import {
  JOURNAL_SNAPSHOT_INTERVAL,
  type AcceptedCommandEvent,
  type RunJournal,
  type VerifierPersistence,
} from '../localVerifier';
import type {
  AttestationReservation,
  ChainCheckpoint,
  ChainCheckpointStore,
  CheckpointResult,
  ConfirmedNonceObservation,
  PendingAttestationRecord,
  ReservationResult,
  RunStartedEventScan,
  RunStartedEventScanKey,
  RunStartedEventScanResult,
  RunStartedEventStore,
  WalletChallengeRow,
  WalletSessionRow,
  WalletSessionStore,
} from './verifierStoreTypes';
import type { AttestationStore, AttestationSignatureCommit } from './verifierStoreTypes';

export interface D1Meta {
  changes: number;
  last_row_id?: number;
}

export interface D1Result<T = unknown> {
  success: boolean;
  results?: T[];
  meta: D1Meta;
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

/** Minimal structural subset of the Workers D1 API, also easy to exercise in Miniflare. */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface RunRow {
  run_key: string;
  initial_state: string;
  head_sequence: number;
  snapshot_sequence?: number;
  snapshot_state?: string;
  sequence: number | null;
  command_id: string | null;
  expected_sequence: number | null;
  command_json: string | null;
  server_time_ms: number | null;
  state_after: string | null;
  credited_atoms: string | null;
  spent_atoms: string | null;
}

interface ChallengeDbRow {
  challenge_id: string;
  nonce: string;
  wallet: string;
  chain_id: string;
  verifying_contract: string;
  origin: string;
  run_id: string;
  message: string;
  created_at_ms: number;
  expires_at_ms: number;
}

interface SessionDbRow {
  token_hash: string;
  session_id: string;
  wallet: string;
  chain_id: string;
  verifying_contract: string;
  origin: string;
  run_id: string;
  created_at_ms: number;
  expires_at_ms: number;
  challenge_id: string | null;
}

interface CheckpointDbRow {
  chain_id: string;
  verifying_contract: string;
  block_number: number;
  block_hash: string;
  parent_hash: string;
}

interface AttestationDbRow {
  payload_digest: string;
  signature: string | null;
  signer_epoch: number;
  status: 'pending' | 'consumed' | 'cancelled';
  expires_at: number;
}

function checked<T>(result: D1Result<T>): T[] {
  if (!result.success) throw new Error('D1 query failed.');
  return result.results ?? [];
}

function changed(result: D1Result): number {
  if (!result.success) throw new Error('D1 write failed.');
  return result.meta.changes;
}

function checkpointKey(chainId: string, address: string): [string, string] {
  return [chainId, address.toLowerCase()];
}

function fromChallenge(row: ChallengeDbRow): WalletChallengeRow {
  return {
    challengeId: row.challenge_id,
    nonce: row.nonce,
    wallet: row.wallet,
    chainId: row.chain_id,
    verifyingContract: row.verifying_contract,
    origin: row.origin,
    runId: row.run_id,
    message: row.message,
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

function fromSession(row: SessionDbRow): WalletSessionRow {
  return {
    tokenHash: row.token_hash,
    sessionId: row.session_id,
    wallet: row.wallet,
    chainId: row.chain_id,
    verifyingContract: row.verifying_contract,
    origin: row.origin,
    runId: row.run_id,
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    ...(row.challenge_id ? { challengeId: row.challenge_id } : {}),
  };
}

function fromCheckpoint(row: CheckpointDbRow): ChainCheckpoint {
  return {
    chainId: row.chain_id,
    verifyingContract: row.verifying_contract,
    blockNumber: Number(row.block_number),
    blockHash: row.block_hash,
    parentHash: row.parent_hash,
  };
}

/** D1 implementation. Batch writes are atomic; SQL triggers enforce command cursor CAS. */
export class D1VerifierStore
  implements
    VerifierPersistence,
    AttestationStore,
    ChainCheckpointStore,
    WalletSessionStore,
    RunStartedEventStore
{
  constructor(private readonly db: D1DatabaseLike) {}

  async initializeRunStartedEventScan(
    key: RunStartedEventScanKey,
    deploymentBlock: number,
    nowMs: number,
  ): Promise<RunStartedEventScan> {
    changed(
      await this.db
        .prepare(
          `INSERT INTO run_started_event_scans(
      chain_id, verifying_contract, player, run_id, season_id, next_block, scanned_through,
      scanned_block_hash, event_json, event_block_number, event_block_hash, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
    ON CONFLICT(chain_id, verifying_contract, player, run_id, season_id) DO NOTHING`,
        )
        .bind(
          key.chainId,
          key.verifyingContract.toLowerCase(),
          key.player.toLowerCase(),
          key.runId,
          key.seasonId,
          deploymentBlock,
          deploymentBlock - 1,
          nowMs,
        )
        .run(),
    );
    const scan = await this.getRunStartedEventScan(key);
    if (!scan) throw new Error('D1 RunStarted event scan could not be initialized.');
    return scan;
  }

  async getRunStartedEventScan(key: RunStartedEventScanKey): Promise<RunStartedEventScan | null> {
    const row = await this.db
      .prepare(
        `SELECT chain_id, verifying_contract, player, run_id,
      season_id, next_block, scanned_through, scanned_block_hash, event_json,
      event_block_number, event_block_hash, updated_at_ms FROM run_started_event_scans
      WHERE chain_id = ? AND verifying_contract = ? AND player = ? AND run_id = ? AND season_id = ?`,
      )
      .bind(
        key.chainId,
        key.verifyingContract.toLowerCase(),
        key.player.toLowerCase(),
        key.runId,
        key.seasonId,
      )
      .first<{
        chain_id: string;
        verifying_contract: string;
        player: string;
        run_id: string;
        season_id: string;
        next_block: number;
        scanned_through: number;
        scanned_block_hash: string | null;
        event_json: string | null;
        event_block_number: number | null;
        event_block_hash: string | null;
        updated_at_ms: number;
      }>();
    if (!row) return null;
    return {
      chainId: row.chain_id,
      verifyingContract: row.verifying_contract,
      player: row.player,
      runId: row.run_id,
      seasonId: row.season_id,
      nextBlock: Number(row.next_block),
      scannedThrough: Number(row.scanned_through),
      scannedBlockHash: row.scanned_block_hash,
      eventJson: row.event_json,
      eventBlockNumber: row.event_block_number === null ? null : Number(row.event_block_number),
      eventBlockHash: row.event_block_hash,
      updatedAtMs: Number(row.updated_at_ms),
    };
  }

  async advanceRunStartedEventScan(
    key: RunStartedEventScanKey,
    expectedNextBlock: number,
    next: Omit<RunStartedEventScan, keyof RunStartedEventScanKey>,
  ): Promise<RunStartedEventScanResult> {
    const result = await this.db
      .prepare(
        `UPDATE run_started_event_scans SET
      next_block = ?, scanned_through = ?, scanned_block_hash = ?, event_json = ?,
      event_block_number = ?, event_block_hash = ?, updated_at_ms = ?
      WHERE chain_id = ? AND verifying_contract = ? AND player = ? AND run_id = ? AND season_id = ?
        AND next_block = ? AND event_json IS NULL`,
      )
      .bind(
        next.nextBlock,
        next.scannedThrough,
        next.scannedBlockHash,
        next.eventJson,
        next.eventBlockNumber,
        next.eventBlockHash,
        next.updatedAtMs,
        key.chainId,
        key.verifyingContract.toLowerCase(),
        key.player.toLowerCase(),
        key.runId,
        key.seasonId,
        expectedNextBlock,
      )
      .run();
    return changed(result) === 1 ? 'advanced' : 'conflict';
  }

  async resetRunStartedEventScan(
    key: RunStartedEventScanKey,
    expectedNextBlock: number,
    deploymentBlock: number,
    nowMs: number,
  ): Promise<RunStartedEventScanResult> {
    const result = await this.db
      .prepare(
        `UPDATE run_started_event_scans SET
      next_block = ?, scanned_through = ?, scanned_block_hash = NULL, event_json = NULL,
      event_block_number = NULL, event_block_hash = NULL, updated_at_ms = ?
      WHERE chain_id = ? AND verifying_contract = ? AND player = ? AND run_id = ? AND season_id = ?
        AND next_block = ?`,
      )
      .bind(
        deploymentBlock,
        deploymentBlock - 1,
        nowMs,
        key.chainId,
        key.verifyingContract.toLowerCase(),
        key.player.toLowerCase(),
        key.runId,
        key.seasonId,
        expectedNextBlock,
      )
      .run();
    return changed(result) === 1 ? 'advanced' : 'conflict';
  }

  async read(runKey: string): Promise<RunJournal | null> {
    const run = await this.db
      .prepare(
        `SELECT r.run_key, r.initial_state, r.head_sequence, s.sequence AS snapshot_sequence,
              s.state AS snapshot_state FROM verifier_runs r
       JOIN verifier_snapshots s ON s.run_key = r.run_key
       WHERE r.run_key = ? ORDER BY s.sequence DESC LIMIT 1`,
      )
      .bind(runKey)
      .first<RunRow>();
    if (!run) return null;
    if (run.snapshot_sequence === undefined || run.snapshot_state === undefined)
      throw new Error('D1 verifier snapshot is incomplete.');
    const rows = checked(
      await this.db
        .prepare(
          `SELECT sequence, command_id, expected_sequence, command_json, server_time_ms,
              state_after, credited_atoms, spent_atoms FROM verifier_commands
       WHERE run_key = ? AND sequence > ? ORDER BY sequence ASC`,
        )
        .bind(runKey, run.snapshot_sequence)
        .all<RunRow>(),
    );
    const events: AcceptedCommandEvent[] = [];
    for (const row of rows) {
      if (row.sequence === null) continue;
      if (
        row.command_id === null ||
        row.expected_sequence === null ||
        row.command_json === null ||
        row.server_time_ms === null ||
        row.state_after === null ||
        row.credited_atoms === null ||
        row.spent_atoms === null
      )
        throw new Error('D1 command journal row is incomplete.');
      events.push({
        commandId: row.command_id,
        expectedSequence: Number(row.expected_sequence),
        sequence: Number(row.sequence),
        command: JSON.parse(row.command_json) as AcceptedCommandEvent['command'],
        serverTimeMs: Number(row.server_time_ms),
        stateAfter: row.state_after,
        creditedAtoms: row.credited_atoms,
        spentAtoms: row.spent_atoms,
      });
    }
    return {
      initialState: run.initial_state,
      snapshotSequence: Number(run.snapshot_sequence),
      snapshotState: run.snapshot_state,
      events,
      headSequence: Number(run.head_sequence),
    };
  }

  async findCommand(runKey: string, commandId: string): Promise<AcceptedCommandEvent | null> {
    const row = await this.db
      .prepare(
        `SELECT command_id, expected_sequence, sequence, command_json,
      server_time_ms, state_after, credited_atoms, spent_atoms FROM verifier_commands
      WHERE run_key = ? AND command_id = ? LIMIT 1`,
      )
      .bind(runKey, commandId)
      .first<RunRow>();
    if (!row) return null;
    if (
      row.command_id === null ||
      row.expected_sequence === null ||
      row.sequence === null ||
      row.command_json === null ||
      row.server_time_ms === null ||
      row.state_after === null ||
      row.credited_atoms === null ||
      row.spent_atoms === null
    )
      throw new Error('D1 command lookup row is incomplete.');
    return {
      commandId: row.command_id,
      expectedSequence: Number(row.expected_sequence),
      sequence: Number(row.sequence),
      command: JSON.parse(row.command_json) as AcceptedCommandEvent['command'],
      serverTimeMs: Number(row.server_time_ms),
      stateAfter: row.state_after,
      creditedAtoms: row.credited_atoms,
      spentAtoms: row.spent_atoms,
    };
  }

  async initializeIfAbsent(runKey: string, initialState: string): Promise<void> {
    const [run, snapshot] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO verifier_runs(run_key, initial_state, head_sequence, updated_at_ms)
        VALUES (?, ?, 0, 0) ON CONFLICT(run_key) DO NOTHING`,
        )
        .bind(runKey, initialState),
      this.db
        .prepare(
          `INSERT INTO verifier_snapshots(run_key, sequence, state)
        SELECT ?, 0, ? WHERE EXISTS (SELECT 1 FROM verifier_runs WHERE run_key = ?)
        ON CONFLICT(run_key, sequence) DO NOTHING`,
        )
        .bind(runKey, initialState, runKey),
    ]);
    changed(run!);
    changed(snapshot!);
  }

  async appendIfCurrentSequence(
    runKey: string,
    expectedSequence: number,
    event: AcceptedCommandEvent,
  ): Promise<'appended' | 'conflict'> {
    try {
      const statements = [
        this.db
          .prepare(
            `INSERT INTO verifier_commands(
               run_key, sequence, command_id, expected_sequence, command_json, server_time_ms,
               state_after, credited_atoms, spent_atoms
             ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
               WHERE EXISTS (SELECT 1 FROM verifier_runs WHERE run_key = ? AND head_sequence = ?)`,
          )
          .bind(
            runKey,
            event.sequence,
            event.commandId,
            expectedSequence,
            JSON.stringify(event.command),
            event.serverTimeMs,
            event.stateAfter,
            event.creditedAtoms,
            event.spentAtoms,
            runKey,
            expectedSequence,
          ),
        this.db
          .prepare(
            `UPDATE verifier_runs SET head_sequence = ?, updated_at_ms = ?
             WHERE run_key = ? AND head_sequence = ?
               AND EXISTS (SELECT 1 FROM verifier_commands
                           WHERE run_key = ? AND sequence = ? AND command_id = ?)`,
          )
          .bind(
            event.sequence,
            event.serverTimeMs,
            runKey,
            expectedSequence,
            runKey,
            event.sequence,
            event.commandId,
          ),
      ];
      if (event.sequence % JOURNAL_SNAPSHOT_INTERVAL === 0)
        statements.push(
          this.db
            .prepare(
              `INSERT INTO verifier_snapshots(run_key, sequence, state)
          SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM verifier_commands WHERE run_key = ? AND sequence = ?)
          ON CONFLICT(run_key, sequence) DO NOTHING`,
            )
            .bind(runKey, event.sequence, event.stateAfter, runKey, event.sequence),
        );
      const results = await this.db.batch(statements);
      const insertResult = results[0];
      const updateResult = results[1];
      const inserted = changed(insertResult!);
      const advanced = changed(updateResult!);
      if (inserted === 0 && advanced === 0) return 'conflict';
      if (inserted === 1 && advanced === 1) return 'appended';
      // An impossible partial result is treated as store corruption; replay will fail closed.
      throw new Error('D1 command append did not atomically advance its cursor.');
    } catch (error) {
      if (error instanceof Error && /constraint|sequence conflict/i.test(error.message))
        return 'conflict';
      throw error;
    }
  }

  async createChallenge(row: WalletChallengeRow): Promise<void> {
    changed(
      await this.db
        .prepare(
          `INSERT INTO wallet_challenges(
             challenge_id, nonce, wallet, chain_id, verifying_contract, origin, run_id,
             message, created_at_ms, expires_at_ms, consumed_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(
          row.challengeId,
          row.nonce,
          row.wallet,
          row.chainId,
          row.verifyingContract.toLowerCase(),
          row.origin,
          row.runId,
          row.message,
          row.createdAtMs,
          row.expiresAtMs,
        )
        .run(),
    );
  }

  async cleanupExpired(nowMs: number, limit: number): Promise<void> {
    if (
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('Expired authentication cleanup bounds are invalid.');
    const results = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM wallet_sessions WHERE token_hash IN (
        SELECT token_hash FROM wallet_sessions
        WHERE expires_at_ms <= ? OR revoked_at_ms IS NOT NULL
        ORDER BY expires_at_ms LIMIT ?)`,
        )
        .bind(nowMs, limit),
      this.db
        .prepare(
          `DELETE FROM wallet_challenges WHERE challenge_id IN (
        SELECT c.challenge_id FROM wallet_challenges c
        LEFT JOIN wallet_sessions s ON s.challenge_id = c.challenge_id
        WHERE c.expires_at_ms <= ? AND s.challenge_id IS NULL
        ORDER BY c.expires_at_ms LIMIT ?)`,
        )
        .bind(nowMs, limit),
    ]);
    changed(results[0]!);
    changed(results[1]!);
  }

  async getChallenge(challengeId: string): Promise<WalletChallengeRow | null> {
    const row = await this.db
      .prepare(
        `SELECT challenge_id, nonce, wallet, chain_id, verifying_contract, origin, run_id,
                message, created_at_ms, expires_at_ms
         FROM wallet_challenges WHERE challenge_id = ?`,
      )
      .bind(challengeId)
      .first<ChallengeDbRow>();
    return row ? fromChallenge(row) : null;
  }

  async consumeChallengeAndCreateSession(
    challengeId: string,
    nonce: string,
    nowMs: number,
    session: WalletSessionRow,
  ): Promise<boolean> {
    const [consumed, inserted] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE wallet_challenges SET consumed_at_ms = ?
           WHERE challenge_id = ? AND nonce = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?`,
        )
        .bind(nowMs, challengeId, nonce, nowMs),
      this.db
        .prepare(
          `INSERT INTO wallet_sessions(
             token_hash, session_id, wallet, chain_id, verifying_contract, origin, run_id,
             created_at_ms, expires_at_ms, revoked_at_ms, challenge_id
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
             WHERE EXISTS (SELECT 1 FROM wallet_challenges
                           WHERE challenge_id = ? AND nonce = ? AND consumed_at_ms = ?)
               AND NOT EXISTS (SELECT 1 FROM wallet_sessions WHERE challenge_id = ?)`,
        )
        .bind(
          session.tokenHash,
          session.sessionId,
          session.wallet,
          session.chainId,
          session.verifyingContract.toLowerCase(),
          session.origin,
          session.runId,
          session.createdAtMs,
          session.expiresAtMs,
          challengeId,
          challengeId,
          nonce,
          nowMs,
          challengeId,
        ),
    ]);
    const updateCount = changed(consumed!);
    const insertCount = changed(inserted!);
    if (updateCount === 1 && insertCount === 1) return true;
    if (updateCount === 0 && insertCount === 0) return false;
    throw new Error('D1 challenge/session transaction returned a partial result.');
  }

  async getSession(tokenHash: string, nowMs: number): Promise<WalletSessionRow | null> {
    const row = await this.db
      .prepare(
        `SELECT token_hash, session_id, wallet, chain_id, verifying_contract, origin, run_id,
                created_at_ms, expires_at_ms, challenge_id
         FROM wallet_sessions
         WHERE token_hash = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?`,
      )
      .bind(tokenHash, nowMs)
      .first<SessionDbRow>();
    return row ? fromSession(row) : null;
  }

  async revokeSession(tokenHash: string, nowMs: number): Promise<void> {
    changed(
      await this.db
        .prepare(
          `UPDATE wallet_sessions SET revoked_at_ms = ?
           WHERE token_hash = ? AND revoked_at_ms IS NULL`,
        )
        .bind(nowMs, tokenHash)
        .run(),
    );
  }

  async reserveAttestation(
    reservation: AttestationReservation,
    nowSeconds: number,
    observation: ConfirmedNonceObservation,
  ): Promise<ReservationResult> {
    if (!this.validObservation(reservation.chainId, reservation.verifyingContract, observation))
      return 'conflict';
    const result = await this.db
      .prepare(
        `INSERT INTO attestation_slots(
           chain_id, verifying_contract, player, nonce, payload_digest, payload_json, run_id,
           action_type, issued_at, expires_at, signature, signer_epoch, status
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending'
           WHERE EXISTS (
             SELECT 1 FROM chain_checkpoints WHERE chain_id = ? AND verifying_contract = ?
               AND block_number = ? AND lower(block_hash) = lower(?) AND healthy = 1
           )
         ON CONFLICT(chain_id, verifying_contract, player, nonce) DO UPDATE SET
           payload_digest = excluded.payload_digest, payload_json = excluded.payload_json,
           run_id = excluded.run_id, action_type = excluded.action_type,
           issued_at = excluded.issued_at, expires_at = excluded.expires_at,
           signature = NULL, signer_epoch = excluded.signer_epoch, status = 'pending'
         WHERE attestation_slots.status = 'pending'
           AND (attestation_slots.expires_at <= ? OR attestation_slots.signer_epoch < excluded.signer_epoch)`,
      )
      .bind(
        reservation.chainId,
        reservation.verifyingContract.toLowerCase(),
        reservation.player.toLowerCase(),
        reservation.nonce,
        reservation.payloadDigest,
        reservation.payloadJson,
        reservation.runId,
        reservation.actionType,
        reservation.issuedAt,
        reservation.expiresAt,
        reservation.signerEpoch,
        observation.chainId,
        observation.verifyingContract.toLowerCase(),
        observation.blockNumber,
        observation.blockHash,
        nowSeconds,
      )
      .run();
    const writes = changed(result);
    if (writes === 1) return 'reserved';
    const existing = await this.getAttestationSlot(reservation);
    if (
      existing?.status === 'pending' &&
      existing.expires_at > nowSeconds &&
      existing.signer_epoch === observation.signerEpoch &&
      existing.payload_digest === reservation.payloadDigest
    )
      return 'same-payload';
    return 'conflict';
  }

  async getPendingAttestation(
    chainId: string,
    verifyingContract: string,
    player: string,
    nonce: string,
    nowSeconds: number,
    signerEpoch: number,
  ): Promise<PendingAttestationRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT payload_digest, payload_json, signature, signer_epoch, expires_at
         FROM attestation_slots WHERE chain_id = ? AND verifying_contract = ?
           AND player = ? AND nonce = ? AND status = 'pending'
           AND expires_at > ? AND signer_epoch = ?`,
      )
      .bind(
        chainId,
        verifyingContract.toLowerCase(),
        player.toLowerCase(),
        nonce,
        nowSeconds,
        signerEpoch,
      )
      .first<{
        payload_digest: string;
        payload_json: string;
        signature: string | null;
        signer_epoch: number;
        expires_at: number;
      }>();
    return row
      ? {
          payloadDigest: row.payload_digest,
          payloadJson: row.payload_json,
          signature: row.signature,
          signerEpoch: row.signer_epoch,
          expiresAt: row.expires_at,
        }
      : null;
  }

  async commitAttestationSignature(
    chainId: string,
    verifyingContract: string,
    player: string,
    nonce: string,
    payloadDigest: string,
    signature: string,
    observation: ConfirmedNonceObservation,
  ): Promise<AttestationSignatureCommit> {
    if (!this.validObservation(chainId, verifyingContract, observation))
      return { status: 'conflict' };
    const result = await this.db
      .prepare(
        `UPDATE attestation_slots SET signature = ?
         WHERE chain_id = ? AND verifying_contract = ? AND player = ? AND nonce = ?
           AND payload_digest = ? AND signer_epoch = ? AND status = 'pending'
           AND signature IS NULL AND EXISTS (
             SELECT 1 FROM chain_checkpoints WHERE chain_id = ? AND verifying_contract = ?
               AND block_number = ? AND lower(block_hash) = lower(?) AND healthy = 1
           )`,
      )
      .bind(
        signature,
        chainId,
        verifyingContract.toLowerCase(),
        player.toLowerCase(),
        nonce,
        payloadDigest,
        observation.signerEpoch,
        observation.chainId,
        observation.verifyingContract.toLowerCase(),
        observation.blockNumber,
        observation.blockHash,
      )
      .run();
    if (changed(result) === 1) return { status: 'stored', signature };
    const existing = await this.getAttestationSignature(
      chainId,
      verifyingContract,
      player,
      nonce,
      payloadDigest,
      observation.signerEpoch,
    );
    return existing ? { status: 'existing', signature: existing } : { status: 'conflict' };
  }

  async getAttestationSignature(
    chainId: string,
    verifyingContract: string,
    player: string,
    nonce: string,
    payloadDigest: string,
    signerEpoch: number,
  ): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT signature FROM attestation_slots
         WHERE chain_id = ? AND verifying_contract = ? AND player = ? AND nonce = ?
           AND payload_digest = ? AND signer_epoch = ? AND status = 'pending'`,
      )
      .bind(
        chainId,
        verifyingContract.toLowerCase(),
        player.toLowerCase(),
        nonce,
        payloadDigest,
        signerEpoch,
      )
      .first<{ signature: string | null }>();
    return row?.signature ?? null;
  }

  private async getAttestationSlot(reservation: AttestationReservation) {
    return this.db
      .prepare(
        `SELECT payload_digest, signature, signer_epoch, status, expires_at
         FROM attestation_slots WHERE chain_id = ? AND verifying_contract = ?
           AND player = ? AND nonce = ?`,
      )
      .bind(
        reservation.chainId,
        reservation.verifyingContract.toLowerCase(),
        reservation.player.toLowerCase(),
        reservation.nonce,
      )
      .first<AttestationDbRow>();
  }

  private async validObservation(
    chainId: string,
    verifyingContract: string,
    observation: ConfirmedNonceObservation,
  ): Promise<boolean> {
    if (
      observation.chainId !== chainId ||
      observation.verifyingContract.toLowerCase() !== verifyingContract.toLowerCase() ||
      !/^(0|[1-9][0-9]*)$/.test(observation.timestampSeconds) ||
      BigInt(observation.timestampSeconds) > (1n << 64n) - 1n ||
      !/^(0|[1-9][0-9]*)$/.test(observation.nonce) ||
      BigInt(observation.nonce) > (1n << 64n) - 1n ||
      !Number.isSafeInteger(observation.blockNumber) ||
      observation.blockNumber < 0 ||
      !Number.isSafeInteger(observation.confirmations) ||
      observation.confirmations < 1 ||
      !Number.isSafeInteger(observation.signerEpoch) ||
      observation.signerEpoch < 0 ||
      observation.signerEpoch > 0xffff_ffff ||
      !/^0x[0-9a-fA-F]{64}$/.test(observation.blockHash)
    )
      return false;
    const checkpoint = await this.getChainCheckpoint(chainId, verifyingContract);
    return Boolean(
      checkpoint &&
      checkpoint.blockNumber === observation.blockNumber &&
      checkpoint.blockHash.toLowerCase() === observation.blockHash.toLowerCase(),
    );
  }

  async advanceChainCheckpoint(
    checkpoint: ChainCheckpoint,
    nowMs: number,
    expectedHead?: ChainCheckpoint,
  ): Promise<CheckpointResult> {
    const [chainId, address] = checkpointKey(checkpoint.chainId, checkpoint.verifyingContract);
    const existing = await this.getCheckpointIncludingUnhealthy(chainId, address);
    if (!existing) {
      const insert = await this.db
        .prepare(
          `INSERT INTO chain_checkpoints(
             chain_id, verifying_contract, block_number, block_hash, parent_hash, healthy, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(chain_id, verifying_contract) DO NOTHING`,
        )
        .bind(
          chainId,
          address,
          checkpoint.blockNumber,
          checkpoint.blockHash,
          checkpoint.parentHash,
          nowMs,
        )
        .run();
      if (changed(insert) === 1) return 'initialized';
      return this.advanceChainCheckpoint(checkpoint, nowMs);
    }
    if (!existing.healthy) return 'reorg';
    if (
      existing.block_number === checkpoint.blockNumber &&
      existing.block_hash.toLowerCase() === checkpoint.blockHash.toLowerCase()
    )
      return 'unchanged';
    if (expectedHead) {
      if (
        !existing.healthy ||
        expectedHead.chainId !== checkpoint.chainId ||
        expectedHead.verifyingContract.toLowerCase() !==
          checkpoint.verifyingContract.toLowerCase() ||
        existing.block_number !== expectedHead.blockNumber ||
        existing.block_hash.toLowerCase() !== expectedHead.blockHash.toLowerCase() ||
        checkpoint.blockNumber < expectedHead.blockNumber
      )
        return 'reorg';
      if (checkpoint.blockNumber === existing.block_number) {
        await this.db
          .prepare(
            `UPDATE chain_checkpoints SET healthy = 0, updated_at_ms = ?
             WHERE chain_id = ? AND verifying_contract = ? AND healthy = 1
               AND block_number = ? AND lower(block_hash) = lower(?)`,
          )
          .bind(nowMs, chainId, address, expectedHead.blockNumber, expectedHead.blockHash)
          .run();
        return 'reorg';
      }
      const update = await this.db
        .prepare(
          `UPDATE chain_checkpoints SET block_number = ?, block_hash = ?, parent_hash = ?, updated_at_ms = ?
           WHERE chain_id = ? AND verifying_contract = ? AND healthy = 1
             AND block_number = ? AND lower(block_hash) = lower(?)`,
        )
        .bind(
          checkpoint.blockNumber,
          checkpoint.blockHash,
          checkpoint.parentHash,
          nowMs,
          chainId,
          address,
          expectedHead.blockNumber,
          expectedHead.blockHash,
        )
        .run();
      if (changed(update) === 1) return 'advanced';
      const winner = await this.getChainCheckpoint(chainId, address);
      return winner?.blockNumber === checkpoint.blockNumber &&
        winner.blockHash.toLowerCase() === checkpoint.blockHash.toLowerCase()
        ? 'unchanged'
        : 'reorg';
    }
    const extendsHead =
      checkpoint.blockNumber === existing.block_number + 1 &&
      checkpoint.parentHash.toLowerCase() === existing.block_hash.toLowerCase();
    if (!extendsHead) {
      await this.db
        .prepare(
          `UPDATE chain_checkpoints SET healthy = 0, updated_at_ms = ?
           WHERE chain_id = ? AND verifying_contract = ? AND healthy = 1
             AND block_number = ? AND lower(block_hash) = lower(?)`,
        )
        .bind(nowMs, chainId, address, existing.block_number, existing.block_hash)
        .run();
      return 'reorg';
    }
    const update = await this.db
      .prepare(
        `UPDATE chain_checkpoints SET block_number = ?, block_hash = ?, parent_hash = ?, updated_at_ms = ?
         WHERE chain_id = ? AND verifying_contract = ? AND healthy = 1
           AND block_number = ? AND lower(block_hash) = lower(?)`,
      )
      .bind(
        checkpoint.blockNumber,
        checkpoint.blockHash,
        checkpoint.parentHash,
        nowMs,
        chainId,
        address,
        existing.block_number,
        existing.block_hash,
      )
      .run();
    return changed(update) === 1 ? 'advanced' : 'reorg';
  }

  async reconcileChainCheckpoint(checkpoint: ChainCheckpoint, nowMs: number): Promise<void> {
    changed(
      await this.db
        .prepare(
          `INSERT INTO chain_checkpoints(
             chain_id, verifying_contract, block_number, block_hash, parent_hash, healthy, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(chain_id, verifying_contract) DO UPDATE SET
             block_number = excluded.block_number, block_hash = excluded.block_hash,
             parent_hash = excluded.parent_hash, healthy = 1, updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(
          checkpoint.chainId,
          checkpoint.verifyingContract.toLowerCase(),
          checkpoint.blockNumber,
          checkpoint.blockHash,
          checkpoint.parentHash,
          nowMs,
        )
        .run(),
    );
  }

  async getChainCheckpoint(
    chainId: string,
    verifyingContract: string,
  ): Promise<ChainCheckpoint | null> {
    const row = await this.db
      .prepare(
        `SELECT chain_id, verifying_contract, block_number, block_hash, parent_hash
         FROM chain_checkpoints WHERE chain_id = ? AND verifying_contract = ? AND healthy = 1`,
      )
      .bind(chainId, verifyingContract.toLowerCase())
      .first<CheckpointDbRow>();
    return row ? fromCheckpoint(row) : null;
  }

  private async getCheckpointIncludingUnhealthy(chainId: string, verifyingContract: string) {
    return this.db
      .prepare(
        `SELECT block_number, block_hash, healthy FROM chain_checkpoints
         WHERE chain_id = ? AND verifying_contract = ?`,
      )
      .bind(chainId, verifyingContract)
      .first<{ block_number: number; block_hash: string; healthy: number }>();
  }
}
