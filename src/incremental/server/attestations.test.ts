import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { V3AttestationData } from '../verifierProtocol';
import {
  buildScoreAttestationTypedData,
  scoreAttestationDigest,
  verifyScoreAttestation,
} from './attestations';

// Disposable deterministic fixture key; never used outside local test vectors.
const testAttester = privateKeyToAccount(`0x${'0'.repeat(63)}1`);
const contract = '0x0000000000000000000000000000000000000002';
const player = '0x0000000000000000000000000000000000000003';
const seasonId = 3_000;
const seasonEnd = BigInt(4 * 86_400 + (seasonId + 1) * 7 * 86_400);
const policy = { expectedChainId: 31_337n, expectedContract: contract, maxLifetimeSeconds: 300n };
const attestation: V3AttestationData = {
  player,
  runId: 4n,
  seasonId: BigInt(seasonId),
  chainId: 31_337n,
  verifyingContract: contract,
  scoreTier: 0,
  natureCollectedAtoms: 0n,
  nonce: 8n,
  issuedAt: seasonEnd - 600n,
  expiresAt: seasonEnd - 300n,
  rulesVersion: 1,
  signerEpoch: 2,
  upgradeChoicesHash: `0x${'ab'.repeat(32)}`,
  actionType: 'START_RUN',
};

describe('V3 EIP-712 attestation', () => {
  it('signs and recovers a payload bound to domain and all application fields', async () => {
    const typed = buildScoreAttestationTypedData(attestation, policy);
    const signature = await testAttester.signTypedData(typed as never);
    expect(await verifyScoreAttestation(typed, signature, testAttester.address)).toBe(true);
    expect(scoreAttestationDigest(typed)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await verifyScoreAttestation(typed, signature, player)).toBe(false);

    const mutated = { ...typed, message: { ...typed.message, runId: typed.message.runId + 1n } };
    expect(await verifyScoreAttestation(mutated, signature, testAttester.address)).toBe(false);
    const otherChain = { ...typed, domain: { ...typed.domain, chainId: typed.domain.chainId + 1 } };
    expect(await verifyScoreAttestation(otherChain, signature, testAttester.address)).toBe(false);
    const changedMessages = [
      { player: '0x0000000000000000000000000000000000000005' as `0x${string}` },
      { seasonId: typed.message.seasonId + 1n },
      { chainId: typed.message.chainId + 1n },
      { verifyingContract: player as `0x${string}` },
      { scoreTier: 1 },
      { natureCollectedAtoms: 1n },
      { nonce: typed.message.nonce + 1n },
      { issuedAt: typed.message.issuedAt + 1n },
      { expiresAt: typed.message.expiresAt - 1n },
      { rulesVersion: typed.message.rulesVersion + 1 },
      { signerEpoch: typed.message.signerEpoch + 1 },
      { upgradeChoicesHash: `0x${'cd'.repeat(32)}` as `0x${string}` },
      { actionType: 2 },
    ];
    for (const changed of changedMessages) {
      const tampered = { ...typed, message: { ...typed.message, ...changed } };
      expect(await verifyScoreAttestation(tampered, signature, testAttester.address)).toBe(false);
    }
  });

  it('rejects wrong deployment, expired/oversized expiry, invalid widths, and wrong action commitments', () => {
    expect(() => buildScoreAttestationTypedData({ ...attestation, chainId: 1n }, policy)).toThrow(
      /chain/,
    );
    expect(() =>
      buildScoreAttestationTypedData({ ...attestation, verifyingContract: player }, policy),
    ).toThrow(/contract/);
    expect(() =>
      buildScoreAttestationTypedData({ ...attestation, expiresAt: attestation.issuedAt }, policy),
    ).toThrow(/expiry/);
    expect(() =>
      buildScoreAttestationTypedData(
        { ...attestation, issuedAt: seasonEnd - 200n, expiresAt: seasonEnd + 1n },
        policy,
      ),
    ).toThrow(/season/);
    expect(() =>
      buildScoreAttestationTypedData({ ...attestation, scoreTier: 65_536 }, policy),
    ).toThrow(/bound/);
    expect(() =>
      buildScoreAttestationTypedData(
        {
          ...attestation,
          actionType: 'REBIRTH',
          upgradeChoicesHash: attestation.upgradeChoicesHash,
        },
        policy,
      ),
    ).toThrow(/Only START_RUN/);
  });
});
