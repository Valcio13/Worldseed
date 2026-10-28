import type { Hex } from 'viem';
import type { V3CheckpointAttestation, V3RebirthAttestation, V3ScoreAttestation } from './api';

export type V3SettlementAction = 'recordPoints' | 'rebirth';

export type V3AttestationTuple = readonly [
  `0x${string}`,
  bigint,
  bigint,
  bigint,
  `0x${string}`,
  number,
  bigint,
  bigint,
  bigint,
  bigint,
  number,
  number,
  `0x${string}`,
  number,
];

export interface V3SettlementExpectation {
  wallet: `0x${string}`;
  runId: bigint;
  seasonId: bigint;
  chainId: bigint;
  verifyingContract: `0x${string}`;
  nonce: bigint;
}

export interface V3SettlementApi {
  getCheckpointAttestation(runId: string, sessionToken: string): Promise<V3CheckpointAttestation>;
  getRebirthAttestation(runId: string, sessionToken: string): Promise<V3RebirthAttestation>;
}

export interface V3SettlementCallbacks {
  onPhase?: (phase: 'requesting-attestation' | 'wallet-pending' | 'confirming') => void;
  onTransactionHash?: (hash: Hex) => void;
  onConfirmed?: () => Promise<void>;
  onRefreshFailed?: () => void;
}

const ZERO_HASH = `0x${'00'.repeat(32)}`;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const UINT32_MAX = 0xffff_ffff;

function isUint(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/** Validate the verifier response against current chain reads before opening the wallet prompt. */
export function toV3AttestationTuple(
  attestation: V3ScoreAttestation,
  signature: Hex,
  action: V3SettlementAction,
  expected: V3SettlementExpectation,
): V3AttestationTuple {
  const expectedAction = action === 'recordPoints' ? 'RECORD_POINTS' : 'REBIRTH';
  const numericFields = [
    attestation.runId,
    attestation.seasonId,
    attestation.chainId,
    attestation.nonce,
    attestation.issuedAt,
    attestation.expiresAt,
  ];
  if (numericFields.some((value) => !/^(0|[1-9][0-9]*)$/.test(value)))
    throw new Error('Verifier returned malformed integer fields.');
  if (!/^(0|[1-9][0-9]*)$/.test(attestation.natureCollectedAtoms))
    throw new Error('Verifier returned malformed Nature statistics.');

  if (
    attestation.player.toLowerCase() !== expected.wallet.toLowerCase() ||
    BigInt(attestation.runId) !== expected.runId ||
    BigInt(attestation.seasonId) !== expected.seasonId ||
    BigInt(attestation.chainId) !== expected.chainId ||
    attestation.verifyingContract.toLowerCase() !== expected.verifyingContract.toLowerCase() ||
    BigInt(attestation.nonce) !== expected.nonce ||
    attestation.actionType !== expectedAction ||
    attestation.upgradeChoicesHash.toLowerCase() !== ZERO_HASH ||
    !isUint(attestation.scoreTier, 65_535) ||
    BigInt(attestation.natureCollectedAtoms) > (1n << 256n) - 1n ||
    (action === 'recordPoints' && BigInt(attestation.natureCollectedAtoms) !== 0n) ||
    !isUint(attestation.rulesVersion, UINT32_MAX) ||
    !isUint(attestation.signerEpoch, UINT32_MAX) ||
    !/^0x[0-9a-fA-F]{64}$/.test(attestation.upgradeChoicesHash) ||
    BigInt(attestation.expiresAt) <= BigInt(attestation.issuedAt) ||
    !SIGNATURE.test(signature)
  )
    throw new Error('Verifier attestation does not match the active wallet, run, or action.');

  return [
    attestation.player,
    BigInt(attestation.runId),
    BigInt(attestation.seasonId),
    BigInt(attestation.chainId),
    attestation.verifyingContract,
    attestation.scoreTier,
    BigInt(attestation.natureCollectedAtoms),
    BigInt(attestation.nonce),
    BigInt(attestation.issuedAt),
    BigInt(attestation.expiresAt),
    attestation.rulesVersion,
    attestation.signerEpoch,
    attestation.upgradeChoicesHash,
    action === 'recordPoints' ? 2 : 3,
  ];
}

export interface SubmitV3SettlementOptions {
  action: V3SettlementAction;
  sessionToken: string;
  expected: V3SettlementExpectation;
  api: V3SettlementApi;
  write: (action: V3SettlementAction, tuple: V3AttestationTuple, signature: Hex) => Promise<Hex>;
  waitForReceipt: (hash: Hex) => Promise<{ status: string }>;
  callbacks?: V3SettlementCallbacks;
}

/** Shared, testable transaction path for checkpoint-only Record Points and rewarding Rebirth. */
export async function submitV3Settlement(options: SubmitV3SettlementOptions): Promise<Hex> {
  const { action, sessionToken, expected, api, write, waitForReceipt, callbacks } = options;
  if (!sessionToken) throw new Error('Wallet session is required.');

  callbacks?.onPhase?.('requesting-attestation');
  const response =
    action === 'recordPoints'
      ? await api.getCheckpointAttestation(expected.runId.toString(), sessionToken)
      : await api.getRebirthAttestation(expected.runId.toString(), sessionToken);
  const tuple = toV3AttestationTuple(response.attestation, response.signature, action, expected);

  callbacks?.onPhase?.('wallet-pending');
  const hash = await write(action, tuple, response.signature);
  callbacks?.onTransactionHash?.(hash);
  callbacks?.onPhase?.('confirming');
  const receipt = await waitForReceipt(hash);
  if (receipt.status !== 'success') throw new Error('Settlement transaction reverted onchain.');
  try {
    await callbacks?.onConfirmed?.();
  } catch {
    // The chain receipt remains authoritative even if a follow-up read is temporarily unavailable.
    callbacks?.onRefreshFailed?.();
  }
  return hash;
}

export type V3SettlementAttestation = V3CheckpointAttestation | V3RebirthAttestation;
