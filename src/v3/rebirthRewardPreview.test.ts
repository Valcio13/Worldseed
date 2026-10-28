import { describe, expect, it } from 'vitest';
import { calculateV3RebirthRewardPreview } from './rebirthRewardPreview';
import type { V3RewardRules } from './types';

const rules: V3RewardRules = {
  rebirthThresholdTier: 35,
  ppStep: 10,
  ppPerRebirthCap: 1_000n,
  ppBase: 1n,
  seasonPPCap: 100_000n,
  seasonCPCap: 100_000n,
  cpMilestoneStep: 7,
};

function calculate(overrides: Partial<Parameters<typeof calculateV3RebirthRewardPreview>[0]> = {}) {
  return calculateV3RebirthRewardPreview({
    scoreTier: 35,
    seasonalHighScoreTier: 0,
    seasonalPP: 0n,
    seasonalCP: 0n,
    totalSeasonCP: 0n,
    lifetimeCP: 0n,
    maxSeasonPoints: 1_000_000n,
    rules,
    ...overrides,
  });
}

describe('verified Rebirth reward preview', () => {
  it('previews base rewards on a first Rebirth and shows the next CP milestone', () => {
    expect(calculate()).toMatchObject({
      pp: 1n,
      cp: 0n,
      nextCpMilestoneTier: 42,
      ppCapped: false,
      cpCapped: false,
    });
  });

  it('counts only new milestones above the previously claimed seasonal high score', () => {
    expect(calculate({ scoreTier: 56, seasonalHighScoreTier: 42 })).toMatchObject({
      pp: 3n,
      cp: 2n,
      nextCpMilestoneTier: 63,
      cpCapped: false,
    });
  });

  it('moves the projected next milestone past the tier being settled', () => {
    expect(calculate({ scoreTier: 44 })).toMatchObject({
      pp: 1n,
      cp: 1n,
      nextCpMilestoneTier: 49,
    });
  });

  it('applies per-Rebirth, seasonal, and global caps to the estimates', () => {
    const cappedRules = {
      ...rules,
      ppPerRebirthCap: 3n,
      seasonPPCap: 4n,
      seasonCPCap: 10n,
    };
    expect(
      calculate({ scoreTier: 70, rules: { ...rules, ppPerRebirthCap: 2n } }),
    ).toMatchObject({ pp: 2n, ppCapped: true });

    const seasonCapped = calculate({
        scoreTier: 70,
        seasonalHighScoreTier: 35,
        seasonalPP: 3n,
        seasonalCP: 9n,
        totalSeasonCP: 0n,
        maxSeasonPoints: 1_000_000n,
        rules: cappedRules,
      });
    expect(seasonCapped).toMatchObject({ pp: 1n, cp: 1n, ppCapped: true, cpCapped: true });

    const globalCapped = calculate({
      scoreTier: 70,
      seasonalHighScoreTier: 35,
      totalSeasonCP: 999_999n,
      maxSeasonPoints: 1_000_000n,
      rules: cappedRules,
    });
    expect(globalCapped).toMatchObject({ cp: 1n, cpCapped: true });

    const lifetimeCapped = calculate({
      scoreTier: 70,
      seasonalHighScoreTier: 35,
      lifetimeCP: (1n << 256n) - 2n,
    });
    expect(lifetimeCapped).toMatchObject({ cp: 1n, cpCapped: true });
  });
});
