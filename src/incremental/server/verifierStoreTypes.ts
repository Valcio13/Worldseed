import type { AcceptedCommandEvent, RunJournal, VerifierPersistence } from '../localVerifier';
export interface ConfirmedNonceObservation {
  chainId: string;
  verifyingContract: string;
  blockNumber: number;
  blockHash: string;
  confirmations: number;
  timestampSeconds: string;
  nonce: string;
  signerEpoch: number;
}

export type Awaitable<T> = T | Promise<T>;

export interface AttestationReservation {
  chainId: string;
  verifyingContract: string;
  player: string;
  nonce: string;
  payloadDigest: string;
  payloadJson: string;
  runId: string;
  actionType: string;
  signerEpoch: number;
  issuedAt: number;
  expiresAt: number;
}

export type ReservationResult = 'reserved' | 'same-payload' | 'conflict';

export interface AttestationSignatureCommit {
  status: 'stored' | 'existing' | 'conflict';
  signature?: string;
}

export interface PendingAttestationRecord {
  payloadDigest: string;
  payloadJson: string;
  signature: string | null;
  signerEpoch: number;
  expiresAt: number;
}

export interface AttestationStore {
  getPendingAttestation(
    chainId: string,
    verifyingContract: string,
    player: string,
    nonce: string,
    nowSeconds: number,
    signerEpoch: number,
  ): Awaitable<PendingAttestationRecord | null>;
  reserveAttestation(
    reservation: AttestationReservation,
    nowSeconds: number,
    observation: ConfirmedNonceObservation,
  ): Awaitable<ReservationResult>;
  commitAttestationSignature(
    chainId: string,
    verifyingContract: string,
    player: string,
    nonce: string,
    payloadDigest: string,
    signature: string,
    observation: ConfirmedNonceObservation,
  ): Awaitable<AttestationSignatureCommit>;
  getAttestationSignature(
    chainId: string,
    verifyingContract: string,
    player: string,
    nonce: string,
    payloadDigest: string,
    signerEpoch: number,
  ): Awaitable<string | null>;
}

export type CheckpointResult = 'initialized' | 'advanced' | 'unchanged' | 'reorg';

export interface ChainCheckpoint {
  chainId: string;
  verifyingContract: string;
  blockNumber: number;
  blockHash: string;
  parentHash: string;
}

export interface ChainCheckpointStore {
  /**
   * Advance to a confirmed canonical head. When expectedHead is supplied, the store performs a
   * compare-and-swap against it; callers must first verify expectedHead's hash with the RPC.
   */
  advanceChainCheckpoint(
    checkpoint: ChainCheckpoint,
    nowMs: number,
    expectedHead?: ChainCheckpoint,
  ): Awaitable<CheckpointResult>;
  reconcileChainCheckpoint(checkpoint: ChainCheckpoint, nowMs: number): Awaitable<void>;
  getChainCheckpoint(chainId: string, verifyingContract: string): Awaitable<ChainCheckpoint | null>;
}

export interface RunStartedEventScanKey {
  chainId: string;
  verifyingContract: string;
  player: string;
  runId: string;
  seasonId: string;
}

export interface RunStartedEventScan extends RunStartedEventScanKey {
  nextBlock: number;
  scannedThrough: number;
  scannedBlockHash: string | null;
  eventJson: string | null;
  eventBlockNumber: number | null;
  eventBlockHash: string | null;
  updatedAtMs: number;
}

export type RunStartedEventScanResult = 'advanced' | 'conflict';

/** Persistent per-run cursor for bounded, confirmed RunStarted log recovery. */
export interface RunStartedEventStore {
  initializeRunStartedEventScan(
    key: RunStartedEventScanKey,
    deploymentBlock: number,
    nowMs: number,
  ): Awaitable<RunStartedEventScan>;
  getRunStartedEventScan(key: RunStartedEventScanKey): Awaitable<RunStartedEventScan | null>;
  advanceRunStartedEventScan(
    key: RunStartedEventScanKey,
    expectedNextBlock: number,
    next: Omit<RunStartedEventScan, keyof RunStartedEventScanKey>,
  ): Awaitable<RunStartedEventScanResult>;
  resetRunStartedEventScan(
    key: RunStartedEventScanKey,
    expectedNextBlock: number,
    deploymentBlock: number,
    nowMs: number,
  ): Awaitable<RunStartedEventScanResult>;
}

export interface WalletChallengeRow {
  challengeId: string;
  nonce: string;
  wallet: string;
  chainId: string;
  verifyingContract: string;
  origin: string;
  runId: string;
  message: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface WalletSessionRow {
  tokenHash: string;
  sessionId: string;
  wallet: string;
  chainId: string;
  verifyingContract: string;
  origin: string;
  runId: string;
  createdAtMs: number;
  expiresAtMs: number;
  challengeId?: string;
}

export interface WalletSessionStore {
  cleanupExpired(nowMs: number, limit: number): Promise<void>;
  createChallenge(row: WalletChallengeRow): Promise<void>;
  getChallenge(challengeId: string): Promise<WalletChallengeRow | null>;
  consumeChallengeAndCreateSession(
    challengeId: string,
    nonce: string,
    nowMs: number,
    session: WalletSessionRow,
  ): Promise<boolean>;
  getSession(tokenHash: string, nowMs: number): Promise<WalletSessionRow | null>;
  revokeSession(tokenHash: string, nowMs: number): Promise<void>;
}

/** Implementations must commit command rows and sequence-head updates atomically. */
export type VerifierStore = VerifierPersistence &
  AttestationStore &
  ChainCheckpointStore &
  RunStartedEventStore;

export type { AcceptedCommandEvent, RunJournal };
