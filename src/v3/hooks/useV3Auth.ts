/**
 * V3 Authentication Hook
 *
 * Manages wallet authentication with the V3 verifier:
 * - Request authentication challenge
 * - Sign challenge with wallet
 * - Submit signature and establish session
 * - Handle session expiration, wallet changes, and disconnection
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useChainId, useSignMessage } from 'wagmi';
import { v3Api, V3ApiError } from '../api';
import { v3ContractAddress, isV3Configured } from '../config';
import { TARGET_CHAIN_ID } from '../../blockchain/config';

export type V3AuthStatus =
  'idle' | 'requesting-challenge' | 'signing' | 'completing' | 'authenticated' | 'error';

export interface V3AuthState {
  status: V3AuthStatus;
  sessionToken: string | null;
  expiresAtMs: number | null;
  error: string | null;
  wallet: `0x${string}` | null;
  runId: string | null;
  isAuthenticated: boolean;
  isConfigured: boolean;
  isCorrectChain: boolean;
}

const emptyAuthState: V3AuthState = {
  status: 'idle',
  sessionToken: null,
  expiresAtMs: null,
  error: null,
  wallet: null,
  runId: null,
  isAuthenticated: false,
  isConfigured: false,
  isCorrectChain: false,
};

export function useV3Auth() {
  const account = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();

  const [state, setState] = useState<V3AuthState>(emptyAuthState);
  const expirationTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const prevAccountRef = useRef<string | null>(null);

  const isConfigured = isV3Configured();
  const isCorrectChain = chainId === TARGET_CHAIN_ID;
  const canAuthenticate = !!(isConfigured && account.address && isCorrectChain);

  // Handle session expiration
  const scheduleSessionExpiration = useCallback((expiresAtMs: number) => {
    if (expirationTimerRef.current) {
      globalThis.clearTimeout(expirationTimerRef.current);
    }

    const timeUntilExpiry = expiresAtMs - Date.now();
    if (timeUntilExpiry > 0) {
      expirationTimerRef.current = globalThis.setTimeout(() => {
        setState((prev) => ({
          ...prev,
          status: 'idle',
          sessionToken: null,
          expiresAtMs: null,
          isAuthenticated: false,
          runId: null,
          error: 'Session expired',
        }));
      }, timeUntilExpiry);
    }
  }, []);

  // Clear session on wallet disconnect or chain change
  useEffect(() => {
    const walletChanged = account.address !== prevAccountRef.current;
    const chainChanged = chainId !== TARGET_CHAIN_ID;

    if (walletChanged || chainChanged) {
      if (state.isAuthenticated) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setState((prev) => ({
          ...prev,
          status: 'idle',
          sessionToken: null,
          expiresAtMs: null,
          isAuthenticated: false,
          runId: null,
          error: null,
        }));
        if (expirationTimerRef.current) {
          globalThis.clearTimeout(expirationTimerRef.current);
          expirationTimerRef.current = null;
        }
      }
      prevAccountRef.current = account.address || null;
    }

    // Update configuration state
    setState((prev) => ({
      ...prev,
      wallet: account.address || null,
      isConfigured,
      isCorrectChain,
    }));
  }, [account.address, chainId, isConfigured, isCorrectChain, state.isAuthenticated]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (expirationTimerRef.current) {
        globalThis.clearTimeout(expirationTimerRef.current);
      }
    };
  }, []);

  /**
   * Request authentication challenge from verifier
   */
  const requestChallenge = useCallback(
    async (runId: string) => {
      if (!account.address || !isCorrectChain || !isConfigured || !v3ContractAddress) {
        setState((prev) => ({
          ...prev,
          error: 'Wallet not connected or V3 not configured',
        }));
        return null;
      }

      setState((prev) => ({
        ...prev,
        status: 'requesting-challenge',
        error: null,
      }));

      try {
        const challenge = await v3Api.requestChallenge({
          wallet: account.address,
          chainId: String(TARGET_CHAIN_ID),
          verifyingContract: v3ContractAddress,
          runId,
        });

        return challenge;
      } catch (err) {
        const message = err instanceof V3ApiError ? err.message : 'Failed to request challenge';
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: message,
        }));
        return null;
      }
    },
    [account.address, isCorrectChain, isConfigured],
  );

  /**
   * Sign challenge and complete authentication
   */
  const authenticate = useCallback(
    async (runId: string) => {
      if (!account.address || !isCorrectChain || !isConfigured || !v3ContractAddress) {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: 'Wallet not connected or V3 not configured',
        }));
        return false;
      }

      setState((prev) => ({
        ...prev,
        status: 'requesting-challenge',
        error: null,
      }));

      try {
        // Step 1: Request challenge
        const challenge = await v3Api.requestChallenge({
          wallet: account.address,
          chainId: String(TARGET_CHAIN_ID),
          verifyingContract: v3ContractAddress,
          runId,
        });

        setState((prev) => ({
          ...prev,
          status: 'signing',
        }));

        // Step 2: Sign challenge with wallet
        const signature = await signMessageAsync({
          message: challenge.message,
        });

        setState((prev) => ({
          ...prev,
          status: 'completing',
        }));

        // Step 3: Complete challenge
        const session = await v3Api.completeChallenge({
          challengeId: challenge.challengeId,
          signature,
        });

        // Store session and schedule expiration
        scheduleSessionExpiration(session.expiresAtMs);

        setState((prev) => ({
          ...prev,
          status: 'authenticated',
          sessionToken: session.sessionToken,
          expiresAtMs: session.expiresAtMs,
          isAuthenticated: true,
          runId,
          error: null,
        }));

        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Authentication failed';
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: message,
          isAuthenticated: false,
          sessionToken: null,
          expiresAtMs: null,
          runId: null,
        }));
        return false;
      }
    },
    [account.address, isCorrectChain, isConfigured, signMessageAsync, scheduleSessionExpiration],
  );

  /**
   * Clear authentication and reset to idle state
   */
  const logout = useCallback(() => {
    if (expirationTimerRef.current) {
      globalThis.clearTimeout(expirationTimerRef.current);
      expirationTimerRef.current = null;
    }

    setState((prev) => ({
      ...prev,
      status: 'idle',
      sessionToken: null,
      expiresAtMs: null,
      isAuthenticated: false,
      runId: null,
      error: null,
    }));
  }, []);

  /**
   * Retry authentication after an error
   */
  const retry = useCallback(
    async (runId: string) => {
      return authenticate(runId);
    },
    [authenticate],
  );

  return {
    // State
    ...state,
    canAuthenticate,

    // Actions
    requestChallenge,
    authenticate,
    logout,
    retry,
  };
}
