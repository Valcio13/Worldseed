/**
 * Weekly guest seasons use the same fixed UTC calendar as the planned V3 contract.
 * IDs are integer weeks since Monday 1970-01-05 00:00 UTC. Keep this module pure so
 * a trusted chain timestamp can replace the local clock at the caller boundary.
 */
export const SEASON_LENGTH_MS = 7 * 24 * 60 * 60 * 1000;
export const SEASON_EPOCH_MONDAY_MS = Date.UTC(1970, 0, 5);

export function seasonIdAt(timestampMs: number): number {
  if (!Number.isSafeInteger(timestampMs))
    throw new RangeError('Timestamp must be an integer in milliseconds.');
  return Math.floor((timestampMs - SEASON_EPOCH_MONDAY_MS) / SEASON_LENGTH_MS);
}

export function seasonStartAt(seasonId: number): number {
  if (!Number.isSafeInteger(seasonId)) throw new RangeError('Season ID must be an integer.');
  return SEASON_EPOCH_MONDAY_MS + seasonId * SEASON_LENGTH_MS;
}

export function nextSeasonStartAt(timestampMs: number): number {
  return seasonStartAt(seasonIdAt(timestampMs) + 1);
}
