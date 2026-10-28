/** Shared display calculation for the contract's seasonal CP score milestones. */
export const V3_CP_MILESTONE_STEP = 7;
export const V3_MAX_SCORE_TIER = 65_535;

function assertTier(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > V3_MAX_SCORE_TIER)
    throw new RangeError(`${label} must be an integer score tier from 0 to ${V3_MAX_SCORE_TIER}.`);
}

/** Number of new multiples of `step` crossed above threshold and prior seasonal high-water. */
export function countNewCpMilestones(
  scoreTier: number,
  seasonalHighScoreTier: number,
  rebirthThresholdTier: number,
  step = V3_CP_MILESTONE_STEP,
): number {
  assertTier(scoreTier, 'Score tier');
  assertTier(seasonalHighScoreTier, 'Seasonal high score tier');
  assertTier(rebirthThresholdTier, 'Rebirth threshold tier');
  if (!Number.isSafeInteger(step) || step <= 0)
    throw new RangeError('CP milestone step must be a positive integer.');

  const base = Math.max(seasonalHighScoreTier, rebirthThresholdTier);
  return scoreTier <= base ? 0 : Math.floor(scoreTier / step) - Math.floor(base / step);
}

/** Next eligible absolute milestone, or null when no later milestone fits the score type. */
export function nextCpMilestoneTier(
  seasonalHighScoreTier: number,
  rebirthThresholdTier: number,
  step = V3_CP_MILESTONE_STEP,
): number | null {
  assertTier(seasonalHighScoreTier, 'Seasonal high score tier');
  assertTier(rebirthThresholdTier, 'Rebirth threshold tier');
  if (!Number.isSafeInteger(step) || step <= 0)
    throw new RangeError('CP milestone step must be a positive integer.');
  const base = Math.max(seasonalHighScoreTier, rebirthThresholdTier);
  const next = (Math.floor(base / step) + 1) * step;
  return next <= V3_MAX_SCORE_TIER ? next : null;
}
