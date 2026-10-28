import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as nodeHttpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'tsx/esm/api';
import { network } from 'hardhat';
import { defineChain } from 'viem';
import { parseEventLogs } from 'viem';

register();

const ORIGIN = 'http://localhost:5173';
const ZERO_HASH = `0x${'00'.repeat(32)}`;
let viem;
let publicClient;
let testClient;
let owner;
let player;
let attacker;
let attester;
let game;
let tempDirectory;
let databasePath;
let server;
let store;
let serverUrl;
let sessionToken;
let challenge;
let walletSignature;
let modules;
let canonicalNowMs = Date.now();

before(async () => {
  modules = {
    ...(await import('../src/incremental/localVerifier.ts')),
    ...(await import('../src/incremental/server/sqliteVerifierStore.ts')),
    ...(await import('../src/incremental/server/walletSessions.ts')),
    ...(await import('../src/incremental/server/v3ChainReader.ts')),
    ...(await import('../src/incremental/server/attestationIssuer.ts')),
    ...(await import('../src/incremental/server/httpVerifier.ts')),
  };
  const connection = await network.create();
  viem = connection.viem;
  publicClient = await viem.getPublicClient();
  testClient = await viem.getTestClient();
  [owner, player, attacker, attester] = await viem.getWalletClients({ count: 4 });
  game = await viem.deployContract(
    'WorldseedGameV3',
    [owner.account.address, attester.account.address],
    {
      client: { wallet: owner },
    },
  );
  tempDirectory = mkdtempSync(join(tmpdir(), 'worldseed-v3-it-'));
  databasePath = join(tempDirectory, 'verifier.sqlite');
  await startVerifier();
  await authenticatePlayer();
});

after(async () => {
  await stopVerifier();
  if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
});

async function startVerifier() {
  store = new modules.SqliteVerifierStore(databasePath);
  const rpcUrl = 'http://127.0.0.1:8545';
  const chain = defineChain({
    id: 31_337,
    name: 'Worldseed Hardhat Local',
    nativeCurrency: { name: 'Local Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const reader = new modules.V3ChainStateReader({
    config: {
      chain,
      rpcUrl,
      contractAddress: game.address,
      confirmations: 1,
      deploymentBlock: 1n,
      activeRunStatus: 1,
      nowMilliseconds: () => Date.now(),
    },
    checkpoints: store,
    client: publicClient,
  });
  const origins = new Set([ORIGIN]);
  const sessions = new modules.SqliteWalletSessions(
    store,
    new modules.EoaAndContractWalletMessageVerifier(reader),
    {
      deployments: new Map([['31337', game.address]]),
      allowedOrigins: origins,
      nowMilliseconds: () => Date.now(),
    },
  );
  const verifier = new modules.LocalVerifier(sessions, reader, store, {
    nowMilliseconds: () => canonicalNowMs,
  });
  const issuer = new modules.V3AttestationIssuer(
    store,
    reader,
    {
      address: attester.account.address,
      signTypedData: (data) => attester.signTypedData(data),
    },
    31_337n,
    game.address,
  );
  server = modules.createLocalVerifierHttpServer({
    allowedOrigins: origins,
    store,
    sessions,
    verifier,
    chain: reader,
    issuer,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Verifier did not bind TCP.');
  serverUrl = `http://127.0.0.1:${address.port}`;
}

async function stopVerifier() {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (store) store.close();
  server = undefined;
  store = undefined;
}

async function request(path, { method = 'GET', body, token = sessionToken } = {}) {
  return new Promise((resolve, reject) => {
    const serializedBody = body ? JSON.stringify(body) : undefined;
    const req = nodeHttpRequest(
      `${serverUrl}${path}`,
      {
        method,
        headers: {
          Origin: ORIGIN,
          ...(serializedBody ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    if (serializedBody) req.write(serializedBody);
    req.end();
  });
}

async function authenticatePlayer() {
  const wrongChain = await request('/api/v3/auth/challenge', {
    method: 'POST',
    token: undefined,
    body: {
      wallet: player.account.address,
      chainId: '1',
      verifyingContract: game.address,
      runId: '1',
    },
  });
  assert.equal(wrongChain.status, 400);
  const response = await request('/api/v3/auth/challenge', {
    method: 'POST',
    token: undefined,
    body: {
      wallet: player.account.address,
      chainId: '31337',
      verifyingContract: game.address,
      runId: '1',
    },
  });
  assert.equal(response.status, 200);
  challenge = response.body;
  walletSignature = await player.signMessage({ message: challenge.message });
  const forged = await request('/api/v3/auth/complete', {
    method: 'POST',
    token: undefined,
    body: {
      challengeId: challenge.challengeId,
      signature: await attacker.signMessage({ message: challenge.message }),
    },
  });
  assert.equal(forged.status, 401);
  const completed = await request('/api/v3/auth/complete', {
    method: 'POST',
    token: undefined,
    body: { challengeId: challenge.challengeId, signature: walletSignature },
  });
  assert.equal(completed.status, 200);
  sessionToken = completed.body.sessionToken;
}

function asContractAttestation(wire) {
  return {
    ...wire,
    runId: BigInt(wire.runId),
    seasonId: BigInt(wire.seasonId),
    chainId: BigInt(wire.chainId),
    nonce: BigInt(wire.nonce),
    issuedAt: BigInt(wire.issuedAt),
    expiresAt: BigInt(wire.expiresAt),
    natureCollectedAtoms: BigInt(wire.natureCollectedAtoms),
    actionType: { START_RUN: 1, RECORD_POINTS: 2, REBIRTH: 3 }[wire.actionType],
  };
}

async function command(sequence, payload, commandId = `command-${sequence}`) {
  const head = await publicClient.getBlock();
  canonicalNowMs = Math.max(canonicalNowMs, Number(head.timestamp * 1_000n));
  return request('/api/v3/runs/1/commands', {
    method: 'POST',
    body: { commandId, expectedSequence: sequence, command: payload },
  });
}

async function advanceCanonicalTime(seconds) {
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
  const head = await publicClient.getBlock();
  canonicalNowMs = Math.max(canonicalNowMs, Number(head.timestamp * 1_000n));
}

it('integrates wallet auth, canonical progression, checkpoint, and successful verified Rebirth', async () => {
  assert.equal(await publicClient.getChainId(), 31_337);
  const replayedChallenge = await request('/api/v3/auth/complete', {
    method: 'POST',
    token: undefined,
    body: { challengeId: challenge.challengeId, signature: walletSignature },
  });
  assert.equal(replayedChallenge.status, 401);

  const rejectedRebirthUpgrade = await request('/api/v3/runs/start-attestation', {
    method: 'POST',
    body: { upgradeChoices: [{ upgradeId: 'rebirth', quantity: 1 }] },
  });
  assert.equal(rejectedRebirthUpgrade.status, 400);
  assert.match(rejectedRebirthUpgrade.body.message, /Rebirth PP upgrade is disabled/);
  assert.equal(await game.read.nextRunId([player.account.address]), 0n);
  assert.equal(await game.read.attestationNonce([player.account.address]), 0n);

  const start = await request('/api/v3/runs/start-attestation', {
    method: 'POST',
    body: { upgradeChoices: [] },
  });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.attestation.actionType, 'START_RUN');
  assert.equal(start.body.attestation.upgradeChoicesHash, await game.read.hashUpgradeChoices([[]]));
  assert.ok(
    Number(start.body.attestation.expiresAt) - Number(start.body.attestation.issuedAt) <= 300,
  );
  const startHash = await game.write.startRun(
    [asContractAttestation(start.body.attestation), [], start.body.signature],
    { account: player.account },
  );
  assert.equal(
    (await publicClient.waitForTransactionReceipt({ hash: startHash })).status,
    'success',
  );
  const startReceipt = await publicClient.getTransactionReceipt({ hash: startHash });
  const startBlock = await publicClient.getBlock({ blockNumber: startReceipt.blockNumber });
  canonicalNowMs = Number(startBlock.timestamp * 1_000n);

  const first = await command(0, { type: 'heart-click' }, 'same-id');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const retry = await command(0, { type: 'heart-click' }, 'same-id');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.canonicalState, first.body.canonicalState);
  assert.equal(retry.body.cursor.sequence, 1);
  assert.equal((await command(0, { type: 'sync' }, 'same-id')).status, 409);
  assert.equal((await command(3, { type: 'sync' }, 'sequence-gap')).status, 409);
  for (let sequence = 1; sequence < 10; sequence += 1)
    assert.equal((await command(sequence, { type: 'heart-click' })).status, 200);
  const purchase = await command(10, { type: 'buy-habitat', habitat: 'water', quantity: 1 });
  assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
  assert.equal(purchase.body.cursor.sequence, 11);

  // Build the score using accepted canonical commands and passive production.
  // Advance the local chain and verifier clock together; do not inject score/state.
  for (let sequence = 11; sequence < 211; sequence += 1)
    assert.equal((await command(sequence, { type: 'heart-click' })).status, 200);
  const forest = await command(211, { type: 'buy-habitat', habitat: 'forest', quantity: 1 });
  assert.equal(forest.status, 200, JSON.stringify(forest.body));
  await advanceCanonicalTime(60 * 60);
  const firstProduction = await command(212, { type: 'sync' });
  assert.equal(firstProduction.status, 200, JSON.stringify(firstProduction.body));
  const forestBatch = await command(213, {
    type: 'buy-habitat',
    habitat: 'forest',
    quantity: 10,
  });
  assert.equal(forestBatch.status, 200, JSON.stringify(forestBatch.body));
  await advanceCanonicalTime(6 * 60 * 60);
  const secondProduction = await command(214, { type: 'sync' });
  assert.equal(secondProduction.status, 200, JSON.stringify(secondProduction.body));
  assert.ok(
    secondProduction.body.scoreTier >= 42 && secondProduction.body.scoreTier < 49,
    JSON.stringify(secondProduction.body),
  );

  const checkpoint = await request('/api/v3/runs/1/record-attestation', {
    method: 'POST',
    body: {},
  });
  assert.equal(checkpoint.status, 200, JSON.stringify(checkpoint.body));
  assert.equal(checkpoint.body.attestation.actionType, 'RECORD_POINTS');
  assert.ok(checkpoint.body.attestation.scoreTier >= 42);
  const duplicateCheckpoint = await request('/api/v3/runs/1/record-attestation', {
    method: 'POST',
    body: {},
  });
  assert.equal(duplicateCheckpoint.body.signature, checkpoint.body.signature);
  const checkpointHash = await game.write.recordPoints(
    [asContractAttestation(checkpoint.body.attestation), checkpoint.body.signature],
    { account: player.account },
  );
  assert.equal(
    (await publicClient.waitForTransactionReceipt({ hash: checkpointHash })).status,
    'success',
  );
  await assert.rejects(
    game.write.recordPoints(
      [asContractAttestation(checkpoint.body.attestation), checkpoint.body.signature],
      { account: player.account },
    ),
  );

  await stopVerifier();
  await startVerifier();
  const recovered = await request('/api/v3/runs/1/recover');
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.cursor.sequence, 215);
  assert.match(recovered.body.canonicalState, /"water":1/);
  assert.match(recovered.body.canonicalState, /"forest":11/);
  const canonicalState = JSON.parse(recovered.body.canonicalState);
  assert.ok(
    BigInt(canonicalState.earnedNatureAtoms) > BigInt(canonicalState.natureAtoms),
    'spent Nature remains included in the cumulative earned total',
  );
  const run = await game.read.runs([player.account.address, 1n]);
  assert.equal(run[3], checkpoint.body.attestation.scoreTier);

  const rebirth = await request('/api/v3/runs/1/rebirth-attestation', { method: 'POST', body: {} });
  assert.equal(rebirth.status, 200, JSON.stringify(rebirth.body));
  assert.equal(rebirth.body.attestation.actionType, 'REBIRTH');
  assert.equal(rebirth.body.attestation.scoreTier, checkpoint.body.attestation.scoreTier);
  assert.equal(rebirth.body.attestation.natureCollectedAtoms, canonicalState.earnedNatureAtoms);
  const rebirthHash = await game.write.rebirth(
    [asContractAttestation(rebirth.body.attestation), rebirth.body.signature],
    { account: player.account },
  );
  const rebirthReceipt = await publicClient.waitForTransactionReceipt({ hash: rebirthHash });
  assert.equal(rebirthReceipt.status, 'success');
  const seasonId = BigInt(run[0]);
  assert.equal(await game.read.seasonalPP([player.account.address, seasonId]), 1n);
  assert.equal(await game.read.seasonalCP([player.account.address, seasonId]), 1n);
  assert.equal(await game.read.lifetimeCP([player.account.address]), 1n);
  assert.equal(
    await game.read.lifetimeNatureCollectedAtoms([player.account.address]),
    BigInt(rebirth.body.attestation.natureCollectedAtoms),
  );
  assert.equal(
    await game.read.totalAccumulatedRebirthScore([player.account.address]),
    BigInt(rebirth.body.attestation.scoreTier),
  );
  assert.equal(
    await game.read.seasonalAccumulatedRebirthScore([player.account.address, seasonId]),
    BigInt(rebirth.body.attestation.scoreTier),
  );
  const rebirthEvents = parseEventLogs({
    abi: game.abi,
    logs: rebirthReceipt.logs,
    eventName: 'RebirthSettled',
  });
  assert.equal(rebirthEvents.length, 1);
  assert.equal(rebirthEvents[0].args.scoreTier, rebirth.body.attestation.scoreTier);
  assert.equal(
    rebirthEvents[0].args.natureCollectedAtoms,
    BigInt(rebirth.body.attestation.natureCollectedAtoms),
  );
  assert.equal(
    await game.read.seasonalHighScoreTier([player.account.address, seasonId]),
    checkpoint.body.attestation.scoreTier,
  );
  assert.equal(await game.read.seasonalRebirths([player.account.address, seasonId]), 1);
  assert.equal(
    await game.read.totalAccumulatedRebirthScore([player.account.address]),
    BigInt(rebirth.body.attestation.scoreTier),
  );
  assert.equal(checkpoint.body.attestation.upgradeChoicesHash, ZERO_HASH);
});
