import { hashTypedData, isAddress, verifyTypedData, type Address, type Hex } from 'viem';
import type { V3AttestationData } from '../verifierProtocol';
import { SEASON_LENGTH_SECONDS, seasonEndAtMilliseconds } from '../rulesV1';

const UINT64_MAX = (1n << 64n) - 1n;
const UINT32_MAX = (1n << 32n) - 1n;
const UINT16_MAX = (1n << 16n) - 1n;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;

const scoreAttestationFields = [
  { name: 'player', type: 'address' },
  { name: 'runId', type: 'uint64' },
  { name: 'seasonId', type: 'uint64' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'scoreTier', type: 'uint16' },
  { name: 'natureCollectedAtoms', type: 'uint256' },
  { name: 'nonce', type: 'uint64' },
  { name: 'issuedAt', type: 'uint64' },
  { name: 'expiresAt', type: 'uint64' },
  { name: 'rulesVersion', type: 'uint32' },
  { name: 'signerEpoch', type: 'uint32' },
  { name: 'upgradeChoicesHash', type: 'bytes32' },
  { name: 'actionType', type: 'uint8' },
] as const;

const actionTypeId = { START_RUN: 1, RECORD_POINTS: 2, REBIRTH: 3 } as const;

export interface ScoreAttestationTypedData {
  domain: {
    name: 'Worldseed V3';
    version: '1';
    chainId: number;
    verifyingContract: Address;
  };
  types: { ScoreAttestation: typeof scoreAttestationFields };
  primaryType: 'ScoreAttestation';
  message: {
    player: Address;
    runId: bigint;
    seasonId: bigint;
    chainId: bigint;
    verifyingContract: Address;
    scoreTier: number;
    natureCollectedAtoms: bigint;
    nonce: bigint;
    issuedAt: bigint;
    expiresAt: bigint;
    rulesVersion: number;
    signerEpoch: number;
    upgradeChoicesHash: Hex;
    actionType: number;
  };
}

export interface AttestationPolicy {
  maxLifetimeSeconds: bigint;
  expectedChainId: bigint;
  expectedContract: string;
}

function bounded(value: bigint, maximum: bigint, field: string): void {
  if (value < 0n || value > maximum)
    throw new Error(`${field} is outside its Solidity integer bound.`);
}

function validate(data: V3AttestationData, policy: AttestationPolicy): ScoreAttestationTypedData {
  if (
    !isAddress(data.player) ||
    !isAddress(data.verifyingContract) ||
    !isAddress(policy.expectedContract)
  )
    throw new Error('Attestation addresses are invalid.');
  if (
    data.chainId !== policy.expectedChainId ||
    data.verifyingContract.toLowerCase() !== policy.expectedContract.toLowerCase()
  )
    throw new Error(
      'Attestation chain or verifying contract does not match deployment configuration.',
    );
  bounded(data.runId, UINT64_MAX, 'runId');
  bounded(data.seasonId, UINT64_MAX, 'seasonId');
  bounded(data.nonce, UINT64_MAX, 'nonce');
  bounded(data.issuedAt, UINT64_MAX, 'issuedAt');
  bounded(data.expiresAt, UINT64_MAX, 'expiresAt');
  bounded(data.chainId, (1n << 256n) - 1n, 'chainId');
  bounded(BigInt(data.scoreTier), UINT16_MAX, 'scoreTier');
  bounded(data.natureCollectedAtoms, (1n << 256n) - 1n, 'natureCollectedAtoms');
  bounded(BigInt(data.rulesVersion), UINT32_MAX, 'rulesVersion');
  bounded(BigInt(data.signerEpoch), UINT32_MAX, 'signerEpoch');
  if (!/^0x[0-9a-fA-F]{64}$/.test(data.upgradeChoicesHash))
    throw new Error('Upgrade commitment must be bytes32.');
  if (!Object.hasOwn(actionTypeId, data.actionType)) throw new Error('Unknown attestation action.');
  if (data.actionType === 'START_RUN' && data.scoreTier !== 0)
    throw new Error('START_RUN attestations must have score tier zero.');
  if (data.actionType !== 'REBIRTH' && data.natureCollectedAtoms !== 0n)
    throw new Error('Only REBIRTH attestations may bind Nature collected.');
  if (data.actionType !== 'START_RUN' && data.upgradeChoicesHash.toLowerCase() !== ZERO_HASH)
    throw new Error('Only START_RUN may bind an upgrade choices hash.');
  if (data.expiresAt <= data.issuedAt || data.expiresAt - data.issuedAt > policy.maxLifetimeSeconds)
    throw new Error('Attestation expiry is invalid or exceeds the configured lifetime.');
  const seasonNumber = Number(data.seasonId);
  if (!Number.isSafeInteger(seasonNumber) || BigInt(seasonNumber) !== data.seasonId)
    throw new Error('Season ID exceeds the supported timestamp calculation range.');
  const seasonEndSeconds = BigInt(seasonEndAtMilliseconds(seasonNumber) / 1_000);
  const seasonStartSeconds = seasonEndSeconds - BigInt(SEASON_LENGTH_SECONDS);
  if (data.issuedAt < seasonStartSeconds || data.issuedAt >= seasonEndSeconds)
    throw new Error('Attestation issue time is outside its season.');
  if (data.expiresAt > seasonEndSeconds)
    throw new Error('Attestation expiry exceeds the season boundary.');
  const chainId = Number(data.chainId);
  if (!Number.isSafeInteger(chainId) || BigInt(chainId) !== data.chainId)
    throw new Error('EIP-712 domain chain ID must be safely representable by the signing library.');
  return {
    domain: {
      name: 'Worldseed V3',
      version: '1',
      chainId,
      verifyingContract: data.verifyingContract as Address,
    },
    types: { ScoreAttestation: scoreAttestationFields },
    primaryType: 'ScoreAttestation',
    message: {
      player: data.player as Address,
      runId: data.runId,
      seasonId: data.seasonId,
      chainId: data.chainId,
      verifyingContract: data.verifyingContract as Address,
      scoreTier: data.scoreTier,
      natureCollectedAtoms: data.natureCollectedAtoms,
      nonce: data.nonce,
      issuedAt: data.issuedAt,
      expiresAt: data.expiresAt,
      rulesVersion: data.rulesVersion,
      signerEpoch: data.signerEpoch,
      upgradeChoicesHash: data.upgradeChoicesHash as Hex,
      actionType: actionTypeId[data.actionType],
    },
  };
}

export function buildScoreAttestationTypedData(
  data: V3AttestationData,
  policy: AttestationPolicy,
): ScoreAttestationTypedData {
  return validate(data, policy);
}

/** Returns the canonical EIP-712 digest; no signer or key is kept by this module. */
export function scoreAttestationDigest(typedData: ScoreAttestationTypedData): Hex {
  return hashTypedData(typedData as Parameters<typeof hashTypedData>[0]);
}

export async function verifyScoreAttestation(
  typedData: ScoreAttestationTypedData,
  signature: Hex,
  expectedAttester: Address,
): Promise<boolean> {
  try {
    if (!isAddress(expectedAttester)) return false;
    return await verifyTypedData({
      address: expectedAttester,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature,
    });
  } catch {
    return false;
  }
}
