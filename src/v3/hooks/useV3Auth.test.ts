/**
 * V3 Authentication Hook Tests
 *
 * Tests for challenge request, signature signing, session establishment,
 * and recovery scenarios (expiration, disconnection, account switching).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { clearV3AuthSession, useV3Auth } from './useV3Auth';
import { useAccount, useChainId, useSignMessage } from 'wagmi';
import { v3Api } from '../api';

// Mock wagmi hooks
vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useChainId: vi.fn(),
  useSignMessage: vi.fn(),
  createConfig: vi.fn(),
}));

// Mock v3Api
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api');
  return {
    ...actual,
    v3Api: {
      requestChallenge: vi.fn(),
      completeChallenge: vi.fn(),
    },
  };
});

// Mock v3 config
vi.mock('../config', () => ({
  isV3Configured: () => true,
  v3ContractAddress: '0x1234567890123456789012345678901234567890' as `0x${string}`,
}));

// Mock blockchain config to avoid createConfig import issues
vi.mock('../../blockchain/config', () => ({
  IS_HEMI_MAINNET: false,
  TARGET_CHAIN_ID: 1,
  TARGET_CHAIN_NAME: 'Hemi Sepolia',
}));

describe('useV3Auth', () => {
  const mockWallet = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`;
  const mockRunId = '1';
  const mockChallengeId = 'challenge-123';
  const mockMessage = 'Sign this message';
  const mockSignature =
    '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`;
  const mockSessionToken = 'token-abc123';
  const mockExpiresAtMs = Date.now() + 900000; // 15 minutes

  beforeEach(() => {
    vi.clearAllMocks();
    clearV3AuthSession();
    window.sessionStorage.clear();
    // Don't use fake timers to avoid hanging tests
  });

  afterEach(() => {
    vi.useRealTimers();
    clearV3AuthSession();
  });

  describe('initial state', () => {
    it('should initialize with idle state and no session', () => {
      vi.mocked(useAccount).mockReturnValue({ address: null } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      vi.mocked(useSignMessage).mockReturnValue({ signMessageAsync: vi.fn() } as never);

      const { result } = renderHook(() => useV3Auth());

      expect(result.current.status).toBe('idle');
      expect(result.current.sessionToken).toBeNull();
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.runId).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('should indicate when V3 is not configured', () => {
      vi.mocked(useAccount).mockReturnValue({ address: null } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      vi.mocked(useSignMessage).mockReturnValue({ signMessageAsync: vi.fn() } as never);

      const { result } = renderHook(() => useV3Auth());

      expect(result.current.isConfigured).toBe(true); // mocked to true
      expect(result.current.canAuthenticate).toBe(false); // no wallet connected
    });

    it('should indicate when on wrong chain', () => {
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet } as never);
      vi.mocked(useChainId).mockReturnValue(999); // wrong chain
      vi.mocked(useSignMessage).mockReturnValue({ signMessageAsync: vi.fn() } as never);

      const { result } = renderHook(() => useV3Auth());

      expect(result.current.isCorrectChain).toBe(false);
      expect(result.current.canAuthenticate).toBe(false);
    });
  });

  describe('successful authentication', () => {
    it('should complete full authentication flow', async () => {
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      vi.mocked(useSignMessage).mockReturnValue({
        signMessageAsync: vi.fn().mockResolvedValue(mockSignature),
      } as never);

      vi.mocked(v3Api.requestChallenge).mockResolvedValue({
        challengeId: mockChallengeId,
        message: mockMessage,
        expiresAtMs: Date.now() + 300000,
      });

      vi.mocked(v3Api.completeChallenge).mockResolvedValue({
        sessionToken: mockSessionToken,
        expiresAtMs: mockExpiresAtMs,
      });

      const { result } = renderHook(() => useV3Auth());

      // Initial state
      expect(result.current.status).toBe('idle');

      // Start authentication
      await act(async () => {
        const success = await result.current.authenticate(mockRunId);
        expect(success).toBe(true);
      });

      // Should be authenticated
      expect(result.current.status).toBe('authenticated');
      expect(result.current.sessionToken).toBe(mockSessionToken);
      expect(result.current.expiresAtMs).toBe(mockExpiresAtMs);
      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.runId).toBe(mockRunId);
      expect(result.current.error).toBeNull();

      // Verify API calls
      expect(v3Api.requestChallenge).toHaveBeenCalledWith({
        wallet: mockWallet,
        chainId: '1',
        verifyingContract: '0x1234567890123456789012345678901234567890',
        runId: mockRunId,
      });

      expect(v3Api.completeChallenge).toHaveBeenCalledWith({
        challengeId: mockChallengeId,
        signature: mockSignature,
      });
    });

    it('restores an unexpired session after a Live/Guest hook remount without signing again', async () => {
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      const signMessageAsync = vi.fn().mockResolvedValue(mockSignature);
      vi.mocked(useSignMessage).mockReturnValue({ signMessageAsync } as never);
      vi.mocked(v3Api.requestChallenge).mockResolvedValue({
        challengeId: mockChallengeId,
        message: mockMessage,
        expiresAtMs: Date.now() + 300000,
      });
      vi.mocked(v3Api.completeChallenge).mockResolvedValue({
        sessionToken: mockSessionToken,
        expiresAtMs: Date.now() + 900000,
      });

      const firstMount = renderHook(() => useV3Auth());
      await act(async () => {
        expect(await firstMount.result.current.authenticate(mockRunId)).toBe(true);
      });
      firstMount.unmount();

      const secondMount = renderHook(() => useV3Auth());
      expect(secondMount.result.current.isAuthenticated).toBe(true);
      expect(secondMount.result.current.sessionToken).toBe(mockSessionToken);
      expect(secondMount.result.current.runId).toBe(mockRunId);
      expect(signMessageAsync).toHaveBeenCalledOnce();
      expect(localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(1);
      act(() => secondMount.result.current.logout());
    });

    it('restores an unexpired scoped session after a page refresh without another signature', async () => {
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet, status: 'connected' } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      const signMessageAsync = vi.fn().mockResolvedValue(mockSignature);
      vi.mocked(useSignMessage).mockReturnValue({ signMessageAsync } as never);
      vi.mocked(v3Api.requestChallenge).mockResolvedValue({
        challengeId: mockChallengeId,
        message: mockMessage,
        expiresAtMs: Date.now() + 300000,
      });
      vi.mocked(v3Api.completeChallenge).mockResolvedValue({
        sessionToken: mockSessionToken,
        expiresAtMs: Date.now() + 900000,
      });

      const firstPage = renderHook(() => useV3Auth());
      await act(async () => {
        expect(await firstPage.result.current.authenticate(mockRunId)).toBe(true);
      });
      firstPage.unmount();
      expect(window.sessionStorage.length).toBe(1);

      // A page reload creates a fresh hook module while tab-scoped storage remains.
      vi.resetModules();
      const refreshedWagmi = await import('wagmi');
      vi.mocked(refreshedWagmi.useAccount).mockReturnValue({
        address: mockWallet,
        status: 'connected',
      } as never);
      vi.mocked(refreshedWagmi.useChainId).mockReturnValue(1);
      vi.mocked(refreshedWagmi.useSignMessage).mockReturnValue({
        signMessageAsync,
      } as never);
      const refreshedAuth = await import('./useV3Auth');
      const secondPage = renderHook(() => refreshedAuth.useV3Auth());

      expect(secondPage.result.current.isAuthenticated).toBe(true);
      expect(secondPage.result.current.sessionToken).toBe(mockSessionToken);
      expect(secondPage.result.current.runId).toBe(mockRunId);
      expect(signMessageAsync).toHaveBeenCalledOnce();
      act(() => refreshedAuth.clearV3AuthSession());
    });

    it('expires cached sessions while unmounted and requires explicit authentication again', async () => {
      vi.useFakeTimers();
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      const signMessageAsync = vi.fn().mockResolvedValue(mockSignature);
      vi.mocked(useSignMessage).mockReturnValue({ signMessageAsync } as never);
      vi.mocked(v3Api.requestChallenge).mockResolvedValue({
        challengeId: mockChallengeId,
        message: mockMessage,
        expiresAtMs: Date.now() + 300000,
      });
      vi.mocked(v3Api.completeChallenge).mockResolvedValue({
        sessionToken: mockSessionToken,
        expiresAtMs: Date.now() + 5000,
      });

      const firstMount = renderHook(() => useV3Auth());
      await act(async () => {
        expect(await firstMount.result.current.authenticate(mockRunId)).toBe(true);
      });
      firstMount.unmount();
      await vi.advanceTimersByTimeAsync(5001);

      const secondMount = renderHook(() => useV3Auth());
      expect(secondMount.result.current.isAuthenticated).toBe(false);
      expect(secondMount.result.current.sessionToken).toBeNull();
      expect(secondMount.result.current.error).toBe('Session expired');
      expect(window.sessionStorage.length).toBe(0);
      expect(signMessageAsync).toHaveBeenCalledOnce();
      act(() => secondMount.result.current.logout());
    });

    it('should request challenge separately', async () => {
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      vi.mocked(useSignMessage).mockReturnValue({
        signMessageAsync: vi.fn(),
      } as never);

      vi.mocked(v3Api.requestChallenge).mockResolvedValue({
        challengeId: mockChallengeId,
        message: mockMessage,
        expiresAtMs: Date.now() + 300000,
      });

      const { result } = renderHook(() => useV3Auth());

      let challenge;
      await act(async () => {
        challenge = await result.current.requestChallenge(mockRunId);
      });

      expect(challenge).toEqual({
        challengeId: mockChallengeId,
        message: mockMessage,
        expiresAtMs: expect.any(Number),
      });

      expect(v3Api.requestChallenge).toHaveBeenCalledWith({
        wallet: mockWallet,
        chainId: '1',
        verifyingContract: '0x1234567890123456789012345678901234567890',
        runId: mockRunId,
      });
    });
  });

  describe('authentication failures', () => {
    it('should handle challenge request failure', async () => {
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      vi.mocked(useSignMessage).mockReturnValue({
        signMessageAsync: vi.fn(),
      } as never);

      const errorMessage = 'Challenge request failed';
      vi.mocked(v3Api.requestChallenge).mockRejectedValue(new Error(errorMessage));

      const { result } = renderHook(() => useV3Auth());

      await act(async () => {
        const success = await result.current.authenticate(mockRunId);
        expect(success).toBe(false);
      });

      expect(result.current.status).toBe('error');
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.runId).toBeNull();
      expect(result.current.error).toBe(errorMessage);
    });

    it('should handle signing failure', async () => {
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      vi.mocked(useSignMessage).mockReturnValue({
        signMessageAsync: vi.fn().mockRejectedValue(new Error('User rejected signing')),
      } as never);

      vi.mocked(v3Api.requestChallenge).mockResolvedValue({
        challengeId: mockChallengeId,
        message: mockMessage,
        expiresAtMs: Date.now() + 300000,
      });

      const { result } = renderHook(() => useV3Auth());

      await act(async () => {
        const success = await result.current.authenticate(mockRunId);
        expect(success).toBe(false);
      });

      expect(result.current.status).toBe('error');
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.error).toContain('User rejected signing');
    });

    it('should handle completion failure', async () => {
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      vi.mocked(useSignMessage).mockReturnValue({
        signMessageAsync: vi.fn().mockResolvedValue(mockSignature),
      } as never);

      vi.mocked(v3Api.requestChallenge).mockResolvedValue({
        challengeId: mockChallengeId,
        message: mockMessage,
        expiresAtMs: Date.now() + 300000,
      });

      const errorMessage = 'Invalid signature';
      vi.mocked(v3Api.completeChallenge).mockRejectedValue(new Error(errorMessage));

      const { result } = renderHook(() => useV3Auth());

      await act(async () => {
        const success = await result.current.authenticate(mockRunId);
        expect(success).toBe(false);
      });

      expect(result.current.status).toBe('error');
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.error).toBe(errorMessage);
    });

    it('should reject authentication when wallet not connected', async () => {
      vi.mocked(useAccount).mockReturnValue({ address: null } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      vi.mocked(useSignMessage).mockReturnValue({
        signMessageAsync: vi.fn(),
      } as never);

      const { result } = renderHook(() => useV3Auth());

      await act(async () => {
        const success = await result.current.authenticate(mockRunId);
        expect(success).toBe(false);
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error).toContain('not connected');
    });

    it('should reject authentication on wrong chain', async () => {
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet } as never);
      vi.mocked(useChainId).mockReturnValue(999);
      vi.mocked(useSignMessage).mockReturnValue({
        signMessageAsync: vi.fn(),
      } as never);

      const { result } = renderHook(() => useV3Auth());

      await act(async () => {
        const success = await result.current.authenticate(mockRunId);
        expect(success).toBe(false);
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error).toContain('not configured');
    });
  });

  describe('session management', () => {
    it('should clear session on logout', async () => {
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      vi.mocked(useSignMessage).mockReturnValue({
        signMessageAsync: vi.fn().mockResolvedValue(mockSignature),
      } as never);

      vi.mocked(v3Api.requestChallenge).mockResolvedValue({
        challengeId: mockChallengeId,
        message: mockMessage,
        expiresAtMs: Date.now() + 300000,
      });

      vi.mocked(v3Api.completeChallenge).mockResolvedValue({
        sessionToken: mockSessionToken,
        expiresAtMs: mockExpiresAtMs,
      });

      const { result, unmount } = renderHook(() => useV3Auth());

      await act(async () => {
        await result.current.authenticate(mockRunId);
      });

      expect(result.current.isAuthenticated).toBe(true);

      act(() => {
        result.current.logout();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.sessionToken).toBeNull();
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.error).toBeNull();
      expect(window.sessionStorage.length).toBe(0);

      unmount();
      const afterLogout = renderHook(() => useV3Auth());
      expect(afterLogout.result.current.isAuthenticated).toBe(false);
      expect(afterLogout.result.current.sessionToken).toBeNull();
    });

    it('does not reuse a stored session after the connected wallet changes', async () => {
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet, status: 'connected' } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      vi.mocked(useSignMessage).mockReturnValue({
        signMessageAsync: vi.fn().mockResolvedValue(mockSignature),
      } as never);
      vi.mocked(v3Api.requestChallenge).mockResolvedValue({
        challengeId: mockChallengeId,
        message: mockMessage,
        expiresAtMs: Date.now() + 300000,
      });
      vi.mocked(v3Api.completeChallenge).mockResolvedValue({
        sessionToken: mockSessionToken,
        expiresAtMs: Date.now() + 900000,
      });

      const { result, rerender } = renderHook(() => useV3Auth());
      await act(async () => {
        expect(await result.current.authenticate(mockRunId)).toBe(true);
      });
      expect(window.sessionStorage.length).toBe(1);

      vi.mocked(useAccount).mockReturnValue({ address: null, status: 'disconnected' } as never);
      rerender();

      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.sessionToken).toBe(mockSessionToken);
      expect(result.current.wallet).toBe(mockWallet);
      expect(window.sessionStorage.length).toBe(1);

      vi.mocked(useAccount).mockReturnValue({
        address: '0x1111111111111111111111111111111111111111',
        status: 'connected',
      } as never);
      rerender();

      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.sessionToken).toBeNull();
      expect(window.sessionStorage.length).toBe(0);
    });
  });

  describe('retry', () => {
    it('should retry authentication after error', async () => {
      vi.mocked(useAccount).mockReturnValue({ address: mockWallet } as never);
      vi.mocked(useChainId).mockReturnValue(1);
      vi.mocked(useSignMessage).mockReturnValue({
        signMessageAsync: vi.fn().mockResolvedValue(mockSignature),
      } as never);

      // First attempt fails
      vi.mocked(v3Api.requestChallenge).mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useV3Auth());

      await act(async () => {
        const success = await result.current.authenticate(mockRunId);
        expect(success).toBe(false);
      });

      expect(result.current.status).toBe('error');

      // Second attempt succeeds
      vi.mocked(v3Api.requestChallenge).mockResolvedValueOnce({
        challengeId: mockChallengeId,
        message: mockMessage,
        expiresAtMs: Date.now() + 300000,
      });

      vi.mocked(v3Api.completeChallenge).mockResolvedValueOnce({
        sessionToken: mockSessionToken,
        expiresAtMs: mockExpiresAtMs,
      });

      await act(async () => {
        const success = await result.current.retry(mockRunId);
        expect(success).toBe(true);
      });

      expect(result.current.status).toBe('authenticated');
      expect(result.current.isAuthenticated).toBe(true);
    });
  });
});
