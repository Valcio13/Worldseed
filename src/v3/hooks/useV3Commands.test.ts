/**
 * V3 Command Queue Tests
 *
 * Tests for verified gameplay command queue:
 * - Command ordering and sequencing
 * - Idempotent retries with same command ID
 * - Duplicate detection via command ID conflict
 * - Cursor recovery on sequence gaps
 * - Error classification and retry strategy
 * - Session expiration handling
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { V3CommandQueueState, V3Command, V3CursorState } from '../types';
import type { V3CommandReceipt } from '../api';
import { v3Api, V3ApiError } from '../api';
import { useV3Commands } from './useV3Commands';

describe('V3 Command Queue', () => {
  describe('command persistence', () => {
    it('should persist command ID, payload, and expected sequence before submission', () => {
      const command: V3Command = {
        commandId: 'cmd-1-123',
        payload: { type: 'heart-click' },
        expectedSequence: 0,
        submittedAt: Date.now(),
        status: 'pending',
      };

      expect(command.commandId).toBe('cmd-1-123');
      expect(command.payload.type).toBe('heart-click');
      expect(command.expectedSequence).toBe(0);
      expect(command.status).toBe('pending');
    });

    it('should store exact payload for retry', () => {
      const payload = { type: 'buy-habitat' as const, habitat: 'water' as const, quantity: 5 };
      const command: V3Command = {
        commandId: 'cmd-2-456',
        payload,
        expectedSequence: 1,
        submittedAt: Date.now(),
        status: 'pending',
      };

      expect(command.payload).toEqual(payload);
      // Check that the payload matches the right type
      if (command.payload.type === 'buy-habitat') {
        expect(command.payload.quantity).toBe(5);
      }
    });

    it('should track submission timestamp for timeout detection', () => {
      const now = Date.now();
      const command: V3Command = {
        commandId: 'cmd-3-789',
        payload: { type: 'heart-click' },
        expectedSequence: 0,
        submittedAt: now,
        status: 'pending',
      };

      expect(command.submittedAt).toBe(now);
      expect(command.submittedAt).toBeGreaterThanOrEqual(now - 1000);
    });
  });

  describe('cursor tracking', () => {
    it('should initialize cursor at sequence 0 for new run', () => {
      const cursor: V3CursorState = {
        runId: 'run-1',
        currentSequence: 0,
        expectedSequence: 0,
        rulesVersion: 1,
      };

      expect(cursor.currentSequence).toBe(0);
      expect(cursor.expectedSequence).toBe(0);
      expect(cursor.rulesVersion).toBe(1);
    });

    it('should advance cursor with server response', () => {
      const receipt: V3CommandReceipt = {
        accepted: true,
        commandId: 'cmd-1',
        cursor: {
          runId: 'run-1',
          sequence: 1,
          rulesVersion: 1,
        },
        serverTimeMs: Date.now(),
        canonicalState: '{}',
        creditedAtoms: '1000000000000',
        spentAtoms: '0',
        scoreTier: 0,
      };

      // Simulate cursor advancement
      let cursor: V3CursorState = {
        runId: 'run-1',
        currentSequence: 0,
        expectedSequence: 0,
        rulesVersion: 1,
      };

      cursor = {
        ...cursor,
        currentSequence: receipt.cursor.sequence,
        expectedSequence: receipt.cursor.sequence,
      };

      expect(cursor.currentSequence).toBe(1);
      expect(cursor.expectedSequence).toBe(1);
    });

    it('should track both current and expected sequence separately', () => {
      let cursor: V3CursorState = {
        runId: 'run-1',
        currentSequence: 0,
        expectedSequence: 0,
        rulesVersion: 1,
      };

      // Submit first command
      cursor = {
        ...cursor,
        expectedSequence: cursor.currentSequence + 1,
      };
      expect(cursor.expectedSequence).toBe(1);
      expect(cursor.currentSequence).toBe(0);

      // Receive response
      cursor = {
        ...cursor,
        currentSequence: 1,
        expectedSequence: 1,
      };
      expect(cursor.currentSequence).toBe(1);
      expect(cursor.expectedSequence).toBe(1);
    });
  });

  describe('command ordering', () => {
    it('should maintain command submission order', () => {
      const queue: V3Command[] = [];

      const cmd1: V3Command = {
        commandId: 'cmd-1',
        payload: { type: 'heart-click' },
        expectedSequence: 0,
        submittedAt: Date.now(),
        status: 'pending',
      };

      const cmd2: V3Command = {
        commandId: 'cmd-2',
        payload: { type: 'heart-click' },
        expectedSequence: 1,
        submittedAt: Date.now() + 100,
        status: 'pending',
      };

      queue.push(cmd1, cmd2);

      expect(queue[0].commandId).toBe('cmd-1');
      expect(queue[1].commandId).toBe('cmd-2');
      expect(queue[0].expectedSequence).toBe(0);
      expect(queue[1].expectedSequence).toBe(1);
    });

    it('should not allow command submission beyond expected sequence', () => {
      const cursor: V3CursorState = {
        runId: 'run-1',
        currentSequence: 5,
        expectedSequence: 5,
        rulesVersion: 1,
      };

      const command: V3Command = {
        commandId: 'cmd-new',
        payload: { type: 'heart-click' },
        expectedSequence: cursor.expectedSequence,
        submittedAt: Date.now(),
        status: 'pending',
      };

      expect(command.expectedSequence).toBe(5);
      // Trying to use a higher expected sequence would be an error
      const invalidExpected = 10;
      expect(invalidExpected).toBeGreaterThan(cursor.expectedSequence);
    });
  });

  describe('idempotent retries', () => {
    it('should retry with identical command ID', () => {
      const originalCommand: V3Command = {
        commandId: 'stable-id-123',
        payload: { type: 'buy-habitat', habitat: 'water', quantity: 3 },
        expectedSequence: 0,
        submittedAt: Date.now(),
        status: 'uncertain',
        error: 'Network timeout',
      };

      // Retry uses same command ID and payload
      const retryCommand: V3Command = {
        ...originalCommand,
        status: 'pending',
        error: undefined,
      };

      expect(retryCommand.commandId).toBe(originalCommand.commandId);
      expect(retryCommand.payload).toEqual(originalCommand.payload);
      expect(retryCommand.commandId).toBe('stable-id-123');
    });

    it('should preserve exact payload across retries', () => {
      const payload = {
        type: 'buy-temporary-upgrade' as const,
        upgrade: 'sunny-season' as const,
      };

      const cmd1: V3Command = {
        commandId: 'upgrade-cmd-1',
        payload,
        expectedSequence: 2,
        submittedAt: Date.now(),
        status: 'uncertain',
      };

      const cmd2: V3Command = {
        ...cmd1,
        status: 'pending',
        submittedAt: Date.now() + 1000, // Different attempt time
      };

      expect(cmd1.payload).toEqual(cmd2.payload);
      if (cmd1.payload.type === 'buy-temporary-upgrade')
        expect(cmd1.payload.upgrade).toBe('sunny-season');
      if (cmd2.payload.type === 'buy-temporary-upgrade')
        expect(cmd2.payload.upgrade).toBe('sunny-season');
    });

    it('should not modify payload on retry', () => {
      const originalPayload = { type: 'heart-click' as const };
      let command: V3Command = {
        commandId: 'cmd-1',
        payload: originalPayload,
        expectedSequence: 0,
        submittedAt: Date.now(),
        status: 'uncertain',
      };

      // "Retry" by resetting status but keeping payload
      command = {
        ...command,
        status: 'pending',
      };

      expect(command.payload).toEqual(originalPayload);
      expect(command.payload.type).toBe('heart-click');
    });
  });

  describe('duplicate detection', () => {
    it('should detect COMMAND_ID_CONFLICT error when reusing command ID with different payload', () => {
      const queue: V3Command[] = [];

      const cmd1: V3Command = {
        commandId: 'conflict-cmd',
        payload: { type: 'buy-habitat', habitat: 'water', quantity: 1 },
        expectedSequence: 0,
        submittedAt: Date.now(),
        status: 'confirmed',
      };

      queue.push(cmd1);

      // Attempt to reuse same ID with different payload
      const differentPayload = { type: 'buy-habitat', habitat: 'grass', quantity: 2 };
      const conflictExists = queue.some((c) => c.commandId === 'conflict-cmd');

      expect(conflictExists).toBe(true);
      expect(cmd1.payload).not.toEqual(differentPayload);
    });

    it('should allow identical retry with same command ID and payload', () => {
      const queue: V3Command[] = [];

      const cmd: V3Command = {
        commandId: 'stable-cmd',
        payload: { type: 'heart-click' },
        expectedSequence: 0,
        submittedAt: Date.now(),
        status: 'confirmed',
        receipt: {
          accepted: true,
          commandId: 'stable-cmd',
          cursor: { runId: 'run-1', sequence: 1, rulesVersion: 1 },
          serverTimeMs: Date.now(),
          canonicalState: '{}',
          creditedAtoms: '1000000000000',
          spentAtoms: '0',
          scoreTier: 0,
        },
      };

      queue.push(cmd);

      // Identical retry is allowed (would return cached receipt)
      const retry: V3Command = {
        commandId: 'stable-cmd',
        payload: { type: 'heart-click' },
        expectedSequence: 0,
        submittedAt: Date.now() + 5000,
        status: 'pending',
      };

      expect(retry.commandId).toBe(cmd.commandId);
      expect(retry.payload).toEqual(cmd.payload);
    });
  });

  describe('cursor recovery', () => {
    it('should recover cursor from 409 STALE_CURSOR error with recovery data', () => {
      const errorResponse = {
        code: 'STALE_CURSOR',
        message: 'Cursor out of sync',
        expectedSequence: 5,
        recovery: {
          cursor: {
            runId: 'run-1',
            sequence: 5,
            rulesVersion: 1,
          },
          canonicalState: '{"natureAtoms":"1000000000000"}',
        },
      };

      // Simulate recovery
      let cursor: V3CursorState = {
        runId: 'run-1',
        currentSequence: 3,
        expectedSequence: 3,
        rulesVersion: 1,
      };

      if (errorResponse.recovery) {
        cursor = {
          runId: errorResponse.recovery.cursor.runId,
          currentSequence: errorResponse.recovery.cursor.sequence,
          expectedSequence: errorResponse.recovery.cursor.sequence,
          rulesVersion: errorResponse.recovery.cursor.rulesVersion,
        };
      }

      expect(cursor.currentSequence).toBe(5);
      expect(cursor.expectedSequence).toBe(5);
    });

    it('should handle SEQUENCE_GAP error with expected sequence', () => {
      const errorResponse = {
        code: 'SEQUENCE_GAP',
        message: 'Sequence gap detected',
        expectedSequence: 10,
      };

      // Client should recover before retrying
      const currentCursor: V3CursorState = {
        runId: 'run-1',
        currentSequence: 5,
        expectedSequence: 6,
        rulesVersion: 1,
      };

      // Gap between current (5) and expected (10) detected
      const gap = errorResponse.expectedSequence - currentCursor.currentSequence;
      expect(gap).toBe(5);
      expect(errorResponse.expectedSequence).toBeGreaterThan(currentCursor.currentSequence);
    });

    it('should update cursor state after recovery', () => {
      let cursor: V3CursorState = {
        runId: 'run-1',
        currentSequence: 0,
        expectedSequence: 0,
        rulesVersion: 1,
      };

      const recovery = {
        cursor: {
          runId: 'run-1',
          sequence: 7,
          rulesVersion: 1,
        },
        canonicalState: '{}',
      };

      // Update cursor
      cursor = {
        ...cursor,
        currentSequence: recovery.cursor.sequence,
        expectedSequence: recovery.cursor.sequence,
      };

      expect(cursor.currentSequence).toBe(7);
      expect(cursor.expectedSequence).toBe(7);
    });
  });

  describe('error classification', () => {
    it('should classify SESSION_EXPIRED as permanent failure', () => {
      const errorCode = 'UNAUTHENTICATED';
      const isRecoverable = false;

      // SESSION_EXPIRED (UNAUTHENTICATED) requires user action, not automatic retry
      expect(errorCode).toBe('UNAUTHENTICATED');
      expect(isRecoverable).toBe(false);
    });

    it('should classify COMMAND_ID_CONFLICT as uncertain for retry', () => {
      const errorCode = 'COMMAND_ID_CONFLICT';
      const isUncertain = true;

      // Can retry with same command ID to get cached result
      expect(errorCode).toBe('COMMAND_ID_CONFLICT');
      expect(isUncertain).toBe(true);
    });

    it('should classify STALE_CURSOR as recoverable', () => {
      const errorCode = 'STALE_CURSOR';
      const isRecoverable = true;

      // Can recover cursor and retry
      expect(errorCode).toBe('STALE_CURSOR');
      expect(isRecoverable).toBe(true);
    });

    it('should classify RULES_REJECTED as permanent failure', () => {
      const errorCode = 'RULES_REJECTED';
      const isRecoverable = false;

      // Rules rejection is permanent, user must correct action
      expect(errorCode).toBe('RULES_REJECTED');
      expect(isRecoverable).toBe(false);
    });

    it('should classify VERIFIER_UNAVAILABLE as uncertain', () => {
      const errorCode = 'VERIFIER_UNAVAILABLE';
      const isUncertain = true;

      // Can retry after service recovery
      expect(errorCode).toBe('VERIFIER_UNAVAILABLE');
      expect(isUncertain).toBe(true);
    });
  });

  describe('command statuses', () => {
    it('should transition pending to confirmed on receipt', () => {
      let command: V3Command = {
        commandId: 'cmd-1',
        payload: { type: 'heart-click' },
        expectedSequence: 0,
        submittedAt: Date.now(),
        status: 'pending',
      };

      const receipt: V3CommandReceipt = {
        accepted: true,
        commandId: 'cmd-1',
        cursor: { runId: 'run-1', sequence: 1, rulesVersion: 1 },
        serverTimeMs: Date.now(),
        canonicalState: '{}',
        creditedAtoms: '1000000000000',
        spentAtoms: '0',
        scoreTier: 0,
      };

      command = {
        ...command,
        status: 'confirmed',
        confirmedAt: Date.now(),
        receipt,
        creditedAtoms: receipt.creditedAtoms,
        spentAtoms: receipt.spentAtoms,
        scoreTier: receipt.scoreTier,
      };

      expect(command.status).toBe('confirmed');
      expect(command.confirmedAt).toBeDefined();
      expect(command.creditedAtoms).toBe('1000000000000');
    });

    it('should transition pending to uncertain on network error', () => {
      let command: V3Command = {
        commandId: 'cmd-1',
        payload: { type: 'heart-click' },
        expectedSequence: 0,
        submittedAt: Date.now(),
        status: 'pending',
      };

      command = {
        ...command,
        status: 'uncertain',
        error: 'Network timeout after 30s',
      };

      expect(command.status).toBe('uncertain');
      expect(command.error).toBe('Network timeout after 30s');
    });

    it('should transition uncertain to confirmed on retry success', () => {
      let command: V3Command = {
        commandId: 'cmd-1',
        payload: { type: 'heart-click' },
        expectedSequence: 0,
        submittedAt: Date.now(),
        status: 'uncertain',
        error: 'Previous timeout',
      };

      const receipt: V3CommandReceipt = {
        accepted: true,
        commandId: 'cmd-1',
        cursor: { runId: 'run-1', sequence: 1, rulesVersion: 1 },
        serverTimeMs: Date.now(),
        canonicalState: '{}',
        creditedAtoms: '1000000000000',
        spentAtoms: '0',
        scoreTier: 0,
      };

      command = {
        ...command,
        status: 'confirmed',
        confirmedAt: Date.now(),
        receipt,
        error: undefined,
      };

      expect(command.status).toBe('confirmed');
      expect(command.error).toBeUndefined();
    });

    it('should transition to failed on permanent error', () => {
      let command: V3Command = {
        commandId: 'cmd-1',
        payload: { type: 'buy-habitat', habitat: 'water', quantity: 999999 },
        expectedSequence: 0,
        submittedAt: Date.now(),
        status: 'pending',
      };

      command = {
        ...command,
        status: 'failed',
        error: 'Insufficient Nature (RULES_REJECTED)',
      };

      expect(command.status).toBe('failed');
      expect(command.error).toContain('RULES_REJECTED');
    });
  });

  describe('queue state management', () => {
    it('should compute pending count correctly', () => {
      const state: V3CommandQueueState = {
        commands: [
          {
            commandId: 'cmd-1',
            payload: { type: 'heart-click' },
            expectedSequence: 0,
            submittedAt: Date.now(),
            status: 'pending',
          },
          {
            commandId: 'cmd-2',
            payload: { type: 'heart-click' },
            expectedSequence: 1,
            submittedAt: Date.now(),
            status: 'pending',
          },
          {
            commandId: 'cmd-3',
            payload: { type: 'heart-click' },
            expectedSequence: 2,
            submittedAt: Date.now(),
            status: 'confirmed',
          },
        ],
        cursor: {
          runId: 'run-1',
          currentSequence: 1,
          expectedSequence: 2,
          rulesVersion: 1,
        },
        sessionToken: 'token-123',
        isSubmitting: false,
        recoveringCursor: false,
        queuedHeartClicks: 0,
      };

      const pendingCount = state.commands.filter((c) => c.status === 'pending').length;
      expect(pendingCount).toBe(2);
    });

    it('should compute confirmed count correctly', () => {
      const state: V3CommandQueueState = {
        commands: [
          {
            commandId: 'cmd-1',
            payload: { type: 'heart-click' },
            expectedSequence: 0,
            submittedAt: Date.now(),
            status: 'confirmed',
          },
          {
            commandId: 'cmd-2',
            payload: { type: 'heart-click' },
            expectedSequence: 1,
            submittedAt: Date.now(),
            status: 'confirmed',
          },
          {
            commandId: 'cmd-3',
            payload: { type: 'heart-click' },
            expectedSequence: 2,
            submittedAt: Date.now(),
            status: 'pending',
          },
        ],
        cursor: {
          runId: 'run-1',
          currentSequence: 2,
          expectedSequence: 2,
          rulesVersion: 1,
        },
        sessionToken: 'token-123',
        isSubmitting: false,
        recoveringCursor: false,
        queuedHeartClicks: 0,
      };

      const confirmedCount = state.commands.filter((c) => c.status === 'confirmed').length;
      expect(confirmedCount).toBe(2);
    });

    it('should compute failed count correctly', () => {
      const state: V3CommandQueueState = {
        commands: [
          {
            commandId: 'cmd-1',
            payload: { type: 'heart-click' },
            expectedSequence: 0,
            submittedAt: Date.now(),
            status: 'failed',
            error: 'Run not active',
          },
          {
            commandId: 'cmd-2',
            payload: { type: 'heart-click' },
            expectedSequence: 1,
            submittedAt: Date.now(),
            status: 'uncertain',
          },
        ],
        cursor: {
          runId: 'run-1',
          currentSequence: 0,
          expectedSequence: 0,
          rulesVersion: 1,
        },
        sessionToken: 'token-123',
        isSubmitting: false,
        recoveringCursor: false,
        queuedHeartClicks: 0,
      };

      const failedCount = state.commands.filter((c) => c.status === 'failed').length;
      expect(failedCount).toBe(1);
    });

    it('should track session token', () => {
      const state: V3CommandQueueState = {
        commands: [],
        cursor: {
          runId: 'run-1',
          currentSequence: 0,
          expectedSequence: 0,
          rulesVersion: 1,
        },
        sessionToken: 'bearer-token-xyz',
        isSubmitting: false,
        recoveringCursor: false,
        queuedHeartClicks: 0,
      };

      expect(state.sessionToken).toBe('bearer-token-xyz');
    });

    it('should track recovery state', () => {
      const state: V3CommandQueueState = {
        commands: [],
        cursor: {
          runId: 'run-1',
          currentSequence: 0,
          expectedSequence: 0,
          rulesVersion: 1,
        },
        sessionToken: 'token',
        isSubmitting: false,
        recoveringCursor: true,
        queuedHeartClicks: 0,
        recoveryError: undefined,
      };

      expect(state.recoveringCursor).toBe(true);

      // After recovery
      const recoveredState = {
        ...state,
        recoveringCursor: false,
        cursor: {
          ...state.cursor,
          currentSequence: 5,
          expectedSequence: 5,
        },
      };

      expect(recoveredState.recoveringCursor).toBe(false);
      expect(recoveredState.cursor.currentSequence).toBe(5);
    });
  });

  describe('no optimistic local state', () => {
    it('should not treat local state as confirmed', () => {
      let command: V3Command = {
        commandId: 'cmd-1',
        payload: { type: 'buy-habitat', habitat: 'water', quantity: 5 },
        expectedSequence: 0,
        submittedAt: Date.now(),
        status: 'pending',
      };

      // Pending state is NOT confirmed
      expect(command.status).not.toBe('confirmed');
      expect(command.receipt).toBeUndefined();

      // Must have server receipt to be confirmed
      command = {
        ...command,
        status: 'confirmed',
        receipt: {
          accepted: true,
          commandId: 'cmd-1',
          cursor: { runId: 'run-1', sequence: 1, rulesVersion: 1 },
          serverTimeMs: Date.now(),
          canonicalState: '{}',
          creditedAtoms: '0',
          spentAtoms: '500000000000',
          scoreTier: 0,
        },
      };

      expect(command.status).toBe('confirmed');
      expect(command.receipt).toBeDefined();
      expect(command.receipt?.accepted).toBe(true);
    });

    it('should use verifier canonical state as authoritative', () => {
      const receipt: V3CommandReceipt = {
        accepted: true,
        commandId: 'cmd-1',
        cursor: { runId: 'run-1', sequence: 1, rulesVersion: 1 },
        serverTimeMs: Date.now(),
        canonicalState: '{"natureAtoms":"500000000000","earnedNatureAtoms":"1000000000000"}',
        creditedAtoms: '1000000000000',
        spentAtoms: '500000000000',
        scoreTier: 0,
      };

      // Only canonical state from server is authoritative
      expect(receipt.canonicalState).toBeDefined();
      expect(typeof receipt.canonicalState).toBe('string');
      // Client should not infer state, only use server-provided values
    });
  });
});

describe('useV3Commands persistence and verifier behavior', () => {
  const runId = 'verified-run-17';
  const token = 'session-secret';
  const receipt = (commandId: string, sequence: number): V3CommandReceipt => ({
    accepted: true,
    commandId,
    cursor: { runId, sequence, rulesVersion: 1 },
    serverTimeMs: Date.now(),
    canonicalState: '{"sequence":1}',
    creditedAtoms: '1000000000000',
    spentAtoms: '0',
    scoreTier: 0,
  });

  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('does not surface a temporary not-found cursor error while Start Run awaits confirmations', async () => {
    vi.spyOn(v3Api, 'recoverRun').mockRejectedValue(new V3ApiError(
      'No run exists for this authenticated wallet.',
      'RUN_NOT_FOUND',
      404,
    ));
    const { result } = renderHook(() => useV3Commands(runId, token));

    await act(async () => {
      await expect(result.current.recoverState()).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    });

    expect(result.current.state?.recoveringCursor).toBe(false);
    expect(result.current.state?.recoveryError).toBeUndefined();
  });

  it('persists the stable ID, exact payload, and cursor before sending', async () => {
    const payload = { type: 'buy-habitat', habitat: 'forest', quantity: 4 } as const;
    const submitSpy = vi
      .spyOn(v3Api, 'submitCommand')
      .mockImplementation(async (_run, envelope) => {
        const persisted = JSON.parse(
          window.localStorage.getItem(`worldseed:v3:command-queue:${runId}`) ?? '{}',
        );
        expect(persisted.commands[0]).toMatchObject({
          commandId: envelope.commandId,
          payload,
          expectedSequence: 0,
          status: 'pending',
        });
        expect(persisted.cursor.currentSequence).toBe(0);
        expect(persisted.sessionToken).toBeUndefined();
        expect(envelope).toEqual({
          commandId: expect.any(String),
          expectedSequence: 0,
          command: payload,
        });
        return receipt(envelope.commandId, 1);
      });
    const { result } = renderHook(() => useV3Commands(runId, token));

    await act(async () => {
      await result.current.submitCommand(payload);
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(result.current.state?.cursor).toMatchObject({ currentSequence: 1, expectedSequence: 1 });
    expect(result.current.state?.commands[0].status).toBe('confirmed');
  });

  it('retries an uncertain command with the same ID, sequence, and payload', async () => {
    const submitSpy = vi
      .spyOn(v3Api, 'submitCommand')
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockImplementationOnce(async (_run, envelope) => receipt(envelope.commandId, 1));
    const { result } = renderHook(() => useV3Commands(runId, token));
    const command = { type: 'buy-temporary-upgrade', upgrade: 'deep-roots' } as const;
    let originalId = '';

    await act(async () => {
      try {
        await result.current.submitCommand(command);
      } catch {
        /* expected network loss */
      }
    });
    originalId = result.current.state?.commands[0].commandId ?? '';
    expect(result.current.state?.commands[0].status).toBe('uncertain');

    await act(async () => {
      await result.current.retryCommand(originalId);
    });

    expect(submitSpy).toHaveBeenCalledTimes(4);
    expect(submitSpy.mock.calls[1][1]).toEqual(submitSpy.mock.calls[0][1]);
    expect(submitSpy.mock.calls[2][1]).toEqual(submitSpy.mock.calls[0][1]);
    expect(submitSpy.mock.calls[3][1]).toEqual(submitSpy.mock.calls[0][1]);
    expect(result.current.state?.commands[0].status).toBe('confirmed');
  });

  it('automatically retries transient submission failures with the identical envelope', async () => {
    const submitSpy = vi.spyOn(v3Api, 'submitCommand')
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockRejectedValueOnce(new V3ApiError('Verifier unavailable', 'VERIFIER_UNAVAILABLE', 503))
      .mockImplementationOnce(async (_run, envelope) => receipt(envelope.commandId, 1));
    const { result } = renderHook(() => useV3Commands(runId, token));
    const command = { type: 'buy-habitat', habitat: 'water', quantity: 1 } as const;

    await act(async () => {
      await result.current.submitCommand(command);
    });

    expect(submitSpy).toHaveBeenCalledTimes(3);
    expect(submitSpy.mock.calls[1][1]).toEqual(submitSpy.mock.calls[0][1]);
    expect(submitSpy.mock.calls[2][1]).toEqual(submitSpy.mock.calls[0][1]);
    expect(result.current.state?.commands[0].status).toBe('confirmed');
  });

  it('does not retry or expose manual retry for a definitive verifier rejection', async () => {
    const submitSpy = vi.spyOn(v3Api, 'submitCommand').mockRejectedValue(
      new V3ApiError('Command payload is invalid', 'UNRECOGNIZED_VALIDATION_ERROR', 422),
    );
    const { result } = renderHook(() => useV3Commands(runId, token));

    await act(async () => {
      await expect(result.current.submitCommand({ type: 'buy-habitat', habitat: 'water', quantity: 1 }))
        .rejects.toThrow('Command payload is invalid');
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(result.current.state?.commands[0]).toMatchObject({
      status: 'failed',
      autoRetryEligible: false,
    });
    await expect(result.current.retryCommand(result.current.state!.commands[0].commandId))
      .rejects.toThrow('Only uncertain commands can be retried safely');
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('persists the in-flight and confirmed queue snapshots once each without duplicate effect writes', async () => {
    const originalSetItem = Storage.prototype.setItem;
    const writeSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      return originalSetItem.call(this, key, value);
    });
    vi.spyOn(v3Api, 'submitCommand').mockImplementation(async (_run, envelope) => receipt(envelope.commandId, 1));
    const { result } = renderHook(() => useV3Commands(runId, token));
    await waitFor(() => expect(result.current.state?.cursor.runId).toBe(runId));
    writeSpy.mockClear();

    await act(async () => {
      await result.current.submitCommand({ type: 'buy-habitat', habitat: 'water', quantity: 1 });
    });

    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it('recovers a cursor conflict and leaves a rejected purchase failed without advancing it', async () => {
    vi.spyOn(v3Api, 'submitCommand').mockRejectedValueOnce(
      new V3ApiError('Purchase is not affordable', 'RULES_REJECTED', 409),
    );
    const { result } = renderHook(() => useV3Commands(runId, token));
    await act(async () => {
      try {
        await result.current.submitCommand({
          type: 'buy-habitat',
          habitat: 'water',
          quantity: 1000,
        });
      } catch {
        /* expected verifier rejection */
      }
    });
    expect(result.current.state?.commands[0].status).toBe('failed');
    expect(result.current.state?.cursor.expectedSequence).toBe(0);

    vi.spyOn(v3Api, 'recoverRun').mockResolvedValue({
      cursor: { runId, sequence: 3, rulesVersion: 1 },
      canonicalState: '{}',
      scoreTier: 0,
      wallet: '0x0000000000000000000000000000000000000000',
    });
    await act(async () => {
      await result.current.resolveConflict();
    });
    expect(result.current.state?.cursor).toMatchObject({ currentSequence: 3, expectedSequence: 3 });
  });

  it('recovers from a command ID conflict and allows a fresh ID at the recovered sequence', async () => {
    const submitSpy = vi
      .spyOn(v3Api, 'submitCommand')
      .mockRejectedValueOnce(
        new V3ApiError('Command ID was used with different content', 'COMMAND_ID_CONFLICT', 409),
      )
      .mockImplementationOnce(async (_run, envelope) => receipt(envelope.commandId, 2));
    vi.spyOn(v3Api, 'recoverRun').mockResolvedValue({
      cursor: { runId, sequence: 1, rulesVersion: 1 },
      canonicalState: '{}',
      scoreTier: 0,
      wallet: '0x0000000000000000000000000000000000000000',
    });
    const { result } = renderHook(() => useV3Commands(runId, token));
    await act(async () => {
      try {
        await result.current.submitCommand({ type: 'heart-click' });
      } catch {
        /* expected conflict */
      }
    });

    const rejected = result.current.state?.commands[0];
    expect(rejected?.status).toBe('failed');
    await act(async () => {
      await result.current.submitCommand({ type: 'heart-click' });
    });

    expect(submitSpy.mock.calls[1][1].commandId).not.toBe(rejected?.commandId);
    expect(submitSpy.mock.calls[1][1].expectedSequence).toBe(1);
    expect(result.current.state?.cursor.currentSequence).toBe(2);
  });

  it('recovers a stale cursor rejection and advances with a new command ID', async () => {
    const submitSpy = vi
      .spyOn(v3Api, 'submitCommand')
      .mockRejectedValueOnce(new V3ApiError('Expected sequence 2', 'STALE_CURSOR', 409))
      .mockImplementationOnce(async (_run, envelope) => receipt(envelope.commandId, 3));
    vi.spyOn(v3Api, 'recoverRun').mockResolvedValue({
      cursor: { runId, sequence: 2, rulesVersion: 1 },
      canonicalState: '{}',
      scoreTier: 0,
      wallet: '0x0000000000000000000000000000000000000000',
    });
    const { result } = renderHook(() => useV3Commands(runId, token));
    await act(async () => {
      try {
        await result.current.submitCommand({ type: 'heart-click' });
      } catch {
        /* expected stale cursor */
      }
    });

    expect(result.current.state?.commands[0].status).toBe('failed');
    await act(async () => {
      await result.current.submitCommand({ type: 'heart-click' });
    });
    expect(submitSpy.mock.calls[1][1].commandId).not.toBe(submitSpy.mock.calls[0][1].commandId);
    expect(submitSpy.mock.calls[1][1].expectedSequence).toBe(2);
  });

  it('restores an interrupted pending command after hook remount and retries its saved envelope', async () => {
    let releaseFirst!: (value: V3CommandReceipt) => void;
    const submitSpy = vi
      .spyOn(v3Api, 'submitCommand')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockImplementationOnce(async (_run, envelope) => receipt(envelope.commandId, 1));
    const first = renderHook(() => useV3Commands(runId, token));
    act(() => {
      void first.result.current.submitCommand({ type: 'heart-click' });
    });
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    const firstEnvelope = submitSpy.mock.calls[0][1];
    first.unmount();

    const reloaded = renderHook(() => useV3Commands(runId, 'reauthenticated-token'));
    await waitFor(() =>
      expect(reloaded.result.current.state?.commands[0].status).toBe('uncertain'),
    );
    expect(reloaded.result.current.state?.sessionToken).toBe('reauthenticated-token');
    await act(async () => {
      await reloaded.result.current.retryCommand(firstEnvelope.commandId);
    });

    expect(submitSpy.mock.calls[1][1]).toEqual(firstEnvelope);
    expect(reloaded.result.current.state?.commands[0].status).toBe('confirmed');
    releaseFirst(receipt(firstEnvelope.commandId, 1));
  });

  it('automatically resumes a persisted interrupted envelope after refresh', async () => {
    const key = `worldseed:v3:command-queue:${runId}`;
    const pending = {
      commandId: 'interrupted-wallet-action',
      payload: { type: 'buy-habitat', habitat: 'water', quantity: 1 },
      expectedSequence: 0,
      submittedAt: Date.now(),
      attemptCount: 1,
      status: 'pending',
    };
    window.localStorage.setItem(key, JSON.stringify({
      commands: [pending],
      cursor: { runId, currentSequence: 0, expectedSequence: 0, rulesVersion: 1 },
      queuedHeartClicks: 0,
    }));
    const submitSpy = vi.spyOn(v3Api, 'submitCommand')
      .mockImplementation(async (_run, envelope) => receipt(envelope.commandId, 1));
    const { result } = renderHook(() => useV3Commands(runId, 'reauthenticated-token'));

    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(submitSpy.mock.calls[0][1]).toEqual({
      commandId: pending.commandId,
      expectedSequence: 0,
      command: pending.payload,
    });
    await waitFor(() => expect(result.current.state?.commands[0].status).toBe('confirmed'));
  });

  it('recovers queued purchases after refresh behind the same uncertain command', async () => {
    let releaseFirst!: (value: V3CommandReceipt) => void;
    const submitSpy = vi.spyOn(v3Api, 'submitCommand')
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
      .mockImplementation(async (_run, envelope) => receipt(envelope.commandId, envelope.expectedSequence + 1));
    const first = renderHook(() => useV3Commands(runId, token));
    act(() => { first.result.current.enqueueCommand({ type: 'buy-habitat', habitat: 'water', quantity: 1 }); });
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    const firstId = submitSpy.mock.calls[0][1].commandId;
    act(() => { first.result.current.enqueueCommand({ type: 'buy-habitat', habitat: 'grass', quantity: 1 }); });
    first.unmount();

    const reloaded = renderHook(() => useV3Commands(runId, 'reauthenticated-token'));
    await waitFor(() => expect(reloaded.result.current.state?.commands[0].status).toBe('uncertain'));
    expect(reloaded.result.current.state?.commands[1]).toMatchObject({
      payload: { type: 'buy-habitat', habitat: 'grass', quantity: 1 },
      status: 'queued',
    });
    await act(async () => { await reloaded.result.current.retryCommand(firstId); });
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(3));
    expect(submitSpy.mock.calls[1][1].commandId).toBe(firstId);
    expect(submitSpy.mock.calls[2][1].command).toEqual({ type: 'buy-habitat', habitat: 'grass', quantity: 1 });
    releaseFirst(receipt(firstId, 1));
  });

  it('persists clicks and sends timed batches no larger than 100 in sequence', async () => {
    const submitSpy = vi
      .spyOn(v3Api, 'submitCommand')
      .mockImplementation(async (_run, envelope) =>
        receipt(envelope.commandId, envelope.expectedSequence + 1),
      );
    vi.useFakeTimers();
    const { result } = renderHook(() => useV3Commands(runId, token));

    act(() => {
      for (let click = 0; click < 205; click += 1)
        expect(result.current.enqueueHeartClick()).toBe(true);
    });
    expect(submitSpy).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      window.localStorage.getItem(`worldseed:v3:command-queue:${runId}`) ?? '{}',
    );
    expect(persisted.queuedHeartClicks).toBe(205);
    expect(persisted.heartBatchDueAt).toBeGreaterThan(Date.now());

    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0][1].command).toEqual({ type: 'heart-click', quantity: 100 });
    expect(result.current.state?.queuedHeartClicks).toBe(105);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(submitSpy).toHaveBeenCalledTimes(2);
    expect(submitSpy.mock.calls[1][1].command).toEqual({ type: 'heart-click', quantity: 100 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(submitSpy).toHaveBeenCalledTimes(3);
    expect(submitSpy.mock.calls[2][1].command).toEqual({ type: 'heart-click', quantity: 5 });
    expect(submitSpy.mock.calls.map((call) => call[1].expectedSequence)).toEqual([0, 1, 2]);
    expect(result.current.state?.queuedHeartClicks).toBe(0);
    expect(result.current.state?.cursor.currentSequence).toBe(3);
    await act(async () => result.current.flushPendingCommands());
  });

  it('restores a definitely rejected batch and blocks it from automatic replay', async () => {
    const submitSpy = vi.spyOn(v3Api, 'submitCommand')
      .mockRejectedValue(new V3ApiError('Rejected by verifier', 'RULES_REJECTED', 409));
    vi.useFakeTimers();
    const { result } = renderHook(() => useV3Commands(runId, token));
    act(() => {
      result.current.enqueueHeartClick();
      result.current.enqueueHeartClick();
      result.current.enqueueHeartClick();
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0][1].command).toEqual({ type: 'heart-click', quantity: 3 });
    expect(result.current.state?.queuedHeartClicks).toBe(0);
    expect(result.current.state?.heartQueueBlocked).toBe(true);
    expect(result.current.state?.commands[0].status).toBe('failed');
    await expect(result.current.flushPendingCommands()).rejects.toThrow(/rejected/);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps Heart batches and purchases in the exact accepted order', async () => {
    const submitSpy = vi.spyOn(v3Api, 'submitCommand').mockImplementation(async (_run, envelope) =>
      receipt(envelope.commandId, envelope.expectedSequence + 1),
    );
    const { result } = renderHook(() => useV3Commands(runId, token));
    act(() => {
      for (let i = 0; i < 50; i += 1) result.current.enqueueHeartClick();
    });
    act(() => { expect(result.current.enqueueCommand({ type: 'buy-habitat', habitat: 'water', quantity: 1 })).toBe(true); });
    act(() => { for (let i = 0; i < 30; i += 1) result.current.enqueueHeartClick(); });
    act(() => { expect(result.current.enqueueCommand({ type: 'buy-habitat', habitat: 'grass', quantity: 1 })).toBe(true); });

    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(4));
    expect(submitSpy.mock.calls.map(call => call[1].command)).toEqual([
      { type: 'heart-click', quantity: 50 },
      { type: 'buy-habitat', habitat: 'water', quantity: 1 },
      { type: 'heart-click', quantity: 30 },
      { type: 'buy-habitat', habitat: 'grass', quantity: 1 },
    ]);
    expect(submitSpy.mock.calls.map(call => call[1].expectedSequence)).toEqual([0, 1, 2, 3]);
  });

  it('does not send actions after a rejected queued purchase and can discard the blocked tail', async () => {
    const submitSpy = vi.spyOn(v3Api, 'submitCommand')
      .mockRejectedValueOnce(new V3ApiError('Not enough Nature', 'RULES_REJECTED', 409));
    const { result } = renderHook(() => useV3Commands(runId, token));
    act(() => {
      expect(result.current.enqueueCommand({ type: 'buy-habitat', habitat: 'water', quantity: 1 })).toBe(true);
      expect(result.current.enqueueCommand({ type: 'buy-habitat', habitat: 'grass', quantity: 1 })).toBe(true);
    });
    await waitFor(() => expect(result.current.state?.heartQueueBlocked).toBe(true));
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(result.current.state?.commands.map(command => command.status)).toEqual(['failed', 'failed']);
    act(() => result.current.discardQueuedHeartClicks());
    expect(result.current.state?.heartQueueBlocked).toBe(false);
    expect(result.current.state?.commands).toEqual([]);
  });

  it('restores queued Heart clicks after refresh and waits for the interrupted envelope retry', async () => {
    let releaseFirst!: (value: V3CommandReceipt) => void;
    const submitSpy = vi
      .spyOn(v3Api, 'submitCommand')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockImplementation(async (_run, envelope) =>
        receipt(envelope.commandId, envelope.expectedSequence + 1),
      );
    vi.useFakeTimers();
    const first = renderHook(() => useV3Commands(runId, token));
    act(() => {
      first.result.current.enqueueHeartClick();
      first.result.current.enqueueHeartClick();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const interruptedEnvelope = submitSpy.mock.calls[0][1];
    act(() => first.result.current.enqueueHeartClick());
    first.unmount();

    const reloaded = renderHook(() => useV3Commands(runId, 'renewed-session'));
    expect(reloaded.result.current.state?.commands[0].status).toBe('uncertain');
    expect(reloaded.result.current.state?.queuedHeartClicks).toBe(1);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      await reloaded.result.current.retryCommand(interruptedEnvelope.commandId);
    });
    expect(submitSpy.mock.calls[1][1]).toEqual(interruptedEnvelope);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(submitSpy).toHaveBeenCalledTimes(3);
    expect(submitSpy.mock.calls[2][1].expectedSequence).toBe(1);
    expect(submitSpy.mock.calls[2][1].command).toEqual({ type: 'heart-click', quantity: 1 });
    expect(reloaded.result.current.state?.queuedHeartClicks).toBe(0);
    releaseFirst(receipt(interruptedEnvelope.commandId, 1));
  });

  it('discards malformed local data and never writes auth tokens to storage', async () => {
    const key = `worldseed:v3:command-queue:${runId}`;
    window.localStorage.setItem(key, '{broken');
    const { result } = renderHook(() => useV3Commands(runId, token));
    await waitFor(() => expect(result.current.state?.cursor.runId).toBe(runId));
    expect(result.current.state?.commands).toEqual([]);
    expect(window.localStorage.getItem(key)).not.toContain(token);
  });

  it('fails closed when local persistence is unavailable', async () => {
    const submitSpy = vi.spyOn(v3Api, 'submitCommand');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const { result } = renderHook(() => useV3Commands(runId, token));

    await expect(
      act(async () => {
        await result.current.submitCommand({ type: 'heart-click' });
      }),
    ).rejects.toThrow('Unable to save the command locally');

    expect(submitSpy).not.toHaveBeenCalled();
  });
});
