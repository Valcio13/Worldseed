import { describe, expect, it } from 'vitest';
import { applyPuzzleMove, createPuzzleRound, directionFromCode } from './engine';
import {
  commitCheckpointAfterSuccess,
  isCheckpointFull,
  queueCheckpointMove,
  restoreCheckpointMoves,
} from './checkpoint';

function legalCodes(seed: number, count: number): number[] {
  let state = createPuzzleRound(seed);
  const codes: number[] = [];
  while (codes.length < count && !state.over) {
    let found = false;
    for (const code of [0, 1, 2, 3]) {
      const direction = directionFromCode(code)!;
      const moved = applyPuzzleMove(state, direction);
      if (!moved.valid) continue;
      codes.push(code);
      state = moved.state;
      found = true;
      break;
    }
    if (!found) break;
  }
  if (codes.length !== count) throw new Error(`Could not generate ${count} legal moves.`);
  return codes;
}

function replay(seed: number, codes: number[]) {
  return codes.reduce((state, code) => {
    const result = applyPuzzleMove(state, directionFromCode(code)!);
    if (!result.valid) throw new Error(`Move ${code} was invalid in fixture.`);
    return result.state;
  }, createPuzzleRound(seed));
}

describe('rewarded 2048 checkpoints', () => {
  it('permits moves 19 and 20 in a batch and blocks move 21 until checkpointed', () => {
    const pending = legalCodes(98765, 20).slice(0, 19);
    expect(isCheckpointFull(pending)).toBe(false);
    const twentieth = queueCheckpointMove(pending, legalCodes(98765, 20)[19]!);
    expect(twentieth).toHaveLength(20);
    expect(isCheckpointFull(twentieth!)).toBe(true);
    expect(queueCheckpointMove(twentieth!, 0)).toBeNull();
  });

  it('advances after a successful checkpoint and preserves the queue after rejection', async () => {
    const pending = legalCodes(98765, 21);
    const rejectReceipt = async () => Promise.reject(new Error('wallet rejected'));
    await expect(commitCheckpointAfterSuccess(0, pending, 20, rejectReceipt)).rejects.toThrow(
      'wallet rejected',
    );
    expect(pending).toHaveLength(21);

    const saved = await commitCheckpointAfterSuccess(0, pending, 20, async () => ({
      status: 'success',
    }));
    expect(saved).toEqual({ confirmedMoves: 20, pending: pending.slice(20) });
    expect(queueCheckpointMove(saved.pending, 99)).toEqual([...pending.slice(20), 99]);
    expect(replay(98765, pending).validMoves).toBe(21);
  });

  it('restores unsaved moves after reload on top of the confirmed checkpoint', () => {
    const all = legalCodes(98765, 23);
    const confirmed = replay(98765, all.slice(0, 20));
    const recovered = restoreCheckpointMoves(confirmed, {
      seed: String(confirmed.seed),
      cursor: confirmed.validMoves,
      directions: all.slice(20),
    });

    expect(recovered.directions).toEqual(all.slice(20));
    expect(recovered.state).toEqual(replay(98765, all));
  });
});
