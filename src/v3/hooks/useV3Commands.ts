/**
 * V3 Command Queue Hook
 *
 * Manages verified gameplay commands with:
 * - Persistent command ID and payload for idempotent retries
 * - Cursor tracking from server responses
 * - Recovery logic for sequence conflicts
 * - Error classification and retry strategy
 *
 * Command lifecycle:
 * 1. pending: Command submitted, waiting for response
 * 2. uncertain: No response (network error, timeout) - can retry with same ID
 * 3. confirmed: Server accepted and advanced cursor
 * 4. failed: Permanent error (malformed, rejected by rules)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { V3Command, V3CommandQueueState, V3CursorState, V3GameplayCommand } from '../types';
import { v3Api } from '../api';
import type { V3ApiError } from '../api';

const STORAGE_PREFIX = 'worldseed:v3:command-queue:';

function storageKey(runId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(runId)}`;
}

function isPersistedQueue(value: unknown, runId: string): value is V3CommandQueueState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<V3CommandQueueState>;
  return (
    candidate.cursor?.runId === runId &&
    (candidate.queuedHeartClicks === undefined ||
      (Number.isSafeInteger(candidate.queuedHeartClicks) && candidate.queuedHeartClicks >= 0)) &&
    (candidate.heartQueueBlocked === undefined ||
      typeof candidate.heartQueueBlocked === 'boolean') &&
    Number.isSafeInteger(candidate.cursor.currentSequence) &&
    candidate.cursor.currentSequence! >= 0 &&
    Number.isSafeInteger(candidate.cursor.expectedSequence) &&
    candidate.cursor.expectedSequence! >= 0 &&
    Number.isSafeInteger(candidate.cursor.rulesVersion) &&
    Array.isArray(candidate.commands) &&
    candidate.commands.every(
      (command) =>
        typeof command.commandId === 'string' &&
        command.commandId.length > 0 &&
        Number.isSafeInteger(command.expectedSequence) &&
        command.expectedSequence >= 0 &&
        Number.isFinite(command.submittedAt) &&
        ['pending', 'confirmed', 'failed', 'uncertain'].includes(command.status) &&
        !!command.payload &&
        typeof command.payload === 'object' &&
        [
          'heart-click',
          'sync',
          'buy-habitat',
          'buy-habitat-production-upgrade',
          'buy-temporary-upgrade',
        ].includes(command.payload.type),
    )
  );
}

function loadQueue(runId: string, sessionToken: string): V3CommandQueueState {
  const initial = createInitialState(runId, sessionToken);
  try {
    if (typeof window === 'undefined') return initial;
    const serialized = window.localStorage.getItem(storageKey(runId));
    if (!serialized) return initial;
    const parsed: unknown = JSON.parse(serialized);
    if (!isPersistedQueue(parsed, runId)) {
      window.localStorage.removeItem(storageKey(runId));
      return initial;
    }
    return {
      ...parsed,
      queuedHeartClicks: parsed.queuedHeartClicks ?? 0,
      heartQueueBlocked: parsed.heartQueueBlocked ?? false,
      commands: parsed.commands.map((command) =>
        command.status === 'pending'
          ? {
              ...command,
              status: 'uncertain',
              error: 'Submission was interrupted; retry the same command.',
            }
          : command,
      ),
      sessionToken,
      isSubmitting: false,
      recoveringCursor: false,
    };
  } catch {
    return initial;
  }
}

function persistQueue(state: V3CommandQueueState): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const persisted = {
      commands: state.commands,
      cursor: state.cursor,
      queuedHeartClicks: state.queuedHeartClicks,
      heartQueueBlocked: state.heartQueueBlocked ?? false,
      ...(state.recoveryError ? { recoveryError: state.recoveryError } : {}),
    };
    window.localStorage.setItem(storageKey(state.cursor.runId), JSON.stringify(persisted));
    return true;
  } catch {
    return false;
  }
}

function isV3ApiError(error: unknown): error is V3ApiError {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}

function assertReceiptMatches(
  receipt: Awaited<ReturnType<typeof v3Api.submitCommand>>,
  commandId: string,
  expectedSequence: number,
  runId: string,
): void {
  if (
    !receipt.accepted ||
    receipt.commandId !== commandId ||
    receipt.cursor.runId !== runId ||
    receipt.cursor.sequence !== expectedSequence + 1
  ) {
    throw new Error('Verifier returned a receipt that does not match the submitted command.');
  }
}

/**
 * Create initial cursor state for a new run
 */
function createInitialCursor(runId: string): V3CursorState {
  return {
    runId,
    currentSequence: 0,
    expectedSequence: 0,
    rulesVersion: 1,
  };
}

/**
 * Create initial command queue state
 */
function createInitialState(runId: string, sessionToken: string): V3CommandQueueState {
  return {
    commands: [],
    cursor: createInitialCursor(runId),
    sessionToken,
    isSubmitting: false,
    recoveringCursor: false,
    queuedHeartClicks: 0,
    heartQueueBlocked: false,
    pendingCount: 0,
    confirmedCount: 0,
    failedCount: 0,
  };
}

/**
 * Generate unique command ID (stable for retry)
 */
function generateCommandId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

export function useV3Commands(runId: string | undefined, sessionToken: string | undefined) {
  const [state, setState] = useState<V3CommandQueueState | null>(() =>
    runId && sessionToken ? loadQueue(runId, sessionToken) : null,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const commitState = useCallback((
    update:
      | V3CommandQueueState
      | null
      | ((previous: V3CommandQueueState | null) => V3CommandQueueState | null),
  ) => {
    const next = typeof update === 'function' ? update(stateRef.current) : update;
    stateRef.current = next;
    setState(next);
  }, []);
  const submitting = useRef(false);

  useEffect(() => {
    commitState(runId && sessionToken ? loadQueue(runId, sessionToken) : null);
    submitting.current = false;
  }, [commitState, runId, sessionToken]);

  useEffect(() => {
    if (state && state.cursor.runId === runId) persistQueue(state);
  }, [state, runId]);

  /**
   * Recover canonical server state for the run
   */
  const recoverState = useCallback(async () => {
    if (!runId || !sessionToken) return null;

    commitState((prev) =>
      prev ? { ...prev, recoveringCursor: true, recoveryError: undefined } : null,
    );

    try {
      const recovery = await v3Api.recoverRun(runId, sessionToken);
      if (
        recovery.cursor.runId !== runId ||
        !Number.isSafeInteger(recovery.cursor.sequence) ||
        recovery.cursor.sequence < 0
      ) {
        throw new Error('Verifier returned an invalid run cursor.');
      }

      commitState((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          cursor: {
            runId: recovery.cursor.runId,
            currentSequence: recovery.cursor.sequence,
            expectedSequence: recovery.cursor.sequence,
            rulesVersion: recovery.cursor.rulesVersion,
          },
          recoveringCursor: false,
        };
      });
      return recovery;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recovery failed';
      commitState((prev) =>
        prev
          ? {
              ...prev,
              recoveringCursor: false,
              recoveryError: message,
            }
          : null,
      );
      throw error;
    }
  }, [commitState, runId, sessionToken]);

  /**
   * Submit a command to the verifier
   * Persists command before submission to enable retries
   */
  const submitCommand = useCallback(
    async (command: V3GameplayCommand, consumeQueuedHeart = false) => {
      const currentState = stateRef.current;
      if (!currentState || !runId || !sessionToken) {
        throw new Error('Command queue not initialized or session expired');
      }
      if (submitting.current) throw new Error('A command is already being submitted');
      if (
        currentState.commands.some(
          (command) => command.status === 'pending' || command.status === 'uncertain',
        )
      ) {
        throw new Error('Resolve the existing command before submitting another command');
      }
      if (consumeQueuedHeart && (command.type !== 'heart-click' || currentState.queuedHeartClicks <= 0)) {
        throw new Error('No queued Heart click is available.');
      }
      submitting.current = true;

      const commandId = generateCommandId();

      // Persist command before submission
      const payload = { ...command } as V3GameplayCommand;
      const persistedCommand: V3Command = {
        commandId,
        payload,
        expectedSequence: currentState.cursor.expectedSequence,
        submittedAt: Date.now(),
        status: 'pending',
      };

      // Save the exact envelope before the request can leave the browser.
      const queuedState = {
        ...currentState,
        commands: [...currentState.commands, persistedCommand],
        queuedHeartClicks: currentState.queuedHeartClicks - (consumeQueuedHeart ? 1 : 0),
        isSubmitting: true,
      };
      if (!persistQueue(queuedState)) {
        submitting.current = false;
        throw new Error('Unable to save the command locally; nothing was sent.');
      }
      commitState(queuedState);

      try {
        // Submit with exact command ID and expected sequence
        const receipt = await v3Api.submitCommand(
          runId,
          {
            commandId,
            expectedSequence: persistedCommand.expectedSequence,
            command: payload,
          },
          sessionToken,
        );

        assertReceiptMatches(receipt, commandId, persistedCommand.expectedSequence, runId);

        // Update state with receipt and advance cursor
        commitState((prev) => {
          if (!prev) return null;
          const commands = prev.commands.map((c) =>
            c.commandId === commandId
              ? {
                  ...c,
                  status: 'confirmed' as const,
                  confirmedAt: Date.now(),
                  receipt,
                  creditedAtoms: receipt.creditedAtoms,
                  spentAtoms: receipt.spentAtoms,
                  scoreTier: receipt.scoreTier,
                }
              : c,
          );
          // Keep frequent Heart clicks from growing the persisted activity list indefinitely.
          const compactCommands =
            payload.type === 'heart-click'
              ? commands.filter(
                  (c) =>
                    c.payload.type !== 'heart-click' ||
                    c.commandId === commandId ||
                    c.status === 'pending' ||
                    c.status === 'uncertain',
                )
              : commands;
          return {
            ...prev,
            isSubmitting: false,
            cursor: {
              ...prev.cursor,
              currentSequence: receipt.cursor.sequence,
              expectedSequence: receipt.cursor.sequence,
            },
            commands: compactCommands,
          };
        });

        return commandId;
      } catch (error) {
        const apiError = isV3ApiError(error) ? error : null;
        // Classify error and determine if recoverable
        let status: 'uncertain' | 'failed' = 'uncertain';
        let errorMsg = error instanceof Error ? error.message : 'Unknown error';

        if (apiError) {
          const err = apiError;
          switch (err.code) {
            case 'COMMAND_ID_CONFLICT':
              status = 'failed';
              if (err.errorResponse?.recovery) {
                const { cursor } = err.errorResponse.recovery;
                commitState((prev) =>
                  prev
                    ? {
                        ...prev,
                        cursor: {
                          runId: cursor.runId,
                          currentSequence: cursor.sequence,
                          expectedSequence: cursor.sequence,
                          rulesVersion: cursor.rulesVersion,
                        },
                      }
                    : null,
                );
              } else {
                try {
                  const recovery = await v3Api.recoverRun(runId, sessionToken);
                  commitState((prev) =>
                    prev
                      ? {
                          ...prev,
                          cursor: {
                            runId: recovery.cursor.runId,
                            currentSequence: recovery.cursor.sequence,
                            expectedSequence: recovery.cursor.sequence,
                            rulesVersion: recovery.cursor.rulesVersion,
                          },
                        }
                      : null,
                  );
                } catch {
                  // Keep the previous cursor; the queue still fails closed on the command.
                }
              }
              break;

            // Cursor conflicts are definite rejections; recover and let the next action use a fresh ID.
            case 'STALE_CURSOR':
            case 'SEQUENCE_GAP':
              status = 'failed';
              if (err.errorResponse?.recovery) {
                const { cursor } = err.errorResponse.recovery;
                commitState((prev) =>
                  prev
                    ? {
                        ...prev,
                        cursor: {
                          runId: cursor.runId,
                          currentSequence: cursor.sequence,
                          expectedSequence: cursor.sequence,
                          rulesVersion: cursor.rulesVersion,
                        },
                      }
                    : null,
                );
              } else {
                try {
                  const recovery = await v3Api.recoverRun(runId, sessionToken);
                  commitState((prev) =>
                    prev
                      ? {
                          ...prev,
                          cursor: {
                            runId: recovery.cursor.runId,
                            currentSequence: recovery.cursor.sequence,
                            expectedSequence: recovery.cursor.sequence,
                            rulesVersion: recovery.cursor.rulesVersion,
                          },
                        }
                      : null,
                  );
                } catch {
                  // Keep the previous cursor; the rejected command remains visible for recovery.
                }
              }
              break;

            case 'PERSISTENCE_CONFLICT':
            case 'RECOVERY_FAILED':
              status = 'uncertain';
              // Try to recover cursor if provided
              if (err.errorResponse?.recovery) {
                commitState((prev) => {
                  if (!prev) return null;
                  return {
                    ...prev,
                    cursor: {
                      runId: err.errorResponse!.recovery!.cursor.runId,
                      currentSequence: err.errorResponse!.recovery!.cursor.sequence,
                      expectedSequence: err.errorResponse!.recovery!.cursor.sequence,
                      rulesVersion: err.errorResponse!.recovery!.cursor.rulesVersion,
                    },
                  };
                });
              }
              break;

            // Session expired - user must reauthenticate
            case 'UNAUTHENTICATED':
              status = 'uncertain';
              errorMsg = 'Session expired - please reauthenticate';
              break;

            // Permanent errors
            case 'REQUEST_REJECTED':
            case 'RUN_NOT_FOUND':
            case 'RUN_NOT_ACTIVE':
            case 'SEASON_EXPIRED':
            case 'RULES_REJECTED':
              status = 'failed';
              break;

            // Verifier unavailable - treat as uncertain
            case 'VERIFIER_UNAVAILABLE':
              status = 'uncertain';
              break;
          }
        }

        commitState((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            isSubmitting: false,
            ...(consumeQueuedHeart && status === 'failed'
              ? {
                  queuedHeartClicks: prev.queuedHeartClicks + 1,
                  heartQueueBlocked: true,
                }
              : {}),
            commands: prev.commands.map((c) =>
              c.commandId === commandId
                ? {
                    ...c,
                    status,
                    error: errorMsg,
                  }
                : c,
            ),
          };
        });

        throw error;
      } finally {
        submitting.current = false;
      }
    },
    [commitState, runId, sessionToken],
  );

  /**
   * Retry an uncertain or failed command
   * Uses same command ID and payload for idempotency
   */
  const retryCommand = useCallback(
    async (commandId: string) => {
      const currentState = stateRef.current;
      if (!currentState || !runId || !sessionToken) {
        throw new Error('Command queue not initialized or session expired');
      }
      if (submitting.current) throw new Error('A command is already being submitted');

      const command = currentState.commands.find((c) => c.commandId === commandId);
      if (!command) {
        throw new Error('Command not found');
      }
      if (command.status !== 'uncertain') {
        throw new Error('Only uncertain commands can be retried safely');
      }
      submitting.current = true;

      // Reset to pending
      commitState((prev) =>
        prev
          ? {
              ...prev,
              commands: prev.commands.map((c) =>
                c.commandId === commandId
                  ? { ...c, status: 'pending' as const, error: undefined }
                  : c,
              ),
              isSubmitting: true,
            }
          : null,
      );

      try {
        // Resubmit with same command ID (idempotent)
        const receipt = await v3Api.submitCommand(
          runId,
          {
            commandId,
            expectedSequence: command.expectedSequence,
            command: command.payload,
          },
          sessionToken,
        );

        assertReceiptMatches(receipt, commandId, command.expectedSequence, runId);

        // Update with receipt
        commitState((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            isSubmitting: false,
            cursor: {
              ...prev.cursor,
              currentSequence: receipt.cursor.sequence,
              expectedSequence: receipt.cursor.sequence,
            },
            commands: prev.commands.map((c) =>
              c.commandId === commandId
                ? {
                    ...c,
                    status: 'confirmed',
                    confirmedAt: Date.now(),
                    receipt,
                    creditedAtoms: receipt.creditedAtoms,
                    spentAtoms: receipt.spentAtoms,
                    scoreTier: receipt.scoreTier,
                  }
                : c,
            ),
          };
        });
      } catch (error) {
        const apiError = isV3ApiError(error) ? error : null;
        if (
          apiError &&
          ['COMMAND_ID_CONFLICT', 'STALE_CURSOR', 'SEQUENCE_GAP'].includes(apiError.code)
        ) {
          try {
            const recovery = await v3Api.recoverRun(runId, sessionToken);
            commitState((prev) =>
              prev
                ? {
                    ...prev,
                    cursor: {
                      runId: recovery.cursor.runId,
                      currentSequence: recovery.cursor.sequence,
                      expectedSequence: recovery.cursor.sequence,
                      rulesVersion: recovery.cursor.rulesVersion,
                    },
                  }
                : null,
            );
          } catch {
            // Keep the last cursor and show the rejected command for manual reconciliation.
          }
        }

        // Update error status
        commitState((prev) => {
          if (!prev) return null;
          const status: 'uncertain' | 'failed' =
            apiError &&
            [
              'REQUEST_REJECTED',
              'RUN_NOT_FOUND',
              'RUN_NOT_ACTIVE',
              'SEASON_EXPIRED',
              'RULES_REJECTED',
              'COMMAND_ID_CONFLICT',
              'STALE_CURSOR',
              'SEQUENCE_GAP',
            ].includes(apiError.code)
              ? 'failed'
              : 'uncertain';
          return {
            ...prev,
            isSubmitting: false,
            commands: prev.commands.map((c) =>
              c.commandId === commandId
                ? {
                    ...c,
                    status,
                    error: error instanceof Error ? error.message : 'Unknown error',
                  }
                : c,
            ),
          };
        });

        throw error;
      } finally {
        submitting.current = false;
      }
    },
    [commitState, runId, sessionToken],
  );

  /**
   * Recover from a cursor conflict
   */
  const resolveConflict = useCallback(async () => {
    await recoverState();
  }, [recoverState]);

  /**
   * Clear completed commands from queue
   */
  const clearCompleted = useCallback(() => {
    commitState((prev) =>
      prev
        ? {
            ...prev,
            commands: prev.commands.filter(
              (c) => c.status === 'pending' || c.status === 'uncertain',
            ),
          }
        : null,
    );
  }, [commitState]);

  const enqueueHeartClick = useCallback(() => {
    const current = stateRef.current;
    if (!current || !runId || !sessionToken || current.heartQueueBlocked) return false;
    if (current.queuedHeartClicks >= 1_000) return false;
    const next = { ...current, queuedHeartClicks: current.queuedHeartClicks + 1 };
    if (!persistQueue(next)) return false;
    commitState(next);
    return true;
  }, [commitState, runId, sessionToken]);

  const discardQueuedHeartClicks = useCallback(() => {
    const current = stateRef.current;
    if (!current) return;
    const next = { ...current, queuedHeartClicks: 0, heartQueueBlocked: false };
    if (persistQueue(next)) commitState(next);
  }, [commitState]);

  const flushPendingCommands = useCallback(async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const current = stateRef.current;
      if (!current) throw new Error('Live command queue is unavailable.');
      if (current.heartQueueBlocked)
        throw new Error('A Heart collection was rejected. Review the pending queue before continuing.');
      if (current.commands.some((command) => command.status === 'uncertain'))
        throw new Error('A Live action needs retry or recovery before this transition.');
      const pending = current.commands.some((command) => command.status === 'pending');
      if (!pending && current.queuedHeartClicks === 0 && !current.isSubmitting) return;
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    throw new Error('Live actions are still syncing. Try the transition again in a moment.');
  }, []);

  useEffect(() => {
    if (
      !state ||
      state.queuedHeartClicks <= 0 ||
      state.heartQueueBlocked ||
      state.isSubmitting ||
      state.recoveringCursor ||
      state.commands.some((command) => command.status === 'pending' || command.status === 'uncertain')
    ) return;
    const timer = window.setTimeout(() => {
      void submitCommand({ type: 'heart-click' }, true).catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [state, submitCommand]);

  // Compute counts
  const computedState = state
    ? {
        ...state,
        pendingCount: state.commands.filter((c) => c.status === 'pending').length,
        confirmedCount: state.commands.filter((c) => c.status === 'confirmed').length,
        failedCount: state.commands.filter((c) => c.status === 'failed').length,
      }
    : null;

  return {
    state: computedState,
    submitCommand,
    retryCommand,
    recoverState,
    resolveConflict,
    clearCompleted,
    enqueueHeartClick,
    discardQueuedHeartClicks,
    flushPendingCommands,
    isReady: !!state,
  };
}

export type { V3CommandQueueState, V3Command, V3CursorState } from '../types';
