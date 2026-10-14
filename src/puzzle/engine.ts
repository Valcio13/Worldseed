export const PUZZLE_SIZE = 4 as const;
export const PUZZLE_CELLS = PUZZLE_SIZE * PUZZLE_SIZE;
export const MAX_ROUND_MOVES = 200;
export const MAX_SAVED_MOVES = 20;
export const CASH_OUT_AFTER = 20;

export type PuzzleMode = 'relaxed' | 'standard' | 'challenging';
export type Direction = 'left' | 'right' | 'up' | 'down';
export type Tile = number;
export type PuzzleBoard = Tile[];

export const MODES: Record<
  PuzzleMode,
  { label: string; fourPercent: number; rewardNumerator: number; rewardDenominator: number }
> = {
  relaxed: { label: 'Relaxed', fourPercent: 5, rewardNumerator: 3, rewardDenominator: 8 },
  standard: { label: 'Standard', fourPercent: 10, rewardNumerator: 1, rewardDenominator: 2 },
  challenging: { label: 'Challenging', fourPercent: 25, rewardNumerator: 5, rewardDenominator: 8 },
};

export const DIRECTION_CODES: Record<Direction, number> = {
  left: 0,
  right: 1,
  up: 2,
  down: 3,
};

export function directionFromCode(code: number): Direction | undefined {
  return (['left', 'right', 'up', 'down'] as const)[code];
}

export interface PuzzleState {
  seed: number;
  rngState: number;
  mode: PuzzleMode;
  board: PuzzleBoard;
  score: number;
  validMoves: number;
  over: boolean;
  reached2048: boolean;
}

export interface MoveResult {
  state: PuzzleState;
  valid: boolean;
  merged: number;
  spawned?: { index: number; value: number };
  scoreIncrease: number;
}

function normalizeSeed(seed: number): number {
  const normalized = seed >>> 0;
  return normalized || 0x6d2b79f5;
}

export function nextRandom(state: number): number {
  let value = normalizeSeed(state);
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function spawn(board: PuzzleBoard, rngState: number, mode: PuzzleMode) {
  const empty: number[] = [];
  for (let i = 0; i < PUZZLE_CELLS; i++) if (board[i] === 0) empty.push(i);
  if (!empty.length) return { rngState, spawned: undefined };

  rngState = nextRandom(rngState);
  const index = empty[rngState % empty.length]!;
  rngState = nextRandom(rngState);
  const value = rngState % 100 < MODES[mode].fourPercent ? 2 : 1;
  board[index] = value;
  return { rngState, spawned: { index, value } };
}

export function createPuzzleRound(seed: number, mode: PuzzleMode = 'standard'): PuzzleState {
  const normalizedSeed = normalizeSeed(seed);
  const board = Array<number>(PUZZLE_CELLS).fill(0);
  let rngState = normalizedSeed;
  rngState = spawn(board, rngState, mode).rngState;
  rngState = spawn(board, rngState, mode).rngState;
  return {
    seed: normalizedSeed,
    rngState,
    mode,
    board,
    score: 0,
    validMoves: 0,
    over: false,
    reached2048: false,
  };
}

function lineIndexes(line: number, direction: Direction): number[] {
  switch (direction) {
    case 'left':
      return [0, 1, 2, 3].map((column) => line * 4 + column);
    case 'right':
      return [3, 2, 1, 0].map((column) => line * 4 + column);
    case 'up':
      return [0, 1, 2, 3].map((row) => row * 4 + line);
    case 'down':
      return [3, 2, 1, 0].map((row) => row * 4 + line);
  }
}

function hasMoves(board: PuzzleBoard): boolean {
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      const index = row * 4 + column;
      if (board[index] === 0) return true;
      if (column < 3 && board[index] === board[index + 1]) return true;
      if (row < 3 && board[index] === board[index + 4]) return true;
    }
  }
  return false;
}

export function isPuzzleOver(board: PuzzleBoard): boolean {
  return !hasMoves(board);
}

export function applyPuzzleMove(state: PuzzleState, direction: Direction): MoveResult {
  if (state.over || state.validMoves >= MAX_ROUND_MOVES)
    return { state, valid: false, merged: 0, scoreIncrease: 0 };

  const board = [...state.board];
  let merged = 0;
  let scoreIncrease = 0;
  for (let line = 0; line < 4; line++) {
    const indexes = lineIndexes(line, direction);
    const values = indexes.map((index) => board[index]!).filter((value) => value !== 0);
    const compacted: number[] = [];
    for (let index = 0; index < values.length; index++) {
      if (values[index] === values[index + 1]) {
        const next = values[index]! + 1;
        compacted.push(next);
        scoreIncrease += 2 ** next;
        merged++;
        index++;
      } else compacted.push(values[index]!);
    }
    indexes.forEach((cell, offset) => {
      board[cell] = compacted[offset] ?? 0;
    });
  }

  const moved = board.some((value, index) => value !== state.board[index]);
  if (!moved) return { state, valid: false, merged: 0, scoreIncrease: 0 };

  const { rngState, spawned } = spawn(board, state.rngState, state.mode);
  const nextState: PuzzleState = {
    ...state,
    board,
    rngState,
    score: state.score + scoreIncrease,
    validMoves: state.validMoves + 1,
    over: state.validMoves + 1 >= MAX_ROUND_MOVES || isPuzzleOver(board),
    reached2048: state.reached2048 || board.includes(11),
  };
  return { state: nextState, valid: true, merged, spawned, scoreIncrease };
}

export function calculateGoldInteger(score: number, mode: PuzzleMode): number {
  const { rewardNumerator, rewardDenominator } = MODES[mode];
  return Number((BigInt(score) * BigInt(rewardNumerator)) / BigInt(rewardDenominator));
}
