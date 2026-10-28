import { countNewCpMilestones, nextCpMilestoneTier } from './cpMilestones';
import type { V3RewardRules } from './types';

const MAX_UINT256 = (1n << 256n) - 1n;

export interface V3RebirthRewardPreviewInput {
  scoreTier: number;
  seasonalHighScoreTier: number;
  seasonalPP: bigint;
  seasonalCP: bigint;
  totalSeasonCP: bigint;
  lifetimeCP: bigint;
  maxSeasonPoints: bigint;
  rules: V3RewardRules;
}

export interface V3RebirthRewardPreview {
  pp: bigint;
  cp: bigint;
  nextCpMilestoneTier: number | null;
  ppCapped: boolean;
  cpCapped: boolean;
}

function remaining(cap: bigint, balance: bigint): bigint {
  return cap > balance ? cap - balance : 0n;
}

function minBigInt(...values: bigint[]): bigint {
  return values.reduce((min, value) => (value < min ? value : min));
}

/** Display-only estimate matching the contract's versioned `_settleRebirth` calculation. */
export function calculateV3RebirthRewardPreview(
  input: V3RebirthRewardPreviewInput,
): V3RebirthRewardPreview {
  const { rules, scoreTier, seasonalHighScoreTier } = input;
  const eligible = scoreTier >= rules.rebirthThresholdTier;
  const rawPP = eligible && rules.ppStep > 0
    ? rules.ppBase + BigInt(Math.floor((scoreTier - rules.rebirthThresholdTier) / rules.ppStep))
    : 0n;
  const rebirthCappedPP = rawPP < rules.ppPerRebirthCap ? rawPP : rules.ppPerRebirthCap;
  const pp = minBigInt(rebirthCappedPP, remaining(rules.seasonPPCap, input.seasonalPP));

  const rawCP = eligible
    ? BigInt(
        countNewCpMilestones(
          scoreTier,
          seasonalHighScoreTier,
          rules.rebirthThresholdTier,
          rules.cpMilestoneStep,
        ),
      )
    : 0n;
  const projectedHighScore = eligible
    ? Math.max(scoreTier, seasonalHighScoreTier)
    : seasonalHighScoreTier;
  const cp = minBigInt(
    rawCP,
    remaining(rules.seasonCPCap, input.seasonalCP),
    remaining(input.maxSeasonPoints, input.totalSeasonCP),
    remaining(MAX_UINT256, input.lifetimeCP),
  );

  return {
    pp,
    cp,
    nextCpMilestoneTier: nextCpMilestoneTier(
      projectedHighScore,
      rules.rebirthThresholdTier,
      rules.cpMilestoneStep,
    ),
    ppCapped: pp < rawPP,
    cpCapped: cp < rawCP,
  };
}
