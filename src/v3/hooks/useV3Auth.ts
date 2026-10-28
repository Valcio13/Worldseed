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

interface InMemoryV3Session {
  wallet: string;
  chainId: number;
  verifyingContract: string;
  runId: string;
  sessionToken: string | null;
  expiresAtMs: number;
}

const SESSION_STORAGE_KEY = 'worldseed:v3:wallet-session:v1';

function readStoredSession(): InMemoryV3Session | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('Invalid session');
    const session = value as Partial<InMemoryV3Session>;
    if (
      typeof session.wallet !== 'string' || !/^0x[\da-f]{40}$/i.test(session.wallet) ||
      !Number.isSafeInteger(session.chainId) || typeof session.verifyingContract !== 'string' ||
      !/^0x[\da-f]{40}$/i.test(session.verifyingContract) ||
      typeof session.runId !== 'string' || !/^\d+$/.test(session.runId) ||
      typeof session.sessionToken !== 'string' || !session.sessionToken ||
      typeof session.expiresAtMs !== 'number' || !Number.isFinite(session.expiresAtMs)
    ) throw new Error('Invalid session');
    if (session.expiresAtMs <= Date.now()) {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return session as InMemoryV3Session;
  } catch {
    try {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Storage can be unavailable in restricted browser contexts.
    }
    return null;
  }
}

function persistSession(session: InMemoryV3Session | null): void {
  try {
    if (session?.sessionToken)
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // The current page can still use its in-memory session if storage is blocked.
  }
}

// Tab-scoped storage survives refresh and Live/Guest remounts without retaining
// the short-lived verifier token across browser sessions.
let inMemorySession: InMemoryV3Session | null = null;
let inMemoryExpiryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

function clearInMemorySession(): void {
  if (inMemoryExpiryTimer) globalThis.clearTimeout(inMemoryExpiryTimer);
  inMemoryExpiryTimer = null;
  inMemorySession = null;
  persistSession(null);
}

function cacheInMemorySession(session: InMemoryV3Session): void {
  if (inMemoryExpiryTimer) globalThis.clearTimeout(inMemoryExpiryTimer);
  inMemoryExpiryTimer = null;
  if (session.expiresAtMs <= Date.now()) {
    inMemorySession = { ...session, sessionToken: null };
    persistSession(null);
    return;
  }
  inMemorySession = session;
  persistSession(session);
  inMemoryExpiryTimer = globalThis.setTimeout(() => {
    if (inMemorySession?.sessionToken === session.sessionToken) {
      inMemorySession = { ...session, sessionToken: null };
      persistSession(null);
    }
    inMemoryExpiryTimer = null;
  }, session.expiresAtMs - Date.now());
}

function readInMemorySession(wallet?: string, chainId?: number): InMemoryV3Session | null {
  if (!inMemorySession) {
    const stored = readStoredSession();
    if (stored) cacheInMemorySession(stored);
  }
  if (!inMemorySession || !wallet || wallet.toLowerCase() !== inMemorySession.wallet ||
      chainId !== inMemorySession.chainId || v3ContractAddress?.toLowerCase() !== inMemorySession.verifyingContract)
    return null;
  if (inMemorySession.sessionToken && inMemorySession.expiresAtMs <= Date.now()) {
    if (inMemoryExpiryTimer) globalThis.clearTimeout(inMemoryExpiryTimer);
    inMemoryExpiryTimer = null;
    inMemorySession = { ...inMemorySession, sessionToken: null };
    persistSession(null);
  }
  return inMemorySession;
}

/** Clears the page-memory verifier session after logout or explicit disconnect. */
export function clearV3AuthSession(): void {
  clearInMemorySession();
}

function authStateFromSession(
  session: InMemoryV3Session,
  isConfigured: boolean,
  isCorrectChain: boolean,
): V3AuthState {
  const isAuthenticated = Boolean(session.sessionToken);
  return {
    ...emptyAuthState,
    status: isAuthenticated ? 'authenticated' : 'idle',
    sessionToken: session.sessionToken,
    expiresAtMs: isAuthenticated ? session.expiresAtMs : null,
    error: isAuthenticated ? null : 'Session expired',
    wallet: session.wallet as `0x${string}`,
    runId: isAuthenticated ? session.runId : null,
    isAuthenticated,
    isConfigured,
    isCorrectChain,
  };
}

export function useV3Auth() {
  const account = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();

  const isConfigured = isV3Configured();
  const isCorrectChain = chainId === TARGET_CHAIN_ID;
  const [state, setState] = useState<V3AuthState>(() => {
    const cached = readInMemorySession(account.address, chainId);
    return cached
      ? authStateFromSession(cached, isConfigured, isCorrectChain)
      : {
          ...emptyAuthState,
          wallet: account.address ?? null,
          isConfigured,
          isCorrectChain,
        };
  });
  const expirationTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const prevAccountRef = useRef<string | null>(inMemorySession?.wallet ?? account.address ?? null);

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
        if (inMemorySession?.expiresAtMs === expiresAtMs) {
          inMemorySession = { ...inMemorySession, sessionToken: null };
          persistSession(null);
        }
      }, timeUntilExpiry);
    }
  }, []);

  // Clear session on wallet disconnect or chain change
  useEffect(() => {
    const walletChanged = account.address !== prevAccountRef.current;
    const chainChanged = chainId !== TARGET_CHAIN_ID;
    const detachedSession = !account.address ? inMemorySession ?? readStoredSession() : null;

    // A provider disconnect is recoverable: keep the run-bound bearer session
    // alive until it expires so reconnecting the same wallet can resume it.
    // Explicit in-app disconnect calls logout first and clears this session.
    if (
      !account.address &&
      account.status === 'disconnected' &&
      !chainChanged &&
      detachedSession &&
      detachedSession.chainId === chainId &&
      detachedSession.verifyingContract === v3ContractAddress?.toLowerCase()
    ) {
      if (!inMemorySession) cacheInMemorySession(detachedSession);
      if (detachedSession.sessionToken) scheduleSessionExpiration(detachedSession.expiresAtMs);
      const detachedState = authStateFromSession(detachedSession, isConfigured, isCorrectChain);
      if (
        state.sessionToken !== detachedState.sessionToken ||
        state.wallet !== detachedState.wallet
      ) setState(detachedState);
      prevAccountRef.current = null;
      return;
    }

    const cached = readInMemorySession(account.address, chainId);

    // During page refresh/provider reconnect the wallet can be temporarily
    // absent. Keep its scoped session until Wagmi resolves the account.
    if (!account.address && (account.status === 'connecting' || account.status === 'reconnecting'))
      return;

    if (walletChanged || chainChanged) {
      if (cached && !chainChanged) {
        scheduleSessionExpiration(cached.expiresAtMs);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setState(authStateFromSession(cached, isConfigured, isCorrectChain));
      } else {
        clearInMemorySession();
        if (expirationTimerRef.current) {
          globalThis.clearTimeout(expirationTimerRef.current);
          expirationTimerRef.current = null;
        }
        setState({
          ...emptyAuthState,
          wallet: account.address ?? null,
          isConfigured,
          isCorrectChain,
        });
      }
      prevAccountRef.current = account.address || null;
      return;
    }

    if (cached?.sessionToken) {
      scheduleSessionExpiration(cached.expiresAtMs);
      if (!state.isAuthenticated || state.sessionToken !== cached.sessionToken) {
        setState(authStateFromSession(cached, isConfigured, isCorrectChain));
        return;
      }
    }

    // Update configuration state
    setState((prev) => ({
      ...prev,
      wallet: account.address || null,
      isConfigured,
      isCorrectChain,
    }));
  }, [account.address, account.status, chainId, isConfigured, isCorrectChain, scheduleSessionExpiration, state.isAuthenticated, state.sessionToken, state.wallet]);

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

        cacheInMemorySession({
          wallet: account.address.toLowerCase(),
          chainId: TARGET_CHAIN_ID,
          verifyingContract: v3ContractAddress.toLowerCase(),
          runId,
          sessionToken: session.sessionToken,
          expiresAtMs: session.expiresAtMs,
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
    clearInMemorySession();
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
