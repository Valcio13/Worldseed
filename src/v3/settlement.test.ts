import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import {
  submitV3Settlement,
  toV3AttestationTuple,
  type V3AttestationTuple,
  type V3SettlementAction,
  type V3SettlementApi,
  type V3SettlementExpectation,
} from './settlement';
import type { V3ScoreAttestation } from './api';

const wallet = '0x1234567890123456789012345678901234567890' as const;
const contract = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;
const signature = `0x${'ab'.repeat(65)}` as Hex;
const zeroHash = `0x${'00'.repeat(32)}` as const;
const expected: V3SettlementExpectation = {
  wallet,
  runId: 7n,
  seasonId: 42n,
  chainId: 743111n,
  verifyingContract: contract,
  nonce: 9n,
};

function attestation(actionType: 'RECORD_POINTS' | 'REBIRTH'): V3ScoreAttestation {
  return {
    player: wallet,
    runId: '7',
    seasonId: '42',
    chainId: '743111',
    verifyingContract: contract,
    scoreTier: 120,
    natureCollectedAtoms: actionType === 'REBIRTH' ? '1234567890123' : '0',
    nonce: '9',
    issuedAt: '1790000000',
    expiresAt: '1790000300',
    rulesVersion: 1,
    signerEpoch: 3,
    upgradeChoicesHash: zeroHash,
    actionType,
  };
}

function apiFor(actionType: 'RECORD_POINTS' | 'REBIRTH'): V3SettlementApi {
  return {
    getCheckpointAttestation: vi.fn(async () => ({
      attestation: attestation(actionType),
      signature,
      digest: zeroHash,
    })),
    getRebirthAttestation: vi.fn(async () => ({
      attestation: attestation(actionType),
      signature,
      digest: zeroHash,
    })),
  };
}

describe('V3 Record Points and Rebirth settlement', () => {
  it.each([
    ['recordPoints', 'RECORD_POINTS', 2],
    ['rebirth', 'REBIRTH', 3],
  ] as const)(
    'submits the verifier attestation for %s with action type %i',
    async (action, actionType, enumValue) => {
      const api = apiFor(actionType);
      const write = vi.fn(async (...args: [V3SettlementAction, V3AttestationTuple, Hex]) => {
        expect(args[0]).toBe(action);
        expect(args[1]).toHaveLength(14);
        expect(args[1][6]).toBe(action === 'rebirth' ? 1_234_567_890_123n : 0n);
        expect(args[1][13]).toBe(enumValue);
        return `0x${'12'.repeat(32)}` as Hex;
      });
      const waitForReceipt = vi.fn(async () => ({ status: 'success' }));
      const onConfirmed = vi.fn(async () => undefined);
      const result = await submitV3Settlement({
        action,
        sessionToken: 'valid-session',
        expected,
        api,
        write,
        waitForReceipt,
        callbacks: { onConfirmed },
      });

      expect(result).toBe(`0x${'12'.repeat(32)}`);
      expect(
        action === 'recordPoints' ? api.getCheckpointAttestation : api.getRebirthAttestation,
      ).toHaveBeenCalledWith('7', 'valid-session');
      expect(write).toHaveBeenCalledOnce();
      expect(waitForReceipt).toHaveBeenCalledWith(result);
      expect(onConfirmed).toHaveBeenCalledOnce();
    },
  );

  it('rejects mismatched wallet, chain, run, nonce, action, or malformed signature before wallet submission', () => {
    const valid = attestation('REBIRTH');
    const mutations: V3ScoreAttestation[] = [
      { ...valid, player: contract },
      { ...valid, chainId: '1' },
      { ...valid, runId: '8' },
      { ...valid, nonce: '10' },
      { ...valid, actionType: 'RECORD_POINTS' },
    ];
    for (const value of mutations)
      expect(() => toV3AttestationTuple(value, signature, 'rebirth', expected)).toThrow();
    expect(() => toV3AttestationTuple(valid, '0x12' as Hex, 'rebirth', expected)).toThrow();
  });

  it('does not refresh confirmed state when the transaction reverts', async () => {
    const onConfirmed = vi.fn(async () => undefined);
    await expect(
      submitV3Settlement({
        action: 'rebirth',
        sessionToken: 'valid-session',
        expected,
        api: apiFor('REBIRTH'),
        write: async () => `0x${'34'.repeat(32)}` as Hex,
        waitForReceipt: async () => ({ status: 'reverted' }),
        callbacks: { onConfirmed },
      }),
    ).rejects.toThrow(/reverted/);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('preserves wallet rejection without waiting for or refreshing a transaction', async () => {
    const waitForReceipt = vi.fn();
    const onConfirmed = vi.fn();
    await expect(
      submitV3Settlement({
        action: 'recordPoints',
        sessionToken: 'valid-session',
        expected,
        api: apiFor('RECORD_POINTS'),
        write: async () => {
          throw Object.assign(new Error('User rejected request'), { code: 4001 });
        },
        waitForReceipt,
        callbacks: { onConfirmed },
      }),
    ).rejects.toMatchObject({ code: 4001 });
    expect(waitForReceipt).not.toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('keeps a successful settlement confirmed if post-receipt reads fail', async () => {
    const onRefreshFailed = vi.fn();
    await expect(
      submitV3Settlement({
        action: 'rebirth',
        sessionToken: 'valid-session',
        expected,
        api: apiFor('REBIRTH'),
        write: async () => `0x${'56'.repeat(32)}` as Hex,
        waitForReceipt: async () => ({ status: 'success' }),
        callbacks: {
          onConfirmed: async () => {
            throw new Error('RPC temporarily unavailable');
          },
          onRefreshFailed,
        },
      }),
    ).resolves.toBe(`0x${'56'.repeat(32)}`);
    expect(onRefreshFailed).toHaveBeenCalledOnce();
  });

  it('does not request an attestation or submit when the wallet session is missing', async () => {
    const api = apiFor('RECORD_POINTS');
    const write = vi.fn();
    await expect(
      submitV3Settlement({
        action: 'recordPoints',
        sessionToken: '',
        expected,
        api,
        write,
        waitForReceipt: async () => ({ status: 'success' }),
      }),
    ).rejects.toThrow(/session/);
    expect(api.getCheckpointAttestation).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
