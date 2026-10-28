/**
 * Version 1 canonical incremental rules shared by the browser and verifier.
 * Authoritative values use 10^12 integer atoms per Nature and never pass through Number.
 * This module is deliberately independent of React, IndexedDB, wallets, and network APIs.
 */

export const RULES_VERSION = 1 as const;
export const NATURE_SCALE = 1_000_000_000_000n;
export const MAX_SCORE_TIER = 65_535;
export const MAX_SCORE_EXPONENT = 9_363;
export const MAX_NATURE_ATOMS = 10n ** 9_375n;
export const MAX_COMMAND_PURCHASE = 1_000;
export const MAX_UPGRADE_LEVEL = 100;
export const MAX_OFFLINE_MS = 8 * 60 * 60 * 1_000;
export const SEASON_LENGTH_SECONDS = 7 * 24 * 60 * 60;
export const SEASON_EPOCH_MONDAY_SECONDS = 4 * 24 * 60 * 60;

const MILLIS_PER_SECOND = 1_000;
const MAX_FACTOR_Q = MAX_NATURE_ATOMS;

export const HABITATS = ['water', 'grass', 'forest'] as const;
export type Habitat = (typeof HABITATS)[number];
export const PP_UPGRADES = ['growth', 'efficiency', 'awakening', 'rebirth'] as const;
export type PPUpgrade = (typeof PP_UPGRADES)[number];
export const TEMP_UPGRADES = ['sunny-season', 'deep-roots'] as const;
export type TemporaryUpgrade = (typeof TEMP_UPGRADES)[number];

export type HabitatLevels = Record<Habitat, number>;
export type UpgradeLevels = Record<PPUpgrade, number>;
export type TemporaryDurations = Record<TemporaryUpgrade, number>;

export interface UpgradeChoice {
  upgradeId: PPUpgrade;
  quantity: number;
}

export interface CanonicalRunState {
  rulesVersion: typeof RULES_VERSION;
  runId: string;
  seasonId: number;
  startedAtMs: number;
  lastServerTimeMs: number;
  natureAtoms: bigint;
  earnedNatureAtoms: bigint;
  productionRemainderMilliAtoms: bigint;
  habitats: HabitatLevels;
  upgrades: UpgradeLevels;
  temporaryMs: TemporaryDurations;
  seasonalPP: bigint;
  seasonRebirths: number;
  activeMilliseconds: number;
  sequence: number;
  status: 'active' | 'expired' | 'abandoned' | 'reborn';
  upgradeChoices: UpgradeChoice[];
}

export interface CanonicalRunInput {
  runId: string;
  seasonId: number;
  startedAtMs: number;
  seasonalPP: bigint;
  existingUpgrades: UpgradeLevels;
  seasonRebirths: number;
  upgradeChoices: readonly UpgradeChoice[];
}

export type GameplayCommand =
  | { type: 'heart-click' }
  | { type: 'buy-habitat'; habitat: Habitat; quantity: number }
  | { type: 'buy-temporary-upgrade'; upgrade: TemporaryUpgrade }
  | { type: 'sync' };

export interface RulesResult {
  state: CanonicalRunState;
  creditedAtoms: bigint;
  spentAtoms: bigint;
}

export class RulesError extends Error {
  constructor(
    readonly code:
      | 'INVALID_RUN'
      | 'INVALID_UPGRADE_CHOICES'
      | 'INSUFFICIENT_PP'
      | 'INVALID_COMMAND'
      | 'INSUFFICIENT_NATURE'
      | 'PURCHASE_LIMIT'
      | 'SEASON_EXPIRED'
      | 'RUN_NOT_ACTIVE'
      | 'INVALID_TIME',
    message: string,
  ) {
    super(message);
    this.name = 'RulesError';
  }
}

const BASE_COST_ATOMS: Record<Habitat, bigint> = {
  water: 10n * NATURE_SCALE,
  grass: 28n * NATURE_SCALE,
  forest: 90n * NATURE_SCALE,
};
const COST_GROWTH: Record<Habitat, readonly [bigint, bigint]> = {
  water: [115n, 100n],
  grass: [117n, 100n],
  forest: [119n, 100n],
};
const BASE_RATE_ATOMS_PER_SECOND: Record<Habitat, bigint> = {
  water: 300_000_000_000n,
  grass: 1_200_000_000_000n,
  forest: 4_800_000_000_000n,
};
const TEMP_CONFIG: Record<TemporaryUpgrade, { cost: bigint; durationMs: number }> = {
  'sunny-season': { cost: 150n * NATURE_SCALE, durationMs: 60_000 },
  'deep-roots': { cost: 1_500n * NATURE_SCALE, durationMs: 90_000 },
};
const UPGRADE_NAMES: readonly PPUpgrade[] = ['growth', 'efficiency', 'awakening', 'rebirth'];

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) throw new RangeError('Expected non-negative division.');
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function mulDivFloor(left: bigint, right: bigint, denominator: bigint): bigint {
  return (left * right) / denominator;
}

function mulDivCeil(left: bigint, right: bigint, denominator: bigint): bigint {
  return ceilDiv(left * right, denominator);
}

function fixedPower(
  numerator: bigint,
  denominator: bigint,
  exponent: number,
  rounding: 'floor' | 'ceil',
): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || denominator <= 0n)
    throw new RulesError('INVALID_COMMAND', 'Invalid multiplier exponent.');
  const multiply = rounding === 'floor' ? mulDivFloor : mulDivCeil;
  let result = NATURE_SCALE;
  let factor =
    rounding === 'floor'
      ? mulDivFloor(numerator, NATURE_SCALE, denominator)
      : mulDivCeil(numerator, NATURE_SCALE, denominator);
  let remaining = BigInt(exponent);
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n)
      result = minBigInt(MAX_FACTOR_Q, multiply(result, factor, NATURE_SCALE));
    remaining >>= 1n;
    if (remaining > 0n) factor = minBigInt(MAX_FACTOR_Q, multiply(factor, factor, NATURE_SCALE));
    if (factor === 0n && rounding === 'floor') return 0n;
  }
  return result;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function seasonEndMs(seasonId: number): number {
  if (!Number.isSafeInteger(seasonId)) throw new RulesError('INVALID_RUN', 'Invalid season ID.');
  const value =
    BigInt(SEASON_EPOCH_MONDAY_SECONDS * MILLIS_PER_SECOND) +
    (BigInt(seasonId) + 1n) * BigInt(SEASON_LENGTH_SECONDS * MILLIS_PER_SECOND);
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp))
    throw new RulesError('INVALID_RUN', 'Season end is outside safe timestamp bounds.');
  return timestamp;
}

function totalLevels(levels: HabitatLevels): bigint {
  return BigInt(levels.water) + BigInt(levels.grass) + BigInt(levels.forest);
}

function validateLevels(levels: UpgradeLevels): void {
  for (const upgrade of UPGRADE_NAMES) {
    if (
      !Number.isSafeInteger(levels[upgrade]) ||
      levels[upgrade] < 0 ||
      levels[upgrade] > MAX_UPGRADE_LEVEL
    )
      throw new RulesError(
        'INVALID_UPGRADE_CHOICES',
        'Upgrade levels are outside the rules bounds.',
      );
  }
}

export function ppUpgradeCost(level: number, quantity: number): bigint {
  if (!Number.isSafeInteger(level) || !Number.isSafeInteger(quantity) || quantity <= 0)
    throw new RulesError(
      'INVALID_UPGRADE_CHOICES',
      'Upgrade quantities must be positive integers.',
    );
  if (level + quantity > MAX_UPGRADE_LEVEL)
    throw new RulesError('INVALID_UPGRADE_CHOICES', 'Upgrade level cap exceeded.');
  const q = BigInt(quantity);
  const current = BigInt(level);
  return (q * (2n * current + q + 1n)) / 2n;
}

function applyUpgradeChoices(
  pp: bigint,
  levels: UpgradeLevels,
  choices: readonly UpgradeChoice[],
): { pp: bigint; levels: UpgradeLevels; choices: UpgradeChoice[] } {
  validateLevels(levels);
  let previousIndex = -1;
  let remainingPP = pp;
  const nextLevels = { ...levels };
  const canonicalChoices: UpgradeChoice[] = [];
  for (const choice of choices) {
    const index = UPGRADE_NAMES.indexOf(choice.upgradeId);
    if (index <= previousIndex || !Number.isSafeInteger(choice.quantity) || choice.quantity <= 0) {
      throw new RulesError(
        'INVALID_UPGRADE_CHOICES',
        'Upgrade choices must be unique and canonically ordered.',
      );
    }
    previousIndex = index;
    const cost = ppUpgradeCost(nextLevels[choice.upgradeId], choice.quantity);
    if (remainingPP < cost) throw new RulesError('INSUFFICIENT_PP', 'Not enough seasonal PP.');
    remainingPP -= cost;
    nextLevels[choice.upgradeId] += choice.quantity;
    canonicalChoices.push({ upgradeId: choice.upgradeId, quantity: choice.quantity });
  }
  return { pp: remainingPP, levels: nextLevels, choices: canonicalChoices };
}

/** Creates canonical run state and atomically settles season upgrade choices. */
export function createCanonicalRun(input: CanonicalRunInput): CanonicalRunState {
  if (
    !input.runId ||
    !Number.isSafeInteger(input.seasonId) ||
    !Number.isSafeInteger(input.startedAtMs) ||
    input.startedAtMs < 0 ||
    input.seasonId !== seasonIdAtMilliseconds(input.startedAtMs) ||
    input.seasonalPP < 0n ||
    !Number.isSafeInteger(input.seasonRebirths) ||
    input.seasonRebirths < 0
  ) {
    throw new RulesError('INVALID_RUN', 'Run context is invalid.');
  }
  const applied = applyUpgradeChoices(
    input.seasonalPP,
    input.existingUpgrades,
    input.upgradeChoices,
  );
  const initialNature = BigInt(applied.levels.awakening) * 5n * NATURE_SCALE;
  return {
    rulesVersion: RULES_VERSION,
    runId: input.runId,
    seasonId: input.seasonId,
    startedAtMs: input.startedAtMs,
    lastServerTimeMs: input.startedAtMs,
    natureAtoms: minBigInt(initialNature, MAX_NATURE_ATOMS),
    earnedNatureAtoms: 0n,
    productionRemainderMilliAtoms: 0n,
    habitats: { water: 0, grass: 0, forest: 0 },
    upgrades: applied.levels,
    temporaryMs: { 'sunny-season': 0, 'deep-roots': 0 },
    seasonalPP: applied.pp,
    seasonRebirths: input.seasonRebirths,
    activeMilliseconds: 0,
    sequence: 0,
    status: 'active',
    upgradeChoices: applied.choices,
  };
}

function activeFactorQ(state: CanonicalRunState): bigint {
  const waterGrass = Math.min(state.habitats.water, state.habitats.grass, 100);
  const grassForest = Math.min(state.habitats.grass, state.habitats.forest, 100);
  let factor = NATURE_SCALE + BigInt(25 * waterGrass + 60 * grassForest) * (NATURE_SCALE / 1_000n);
  const levels = totalLevels(state.habitats);
  const milestone =
    levels >= 100n
      ? [3n, 1n]
      : levels >= 40n
        ? [2n, 1n]
        : levels >= 15n
          ? [3n, 2n]
          : levels >= 5n
            ? [6n, 5n]
            : [1n, 1n];
  factor = minBigInt(MAX_FACTOR_Q, mulDivFloor(factor, milestone[0], milestone[1]));
  factor = minBigInt(
    MAX_FACTOR_Q,
    mulDivFloor(factor, fixedPower(3n, 2n, state.upgrades.growth, 'floor'), NATURE_SCALE),
  );
  if (state.temporaryMs['sunny-season'] > 0) factor = minBigInt(MAX_FACTOR_Q, factor * 2n);
  if (state.temporaryMs['deep-roots'] > 0) factor = minBigInt(MAX_FACTOR_Q, factor * 3n);
  return factor;
}

export function productionPerSecondAtoms(state: CanonicalRunState): bigint {
  let base = 0n;
  for (const habitat of HABITATS)
    base += BigInt(state.habitats[habitat]) * BASE_RATE_ATOMS_PER_SECOND[habitat];
  return minBigInt(MAX_NATURE_ATOMS, mulDivFloor(base, activeFactorQ(state), NATURE_SCALE));
}

function credit(
  state: CanonicalRunState,
  amount: bigint,
): { state: CanonicalRunState; credited: bigint } {
  if (amount <= 0n) return { state, credited: 0n };
  const spendableRoom = maxBigInt(0n, MAX_NATURE_ATOMS - state.natureAtoms);
  const credited = minBigInt(amount, spendableRoom);
  // Only Nature actually credited to the run counts as earned; spending never reverses it.
  const earned = minBigInt(MAX_NATURE_ATOMS, state.earnedNatureAtoms + credited);
  return {
    state: { ...state, natureAtoms: state.natureAtoms + credited, earnedNatureAtoms: earned },
    credited,
  };
}

function advanceSegment(state: CanonicalRunState, milliseconds: number): CanonicalRunState {
  if (milliseconds <= 0) return state;
  const rate = productionPerSecondAtoms(state);
  const numerator = rate * BigInt(milliseconds) + state.productionRemainderMilliAtoms;
  const generatedAtoms = numerator / BigInt(MILLIS_PER_SECOND);
  const remainder = numerator % BigInt(MILLIS_PER_SECOND);
  const credited = credit(state, generatedAtoms);
  return {
    ...credited.state,
    productionRemainderMilliAtoms: remainder,
    temporaryMs: {
      'sunny-season': Math.max(0, state.temporaryMs['sunny-season'] - milliseconds),
      'deep-roots': Math.max(0, state.temporaryMs['deep-roots'] - milliseconds),
    },
    activeMilliseconds: state.activeMilliseconds + milliseconds,
  };
}

/** Advances passive production using elapsed server milliseconds, capped at eight hours. */
export function advanceCanonicalRun(
  state: CanonicalRunState,
  serverTimeMs: number,
): CanonicalRunState {
  if (!Number.isSafeInteger(serverTimeMs) || serverTimeMs < state.lastServerTimeMs)
    throw new RulesError('INVALID_TIME', 'Server time must be monotonic integer milliseconds.');
  if (state.status !== 'active') throw new RulesError('RUN_NOT_ACTIVE', 'Run is not active.');
  const end = seasonEndMs(state.seasonId);
  if (state.lastServerTimeMs >= end || serverTimeMs >= end)
    throw new RulesError('SEASON_EXPIRED', 'Run season has ended.');
  const elapsed = Math.min(
    serverTimeMs - state.lastServerTimeMs,
    MAX_OFFLINE_MS,
    end - state.lastServerTimeMs,
  );
  let remaining = elapsed;
  let next = state;
  while (remaining > 0) {
    const temporaryRemaining = [
      next.temporaryMs['sunny-season'],
      next.temporaryMs['deep-roots'],
    ].filter((duration) => duration > 0);
    const untilEffectChange = temporaryRemaining.length
      ? Math.min(...temporaryRemaining)
      : remaining;
    const segment = Math.min(remaining, untilEffectChange);
    next = advanceSegment(next, segment);
    remaining -= segment;
  }
  return { ...next, lastServerTimeMs: serverTimeMs };
}

function habitatUnitCost(state: CanonicalRunState, habitat: Habitat, level: number): bigint {
  if (!Number.isSafeInteger(level) || level < 0)
    throw new RulesError('INVALID_COMMAND', 'Invalid habitat level.');
  const [growthNumerator, growthDenominator] = COST_GROWTH[habitat];
  const growthQ = fixedPower(growthNumerator, growthDenominator, level, 'ceil');
  const efficiencyQ = fixedPower(9n, 10n, state.upgrades.efficiency, 'ceil');
  const withGrowth = mulDivCeil(BASE_COST_ATOMS[habitat], growthQ, NATURE_SCALE);
  return minBigInt(MAX_NATURE_ATOMS, mulDivCeil(withGrowth, efficiencyQ, NATURE_SCALE));
}

export function habitatPurchaseCost(
  state: CanonicalRunState,
  habitat: Habitat,
  quantity: number,
): bigint {
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > MAX_COMMAND_PURCHASE)
    throw new RulesError(
      'PURCHASE_LIMIT',
      `Purchase quantity must be between 1 and ${MAX_COMMAND_PURCHASE}.`,
    );
  if (!HABITATS.includes(habitat)) throw new RulesError('INVALID_COMMAND', 'Unknown habitat.');
  if (state.habitats[habitat] + quantity > Number.MAX_SAFE_INTEGER)
    throw new RulesError('PURCHASE_LIMIT', 'Habitat level cap exceeded.');
  let cost = habitatUnitCost(state, habitat, state.habitats[habitat]);
  let total = 0n;
  const [numerator, denominator] = COST_GROWTH[habitat];
  for (let index = 0; index < quantity; index++) {
    total = minBigInt(MAX_NATURE_ATOMS, total + cost);
    cost = minBigInt(MAX_NATURE_ATOMS, mulDivCeil(cost, numerator, denominator));
  }
  return total;
}

function spend(state: CanonicalRunState, amount: bigint): CanonicalRunState {
  if (state.natureAtoms < amount) throw new RulesError('INSUFFICIENT_NATURE', 'Not enough Nature.');
  return { ...state, natureAtoms: state.natureAtoms - amount };
}

/** Applies a validated gameplay command after advancing to its server-assigned time. */
export function applyCanonicalCommand(
  prior: CanonicalRunState,
  command: GameplayCommand,
  serverTimeMs: number,
): RulesResult {
  const advanced = advanceCanonicalRun(prior, serverTimeMs);
  let state = advanced;
  let creditedAtoms = advanced.earnedNatureAtoms - prior.earnedNatureAtoms;
  let spentAtoms = 0n;
  switch (command.type) {
    case 'sync':
      break;
    case 'heart-click': {
      const generated = credit(state, NATURE_SCALE);
      state = generated.state;
      creditedAtoms += generated.credited;
      break;
    }
    case 'buy-habitat': {
      if (!HABITATS.includes(command.habitat))
        throw new RulesError('INVALID_COMMAND', 'Unknown habitat.');
      const cost = habitatPurchaseCost(state, command.habitat, command.quantity);
      state = spend(state, cost);
      state = {
        ...state,
        habitats: {
          ...state.habitats,
          [command.habitat]: state.habitats[command.habitat] + command.quantity,
        },
      };
      spentAtoms = cost;
      break;
    }
    case 'buy-temporary-upgrade': {
      const config = TEMP_CONFIG[command.upgrade];
      if (!config) throw new RulesError('INVALID_COMMAND', 'Unknown temporary upgrade.');
      state = spend(state, config.cost);
      state = {
        ...state,
        temporaryMs: { ...state.temporaryMs, [command.upgrade]: config.durationMs },
      };
      spentAtoms = config.cost;
      break;
    }
    default: {
      const exhaustive: never = command;
      throw new RulesError('INVALID_COMMAND', `Unsupported command: ${String(exhaustive)}.`);
    }
  }
  if (prior.sequence >= Number.MAX_SAFE_INTEGER)
    throw new RulesError('INVALID_COMMAND', 'Run command sequence is exhausted.');
  return {
    state: { ...state, sequence: prior.sequence + 1 },
    creditedAtoms,
    spentAtoms,
  };
}

/** Exact monotonic score normalization from cumulative earned atoms. */
export function scoreTierFromEarnedNature(earnedNatureAtoms: bigint): number {
  if (earnedNatureAtoms < 0n) throw new RangeError('Earned Nature cannot be negative.');
  const atoms = minBigInt(earnedNatureAtoms, MAX_NATURE_ATOMS);
  if (atoms < NATURE_SCALE) return 0;
  const digits = atoms.toString().length;
  const exponent = digits - 13;
  if (exponent >= MAX_SCORE_EXPONENT) return MAX_SCORE_TIER;
  const significandQ = atoms / 10n ** BigInt(exponent);
  const thresholds = [
    1_000_000_000_000n,
    1_250_000_000_000n,
    1_500_000_000_000n,
    2_000_000_000_000n,
    3_000_000_000_000n,
    5_000_000_000_000n,
    7_500_000_000_000n,
  ];
  let bucket = 0;
  for (let index = 1; index < thresholds.length; index++) {
    if (significandQ >= thresholds[index]!) bucket = index;
    else break;
  }
  return Math.min(MAX_SCORE_TIER, 7 * exponent + bucket);
}

/** The approved guest-compatible Monday 00:00 UTC season index. */
export function seasonIdAtMilliseconds(timestampMs: number): number {
  if (!Number.isSafeInteger(timestampMs))
    throw new RulesError('INVALID_TIME', 'Timestamp must be integer milliseconds.');
  const delta = BigInt(timestampMs) - BigInt(SEASON_EPOCH_MONDAY_SECONDS * MILLIS_PER_SECOND);
  const week = BigInt(SEASON_LENGTH_SECONDS * MILLIS_PER_SECOND);
  let seasonId = delta / week;
  if (delta < 0n && delta % week !== 0n) seasonId -= 1n;
  return Number(seasonId);
}

export function seasonEndAtMilliseconds(seasonId: number): number {
  return seasonEndMs(seasonId);
}

export function serializeCanonicalRun(state: CanonicalRunState): string {
  return JSON.stringify({
    ...state,
    natureAtoms: state.natureAtoms.toString(),
    earnedNatureAtoms: state.earnedNatureAtoms.toString(),
    productionRemainderMilliAtoms: state.productionRemainderMilliAtoms.toString(),
    seasonalPP: state.seasonalPP.toString(),
    upgradeChoices: state.upgradeChoices.map((choice) => ({ ...choice })),
  });
}

export function deserializeCanonicalRun(serialized: string): CanonicalRunState {
  const value = JSON.parse(serialized) as Omit<
    CanonicalRunState,
    'natureAtoms' | 'earnedNatureAtoms' | 'productionRemainderMilliAtoms' | 'seasonalPP'
  > & {
    natureAtoms: string;
    earnedNatureAtoms: string;
    productionRemainderMilliAtoms: string;
    seasonalPP: string;
  };
  const state: CanonicalRunState = {
    ...value,
    natureAtoms: BigInt(value.natureAtoms),
    earnedNatureAtoms: BigInt(value.earnedNatureAtoms),
    productionRemainderMilliAtoms: BigInt(value.productionRemainderMilliAtoms),
    seasonalPP: BigInt(value.seasonalPP),
  };
  validateCanonicalRun(state);
  return state;
}

export function validateCanonicalRun(value: unknown): asserts value is CanonicalRunState {
  if (!value || typeof value !== 'object')
    throw new RulesError('INVALID_RUN', 'Canonical run is invalid.');
  const state = value as CanonicalRunState;
  if (
    state.rulesVersion !== RULES_VERSION ||
    typeof state.runId !== 'string' ||
    state.runId.length === 0 ||
    !Number.isSafeInteger(state.seasonId) ||
    !Number.isSafeInteger(state.startedAtMs) ||
    state.startedAtMs < 0 ||
    state.seasonId !== seasonIdAtMilliseconds(state.startedAtMs) ||
    !Number.isSafeInteger(state.lastServerTimeMs) ||
    state.lastServerTimeMs < state.startedAtMs ||
    typeof state.natureAtoms !== 'bigint' ||
    state.natureAtoms < 0n ||
    state.natureAtoms > MAX_NATURE_ATOMS ||
    typeof state.earnedNatureAtoms !== 'bigint' ||
    state.earnedNatureAtoms < 0n ||
    state.earnedNatureAtoms > MAX_NATURE_ATOMS ||
    typeof state.productionRemainderMilliAtoms !== 'bigint' ||
    state.productionRemainderMilliAtoms < 0n ||
    state.productionRemainderMilliAtoms >= BigInt(MILLIS_PER_SECOND) ||
    !Number.isSafeInteger(state.sequence) ||
    state.sequence < 0 ||
    !Number.isSafeInteger(state.activeMilliseconds) ||
    state.activeMilliseconds < 0 ||
    typeof state.seasonalPP !== 'bigint' ||
    state.seasonalPP < 0n ||
    !Number.isSafeInteger(state.seasonRebirths) ||
    state.seasonRebirths < 0 ||
    !['active', 'expired', 'abandoned', 'reborn'].includes(state.status) ||
    !Array.isArray(state.upgradeChoices)
  )
    throw new RulesError('INVALID_RUN', 'Canonical run fields are malformed or outside bounds.');
  for (const habitat of HABITATS)
    if (!Number.isSafeInteger(state.habitats?.[habitat]) || state.habitats[habitat] < 0)
      throw new RulesError('INVALID_RUN', 'Canonical habitat level is invalid.');
  validateLevels(state.upgrades);
  for (const upgrade of TEMP_UPGRADES)
    if (!Number.isSafeInteger(state.temporaryMs?.[upgrade]) || state.temporaryMs[upgrade] < 0)
      throw new RulesError('INVALID_RUN', 'Temporary upgrade duration is invalid.');
  let previousUpgradeIndex = -1;
  for (const choice of state.upgradeChoices) {
    const index = UPGRADE_NAMES.indexOf(choice.upgradeId);
    if (
      index <= previousUpgradeIndex ||
      !Number.isSafeInteger(choice.quantity) ||
      choice.quantity <= 0
    )
      throw new RulesError('INVALID_RUN', 'Upgrade choices are malformed or not canonical.');
    previousUpgradeIndex = index;
  }
}
