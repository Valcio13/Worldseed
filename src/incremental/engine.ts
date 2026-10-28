import {
  addValues,
  compareValues,
  isValidValue,
  multiplyByNumber,
  multiplyValues,
  pow10,
  subtractValues,
  valueFromNumber,
  valueFromParts,
  type BigValue,
} from './decimal';
import { seasonIdAt } from './season';

export { nextSeasonStartAt, seasonIdAt, seasonStartAt, SEASON_LENGTH_MS } from './season';

export const ECONOMY_SCHEMA_VERSION = 1 as const;
export type HabitatKind =
  | 'water'
  | 'grass'
  | 'forest'
  | 'mountain'
  | 'crystal-cavern'
  | 'ancient-grove';
type OriginalHabitatKind = 'water' | 'grass' | 'forest';
export type HabitatLevels = Record<OriginalHabitatKind, number> &
  Partial<Record<Exclude<HabitatKind, OriginalHabitatKind>, number>>;
export type BuyAmount = 1 | 10 | 100 | 'max';
export type PPUpgrade = 'growth' | 'efficiency' | 'awakening' | 'rebirth';
export type TemporaryUpgrade = 'sunny-season' | 'deep-roots' | 'nature-surge';

export interface SeasonRecord {
  seasonId: number;
  rebirths: number;
  communityPoints: number;
  /** Optional fields keep older local archives readable while enriching new season summaries. */
  natureAtEnd?: BigValue;
  lifetimeNatureAtEnd?: BigValue;
  personalPointsAtEnd?: number;
  habitatsAtEnd?: HabitatLevels;
  upgradesAtEnd?: Record<PPUpgrade, number>;
}

export const HABITAT_BASE_COST: Record<HabitatKind, BigValue> = {
  water: valueFromNumber(10),
  grass: valueFromNumber(28),
  forest: valueFromNumber(90),
  mountain: valueFromNumber(300),
  'crystal-cavern': valueFromNumber(1_200),
  'ancient-grove': valueFromNumber(4_800),
};
export const HABITAT_COST_GROWTH: Record<HabitatKind, number> = {
  water: 1.15,
  grass: 1.17,
  forest: 1.19,
  mountain: 1.21,
  'crystal-cavern': 1.23,
  'ancient-grove': 1.25,
};
export const HABITAT_BASE_RATE: Record<HabitatKind, number> = {
  water: 0.3,
  grass: 1.2,
  forest: 4.8,
  mountain: 16,
  'crystal-cavern': 64,
  'ancient-grove': 256,
};
export const HABITAT_UPGRADE_MILESTONES = [10, 25, 50, 100] as const;
export const FERTILE_SOIL_MAX_LEVEL = 5;
export const FIRST_REBIRTH_REQUIREMENT = valueFromNumber(2_000);
export const REBIRTH_MULTIPLIERS = [
  1, 1.02, 1.04, 1.06, 1.08, 1.1, 1.12, 1.14, 1.16, 1.18, 1.2,
] as const;
export const MAX_HABITAT_LEVEL = Number.MAX_SAFE_INTEGER;

export interface EconomyState {
  schemaVersion: typeof ECONOMY_SCHEMA_VERSION;
  seasonId: number;
  nature: BigValue;
  lifetimeNature: BigValue;
  runNature: BigValue;
  habitats: HabitatLevels;
  /** Missing on old guest saves; interpreted as no purchased habitat upgrades. */
  habitatProductionUpgrades?: Partial<Record<HabitatKind, number>>;
  /** Optional for old saves; run-only increase, reset on Rebirth. */
  fertileSoilLevel?: number;
  /** Optional for old saves; Time Bloom can be used once per run. */
  timeBloomUsed?: boolean;
  temporaryUpgrades: Record<TemporaryUpgrade, number>;
  seasonalPP: number;
  seasonalCP: number;
  lifetimeCP: number;
  seasonRebirths: number;
  lifetimeRebirths: number;
  seasonRecords: SeasonRecord[];
  achievements: string[];
  personalUpgrades: Record<PPUpgrade, number>;
  milestoneFlags: number[];
  activeSeconds: number;
}

export interface EconomyEvent {
  kind: 'heart-click' | 'habitat-bought' | 'upgrade-bought' | 'milestone' | 'rebirth';
  message: string;
}

export interface ActionResult {
  state: EconomyState;
  events: EconomyEvent[];
  error?: string;
}

export const HABITATS: readonly HabitatKind[] = [
  'water', 'grass', 'forest', 'mountain', 'crystal-cavern', 'ancient-grove',
];
const MILESTONES = [
  { at: 5, multiplier: 1.2 },
  { at: 15, multiplier: 1.5 },
  { at: 40, multiplier: 2 },
  { at: 100, multiplier: 3 },
] as const;
const TEMP_UPGRADE_CONFIG: Record<
  TemporaryUpgrade,
  { cost: number; multiplier: number; seconds: number; label: string }
> = {
  'sunny-season': { cost: 150, multiplier: 2, seconds: 60, label: 'Sunny Season' },
  'deep-roots': { cost: 1_500, multiplier: 3, seconds: 90, label: 'Deep Roots' },
  'nature-surge': { cost: 1_500, multiplier: 4, seconds: 30, label: 'Nature Surge' },
};

function emptyTemporaryUpgrades(): Record<TemporaryUpgrade, number> {
  return Object.fromEntries(
    Object.keys(TEMP_UPGRADE_CONFIG).map((upgrade) => [upgrade, 0]),
  ) as Record<TemporaryUpgrade, number>;
}

function decayTemporaryUpgrades(
  remaining: Partial<Record<TemporaryUpgrade, number>>,
  seconds: number,
): Record<TemporaryUpgrade, number> {
  return Object.fromEntries(
    Object.keys(TEMP_UPGRADE_CONFIG).map((upgrade) => [
      upgrade,
      Math.max(0, (remaining[upgrade as TemporaryUpgrade] ?? 0) - seconds),
    ]),
  ) as Record<TemporaryUpgrade, number>;
}

function finiteLevel(level: number): boolean {
  return Number.isSafeInteger(level) && level >= 0;
}

export function createEconomyState(seasonId = 0): EconomyState {
  if (!Number.isSafeInteger(seasonId)) throw new RangeError('Season ID must be an integer.');
  return {
    schemaVersion: ECONOMY_SCHEMA_VERSION,
    seasonId,
    nature: valueFromNumber(0),
    lifetimeNature: valueFromNumber(0),
    runNature: valueFromNumber(0),
    habitats: {
      water: 0,
      grass: 0,
      forest: 0,
      mountain: 0,
      'crystal-cavern': 0,
      'ancient-grove': 0,
    },
    habitatProductionUpgrades: emptyHabitatProductionUpgrades(),
    fertileSoilLevel: 0,
    timeBloomUsed: false,
    temporaryUpgrades: emptyTemporaryUpgrades(),
    seasonalPP: 0,
    seasonalCP: 0,
    lifetimeCP: 0,
    seasonRebirths: 0,
    lifetimeRebirths: 0,
    seasonRecords: [],
    achievements: [],
    personalUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
    milestoneFlags: [],
    activeSeconds: 0,
  };
}

export function resetForNewSeason(state: EconomyState, seasonId: number): EconomyState {
  if (!Number.isSafeInteger(seasonId)) throw new RangeError('Season ID must be an integer.');
  if (seasonId <= state.seasonId) return state;
  const alreadyArchived = state.seasonRecords.some((record) => record.seasonId === state.seasonId);
  return {
    ...createEconomyState(seasonId),
    lifetimeNature: state.lifetimeNature,
    lifetimeCP: state.lifetimeCP,
    lifetimeRebirths: state.lifetimeRebirths,
    seasonRecords: alreadyArchived
      ? [...state.seasonRecords]
      : [
          ...state.seasonRecords,
          {
            seasonId: state.seasonId,
            rebirths: state.seasonRebirths,
            communityPoints: state.seasonalCP,
            natureAtEnd: state.nature,
            lifetimeNatureAtEnd: state.lifetimeNature,
            personalPointsAtEnd: state.seasonalPP,
            habitatsAtEnd: { ...state.habitats },
            upgradesAtEnd: { ...state.personalUpgrades },
          },
        ],
    achievements: [...state.achievements],
  };
}

export const MAX_OFFLINE_SECONDS = 8 * 60 * 60;

export interface OfflineProgressResult {
  state: EconomyState;
  secondsApplied: number;
}

/** Apply local guest-only offline production, never across a season boundary. */
export function applyOfflineProgress(
  state: EconomyState,
  savedAt: number,
  now: number,
): OfflineProgressResult {
  if (!Number.isFinite(savedAt) || !Number.isFinite(now))
    throw new RangeError('Save timestamps must be finite.');
  if (
    now <= savedAt ||
    seasonIdAt(savedAt) !== seasonIdAt(now) ||
    state.seasonId !== seasonIdAt(now)
  )
    return { state, secondsApplied: 0 };
  const secondsApplied = Math.min(MAX_OFFLINE_SECONDS, Math.floor((now - savedAt) / 1000));
  if (secondsApplied <= 0) return { state, secondsApplied: 0 };

  const boundaries = [0, secondsApplied];
  for (const remaining of Object.values(state.temporaryUpgrades ?? {})) {
    if (remaining > 0 && remaining < secondsApplied) boundaries.push(remaining);
  }
  boundaries.sort((a, b) => a - b);
  let generated = valueFromNumber(0);
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    const midpoint = (start + end) / 2;
    const intervalState: EconomyState = {
      ...state,
      temporaryUpgrades: decayTemporaryUpgrades(state.temporaryUpgrades, midpoint),
    };
    generated = addValues(
      generated,
      multiplyByNumber(productionPerSecond(intervalState), end - start),
    );
  }
  return {
    state: {
      ...state,
      nature: addValues(state.nature, generated),
      lifetimeNature: addValues(state.lifetimeNature, generated),
      runNature: addValues(state.runNature, generated),
      temporaryUpgrades: decayTemporaryUpgrades(state.temporaryUpgrades, secondsApplied),
    },
    secondsApplied,
  };
}

export function totalHabitatLevels(state: EconomyState): number {
  return HABITATS.reduce((sum, habitat) => sum + (state.habitats[habitat] ?? 0), 0);
}

function emptyHabitatProductionUpgrades(): Record<HabitatKind, number> {
  return Object.fromEntries(HABITATS.map((habitat) => [habitat, 0])) as Record<HabitatKind, number>;
}

function habitatUpgradeCount(state: EconomyState, habitat: HabitatKind): number {
  return state.habitatProductionUpgrades?.[habitat] ?? 0;
}

export function habitatProductionUpgradeCost(habitat: HabitatKind, milestoneIndex: number): BigValue {
  if (
    !Number.isSafeInteger(milestoneIndex) ||
    milestoneIndex < 0 ||
    milestoneIndex >= HABITAT_UPGRADE_MILESTONES.length
  )
    throw new RangeError('Habitat production upgrade milestone is invalid.');
  const quantity = HABITAT_UPGRADE_MILESTONES[milestoneIndex]!;
  return multiplyByNumber(HABITAT_BASE_COST[habitat], quantity * quantity);
}

export function productionMultiplier(state: EconomyState): number {
  const waterGrass = Math.min(state.habitats.water, state.habitats.grass, 100);
  const grassForest = Math.min(state.habitats.grass, state.habitats.forest, 100);
  const adjacency = 1 + waterGrass * 0.025 + grassForest * 0.06;
  const total = totalHabitatLevels(state);
  const milestone = [...MILESTONES].reverse().find((item) => total >= item.at)?.multiplier ?? 1;
  const ppGrowth = 1.5 ** state.personalUpgrades.growth;
  const boosts = Object.entries(state.temporaryUpgrades).reduce(
    (multiplier, [id, remaining]) =>
      multiplier * (remaining > 0 ? TEMP_UPGRADE_CONFIG[id as TemporaryUpgrade].multiplier : 1),
    1,
  );
  const fertileSoil = 1 + Math.min(FERTILE_SOIL_MAX_LEVEL, state.fertileSoilLevel ?? 0) * 0.1;
  const result = adjacency * milestone * ppGrowth * fertileSoil * boosts;
  if (!Number.isFinite(result))
    throw new RangeError('Production multiplier exceeded its safe range.');
  return result;
}

export function productionPerSecond(state: EconomyState): BigValue {
  let base = valueFromNumber(0);
  for (const habitat of HABITATS) {
    base = addValues(
      base,
      habitatBaseProduction(state, habitat),
    );
  }
  const growthBoost = pow10(Math.log10(1.5) * state.personalUpgrades.growth);
  return multiplyValues(
    multiplyByNumber(base, productionMultiplierWithoutPPGrowth(state)),
    growthBoost,
  );
}

export function habitatProductionPerSecond(state: EconomyState, habitat: HabitatKind): BigValue {
  const base = habitatBaseProduction(state, habitat);
  const growthBoost = pow10(Math.log10(1.5) * state.personalUpgrades.growth);
  return multiplyValues(
    multiplyByNumber(base, productionMultiplierWithoutPPGrowth(state)),
    growthBoost,
  );
}

function habitatBaseProduction(state: EconomyState, habitat: HabitatKind): BigValue {
  const level = state.habitats[habitat] ?? 0;
  const multiplier = 2 ** habitatUpgradeCount(state, habitat);
  return multiplyByNumber(
    multiplyByNumber(valueFromNumber(level), HABITAT_BASE_RATE[habitat]),
    multiplier,
  );
}

function productionMultiplierWithoutPPGrowth(state: EconomyState): number {
  const waterGrass = Math.min(state.habitats.water, state.habitats.grass, 100);
  const grassForest = Math.min(state.habitats.grass, state.habitats.forest, 100);
  const adjacency = 1 + waterGrass * 0.025 + grassForest * 0.06;
  const total = totalHabitatLevels(state);
  const milestone = [...MILESTONES].reverse().find((item) => total >= item.at)?.multiplier ?? 1;
  const boosts = Object.entries(state.temporaryUpgrades).reduce(
    (multiplier, [id, remaining]) =>
      multiplier * (remaining > 0 ? TEMP_UPGRADE_CONFIG[id as TemporaryUpgrade].multiplier : 1),
    1,
  );
  const fertileSoil = 1 + Math.min(FERTILE_SOIL_MAX_LEVEL, state.fertileSoilLevel ?? 0) * 0.1;
  const result = adjacency * milestone * fertileSoil * boosts;
  if (!Number.isFinite(result))
    throw new RangeError('Production multiplier exceeded its safe range.');
  return result;
}

export function tickEconomy(state: EconomyState, seconds: number): EconomyState {
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new RangeError('Tick duration must be finite and non-negative.');
  if (seconds === 0) return state;
  const boundaries = [0, seconds];
  for (const remaining of Object.values(state.temporaryUpgrades ?? {})) {
    if (remaining > 0 && remaining < seconds) boundaries.push(remaining);
  }
  boundaries.sort((a, b) => a - b);
  let generated = valueFromNumber(0);
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    const midpoint = (start + end) / 2;
    const intervalState = {
      ...state,
      temporaryUpgrades: decayTemporaryUpgrades(state.temporaryUpgrades, midpoint),
    };
    generated = addValues(
      generated,
      multiplyByNumber(productionPerSecond(intervalState), end - start),
    );
  }
  const temporaryUpgrades = decayTemporaryUpgrades(state.temporaryUpgrades, seconds);
  return {
    ...state,
    nature: addValues(state.nature, generated),
    lifetimeNature: addValues(state.lifetimeNature, generated),
    runNature: addValues(state.runNature, generated),
    temporaryUpgrades,
    activeSeconds: state.activeSeconds + seconds,
  };
}

export function clickIslandHeart(state: EconomyState): ActionResult {
  const one = valueFromNumber(1);
  return {
    state: {
      ...state,
      nature: addValues(state.nature, one),
      lifetimeNature: addValues(state.lifetimeNature, one),
      runNature: addValues(state.runNature, one),
    },
    events: [{ kind: 'heart-click', message: '+1 Nature from the Island Heart.' }],
  };
}

export function habitatUnitCost(
  state: EconomyState,
  habitat: HabitatKind,
  level = state.habitats[habitat] ?? 0,
): BigValue {
  if (!finiteLevel(level))
    throw new RangeError('Habitat level must be a non-negative safe integer.');
  const efficiency = 0.9 ** state.personalUpgrades.efficiency;
  const growth = pow10(Math.log10(HABITAT_COST_GROWTH[habitat]) * level);
  return multiplyByNumber(multiplyValues(HABITAT_BASE_COST[habitat], growth), efficiency);
}

export function habitatBulkCost(
  state: EconomyState,
  habitat: HabitatKind,
  quantity: number,
): BigValue {
  if (!Number.isSafeInteger(quantity) || quantity < 0)
    throw new RangeError('Purchase quantity must be a non-negative integer.');
  if (quantity === 0) return valueFromNumber(0);
  const start = habitatUnitCost(state, habitat);
  const ratio = HABITAT_COST_GROWTH[habitat];
  const factor = (10 ** (Math.log10(ratio) * quantity) - 1) / (ratio - 1);
  if (!Number.isFinite(factor) || factor <= 0) return valueFromParts(1, Number.MAX_SAFE_INTEGER);
  return multiplyByNumber(start, factor);
}

export function calculateBuyQuantity(
  state: EconomyState,
  habitat: HabitatKind,
  amount: BuyAmount,
): number {
  const room = MAX_HABITAT_LEVEL - (state.habitats[habitat] ?? 0);
  if (amount !== 'max') return Math.min(amount, room);
  if (room <= 0 || compareValues(habitatUnitCost(state, habitat), state.nature) > 0) return 0;
  let low = 1;
  let high = 2;
  while (high < room && compareValues(habitatBulkCost(state, habitat, high), state.nature) <= 0) {
    low = high;
    high = Math.min(room, high * 2);
  }
  if (compareValues(habitatBulkCost(state, habitat, high), state.nature) <= 0) return high;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareValues(habitatBulkCost(state, habitat, middle), state.nature) <= 0) low = middle;
    else high = middle;
  }
  return low;
}

export function buyHabitat(
  state: EconomyState,
  habitat: HabitatKind,
  amount: BuyAmount,
): ActionResult {
  const quantity = calculateBuyQuantity(state, habitat, amount);
  if (quantity <= 0) return { state, events: [], error: `More Nature is needed for ${habitat}.` };
  const cost = habitatBulkCost(state, habitat, quantity);
  if (compareValues(cost, state.nature) > 0)
    return { state, events: [], error: 'Not enough Nature for that purchase.' };
  const next = {
    ...state,
    nature: subtractValues(state.nature, cost),
    habitats: { ...state.habitats, [habitat]: (state.habitats[habitat] ?? 0) + quantity },
  };
  const events: EconomyEvent[] = [
    {
      kind: 'habitat-bought',
      message: `Bought ${quantity} ${habitat} ${quantity === 1 ? 'habitat' : 'habitats'}.`,
    },
  ];
  for (const milestone of MILESTONES) {
    if (
      totalHabitatLevels(state) < milestone.at &&
      totalHabitatLevels(next) >= milestone.at &&
      !state.milestoneFlags.includes(milestone.at)
    ) {
      next.milestoneFlags = [...state.milestoneFlags, milestone.at];
      events.push({
        kind: 'milestone',
        message: `Habitat milestone ${milestone.at}: production increased.`,
      });
    }
  }
  return { state: next, events };
}

/** Buy the next sequential production upgrade for one habitat using Nature. */
export function buyHabitatProductionUpgrade(
  state: EconomyState,
  habitat: HabitatKind,
): ActionResult {
  const ownedUpgrades = habitatUpgradeCount(state, habitat);
  if (ownedUpgrades >= HABITAT_UPGRADE_MILESTONES.length)
    return { state, events: [], error: 'This habitat is fully upgraded.' };
  const requiredLevel = HABITAT_UPGRADE_MILESTONES[ownedUpgrades]!;
  if ((state.habitats[habitat] ?? 0) < requiredLevel)
    return {
      state,
      events: [],
      error: `Own ${requiredLevel} ${habitat} habitats to unlock its next production upgrade.`,
    };
  const cost = habitatProductionUpgradeCost(habitat, ownedUpgrades);
  if (compareValues(state.nature, cost) < 0)
    return { state, events: [], error: 'Not enough Nature for this habitat production upgrade.' };
  return {
    state: {
      ...state,
      nature: subtractValues(state.nature, cost),
      habitatProductionUpgrades: {
        ...emptyHabitatProductionUpgrades(),
        ...state.habitatProductionUpgrades,
        [habitat]: ownedUpgrades + 1,
      },
    },
    events: [
      {
        kind: 'upgrade-bought',
        message: `${habitat} production doubled at the ${requiredLevel}-habitat milestone.`,
      },
    ],
  };
}

export function buyTemporaryUpgrade(state: EconomyState, upgrade: TemporaryUpgrade): ActionResult {
  const config = TEMP_UPGRADE_CONFIG[upgrade];
  const cost = valueFromNumber(config.cost);
  if (compareValues(state.nature, cost) < 0)
    return { state, events: [], error: `Need ${config.cost} Nature for ${config.label}.` };
  return {
    state: {
      ...state,
      nature: subtractValues(state.nature, cost),
      temporaryUpgrades: { ...state.temporaryUpgrades, [upgrade]: config.seconds },
    },
    events: [
      { kind: 'upgrade-bought', message: `${config.label} active for ${config.seconds} seconds.` },
    ],
  };
}

/** Price for the next Fertile Soil level; the improvement resets on Rebirth. */
export function fertileSoilCost(state: EconomyState): BigValue {
  return valueFromNumber(1_000 * ((state.fertileSoilLevel ?? 0) + 1));
}

export function buyFertileSoil(state: EconomyState): ActionResult {
  const level = state.fertileSoilLevel ?? 0;
  if (level >= FERTILE_SOIL_MAX_LEVEL)
    return { state, events: [], error: 'Fertile Soil is fully enriched for this run.' };
  const cost = fertileSoilCost(state);
  if (compareValues(state.nature, cost) < 0)
    return { state, events: [], error: 'Not enough Nature for Fertile Soil.' };
  const nextLevel = level + 1;
  return {
    state: {
      ...state,
      nature: subtractValues(state.nature, cost),
      fertileSoilLevel: nextLevel,
    },
    events: [
      {
        kind: 'upgrade-bought',
        message: `Fertile Soil raised production by 10% (${nextLevel}/${FERTILE_SOIL_MAX_LEVEL}).`,
      },
    ],
  };
}

/** Time Bloom costs 20 seconds of current production and grants 30 seconds once per run. */
export function timeBloomCost(state: EconomyState): BigValue {
  return multiplyByNumber(productionPerSecond(state), 20);
}

export function buyTimeBloom(state: EconomyState): ActionResult {
  if (state.timeBloomUsed)
    return { state, events: [], error: 'Time Bloom has already been used this run.' };
  const production = productionPerSecond(state);
  if (compareValues(production, valueFromNumber(0)) <= 0)
    return { state, events: [], error: 'Build a habitat before using Time Bloom.' };
  const cost = multiplyByNumber(production, 20);
  if (compareValues(state.nature, cost) < 0)
    return { state, events: [], error: 'Not enough Nature for Time Bloom.' };
  const reward = multiplyByNumber(production, 30);
  return {
    state: {
      ...state,
      nature: addValues(subtractValues(state.nature, cost), reward),
      lifetimeNature: addValues(state.lifetimeNature, reward),
      runNature: addValues(state.runNature, reward),
      timeBloomUsed: true,
    },
    events: [
      { kind: 'upgrade-bought', message: 'Time Bloom produced 30 seconds of Nature instantly.' },
    ],
  };
}

export function rebirthRequirement(state: EconomyState): BigValue {
  const step = REBIRTH_MULTIPLIERS[Math.min(state.seasonRebirths, REBIRTH_MULTIPLIERS.length - 1)]!;
  const reduction = 0.82 ** state.personalUpgrades.awakening;
  const currentGoal = multiplyByNumber(multiplyByNumber(FIRST_REBIRTH_REQUIREMENT, step), reduction);
  const awakeningGrant = valueFromNumber(5 * state.personalUpgrades.awakening);
  if (compareValues(currentGoal, awakeningGrant) > 0) return currentGoal;
  return addValues(awakeningGrant, multiplyByNumber(FIRST_REBIRTH_REQUIREMENT, step * 0.1));
}

export function canRebirth(state: EconomyState): boolean {
  return compareValues(state.runNature, rebirthRequirement(state)) >= 0;
}

export function rebirthReward(state: EconomyState): { pp: number; cp: number } {
  const required = rebirthRequirement(state);
  const ratio =
    compareValues(state.runNature, required) <= 0
      ? 1
      : Math.min(
          1e12,
          (10 ** Math.min(12, state.runNature.exponent - required.exponent) *
            state.runNature.mantissa) /
            required.mantissa,
        );
  const rebirthBonus = 1 + state.personalUpgrades.rebirth * 0.25;
  const natureReward = Math.min(Math.sqrt(ratio), 10);
  const pp = Math.max(1, Math.floor(natureReward * rebirthBonus));
  const cp = Math.max(1, 1 + Math.floor(Math.log10(ratio + 1e-12)));
  return { pp, cp };
}

export function performRebirth(state: EconomyState): ActionResult {
  if (!canRebirth(state))
    return { state, events: [], error: 'Reach the Nature goal before rebirthing.' };
  const { pp, cp } = rebirthReward(state);
  const next = {
    ...state,
    nature: valueFromNumber(0),
    runNature: valueFromNumber(0),
    habitats: {
      water: 0,
      grass: 0,
      forest: 0,
      mountain: 0,
      'crystal-cavern': 0,
      'ancient-grove': 0,
    },
    habitatProductionUpgrades: emptyHabitatProductionUpgrades(),
    temporaryUpgrades: emptyTemporaryUpgrades(),
    fertileSoilLevel: 0,
    timeBloomUsed: false,
    seasonalPP: state.seasonalPP + pp,
    seasonalCP: state.seasonalCP + cp,
    lifetimeCP: state.lifetimeCP + cp,
    seasonRebirths: state.seasonRebirths + 1,
    lifetimeRebirths: state.lifetimeRebirths + 1,
    seasonRecords: state.seasonRecords,
    achievements:
      state.lifetimeRebirths === 0 && !state.achievements.includes('first-rebirth')
        ? [...state.achievements, 'first-rebirth']
        : [...state.achievements],
    milestoneFlags: [],
    activeSeconds: 0,
  };
  next.nature = valueFromNumber(5 * next.personalUpgrades.awakening);
  next.runNature = next.nature;
  next.lifetimeNature = addValues(next.lifetimeNature, next.nature);
  return {
    state: next,
    events: [
      { kind: 'rebirth', message: `Rebirth earned ${pp} seasonal PP and ${cp} simulated CP.` },
    ],
  };
}

export const PP_UPGRADE_CONFIG: Record<PPUpgrade, { label: string; description: string }> = {
  growth: { label: 'Growth', description: 'Increase all Nature production by 50% per level.' },
  efficiency: {
    label: 'Efficiency',
    description: 'Reduce habitat upgrade costs by 10% per level.',
  },
  awakening: {
    label: 'Awakening',
    description: 'Start future runs with 5 Nature per level and lower their rebirth goal.',
  },
  rebirth: { label: 'Rebirth', description: 'Increase future PP rewards by 25% per level.' },
};

export function ppUpgradeCost(state: EconomyState, upgrade: PPUpgrade): number {
  return state.personalUpgrades[upgrade] + 1;
}

export function buyPPUpgrade(state: EconomyState, upgrade: PPUpgrade): ActionResult {
  const cost = ppUpgradeCost(state, upgrade);
  if (state.personalUpgrades[upgrade] >= 100)
    return { state, events: [], error: 'This seasonal upgrade is fully grown.' };
  if (state.seasonalPP < cost) return { state, events: [], error: `${cost} seasonal PP required.` };
  return {
    state: {
      ...state,
      seasonalPP: state.seasonalPP - cost,
      personalUpgrades: {
        ...state.personalUpgrades,
        [upgrade]: state.personalUpgrades[upgrade] + 1,
      },
    },
    events: [{ kind: 'upgrade-bought', message: `${PP_UPGRADE_CONFIG[upgrade].label} upgraded.` }],
  };
}

export function validateEconomyState(state: unknown): state is EconomyState {
  if (!state || typeof state !== 'object') return false;
  const candidate = state as EconomyState;
  return (
    candidate.schemaVersion === ECONOMY_SCHEMA_VERSION &&
    Number.isSafeInteger(candidate.seasonId) &&
    [candidate.nature, candidate.lifetimeNature, candidate.runNature].every(isValidValue) &&
    HABITATS.every((habitat) =>
      habitat === 'water' || habitat === 'grass' || habitat === 'forest'
        ? finiteLevel(candidate.habitats?.[habitat])
        : candidate.habitats?.[habitat] === undefined || finiteLevel(candidate.habitats[habitat]),
    ) &&
    (candidate.habitatProductionUpgrades === undefined ||
      (candidate.habitatProductionUpgrades !== null &&
        typeof candidate.habitatProductionUpgrades === 'object' &&
        HABITATS.every((habitat) => {
          const count = candidate.habitatProductionUpgrades?.[habitat] ?? 0;
          return (
            Number.isSafeInteger(count) &&
            count >= 0 &&
            count <= HABITAT_UPGRADE_MILESTONES.length &&
            (count === 0 ||
              (candidate.habitats[habitat] ?? 0) >=
                HABITAT_UPGRADE_MILESTONES[count - 1]!)
          );
        }))) &&
    candidate.temporaryUpgrades !== null &&
    typeof candidate.temporaryUpgrades === 'object' &&
    (Object.keys(TEMP_UPGRADE_CONFIG) as TemporaryUpgrade[]).every(
      (upgrade) =>
        Number.isFinite(candidate.temporaryUpgrades[upgrade] ?? 0) &&
        (candidate.temporaryUpgrades[upgrade] ?? 0) >= 0,
    ) &&
    (candidate.fertileSoilLevel === undefined ||
      (Number.isSafeInteger(candidate.fertileSoilLevel) &&
        candidate.fertileSoilLevel >= 0 &&
        candidate.fertileSoilLevel <= FERTILE_SOIL_MAX_LEVEL)) &&
    (candidate.timeBloomUsed === undefined || typeof candidate.timeBloomUsed === 'boolean') &&
    [
      candidate.seasonalPP,
      candidate.seasonalCP,
      candidate.lifetimeCP,
      candidate.seasonRebirths,
      candidate.lifetimeRebirths,
    ].every((count) => Number.isSafeInteger(count) && count >= 0) &&
    (['growth', 'efficiency', 'awakening', 'rebirth'] as const).every(
      (upgrade) =>
        finiteLevel(candidate.personalUpgrades?.[upgrade]) &&
        candidate.personalUpgrades[upgrade] <= 100,
    ) &&
    Number.isFinite(candidate.activeSeconds) &&
    candidate.activeSeconds >= 0 &&
    Array.isArray(candidate.milestoneFlags) &&
    candidate.milestoneFlags.every((flag) => Number.isSafeInteger(flag) && flag >= 0) &&
    Array.isArray(candidate.achievements) &&
    candidate.achievements.every((achievement) => typeof achievement === 'string') &&
    Array.isArray(candidate.seasonRecords) &&
    candidate.seasonRecords.every(
      (record) =>
        record &&
        Number.isSafeInteger(record.seasonId) &&
        Number.isSafeInteger(record.rebirths) &&
        record.rebirths >= 0 &&
        Number.isSafeInteger(record.communityPoints) &&
        record.communityPoints >= 0 &&
        (record.natureAtEnd === undefined || isValidValue(record.natureAtEnd)) &&
        (record.lifetimeNatureAtEnd === undefined || isValidValue(record.lifetimeNatureAtEnd)) &&
        (record.personalPointsAtEnd === undefined ||
          (Number.isSafeInteger(record.personalPointsAtEnd) && record.personalPointsAtEnd >= 0)) &&
        (record.habitatsAtEnd === undefined ||
          HABITATS.every((habitat) =>
            habitat === 'water' || habitat === 'grass' || habitat === 'forest'
              ? finiteLevel(record.habitatsAtEnd?.[habitat] ?? NaN)
              : record.habitatsAtEnd?.[habitat] === undefined ||
                finiteLevel(record.habitatsAtEnd[habitat] ?? 0),
          )) &&
        (record.upgradesAtEnd === undefined ||
          (['growth', 'efficiency', 'awakening', 'rebirth'] as const).every((upgrade) =>
            finiteLevel(record.upgradesAtEnd?.[upgrade] ?? NaN),
          )),
    )
  );
}
