/**
 * Start Run Flow Hook
 *
 * Orchestrates the complete Start Run flow:
 * 1. Get next run ID from contract
 * 2. Authenticate with verifier (via useV3Auth)
 * 3. Request Start Run attestation
 * 4. Submit transaction with attestation
 * 5. Wait for confirmation
 * 6. Handle errors and provide retry UI
 */

import { useCallback, useState } from 'react';
import { useAccount, useChainId, useReadContract } from 'wagmi';
import { v3ContractAbi, v3ContractAddress, isV3Configured } from '../config';
import { TARGET_CHAIN_ID } from '../../blockchain/config';
import type { V3UpgradeKind } from '../types';

export type StartRunFlowStatus =
  | 'idle'
  | 'fetching-next-run-id'
  | 'authenticating'
  | 'requesting-attestation'
  | 'submitting-transaction'
  | 'confirming'
  | 'success'
  | 'error';

export interface StartRunFlowState {
  status: StartRunFlowStatus;
  sessionToken: string | null;
  error: string | null;
  errorCode: string | null;
  transactionHash: `0x${string}` | null;
  retryCount: number;
}

interface StartRunFlowCallbacks {
  onAuthRequired: () => Promise<string>; // Returns session token
  onStartRun: (
    sessionToken: string,
    upgrades: Array<{ upgradeId: number; quantity: number }>,
  ) => Promise<`0x${string}`>;
}

const emptyState: StartRunFlowState = {
  status: 'idle',
  sessionToken: null,
  error: null,
  errorCode: null,
  transactionHash: null,
  retryCount: 0,
};

/** The contract stores the last allocated ID; the next run uses counter + 1. */
export function deriveNextRunId(counter: bigint | undefined): bigint | undefined {
  return counter === undefined ? undefined : counter + 1n;
}

/**
 * Start Run flow orchestrator hook
 *
 * Usage:
 * ```tsx
 * const { state, start, retry, reset } = useStartRunFlow({
 *   onAuthRequired: async () => {
 *     // Use useV3Auth to authenticate and get session token
 *     const success = await authenticate(nextRunId);
 *     if (!success) throw new Error('Authentication failed');
 *     return sessionToken;
 *   },
 *   onStartRun: (sessionToken, upgrades) => {
 *     // Use useV3Run.startRun with the session token
 *     return startRun(sessionToken, upgrades);
 *   },
 * });
 * ```
 */
export function useStartRunFlow(callbacks: StartRunFlowCallbacks) {
  const account = useAccount();
  const chainId = useChainId();
  const [state, setState] = useState<StartRunFlowState>(emptyState);
  const maxRetries = 3;

  const isConfigured = isV3Configured();
  const isCorrectChain = chainId === TARGET_CHAIN_ID;
  const canAccess = isConfigured && account.address && isCorrectChain;

  // Read next run ID
  const nextRunIdData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'nextRunId',
    args: account.address ? [account.address] : undefined,
    query: {
      enabled: canAccess,
    },
  });
  const refreshNextRunId = nextRunIdData.refetch;

  /**
   * Execute the flow with error handling
   */
  const executeFlow = useCallback(
    async (upgrades: Array<{ upgradeId: V3UpgradeKind; quantity: number }>) => {
      try {
        // Step 1: Authenticate
        setState((prev) => ({
          ...prev,
          status: 'authenticating',
          error: null,
          errorCode: null,
        }));

        let sessionToken: string;
        try {
          sessionToken = await callbacks.onAuthRequired();
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Authentication failed';
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: message,
            errorCode: 'AUTH_FAILED',
          }));
          return false;
        }

        setState((prev) => ({
          ...prev,
          sessionToken,
        }));

        // Step 2-5: Submit transaction (handled by onStartRun)
        setState((prev) => ({
          ...prev,
          status: 'requesting-attestation',
        }));

        const upgradeChoices = upgrades.map((u) => ({
          upgradeId:
            u.upgradeId === 'growth'
              ? 0
              : u.upgradeId === 'efficiency'
                ? 1
                : u.upgradeId === 'awakening'
                  ? 2
                  : 3, // rebirth
          quantity: u.quantity,
        }));

        try {
          setState((prev) => ({
            ...prev,
            status: 'submitting-transaction',
          }));

          const hash = await callbacks.onStartRun(sessionToken, upgradeChoices);

          // The contract increments its counter when Start Run is confirmed. Refresh it
          // before exposing the next run ID to authentication or another start attempt.
          await refreshNextRunId().catch(() => undefined);

          setState((prev) => ({
            ...prev,
            status: 'success',
            transactionHash: hash,
          }));

          return true;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Transaction failed';
          const errorCode = message.includes('User rejected')
            ? 'WALLET_REJECTED'
            : message.includes('Session expired')
              ? 'SESSION_EXPIRED'
              : message.includes('expired')
                ? 'ATTESTATION_EXPIRED'
                : message.includes('chain')
                  ? 'WRONG_CHAIN'
                  : 'TRANSACTION_FAILED';

          setState((prev) => ({
            ...prev,
            status: 'error',
            error: message,
            errorCode,
          }));
          return false;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unexpected error';
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: message,
          errorCode: 'UNEXPECTED_ERROR',
        }));
        return false;
      }
    },
    [callbacks, refreshNextRunId],
  );

  /**
   * Start the Run creation flow
   */
  const start = useCallback(
    async (upgrades: Array<{ upgradeId: V3UpgradeKind; quantity: number }>) => {
      if (!canAccess) {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: 'Wallet not connected or V3 not configured',
          errorCode: 'WALLET_NOT_READY',
        }));
        return false;
      }

      // `nextRunId` is the last allocated counter. Zero is valid for a new wallet;
      // the actual run ID is the counter plus one.
      if (nextRunIdData.data === undefined) {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: 'Could not determine next run ID',
          errorCode: 'RUN_ID_UNKNOWN',
        }));
        return false;
      }

      setState((prev) => ({
        ...prev,
        retryCount: 0,
      }));

      return executeFlow(upgrades);
    },
    [canAccess, nextRunIdData.data, executeFlow],
  );

  /**
   * Retry the flow after an error
   */
  const retry = useCallback(
    async (upgrades: Array<{ upgradeId: V3UpgradeKind; quantity: number }>) => {
      setState((prev) => {
        if (prev.retryCount >= maxRetries) {
          return {
            ...prev,
            error: `Max retries (${maxRetries}) exceeded`,
            errorCode: 'MAX_RETRIES_EXCEEDED',
          };
        }

        return {
          ...prev,
          retryCount: prev.retryCount + 1,
        };
      });

      return executeFlow(upgrades);
    },
    [executeFlow],
  );

  /**
   * Reset the flow to idle state
   */
  const reset = useCallback(() => {
    setState(emptyState);
  }, []);

  return {
    state,
    start,
    retry,
    reset,
    nextRunId: deriveNextRunId(nextRunIdData.data),
    refreshNextRunId,
    canRetry: state.retryCount < maxRetries,
  };
}
