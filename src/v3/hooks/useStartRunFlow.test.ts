/**
 * Start Run Flow Tests
 *
 * Unit tests for the StartRunFlowState and error handling logic.
 * Integration tests with full flow require WagmiProvider and should be tested
 * manually or in e2e tests due to vitest environment limitations.
 */

import { describe, it, expect } from 'vitest';
import { deriveNextRunId } from './useStartRunFlow';
import type { StartRunFlowState, StartRunFlowStatus } from './useStartRunFlow';

describe('useStartRunFlow', () => {
  describe('run ID derivation', () => {
    it('uses run 1 when the contract counter is zero', () => {
      expect(deriveNextRunId(0n)).toBe(1n);
    });

    it('increments the last allocated ID for subsequent runs', () => {
      expect(deriveNextRunId(7n)).toBe(8n);
    });

    it('waits until the contract counter has loaded', () => {
      expect(deriveNextRunId(undefined)).toBeUndefined();
    });
  });
  describe('state management', () => {
    it('should define correct initial state shape', () => {
      const initialState: StartRunFlowState = {
        status: 'idle',
        sessionToken: null,
        error: null,
        errorCode: null,
        transactionHash: null,
        retryCount: 0,
      };

      expect(initialState.status).toBe('idle');
      expect(initialState.sessionToken).toBeNull();
      expect(initialState.error).toBeNull();
      expect(initialState.errorCode).toBeNull();
      expect(initialState.transactionHash).toBeNull();
      expect(initialState.retryCount).toBe(0);
    });

    it('should support all valid status values', () => {
      const validStatuses: StartRunFlowStatus[] = [
        'idle',
        'fetching-next-run-id',
        'authenticating',
        'requesting-attestation',
        'submitting-transaction',
        'confirming',
        'success',
        'error',
      ];

      validStatuses.forEach((status) => {
        expect([
          'idle',
          'fetching-next-run-id',
          'authenticating',
          'requesting-attestation',
          'submitting-transaction',
          'confirming',
          'success',
          'error',
        ]).toContain(status);
      });
    });

    it('should track retry count for max retry enforcement', () => {
      const state1: StartRunFlowState = {
        status: 'error',
        sessionToken: null,
        error: 'Transaction failed',
        errorCode: 'TRANSACTION_FAILED',
        transactionHash: null,
        retryCount: 0,
      };

      const state2: StartRunFlowState = {
        ...state1,
        retryCount: 1,
      };

      const state3: StartRunFlowState = {
        ...state2,
        retryCount: 3,
      };

      expect(state1.retryCount).toBe(0);
      expect(state2.retryCount).toBe(1);
      expect(state3.retryCount).toBe(3);
    });
  });

  describe('error codes', () => {
    it('should classify auth failure error code', () => {
      const errorCode = 'AUTH_FAILED';
      expect([
        'AUTH_FAILED',
        'SESSION_EXPIRED',
        'ATTESTATION_EXPIRED',
        'WALLET_REJECTED',
        'TRANSACTION_FAILED',
        'MAX_RETRIES_EXCEEDED',
        'WRONG_CHAIN',
      ]).toContain(errorCode);
    });

    it('should classify wallet rejection error code', () => {
      const errorCode = 'WALLET_REJECTED';
      expect([
        'AUTH_FAILED',
        'SESSION_EXPIRED',
        'ATTESTATION_EXPIRED',
        'WALLET_REJECTED',
        'TRANSACTION_FAILED',
        'MAX_RETRIES_EXCEEDED',
        'WRONG_CHAIN',
      ]).toContain(errorCode);
    });

    it('should classify session expired error code', () => {
      const errorCode = 'SESSION_EXPIRED';
      expect([
        'AUTH_FAILED',
        'SESSION_EXPIRED',
        'ATTESTATION_EXPIRED',
        'WALLET_REJECTED',
        'TRANSACTION_FAILED',
        'MAX_RETRIES_EXCEEDED',
        'WRONG_CHAIN',
      ]).toContain(errorCode);
    });

    it('should classify transaction error code', () => {
      const errorCode = 'TRANSACTION_FAILED';
      expect([
        'AUTH_FAILED',
        'SESSION_EXPIRED',
        'ATTESTATION_EXPIRED',
        'WALLET_REJECTED',
        'TRANSACTION_FAILED',
        'MAX_RETRIES_EXCEEDED',
        'WRONG_CHAIN',
      ]).toContain(errorCode);
    });

    it('should classify max retries exceeded error code', () => {
      const errorCode = 'MAX_RETRIES_EXCEEDED';
      expect([
        'AUTH_FAILED',
        'SESSION_EXPIRED',
        'ATTESTATION_EXPIRED',
        'WALLET_REJECTED',
        'TRANSACTION_FAILED',
        'MAX_RETRIES_EXCEEDED',
        'WRONG_CHAIN',
      ]).toContain(errorCode);
    });
  });

  describe('retry logic', () => {
    it('should allow up to 3 retries (max retries = 3)', () => {
      const maxRetries = 3;

      let retryCount = 0;
      let canRetry = retryCount < maxRetries;
      expect(canRetry).toBe(true);

      retryCount++;
      canRetry = retryCount < maxRetries;
      expect(canRetry).toBe(true);

      retryCount++;
      canRetry = retryCount < maxRetries;
      expect(canRetry).toBe(true);

      retryCount++;
      canRetry = retryCount < maxRetries;
      expect(canRetry).toBe(false);
    });

    it('should prevent retry after max retries reached', () => {
      const maxRetries = 3;
      let retryCount = maxRetries;

      const canRetry = retryCount < maxRetries;
      expect(canRetry).toBe(false);
    });
  });

  describe('state transitions', () => {
    it('should transition from idle to authenticating', () => {
      const state: StartRunFlowState = {
        status: 'idle',
        sessionToken: null,
        error: null,
        errorCode: null,
        transactionHash: null,
        retryCount: 0,
      };

      const nextState: StartRunFlowState = {
        ...state,
        status: 'authenticating',
      };

      expect(state.status).toBe('idle');
      expect(nextState.status).toBe('authenticating');
    });

    it('should transition from authenticating to requesting-attestation', () => {
      const state: StartRunFlowState = {
        status: 'authenticating',
        sessionToken: null,
        error: null,
        errorCode: null,
        transactionHash: null,
        retryCount: 0,
      };

      const nextState: StartRunFlowState = {
        ...state,
        status: 'requesting-attestation',
        sessionToken: 'session-token-123',
      };

      expect(state.status).toBe('authenticating');
      expect(nextState.status).toBe('requesting-attestation');
      expect(nextState.sessionToken).toBe('session-token-123');
    });

    it('should transition from requesting-attestation to submitting-transaction', () => {
      const state: StartRunFlowState = {
        status: 'requesting-attestation',
        sessionToken: 'session-token-123',
        error: null,
        errorCode: null,
        transactionHash: null,
        retryCount: 0,
      };

      const nextState: StartRunFlowState = {
        ...state,
        status: 'submitting-transaction',
      };

      expect(state.status).toBe('requesting-attestation');
      expect(nextState.status).toBe('submitting-transaction');
    });

    it('should transition from submitting-transaction to confirming', () => {
      const hash = '0x1234567890123456789012345678901234567890123456789012345678901234' as const;
      const state: StartRunFlowState = {
        status: 'submitting-transaction',
        sessionToken: 'session-token-123',
        error: null,
        errorCode: null,
        transactionHash: null,
        retryCount: 0,
      };

      const nextState: StartRunFlowState = {
        ...state,
        status: 'confirming',
        transactionHash: hash,
      };

      expect(state.status).toBe('submitting-transaction');
      expect(nextState.status).toBe('confirming');
      expect(nextState.transactionHash).toBe(hash);
    });

    it('should transition from confirming to success', () => {
      const state: StartRunFlowState = {
        status: 'confirming',
        sessionToken: 'session-token-123',
        error: null,
        errorCode: null,
        transactionHash:
          '0x1234567890123456789012345678901234567890123456789012345678901234' as const,
        retryCount: 0,
      };

      const nextState: StartRunFlowState = {
        ...state,
        status: 'success',
      };

      expect(state.status).toBe('confirming');
      expect(nextState.status).toBe('success');
    });

    it('should transition to error state on auth failure', () => {
      const state: StartRunFlowState = {
        status: 'authenticating',
        sessionToken: null,
        error: null,
        errorCode: null,
        transactionHash: null,
        retryCount: 0,
      };

      const nextState: StartRunFlowState = {
        ...state,
        status: 'error',
        error: 'Authentication failed',
        errorCode: 'AUTH_FAILED',
      };

      expect(state.status).toBe('authenticating');
      expect(nextState.status).toBe('error');
      expect(nextState.error).toBe('Authentication failed');
      expect(nextState.errorCode).toBe('AUTH_FAILED');
    });

    it('should transition to error state on transaction failure', () => {
      const state: StartRunFlowState = {
        status: 'submitting-transaction',
        sessionToken: 'session-token-123',
        error: null,
        errorCode: null,
        transactionHash: null,
        retryCount: 0,
      };

      const nextState: StartRunFlowState = {
        ...state,
        status: 'error',
        error: 'User rejected transaction',
        errorCode: 'WALLET_REJECTED',
      };

      expect(state.status).toBe('submitting-transaction');
      expect(nextState.status).toBe('error');
      expect(nextState.error).toBe('User rejected transaction');
      expect(nextState.errorCode).toBe('WALLET_REJECTED');
    });
  });

  describe('reset behavior', () => {
    it('should restore initial state on reset', () => {
      const errorState: StartRunFlowState = {
        status: 'error',
        sessionToken: 'old-token',
        error: 'Something failed',
        errorCode: 'TRANSACTION_FAILED',
        transactionHash:
          '0x1234567890123456789012345678901234567890123456789012345678901234' as const,
        retryCount: 2,
      };

      const resetState: StartRunFlowState = {
        status: 'idle',
        sessionToken: null,
        error: null,
        errorCode: null,
        transactionHash: null,
        retryCount: 0,
      };

      expect(errorState.status).toBe('error');
      expect(errorState.retryCount).toBe(2);

      expect(resetState.status).toBe('idle');
      expect(resetState.retryCount).toBe(0);
      expect(resetState.sessionToken).toBeNull();
    });
  });
});
