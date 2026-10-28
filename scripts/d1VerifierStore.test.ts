import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { LocalVerifier } from '../src/incremental/localVerifier';
import { seasonIdAtMilliseconds } from '../src/incremental/rulesV1';
import { V3AttestationIssuer } from '../src/incremental/server/attestationIssuer';
import { buildScoreAttestationTypedData } from '../src/incremental/server/attestations';
import {
  D1VerifierStore,
  type D1DatabaseLike,
  type D1PreparedStatement,
  type D1Result,
} from '../src/incremental/server/d1VerifierStore';
import type {
  ChainCheckpoint,
  ConfirmedNonceObservation,
} from '../src/incremental/server/verifierStoreTypes';
import { WorkersWalletSessions } from '../src/incremental/server/workersWalletSessions';
import { createWorkerVerifierHandler } from '../src/incremental/worker/httpHandler';
import workerEntrypoint from '../src/incremental/worker/index';

const TEST_KEY = `0x${'11'.repeat(32)}` as const;
const TEST_CHAIN_ID = 31_337n;
const TEST_CONTRACT = '0x2222222222222222222222222222222222222222';
const TEST_ORIGIN = 'https://worldseed.example';
const NOW = 1_798_000_000_000;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const PARENT_HASH = `0x${'cd'.repeat(32)}`;

class SqliteD1TestDouble implements D1DatabaseLike {
  private readonly database = new DatabaseSync(':memory:');

  prepare(query: string): D1PreparedStatement {
    let values: unknown[] = [];
    const statement = this.database.prepare(query);
    const adapter: D1PreparedStatement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return adapter;
      },
      first: async <T>() => (statement.get(...(values as never[])) as T | undefined) ?? null,
      all: async <T>() => ({
        success: true,
        results: statement.all(...(values as never[])) as T[],
        meta: { changes: 0 },
      }),
      run: async <T>() => {
        const result = statement.run(...(values as never[]));
        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes) },
        } as D1Result<T>;
      },
    };
    return adapter;
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  close(): void {
    this.database.close();
  }
}

describe('Workers D1 verifier persistence adapter', () => {
  let database: SqliteD1TestDouble;
  let store: D1VerifierStore;
  let now: number;
  const account = privateKeyToAccount(TEST_KEY);

  before(async () => {
    database = new SqliteD1TestDouble();
    for (const name of [
      '0001_v3_verifier.sql',
      '0002_verifier_journal_snapshots.sql',
      '0003_run_started_event_scans.sql',
    ]) {
      const migration = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      for (const statement of migration
        .split(/;\s*\r?\n\s*\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean))
        await database.prepare(statement).run();
    }
    store = new D1VerifierStore(database);
    now = NOW;
  });

  after(() => database?.close());

  it('rejects non-HTTPS public origins without returning configuration or secret values', async () => {
    const response = await workerEntrypoint.fetch(new Request('https://worldseed.example/health'), {
      WORLDSEED_DB: {} as never,
      ASSETS: { fetch: async () => new Response('asset') },
      V3_CHAIN_ID: String(TEST_CHAIN_ID),
      V3_RPC_URL: 'https://rpc.example',
      V3_CONTRACT_ADDRESS: TEST_CONTRACT,
      V3_DEPLOYMENT_BLOCK: '1',
      V3_CONFIRMATIONS: '2',
      V3_ALLOWED_ORIGINS: 'http://worldseed.example',
      V3_ATTESTER_PRIVATE_KEY: TEST_KEY,
    });
    assert.equal(response.status, 503);
    const responseText = await response.text();
    assert.equal(responseText.includes(TEST_KEY), false);
    assert.match(responseText, /VERIFIER_UNAVAILABLE/);
  });

  it('authenticates a wallet and consumes a signed challenge once', async () => {
    const sessions = new WorkersWalletSessions(
      store,
      { isValidSignature: async () => false },
      new Map([[String(TEST_CHAIN_ID), TEST_CONTRACT]]),
      new Set([TEST_ORIGIN]),
      () => now,
    );
    const challenge = await sessions.issueChallenge({
      wallet: account.address,
      chainId: String(TEST_CHAIN_ID),
      verifyingContract: TEST_CONTRACT,
      origin: TEST_ORIGIN,
      runId: '1',
    });
    await assert.rejects(
      sessions.completeChallenge(challenge.challengeId, `0x${'00'.repeat(65)}` as `0x${string}`),
    );
    const signature = await account.signMessage({ message: challenge.message });
    const response = await sessions.completeChallenge(challenge.challengeId, signature);
    assert.deepEqual(await sessions.authenticate(response.sessionToken), {
      wallet: account.address,
      chainId: TEST_CHAIN_ID,
      verifyingContract: TEST_CONTRACT,
      sessionId: (await sessions.authenticate(response.sessionToken))!.sessionId,
      runId: '1',
      origin: TEST_ORIGIN,
    });
    await assert.rejects(sessions.completeChallenge(challenge.challengeId, signature));
    assert.equal(await store.getSession(response.sessionToken, now), null);
  });

  it('serializes concurrent commands, makes retries idempotent, and recovers state', async () => {
    const sessions = new WorkersWalletSessions(
      store,
      { isValidSignature: async () => false },
      new Map([[String(TEST_CHAIN_ID), TEST_CONTRACT]]),
      new Set([TEST_ORIGIN]),
      () => now,
    );
    const challenge = await sessions.issueChallenge({
      wallet: account.address,
      chainId: String(TEST_CHAIN_ID),
      verifyingContract: TEST_CONTRACT,
      origin: TEST_ORIGIN,
      runId: '3',
    });
    const signature = await account.signMessage({ message: challenge.message });
    const { sessionToken } = await sessions.completeChallenge(challenge.challengeId, signature);
    const seasonId = seasonIdAtMilliseconds(now);
    const authority = {
      getRunContext: async () => ({
        player: account.address,
        chainId: TEST_CHAIN_ID,
        verifyingContract: TEST_CONTRACT,
        active: true,
        currentSeasonId: seasonId,
        input: {
          runId: '3',
          seasonId,
          startedAtMs: now,
          seasonalPP: 0n,
          existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
          seasonRebirths: 0,
          upgradeChoices: [],
        },
      }),
    };
    const verifier = new LocalVerifier(sessions, authority, store, { nowMilliseconds: () => now });
    await verifier.recover(sessionToken, '3');
    const request = {
      sessionToken,
      runId: '3',
      commandId: 'click-1',
      expectedSequence: 0,
      command: { type: 'heart-click' as const },
    };
    const receipts = await Promise.all([verifier.submit(request), verifier.submit(request)]);
    assert.deepEqual(
      receipts.map((receipt) => receipt.cursor.sequence),
      [1, 1],
    );
    const runKey = `31337:${TEST_CONTRACT}:${account.address.toLowerCase()}:3`;
    assert.equal((await store.read(runKey))?.events.length, 1);
    await assert.rejects(verifier.submit({ ...request, commandId: 'gap', expectedSequence: 3 }), {
      code: 'SEQUENCE_GAP',
      expectedSequence: 1,
    });
    const competitors = await Promise.allSettled([
      verifier.submit({
        ...request,
        commandId: 'contender-a',
        expectedSequence: 1,
        command: { type: 'sync' },
      }),
      verifier.submit({
        ...request,
        commandId: 'contender-b',
        expectedSequence: 1,
        command: { type: 'sync' },
      }),
    ]);
    assert.equal(competitors.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((await store.read(runKey))?.headSequence, 2);
    const restartedVerifier = new LocalVerifier(sessions, authority, store, {
      nowMilliseconds: () => now,
    });
    assert.equal((await restartedVerifier.recover(sessionToken, '3')).cursor.sequence, 2);
  });

  it('validates, applies, persists, and retries gameplay commands through the authenticated Worker route', async () => {
    const player = privateKeyToAccount(`0x${'55'.repeat(32)}`);
    const sessions = new WorkersWalletSessions(
      store,
      { isValidSignature: async () => false },
      new Map([[String(TEST_CHAIN_ID), TEST_CONTRACT]]),
      new Set([TEST_ORIGIN]),
      () => now,
    );
    const challenge = await sessions.issueChallenge({
      wallet: player.address,
      chainId: String(TEST_CHAIN_ID),
      verifyingContract: TEST_CONTRACT,
      origin: TEST_ORIGIN,
      runId: '77',
    });
    const signature = await player.signMessage({ message: challenge.message });
    const { sessionToken } = await sessions.completeChallenge(challenge.challengeId, signature);
    const seasonId = seasonIdAtMilliseconds(now);
    const verifier = new LocalVerifier(
      sessions,
      {
        getRunContext: async (session, runId) =>
          runId === '77'
            ? {
                player: session.wallet,
                chainId: TEST_CHAIN_ID,
                verifyingContract: TEST_CONTRACT,
                active: true,
                currentSeasonId: seasonId,
                input: {
                  runId: '77',
                  seasonId,
                  startedAtMs: now,
                  seasonalPP: 0n,
                  existingUpgrades: {
                    growth: 0,
                    efficiency: 0,
                    awakening: 60,
                    rebirth: 0,
                  },
                  seasonRebirths: 0,
                  upgradeChoices: [],
                },
              }
            : null,
      },
      store,
      { nowMilliseconds: () => now },
    );
    const handler = createWorkerVerifierHandler({
      allowedOrigins: new Set([TEST_ORIGIN]),
      store,
      sessions,
      verifier,
      chain: {} as never,
      issuer: {} as never,
    });
    const send = (body: Record<string, unknown>) =>
      handler(
        new Request('https://worldseed.example/api/v3/runs/77/commands', {
          method: 'POST',
          headers: {
            origin: TEST_ORIGIN,
            authorization: `Bearer ${sessionToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      );

    const firstRequest = {
      commandId: 'player-77-command-1',
      expectedSequence: 0,
      command: { type: 'heart-click' },
      natureAtoms: '999999999999999999999999999999999999',
      earnedNatureAtoms: '999999999999999999999999999999999999',
      creditedAtoms: '999999999999999999999999999999999999',
    };
    const firstResponse = await send(firstRequest);
    const first = (await firstResponse.json()) as Record<string, unknown>;
    assert.equal(firstResponse.status, 200, JSON.stringify(first));
    assert.equal(first.accepted, true);
    assert.equal(first.commandId, firstRequest.commandId);
    assert.equal((first.cursor as { sequence: number }).sequence, 1);
    assert.equal(first.creditedAtoms, '1000000000000');
    const canonicalAfterClick = JSON.parse(first.canonicalState as string) as {
      natureAtoms: string;
      earnedNatureAtoms: string;
    };
    assert.equal(canonicalAfterClick.natureAtoms, '301000000000000');
    assert.equal(canonicalAfterClick.earnedNatureAtoms, '1000000000000');

    const retryResponse = await send(firstRequest);
    assert.deepEqual(await retryResponse.json(), first);

    const reusedIdResponse = await send({
      ...firstRequest,
      command: { type: 'sync' },
    });
    assert.equal(reusedIdResponse.status, 409);
    assert.equal(((await reusedIdResponse.json()) as { code: string }).code, 'COMMAND_ID_CONFLICT');

    const habitatResponse = await send({
      commandId: 'player-77-command-2',
      expectedSequence: 1,
      command: { type: 'buy-habitat', habitat: 'water', quantity: 2 },
    });
    const habitat = (await habitatResponse.json()) as Record<string, unknown>;
    assert.equal(habitatResponse.status, 200, JSON.stringify(habitat));
    assert.equal(habitat.spentAtoms, '21500000000000');
    assert.equal(
      (JSON.parse(habitat.canonicalState as string) as { habitats: { water: number } }).habitats
        .water,
      2,
    );

    const upgradeResponse = await send({
      commandId: 'player-77-command-3',
      expectedSequence: 2,
      command: { type: 'buy-temporary-upgrade', upgrade: 'sunny-season' },
    });
    const upgrade = (await upgradeResponse.json()) as Record<string, unknown>;
    assert.equal(upgradeResponse.status, 200, JSON.stringify(upgrade));
    assert.equal(upgrade.spentAtoms, '150000000000000');
    assert.equal(
      (
        JSON.parse(upgrade.canonicalState as string) as {
          temporaryMs: { 'sunny-season': number };
        }
      ).temporaryMs['sunny-season'],
      60_000,
    );

    const runKey = `31337:${TEST_CONTRACT}:${player.address.toLowerCase()}:77`;
    const journal = await store.read(runKey);
    assert.equal(journal?.headSequence, 3);
    assert.deepEqual(
      journal?.events.map((event) => event.commandId),
      [firstRequest.commandId, 'player-77-command-2', 'player-77-command-3'],
    );

    const rejectedPurchase = await send({
      commandId: 'player-77-too-expensive',
      expectedSequence: 3,
      command: { type: 'buy-habitat', habitat: 'forest', quantity: 2 },
    });
    assert.equal(rejectedPurchase.status, 409);
    assert.equal(((await rejectedPurchase.json()) as { code: string }).code, 'RULES_REJECTED');
    assert.equal((await store.read(runKey))?.headSequence, 3);

    const malformedEnvelope = await send({
      commandId: '',
      expectedSequence: -1,
      command: { type: 'sync' },
    });
    assert.equal(malformedEnvelope.status, 400);
    assert.equal((await store.read(runKey))?.headSequence, 3);
  });

  it('bounds replay reads with periodic snapshots while retaining indexed old-command retries', async () => {
    const runKey = 'snapshot-test-run';
    await store.initializeIfAbsent(runKey, '{"sequence":0}');
    for (let sequence = 1; sequence <= 260; sequence += 1) {
      const event = {
        commandId: `snapshot-command-${sequence}`,
        expectedSequence: sequence - 1,
        sequence,
        command: { type: 'sync' as const },
        serverTimeMs: now + sequence,
        stateAfter: JSON.stringify({ sequence }),
        creditedAtoms: '0',
        spentAtoms: '0',
      };
      assert.equal(await store.appendIfCurrentSequence(runKey, sequence - 1, event), 'appended');
    }
    const journal = await store.read(runKey);
    assert.equal(journal?.headSequence, 260);
    assert.equal(journal?.snapshotSequence, 256);
    assert.equal(journal?.events.length, 4);
    assert.equal((await store.findCommand(runKey, 'snapshot-command-1'))?.sequence, 1);
  });

  it('persists RunStarted scan pages atomically and rejects a stale cursor writer', async () => {
    const key = {
      chainId: String(TEST_CHAIN_ID),
      verifyingContract: TEST_CONTRACT,
      player: account.address,
      runId: '700',
      seasonId: '0',
    };
    const initialized = await store.initializeRunStartedEventScan(key, 10, now);
    assert.equal(initialized.nextBlock, 10);
    assert.equal(
      await store.advanceRunStartedEventScan(key, 10, {
        nextBlock: 110,
        scannedThrough: 109,
        scannedBlockHash: BLOCK_HASH,
        eventJson: null,
        eventBlockNumber: null,
        eventBlockHash: null,
        updatedAtMs: now + 1,
      }),
      'advanced',
    );
    assert.equal((await store.getRunStartedEventScan(key))?.nextBlock, 110);
    assert.equal(
      await store.advanceRunStartedEventScan(key, 10, {
        nextBlock: 110,
        scannedThrough: 109,
        scannedBlockHash: BLOCK_HASH,
        eventJson: null,
        eventBlockNumber: null,
        eventBlockHash: null,
        updatedAtMs: now + 2,
      }),
      'conflict',
    );
  });

  it('reserves one attestation per nonce and returns the concurrent winning signature', async () => {
    const checkpoint: ChainCheckpoint = {
      chainId: String(TEST_CHAIN_ID),
      verifyingContract: TEST_CONTRACT,
      blockNumber: 8,
      blockHash: BLOCK_HASH,
      parentHash: PARENT_HASH,
    };
    await store.reconcileChainCheckpoint(checkpoint, now);
    const observation: ConfirmedNonceObservation = {
      ...checkpoint,
      confirmations: 2,
      timestampSeconds: String(Math.floor(now / 1_000)),
      nonce: '0',
      signerEpoch: 1,
    };
    const reservation = {
      chainId: String(TEST_CHAIN_ID),
      verifyingContract: TEST_CONTRACT,
      player: account.address,
      nonce: '0',
      payloadDigest: `0x${'22'.repeat(32)}`,
      payloadJson: '{}',
      runId: '1',
      actionType: 'START_RUN',
      signerEpoch: 1,
      issuedAt: Math.floor(now / 1_000),
      expiresAt: Math.floor(now / 1_000) + 300,
    };
    const reservations = await Promise.all([
      store.reserveAttestation(reservation, Math.floor(now / 1_000), observation),
      store.reserveAttestation(reservation, Math.floor(now / 1_000), observation),
    ]);
    assert.deepEqual(reservations.sort(), ['reserved', 'same-payload']);
    const commits = await Promise.all([
      store.commitAttestationSignature(
        reservation.chainId,
        reservation.verifyingContract,
        reservation.player,
        reservation.nonce,
        reservation.payloadDigest,
        `0x${'33'.repeat(65)}`,
        observation,
      ),
      store.commitAttestationSignature(
        reservation.chainId,
        reservation.verifyingContract,
        reservation.player,
        reservation.nonce,
        reservation.payloadDigest,
        `0x${'44'.repeat(65)}`,
        observation,
      ),
    ]);
    assert.deepEqual(commits.map((entry) => entry.status).sort(), ['existing', 'stored']);
    const winner = await store.getAttestationSignature(
      reservation.chainId,
      reservation.verifyingContract,
      reservation.player,
      reservation.nonce,
      reservation.payloadDigest,
      1,
    );
    assert.ok(commits.every((entry) => entry.signature === winner));
    assert.equal(
      await store.reserveAttestation(
        { ...reservation, payloadDigest: `0x${'55'.repeat(32)}` },
        Math.floor(now / 1_000),
        observation,
      ),
      'conflict',
    );
  });

  it('advances a confirmed checkpoint across downtime with a compare-and-swap', async () => {
    const previous: ChainCheckpoint = {
      chainId: String(TEST_CHAIN_ID),
      verifyingContract: TEST_CONTRACT,
      blockNumber: 12,
      blockHash: `0x${'12'.repeat(32)}`,
      parentHash: `0x${'11'.repeat(32)}`,
    };
    await store.reconcileChainCheckpoint(previous, now);
    const confirmedHead: ChainCheckpoint = {
      ...previous,
      blockNumber: 10_000,
      blockHash: `0x${'aa'.repeat(32)}`,
      parentHash: `0x${'bb'.repeat(32)}`,
    };
    assert.equal(await store.advanceChainCheckpoint(confirmedHead, now + 1, previous), 'advanced');
    assert.deepEqual(
      await store.getChainCheckpoint(String(TEST_CHAIN_ID), TEST_CONTRACT),
      confirmedHead,
    );
    // A competing request with a stale expected head cannot roll the checkpoint backward.
    assert.equal(
      await store.advanceChainCheckpoint(
        { ...confirmedHead, blockNumber: 9_999, blockHash: `0x${'99'.repeat(32)}` },
        now + 2,
        previous,
      ),
      'reorg',
    );
    assert.deepEqual(
      await store.getChainCheckpoint(String(TEST_CHAIN_ID), TEST_CONTRACT),
      confirmedHead,
    );
  });

  it('issues a valid Rebirth attestation through the HTTP handler after canonical command replay', async () => {
    const attester = privateKeyToAccount(`0x${'33'.repeat(32)}`);
    const player = privateKeyToAccount(`0x${'44'.repeat(32)}`);
    const checkpoint: ChainCheckpoint = {
      chainId: String(TEST_CHAIN_ID),
      verifyingContract: TEST_CONTRACT,
      blockNumber: 9,
      blockHash: `0x${'ef'.repeat(32)}`,
      parentHash: `0x${'aa'.repeat(32)}`,
    };
    await store.reconcileChainCheckpoint(checkpoint, now);
    const observation: ConfirmedNonceObservation = {
      ...checkpoint,
      confirmations: 2,
      timestampSeconds: String(Math.floor(now / 1_000)),
      nonce: '0',
      signerEpoch: 1,
    };
    const chain = {
      getAttesterAddress: async () => attester.address,
      getConfirmedNonceObservation: async () => ({
        ...observation,
        timestampSeconds: String(Math.floor(now / 1_000)),
      }),
      getConfirmedTimestampSeconds: async () => BigInt(Math.floor(now / 1_000)),
      getRunSettlementContext: async () => ({
        lastRecordedScoreTier: 0,
        rulesVersion: 1,
        rebirthThresholdTier: 84,
      }),
    };
    const issuer = new V3AttestationIssuer(
      store,
      chain as never,
      attester,
      TEST_CHAIN_ID,
      TEST_CONTRACT,
    );
    const sessions = new WorkersWalletSessions(
      store,
      { isValidSignature: async () => false },
      new Map([[String(TEST_CHAIN_ID), TEST_CONTRACT]]),
      new Set([TEST_ORIGIN]),
      () => now,
    );
    const challenge = await sessions.issueChallenge({
      wallet: player.address,
      chainId: String(TEST_CHAIN_ID),
      verifyingContract: TEST_CONTRACT,
      origin: TEST_ORIGIN,
      runId: '1',
    });
    const signed = await player.signMessage({ message: challenge.message });
    const { sessionToken } = await sessions.completeChallenge(challenge.challengeId, signed);
    // This fixture stands in for a rules-verified run at the rebirth threshold. It is not wired into production.
    // Isolated confirmed-chain fixture: these committed PP choices are valid inputs to
    // createCanonicalRun, and the actual production verifier derives the score by replaying
    // accepted commands. No recover()/score result is mocked and no client score is supplied.
    let commandTimeMs = now;
    const seasonId = seasonIdAtMilliseconds(now);
    const verifier = new LocalVerifier(
      sessions,
      {
        getRunContext: async (session, runId) =>
          runId === '1'
            ? {
                player: session.wallet,
                chainId: TEST_CHAIN_ID,
                verifyingContract: TEST_CONTRACT,
                active: true,
                currentSeasonId: seasonId,
                input: {
                  runId: '1',
                  seasonId,
                  startedAtMs: NOW,
                  seasonalPP: 10_100n,
                  existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
                  seasonRebirths: 0,
                  upgradeChoices: [
                    { upgradeId: 'growth', quantity: 100 },
                    { upgradeId: 'awakening', quantity: 100 },
                  ],
                },
              }
            : null,
      },
      store,
      { nowMilliseconds: () => commandTimeMs },
    );
    await verifier.recover(sessionToken, '1');
    await verifier.submit({
      sessionToken,
      runId: '1',
      commandId: 'rebirth-test-forest',
      expectedSequence: 0,
      command: { type: 'buy-habitat', habitat: 'forest', quantity: 1 },
    });
    commandTimeMs += 1_000;
    const verifiedRun = await verifier.submit({
      sessionToken,
      runId: '1',
      commandId: 'rebirth-test-production',
      expectedSequence: 1,
      command: { type: 'sync' },
    });
    assert.ok(verifiedRun.scoreTier >= 84);
    const handler = createWorkerVerifierHandler({
      allowedOrigins: new Set([TEST_ORIGIN]),
      store,
      sessions,
      verifier: verifier as never,
      chain: chain as never,
      issuer,
    });
    const response = await handler(
      new Request(`https://worldseed.example/api/v3/runs/1/rebirth-attestation`, {
        method: 'POST',
        headers: {
          origin: TEST_ORIGIN,
          authorization: `Bearer ${sessionToken}`,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(body));
    now += 10_000;
    const retryResponse = await handler(
      new Request(`https://worldseed.example/api/v3/runs/1/rebirth-attestation`, {
        method: 'POST',
        headers: {
          origin: TEST_ORIGIN,
          authorization: `Bearer ${sessionToken}`,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    );
    const retryBody = (await retryResponse.json()) as Record<string, unknown>;
    assert.equal(retryResponse.status, 200, JSON.stringify(retryBody));
    assert.equal(retryBody.digest, body.digest);
    assert.equal(retryBody.signature, body.signature);
    const payload = body as {
      attestation: Parameters<typeof buildScoreAttestationTypedData>[0] & { actionType: 'REBIRTH' };
      signature: `0x${string}`;
    };
    assert.equal(payload.attestation.scoreTier, verifiedRun.scoreTier);
    assert.ok(payload.attestation.scoreTier >= 84);
    const attestation = {
      ...payload.attestation,
      runId: BigInt(payload.attestation.runId),
      seasonId: BigInt(payload.attestation.seasonId),
      chainId: BigInt(payload.attestation.chainId),
      nonce: BigInt(payload.attestation.nonce),
      issuedAt: BigInt(payload.attestation.issuedAt),
      expiresAt: BigInt(payload.attestation.expiresAt),
    };
    const typedData = buildScoreAttestationTypedData(attestation, {
      maxLifetimeSeconds: 300n,
      expectedChainId: TEST_CHAIN_ID,
      expectedContract: TEST_CONTRACT,
    });
    assert.equal(
      await verifyTypedData({
        ...typedData,
        signature: payload.signature,
        address: attester.address,
      }),
      true,
    );
  });

  it('rolls back a failed D1 batch write and does not advance the cursor', async () => {
    const runKey = 'test:run:failed-write';
    await store.initializeIfAbsent(runKey, '{}');
    database.exec(`CREATE TRIGGER reject_test_command BEFORE INSERT ON verifier_commands
      WHEN NEW.run_key = '${runKey}' BEGIN SELECT RAISE(ABORT, 'simulated database failure'); END`);
    await assert.rejects(
      store.appendIfCurrentSequence(runKey, 0, {
        commandId: 'fail',
        expectedSequence: 0,
        sequence: 1,
        command: { type: 'heart-click' },
        serverTimeMs: now,
        stateAfter: '{}',
        creditedAtoms: '0',
        spentAtoms: '0',
      }),
    );
    assert.equal((await store.read(runKey))?.headSequence, 0);
    database.exec('DROP TRIGGER reject_test_command');
  });
});
