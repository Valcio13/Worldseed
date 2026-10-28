/**
 * V3 API Client Tests
 *
 * Tests for successful requests, error responses, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  v3Api,
  V3ApiError,
  type V3ChallengeRequest,
  type V3ChallengeCompletion,
  type V3StartAttestationRequest,
  type V3CommandEnvelope,
  createMockV3Api,
} from './api';

// Mock fetch globally
const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function mockFetchResponse(status: number, data: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as Response);
}

describe('V3 API Client', () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
  });

  describe('health check', () => {
    it('should return health status', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      const result = await v3Api.health();
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/health'));
    });
  });

  describe('authentication', () => {
    it('should request challenge', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce(
        mockFetchResponse(200, {
          challengeId: 'chal-123',
          message: 'Sign this',
          expiresAtMs: Date.now() + 300000,
        }),
      );

      const req: V3ChallengeRequest = {
        wallet: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        chainId: '1',
        verifyingContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
        runId: '1',
      };

      const result = await v3Api.requestChallenge(req);
      expect(result.challengeId).toBe('chal-123');
      expect(result.message).toBe('Sign this');
    });

    it('should complete challenge with signature', async () => {
      const sessionResponse = {
        sessionToken: 'token-123',
        expiresAtMs: Date.now() + 900000,
      };

      vi.mocked(fetchMock).mockResolvedValueOnce(mockFetchResponse(200, sessionResponse));

      const req: V3ChallengeCompletion = {
        challengeId: 'chal-123',
        signature:
          '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`,
      };

      const result = await v3Api.completeChallenge(req);
      expect(result.sessionToken).toBe('token-123');
    });

    it('should handle authentication error', async () => {
      vi.mocked(fetchMock).mockResolvedValue(
        mockFetchResponse(401, {
          code: 'UNAUTHENTICATED',
          message: 'Session expired',
        }),
      );

      const req: V3ChallengeCompletion = {
        challengeId: 'chal-123',
        signature: '0xdeadbeef' as `0x${string}`,
      };

      await expect(v3Api.completeChallenge(req)).rejects.toThrow(V3ApiError);
      try {
        await v3Api.completeChallenge(req);
      } catch (e) {
        expect((e as V3ApiError).code).toBe('UNAUTHENTICATED');
        expect((e as V3ApiError).status).toBe(401);
      }
    });
  });

  describe('start run', () => {
    it('should get start attestation with upgrades', async () => {
      const attestation = {
        attestation: {
          player: '0x1234567890123456789012345678901234567890' as `0x${string}`,
          runId: '1',
          seasonId: '0',
          chainId: '1',
          verifyingContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
          scoreTier: 0,
          nonce: '0',
          issuedAt: '1234567890',
          expiresAt: '1234568190',
          rulesVersion: 1,
          signerEpoch: 1,
          upgradeChoicesHash:
            '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
          actionType: 'START_RUN' as const,
        },
        signature:
          '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`,
        digest:
          '0xcafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe' as `0x${string}`,
        upgradeChoices: [{ upgradeId: 0, quantity: 1 }],
      };

      vi.mocked(fetchMock).mockResolvedValueOnce(mockFetchResponse(200, attestation));

      const req: V3StartAttestationRequest = {
        upgradeChoices: [{ upgradeId: 'growth', quantity: 1 }],
      };

      const result = await v3Api.getStartAttestation('1', req, 'session-token');
      expect(result.attestation.actionType).toBe('START_RUN');
      expect(result.upgradeChoices[0].upgradeId).toBe(0);
    });

    it('should handle sequence conflict', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce(
        mockFetchResponse(409, {
          code: 'SEQUENCE_GAP',
          message: 'Expected sequence 5, got 10',
          expectedSequence: 5,
        }),
      );

      await expect(v3Api.getStartAttestation('1', {}, 'token')).rejects.toThrow(V3ApiError);
    });
  });

  describe('commands', () => {
    it('should submit heart-click command', async () => {
      const receipt = {
        accepted: true,
        commandId: 'cmd-1',
        cursor: { runId: '1', sequence: 1, rulesVersion: 1 },
        serverTimeMs: Date.now(),
        canonicalState: '{}',
        creditedAtoms: '1000000000000',
        spentAtoms: '0',
        scoreTier: 0,
      };

      vi.mocked(fetchMock).mockResolvedValueOnce(mockFetchResponse(200, receipt));

      const cmd: V3CommandEnvelope = {
        commandId: 'cmd-1',
        expectedSequence: 0,
        command: { type: 'heart-click' },
      };

      const result = await v3Api.submitCommand('1', cmd, 'token');
      expect(result.accepted).toBe(true);
      expect(result.creditedAtoms).toBe('1000000000000');
    });

    it('should handle buy-habitat command', async () => {
      const receipt = {
        accepted: true,
        commandId: 'cmd-2',
        cursor: { runId: '1', sequence: 2, rulesVersion: 1 },
        serverTimeMs: Date.now(),
        canonicalState: '{}',
        creditedAtoms: '0',
        spentAtoms: '100000000000',
        scoreTier: 0,
      };

      vi.mocked(fetchMock).mockResolvedValueOnce(mockFetchResponse(200, receipt));

      const cmd: V3CommandEnvelope = {
        commandId: 'cmd-2',
        expectedSequence: 1,
        command: { type: 'buy-habitat', habitat: 'water', quantity: 5 },
      };

      const result = await v3Api.submitCommand('1', cmd, 'token');
      expect(result.spentAtoms).toBe('100000000000');
    });

    it('rejects invalid command IDs, cursors, and habitat quantities before network submission', async () => {
      const valid = (overrides: Partial<V3CommandEnvelope>): V3CommandEnvelope => ({
        commandId: 'valid-id',
        expectedSequence: 0,
        command: { type: 'heart-click' },
        ...overrides,
      });
      await expect(v3Api.submitCommand('1', valid({ commandId: '' }), 'token')).rejects.toThrow(
        'commandId',
      );
      await expect(
        v3Api.submitCommand('1', valid({ expectedSequence: Number.MAX_SAFE_INTEGER + 1 }), 'token'),
      ).rejects.toThrow('expectedSequence');
      await expect(
        v3Api.submitCommand(
          '1',
          valid({
            command: { type: 'buy-habitat', habitat: 'water', quantity: 1001 },
          }),
          'token',
        ),
      ).rejects.toThrow('1 through 1000');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should handle command not found error', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce(
        mockFetchResponse(404, {
          code: 'RUN_NOT_FOUND',
          message: 'Run 999 not found',
        }),
      );

      const cmd: V3CommandEnvelope = {
        commandId: 'cmd-1',
        expectedSequence: 0,
        command: { type: 'heart-click' },
      };

      await expect(v3Api.submitCommand('999', cmd, 'token')).rejects.toThrow(V3ApiError);
    });
  });

  describe('recovery', () => {
    it('should recover run state', async () => {
      const recovery = {
        cursor: { runId: '1', sequence: 5, rulesVersion: 1 },
        canonicalState: '{"habitatsLevel":{"water":2,"grass":1,"forest":0}}',
        scoreTier: 1,
        wallet: '0x1234567890123456789012345678901234567890' as `0x${string}`,
      };

      vi.mocked(fetchMock).mockResolvedValueOnce(mockFetchResponse(200, recovery));

      const result = await v3Api.recoverRun('1', 'token');
      expect(result.cursor.sequence).toBe(5);
      expect(result.scoreTier).toBe(1);
    });
  });

  describe('checkpoints', () => {
    it('should get checkpoint attestation', async () => {
      const checkpoint = {
        attestation: {
          player: '0x1234567890123456789012345678901234567890' as `0x${string}`,
          runId: '1',
          seasonId: '0',
          chainId: '1',
          verifyingContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
          scoreTier: 5,
          nonce: '1',
          issuedAt: '1234567890',
          expiresAt: '1234568190',
          rulesVersion: 1,
          signerEpoch: 1,
          upgradeChoicesHash:
            '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
          actionType: 'RECORD_POINTS' as const,
        },
        signature: '0xdeadbeef' as `0x${string}`,
        digest: '0xcafebabe' as `0x${string}`,
      };

      vi.mocked(fetchMock).mockResolvedValueOnce(mockFetchResponse(200, checkpoint));

      const result = await v3Api.getCheckpointAttestation('1', 'token');
      expect(result.attestation.actionType).toBe('RECORD_POINTS');
      expect(result.attestation.scoreTier).toBe(5);
    });
  });

  describe('rebirth', () => {
    it('should get rebirth attestation', async () => {
      const rebirth = {
        attestation: {
          player: '0x1234567890123456789012345678901234567890' as `0x${string}`,
          runId: '1',
          seasonId: '0',
          chainId: '1',
          verifyingContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
          scoreTier: 50,
          nonce: '2',
          issuedAt: '1234567890',
          expiresAt: '1234568190',
          rulesVersion: 1,
          signerEpoch: 1,
          upgradeChoicesHash:
            '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
          actionType: 'REBIRTH' as const,
        },
        signature: '0xdeadbeef' as `0x${string}`,
        digest: '0xcafebabe' as `0x${string}`,
      };

      vi.mocked(fetchMock).mockResolvedValueOnce(mockFetchResponse(200, rebirth));

      const result = await v3Api.getRebirthAttestation('1', 'token');
      expect(result.attestation.actionType).toBe('REBIRTH');
    });

    it('should handle rebirth not ready error', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce(
        mockFetchResponse(409, {
          code: 'SCORE_BELOW_THRESHOLD',
          message: 'Score does not meet rebirth threshold',
        }),
      );

      await expect(v3Api.getRebirthAttestation('1', 'token')).rejects.toThrow(V3ApiError);
    });
  });
});

describe('V3 API - HTTP Methods and Paths', () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
  });

  describe('health endpoint', () => {
    it('should call GET /health', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      await v3Api.health();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = vi.mocked(fetchMock).mock.calls[0];
      expect(call[0]).toBe('/health');
      // Health endpoint doesn't use fetch options (no body, just GET)
      expect(call[1]).toBeUndefined();
    });
  });

  describe('authentication endpoints', () => {
    it('should call POST /api/v3/auth/challenge with correct body', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce(
        mockFetchResponse(200, {
          challengeId: 'chal-123',
          message: 'Sign this',
          expiresAtMs: Date.now() + 300000,
        }),
      );

      const req: V3ChallengeRequest = {
        wallet: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        chainId: '1',
        verifyingContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
        runId: '1',
      };

      await v3Api.requestChallenge(req);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = vi.mocked(fetchMock).mock.calls[0];
      expect(call[0]).toBe('/api/v3/auth/challenge');
      expect(call[1]?.method).toBe('POST');
      expect(JSON.parse(call[1]?.body as string)).toEqual(req);
    });

    it('should call POST /api/v3/auth/complete with correct body', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce(
        mockFetchResponse(200, {
          sessionToken: 'token-123',
          expiresAtMs: Date.now() + 900000,
        }),
      );

      const req: V3ChallengeCompletion = {
        challengeId: 'chal-123',
        signature: '0xdeadbeef' as `0x${string}`,
      };

      await v3Api.completeChallenge(req);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = vi.mocked(fetchMock).mock.calls[0];
      expect(call[0]).toBe('/api/v3/auth/complete');
      expect(call[1]?.method).toBe('POST');
      expect(JSON.parse(call[1]?.body as string)).toEqual(req);
    });
  });

  describe('start attestation endpoint', () => {
    it('should call POST /api/v3/runs/start-attestation (not /runs/{runId}/start-attestation)', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce(
        mockFetchResponse(200, {
          attestation: {
            player: '0x1234567890123456789012345678901234567890' as `0x${string}`,
            runId: '1',
            seasonId: '0',
            chainId: '1',
            verifyingContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
            scoreTier: 0,
            nonce: '0',
            issuedAt: '1234567890',
            expiresAt: '1234568190',
            rulesVersion: 1,
            signerEpoch: 1,
            upgradeChoicesHash:
              '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
            actionType: 'START_RUN' as const,
          },
          signature: '0xdeadbeef' as `0x${string}`,
          digest: '0xcafebabe' as `0x${string}`,
          upgradeChoices: [],
        }),
      );

      const req: V3StartAttestationRequest = {
        upgradeChoices: [],
      };

      await v3Api.getStartAttestation('1', req, 'token-123');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = vi.mocked(fetchMock).mock.calls[0];
      // Should NOT include runId in the path
      expect(call[0]).toBe('/api/v3/runs/start-attestation');
      expect(call[1]?.method).toBe('POST');
      expect(call[1]?.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-123',
      });
    });
  });

  describe('command endpoints', () => {
    it('should call POST /api/v3/runs/{runId}/commands with authorization', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce(
        mockFetchResponse(200, {
          accepted: true,
          commandId: 'cmd-1',
          cursor: { runId: '1', sequence: 1, rulesVersion: 1 },
          serverTimeMs: Date.now(),
          canonicalState: '{}',
          creditedAtoms: '1000000000000',
          spentAtoms: '0',
          scoreTier: 0,
        }),
      );

      const cmd: V3CommandEnvelope = {
        commandId: 'cmd-1',
        expectedSequence: 0,
        command: { type: 'heart-click' },
      };

      await v3Api.submitCommand('1', cmd, 'token-123');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = vi.mocked(fetchMock).mock.calls[0];
      expect(call[0]).toBe('/api/v3/runs/1/commands');
      expect(call[1]?.method).toBe('POST');
      expect(call[1]?.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-123',
      });
      const body = JSON.parse(call[1]?.body as string);
      expect(body.commandId).toBe('cmd-1');
      expect(body.command.type).toBe('heart-click');
    });
  });

  describe('recovery endpoints', () => {
    it('should call GET /api/v3/runs/{runId}/recover with authorization', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce(
        mockFetchResponse(200, {
          cursor: { runId: '1', sequence: 5, rulesVersion: 1 },
          canonicalState: '{"habitatsLevel":{"water":2,"grass":1,"forest":0}}',
          scoreTier: 1,
          wallet: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        }),
      );

      await v3Api.recoverRun('1', 'token-123');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = vi.mocked(fetchMock).mock.calls[0];
      expect(call[0]).toBe('/api/v3/runs/1/recover');
      expect(call[1]?.method).toBe('GET');
      expect(call[1]?.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-123',
      });
    });
  });

  describe('checkpoint endpoints', () => {
    it('should call POST /api/v3/runs/{runId}/record-attestation', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce(
        mockFetchResponse(200, {
          attestation: {
            player: '0x1234567890123456789012345678901234567890' as `0x${string}`,
            runId: '1',
            seasonId: '0',
            chainId: '1',
            verifyingContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
            scoreTier: 5,
            nonce: '1',
            issuedAt: '1234567890',
            expiresAt: '1234568190',
            rulesVersion: 1,
            signerEpoch: 1,
            upgradeChoicesHash:
              '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
            actionType: 'RECORD_POINTS' as const,
          },
          signature: '0xdeadbeef' as `0x${string}`,
          digest: '0xcafebabe' as `0x${string}`,
        }),
      );

      await v3Api.getCheckpointAttestation('1', 'token-123');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = vi.mocked(fetchMock).mock.calls[0];
      expect(call[0]).toBe('/api/v3/runs/1/record-attestation');
      expect(call[1]?.method).toBe('POST');
    });
  });

  describe('rebirth endpoints', () => {
    it('should call POST /api/v3/runs/{runId}/rebirth-attestation', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce(
        mockFetchResponse(200, {
          attestation: {
            player: '0x1234567890123456789012345678901234567890' as `0x${string}`,
            runId: '1',
            seasonId: '0',
            chainId: '1',
            verifyingContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
            scoreTier: 50,
            nonce: '2',
            issuedAt: '1234567890',
            expiresAt: '1234568190',
            rulesVersion: 1,
            signerEpoch: 1,
            upgradeChoicesHash:
              '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
            actionType: 'REBIRTH' as const,
          },
          signature: '0xdeadbeef' as `0x${string}`,
          digest: '0xcafebabe' as `0x${string}`,
        }),
      );

      await v3Api.getRebirthAttestation('1', 'token-123');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = vi.mocked(fetchMock).mock.calls[0];
      expect(call[0]).toBe('/api/v3/runs/1/rebirth-attestation');
      expect(call[1]?.method).toBe('POST');
    });
  });

  describe('command translation', () => {
    it('should translate valid gameplay commands', async () => {
      const { translateGameplayCommand } = await import('./api');

      expect(translateGameplayCommand({ type: 'heart-click' })).toEqual({ type: 'heart-click' });
      expect(translateGameplayCommand({ type: 'heart-click', quantity: 100 })).toEqual({ type: 'heart-click', quantity: 100 });
      expect(() => translateGameplayCommand({ type: 'heart-click', quantity: 101 })).toThrow(/1 through 100/);
      expect(translateGameplayCommand({ type: 'sync' })).toEqual({ type: 'sync' });
      expect(
        translateGameplayCommand({ type: 'buy-habitat', habitat: 'water', quantity: 5 }),
      ).toEqual({
        type: 'buy-habitat',
        habitat: 'water',
        quantity: 5,
      });
      for (const habitat of [
        'water',
        'grass',
        'forest',
        'mountain',
        'crystal-cavern',
        'ancient-grove',
      ]) {
        expect(translateGameplayCommand({ type: 'buy-habitat', habitat, quantity: 1 })).toEqual({
          type: 'buy-habitat',
          habitat,
          quantity: 1,
        });
      }
      expect(
        translateGameplayCommand({
          type: 'buy-habitat-production-upgrade',
          habitat: 'ancient-grove',
          milestone: 100,
        }),
      ).toEqual({
        type: 'buy-habitat-production-upgrade',
        habitat: 'ancient-grove',
        milestone: 100,
      });
      expect(
        translateGameplayCommand({ type: 'buy-temporary-upgrade', upgrade: 'sunny-season' }),
      ).toEqual({
        type: 'buy-temporary-upgrade',
        upgrade: 'sunny-season',
      });
      expect(
        translateGameplayCommand({ type: 'buy-temporary-upgrade', upgrade: 'nature-surge' }),
      ).toEqual({ type: 'buy-temporary-upgrade', upgrade: 'nature-surge' });
      expect(translateGameplayCommand({ type: 'buy-fertile-soil' })).toEqual({ type: 'buy-fertile-soil' });
      expect(translateGameplayCommand({ type: 'buy-time-bloom' })).toEqual({ type: 'buy-time-bloom' });
    });

    it('should reject unsupported commands with explicit error messages', async () => {
      const { translateGameplayCommand } = await import('./api');

      expect(() => translateGameplayCommand({ type: 'invalid-command' })).toThrow(
        /Unsupported gameplay command type.*invalid-command/,
      );
      expect(() =>
        translateGameplayCommand({ type: 'buy-habitat', habitat: 'invalid', quantity: 1 }),
      ).toThrow(/Unsupported habitat.*invalid/);
      expect(() =>
        translateGameplayCommand({ type: 'buy-habitat', habitat: 'water', quantity: -5 }),
      ).toThrow(/Invalid quantity.*Must be an integer from 1 through 1000/);
      expect(() =>
        translateGameplayCommand({
          type: 'buy-habitat-production-upgrade',
          habitat: 'water',
          milestone: 11,
        }),
      ).toThrow(/Invalid production-upgrade milestone/);
      expect(() =>
        translateGameplayCommand({ type: 'buy-temporary-upgrade', upgrade: 'invalid' }),
      ).toThrow(/Unsupported temporary upgrade.*invalid/);
    });
  });
});

describe('Mock V3 API (Development)', () => {
  it('should provide mock implementation for testing', async () => {
    const mock = createMockV3Api();

    const health = await mock.health();
    expect(health.ok).toBe(true);

    const challenge = await mock.requestChallenge();
    expect(challenge.challengeId).toBeDefined();

    const session = await mock.completeChallenge();
    expect(session.sessionToken).toBeDefined();
  });

  it('should simulate command submissions', async () => {
    const mock = createMockV3Api();

    const cmd: V3CommandEnvelope = {
      commandId: 'test-1',
      expectedSequence: 0,
      command: { type: 'heart-click' },
    };

    const result1 = await mock.submitCommand('1', cmd);
    expect(result1.accepted).toBe(true);
    expect(result1.creditedAtoms).toBe('1000000000000');

    const cmd2: V3CommandEnvelope = {
      commandId: 'test-2',
      expectedSequence: 1,
      command: { type: 'buy-habitat', habitat: 'water', quantity: 1 },
    };

    const result2 = await mock.submitCommand('1', cmd2);
    expect(result2.accepted).toBe(true);
  });
});
