import { compareValues, formatValue } from '../../src/incremental/decimal';
import {
  buyHabitat,
  canRebirth,
  buyPPUpgrade,
  clickIslandHeart,
  createEconomyState,
  performRebirth,
  productionPerSecond,
  HABITAT_BASE_RATE,
  HABITAT_BASE_COST,
  HABITAT_COST_GROWTH,
  tickEconomy,
  type EconomyState,
  type HabitatKind,
} from '../../src/incremental/engine';

export type PurchasingStrategy = 'water-first' | 'balanced-roi' | 'buy-max';

export interface SimulationSnapshot {
  second: number;
  nature: string;
  naturePerSecond: string;
  levels: EconomyState['habitats'];
  rebirths: number;
  pp: number;
  cp: number;
}

export interface SimulationResult {
  strategy: PurchasingStrategy;
  firstHabitatAt: number | null;
  firstProductionAt: number | null;
  firstRebirthAt: number | null;
  rebirthTimes: number[];
  snapshots: SimulationSnapshot[];
  invalidValues: string[];
  stalledAt: number | null;
}

const KINDS: HabitatKind[] = ['water', 'grass', 'forest'];
const SNAPSHOT_TIMES = [300, 600, 1800, 3600];

function buyForStrategy(state: EconomyState, strategy: PurchasingStrategy): EconomyState {
  if (strategy === 'water-first') {
    const preferred: HabitatKind[] =
      state.habitats.water === 0
        ? ['water', 'grass', 'forest']
        : state.habitats.grass === 0
          ? ['grass', 'water', 'forest']
          : state.habitats.forest === 0
            ? ['forest', 'grass', 'water']
            : ['forest', 'grass', 'water'];
    for (const kind of preferred) {
      const bought = buyHabitat(state, kind, 1);
      if (!bought.error) return bought.state;
    }
    return state;
  }

  if (strategy === 'buy-max') {
    for (const kind of KINDS) {
      const bought = buyHabitat(state, kind, 'max');
      if (!bought.error) state = bought.state;
    }
    return state;
  }

  // Buy the highest production per Nature after first securing one of each
  // habitat, which gives the player the adjacency and milestone systems.
  if (state.habitats.water === 0) return buyHabitat(state, 'water', 1).state;
  if (state.habitats.grass === 0) return buyHabitat(state, 'grass', 1).state;
  if (state.habitats.forest === 0) return buyHabitat(state, 'forest', 1).state;
  let selected: HabitatKind | undefined;
  let best = -1;
  for (const kind of KINDS) {
    const trial = buyHabitat(state, kind, 1);
    if (trial.error) continue;
    const level = state.habitats[kind] ?? 0;
    const logCost =
      Math.log10(HABITAT_BASE_COST[kind].mantissa) +
      HABITAT_BASE_COST[kind].exponent +
      level * Math.log10(HABITAT_COST_GROWTH[kind]);
    const score = Math.log10(HABITAT_BASE_RATE[kind]) - logCost;
    if (score > best) {
      best = score;
      selected = kind;
    }
  }
  return selected ? buyHabitat(state, selected, 1).state : state;
}

function snapshot(second: number, state: EconomyState): SimulationSnapshot {
  return {
    second,
    nature: formatValue(state.nature),
    naturePerSecond: formatValue(productionPerSecond(state)),
    levels: { ...state.habitats },
    rebirths: state.seasonRebirths,
    pp: state.seasonalPP,
    cp: state.seasonalCP,
  };
}

export function simulateStrategy(
  strategy: PurchasingStrategy,
  options: { seconds?: number; clicksPerSecond?: number; seed?: number } = {},
): SimulationResult {
  const seconds = options.seconds ?? 3600;
  const clicksPerSecond = options.clicksPerSecond ?? 1;
  if (
    !Number.isInteger(seconds) ||
    seconds < 0 ||
    !Number.isFinite(clicksPerSecond) ||
    clicksPerSecond < 0
  )
    throw new RangeError('Simulation settings must be finite and non-negative.');

  let state = createEconomyState(options.seed ?? 1);
  const snapshots: SimulationSnapshot[] = [];
  const invalidValues: string[] = [];
  const rebirthTimes: number[] = [];
  let firstHabitatAt: number | null = null;
  let firstProductionAt: number | null = null;
  let firstRebirthAt: number | null = null;
  let stalledAt: number | null = null;
  let noProgressSeconds = 0;
  let clickRemainder = 0;

  for (let second = 1; second <= seconds; second += 1) {
    const runBefore = state.runNature;
    clickRemainder += clicksPerSecond;
    const clicks = Math.floor(clickRemainder);
    clickRemainder -= clicks;
    for (let click = 0; click < clicks; click += 1) state = clickIslandHeart(state).state;
    state = tickEconomy(state, 1);
    const beforeLevels = state.habitats.water + state.habitats.grass + state.habitats.forest;
    state = buyForStrategy(state, strategy);
    if (
      firstHabitatAt === null &&
      beforeLevels < state.habitats.water + state.habitats.grass + state.habitats.forest
    )
      firstHabitatAt = second;
    if (
      firstProductionAt === null &&
      compareValues(productionPerSecond(state), { mantissa: 0, exponent: 0 }) > 0
    )
      firstProductionAt = second;
    if (canRebirth(state)) {
      if (firstRebirthAt === null) firstRebirthAt = second;
      const result = performRebirth(state);
      state = result.state;
      while (
        state.seasonalPP >= state.personalUpgrades.growth + 1 &&
        state.personalUpgrades.growth < 100
      ) {
        state = buyPPUpgrade(state, 'growth').state;
      }
      rebirthTimes.push(second);
    }
    if (SNAPSHOT_TIMES.includes(second)) snapshots.push(snapshot(second, state));

    const values = [
      state.nature,
      state.runNature,
      state.lifetimeNature,
      productionPerSecond(state),
    ];
    if (
      values.some(
        (value) => !Number.isFinite(value.mantissa) || !Number.isSafeInteger(value.exponent),
      )
    )
      invalidValues.push(`invalid value at ${second}s`);
    const gained = compareValues(state.runNature, runBefore) !== 0;
    const bought =
      beforeLevels < state.habitats.water + state.habitats.grass + state.habitats.forest;
    noProgressSeconds = gained || bought ? 0 : noProgressSeconds + 1;
    if (noProgressSeconds >= 60 && stalledAt === null) stalledAt = second;
  }

  return {
    strategy,
    firstHabitatAt,
    firstProductionAt,
    firstRebirthAt,
    rebirthTimes,
    snapshots,
    invalidValues,
    stalledAt,
  };
}

export function simulateAllStrategies(): SimulationResult[] {
  return (['water-first', 'balanced-roi', 'buy-max'] as const).map((strategy) =>
    simulateStrategy(strategy),
  );
}
