import { describe, expect, it } from 'vitest';
import {
  buyHabitat,
  buyHabitatProductionUpgrade,
  buyPPUpgrade,
  canRebirth,
  clickIslandHeart,
  createEconomyState,
  FIRST_REBIRTH_REQUIREMENT,
  HABITATS,
  REBIRTH_MULTIPLIERS,
  performRebirth,
  productionPerSecond,
  rebirthReward,
  rebirthRequirement,
  tickEconomy,
  type EconomyState,
  type HabitatKind,
} from '../../src/incremental/engine';
import {
  addValues,
  compareValues,
  multiplyByNumber,
  subtractValues,
  valueToNumber,
  valueFromNumber,
} from '../../src/incremental/decimal';

interface RebirthSample {
  second: number;
  ppEarned: number;
  ppSpentOnGrowth: number;
  growthLevel: number;
}

type RewardApproach = 'current' | 'hard-cap-10' | 'diminishing-10';
type PPInvestment = 'growth' | 'rebirth';

function natureDerivedBaseReward(state: EconomyState): number {
  const required = rebirthRequirement(state);
  if (compareValues(state.runNature, required) <= 0) return 1;
  const ratio = Math.min(
    1e12,
    (10 ** Math.min(12, state.runNature.exponent - required.exponent) * state.runNature.mantissa) /
      required.mantissa,
  );
  return Math.sqrt(ratio);
}

function ppAward(state: EconomyState, approach: RewardApproach): number {
  if (approach === 'current') return rebirthReward(state).pp;
  const baseReward = natureDerivedBaseReward(state);
  const adjustedBase =
    approach === 'hard-cap-10'
      ? Math.min(baseReward, 10)
      : baseReward <= 10
        ? baseReward
        : 10 + 10 * Math.log2(baseReward / 10);
  const rebirthBonus = 1 + state.personalUpgrades.rebirth * 0.25;
  return Math.max(1, Math.floor(adjustedBase * rebirthBonus));
}

function effectiveRebirthGoal(state: EconomyState) {
  const currentGoal = rebirthRequirement(state);
  const awakeningGrant = valueFromNumber(5 * state.personalUpgrades.awakening);
  if (compareValues(currentGoal, awakeningGrant) > 0) return currentGoal;
  const step = REBIRTH_MULTIPLIERS[Math.min(state.seasonRebirths, REBIRTH_MULTIPLIERS.length - 1)]!;
  return addValues(awakeningGrant, multiplyByNumber(FIRST_REBIRTH_REQUIREMENT, step * 0.1));
}

function applyRebirth(state: EconomyState, approach: RewardApproach): EconomyState {
  const reborn = performRebirth(state).state;
  return {
    ...reborn,
    seasonalPP: state.seasonalPP + ppAward(state, approach),
  };
}

function investPP(state: EconomyState, investment: PPInvestment): EconomyState {
  while (
    state.seasonalPP >= state.personalUpgrades[investment] + 1 &&
    state.personalUpgrades[investment] < 100
  ) {
    const upgrade = buyPPUpgrade(state, investment);
    if (upgrade.error) break;
    state = upgrade.state;
  }
  return state;
}

function purchasedHabitatUpgradeCount(state: EconomyState): number {
  return Object.values(state.habitatProductionUpgrades ?? {}).reduce(
    (sum, level) => sum + level,
    0,
  );
}

function chooseBestAffordableInvestment(state: EconomyState): EconomyState {
  let choice = state;
  let bestPayback = Number.POSITIVE_INFINITY;
  const consider = (candidate: EconomyState, available: boolean) => {
    if (!available) return;
    const deltaRate =
      valueToNumber(productionPerSecond(candidate)) - valueToNumber(productionPerSecond(state));
    const spent = valueToNumber(subtractValues(state.nature, candidate.nature));
    const payback = deltaRate > 0 ? spent / deltaRate : Number.POSITIVE_INFINITY;
    if (payback < bestPayback) {
      bestPayback = payback;
      choice = candidate;
    }
  };
  for (const habitat of HABITATS) {
    const purchase = buyHabitat(state, habitat, 1);
    consider(purchase.state, !purchase.error);
    const upgrade = buyHabitatProductionUpgrade(state, habitat);
    consider(upgrade.state, !upgrade.error);
  }
  return choice;
}

function rebirthGoalAtBase(state: EconomyState, baseNature: number) {
  return multiplyByNumber(
    rebirthRequirement(state),
    baseNature / valueToNumber(FIRST_REBIRTH_REQUIREMENT),
  );
}

/** Use the production engine's real reward/reset code while changing only the simulated gate. */
function performRebirthAtGoal(
  state: EconomyState,
  customGoal: ReturnType<typeof rebirthRequirement>,
) {
  const canonicalGoal = rebirthRequirement(state);
  const scaledRunNature = multiplyByNumber(
    state.runNature,
    valueToNumber(canonicalGoal) / valueToNumber(customGoal),
  );
  return performRebirth({ ...state, runNature: scaledRunNature });
}

function simulateThreshold(baseNature: number, rebirthCount = 6, maxSeconds = 7 * 24 * 60 * 60) {
  let state = createEconomyState(1);
  let clickRemainder = 0;
  const samples: RebirthSample[] = [];
  for (let second = 1; second <= maxSeconds && samples.length < rebirthCount; second += 1) {
    clickRemainder += 1;
    const clicks = Math.floor(clickRemainder);
    clickRemainder -= clicks;
    for (let click = 0; click < clicks; click += 1) state = clickIslandHeart(state).state;
    state = tickEconomy(state, 1);
    state = chooseBestAffordableInvestment(state);

    const customGoal = rebirthGoalAtBase(state, baseNature);
    if (compareValues(state.runNature, customGoal) < 0) continue;

    const beforePP = state.seasonalPP;
    const reborn = performRebirthAtGoal(state, customGoal).state;
    const ppEarned = reborn.seasonalPP - beforePP;
    state = reborn;
    let ppSpentOnGrowth = 0;
    while (
      state.seasonalPP >= state.personalUpgrades.growth + 1 &&
      state.personalUpgrades.growth < 100
    ) {
      const upgraded = buyPPUpgrade(state, 'growth');
      if (upgraded.error) break;
      state = upgraded.state;
      ppSpentOnGrowth += state.personalUpgrades.growth;
    }
    samples.push({
      second,
      ppEarned,
      ppSpentOnGrowth,
      growthLevel: state.personalUpgrades.growth,
    });
  }
  return { baseNature, samples };
}

function simulateImmediateForDuration(
  seconds: number,
  approach: RewardApproach = 'current',
  investment: PPInvestment = 'growth',
) {
  let state = createEconomyState(1);
  let clickRemainder = 0;
  let totalPPEarned = 0;
  let rebirths = 0;
  let milestoneUpgradesPurchased = 0;
  for (let second = 1; second <= seconds; second += 1) {
    clickRemainder += 1;
    const clicks = Math.floor(clickRemainder);
    clickRemainder -= clicks;
    for (let click = 0; click < clicks; click += 1) state = clickIslandHeart(state).state;
    state = tickEconomy(state, 1);
    const priorUpgradeCount = purchasedHabitatUpgradeCount(state);
    state = chooseBestAffordableInvestment(state);
    milestoneUpgradesPurchased += purchasedHabitatUpgradeCount(state) - priorUpgradeCount;
    if (!canRebirth(state)) continue;
    const beforePP = state.seasonalPP;
    state = applyRebirth(state, approach);
    totalPPEarned += state.seasonalPP - beforePP;
    rebirths += 1;
    state = investPP(state, investment);
  }
  return {
    rebirths,
    totalPPEarned,
    growthLevel: state.personalUpgrades.growth,
    rebirthUpgradeLevel: state.personalUpgrades.rebirth,
    milestoneUpgradesPurchased,
  };
}

function simulateSavedHabitatRun(maxSeconds = 7 * 24 * 60 * 60) {
  let state = createEconomyState(1);
  let clickRemainder = 0;
  const firstBoughtAt: Partial<Record<HabitatKind, number>> = {};
  const purchasePlan: Array<{ habitat: HabitatKind; level: number }> = [
    { habitat: 'water', level: 1 },
    { habitat: 'grass', level: 1 },
    { habitat: 'forest', level: 1 },
    { habitat: 'mountain', level: 1 },
    { habitat: 'crystal-cavern', level: 1 },
    { habitat: 'ancient-grove', level: 1 },
    { habitat: 'water', level: 10 },
  ];
  let planIndex = 0;
  let firstUpgradeAt: number | null = null;
  let firstUpgradeCost = 0;
  let firstUpgradeGainPerSecond = 0;
  let firstRebirthAt: number | null = null;

  for (let second = 1; second <= maxSeconds; second += 1) {
    clickRemainder += 1;
    const clicks = Math.floor(clickRemainder);
    clickRemainder -= clicks;
    for (let click = 0; click < clicks; click += 1) state = clickIslandHeart(state).state;
    state = tickEconomy(state, 1);

    const target = purchasePlan[planIndex];
    if (target) {
      const currentLevel = state.habitats[target.habitat] ?? 0;
      if (currentLevel < target.level) {
        const purchase = buyHabitat(state, target.habitat, 1);
        if (!purchase.error) {
          state = purchase.state;
          if (currentLevel === 0) firstBoughtAt[target.habitat] ??= second;
        }
      }
      if ((state.habitats[target.habitat] ?? 0) >= target.level) planIndex += 1;
      continue;
    }

    const beforeNature = state.nature;
    const beforeRate = productionPerSecond(state);
    const upgrade = buyHabitatProductionUpgrade(state, 'water');
    if (!upgrade.error) {
      state = upgrade.state;
      firstUpgradeAt = second;
      firstUpgradeCost = valueToNumber(subtractValues(beforeNature, state.nature));
      firstUpgradeGainPerSecond =
        valueToNumber(productionPerSecond(state)) - valueToNumber(beforeRate);
    }
    if (firstUpgradeAt !== null && canRebirth(state)) {
      firstRebirthAt = second;
      const beforePP = state.seasonalPP;
      const reward = performRebirth(state);
      return {
        firstBoughtAt,
        firstUpgradeAt,
        firstUpgradeCost,
        firstUpgradeGainPerSecond,
        firstRebirthAt,
        runNatureAtRebirth: valueToNumber(state.runNature),
        rewardPP: reward.state.seasonalPP - beforePP,
        rewardCP: reward.state.seasonalCP - state.seasonalCP,
        completedPlan: true,
      };
    }
  }
  return {
    firstBoughtAt,
    firstUpgradeAt,
    firstUpgradeCost,
    firstUpgradeGainPerSecond,
    firstRebirthAt,
    runNatureAtRebirth: valueToNumber(state.runNature),
    rewardPP: 0,
    rewardCP: 0,
    completedPlan: false,
  };
}

function simulateRepeatedSavedRuns(
  durationSeconds: number,
  holdAfterUpgradeSeconds: number,
  approach: RewardApproach = 'current',
  investment: PPInvestment = 'growth',
) {
  let state = createEconomyState(1);
  let clickRemainder = 0;
  let planIndex = 0;
  let upgradeBoughtAt: number | null = null;
  let firstUpgradeAt: number | null = null;
  let totalPPEarned = 0;
  let maxPPPerRebirth = 0;
  let milestoneUpgradesPurchased = 0;
  const rebirthTimes: number[] = [];
  const ppPerRebirth: number[] = [];
  const plan: Array<{ habitat: HabitatKind; level: number }> = [
    { habitat: 'water', level: 1 },
    { habitat: 'grass', level: 1 },
    { habitat: 'forest', level: 1 },
    { habitat: 'mountain', level: 1 },
    { habitat: 'crystal-cavern', level: 1 },
    { habitat: 'ancient-grove', level: 1 },
    { habitat: 'water', level: 10 },
  ];

  for (let second = 1; second <= durationSeconds; second += 1) {
    clickRemainder += 1;
    const clicks = Math.floor(clickRemainder);
    clickRemainder -= clicks;
    for (let click = 0; click < clicks; click += 1) state = clickIslandHeart(state).state;
    state = tickEconomy(state, 1);

    const target = plan[planIndex];
    if (target) {
      if ((state.habitats[target.habitat] ?? 0) < target.level) {
        const purchase = buyHabitat(state, target.habitat, 1);
        if (!purchase.error) state = purchase.state;
      }
      if ((state.habitats[target.habitat] ?? 0) >= target.level) planIndex += 1;
      continue;
    }

    if (upgradeBoughtAt === null) {
      const upgrade = buyHabitatProductionUpgrade(state, 'water');
      if (!upgrade.error) {
        state = upgrade.state;
        milestoneUpgradesPurchased += 1;
        upgradeBoughtAt = second;
        firstUpgradeAt ??= second;
      }
    }
    if (
      upgradeBoughtAt !== null &&
      second - upgradeBoughtAt >= holdAfterUpgradeSeconds &&
      canRebirth(state)
    ) {
      const beforePP = state.seasonalPP;
      state = applyRebirth(state, approach);
      const reward = state.seasonalPP - beforePP;
      totalPPEarned += reward;
      maxPPPerRebirth = Math.max(maxPPPerRebirth, reward);
      ppPerRebirth.push(reward);
      rebirthTimes.push(second);
      state = investPP(state, investment);
      planIndex = 0;
      upgradeBoughtAt = null;
    }
  }
  return {
    firstUpgradeAt,
    rebirthTimes,
    ppPerRebirth,
    totalPPEarned,
    remainingPP: state.seasonalPP,
    growthLevel: state.personalUpgrades.growth,
    rebirthUpgradeLevel: state.personalUpgrades.rebirth,
    milestoneUpgradesPurchased,
    maxPPPerRebirth,
  };
}

describe('Rebirth pacing and longer-run investigation', () => {
  it('sweeps the Awakening safeguard and compares reward formulas for 30-minute play', () => {
    const awakeningSweep = [];
    for (const seasonRebirths of [0, 1, 5, 10, REBIRTH_MULTIPLIERS.length - 1]) {
      for (let awakening = 0; awakening <= 100; awakening += 1) {
        const state = {
          ...createEconomyState(1),
          seasonRebirths,
          personalUpgrades: { ...createEconomyState(1).personalUpgrades, awakening },
        };
        const oldGoal = rebirthRequirement(state);
        const gift = valueFromNumber(awakening * 5);
        const safeGoal = effectiveRebirthGoal(state);
        expect(compareValues(safeGoal, gift)).toBeGreaterThan(0);
        if (compareValues(oldGoal, gift) > 0) expect(safeGoal).toEqual(oldGoal);
      }
    }
    for (const awakening of [16, 17, 100]) {
      const state = {
        ...createEconomyState(1),
        personalUpgrades: { ...createEconomyState(1).personalUpgrades, awakening },
      };
      awakeningSweep.push({
        awakening,
        oldGoal: valueToNumber(rebirthRequirement(state)),
        grant: awakening * 5,
        effectiveGoal: valueToNumber(effectiveRebirthGoal(state)),
      });
    }

    const approaches: RewardApproach[] = ['current', 'hard-cap-10', 'diminishing-10'];
    const rewardComparison = approaches.map((approach) => ({
      approach,
      immediateGrowth: simulateImmediateForDuration(30 * 60, approach, 'growth'),
      immediateRebirthUpgrade: simulateImmediateForDuration(30 * 60, approach, 'rebirth'),
      savedThenRebirthWithoutHold: simulateRepeatedSavedRuns(30 * 60, 0, approach, 'growth'),
      savedThenRebirthGrowth: simulateRepeatedSavedRuns(30 * 60, 205, approach, 'growth'),
      savedThenRebirthUpgrade: simulateRepeatedSavedRuns(30 * 60, 205, approach, 'rebirth'),
    }));
    console.log(
      'AWAKENING_AND_PP_FORMULA_COMPARISON',
      JSON.stringify({ awakeningSweep, rewardComparison }),
    );
    expect(awakeningSweep).toHaveLength(3);
    expect(rewardComparison).toHaveLength(3);
  });

  it('compares lower and higher rebirth gates under the same balanced policy', () => {
    const thresholds = [1_000, 2_000, 5_000, 10_000].map((base) => simulateThreshold(base, 6));
    const thirtyMinuteThresholds = [1_000, 2_000, 5_000, 10_000].map((base) => {
      const result = simulateThreshold(base, 1_000, 30 * 60);
      return {
        baseNature: base,
        rebirths: result.samples.length,
        ppEarned: result.samples.reduce((sum, { ppEarned }) => sum + ppEarned, 0),
        growthAfterLast: result.samples.at(-1)?.growthLevel ?? 0,
      };
    });
    console.log(
      'THRESHOLD_COMPARISON',
      JSON.stringify({
        firstSix: thresholds.map(({ baseNature, samples }) => ({
          baseNature,
          rebirthTimes: samples.map(({ second }) => second),
          rebirthIntervals: samples.map(
            (cycle, index) => cycle.second - (samples[index - 1]?.second ?? 0),
          ),
          rewardsPerRebirth: samples.map(({ ppEarned }) => ppEarned),
          growthAfterEach: samples.map(({ growthLevel }) => growthLevel),
        })),
        thirtyMinutes: thirtyMinuteThresholds,
      }),
    );
    expect(thresholds.every(({ samples }) => samples.length === 6)).toBe(true);
  });

  it('measures a deliberate save-and-upgrade run against immediate Rebirth PP', () => {
    const savedRun = simulateSavedHabitatRun();
    const immediate = simulateImmediateForDuration(savedRun.firstRebirthAt ?? 0);
    const thirtyMinuteImmediate = simulateImmediateForDuration(30 * 60);
    const thirtyMinuteSaved = simulateRepeatedSavedRuns(30 * 60, 0);
    const thirtyMinuteSavedWithPaybackHold = simulateRepeatedSavedRuns(30 * 60, 205);
    console.log(
      'SAVED_HABITAT_RUN',
      JSON.stringify({
        ...savedRun,
        immediateStrategyAtSameTime: immediate,
        delayedPPPerMinute: savedRun.rewardPP / ((savedRun.firstRebirthAt ?? 1) / 60),
        immediatePPPerMinute: immediate.totalPPEarned / ((savedRun.firstRebirthAt ?? 1) / 60),
        thirtyMinuteComparison: {
          immediate: thirtyMinuteImmediate,
          saveUpgradeThenRebirth: thirtyMinuteSaved,
          saveUpgradeThenWait205Seconds: thirtyMinuteSavedWithPaybackHold,
        },
      }),
    );
    expect(savedRun.completedPlan).toBe(true);
    expect(savedRun.firstUpgradeAt).not.toBeNull();
    expect(savedRun.firstRebirthAt).not.toBeNull();
  });
});
