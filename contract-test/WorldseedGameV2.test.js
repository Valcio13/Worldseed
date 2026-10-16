import assert from 'node:assert/strict';
import { before, it } from 'node:test';
import { network } from 'hardhat';
import { hashTypedData, recoverAddress } from 'viem';
import { applyPuzzleMove, calculateGoldInteger, createPuzzleRound } from '../src/puzzle/engine.ts';
import witnessVector from '../shared/witness-v1.json' with { type: 'json' };

const types = {
  CandidateSet: [
    { name: 'player', type: 'address' },
    { name: 'expeditionNumber', type: 'uint64' },
    { name: 'sourceCommitment', type: 'bytes32' },
    { name: 'candidateSeeds', type: 'bytes32[3]' },
    { name: 'combinedCharacterSeed', type: 'bytes32' },
    { name: 'islandGeneratorVersion', type: 'uint32' },
    { name: 'characterGeneratorVersion', type: 'uint32' },
    { name: 'sourceSelectionPolicyVersion', type: 'uint32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
};

let viem;
let publicClient;
let owner;
let player;
let other;
let attester;
let game;

before(async () => {
  ({ viem } = await network.create());
  [owner, player, other, attester] = await viem.getWalletClients({ count: 4 });
  publicClient = await viem.getPublicClient();
  game = await viem.deployContract(
    'WorldseedGameV2',
    [owner.account.address, attester.account.address],
    {
      client: { wallet: owner },
    },
  );
});

async function signedSet(
  expeditionNumber = 1,
  playerAddress = player.account.address,
  contractInstance = game,
) {
  const contractAddress = contractInstance.address;
  const block = await publicClient.getBlock();
  const issuedAt = Number(block.timestamp);
  const set = {
    player: playerAddress,
    expeditionNumber: BigInt(expeditionNumber),
    sourceCommitment: `0x${'ab'.repeat(32)}`,
    candidateSeeds: [`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`, `0x${'03'.repeat(32)}`],
    combinedCharacterSeed: `0x${'cd'.repeat(32)}`,
    islandGeneratorVersion: 2,
    characterGeneratorVersion: 1,
    sourceSelectionPolicyVersion: 1,
    issuedAt: BigInt(issuedAt),
    expiresAt: BigInt(issuedAt + 7 * 24 * 60 * 60),
  };
  const signature = await attester.signTypedData({
    domain: {
      name: 'Worldseed Candidate Set',
      version: '2',
      chainId: 743111,
      verifyingContract: contractAddress,
    },
    types,
    primaryType: 'CandidateSet',
    message: set,
  });
  const eipHash = hashTypedData({
    domain: {
      name: 'Worldseed Candidate Set',
      version: '2',
      chainId: 743111,
      verifyingContract: contractAddress,
    },
    types,
    primaryType: 'CandidateSet',
    message: set,
  });
  assert.equal(
    (await contractInstance.read.candidateSetDigest([set])).toLowerCase(),
    eipHash.toLowerCase(),
  );
  assert.equal(
    (await recoverAddress({ hash: eipHash, signature })).toLowerCase(),
    attester.account.address.toLowerCase(),
  );
  return { set, signature };
}

it('accepts each attested candidate and preserves the full commitment for deterministic generation', async () => {
  for (let selectedIndex = 0; selectedIndex < 3; selectedIndex += 1) {
    const fresh = await viem.deployContract(
      'WorldseedGameV2',
      [owner.account.address, attester.account.address],
      {
        client: { wallet: owner },
      },
    );
    const { set, signature } = await signedSet(1, player.account.address, fresh);
    const startGas = await fresh.estimateGas.startExpedition([set, selectedIndex, signature], {
      account: player.account,
    });
    if (selectedIndex === 0)
      console.info(`v2 startExpedition estimate: ${startGas} gas (local EVM)`);
    const hash = await fresh.write.startExpedition([set, selectedIndex, signature], {
      account: player.account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    const state = await fresh.read.expeditionState([player.account.address, 1n]);
    assert.equal(state[0], 1);
    assert.equal(state[4], set.candidateSeeds[selectedIndex]);
    assert.equal(state[5], set.sourceCommitment);
    assert.equal(state[6], set.combinedCharacterSeed);
    assert.deepEqual(
      (await fresh.read.expeditionBoard([player.account.address, 1n]))[1],
      [1, 1, 0],
    );
  }
});

it('rejects invalid indices, tampering, wrong wallet, expiry, replay, and double starts', async () => {
  const fresh = await viem.deployContract(
    'WorldseedGameV2',
    [owner.account.address, attester.account.address],
    {
      client: { wallet: owner },
    },
  );
  const { set, signature } = await signedSet(1, player.account.address, fresh);
  await assert.rejects(
    fresh.write.startExpedition([set, 3, signature], { account: player.account }),
  );
  const tampered = {
    ...set,
    candidateSeeds: [`0x${'04'.repeat(32)}`, ...set.candidateSeeds.slice(1)],
  };
  await assert.rejects(
    fresh.write.startExpedition([tampered, 0, signature], { account: player.account }),
  );
  await assert.rejects(
    fresh.write.startExpedition([set, 0, signature], { account: other.account }),
  );
  const wrongNumber = await signedSet(2, player.account.address, fresh);
  await assert.rejects(
    fresh.write.startExpedition([wrongNumber.set, 0, wrongNumber.signature], {
      account: player.account,
    }),
  );
  const wrongContract = await signedSet(1, player.account.address, game);
  await assert.rejects(
    fresh.write.startExpedition([wrongContract.set, 0, wrongContract.signature], {
      account: player.account,
    }),
  );
  const wrongChainSignature = await attester.signTypedData({
    domain: {
      name: 'Worldseed Candidate Set',
      version: '2',
      chainId: 1,
      verifyingContract: fresh.address,
    },
    types,
    primaryType: 'CandidateSet',
    message: set,
  });
  await assert.rejects(
    fresh.write.startExpedition([set, 0, wrongChainSignature], { account: player.account }),
  );
  const expired = { ...set, expiresAt: set.issuedAt - 1n };
  await assert.rejects(
    fresh.write.startExpedition([expired, 0, signature], { account: player.account }),
  );
  const hash = await fresh.write.startExpedition([set, 0, signature], { account: player.account });
  await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(
    await fresh.read.usedCandidateSetDigests([await fresh.read.candidateSetDigest([set])]),
    true,
  );
  await assert.rejects(
    fresh.write.startExpedition([set, 0, signature], { account: player.account }),
  );
});

it('separates consecutive expedition inventory and keeps confirmed account Gold through abandonment', async () => {
  const fresh = await viem.deployContract(
    'WorldseedGameV2',
    [owner.account.address, attester.account.address],
    {
      client: { wallet: owner },
    },
  );
  const { set, signature } = await signedSet(1, player.account.address, fresh);
  await fresh.write.startExpedition([set, 0, signature], { account: player.account });
  await assert.rejects(fresh.write.buyHabitat([1n, 2, 1], { account: player.account }));
  assert.equal(await fresh.read.goldBalances([player.account.address]), 0n);
  assert.deepEqual((await fresh.read.expeditionBoard([player.account.address, 1n]))[1], [1, 1, 0]);
  await fresh.write.saveProgress([1n, 0n, [33, 62]], { account: player.account });
  let state = await fresh.read.expeditionState([player.account.address, 1n]);
  assert.equal(state[2], 1);
  assert.deepEqual((await fresh.read.expeditionBoard([player.account.address, 1n]))[1], [1, 2, 0]);
  await fresh.write.saveProgress([1n, 2n, [60, 62]], { account: player.account });
  assert.deepEqual((await fresh.read.expeditionBoard([player.account.address, 1n]))[1], [1, 2, 0]);
  const contributionHash = await fresh.write.contributeWorldTree([1n, 1], {
    account: player.account,
  });
  await publicClient.waitForTransactionReceipt({ hash: contributionHash });
  const week = await fresh.read.currentWeek();
  assert.equal(await fresh.read.weeklyContributions([week]), 2);
  await assert.rejects(fresh.write.contributeWorldTree([1n, 1], { account: player.account }));
  const abandonGas = await fresh.estimateGas.abandonExpedition([1n], { account: player.account });
  console.info(`v2 abandonExpedition estimate: ${abandonGas} gas (local EVM)`);
  await fresh.write.abandonExpedition([1n], { account: player.account });
  await assert.rejects(fresh.write.saveProgress([1n, 2n, [64]], { account: player.account }));
  await assert.rejects(
    fresh.write.finishExpedition([1n, 2n, [], `0x${'11'.repeat(32)}`], { account: player.account }),
  );
  const second = await signedSet(2, player.account.address, fresh);
  await fresh.write.startExpedition([second.set, 1, second.signature], { account: player.account });
  state = await fresh.read.expeditionState([player.account.address, 2n]);
  assert.equal(state[0], 1);
  assert.deepEqual((await fresh.read.expeditionBoard([player.account.address, 2n]))[1], [1, 1, 0]);
  assert.equal(await fresh.read.goldBalances([player.account.address]), 0n);
});

it('completes a solvable V1-compatible restoration once and keeps its World Tree points', async () => {
  const fresh = await viem.deployContract(
    'WorldseedGameV2',
    [owner.account.address, attester.account.address],
    {
      client: { wallet: owner },
    },
  );
  const { set, signature } = await signedSet(1, player.account.address, fresh);
  await fresh.write.startExpedition([set, 2, signature], { account: player.account });
  const saveGas = await fresh.estimateGas.saveProgress([1n, 0n, witnessVector.actions], {
    account: player.account,
  });
  console.info(`v2 17-action Save Progress estimate: ${saveGas} gas (local EVM)`);
  await fresh.write.saveProgress([1n, 0n, witnessVector.actions], { account: player.account });
  const beforeFinish = await fresh.read.expeditionState([player.account.address, 1n]);
  assert.equal(beforeFinish[2], 4);
  assert.equal(beforeFinish[3], BigInt(witnessVector.actions.length));
  const week = await fresh.read.currentWeek();
  const finishGas = await fresh.estimateGas.finishExpedition(
    [1n, BigInt(witnessVector.actions.length), [], `0x${'11'.repeat(32)}`],
    { account: player.account },
  );
  console.info(`v2 witness Finish estimate: ${finishGas} gas (local EVM)`);
  const hash = await fresh.write.finishExpedition(
    [1n, BigInt(witnessVector.actions.length), [], `0x${'11'.repeat(32)}`],
    { account: player.account },
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  assert.equal(await fresh.read.weeklyContributions([week]), 6);
  assert.equal(
    await fresh.read.expeditionState([player.account.address, 1n]).then((state) => state[0]),
    2,
  );
  await assert.rejects(
    fresh.write.finishExpedition([1n, 17n, [], `0x${'11'.repeat(32)}`], {
      account: player.account,
    }),
  );
  const next = await signedSet(2, player.account.address, fresh);
  await fresh.write.startExpedition([next.set, 0, next.signature], { account: player.account });
  assert.equal((await fresh.read.expeditionState([player.account.address, 2n]))[0], 1);
});

it('uses two-step attester rotation and owner-controlled emergency pause', async () => {
  const fresh = await viem.deployContract(
    'WorldseedGameV2',
    [owner.account.address, attester.account.address],
    {
      client: { wallet: owner },
    },
  );
  await assert.rejects(
    fresh.write.proposeAttester([other.account.address], { account: player.account }),
  );
  await fresh.write.proposeAttester([other.account.address], { account: owner.account });
  await assert.rejects(fresh.write.acceptAttester([], { account: player.account }));
  await fresh.write.acceptAttester([], { account: other.account });
  assert.equal((await fresh.read.attester()).toLowerCase(), other.account.address.toLowerCase());
  const oldSignerSet = await signedSet(1, player.account.address, fresh);
  await assert.rejects(
    fresh.write.startExpedition([oldSignerSet.set, 0, oldSignerSet.signature], {
      account: player.account,
    }),
  );
  await fresh.write.setPaused([true], { account: owner.account });
  const { set, signature } = await signedSet();
  await assert.rejects(
    fresh.write.startExpedition([set, 0, signature], { account: player.account }),
  );
  await fresh.write.setPaused([false], { account: owner.account });
});

it('does not invalidate an active expedition when its candidate attestation later expires', async () => {
  const fresh = await viem.deployContract(
    'WorldseedGameV2',
    [owner.account.address, attester.account.address],
    {
      client: { wallet: owner },
    },
  );
  const { set, signature } = await signedSet(1, player.account.address, fresh);
  await fresh.write.startExpedition([set, 0, signature], { account: player.account });

  const testClient = await viem.getTestClient();
  await testClient.increaseTime({ seconds: 7 * 24 * 60 * 60 + 1 });
  await testClient.mine({ blocks: 1 });

  await fresh.write.saveProgress([1n, 0n, [33]], { account: player.account });
  assert.equal(
    (await fresh.read.expeditionState([player.account.address, 1n]))[3],
    1n,
    'expiry is an issuance check, not an active-run timeout',
  );
});

it('keeps pause authority owner-only and restores active-run actions after unpause', async () => {
  const fresh = await viem.deployContract(
    'WorldseedGameV2',
    [owner.account.address, attester.account.address],
    {
      client: { wallet: owner },
    },
  );
  const { set, signature } = await signedSet(1, player.account.address, fresh);
  await fresh.write.startExpedition([set, 0, signature], { account: player.account });
  await fresh.write.startPuzzleRound([1n, 1], { account: player.account });
  const contributionBefore = await fresh.read.weeklyContributions([await fresh.read.currentWeek()]);

  await assert.rejects(fresh.write.setPaused([true], { account: player.account }));
  await fresh.write.setPaused([true], { account: owner.account });
  await assert.rejects(fresh.write.saveProgress([1n, 0n, [33]], { account: player.account }));
  await assert.rejects(fresh.write.startPuzzleRound([1n, 1], { account: player.account }));
  await fresh.write.abandonExpedition([1n], { account: player.account });
  assert.equal((await fresh.read.expeditionState([player.account.address, 1n]))[0], 3);
  assert.equal(await fresh.read.activeExpeditionId([player.account.address]), 0n);
  assert.equal((await fresh.read.puzzleState([player.account.address]))[0], false);
  assert.equal(
    await fresh.read.weeklyContributions([await fresh.read.currentWeek()]),
    contributionBefore,
  );
  const second = await signedSet(2, player.account.address, fresh);
  await assert.rejects(
    fresh.write.startExpedition([second.set, 0, second.signature], { account: player.account }),
  );
  await fresh.write.setPaused([false], { account: owner.account });
  await fresh.write.startExpedition([second.set, 0, second.signature], { account: player.account });
  assert.equal((await fresh.read.expeditionState([player.account.address, 2n]))[0], 1);
});

it('forfeits an unfinished puzzle on abandonment and permits a later run', async () => {
  const fresh = await viem.deployContract(
    'WorldseedGameV2',
    [owner.account.address, attester.account.address],
    {
      client: { wallet: owner },
    },
  );
  const first = await signedSet(1, player.account.address, fresh);
  await fresh.write.startExpedition([first.set, 0, first.signature], { account: player.account });
  await fresh.write.startPuzzleRound([1n, 1], { account: player.account });
  assert.equal((await fresh.read.puzzleState([player.account.address]))[0], true);
  await fresh.write.abandonExpedition([1n], { account: player.account });
  const forfeited = await fresh.read.puzzleState([player.account.address]);
  assert.equal(forfeited[0], false);
  assert.equal(forfeited[6], 0n);
  await assert.rejects(fresh.write.savePuzzleMoves([0, [0], true], { account: player.account }));

  const second = await signedSet(2, player.account.address, fresh);
  await fresh.write.startExpedition([second.set, 0, second.signature], { account: player.account });
  await fresh.write.startPuzzleRound([2n, 1], { account: player.account });
  assert.equal((await fresh.read.puzzleState([player.account.address]))[0], true);
});

it('preserves V1 2048 settlement math as account Gold after abandoning the expedition', async () => {
  const fresh = await viem.deployContract(
    'WorldseedGameV2',
    [owner.account.address, attester.account.address],
    {
      client: { wallet: owner },
    },
  );
  const { set, signature } = await signedSet(1, player.account.address, fresh);
  await fresh.write.startExpedition([set, 0, signature], { account: player.account });
  const puzzleStartGas = await fresh.estimateGas.startPuzzleRound([1n, 1], {
    account: player.account,
  });
  console.info(`v2 rewarded-round start estimate: ${puzzleStartGas} gas (local EVM)`);
  await fresh.write.startPuzzleRound([1n, 1], { account: player.account });
  const round = await fresh.read.puzzleState([player.account.address]);
  let puzzle = createPuzzleRound(round[4], 'standard');
  const directions = [];
  const names = ['left', 'right', 'up', 'down'];
  while (directions.length < 20 && !puzzle.over) {
    const options = names
      .map((direction, code) => ({ code, result: applyPuzzleMove(puzzle, direction) }))
      .filter(({ result }) => result.valid)
      .sort(
        (a, b) =>
          a.result.state.board.filter((tile) => tile === 0).length -
            b.result.state.board.filter((tile) => tile === 0).length ||
          b.result.state.score - a.result.state.score,
      );
    assert.ok(options.length > 0, 'the model marks game-over when no move remains');
    const selected = options[0];
    directions.push(selected.code);
    puzzle = selected.result.state;
  }
  assert.equal(directions.length, 20);
  const checkpointGas = await fresh.estimateGas.savePuzzleMoves([0, directions, true], {
    account: player.account,
  });
  console.info(`v2 20-move settlement estimate: ${checkpointGas} gas (local EVM)`);
  await fresh.write.savePuzzleMoves([0, directions, true], { account: player.account });
  const expectedGold = BigInt(calculateGoldInteger(puzzle.score, 'standard'));
  assert.equal(await fresh.read.goldBalances([player.account.address]), expectedGold);
  await assert.rejects(
    fresh.write.savePuzzleMoves([0, directions, true], { account: player.account }),
  );
  assert.equal(await fresh.read.goldBalances([player.account.address]), expectedGold);
  await fresh.write.abandonExpedition([1n], { account: player.account });
  const second = await signedSet(2, player.account.address, fresh);
  await fresh.write.startExpedition([second.set, 2, second.signature], { account: player.account });
  assert.equal(await fresh.read.goldBalances([player.account.address]), expectedGold);
});
