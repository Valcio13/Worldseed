import type { CanonicalRunState, GameplayCommand } from './versionedRules';

/** Client supplied fields are inputs, never evidence of time, identity, or resulting state. */
export interface CommandRequest {
  sessionToken: string;
  runId: string;
  commandId: string;
  expectedSequence: number;
  command: GameplayCommand;
  clientTimestampMs?: number;
}

export interface AuthenticatedWalletSession {
  wallet: string;
  chainId: bigint;
  verifyingContract: string;
  sessionId: string;
  runId: string;
  origin: string;
}

export interface RunCursor {
  runId: string;
  sequence: number;
  rulesVersion: number;
}

export interface CommandReceipt {
  accepted: true;
  commandId: string;
  cursor: RunCursor;
  serverTimeMs: number;
  state: CanonicalRunState;
  creditedAtoms: bigint;
  spentAtoms: bigint;
  scoreTier: number;
}

/** JSON-safe form for an eventual frontend API; BigInts are decimal strings, never JS numbers. */
export interface CommandReceiptWire {
  accepted: true;
  commandId: string;
  cursor: RunCursor;
  serverTimeMs: number;
  canonicalState: string;
  creditedAtoms: string;
  spentAtoms: string;
  scoreTier: number;
}

export interface VerifierErrorWire {
  code: VerifierErrorCode;
  message: string;
  expectedSequence?: number;
  recovery?: { cursor: RunCursor; canonicalState: string };
}

/** Exact application data which a future V3 EIP-712 attestation will bind. */
export interface V3AttestationData {
  player: string;
  runId: bigint;
  seasonId: bigint;
  chainId: bigint;
  verifyingContract: string;
  scoreTier: number;
  /** Canonical Nature atom total for the run; zero except on REBIRTH. */
  natureCollectedAtoms: bigint;
  nonce: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
  rulesVersion: number;
  signerEpoch: number;
  upgradeChoicesHash: `0x${string}`;
  actionType: 'START_RUN' | 'RECORD_POINTS' | 'REBIRTH';
}

export type VerifierErrorCode =
  | 'UNAUTHENTICATED'
  | 'WRONG_WALLET'
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_ACTIVE'
  | 'SEASON_EXPIRED'
  | 'RULES_MISMATCH'
  | 'INVALID_REQUEST'
  | 'COMMAND_ID_CONFLICT'
  | 'STALE_CURSOR'
  | 'SEQUENCE_GAP'
  | 'PERSISTENCE_CONFLICT'
  | 'RECOVERY_FAILED'
  | 'RULES_REJECTED';

export class VerifierError extends Error {
  constructor(
    readonly code: VerifierErrorCode,
    message: string,
    readonly expectedSequence?: number,
    readonly recovery?: { cursor: RunCursor; canonicalState: string },
  ) {
    super(message);
    this.name = 'VerifierError';
  }
}
