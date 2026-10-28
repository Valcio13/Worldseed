import type { Address, Hex } from 'viem';
import { seasonEndAtMilliseconds } from '../rulesV1';
import type { V3AttestationData } from '../verifierProtocol';
import {
  buildScoreAttestationTypedData,
  scoreAttestationDigest,
  type ScoreAttestationTypedData,
  verifyScoreAttestation,
} from './attestations';
import type { V3ChainStateReader } from './v3ChainReader';
import type { AttestationStore, PendingAttestationRecord } from './verifierStoreTypes';

const MAX_LIFETIME_SECONDS = 300n;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;
const ACTION_BY_ID = { 1: 'START_RUN', 2: 'RECORD_POINTS', 3: 'REBIRTH' } as const;

export class AttestationConflictError extends Error {
  constructor(message = 'A conflicting attestation already occupies this wallet nonce.') {
    super(message);
    this.name = 'AttestationConflictError';
  }
}

function attestationFromPayload(payloadJson: string): V3AttestationData {
  const value: unknown = JSON.parse(payloadJson);
  if (!value || typeof value !== 'object' || !('message' in value))
    throw new Error('Stored attestation payload is malformed.');
  const message = (value as { message: Record<string, unknown> }).message;
  const integer = (field: string): bigint => {
    const raw = message[field];
    if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw))
      throw new Error('Stored attestation integer is malformed.');
    return BigInt(raw);
  };
  const action = ACTION_BY_ID[message.actionType as keyof typeof ACTION_BY_ID];
  if (
    typeof message.player !== 'string' ||
    typeof message.verifyingContract !== 'string' ||
    typeof message.scoreTier !== 'number' ||
    !Number.isSafeInteger(message.scoreTier) ||
    typeof message.rulesVersion !== 'number' ||
    !Number.isSafeInteger(message.rulesVersion) ||
    typeof message.signerEpoch !== 'number' ||
    !Number.isSafeInteger(message.signerEpoch) ||
    typeof message.upgradeChoicesHash !== 'string' ||
    !action
  )
    throw new Error('Stored attestation payload is malformed.');
  return {
    player: message.player as Address,
    runId: integer('runId'),
    seasonId: integer('seasonId'),
    chainId: integer('chainId'),
    natureCollectedAtoms: integer('natureCollectedAtoms'),
    verifyingContract: message.verifyingContract as Address,
    scoreTier: message.scoreTier,
    nonce: integer('nonce'),
    issuedAt: integer('issuedAt'),
    expiresAt: integer('expiresAt'),
    rulesVersion: message.rulesVersion,
    signerEpoch: message.signerEpoch,
    upgradeChoicesHash: message.upgradeChoicesHash as Hex,
    actionType: action,
  };
}

export interface AttestationRequest {
  player: Address;
  runId: bigint;
  seasonId: bigint;
  rulesVersion: number;
  scoreTier: number;
  natureCollectedAtoms: bigint;
  actionType: V3AttestationData['actionType'];
  upgradeChoicesHash?: Hex;
  expectedNonce?: bigint;
  expectedSignerEpoch?: number;
}

export interface LocalAttestationSigner {
  address: Address;
  signTypedData(data: ScoreAttestationTypedData): Promise<Hex>;
}

export interface IssuedAttestation {
  attestation: V3AttestationData;
  signature: Hex;
  digest: Hex;
}

/** Signs only confirmed contract state and persists each signature before returning it. */
export class V3AttestationIssuer {
  constructor(
    private readonly store: AttestationStore,
    private readonly chain: V3ChainStateReader,
    private readonly signer: LocalAttestationSigner,
    private readonly chainId: bigint,
    private readonly contractAddress: Address,
  ) {}

  async issue(request: AttestationRequest): Promise<IssuedAttestation> {
    if ((await this.chain.getAttesterAddress()).toLowerCase() !== this.signer.address.toLowerCase())
      throw new Error('Configured signer does not match the contract attester.');
    const observation = await this.chain.getConfirmedNonceObservation(request.player);
    const nonce = BigInt(observation.nonce);
    if (
      (request.expectedNonce !== undefined && request.expectedNonce !== nonce) ||
      (request.expectedSignerEpoch !== undefined &&
        request.expectedSignerEpoch !== observation.signerEpoch)
    )
      throw new Error(
        'Confirmed nonce or signer epoch changed; refresh before requesting a signature.',
      );
    if (
      BigInt(observation.chainId) !== this.chainId ||
      observation.verifyingContract.toLowerCase() !== this.contractAddress.toLowerCase()
    )
      throw new Error('Confirmed verifier deployment differs from the configured EIP-712 domain.');

    if (!/^(0|[1-9][0-9]*)$/.test(observation.timestampSeconds))
      throw new Error('Confirmed timestamp observation is malformed.');
    const issuedAt = BigInt(observation.timestampSeconds);
    const activeReservation = await this.store.getPendingAttestation(
      observation.chainId,
      observation.verifyingContract,
      request.player,
      nonce.toString(),
      Number(issuedAt),
      observation.signerEpoch,
    );
    if (activeReservation)
      return this.reusePending(request, nonce, observation, activeReservation, issuedAt);
    const end = BigInt(Math.floor(seasonEndAtMilliseconds(Number(request.seasonId)) / 1_000));
    const expiresAt = issuedAt + MAX_LIFETIME_SECONDS < end ? issuedAt + MAX_LIFETIME_SECONDS : end;
    if (expiresAt <= issuedAt)
      throw new Error('The season is too close to expiry for an attestation.');
    const attestation: V3AttestationData = {
      player: request.player,
      runId: request.runId,
      seasonId: request.seasonId,
      chainId: this.chainId,
      verifyingContract: this.contractAddress,
      scoreTier: request.scoreTier,
      natureCollectedAtoms: request.natureCollectedAtoms,
      nonce,
      issuedAt,
      expiresAt,
      rulesVersion: request.rulesVersion,
      signerEpoch: observation.signerEpoch,
      upgradeChoicesHash: request.upgradeChoicesHash ?? ZERO_HASH,
      actionType: request.actionType,
    };
    const typedData = buildScoreAttestationTypedData(attestation, {
      maxLifetimeSeconds: MAX_LIFETIME_SECONDS,
      expectedChainId: this.chainId,
      expectedContract: this.contractAddress,
    });
    const digest = scoreAttestationDigest(typedData);
    const payloadJson = JSON.stringify(typedData, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    const reservation = {
      chainId: observation.chainId,
      verifyingContract: observation.verifyingContract,
      player: request.player,
      nonce: nonce.toString(),
      payloadDigest: digest,
      payloadJson,
      runId: request.runId.toString(),
      actionType: request.actionType,
      signerEpoch: observation.signerEpoch,
      issuedAt: Number(issuedAt),
      expiresAt: Number(expiresAt),
    };
    const reserved = await this.store.reserveAttestation(
      reservation,
      Number(issuedAt),
      observation,
    );
    if (reserved === 'conflict') {
      const winner = await this.store.getPendingAttestation(
        observation.chainId,
        observation.verifyingContract,
        request.player,
        nonce.toString(),
        Number(issuedAt),
        observation.signerEpoch,
      );
      if (winner) return this.reusePending(request, nonce, observation, winner, issuedAt);
      throw new AttestationConflictError();
    }
    const cached = await this.store.getAttestationSignature(
      observation.chainId,
      observation.verifyingContract,
      request.player,
      nonce.toString(),
      digest,
      observation.signerEpoch,
    );
    if (cached) return { attestation, signature: cached as Hex, digest };

    return this.signAndStore(attestation, typedData, digest, observation);
  }

  private async reusePending(
    request: AttestationRequest,
    nonce: bigint,
    observation: Awaited<ReturnType<V3ChainStateReader['getConfirmedNonceObservation']>>,
    pending: PendingAttestationRecord,
    nowSeconds: bigint,
  ): Promise<IssuedAttestation> {
    const attestation = attestationFromPayload(pending.payloadJson);
    const typedData = buildScoreAttestationTypedData(attestation, {
      maxLifetimeSeconds: MAX_LIFETIME_SECONDS,
      expectedChainId: this.chainId,
      expectedContract: this.contractAddress,
    });
    const digest = scoreAttestationDigest(typedData);
    const upgradeChoicesHash = request.upgradeChoicesHash ?? ZERO_HASH;
    if (
      digest.toLowerCase() !== pending.payloadDigest.toLowerCase() ||
      pending.signerEpoch !== observation.signerEpoch ||
      BigInt(pending.expiresAt) !== attestation.expiresAt ||
      nowSeconds >= attestation.expiresAt ||
      attestation.player.toLowerCase() !== request.player.toLowerCase() ||
      attestation.runId !== request.runId ||
      attestation.seasonId !== request.seasonId ||
      attestation.chainId !== this.chainId ||
      attestation.verifyingContract.toLowerCase() !== this.contractAddress.toLowerCase() ||
      attestation.scoreTier !== request.scoreTier ||
      attestation.natureCollectedAtoms !== request.natureCollectedAtoms ||
      attestation.nonce !== nonce ||
      attestation.rulesVersion !== request.rulesVersion ||
      attestation.signerEpoch !== observation.signerEpoch ||
      attestation.upgradeChoicesHash.toLowerCase() !== upgradeChoicesHash.toLowerCase() ||
      attestation.actionType !== request.actionType
    )
      throw new AttestationConflictError();

    if (pending.signature) {
      if (!(await verifyScoreAttestation(typedData, pending.signature as Hex, this.signer.address)))
        throw new Error('Stored attestation signature failed verification.');
      return { attestation, signature: pending.signature as Hex, digest };
    }
    return this.signAndStore(attestation, typedData, digest, observation);
  }

  private async signAndStore(
    attestation: V3AttestationData,
    typedData: ScoreAttestationTypedData,
    digest: Hex,
    observation: Awaited<ReturnType<V3ChainStateReader['getConfirmedNonceObservation']>>,
  ): Promise<IssuedAttestation> {
    const signature = await this.signer.signTypedData(typedData);
    const latest = await this.chain.getConfirmedNonceObservation(attestation.player);
    if (!/^(0|[1-9][0-9]*)$/.test(latest.timestampSeconds))
      throw new Error('Confirmed timestamp observation is malformed.');
    const latestTime = BigInt(latest.timestampSeconds);
    if (
      latest.chainId !== observation.chainId ||
      latest.verifyingContract.toLowerCase() !== observation.verifyingContract.toLowerCase() ||
      latest.nonce !== attestation.nonce.toString() ||
      latest.signerEpoch !== observation.signerEpoch ||
      latestTime >= attestation.expiresAt
    )
      throw new Error('Nonce, signer epoch, or attestation expiry changed while signing.');
    const saved = await this.store.commitAttestationSignature(
      observation.chainId,
      observation.verifyingContract,
      attestation.player,
      attestation.nonce.toString(),
      digest,
      signature,
      latest,
    );
    if (
      (saved.status === 'stored' || saved.status === 'existing') &&
      saved.signature &&
      (await verifyScoreAttestation(typedData, saved.signature as Hex, this.signer.address))
    )
      return { attestation, signature: saved.signature as Hex, digest };
    const winner = await this.store.getAttestationSignature(
      observation.chainId,
      observation.verifyingContract,
      attestation.player,
      attestation.nonce.toString(),
      digest,
      observation.signerEpoch,
    );
    if (winner) return { attestation, signature: winner as Hex, digest };
    throw new Error('Attestation could not be committed against the confirmed chain state.');
  }
}
