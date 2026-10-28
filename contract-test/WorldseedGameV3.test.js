import assert from 'node:assert/strict';
import { before, it } from 'node:test';
import { network } from 'hardhat';
import { hashTypedData } from 'viem';
import vectors from '../src/incremental/v3TestVectors.json' with { type: 'json' };

const attestationTypes = {
  ScoreAttestation: [
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
  ],
};
const ZERO_HASH = `0x${'00'.repeat(32)}`;
const WEEK = 7 * 24 * 60 * 60;
const EPOCH = 4 * 24 * 60 * 60;
let viem;
let publicClient;
let testClient;
let owner;
let player;
let other;
let attester;
let replacementAttester;

before(async () => {
  const clients = await network.create();
  viem = clients.viem;
  publicClient = await viem.getPublicClient();
  testClient = await viem.getTestClient();
  [owner, player, other, attester, replacementAttester] = await viem.getWalletClients({ count: 5 });
});

async function deploy() {
  return viem.deployContract('WorldseedGameV3', [owner.account.address, attester.account.address], {
    client: { wallet: owner },
  });
}

async function nextSeasonData(game) {
  const [block, seasonId, chainId] = await Promise.all([
    publicClient.getBlock(),
    game.read.currentSeasonId(),
    publicClient.getChainId(),
  ]);
  const end = await game.read.seasonEnd([seasonId]);
  return { block, seasonId, chainId: BigInt(chainId), end };
}

async function signAttestation(game, signer, overrides = {}) {
  const { block, seasonId, chainId, end } = await nextSeasonData(game);
  const issuedAt = block.timestamp;
  const base = {
    player: player.account.address,
    runId: 1n,
    seasonId,
    chainId,
    verifyingContract: game.address,
    scoreTier: 0,
    natureCollectedAtoms: 0n,
    nonce: await game.read.attestationNonce([player.account.address]),
    issuedAt,
    expiresAt: issuedAt + 300n < end ? issuedAt + 300n : end,
    rulesVersion: 1,
    signerEpoch: await game.read.signerEpoch(),
    upgradeChoicesHash: ZERO_HASH,
    actionType: 1,
    ...overrides,
  };
  const domain = {
    name: 'Worldseed V3',
    version: '1',
    chainId: Number(base.chainId),
    verifyingContract: base.verifyingContract,
  };
  const signature = await signer.signTypedData({
    domain,
    types: attestationTypes,
    primaryType: 'ScoreAttestation',
    message: base,
  });
  return {
    data: base,
    signature,
    digest: hashTypedData({
      domain,
      types: attestationTypes,
      primaryType: 'ScoreAttestation',
      message: base,
    }),
  };
}

async function start(game, signer = attester, overrides = {}, choices = []) {
  const choicesHash = await game.read.hashUpgradeChoices([choices]);
  const { data, signature } = await signAttestation(game, signer, {
    upgradeChoicesHash: choicesHash,
    ...overrides,
  });
  const hash = await game.write.startRun([data, choices, signature], { account: player.account });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return { data, signature, receipt };
}

async function activateVersion2(game, overrides = {}) {
  const currentSeason = await game.read.currentSeasonId();
  const end = await game.read.seasonEnd([currentSeason]);
  const now = (await publicClient.getBlock()).timestamp;
  if (end - now <= 2n * 24n * 60n * 60n + 1n) {
    await testClient.increaseTime({ seconds: Number(end - now + 1n) });
    await testClient.mine({ blocks: 1 });
  }
  const rules = {
    rebirthThresholdTier: 42,
    ppStep: 10,
    ppPerRebirthCap: 1_000,
    ppBase: 1,
    seasonPPCap: 100_000,
    seasonCPCap: 100_000,
    maxUpgradeLevel: 100,
    cpMilestoneStep: 7,
    ...overrides,
  };
  await game.write.proposeRewardRules([2, rules], { account: owner.account });
  await testClient.increaseTime({ seconds: 2 * 24 * 60 * 60 + 1 });
  await testClient.mine({ blocks: 1 });
  await game.write.activateRewardRules([2], { account: owner.account });
}

async function action(game, functionName, signer, actionType, overrides = {}) {
  const { data, signature } = await signAttestation(game, signer, {
    runId: await game.read.activeRunId([player.account.address]),
    seasonId: (
      await game.read.runs([
        player.account.address,
        await game.read.activeRunId([player.account.address]),
      ])
    )[0],
    scoreTier: 1,
    upgradeChoicesHash: ZERO_HASH,
    actionType,
    ...overrides,
  });
  const hash = await game.write[functionName]([data, signature], { account: player.account });
  return publicClient.waitForTransactionReceipt({ hash });
}

async function expectRevert(promise) {
  await assert.rejects(promise);
}

it('matches published Monday UTC season and Solidity upgrade commitment vectors', async () => {
  const game = await deploy();
  for (const vector of vectors.seasonBoundaries)
    assert.equal(
      await game.read.seasonIdAt([BigInt(Math.floor(vector.timestampMs / 1000))]),
      BigInt(vector.seasonId),
    );
  const choices = vectors.upgradeCommitment.choices;
  assert.equal(await game.read.hashUpgradeChoices([choices]), vectors.upgradeCommitment.keccak256);
  const emptyHash = await game.read.hashUpgradeChoices([[]]);
  assert.notEqual(emptyHash, ZERO_HASH);
  assert.equal(await game.read.seasonStart([0n]), BigInt(EPOCH));
  assert.equal(await game.read.seasonEnd([0n]), BigInt(EPOCH + WEEK));
});

it('matches the published EIP-712 digest and atomically applies committed PP upgrades', async () => {
  const game = await deploy();
  // Seed one PP through the only award path, then spend it at the next Start Run.
  await start(game);
  await action(game, 'rebirth', attester, 3, { scoreTier: 35 });
  const beforePP = await game.read.seasonalPP([
    player.account.address,
    await game.read.currentSeasonId(),
  ]);
  assert.equal(beforePP, 1n);
  const choices = [{ upgradeId: 0, quantity: 1 }];
  const choiceHash = await game.read.hashUpgradeChoices([choices]);
  const { data, signature, digest } = await signAttestation(game, attester, {
    runId: 2n,
    scoreTier: 0,
    upgradeChoicesHash: choiceHash,
    actionType: 1,
  });
  assert.equal(await game.read.hashAttestation([data]), digest);
  const txHash = await game.write.startRun([data, choices, signature], { account: player.account });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: txHash })).status, 'success');
  assert.equal(
    await game.read.seasonalPP([player.account.address, await game.read.currentSeasonId()]),
    0n,
  );
  assert.equal(await game.read.seasonalUpgradeLevel([player.account.address, data.seasonId, 0]), 1);
  const run = await game.read.runs([player.account.address, 2n]);
  assert.equal(run[4], 1);
  assert.equal(run[5], choiceHash);
});

it('rejects invalid bindings, signatures, expiry, malformed choices, and overspending without consuming state', async () => {
  const game = await deploy();
  const initialNonce = await game.read.attestationNonce([player.account.address]);
  const badPayloads = [
    { chainId: 1n },
    { verifyingContract: other.account.address },
    { player: other.account.address },
    { runId: 2n },
    { seasonId: 1n },
    { expiresAt: 1n },
    { nonce: 9n },
    { signerEpoch: 7 },
  ];
  for (const mutation of badPayloads) {
    const choicesHash = await game.read.hashUpgradeChoices([[]]);
    const { data, signature } = await signAttestation(game, attester, {
      upgradeChoicesHash: choicesHash,
      ...mutation,
    });
    await expectRevert(game.write.startRun([data, [], signature], { account: player.account }));
    assert.equal(await game.read.attestationNonce([player.account.address]), initialNonce);
    assert.equal(await game.read.activeRunId([player.account.address]), 0n);
  }
  const choicesHash = await game.read.hashUpgradeChoices([[{ upgradeId: 0, quantity: 1 }]]);
  const { data, signature } = await signAttestation(game, attester, {
    upgradeChoicesHash: choicesHash,
  });
  await expectRevert(
    game.write.startRun([data, [{ upgradeId: 1, quantity: 1 }], signature], {
      account: player.account,
    }),
  );
  await expectRevert(
    game.write.startRun(
      [
        data,
        [
          { upgradeId: 0, quantity: 1 },
          { upgradeId: 0, quantity: 1 },
        ],
        signature,
      ],
      { account: player.account },
    ),
  );
  await expectRevert(
    game.write.startRun([data, [{ upgradeId: 4, quantity: 1 }], signature], {
      account: player.account,
    }),
  );
  const wrongSignerPayload = await signAttestation(game, other, {
    upgradeChoicesHash: await game.read.hashUpgradeChoices([[]]),
  });
  await expectRevert(
    game.write.startRun([wrongSignerPayload.data, [], wrongSignerPayload.signature], {
      account: player.account,
    }),
  );
  assert.equal(await game.read.attestationNonce([player.account.address]), initialNonce);
});

it('rejects a correctly committed upgrade batch that exceeds seasonal PP, preserving nonce and levels', async () => {
  const game = await deploy();
  await start(game);
  await action(game, 'rebirth', attester, 3, { scoreTier: 35 });
  const season = await game.read.currentSeasonId();
  assert.equal(await game.read.seasonalPP([player.account.address, season]), 1n);
  const choices = [{ upgradeId: 0, quantity: 2 }];
  const choicesHash = await game.read.hashUpgradeChoices([choices]);
  const signed = await signAttestation(game, attester, {
    runId: 2n,
    nonce: await game.read.attestationNonce([player.account.address]),
    scoreTier: 0,
    upgradeChoicesHash: choicesHash,
    actionType: 1,
  });
  const nonceBefore = await game.read.attestationNonce([player.account.address]);
  await expectRevert(
    game.write.startRun([signed.data, choices, signed.signature], { account: player.account }),
  );
  assert.equal(await game.read.attestationNonce([player.account.address]), nonceBefore);
  assert.equal(await game.read.nextRunId([player.account.address]), 1n);
  assert.equal(await game.read.seasonalPP([player.account.address, season]), 1n);
  assert.equal(await game.read.seasonalUpgradeLevel([player.account.address, season, 0]), 0);
});

it('enforces monotonic checkpoints and settles exactly once; rebirth needs no prior checkpoint', async () => {
  const game = await deploy();
  await start(game);
  await action(game, 'recordPoints', attester, 2, { scoreTier: 10 });
  assert.equal(
    await game.read.seasonalPP([player.account.address, await game.read.currentSeasonId()]),
    0n,
  );
  assert.equal(
    await game.read.seasonalCP([player.account.address, await game.read.currentSeasonId()]),
    0n,
  );
  await expectRevert(action(game, 'recordPoints', attester, 2, { scoreTier: 10 }));
  const next = await game.read.attestationNonce([player.account.address]);
  const rebirth = await signAttestation(game, attester, {
    runId: 1n,
    nonce: next,
    scoreTier: 65535,
    upgradeChoicesHash: ZERO_HASH,
    actionType: 3,
  });
  const hash = await game.write.rebirth([rebirth.data, rebirth.signature], {
    account: player.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  const season = await game.read.currentSeasonId();
  assert.equal(await game.read.seasonalPP([player.account.address, season]), 1_000n);
  assert.equal(await game.read.seasonalCP([player.account.address, season]), 9_357n);
  assert.equal(await game.read.lifetimeCP([player.account.address]), 9_357n);
  assert.equal(await game.read.totalSeasonCP([season]), 9_357n);
  assert.equal(await game.read.seasonalHighScoreTier([player.account.address, season]), 65_535);
  assert.equal((await game.read.runs([player.account.address, 1n]))[1], 2);
  await expectRevert(
    game.write.rebirth([rebirth.data, rebirth.signature], { account: player.account }),
  );
  assert.equal(await game.read.lifetimeCP([player.account.address]), 9_357n);
});

it('rejects below-threshold rebirth and preserves the nonce so a valid retry can settle', async () => {
  const game = await deploy();
  await start(game);
  const nonce = await game.read.attestationNonce([player.account.address]);
  const weak = await signAttestation(game, attester, {
    runId: 1n,
    nonce,
    scoreTier: 34,
    upgradeChoicesHash: ZERO_HASH,
    actionType: 3,
  });
  await expectRevert(game.write.rebirth([weak.data, weak.signature], { account: player.account }));
  assert.equal(await game.read.attestationNonce([player.account.address]), nonce);
  const valid = await signAttestation(game, attester, {
    runId: 1n,
    nonce,
    scoreTier: 35,
    upgradeChoicesHash: ZERO_HASH,
    actionType: 3,
  });
  const hash = await game.write.rebirth([valid.data, valid.signature], { account: player.account });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, 'success');
});

it('awards CP once per new seasonal seven-tier milestone and none for repeated scores', async () => {
  const game = await deploy();
  const season = await game.read.currentSeasonId();

  await start(game);
  await action(game, 'rebirth', attester, 3, {
    scoreTier: 42,
    natureCollectedAtoms: 1_200_000_000_000_000n,
  });
  assert.equal(await game.read.seasonalCP([player.account.address, season]), 1n);
  assert.equal(await game.read.seasonalHighScoreTier([player.account.address, season]), 42);

  await start(game, attester, { runId: 2n });
  await action(game, 'rebirth', attester, 3, {
    runId: 2n,
    scoreTier: 42,
    natureCollectedAtoms: 2_450_000_000_000_000n,
  });
  assert.equal(await game.read.seasonalCP([player.account.address, season]), 1n);

  await start(game, attester, { runId: 3n });
  await action(game, 'rebirth', attester, 3, {
    runId: 3n,
    scoreTier: 56,
    natureCollectedAtoms: 3_800_000_000_000_000n,
  });
  assert.equal(await game.read.seasonalCP([player.account.address, season]), 3n);
  assert.equal(await game.read.seasonalHighScoreTier([player.account.address, season]), 56);
  assert.equal(
    await game.read.lifetimeNatureCollectedAtoms([player.account.address]),
    7_450_000_000_000_000n,
  );
  assert.equal(await game.read.totalAccumulatedRebirthScore([player.account.address]), 140n);
  assert.equal(
    await game.read.seasonalAccumulatedRebirthScore([player.account.address, season]),
    140n,
  );
});

it('binds Nature collected to the Rebirth signature and does not count failed or repeated settlement', async () => {
  const game = await deploy();
  const season = await game.read.currentSeasonId();
  await start(game);
  const signed = await signAttestation(game, attester, {
    scoreTier: 42,
    upgradeChoicesHash: ZERO_HASH,
    actionType: 3,
    natureCollectedAtoms: 900_000_000_000_000n,
  });
  const tampered = { ...signed.data, natureCollectedAtoms: 1n };
  await expectRevert(game.write.rebirth([tampered, signed.signature], { account: player.account }));
  assert.equal(await game.read.attestationNonce([player.account.address]), 1n);
  assert.equal(await game.read.lifetimeNatureCollectedAtoms([player.account.address]), 0n);

  const hash = await game.write.rebirth([signed.data, signed.signature], {
    account: player.account,
  });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, 'success');
  assert.equal(
    await game.read.lifetimeNatureCollectedAtoms([player.account.address]),
    900_000_000_000_000n,
  );
  assert.equal(await game.read.totalAccumulatedRebirthScore([player.account.address]), 42n);
  assert.equal(
    await game.read.seasonalAccumulatedRebirthScore([player.account.address, season]),
    42n,
  );
  await expectRevert(
    game.write.rebirth([signed.data, signed.signature], { account: player.account }),
  );
  assert.equal(
    await game.read.lifetimeNatureCollectedAtoms([player.account.address]),
    900_000_000_000_000n,
  );
});

it('saturates lifetime Nature atom totals without blocking a valid later Rebirth', async () => {
  const game = await deploy();
  await start(game);
  await action(game, 'rebirth', attester, 3, {
    scoreTier: 42,
    natureCollectedAtoms: (1n << 256n) - 1n,
  });
  await start(game, attester, { runId: 2n });
  await action(game, 'rebirth', attester, 3, {
    runId: 2n,
    scoreTier: 42,
    natureCollectedAtoms: 1n,
  });
  assert.equal(
    await game.read.lifetimeNatureCollectedAtoms([player.account.address]),
    (1n << 256n) - 1n,
  );
  assert.equal(await game.read.totalAccumulatedRebirthScore([player.account.address]), 84n);
});

it('uses V1/V2 run-pinned thresholds and shares the high-water across a rules-version switch', async () => {
  const game = await deploy();
  const initialSeason = await game.read.currentSeasonId();
  const seasonEnd = await game.read.seasonEnd([initialSeason]);
  const now = (await publicClient.getBlock()).timestamp;
  if (seasonEnd - now <= 2n * 24n * 60n * 60n + 1n) {
    await testClient.increaseTime({ seconds: Number(seasonEnd - now + 1n) });
    await testClient.mine({ blocks: 1 });
  }
  await start(game);
  await activateVersion2(game);

  // The active V1 run keeps its V1 threshold after V2 becomes active.
  await action(game, 'rebirth', attester, 3, {
    runId: 1n,
    rulesVersion: 1,
    scoreTier: 42,
    natureCollectedAtoms: 10n,
  });
  const season = await game.read.currentSeasonId();
  assert.equal(await game.read.seasonalCP([player.account.address, season]), 1n);

  await start(game, attester, { runId: 2n, rulesVersion: 2 });
  const nonce = await game.read.attestationNonce([player.account.address]);
  const belowV2 = await signAttestation(game, attester, {
    runId: 2n,
    nonce,
    rulesVersion: 2,
    scoreTier: 41,
    upgradeChoicesHash: ZERO_HASH,
    actionType: 3,
  });
  await expectRevert(
    game.write.rebirth([belowV2.data, belowV2.signature], { account: player.account }),
  );
  assert.equal(await game.read.attestationNonce([player.account.address]), nonce);

  await action(game, 'rebirth', attester, 3, {
    runId: 2n,
    rulesVersion: 2,
    scoreTier: 49,
    natureCollectedAtoms: 20n,
  });
  assert.equal(await game.read.seasonalCP([player.account.address, season]), 2n);
  assert.equal(await game.read.seasonalHighScoreTier([player.account.address, season]), 49);
  assert.equal(await game.read.lifetimeNatureCollectedAtoms([player.account.address]), 30n);
  assert.equal(await game.read.totalAccumulatedRebirthScore([player.account.address]), 91n);
  assert.equal(
    await game.read.seasonalAccumulatedRebirthScore([player.account.address, season]),
    91n,
  );
});

it('settles a valid Rebirth with partial or zero PP/CP when season caps are reached', async () => {
  const game = await deploy();
  await activateVersion2(game, { seasonPPCap: 1, seasonCPCap: 1 });
  const season = await game.read.currentSeasonId();
  await start(game, attester, { runId: 1n, rulesVersion: 2 });
  await action(game, 'rebirth', attester, 3, { runId: 1n, rulesVersion: 2, scoreTier: 56 });
  assert.equal(await game.read.seasonalPP([player.account.address, season]), 1n);
  assert.equal(await game.read.seasonalCP([player.account.address, season]), 1n);

  await start(game, attester, { runId: 2n, rulesVersion: 2 });
  const settled = await action(game, 'rebirth', attester, 3, {
    runId: 2n,
    rulesVersion: 2,
    scoreTier: 70,
  });
  assert.equal(settled.status, 'success');
  assert.equal(await game.read.seasonalPP([player.account.address, season]), 1n);
  assert.equal(await game.read.seasonalCP([player.account.address, season]), 1n);
  assert.equal(await game.read.seasonalHighScoreTier([player.account.address, season]), 70);
  assert.equal(await game.read.seasonalRebirths([player.account.address, season]), 2);
});

it('starts a fresh seasonal high-water after rollover without carrying seasonal CP forward', async () => {
  const game = await deploy();
  const oldSeason = await game.read.currentSeasonId();
  await start(game);
  await action(game, 'rebirth', attester, 3, { scoreTier: 42 });
  assert.equal(await game.read.seasonalHighScoreTier([player.account.address, oldSeason]), 42);

  const end = await game.read.seasonEnd([oldSeason]);
  const now = (await publicClient.getBlock()).timestamp;
  if (end > now) {
    await testClient.increaseTime({ seconds: Number(end - now + 1n) });
    await testClient.mine({ blocks: 1 });
  }
  const newSeason = await game.read.currentSeasonId();
  assert.equal(newSeason, oldSeason + 1n);
  assert.equal(await game.read.seasonalHighScoreTier([player.account.address, newSeason]), 0);
  assert.equal(await game.read.seasonalCP([player.account.address, newSeason]), 0n);
  assert.equal(
    await game.read.seasonalAccumulatedRebirthScore([player.account.address, oldSeason]),
    42n,
  );
  assert.equal(await game.read.totalAccumulatedRebirthScore([player.account.address]), 42n);

  await start(game, attester, { runId: 2n });
  await action(game, 'rebirth', attester, 3, { runId: 2n, scoreTier: 42 });
  assert.equal(await game.read.seasonalHighScoreTier([player.account.address, newSeason]), 42);
  assert.equal(await game.read.seasonalCP([player.account.address, newSeason]), 1n);
  assert.equal(await game.read.lifetimeCP([player.account.address]), 2n);
  assert.equal(
    await game.read.seasonalAccumulatedRebirthScore([player.account.address, newSeason]),
    42n,
  );
  assert.equal(await game.read.totalAccumulatedRebirthScore([player.account.address]), 84n);
});

it('rejects a signature that expires before mining without consuming its run ID or nonce', async () => {
  const game = await deploy();
  const signed = await signAttestation(game, attester, {
    upgradeChoicesHash: await game.read.hashUpgradeChoices([[]]),
  });
  await testClient.increaseTime({ seconds: 301 });
  await testClient.mine({ blocks: 1 });
  await expectRevert(
    game.write.startRun([signed.data, [], signed.signature], { account: player.account }),
  );
  assert.equal(await game.read.attestationNonce([player.account.address]), 0n);
  assert.equal(await game.read.nextRunId([player.account.address]), 0n);
  assert.equal(await game.read.activeRunId([player.account.address]), 0n);
  await start(game);
  assert.equal(await game.read.nextRunId([player.account.address]), 1n);
});

it('rejects an attestation issued before the attested season begins', async () => {
  const game = await deploy();
  const previousSeason = await game.read.currentSeasonId();
  const seasonStart = await game.read.seasonEnd([previousSeason]);
  const currentBlock = await publicClient.getBlock();
  if (seasonStart > currentBlock.timestamp + 2n) {
    await testClient.increaseTime({ seconds: Number(seasonStart - currentBlock.timestamp + 1n) });
    await testClient.mine({ blocks: 1 });
  }
  const newSeason = await game.read.currentSeasonId();
  assert.equal(newSeason, previousSeason + 1n);
  const beforeBoundary = seasonStart - 1n;
  const signed = await signAttestation(game, attester, {
    seasonId: newSeason,
    issuedAt: beforeBoundary,
    expiresAt: beforeBoundary + 300n,
    upgradeChoicesHash: await game.read.hashUpgradeChoices([[]]),
  });
  await expectRevert(
    game.write.startRun([signed.data, [], signed.signature], { account: player.account }),
  );
  assert.equal(await game.read.attestationNonce([player.account.address]), 0n);
  assert.equal(await game.read.nextRunId([player.account.address]), 0n);
});

it('keeps abandonment available while paused and lazily expires stale runs after rollover', async () => {
  const game = await deploy();
  await start(game);
  await game.write.pause([], { account: owner.account });
  await expectRevert(start(game));
  await game.write.abandonRun([1n], { account: player.account });
  assert.equal((await game.read.runs([player.account.address, 1n]))[1], 4);
  await game.write.unpause([], { account: owner.account });

  const second = await deploy();
  const started = await start(second);
  const run = await second.read.runs([player.account.address, 1n]);
  const end = await second.read.seasonEnd([run[0]]);
  const now = (await publicClient.getBlock()).timestamp;
  if (end > now + 1n) {
    await testClient.increaseTime({ seconds: Number(end - now) });
    await testClient.mine({ blocks: 1 });
  }
  const newSeason = await second.read.currentSeasonId();
  assert.equal(newSeason, run[0] + 1n);
  const data = await signAttestation(second, attester, {
    runId: 2n,
    seasonId: newSeason,
    upgradeChoicesHash: await second.read.hashUpgradeChoices([[]]),
    actionType: 1,
  });
  const txHash = await second.write.startRun([data.data, [], data.signature], {
    account: player.account,
  });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: txHash })).status, 'success');
  assert.equal((await second.read.runs([player.account.address, 1n]))[1], 3);
  assert.equal(await second.read.activeRunId([player.account.address]), 2n);
  assert.ok(started.receipt.status === 'success');
});

it('invalidates old signatures on delayed attester rotation and restricts pause controls', async () => {
  const game = await deploy();
  await start(game);
  const oldSignature = await signAttestation(game, attester, {
    runId: 1n,
    nonce: 1n,
    scoreTier: 10,
    upgradeChoicesHash: ZERO_HASH,
    actionType: 2,
  });
  await expectRevert(game.write.pause([], { account: player.account }));
  await game.write.proposeAttester([replacementAttester.account.address], {
    account: owner.account,
  });
  await expectRevert(game.write.acceptAttester([], { account: replacementAttester.account }));
  await testClient.increaseTime({ seconds: 2 * 24 * 60 * 60 + 1 });
  await testClient.mine({ blocks: 1 });
  await game.write.acceptAttester([], { account: replacementAttester.account });
  assert.equal(await game.read.signerEpoch(), 2);
  await expectRevert(
    game.write.recordPoints([oldSignature.data, oldSignature.signature], {
      account: player.account,
    }),
  );
  assert.equal(await game.read.attestationNonce([player.account.address]), 1n);
  await game.write.pause([], { account: owner.account });
  await expectRevert(action(game, 'recordPoints', replacementAttester, 2, { scoreTier: 10 }));
  await game.write.unpause([], { account: owner.account });
  await action(game, 'recordPoints', replacementAttester, 2, { scoreTier: 10 });
});

it('requires player caller identity and rejects wrong-run / replay signatures', async () => {
  const game = await deploy();
  const signed = await signAttestation(game, attester, {
    upgradeChoicesHash: await game.read.hashUpgradeChoices([[]]),
  });
  await expectRevert(
    game.write.startRun([signed.data, [], signed.signature], { account: other.account }),
  );
  assert.equal(await game.read.attestationNonce([player.account.address]), 0n);
  await start(game);
  const wrongRun = await signAttestation(game, attester, {
    runId: 2n,
    nonce: 1n,
    scoreTier: 1,
    upgradeChoicesHash: ZERO_HASH,
    actionType: 2,
  });
  await expectRevert(
    game.write.recordPoints([wrongRun.data, wrongRun.signature], { account: player.account }),
  );
  assert.equal(await game.read.attestationNonce([player.account.address]), 1n);
});
