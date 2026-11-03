import { describe, expect, it } from 'vitest';
import {
  buyHabitat,
  buyHabitatProductionUpgrade,
  buyPPUpgrade,
  canRebirth,
  clickIslandHeart,
  createEconomyState,
  HABITATS,
  performRebirth,
  productionPerSecond,
  rebirthRequirement,
  tickEconomy,
  type EconomyState,
  type HabitatKind,
  type PPUpgrade,
} from '../../src/incremental/engine';
import { subtractValues, valueToNumber } from '../../src/incremental/decimal';

interface BalanceScenario {
  name: string;
  clicksPerSecond: number;
  purchaseIntervalSeconds: number;
  ppUpgrade: PPUpgrade;
}

interface BalanceRebirth {
  second: number;
  naturePerSecond: number;
  awakeningLevel: number;
  rebirthGoal: number;
  levels: Record<HabitatKind, number>;
  productionUpgrades: Record<HabitatKind, number>;
  habitatKindsOwned: number;
}

function fullLevels(state: EconomyState): Record<HabitatKind, number> {
  return Object.fromEntries(HABITATS.map((kind) => [kind, state.habitats[kind] ?? 0])) as Record<
    HabitatKind,
    number
  >;
}

function upgradeLevels(state: EconomyState): Record<HabitatKind, number> {
  return Object.fromEntries(
    HABITATS.map((kind) => [kind, state.habitatProductionUpgrades?.[kind] ?? 0]),
  ) as Record<HabitatKind, number>;
}

function investmentPayback(state: EconomyState, next: EconomyState): number {
  const productionGain =
    valueToNumber(productionPerSecond(next)) - valueToNumber(productionPerSecond(state));
  const natureSpent = valueToNumber(subtractValues(state.nature, next.nature));
  return productionGain > 0 ? natureSpent / productionGain : Number.POSITIVE_INFINITY;
}

function chooseBestInvestment(state: EconomyState): EconomyState {
  let bestState = state;
  let bestPayback = Number.POSITIVE_INFINITY;
  for (const habitat of HABITATS) {
    const habitatPurchase = buyHabitat(state, habitat, 1);
    if (!habitatPurchase.error) {
      const payback = investmentPayback(state, habitatPurchase.state);
      if (payback < bestPayback) {
        bestPayback = payback;
        bestState = habitatPurchase.state;
      }
    }
    const productionUpgrade = buyHabitatProductionUpgrade(state, habitat);
    if (!productionUpgrade.error) {
      const payback = investmentPayback(state, productionUpgrade.state);
      if (payback < bestPayback) {
        bestPayback = payback;
        bestState = productionUpgrade.state;
      }
    }
  }
  return bestState;
}

function simulateBalanceScenario(
  scenario: BalanceScenario,
  rebirthTarget = 6,
  maxSeconds = 7 * 24 * 60 * 60,
) {
  let state = createEconomyState(1);
  let clickRemainder = 0;
  let firstHabitatAt: number | null = null;
  let firstNewHabitatAt: number | null = null;
  const rebirths: BalanceRebirth[] = [];
  const milestoneUpgradeTimes: Partial<Record<HabitatKind, number[]>> = {};
  const firstHabitatTimes: Partial<Record<HabitatKind, number>> = {};

  for (let second = 1; second <= maxSeconds && rebirths.length < rebirthTarget; second += 1) {
    clickRemainder += scenario.clicksPerSecond;
    const clicks = Math.floor(clickRemainder);
    clickRemainder -= clicks;
    for (let click = 0; click < clicks; click += 1) state = clickIslandHeart(state).state;
    state = tickEconomy(state, 1);

    if (second % scenario.purchaseIntervalSeconds === 0) {
      const beforeLevels = fullLevels(state);
      const beforeUpgrades = upgradeLevels(state);
      state = chooseBestInvestment(state);
      for (const habitat of HABITATS) {
        if (beforeLevels[habitat] === 0 && (state.habitats[habitat] ?? 0) > 0)
          firstHabitatTimes[habitat] ??= second;
      }
      if (
        firstHabitatAt === null &&
        HABITATS.some((habitat) => (state.habitats[habitat] ?? 0) > beforeLevels[habitat])
      )
        firstHabitatAt = second;
      if (
        firstNewHabitatAt === null &&
        HABITATS.slice(3).some((habitat) => (state.habitats[habitat] ?? 0) > 0)
      )
        firstNewHabitatAt = second;
      for (const habitat of HABITATS) {
        const before = beforeUpgrades[habitat];
        const after = state.habitatProductionUpgrades?.[habitat] ?? 0;
        if (after > before) {
          const index = after - 1;
          const times = (milestoneUpgradeTimes[habitat] ??= []);
          while (times.length <= index) times.push(second);
          times[index] = second;
        }
      }
    }

    if (canRebirth(state)) {
      const boughtHabitats = fullLevels(state);
      const boughtUpgrades = upgradeLevels(state);
      rebirths.push({
        second,
        naturePerSecond: valueToNumber(productionPerSecond(state)),
        awakeningLevel: state.personalUpgrades.awakening,
        rebirthGoal: valueToNumber(rebirthRequirement(state)),
        levels: boughtHabitats,
        productionUpgrades: boughtUpgrades,
        habitatKindsOwned: HABITATS.filter((habitat) => boughtHabitats[habitat] > 0).length,
      });
      state = performRebirth(state).state;
      while (
        state.seasonalPP >= state.personalUpgrades[scenario.ppUpgrade] + 1 &&
        state.personalUpgrades[scenario.ppUpgrade] < 100
      )
        state = buyPPUpgrade(state, scenario.ppUpgrade).state;
    }
  }

  return {
    scenario: scenario.name,
    firstHabitatAt,
    firstNewHabitatAt,
    firstHabitatTimes,
    rebirths,
    milestoneUpgradeTimes,
  };
}

const SCENARIOS: BalanceScenario[] = [
  {
    name: 'active (5 clicks/s, buy every second, Growth PP)',
    clicksPerSecond: 5,
    purchaseIntervalSeconds: 1,
    ppUpgrade: 'growth',
  },
  {
    name: 'balanced (1 click/s, buy every second, Growth PP)',
    clicksPerSecond: 1,
    purchaseIntervalSeconds: 1,
    ppUpgrade: 'growth',
  },
  {
    name: 'mostly passive (0.1 clicks/s, buy every 10s, Growth PP)',
    clicksPerSecond: 0.1,
    purchaseIntervalSeconds: 10,
    ppUpgrade: 'growth',
  },
  {
    name: 'active Awakening investment (5 clicks/s)',
    clicksPerSecond: 5,
    purchaseIntervalSeconds: 1,
    ppUpgrade: 'awakening',
  },
];

describe('six-habitat progression balance simulation', () => {
  it('reports six-rebirth pacing and habitat adoption under active, balanced, and passive play', () => {
    const results = SCENARIOS.slice(0, 3).map((scenario) => simulateBalanceScenario(scenario, 30));
    for (const result of results) {
      const intervals = result.rebirths.map(
        (cycle, index) => cycle.second - (result.rebirths[index - 1]?.second ?? 0),
      );
      console.log(
        'SIX_HABITAT_BALANCE',
        JSON.stringify({
          scenario: result.scenario,
          firstHabitatAt: result.firstHabitatAt,
          firstNewHabitatAt: result.firstNewHabitatAt,
          firstHabitatTimes: result.firstHabitatTimes,
          rebirthIntervalsSeconds: intervals,
          lastRebirthAt: result.rebirths.at(-1)?.second,
          latestLevels: result.rebirths.at(-1)?.levels,
          latestProductionUpgrades: result.rebirths.at(-1)?.productionUpgrades,
        }),
      );
      expect(result.firstHabitatAt).not.toBeNull();
      expect(result.rebirths).toHaveLength(30);
      expect(
        result.rebirths.every(({ second }) => Number.isSafeInteger(second) && second > 0),
      ).toBe(true);
      expect(result.rebirths[0]!.habitatKindsOwned).toBeGreaterThan(0);
      expect(Object.values(result.milestoneUpgradeTimes).flat()).toEqual([]);
    }
  });

  it('keeps the Awakening starting grant below the effective Rebirth goal', () => {
    let firstImmediateLevel: number | null = null;
    let comparison: { startingNature: number; goal: number } | undefined;
    for (let level = 0; level <= 100; level += 1) {
      const state = {
        ...createEconomyState(1),
        personalUpgrades: { growth: 0, efficiency: 0, awakening: level, rebirth: 0 },
      };
      const startingNature = 5 * level;
      const goal = valueToNumber(rebirthRequirement(state));
      if (startingNature >= goal) {
        firstImmediateLevel = level;
        comparison = { startingNature, goal };
        break;
      }
    }
    console.log('AWAKENING_IMMEDIATE_REBIRTH', JSON.stringify({ firstImmediateLevel, comparison }));
    expect(firstImmediateLevel).toBeNull();

    const played = simulateBalanceScenario(SCENARIOS[3]!, 170);
    const firstSafeguardedRebirth = played.rebirths.find(
      ({ awakeningLevel }) => awakeningLevel >= 17,
    );
    console.log(
      'AWAKENING_SIMULATION',
      JSON.stringify({
        firstSixteenRebirths: played.rebirths.slice(0, 16).map(({ second }) => second),
        firstSafeguardedRebirth,
        totalCycles: played.rebirths.length,
        lastCycleAt: played.rebirths.at(-1)?.second,
      }),
    );
    expect(firstSafeguardedRebirth).toBeDefined();
    expect(firstSafeguardedRebirth?.awakeningLevel).toBeGreaterThanOrEqual(17);
    expect(firstSafeguardedRebirth?.rebirthGoal).toBeGreaterThan(
      (firstSafeguardedRebirth?.awakeningLevel ?? 0) * 5,
    );
  });
});
