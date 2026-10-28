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

const HEART_BATCH_DELAY_MS = 1_500;
const MAX_HEART_BATCH = 100;
const MAX_QUEUED_HEART_CLICKS = 1_000;
const MAX_AUTOMATIC_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [300, 900] as const;

function heartClickQuantity(command: V3GameplayCommand): number {
  return command.type === 'heart-click' ? (command.quantity ?? 1) : 0;
}

function outstandingHeartClicks(state: V3CommandQueueState): number {
  return state.queuedHeartClicks + state.commands.reduce(
    (total, command) => total + (command.status === 'queued' || command.status === 'pending' || command.status === 'uncertain'
      ? heartClickQuantity(command.payload)
      : 0),
    0,
  );
}

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
    (candidate.heartBatchDueAt === undefined || candidate.heartBatchDueAt === null ||
      (Number.isSafeInteger(candidate.heartBatchDueAt) && candidate.heartBatchDueAt >= 0)) &&
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
        (command.notBefore === undefined || Number.isFinite(command.notBefore)) &&
        (command.attemptCount === undefined || (Number.isSafeInteger(command.attemptCount) && command.attemptCount >= 0)) &&
        (command.autoRetryEligible === undefined || typeof command.autoRetryEligible === 'boolean') &&
        ['queued', 'pending', 'confirmed', 'failed', 'uncertain'].includes(command.status) &&
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
      heartBatchDueAt: parsed.heartBatchDueAt ?? (
        (parsed.queuedHeartClicks ?? 0) > 0 ? Date.now() + HEART_BATCH_DELAY_MS : null
      ),
      heartQueueBlocked: parsed.heartQueueBlocked ?? false,
      commands: parsed.commands.map((command) =>
        command.status === 'pending'
          ? {
              ...command,
              status: 'uncertain',
              attemptCount: Math.min((command.attemptCount ?? 1) + 1, MAX_AUTOMATIC_ATTEMPTS + 1),
              autoRetryEligible: (command.attemptCount ?? 1) < MAX_AUTOMATIC_ATTEMPTS,
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

interface QueuePersistenceCache {
  serialized: string | null;
  state: V3CommandQueueState | null;
}

function persistQueue(state: V3CommandQueueState, cache?: QueuePersistenceCache): boolean {
  try {
    if (typeof window === 'undefined') return false;
    if (cache?.state === state) return true;
    const persisted = {
      commands: state.commands,
      cursor: state.cursor,
      queuedHeartClicks: state.queuedHeartClicks,
      heartBatchDueAt: state.heartBatchDueAt ?? null,
      heartQueueBlocked: state.heartQueueBlocked ?? false,
      ...(state.recoveryError ? { recoveryError: state.recoveryError } : {}),
    };
    const serialized = JSON.stringify(persisted);
    if (cache?.serialized === serialized) {
      cache.state = state;
      return true;
    }
    window.localStorage.setItem(storageKey(state.cursor.runId), serialized);
    if (cache) {
      cache.serialized = serialized;
      cache.state = state;
    }
    return true;
  } catch {
    return false;
  }
}

function isTransientSubmissionError(error: unknown): boolean {
  if (isV3ApiError(error))
    return [408, 425, 429].includes(error.status) || error.status >= 500 || error.code === 'VERIFIER_UNAVAILABLE';
  if (error instanceof TypeError) return true; // fetch network failure
  return error instanceof Error && ['AbortError', 'TimeoutError', 'NetworkError'].includes(error.name);
}

function isDefinitiveSubmissionRejection(error: unknown): boolean {
  if (!isV3ApiError(error) || error.status < 400 || error.status >= 500) return false;
  if ([408, 425, 429].includes(error.status)) return false;
  // These responses can indicate that the server committed but the client did not
  // receive a usable receipt, or that the session must be refreshed first.
  return !['UNAUTHENTICATED', 'PERSISTENCE_CONFLICT', 'RECOVERY_FAILED'].includes(error.code);
}

function retryDelay(attemptCount: number): number {
  return RETRY_BACKOFF_MS[Math.min(Math.max(attemptCount - 2, 0), RETRY_BACKOFF_MS.length - 1)];
}

function waitForRetry(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

async function submitWithAutomaticRetries<T>(
  submit: () => Promise<T>,
  startingAttempt: number,
  onRetry: (attemptCount: number, error: unknown) => void,
): Promise<T> {
  let attemptCount = startingAttempt;
  while (true) {
    try {
      return await submit();
    } catch (error) {
      if (!isTransientSubmissionError(error) || attemptCount >= MAX_AUTOMATIC_ATTEMPTS) throw error;
      attemptCount += 1;
      onRetry(attemptCount, error);
      await waitForRetry(retryDelay(attemptCount));
    }
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
    heartBatchDueAt: null,
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
  const persistedQueueCache = useRef<QueuePersistenceCache>({ serialized: null, state: null });
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
    if (state && state.cursor.runId === runId) persistQueue(state, persistedQueueCache.current);
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
    async (command: V3GameplayCommand, consumeQueuedHeart = 0, queuedCommandId?: string) => {
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
      if (!Number.isSafeInteger(consumeQueuedHeart) || consumeQueuedHeart < 0 || consumeQueuedHeart > MAX_HEART_BATCH ||
        (consumeQueuedHeart > 0 && (command.type !== 'heart-click' || consumeQueuedHeart > currentState.queuedHeartClicks || heartClickQuantity(command) !== consumeQueuedHeart))) {
        throw new Error('No queued Heart click is available.');
      }
      if (command.type === 'heart-click' && (!Number.isSafeInteger(heartClickQuantity(command)) || heartClickQuantity(command) < 1 || heartClickQuantity(command) > MAX_HEART_BATCH))
        throw new Error(`Heart batches must contain 1 through ${MAX_HEART_BATCH} clicks.`);
      if (consumeQueuedHeart === 0 && currentState.queuedHeartClicks > 0 && !queuedCommandId)
        throw new Error('Queued Heart clicks must be verified before the next action.');
      submitting.current = true;

      const existingQueued = queuedCommandId
        ? currentState.commands.find((item) => item.commandId === queuedCommandId && item.status === 'queued')
        : undefined;
      if (queuedCommandId && (!existingQueued || JSON.stringify(existingQueued.payload) !== JSON.stringify(command))) {
        submitting.current = false;
        throw new Error('Queued command no longer matches the persisted action.');
      }
      const commandId = existingQueued?.commandId ?? generateCommandId();

      // Persist command before submission
      const payload = { ...command } as V3GameplayCommand;
      const persistedCommand: V3Command = {
        commandId,
        payload,
        expectedSequence: currentState.cursor.expectedSequence,
        submittedAt: Date.now(),
        attemptCount: 1,
        autoRetryEligible: true,
        status: 'pending',
      };

      // Save the exact envelope before the request can leave the browser.
      const queuedState = {
        ...currentState,
        commands: existingQueued
          ? currentState.commands.map((item) => item.commandId === commandId
              ? { ...item, expectedSequence: currentState.cursor.expectedSequence, status: 'pending' as const, submittedAt: Date.now(), attemptCount: 1, autoRetryEligible: true }
              : item)
          : [...currentState.commands, persistedCommand],
        queuedHeartClicks: currentState.queuedHeartClicks - consumeQueuedHeart,
        heartBatchDueAt: currentState.queuedHeartClicks - consumeQueuedHeart > 0
          ? Date.now() + HEART_BATCH_DELAY_MS
          : null,
        isSubmitting: true,
      };
      if (!persistQueue(queuedState, persistedQueueCache.current)) {
        submitting.current = false;
        throw new Error('Unable to save the command locally; nothing was sent.');
      }
      commitState(queuedState);

      let attemptCount = 1;
      try {
        const envelope = {
          commandId,
          expectedSequence: persistedCommand.expectedSequence,
          command: payload,
        };
        const receipt = await submitWithAutomaticRetries(
          () => v3Api.submitCommand(runId, envelope, sessionToken),
          attemptCount,
          (nextAttemptCount, retryError) => {
            attemptCount = nextAttemptCount;
            commitState((prev) => prev ? {
              ...prev,
              commands: prev.commands.map(item => item.commandId === commandId
                ? { ...item, attemptCount: nextAttemptCount, autoRetryEligible: true,
                    error: retryError instanceof Error ? retryError.message : 'Temporary network interruption.' }
                : item),
            } : null);
          },
        );

        assertReceiptMatches(receipt, commandId, persistedCommand.expectedSequence, runId);

        // Update state with receipt and advance cursor
        submitting.current = false;
        commitState((prev) => {
          if (!prev) return null;
          const commands = prev.commands.map((c) =>
            c.commandId === commandId
              ? {
                  ...c,
                  status: 'confirmed' as const,
                  autoRetryEligible: false,
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
                    c.status === 'queued' ||
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
          // Treat any other non-retryable 4xx as a definitive rejection. This
          // prevents unknown verifier validation errors from entering retry paths.
          if (isDefinitiveSubmissionRejection(apiError)) status = 'failed';
        }

        submitting.current = false;
        commitState((prev) => {
          if (!prev) return null;
          const queueRejected = Boolean(queuedCommandId && status === 'failed');
          return {
            ...prev,
            isSubmitting: false,
            ...(consumeQueuedHeart > 0 && status === 'failed'
              ? {
                  queuedHeartClicks: prev.queuedHeartClicks + consumeQueuedHeart,
                  heartBatchDueAt: null,
                  heartQueueBlocked: true,
                }
              : {}),
            ...(queueRejected
              ? { queuedHeartClicks: 0, heartBatchDueAt: null, heartQueueBlocked: true }
              : {}),
            commands: prev.commands.map((c) =>
              c.commandId === commandId
                ? {
                    ...c,
                    status,
                    error: errorMsg,
                    attemptCount,
                    autoRetryEligible: status === 'uncertain' && isTransientSubmissionError(error) && attemptCount < MAX_AUTOMATIC_ATTEMPTS,
                  }
                : queueRejected && c.status === 'queued'
                  ? { ...c, status: 'failed' as const, error: 'Not sent because an earlier action was rejected.' }
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
    async (commandId: string, automatic = false) => {
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
      if (automatic && (!command.autoRetryEligible || (command.attemptCount ?? 1) > MAX_AUTOMATIC_ATTEMPTS)) return;
      submitting.current = true;
      let attemptCount = automatic ? command.attemptCount ?? 1 : 1;

      // Reset to pending
      commitState((prev) =>
        prev
          ? {
              ...prev,
              commands: prev.commands.map((c) =>
                c.commandId === commandId
                  ? { ...c, status: 'pending' as const, attemptCount, autoRetryEligible: true, error: undefined }
                  : c,
              ),
              isSubmitting: true,
            }
          : null,
      );

      try {
        const envelope = {
          commandId,
          expectedSequence: command.expectedSequence,
          command: command.payload,
        };
        const receipt = await submitWithAutomaticRetries(
          () => v3Api.submitCommand(runId, envelope, sessionToken),
          attemptCount,
          (nextAttemptCount, retryError) => {
            attemptCount = nextAttemptCount;
            commitState((prev) => prev ? {
              ...prev,
              commands: prev.commands.map(item => item.commandId === commandId
                ? { ...item, attemptCount, autoRetryEligible: true,
                    error: retryError instanceof Error ? retryError.message : 'Temporary network interruption.' }
                : item),
            } : null);
          },
        );

        assertReceiptMatches(receipt, commandId, command.expectedSequence, runId);

        // Update with receipt
        submitting.current = false;
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
                    autoRetryEligible: false,
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
        submitting.current = false;
        commitState((prev) => {
          if (!prev) return null;
          const status: 'uncertain' | 'failed' =
            isDefinitiveSubmissionRejection(error) || Boolean(apiError && [
              'REQUEST_REJECTED',
              'RUN_NOT_FOUND',
              'RUN_NOT_ACTIVE',
              'SEASON_EXPIRED',
              'RULES_REJECTED',
              'COMMAND_ID_CONFLICT',
              'STALE_CURSOR',
              'SEQUENCE_GAP',
            ].includes(apiError.code))
              ? 'failed'
              : 'uncertain';
          const queueRejected = status === 'failed' && prev.commands.some(c => c.status === 'queued');
          return {
            ...prev,
            isSubmitting: false,
            ...(queueRejected ? { heartQueueBlocked: true, queuedHeartClicks: 0, heartBatchDueAt: null } : {}),
            commands: prev.commands.map((c) =>
              c.commandId === commandId
                ? {
                    ...c,
                    status,
                    error: error instanceof Error ? error.message : 'Unknown error',
                    attemptCount,
                    autoRetryEligible: status === 'uncertain' && isTransientSubmissionError(error) && attemptCount < MAX_AUTOMATIC_ATTEMPTS,
                  }
                : queueRejected && c.status === 'queued'
                  ? { ...c, status: 'failed' as const, error: 'Not sent because an earlier action was rejected.' }
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
              (c) => c.status === 'queued' || c.status === 'pending' || c.status === 'uncertain',
            ),
          }
        : null,
    );
  }, [commitState]);

  const enqueueHeartClick = useCallback(() => {
    const current = stateRef.current;
    if (!current || !runId || !sessionToken || current.heartQueueBlocked) return false;
    if (outstandingHeartClicks(current) >= MAX_QUEUED_HEART_CLICKS) return false;
    const next = {
      ...current,
      queuedHeartClicks: current.queuedHeartClicks + 1,
      heartBatchDueAt: current.queuedHeartClicks === 0
        ? Date.now() + HEART_BATCH_DELAY_MS
        : current.heartBatchDueAt ?? Date.now() + HEART_BATCH_DELAY_MS,
    };
    if (!persistQueue(next, persistedQueueCache.current)) return false;
    commitState(next);
    return true;
  }, [commitState, runId, sessionToken]);

  const sealHeartBuffer = useCallback((source: V3CommandQueueState): V3CommandQueueState => {
    if (source.queuedHeartClicks <= 0) return source;
    const additions: V3Command[] = [];
    let remaining = source.queuedHeartClicks;
    const scheduledAt = Date.now();
    while (remaining > 0) {
      const quantity = Math.min(remaining, MAX_HEART_BATCH);
      const batchIndex = additions.length;
      additions.push({
        commandId: generateCommandId(),
        payload: { type: 'heart-click', quantity },
        expectedSequence: source.cursor.expectedSequence,
        submittedAt: Date.now(),
        ...(batchIndex > 0 ? { notBefore: scheduledAt + batchIndex * HEART_BATCH_DELAY_MS } : {}),
        status: 'queued',
      });
      remaining -= quantity;
    }
    return { ...source, commands: [...source.commands, ...additions], queuedHeartClicks: 0, heartBatchDueAt: null };
  }, []);

  /** Persist an ordinary gameplay action immediately behind any buffered Heart clicks. */
  const enqueueCommand = useCallback((payload: V3GameplayCommand): boolean => {
    const current = stateRef.current;
    if (!current || !runId || !sessionToken || current.heartQueueBlocked || current.recoveringCursor) return false;
    const ordered = sealHeartBuffer(current);
    const next: V3CommandQueueState = {
      ...ordered,
      commands: [...ordered.commands, {
        commandId: generateCommandId(),
        payload,
        expectedSequence: ordered.cursor.expectedSequence,
        submittedAt: Date.now(),
        status: 'queued',
      }],
    };
    if (!persistQueue(next, persistedQueueCache.current)) return false;
    commitState(next);
    return true;
  }, [commitState, runId, sealHeartBuffer, sessionToken]);

  const discardQueuedHeartClicks = useCallback(() => {
    const current = stateRef.current;
    if (!current) return;
    const next = {
      ...current,
      queuedHeartClicks: 0,
      heartBatchDueAt: null,
      heartQueueBlocked: false,
      commands: current.commands.filter((command) => command.status !== 'failed'),
    };
    if (persistQueue(next, persistedQueueCache.current)) commitState(next);
  }, [commitState]);

  const flushPendingCommands = useCallback(async () => {
    const current = stateRef.current;
    if (current?.queuedHeartClicks) {
      const next = sealHeartBuffer(current);
      if (!persistQueue(next, persistedQueueCache.current)) throw new Error('Unable to save pending Live actions locally.');
      commitState(next);
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const current = stateRef.current;
      if (!current) throw new Error('Live command queue is unavailable.');
      if (current.heartQueueBlocked)
        throw new Error('A Live action was rejected. Review or discard dependent queued actions before continuing.');
      if (current.commands.some((command) => command.status === 'uncertain'))
        throw new Error('A Live action needs retry or recovery before this transition.');
      const pending = current.commands.some((command) => command.status === 'pending' || command.status === 'queued');
      if (!pending && current.queuedHeartClicks === 0 && !current.isSubmitting) return;
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    throw new Error('Live actions are still syncing. Try the transition again in a moment.');
  }, [commitState, sealHeartBuffer]);

  useEffect(() => {
    if (
      !state ||
      state.queuedHeartClicks <= 0 ||
      state.heartQueueBlocked ||
      state.isSubmitting ||
      state.recoveringCursor ||
      state.commands.some((command) => command.status === 'pending' || command.status === 'uncertain')
    ) return;
    const dueAt = state.heartBatchDueAt ?? Date.now() + HEART_BATCH_DELAY_MS;
    const quantity = Math.min(state.queuedHeartClicks, MAX_HEART_BATCH);
    const timer = window.setTimeout(() => {
      const current = stateRef.current;
      if (!current) return;
      const next = sealHeartBuffer({ ...current, queuedHeartClicks: quantity });
      const remainder = current.queuedHeartClicks - quantity;
      const withRemainder = { ...next, queuedHeartClicks: remainder, heartBatchDueAt: remainder > 0 ? Date.now() + HEART_BATCH_DELAY_MS : null };
      if (persistQueue(withRemainder, persistedQueueCache.current)) commitState(withRemainder);
    }, Math.max(0, dueAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [commitState, sealHeartBuffer, state]);

  // Resume an interrupted transient command with the same persisted envelope after reload.
  useEffect(() => {
    if (!state || state.heartQueueBlocked || state.isSubmitting || state.recoveringCursor || submitting.current) return;
    if (state.commands.some(command => command.status === 'pending')) return;
    const interrupted = state.commands.find(command =>
      command.status === 'uncertain' && command.autoRetryEligible &&
      (command.attemptCount ?? 1) <= MAX_AUTOMATIC_ATTEMPTS,
    );
    if (!interrupted) return;
    const timer = window.setTimeout(() => {
      void retryCommand(interrupted.commandId, true).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [retryCommand, state]);

  // Submit the head of the persisted ordered journal, one verifier sequence at a time.
  useEffect(() => {
    if (!state || state.heartQueueBlocked || state.isSubmitting || state.recoveringCursor || submitting.current) return;
    if (state.commands.some((command) => command.status === 'pending' || command.status === 'uncertain')) return;
    const head = state.commands.find((command) => command.status === 'queued');
    if (!head) return;
    const waitMs = Math.max(0, (head.notBefore ?? 0) - Date.now());
    if (waitMs > 0) {
      const timer = window.setTimeout(() => {
        commitState((previous) => previous ? { ...previous } : null);
      }, waitMs);
      return () => window.clearTimeout(timer);
    }
    void submitCommand(head.payload, 0, head.commandId).catch(() => undefined);
  }, [commitState, state, submitCommand]);

  // Compute counts
  const computedState = state
    ? {
        ...state,
        pendingCount: state.commands.filter((c) => c.status === 'queued' || c.status === 'pending').length,
        confirmedCount: state.commands.filter((c) => c.status === 'confirmed').length,
        failedCount: state.commands.filter((c) => c.status === 'failed').length,
      }
    : null;

  return {
    state: computedState,
    submitCommand,
    enqueueCommand,
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
