import { applyPuzzleMove, directionFromCode, MAX_SAVED_MOVES, type PuzzleState } from './engine';

export interface PendingCheckpoint {
  seed: string;
  cursor: number;
  directions: number[];
}

export function isCheckpointFull(directions: number[]): boolean {
  return directions.length >= MAX_SAVED_MOVES;
}

export function queueCheckpointMove(directions: number[], direction: number): number[] | null {
  if (isCheckpointFull(directions)) return null;
  return [...directions, direction];
}

export function commitCheckpoint(
  confirmedMoves: number,
  pending: number[],
  submittedCount: number,
): { confirmedMoves: number; pending: number[] } {
  const count = Math.min(Math.max(0, submittedCount), pending.length);
  return {
    confirmedMoves: confirmedMoves + count,
    pending: pending.slice(count),
  };
}

/** A checkpoint queue is consumed only after the caller confirms a successful receipt. */
export async function commitCheckpointAfterSuccess<T extends { status: string }>(
  confirmedMoves: number,
  pending: number[],
  submittedCount: number,
  waitForReceipt: () => Promise<T>,
): Promise<{ confirmedMoves: number; pending: number[] }> {
  await waitForReceipt();
  return commitCheckpoint(confirmedMoves, pending, submittedCount);
}

/** Replays only same-round queued moves on top of an authoritative chain checkpoint. */
export function restoreCheckpointMoves(
  confirmed: PuzzleState,
  stored: PendingCheckpoint | null,
): { state: PuzzleState; directions: number[] } {
  if (
    stored?.seed !== String(confirmed.seed) ||
    stored.cursor !== confirmed.validMoves ||
    !Array.isArray(stored.directions)
  ) {
    return { state: confirmed, directions: [] };
  }

  let state = confirmed;
  const directions: number[] = [];
  for (const code of stored.directions) {
    const direction = directionFromCode(code);
    if (!direction || directions.length >= MAX_SAVED_MOVES) break;
    const next = applyPuzzleMove(state, direction);
    if (!next.valid) break;
    state = next.state;
    directions.push(code);
  }
  return { state, directions };
}
