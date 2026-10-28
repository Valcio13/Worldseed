import { DatabaseSync } from 'node:sqlite';
import {
  JOURNAL_SNAPSHOT_INTERVAL,
  type AcceptedCommandEvent,
  type RunJournal,
  type VerifierPersistence,
} from '../localVerifier';
import type {
  AttestationReservation,
  ChainCheckpoint,
  ConfirmedNonceObservation,
  PendingAttestationRecord,
  ReservationResult,
  RunStartedEventScan,
  RunStartedEventScanKey,
  RunStartedEventScanResult,
  RunStartedEventStore,
  WalletChallengeRow,
  WalletSessionRow,
} from './verifierStoreTypes';
export type {
  AttestationReservation,
  ChainCheckpoint,
  ConfirmedNonceObservation,
  ReservationResult,
  WalletChallengeRow,
  WalletSessionRow,
} from './verifierStoreTypes';

const UINT64_MAX = (1n << 64n) - 1n;

/** Node 22 SQLite adapter. Keep this server-only module out of browser imports. */
export class SqliteVerifierStore implements VerifierPersistence, RunStartedEventStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;',
    );
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  initializeRunStartedEventScan(
    key: RunStartedEventScanKey,
    deploymentBlock: number,
    nowMs: number,
  ): RunStartedEventScan {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO run_started_event_scans(
      chain_id, verifying_contract, player, run_id, season_id, next_block, scanned_through,
      scanned_block_hash, event_json, event_block_number, event_block_hash, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(
        key.chainId,
        key.verifyingContract.toLowerCase(),
        key.player.toLowerCase(),
        key.runId,
        key.seasonId,
        deploymentBlock,
        deploymentBlock - 1,
        nowMs,
      );
    const scan = this.getRunStartedEventScan(key);
    if (!scan) throw new Error('SQLite RunStarted event scan could not be initialized.');
    return scan;
  }

  getRunStartedEventScan(key: RunStartedEventScanKey): RunStartedEventScan | null {
    const row = this.db
      .prepare(
        `SELECT chain_id, verifying_contract, player, run_id, season_id,
      next_block, scanned_through, scanned_block_hash, event_json, event_block_number,
      event_block_hash, updated_at_ms FROM run_started_event_scans WHERE chain_id = ?
      AND verifying_contract = ? AND player = ? AND run_id = ? AND season_id = ?`,
      )
      .get(
        key.chainId,
        key.verifyingContract.toLowerCase(),
        key.player.toLowerCase(),
        key.runId,
        key.seasonId,
      ) as Record<string, string | number | null> | undefined;
    if (!row) return null;
    return {
      chainId: String(row.chain_id),
      verifyingContract: String(row.verifying_contract),
      player: String(row.player),
      runId: String(row.run_id),
      seasonId: String(row.season_id),
      nextBlock: Number(row.next_block),
      scannedThrough: Number(row.scanned_through),
      scannedBlockHash: row.scanned_block_hash === null ? null : String(row.scanned_block_hash),
      eventJson: row.event_json === null ? null : String(row.event_json),
      eventBlockNumber: row.event_block_number === null ? null : Number(row.event_block_number),
      eventBlockHash: row.event_block_hash === null ? null : String(row.event_block_hash),
      updatedAtMs: Number(row.updated_at_ms),
    };
  }

  advanceRunStartedEventScan(
    key: RunStartedEventScanKey,
    expectedNextBlock: number,
    next: Omit<RunStartedEventScan, keyof RunStartedEventScanKey>,
  ): RunStartedEventScanResult {
    const result = this.db
      .prepare(
        `UPDATE run_started_event_scans SET next_block = ?,
      scanned_through = ?, scanned_block_hash = ?, event_json = ?, event_block_number = ?,
      event_block_hash = ?, updated_at_ms = ? WHERE chain_id = ? AND verifying_contract = ?
      AND player = ? AND run_id = ? AND season_id = ? AND next_block = ? AND event_json IS NULL`,
      )
      .run(
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
      );
    return Number(result.changes) === 1 ? 'advanced' : 'conflict';
  }

  resetRunStartedEventScan(
    key: RunStartedEventScanKey,
    expectedNextBlock: number,
    deploymentBlock: number,
    nowMs: number,
  ): RunStartedEventScanResult {
    const result = this.db
      .prepare(
        `UPDATE run_started_event_scans SET next_block = ?,
      scanned_through = ?, scanned_block_hash = NULL, event_json = NULL,
      event_block_number = NULL, event_block_hash = NULL, updated_at_ms = ?
      WHERE chain_id = ? AND verifying_contract = ? AND player = ? AND run_id = ?
      AND season_id = ? AND next_block = ?`,
      )
      .run(
        deploymentBlock,
        deploymentBlock - 1,
        nowMs,
        key.chainId,
        key.verifyingContract.toLowerCase(),
        key.player.toLowerCase(),
        key.runId,
        key.seasonId,
        expectedNextBlock,
      );
    return Number(result.changes) === 1 ? 'advanced' : 'conflict';
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verifier_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO verifier_schema(singleton, version) VALUES (1, 5);
      CREATE TABLE IF NOT EXISTS verifier_runs (
        run_key TEXT PRIMARY KEY,
        initial_state TEXT NOT NULL,
        head_sequence INTEGER NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
        updated_at_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS verifier_commands (
        run_key TEXT NOT NULL REFERENCES verifier_runs(run_key) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        command_id TEXT NOT NULL,
        expected_sequence INTEGER NOT NULL CHECK (expected_sequence >= 0),
        command_json TEXT NOT NULL,
        server_time_ms INTEGER NOT NULL,
        state_after TEXT NOT NULL,
        credited_atoms TEXT NOT NULL,
        spent_atoms TEXT NOT NULL,
        PRIMARY KEY (run_key, sequence),
        UNIQUE (run_key, command_id)
      );
      CREATE TABLE IF NOT EXISTS verifier_snapshots (
        run_key TEXT NOT NULL REFERENCES verifier_runs(run_key) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        state TEXT NOT NULL,
        PRIMARY KEY (run_key, sequence)
      );
      CREATE TABLE IF NOT EXISTS run_started_event_scans (
        chain_id TEXT NOT NULL, verifying_contract TEXT NOT NULL, player TEXT NOT NULL,
        run_id TEXT NOT NULL, season_id TEXT NOT NULL, next_block INTEGER NOT NULL,
        scanned_through INTEGER NOT NULL, scanned_block_hash TEXT, event_json TEXT,
        event_block_number INTEGER, event_block_hash TEXT, updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (chain_id, verifying_contract, player, run_id, season_id)
      );
      CREATE TABLE IF NOT EXISTS wallet_challenges (
        challenge_id TEXT PRIMARY KEY,
        nonce TEXT NOT NULL UNIQUE,
        wallet TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        verifying_contract TEXT NOT NULL,
        origin TEXT NOT NULL,
        run_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        consumed_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS wallet_sessions (
        token_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        wallet TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        verifying_contract TEXT NOT NULL,
        origin TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS wallet_sessions_expiry ON wallet_sessions(expires_at_ms);
      CREATE TABLE IF NOT EXISTS attestation_slots (
        chain_id TEXT NOT NULL,
        verifying_contract TEXT NOT NULL,
        player TEXT NOT NULL,
        nonce TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        run_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        signature TEXT,
        signer_epoch INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'cancelled')),
        PRIMARY KEY (chain_id, verifying_contract, player, nonce)
      );
      CREATE TABLE IF NOT EXISTS chain_checkpoints (
        chain_id TEXT NOT NULL,
        verifying_contract TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        parent_hash TEXT NOT NULL,
        healthy INTEGER NOT NULL CHECK (healthy IN (0, 1)),
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (chain_id, verifying_contract)
      );
    `);
    const version = this.db
      .prepare('SELECT version FROM verifier_schema WHERE singleton = 1')
      .get() as { version: number } | undefined;
    if (!version) throw new Error('Unsupported verifier SQLite schema version: missing');
    if (version.version === 1) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const columns = this.db.prepare('PRAGMA table_info(attestation_slots)').all() as Array<{
          name: string;
        }>;
        if (!columns.some((column) => column.name === 'signature'))
          this.db.exec('ALTER TABLE attestation_slots ADD COLUMN signature TEXT');
        this.db.prepare('UPDATE verifier_schema SET version = 2 WHERE singleton = 1').run();
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    let migratedVersion = this.db
      .prepare('SELECT version FROM verifier_schema WHERE singleton = 1')
      .get() as { version: number } | undefined;
    if (migratedVersion?.version === 2) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const columns = this.db.prepare('PRAGMA table_info(attestation_slots)').all() as Array<{
          name: string;
        }>;
        if (!columns.some((column) => column.name === 'signer_epoch'))
          this.db.exec(
            'ALTER TABLE attestation_slots ADD COLUMN signer_epoch INTEGER NOT NULL DEFAULT 0',
          );
        this.db.prepare('UPDATE verifier_schema SET version = 3 WHERE singleton = 1').run();
        this.db.exec('COMMIT');
        migratedVersion = { version: 3 };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    if (migratedVersion?.version === 3) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS verifier_snapshots (
            run_key TEXT NOT NULL REFERENCES verifier_runs(run_key) ON DELETE RESTRICT,
            sequence INTEGER NOT NULL CHECK (sequence >= 0),
            state TEXT NOT NULL,
            PRIMARY KEY (run_key, sequence)
          );
          INSERT OR IGNORE INTO verifier_snapshots(run_key, sequence, state)
            SELECT run_key, 0, initial_state FROM verifier_runs;
        `);
        this.db.prepare('UPDATE verifier_schema SET version = 4 WHERE singleton = 1').run();
        this.db.exec('COMMIT');
        migratedVersion = { version: 4 };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    if (migratedVersion?.version === 4) {
      this.db.prepare('UPDATE verifier_schema SET version = 5 WHERE singleton = 1').run();
      migratedVersion = { version: 5 };
    }
    if (migratedVersion?.version !== 5) {
      throw new Error(
        `Unsupported verifier SQLite schema version: ${migratedVersion?.version ?? 'missing'}`,
      );
    }
  }

  async read(runKey: string): Promise<RunJournal | null> {
    const run = this.db
      .prepare(
        `SELECT r.initial_state, r.head_sequence, s.sequence AS snapshot_sequence, s.state AS snapshot_state
                FROM verifier_runs r JOIN verifier_snapshots s ON s.run_key = r.run_key
                WHERE r.run_key = ? ORDER BY s.sequence DESC LIMIT 1`,
      )
      .get(runKey) as
      | {
          initial_state: string;
          head_sequence: number;
          snapshot_sequence: number;
          snapshot_state: string;
        }
      | undefined;
    if (!run) return null;
    const rows = this.db
      .prepare(
        `
      SELECT command_id, expected_sequence, sequence, command_json, server_time_ms,
             state_after, credited_atoms, spent_atoms
      FROM verifier_commands WHERE run_key = ? AND sequence > ? ORDER BY sequence ASC
    `,
      )
      .all(runKey, run.snapshot_sequence) as Array<Record<string, string | number>>;
    return {
      initialState: run.initial_state,
      snapshotSequence: Number(run.snapshot_sequence),
      snapshotState: run.snapshot_state,
      headSequence: run.head_sequence,
      events: rows.map((row) => ({
        commandId: String(row.command_id),
        expectedSequence: Number(row.expected_sequence),
        sequence: Number(row.sequence),
        command: JSON.parse(String(row.command_json)) as AcceptedCommandEvent['command'],
        serverTimeMs: Number(row.server_time_ms),
        stateAfter: String(row.state_after),
        creditedAtoms: String(row.credited_atoms),
        spentAtoms: String(row.spent_atoms),
      })),
    };
  }

  async findCommand(runKey: string, commandId: string): Promise<AcceptedCommandEvent | null> {
    const row = this.db
      .prepare(
        `SELECT command_id, expected_sequence, sequence, command_json,
      server_time_ms, state_after, credited_atoms, spent_atoms FROM verifier_commands
      WHERE run_key = ? AND command_id = ?`,
      )
      .get(runKey, commandId) as Record<string, string | number> | undefined;
    if (!row) return null;
    return {
      commandId: String(row.command_id),
      expectedSequence: Number(row.expected_sequence),
      sequence: Number(row.sequence),
      command: JSON.parse(String(row.command_json)) as AcceptedCommandEvent['command'],
      serverTimeMs: Number(row.server_time_ms),
      stateAfter: String(row.state_after),
      creditedAtoms: String(row.credited_atoms),
      spentAtoms: String(row.spent_atoms),
    };
  }

  async initializeIfAbsent(runKey: string, initialState: string): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(`INSERT OR IGNORE INTO verifier_runs(run_key, initial_state) VALUES (?, ?)`)
        .run(runKey, initialState);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO verifier_snapshots(run_key, sequence, state) VALUES (?, 0, ?)`,
        )
        .run(runKey, initialState);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async appendIfCurrentSequence(
    runKey: string,
    expectedSequence: number,
    event: AcceptedCommandEvent,
  ): Promise<'appended' | 'conflict'> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.db
        .prepare('SELECT head_sequence FROM verifier_runs WHERE run_key = ?')
        .get(runKey) as { head_sequence: number } | undefined;
      if (
        !run ||
        run.head_sequence !== expectedSequence ||
        event.sequence !== expectedSequence + 1
      ) {
        this.db.exec('ROLLBACK');
        return 'conflict';
      }
      this.db
        .prepare(
          `
        INSERT INTO verifier_commands(
          run_key, sequence, command_id, expected_sequence, command_json, server_time_ms,
          state_after, credited_atoms, spent_atoms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          runKey,
          event.sequence,
          event.commandId,
          event.expectedSequence,
          JSON.stringify(event.command),
          event.serverTimeMs,
          event.stateAfter,
          event.creditedAtoms,
          event.spentAtoms,
        );
      const updated = this.db
        .prepare(
          `
        UPDATE verifier_runs SET head_sequence = ?, updated_at_ms = ?
        WHERE run_key = ? AND head_sequence = ?
      `,
        )
        .run(event.sequence, event.serverTimeMs, runKey, expectedSequence);
      if (Number(updated.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return 'conflict';
      }
      if (event.sequence % JOURNAL_SNAPSHOT_INTERVAL === 0)
        this.db
          .prepare('INSERT INTO verifier_snapshots(run_key, sequence, state) VALUES (?, ?, ?)')
          .run(runKey, event.sequence, event.stateAfter);
      this.db.exec('COMMIT');
      return 'appended';
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (
        error instanceof Error &&
        'code' in error &&
        String(error.code).startsWith('SQLITE_CONSTRAINT')
      )
        return 'conflict';
      throw error;
    }
  }

  createChallenge(row: WalletChallengeRow): void {
    this.db
      .prepare(
        `
      INSERT INTO wallet_challenges(
        challenge_id, nonce, wallet, chain_id, verifying_contract, origin, run_id,
        message, created_at_ms, expires_at_ms, consumed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `,
      )
      .run(
        row.challengeId,
        row.nonce,
        row.wallet,
        row.chainId,
        row.verifyingContract,
        row.origin,
        row.runId,
        row.message,
        row.createdAtMs,
        row.expiresAtMs,
      );
  }

  getChallenge(challengeId: string): WalletChallengeRow | null {
    const row = this.db
      .prepare(
        `
      SELECT challenge_id, nonce, wallet, chain_id, verifying_contract, origin, run_id,
             message, created_at_ms, expires_at_ms
      FROM wallet_challenges WHERE challenge_id = ?
    `,
      )
      .get(challengeId) as Record<string, string | number> | undefined;
    if (!row) return null;
    return {
      challengeId: String(row.challenge_id),
      nonce: String(row.nonce),
      wallet: String(row.wallet),
      chainId: String(row.chain_id),
      verifyingContract: String(row.verifying_contract),
      origin: String(row.origin),
      runId: String(row.run_id),
      message: String(row.message),
      createdAtMs: Number(row.created_at_ms),
      expiresAtMs: Number(row.expires_at_ms),
    };
  }

  consumeChallengeAndCreateSession(
    challengeId: string,
    nonce: string,
    nowMs: number,
    session: WalletSessionRow,
  ): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const challenge = this.db
        .prepare(
          `
        SELECT nonce, expires_at_ms, consumed_at_ms FROM wallet_challenges WHERE challenge_id = ?
      `,
        )
        .get(challengeId) as
        { nonce: string; expires_at_ms: number; consumed_at_ms: number | null } | undefined;
      if (
        !challenge ||
        challenge.nonce !== nonce ||
        challenge.consumed_at_ms !== null ||
        challenge.expires_at_ms <= nowMs
      ) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const consumed = this.db
        .prepare(
          `
        UPDATE wallet_challenges SET consumed_at_ms = ? WHERE challenge_id = ? AND consumed_at_ms IS NULL
      `,
        )
        .run(nowMs, challengeId);
      if (Number(consumed.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.insertSession(session);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (
        error instanceof Error &&
        'code' in error &&
        String(error.code).startsWith('SQLITE_CONSTRAINT')
      )
        return false;
      throw error;
    }
  }

  private insertSession(session: WalletSessionRow): void {
    this.db
      .prepare(
        `
      INSERT INTO wallet_sessions(
        token_hash, session_id, wallet, chain_id, verifying_contract, origin, run_id,
        created_at_ms, expires_at_ms, revoked_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `,
      )
      .run(
        session.tokenHash,
        session.sessionId,
        session.wallet,
        session.chainId,
        session.verifyingContract,
        session.origin,
        session.runId,
        session.createdAtMs,
        session.expiresAtMs,
      );
  }

  getSession(tokenHash: string, nowMs: number): WalletSessionRow | null {
    const row = this.db
      .prepare(
        `
      SELECT token_hash, session_id, wallet, chain_id, verifying_contract, origin, run_id,
             created_at_ms, expires_at_ms
      FROM wallet_sessions
      WHERE token_hash = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
    `,
      )
      .get(tokenHash, nowMs) as Record<string, string | number> | undefined;
    if (!row) return null;
    return {
      tokenHash: String(row.token_hash),
      sessionId: String(row.session_id),
      wallet: String(row.wallet),
      chainId: String(row.chain_id),
      verifyingContract: String(row.verifying_contract),
      origin: String(row.origin),
      runId: String(row.run_id),
      createdAtMs: Number(row.created_at_ms),
      expiresAtMs: Number(row.expires_at_ms),
    };
  }

  revokeSession(tokenHash: string, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE wallet_sessions SET revoked_at_ms = ? WHERE token_hash = ? AND revoked_at_ms IS NULL`,
      )
      .run(nowMs, tokenHash);
  }

  getPendingAttestation(
    chainId: string,
    verifyingContract: string,
    player: string,
    nonce: string,
    nowSeconds: number,
    signerEpoch: number,
  ): PendingAttestationRecord | null {
    const row = this.db
      .prepare(
        `SELECT payload_digest, payload_json, signature, signer_epoch, expires_at
         FROM attestation_slots WHERE chain_id = ? AND verifying_contract = ?
           AND player = ? AND nonce = ? AND status = 'pending'
           AND expires_at > ? AND signer_epoch = ?`,
      )
      .get(
        chainId,
        verifyingContract.toLowerCase(),
        player.toLowerCase(),
        nonce,
        nowSeconds,
        signerEpoch,
      ) as
      | {
          payload_digest: string;
          payload_json: string;
          signature: string | null;
          signer_epoch: number;
          expires_at: number;
        }
      | undefined;
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

  reserveAttestation(
    reservation: AttestationReservation,
    nowSeconds: number,
    observation: ConfirmedNonceObservation,
  ): ReservationResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        observation.chainId !== reservation.chainId ||
        observation.verifyingContract.toLowerCase() !==
          reservation.verifyingContract.toLowerCase() ||
        observation.nonce !== reservation.nonce ||
        observation.signerEpoch !== reservation.signerEpoch ||
        !this.isCurrentConfirmedObservation(observation)
      ) {
        this.db.exec('ROLLBACK');
        return 'conflict';
      }
      const existing = this.db
        .prepare(
          `
        SELECT payload_digest, expires_at, status, signer_epoch FROM attestation_slots
        WHERE chain_id = ? AND verifying_contract = ? AND player = ? AND nonce = ?
      `,
        )
        .get(
          reservation.chainId,
          reservation.verifyingContract.toLowerCase(),
          reservation.player.toLowerCase(),
          reservation.nonce,
        ) as
        | {
            payload_digest: string;
            expires_at: number;
            status: string;
            signer_epoch: number;
          }
        | undefined;
      if (existing?.status === 'pending' && existing.expires_at > nowSeconds) {
        if (existing.signer_epoch >= observation.signerEpoch) {
          this.db.exec('ROLLBACK');
          return existing.signer_epoch === observation.signerEpoch &&
            existing.payload_digest === reservation.payloadDigest
            ? 'same-payload'
            : 'conflict';
        }
      }
      if (existing && existing.status === 'consumed') {
        this.db.exec('ROLLBACK');
        return 'conflict';
      }
      this.db
        .prepare(
          `
        INSERT INTO attestation_slots(
          chain_id, verifying_contract, player, nonce, payload_digest, payload_json,
          run_id, action_type, issued_at, expires_at, signature, signer_epoch, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending')
        ON CONFLICT(chain_id, verifying_contract, player, nonce) DO UPDATE SET
          payload_digest = excluded.payload_digest, payload_json = excluded.payload_json,
          run_id = excluded.run_id, action_type = excluded.action_type,
          issued_at = excluded.issued_at, expires_at = excluded.expires_at,
          signature = NULL, signer_epoch = excluded.signer_epoch, status = 'pending'
      `,
        )
        .run(
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
        );
      this.db.exec('COMMIT');
      return 'reserved';
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The winning signature is persisted once so concurrent/restarted issuers return identical bytes. */
  commitAttestationSignature(
    chainId: string,
    verifyingContract: string,
    player: string,
    nonce: string,
    payloadDigest: string,
    signature: string,
    observation: ConfirmedNonceObservation,
  ): { status: 'stored' | 'existing' | 'conflict'; signature?: string } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        observation.chainId !== chainId ||
        observation.verifyingContract.toLowerCase() !== verifyingContract.toLowerCase() ||
        !this.isCurrentConfirmedObservation(observation)
      ) {
        this.db.exec('ROLLBACK');
        return { status: 'conflict' };
      }
      const slot = this.db
        .prepare(
          `
        SELECT payload_digest, status, signature, signer_epoch FROM attestation_slots
        WHERE chain_id = ? AND verifying_contract = ? AND player = ? AND nonce = ?
      `,
        )
        .get(chainId, verifyingContract.toLowerCase(), player.toLowerCase(), nonce) as
        | { payload_digest: string; status: string; signature: string | null; signer_epoch: number }
        | undefined;
      if (
        !slot ||
        slot.status !== 'pending' ||
        slot.payload_digest !== payloadDigest ||
        slot.signer_epoch !== observation.signerEpoch
      ) {
        this.db.exec('ROLLBACK');
        return { status: 'conflict' };
      }
      if (slot.signature !== null) {
        this.db.exec('COMMIT');
        return { status: 'existing', signature: slot.signature };
      }
      const updated = this.db
        .prepare(
          `
        UPDATE attestation_slots SET signature = ?
        WHERE chain_id = ? AND verifying_contract = ? AND player = ? AND nonce = ?
          AND payload_digest = ? AND status = 'pending' AND signature IS NULL
      `,
        )
        .run(
          signature,
          chainId,
          verifyingContract.toLowerCase(),
          player.toLowerCase(),
          nonce,
          payloadDigest,
        );
      if (Number(updated.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return { status: 'conflict' };
      }
      this.db.exec('COMMIT');
      return { status: 'stored', signature };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getAttestationSignature(
    chainId: string,
    verifyingContract: string,
    player: string,
    nonce: string,
    payloadDigest: string,
    signerEpoch: number,
  ): string | null {
    const slot = this.db
      .prepare(
        `
      SELECT signature FROM attestation_slots
      WHERE chain_id = ? AND verifying_contract = ? AND player = ? AND nonce = ?
        AND payload_digest = ? AND signer_epoch = ? AND status = 'pending'
    `,
      )
      .get(
        chainId,
        verifyingContract.toLowerCase(),
        player.toLowerCase(),
        nonce,
        payloadDigest,
        signerEpoch,
      ) as { signature: string | null } | undefined;
    return slot?.signature ?? null;
  }

  /** Settle only after authoritative chain reconciliation proves nonce consumption or non-consumption. */
  settleAttestation(
    chainId: string,
    verifyingContract: string,
    player: string,
    nonce: string,
    payloadDigest: string,
    outcome: 'consumed' | 'cancelled',
    observation: ConfirmedNonceObservation,
    nowSeconds: number,
  ): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        observation.chainId !== chainId ||
        observation.verifyingContract.toLowerCase() !== verifyingContract.toLowerCase() ||
        !/^(0|[1-9][0-9]*)$/.test(nonce) ||
        BigInt(nonce) > UINT64_MAX ||
        !Number.isSafeInteger(nowSeconds) ||
        nowSeconds < 0 ||
        !this.isCurrentConfirmedObservation(observation)
      ) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const slot = this.db
        .prepare(
          `
      SELECT expires_at, status, signer_epoch FROM attestation_slots
      WHERE chain_id = ? AND verifying_contract = ? AND player = ? AND nonce = ? AND payload_digest = ?
    `,
        )
        .get(
          chainId,
          verifyingContract.toLowerCase(),
          player.toLowerCase(),
          nonce,
          payloadDigest,
        ) as { expires_at: number; status: string; signer_epoch: number } | undefined;
      if (!slot || slot.status !== 'pending') {
        this.db.exec('ROLLBACK');
        return false;
      }
      const reservedNonce = BigInt(nonce);
      const observedNonce = BigInt(observation.nonce);
      if (
        outcome === 'consumed' &&
        (observedNonce !== reservedNonce + 1n || observation.signerEpoch !== slot.signer_epoch)
      ) {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (
        outcome === 'cancelled' &&
        (observedNonce !== reservedNonce ||
          (nowSeconds < slot.expires_at && observation.signerEpoch <= slot.signer_epoch))
      ) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const result = this.db
        .prepare(
          `
      UPDATE attestation_slots SET status = ?
      WHERE chain_id = ? AND verifying_contract = ? AND player = ? AND nonce = ?
        AND payload_digest = ? AND status = 'pending'
    `,
        )
        .run(
          outcome,
          chainId,
          verifyingContract.toLowerCase(),
          player.toLowerCase(),
          nonce,
          payloadDigest,
        );
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private isCurrentConfirmedObservation(observation: ConfirmedNonceObservation): boolean {
    if (
      !/^(0|[1-9][0-9]*)$/.test(observation.timestampSeconds) ||
      BigInt(observation.timestampSeconds) > UINT64_MAX ||
      !/^(0|[1-9][0-9]*)$/.test(observation.nonce) ||
      BigInt(observation.nonce) > UINT64_MAX ||
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
    const checkpoint = this.getChainCheckpoint(observation.chainId, observation.verifyingContract);
    return Boolean(
      checkpoint &&
      checkpoint.blockNumber === observation.blockNumber &&
      checkpoint.blockHash.toLowerCase() === observation.blockHash.toLowerCase(),
    );
  }

  advanceChainCheckpoint(
    checkpoint: ChainCheckpoint,
    nowMs: number,
    expectedHead?: ChainCheckpoint,
  ): 'initialized' | 'advanced' | 'unchanged' | 'reorg' {
    const contract = checkpoint.verifyingContract.toLowerCase();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare(
          `
        SELECT block_number, block_hash, healthy FROM chain_checkpoints WHERE chain_id = ? AND verifying_contract = ?
      `,
        )
        .get(checkpoint.chainId, contract) as
        { block_number: number; block_hash: string; healthy: number } | undefined;
      if (!existing) {
        this.db
          .prepare(`INSERT INTO chain_checkpoints VALUES (?, ?, ?, ?, ?, 1, ?)`)
          .run(
            checkpoint.chainId,
            contract,
            checkpoint.blockNumber,
            checkpoint.blockHash,
            checkpoint.parentHash,
            nowMs,
          );
        this.db.exec('COMMIT');
        return 'initialized';
      }
      if (existing.healthy === 0) {
        this.db.exec('ROLLBACK');
        return 'reorg';
      }
      if (
        checkpoint.blockNumber === existing.block_number &&
        checkpoint.blockHash === existing.block_hash
      ) {
        this.db.exec('COMMIT');
        return 'unchanged';
      }
      if (expectedHead) {
        if (
          existing.healthy === 0 ||
          expectedHead.chainId !== checkpoint.chainId ||
          expectedHead.verifyingContract.toLowerCase() !== contract ||
          existing.block_number !== expectedHead.blockNumber ||
          existing.block_hash.toLowerCase() !== expectedHead.blockHash.toLowerCase() ||
          checkpoint.blockNumber < expectedHead.blockNumber
        ) {
          this.db.exec('ROLLBACK');
          return 'reorg';
        }
        if (checkpoint.blockNumber === existing.block_number) {
          this.db
            .prepare(
              `UPDATE chain_checkpoints SET healthy = 0, updated_at_ms = ? WHERE chain_id = ? AND verifying_contract = ? AND healthy = 1 AND block_number = ? AND lower(block_hash) = lower(?)`,
            )
            .run(
              nowMs,
              checkpoint.chainId,
              contract,
              expectedHead.blockNumber,
              expectedHead.blockHash,
            );
          this.db.exec('COMMIT');
          return 'reorg';
        }
        const result = this.db
          .prepare(
            `UPDATE chain_checkpoints SET block_number = ?, block_hash = ?, parent_hash = ?, updated_at_ms = ? WHERE chain_id = ? AND verifying_contract = ? AND healthy = 1 AND block_number = ? AND lower(block_hash) = lower(?)`,
          )
          .run(
            checkpoint.blockNumber,
            checkpoint.blockHash,
            checkpoint.parentHash,
            nowMs,
            checkpoint.chainId,
            contract,
            expectedHead.blockNumber,
            expectedHead.blockHash,
          );
        this.db.exec('COMMIT');
        return Number(result.changes) === 1 ? 'advanced' : 'reorg';
      }
      if (
        checkpoint.blockNumber !== existing.block_number + 1 ||
        checkpoint.parentHash !== existing.block_hash
      ) {
        this.db
          .prepare(
            `UPDATE chain_checkpoints SET healthy = 0, updated_at_ms = ? WHERE chain_id = ? AND verifying_contract = ?`,
          )
          .run(nowMs, checkpoint.chainId, contract);
        this.db.exec('COMMIT');
        return 'reorg';
      }
      this.db
        .prepare(
          `UPDATE chain_checkpoints SET block_number = ?, block_hash = ?, parent_hash = ?, updated_at_ms = ? WHERE chain_id = ? AND verifying_contract = ?`,
        )
        .run(
          checkpoint.blockNumber,
          checkpoint.blockHash,
          checkpoint.parentHash,
          nowMs,
          checkpoint.chainId,
          contract,
        );
      this.db.exec('COMMIT');
      return 'advanced';
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reconcileChainCheckpoint(checkpoint: ChainCheckpoint, nowMs: number): void {
    this.db
      .prepare(
        `
      INSERT INTO chain_checkpoints(chain_id, verifying_contract, block_number, block_hash, parent_hash, healthy, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(chain_id, verifying_contract) DO UPDATE SET
        block_number = excluded.block_number, block_hash = excluded.block_hash,
        parent_hash = excluded.parent_hash, healthy = 1, updated_at_ms = excluded.updated_at_ms
    `,
      )
      .run(
        checkpoint.chainId,
        checkpoint.verifyingContract.toLowerCase(),
        checkpoint.blockNumber,
        checkpoint.blockHash,
        checkpoint.parentHash,
        nowMs,
      );
  }

  getChainCheckpoint(chainId: string, verifyingContract: string): ChainCheckpoint | null {
    const row = this.db
      .prepare(
        `
      SELECT chain_id, verifying_contract, block_number, block_hash, parent_hash
      FROM chain_checkpoints WHERE chain_id = ? AND verifying_contract = ? AND healthy = 1
    `,
      )
      .get(chainId, verifyingContract.toLowerCase()) as Record<string, string | number> | undefined;
    return row
      ? {
          chainId: String(row.chain_id),
          verifyingContract: String(row.verifying_contract),
          blockNumber: Number(row.block_number),
          blockHash: String(row.block_hash),
          parentHash: String(row.parent_hash),
        }
      : null;
  }
}
