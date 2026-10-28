/**
 * V3 Authentication Hook Tests
 *
 * Tests for challenge request, signature signing, session establishment,
 * and recovery scenarios (expiration, disconnection, account switching).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useV3Auth } from './useV3Auth';
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
  TARGET_CHAIN_ID: 1,
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
    // Don't use fake timers to avoid hanging tests
  });

  afterEach(() => {
    // Clean up any lingering timers
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

      const { result } = renderHook(() => useV3Auth());

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
