// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { AcceptedCommandEvent } from '../localVerifier';
import { SqliteVerifierStore } from './sqliteVerifierStore';

const directories: string[] = [];
function openStore() {
  const directory = mkdtempSync(join(tmpdir(), 'worldseed-verifier-'));
  directories.push(directory);
  return { directory, store: new SqliteVerifierStore(join(directory, 'verifier.sqlite')) };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const event: AcceptedCommandEvent = {
  commandId: 'cmd-1',
  expectedSequence: 0,
  sequence: 1,
  command: { type: 'heart-click' },
  serverTimeMs: 10,
  stateAfter: '{"sequence":1}',
  creditedAtoms: '100',
  spentAtoms: '0',
};

describe('SQLite verifier persistence', () => {
  it('migrates a prior version-1 attestation table without losing nonce rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'worldseed-verifier-migration-'));
    directories.push(directory);
    const path = join(directory, 'verifier.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE verifier_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL);
      INSERT INTO verifier_schema VALUES (1, 1);
      CREATE TABLE verifier_runs (
        run_key TEXT PRIMARY KEY, initial_state TEXT NOT NULL,
        head_sequence INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO verifier_runs VALUES ('legacy-run', '{"sequence":0}', 0, 0);
      CREATE TABLE attestation_slots (
        chain_id TEXT NOT NULL, verifying_contract TEXT NOT NULL, player TEXT NOT NULL, nonce TEXT NOT NULL,
        payload_digest TEXT NOT NULL, payload_json TEXT NOT NULL, run_id TEXT NOT NULL, action_type TEXT NOT NULL,
        issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY (chain_id, verifying_contract, player, nonce)
      );
      INSERT INTO attestation_slots VALUES ('1', 'contract', 'player', '5', 'digest', '{}', '4', 'REBIRTH', 1, 10, 'pending');
    `);
    legacy.close();
    const migrated = new SqliteVerifierStore(path);
    try {
      const migrationCheckpoint = {
        chainId: '1',
        verifyingContract: 'contract',
        blockNumber: 4,
        blockHash: `0x${'04'.padStart(64, '0')}`,
        parentHash: `0x${'03'.padStart(64, '0')}`,
      };
      migrated.advanceChainCheckpoint(migrationCheckpoint, 1);
      expect(
        migrated.reserveAttestation(
          {
            chainId: '1',
            verifyingContract: 'contract',
            player: 'player',
            nonce: '5',
            payloadDigest: 'digest',
            payloadJson: '{}',
            runId: '4',
            actionType: 'REBIRTH',
            signerEpoch: 0,
            issuedAt: 2,
            expiresAt: 20,
          },
          2,
          {
            ...migrationCheckpoint,
            confirmations: 1,
            timestampSeconds: '5',
            nonce: '5',
            signerEpoch: 0,
          },
        ),
      ).toBe('same-payload');
      migrated.initializeRunStartedEventScan(
        {
          chainId: '1',
          verifyingContract: 'contract',
          player: 'player',
          runId: '4',
          seasonId: '1',
        },
        100,
        3,
      );
    } finally {
      migrated.close();
    }
    const check = new DatabaseSync(path);
    try {
      const version = check.prepare('SELECT version FROM verifier_schema').get() as {
        version: number;
      };
      const tableExists = (table: string) =>
        Boolean(
          check
            .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table),
        );
      const attestationColumns = check
        .prepare('PRAGMA table_info(attestation_slots)')
        .all() as Array<{
        name: string;
      }>;
      expect(version.version).toBe(5);
      expect(attestationColumns.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['signature', 'signer_epoch']),
      );
      expect(tableExists('verifier_snapshots')).toBe(true);
      expect(tableExists('run_started_event_scans')).toBe(true);
      expect(
        check
          .prepare('SELECT state FROM verifier_snapshots WHERE run_key = ? AND sequence = 0')
          .get('legacy-run'),
      ).toEqual({ state: '{"sequence":0}' });
      expect(
        check
          .prepare(
            'SELECT next_block, scanned_through FROM run_started_event_scans WHERE run_id = ?',
          )
          .get('4'),
      ).toEqual({ next_block: 100, scanned_through: 99 });
    } finally {
      check.close();
    }
  });

  it('atomically appends one ordered command under concurrent duplicate submissions and survives restart', async () => {
    const first = openStore();
    await first.store.initializeIfAbsent('run-key', '{}');
    const outcomes = await Promise.all([
      first.store.appendIfCurrentSequence('run-key', 0, event),
      first.store.appendIfCurrentSequence('run-key', 0, event),
    ]);
    expect(outcomes.sort()).toEqual(['appended', 'conflict']);
    expect((await first.store.read('run-key'))?.headSequence).toBe(1);
    first.store.close();

    const reopened = new SqliteVerifierStore(join(first.directory, 'verifier.sqlite'));
    expect(await reopened.read('run-key')).toMatchObject({
      headSequence: 1,
      events: [{ commandId: 'cmd-1' }],
    });
    reopened.close();
  });

  it('atomically consumes a one-time challenge with session insertion', () => {
    const { store } = openStore();
    const challenge = {
      challengeId: 'challenge',
      nonce: 'nonce',
      wallet: '0x0000000000000000000000000000000000000001',
      chainId: '1',
      verifyingContract: '0x0000000000000000000000000000000000000002',
      origin: 'https://example.test',
      runId: '4',
      message: 'signed challenge',
      createdAtMs: 1,
      expiresAtMs: 100,
    };
    store.createChallenge(challenge);
    const session = {
      tokenHash: 'hashed-token',
      sessionId: 'session',
      wallet: challenge.wallet,
      chainId: challenge.chainId,
      verifyingContract: challenge.verifyingContract,
      origin: challenge.origin,
      runId: challenge.runId,
      createdAtMs: 10,
      expiresAtMs: 90,
    };
    const results = [
      store.consumeChallengeAndCreateSession('challenge', 'nonce', 10, session),
      store.consumeChallengeAndCreateSession('challenge', 'nonce', 10, {
        ...session,
        tokenHash: 'other-hash',
        sessionId: 'other',
      }),
    ];
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(store.getSession('hashed-token', 11)?.sessionId).toBe('session');
    expect(store.getSession('other-hash', 11)).toBeNull();
    store.close();
  });

  it('reserves one attestation per nonce, requires chain-confirmed availability, and settles only with proof', async () => {
    const { store } = openStore();
    const reservation = {
      chainId: '1',
      verifyingContract: '0x0000000000000000000000000000000000000002',
      player: '0x0000000000000000000000000000000000000001',
      nonce: '9',
      payloadDigest: 'digest-a',
      payloadJson: '{}',
      runId: '4',
      actionType: 'REBIRTH',
      signerEpoch: 2,
      issuedAt: 1,
      expiresAt: 100,
    };
    const observation = {
      chainId: '1',
      verifyingContract: reservation.verifyingContract,
      blockNumber: 77,
      blockHash: `0x${'77'.padStart(64, '0')}`,
      confirmations: 2,
      timestampSeconds: '77',
      nonce: '9',
      signerEpoch: 2,
    };
    expect(
      store.advanceChainCheckpoint(
        { ...observation, parentHash: `0x${'76'.padStart(64, '0')}` },
        1,
      ),
    ).toBe('initialized');
    expect(store.reserveAttestation(reservation, 1, { ...observation, nonce: '8' })).toBe(
      'conflict',
    );
    expect(
      store.reserveAttestation(reservation, 1, {
        ...observation,
        blockHash: `0x${'78'.padStart(64, '0')}`,
      }),
    ).toBe('conflict');
    expect(store.reserveAttestation(reservation, 1, observation)).toBe('reserved');
    expect(store.reserveAttestation(reservation, 2, observation)).toBe('same-payload');
    expect(
      store.reserveAttestation({ ...reservation, payloadDigest: 'digest-b' }, 2, observation),
    ).toBe('conflict');
    const signatures = await Promise.all([
      Promise.resolve(
        store.commitAttestationSignature(
          '1',
          reservation.verifyingContract,
          reservation.player,
          '9',
          'digest-a',
          'sig-a',
          observation,
        ),
      ),
      Promise.resolve(
        store.commitAttestationSignature(
          '1',
          reservation.verifyingContract,
          reservation.player,
          '9',
          'digest-a',
          'sig-b',
          observation,
        ),
      ),
    ]);
    expect(signatures.filter((result) => result.status === 'stored')).toHaveLength(1);
    expect(signatures.filter((result) => result.status === 'existing')).toHaveLength(1);
    const winner = store.getAttestationSignature(
      '1',
      reservation.verifyingContract,
      reservation.player,
      '9',
      'digest-a',
      2,
    );
    expect(winner).toMatch(/^sig-/);
    expect(new Set(signatures.map((result) => result.signature)).size).toBe(1);
    expect(
      store.settleAttestation(
        '1',
        reservation.verifyingContract,
        reservation.player,
        '9',
        'digest-a',
        'consumed',
        observation,
        2,
      ),
    ).toBe(false);
    const consumedObservation = { ...observation, nonce: '10' };
    expect(
      store.settleAttestation(
        '1',
        reservation.verifyingContract,
        reservation.player,
        '9',
        'digest-a',
        'consumed',
        consumedObservation,
        2,
      ),
    ).toBe(true);
    expect(store.reserveAttestation(reservation, 200, consumedObservation)).toBe('conflict');
    const cancellable = { ...reservation, nonce: '10', payloadDigest: 'digest-c', expiresAt: 100 };
    expect(store.reserveAttestation(cancellable, 1, consumedObservation)).toBe('reserved');
    expect(
      store.settleAttestation(
        '1',
        reservation.verifyingContract,
        reservation.player,
        '10',
        'digest-c',
        'cancelled',
        consumedObservation,
        99,
      ),
    ).toBe(false);
    expect(
      store.settleAttestation(
        '1',
        reservation.verifyingContract,
        reservation.player,
        '10',
        'digest-c',
        'cancelled',
        consumedObservation,
        100,
      ),
    ).toBe(true);
    expect(store.reserveAttestation(cancellable, 100, consumedObservation)).toBe('reserved');
    store.close();
  });

  it('marks a checkpoint unhealthy on a gap/reorg and requires explicit reconciliation', () => {
    const { store } = openStore();
    const base = { chainId: '1', verifyingContract: '0x0000000000000000000000000000000000000002' };
    expect(
      store.advanceChainCheckpoint(
        { ...base, blockNumber: 10, blockHash: '0x10', parentHash: '0x09' },
        1,
      ),
    ).toBe('initialized');
    expect(
      store.advanceChainCheckpoint(
        { ...base, blockNumber: 11, blockHash: '0x11', parentHash: '0x10' },
        2,
      ),
    ).toBe('advanced');
    expect(
      store.advanceChainCheckpoint(
        { ...base, blockNumber: 12, blockHash: '0x12b', parentHash: '0x11b' },
        3,
      ),
    ).toBe('reorg');
    expect(store.getChainCheckpoint('1', base.verifyingContract)).toBeNull();
    expect(
      store.advanceChainCheckpoint(
        { ...base, blockNumber: 12, blockHash: '0x12', parentHash: '0x11' },
        4,
      ),
    ).toBe('reorg');
    store.reconcileChainCheckpoint(
      { ...base, blockNumber: 11, blockHash: '0x11', parentHash: '0x10' },
      5,
    );
    expect(
      store.advanceChainCheckpoint(
        { ...base, blockNumber: 12, blockHash: '0x12', parentHash: '0x11' },
        6,
      ),
    ).toBe('advanced');
    store.close();
  });

  it('advances to a confirmed head after verifying the expected checkpoint', () => {
    const { store } = openStore();
    const previous = {
      chainId: '1',
      verifyingContract: '0x0000000000000000000000000000000000000002',
      blockNumber: 10,
      blockHash: '0x10',
      parentHash: '0x09',
    };
    expect(store.advanceChainCheckpoint(previous, 1)).toBe('initialized');
    const head = {
      ...previous,
      blockNumber: 50_000,
      blockHash: '0x50',
      parentHash: '0x49',
    };
    expect(store.advanceChainCheckpoint(head, 2, previous)).toBe('advanced');
    expect(store.getChainCheckpoint('1', previous.verifyingContract)).toEqual(head);
    expect(store.advanceChainCheckpoint({ ...head, blockNumber: 49_999 }, 3, previous)).toBe(
      'reorg',
    );
    expect(store.getChainCheckpoint('1', previous.verifyingContract)).toEqual(head);
    store.close();
  });

  it('invalidates pending signatures immediately when the confirmed signer epoch advances', () => {
    const { store } = openStore();
    const base = {
      chainId: '1',
      verifyingContract: '0x0000000000000000000000000000000000000002',
      blockNumber: 30,
      blockHash: `0x${'30'.padStart(64, '0')}`,
      parentHash: `0x${'29'.padStart(64, '0')}`,
      timestampSeconds: '30',
    };
    store.advanceChainCheckpoint(base, 1);
    const oldObservation = { ...base, confirmations: 2, nonce: '11', signerEpoch: 4 };
    const oldReservation = {
      chainId: '1',
      verifyingContract: base.verifyingContract,
      player: '0x0000000000000000000000000000000000000001',
      nonce: '11',
      payloadDigest: 'old-digest',
      payloadJson: '{}',
      runId: '3',
      actionType: 'REBIRTH',
      signerEpoch: 4,
      issuedAt: 10,
      expiresAt: 100,
    };
    expect(store.reserveAttestation(oldReservation, 10, oldObservation)).toBe('reserved');
    expect(
      store.commitAttestationSignature(
        '1',
        base.verifyingContract,
        oldReservation.player,
        '11',
        'old-digest',
        'old-sig',
        oldObservation,
      ).status,
    ).toBe('stored');

    const nextBlock = {
      ...base,
      blockNumber: 31,
      blockHash: `0x${'31'.padStart(64, '0')}`,
      parentHash: base.blockHash,
    };
    store.advanceChainCheckpoint(nextBlock, 2);
    const rotatedObservation = { ...nextBlock, confirmations: 2, nonce: '11', signerEpoch: 5 };
    const rotatedReservation = { ...oldReservation, payloadDigest: 'new-digest', signerEpoch: 5 };
    expect(store.reserveAttestation(rotatedReservation, 11, rotatedObservation)).toBe('reserved');
    expect(
      store.getAttestationSignature(
        '1',
        base.verifyingContract,
        oldReservation.player,
        '11',
        'old-digest',
        4,
      ),
    ).toBeNull();
    expect(
      store.commitAttestationSignature(
        '1',
        base.verifyingContract,
        oldReservation.player,
        '11',
        'old-digest',
        'stale-sig',
        oldObservation,
      ).status,
    ).toBe('conflict');
    expect(
      store.commitAttestationSignature(
        '1',
        base.verifyingContract,
        oldReservation.player,
        '11',
        'new-digest',
        'new-sig',
        rotatedObservation,
      ).status,
    ).toBe('stored');
    store.close();
  });
});
