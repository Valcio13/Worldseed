import assert from 'node:assert/strict';
import { before, it } from 'node:test';
import { network } from 'hardhat';
import witnessVector from '../shared/witness-v1.json' with { type: 'json' };
import { applyPuzzleMove, calculateGoldInteger, createPuzzleRound } from '../src/puzzle/engine.ts';

let viem;
let player;
let game;

before(async () => {
  ({ viem } = await network.create());
  [player] = await viem.getWalletClients();
  game = await viem.deployContract('WorldseedGame', [], { client: { wallet: player } });
});

it('grants starter resources once and rejects duplicate starts', async () => {
  await game.write.startIsland([123n]);
  const state = await game.read.islandState([player.account.address]);
  assert.equal(state[0], true);
  assert.deepEqual(state[6], [1, 1, 0]);
  await assert.rejects(game.write.startIsland([456n]));
});

it('replays ordered actions, unlocks a milestone once, and rejects stale cursors', async () => {
  // (1,1) Water, then adjacent (1,2) Grass, unlock the Dry Basin.
  await game.write.saveProgress([0n, [33, 62]]);
  const state = await game.read.islandState([player.account.address]);
  assert.equal(state[2], 1);
  assert.equal(state[3], 2n);
  assert.deepEqual(state[6], [1, 2, 0]);
  await assert.rejects(game.write.saveProgress([0n, [36]]));
});

it('rejects locked placement and prevents an unbacked resource spend', async () => {
  const [second] = await viem.getWalletClients({ count: 2 });
  const other = await viem.deployContract('WorldseedGame', [], { client: { wallet: second } });
  await other.write.startIsland([1n]);
  await assert.rejects(other.write.saveProgress([0n, [72]])); // highlands cell before unlock
  await other.write.saveProgress([0n, [33, 62]]);
  await assert.rejects(other.write.saveProgress([2n, [67]])); // Forest without inventory
  const state = await other.read.islandState([second.account.address]);
  assert.equal(state[3], 2n);
  assert.deepEqual(state[6], [1, 2, 0]);
});

it('allows an empty finish tail after a synced cursor and enforces the completion predicate', async () => {
  await assert.rejects(game.write.finishIsland([2n, [], `0x${'00'.repeat(32)}`]));
});

it('accepts the shared v1 completion witness and credits six World Tree points', async () => {
  const witnessGame = await viem.deployContract('WorldseedGame', [], {
    client: { wallet: player },
  });
  assert.equal(await witnessGame.read.GENERATOR_VERSION(), 1);
  await witnessGame.write.startIsland([987654321n]);
  const witness = witnessVector.actions;
  const twentyActionBatch = [...witness, 48, 50, 104];
  const saveGas = await witnessGame.estimateGas.saveProgress([0n, twentyActionBatch]);
  assert.ok(saveGas > 0n);
  console.info(`v1 max-size Save Progress estimate: ${saveGas} gas (local EVM)`);
  await witnessGame.write.saveProgress([0n, witness]);
  const state = await witnessGame.read.islandState([player.account.address]);
  assert.equal(state[2], 4);
  assert.equal(state[3], 17n);
  const finishGas = await witnessGame.estimateGas.finishIsland([17n, [], `0x${'11'.repeat(32)}`]);
  assert.ok(finishGas > 0n);
  console.info(`v1 witness Finish estimate: ${finishGas} gas (local EVM)`);
  await witnessGame.write.finishIsland([17n, [], `0x${'11'.repeat(32)}`]);
  const afterFinish = await witnessGame.read.islandState([player.account.address]);
  assert.equal(afterFinish[1], true);
  const week = await witnessGame.read.currentWeek();
  assert.equal(await witnessGame.read.weeklyContributions([week]), 6);
});

it('replays 2048 moves across checkpoints, consumes stamina, and settles verified Gold once', async () => {
  const address = player.account.address;
  assert.deepEqual(await game.read.staminaState([address]), [5, 0n]);
  await game.write.startPuzzleRound([1]); // Standard
  const first = await game.read.puzzleState([address]);
  assert.equal(first[0], true);
  assert.equal(first[1], 1);
  assert.equal(first[2], 0);
  const afterStartStamina = await game.read.staminaState([address]);
  assert.equal(afterStartStamina[0], 4);
  assert.ok(afterStartStamina[1] > 0n);
  const testClient = await viem.getTestClient();
  await testClient.increaseTime({ seconds: 1_799 });
  await testClient.mine({ blocks: 1 });
  assert.equal((await game.read.staminaState([address]))[0], 4);
  await testClient.increaseTime({ seconds: 1 });
  await testClient.mine({ blocks: 1 });
  assert.deepEqual(await game.read.staminaState([address]), [5, 0n]); // offline regeneration

  const mode = 'standard';
  let expected = createPuzzleRound(first[4], mode);
  assert.deepEqual(first[6], expected.board);
  assert.equal(first[5], expected.rngState);
  await assert.rejects(game.write.startPuzzleRound([0])); // one active round per wallet

  const directions = [];
  const available = ['left', 'right', 'up', 'down'];
  const survivalMove = (state) =>
    available
      .map((direction) => ({ direction, ...applyPuzzleMove(state, direction) }))
      .filter((candidate) => candidate.valid)
      .sort(
        (a, b) =>
          a.state.board.filter((tile) => tile === 0).length -
            b.state.board.filter((tile) => tile === 0).length || b.state.score - a.state.score,
      )[0];
  while (directions.length < 20 && !expected.over) {
    const move = survivalMove(expected);
    assert.ok(move, 'the puzzle must report game-over when no direction is valid');
    const { direction } = move;
    directions.push({ direction, state: move.state });
    expected = move.state;
  }
  assert.equal(directions.length, 20);
  const directionCodes = directions.map(
    ({ direction }) => ({ left: 0, right: 1, up: 2, down: 3 })[direction],
  );
  await assert.rejects(game.write.savePuzzleMoves([1, [directionCodes[0]], false])); // stale cursor
  await assert.rejects(game.write.savePuzzleMoves([0, [4], false])); // invalid direction
  await assert.rejects(game.write.savePuzzleMoves([0, Array(21).fill(0), false])); // bounded calldata
  await assert.rejects(game.write.savePuzzleMoves([0, directionCodes.slice(0, 9), true]));
  assert.equal((await game.read.puzzleState([address]))[2], 0); // failed cash-out is atomic

  const maxBatchGas = await game.estimateGas.savePuzzleMoves([0, directionCodes, true]);
  assert.ok(maxBatchGas > 0n);
  console.info(`v1 2048 20-move settle estimate: ${maxBatchGas} gas (local EVM)`);

  let checkpoint = createPuzzleRound(first[4], mode);
  const firstBatch = directionCodes.slice(0, 10);
  await game.write.savePuzzleMoves([0, firstBatch, false]);
  for (const code of firstBatch) {
    const dir = ['left', 'right', 'up', 'down'][code];
    checkpoint = applyPuzzleMove(checkpoint, dir).state;
  }
  const resumed = await game.read.puzzleState([address]);
  assert.equal(resumed[0], true);
  assert.equal(resumed[2], 10);
  assert.equal(resumed[3], checkpoint.score);
  assert.equal(resumed[5], checkpoint.rngState);
  assert.deepEqual(resumed[6], checkpoint.board);

  await game.write.savePuzzleMoves([10, directionCodes.slice(10), true]);
  const settled = await game.read.puzzleState([address]);
  assert.equal(settled[0], false);
  assert.equal(settled[2], 20);
  assert.equal(settled[3], expected.score);
  assert.equal(
    await game.read.goldBalances([address]),
    BigInt(calculateGoldInteger(expected.score, mode)),
  );
  await assert.rejects(game.write.savePuzzleMoves([20, [], true])); // no duplicate payout
});
