import { describe, expect, it } from 'vitest';
import {
  applyPuzzleMove,
  calculateGoldInteger,
  createPuzzleRound,
  isPuzzleOver,
  MODES,
  type PuzzleState,
} from './engine';

describe('2048 puzzle engine', () => {
  it('merges equal tiles once per move and awards the merged tile value', () => {
    const round = createPuzzleRound(123, 'standard');
    round.board = [1, 1, 1, 1, ...Array(12).fill(0)];
    const result = applyPuzzleMove(round, 'left');

    expect(result.valid).toBe(true);
    expect(result.state.board.slice(0, 2)).toEqual([2, 2]);
    expect(result.state.board.filter(Boolean)).toHaveLength(3);
    expect(result.merged).toBe(2);
    expect(result.scoreIncrease).toBe(8);
    expect(result.state.validMoves).toBe(1);
  });

  it('does not count or spawn for an invalid move', () => {
    const round = createPuzzleRound(456, 'standard');
    round.board = [1, ...Array(15).fill(0)];
    const result = applyPuzzleMove(round, 'left');

    expect(result.valid).toBe(false);
    expect(result.state).toBe(round);
    expect(result.state.validMoves).toBe(0);
    expect(result.spawned).toBeUndefined();
  });

  it('generates a deterministic initial board and sequence for each mode', () => {
    for (const mode of Object.keys(MODES) as Array<keyof typeof MODES>) {
      expect(createPuzzleRound(0x12345678, mode)).toEqual(createPuzzleRound(0x12345678, mode));
      expect(createPuzzleRound(0x12345678, mode).board.filter(Boolean)).toHaveLength(2);
    }
  });

  it('uses the configured mode probabilities for tile spawns', () => {
    const results = Object.keys(MODES).map((mode) => {
      let fours = 0;
      for (let seed = 1; seed <= 4000; seed++) {
        if (createPuzzleRound(seed, mode as keyof typeof MODES).board.includes(2)) fours++;
      }
      return fours;
    });
    expect(results[0]).toBeLessThan(results[1]!);
    expect(results[1]).toBeLessThan(results[2]!);
    expect(results[0]).toBeGreaterThan(300);
    expect(results[2]).toBeGreaterThan(700);
  });

  it('detects a naturally blocked board', () => {
    const board = [1, 2, 1, 2, 2, 1, 2, 1, 1, 2, 1, 2, 2, 1, 2, 1];
    expect(isPuzzleOver(board)).toBe(true);
  });

  it('ends naturally before the voluntary cash-out threshold', () => {
    const round: PuzzleState = {
      ...createPuzzleRound(7, 'challenging'),
      rngState: 1,
      board: [1, 0, 2, 1, 2, 1, 2, 1, 1, 2, 1, 2, 2, 1, 2, 1],
    };
    // Find an RNG state that grows a 4 in the only empty cell, keeping the
    // resulting full board free of equal neighbors.
    while (true) {
      const result = applyPuzzleMove(round, 'left');
      if (result.valid && result.state.over) {
        expect(result.state.validMoves).toBe(1);
        expect(result.state.over).toBe(true);
        break;
      }
      round.rngState++;
      if (round.rngState > 10000) throw new Error('Could not construct terminal spawn state');
    }
  });

  it('ends a round at 200 valid moves', () => {
    const round: PuzzleState = {
      ...createPuzzleRound(99),
      board: [1, ...Array(15).fill(0)],
      validMoves: 199,
    };
    const result = applyPuzzleMove(round, 'right');
    expect(result.valid).toBe(true);
    expect(result.state.validMoves).toBe(200);
    expect(result.state.over).toBe(true);
  });

  it('calculates each reward with exact integer arithmetic', () => {
    expect(calculateGoldInteger(101, 'relaxed')).toBe(37);
    expect(calculateGoldInteger(101, 'standard')).toBe(50);
    expect(calculateGoldInteger(101, 'challenging')).toBe(63);
    expect(calculateGoldInteger(0xffff_ffff, 'challenging')).toBe(2_684_354_559);
  });
});
