/**
 * Provisional rules data for the six-habitat expansion.
 *
 * This module is intentionally isolated from rulesV1 and the verifier command
 * protocol. Activating these values requires a rules-version migration and
 * coordinated client/verifier support.
 */

export const HABITAT_EXPANSION_RULES_VERSION = 2 as const;
export const NATURE_ATOMS_PER_NATURE_V2 = 1_000_000_000_000n;
export const HABITAT_IDS_V2 = [
  'water',
  'grass',
  'forest',
  'mountain',
  'crystal-cavern',
  'ancient-grove',
] as const;

export type HabitatIdV2 = (typeof HABITAT_IDS_V2)[number];
export type HabitatUpgradeMilestone = 10 | 25 | 50 | 100;

export const HABITAT_UPGRADE_MILESTONES = [
  10, 25, 50, 100,
] as const satisfies readonly HabitatUpgradeMilestone[];
export const MAX_HABITAT_PRODUCTION_MULTIPLIER = 16;

export interface HabitatRuleV2 {
  baseCostNature: bigint;
  baseProductionPerSecondTenths: bigint;
  costGrowth: readonly [numerator: bigint, denominator: bigint];
}

/** Rates use exact tenths so Water's existing 0.3 Nature/sec stays representable. */
export const HABITAT_RULES_V2: Readonly<Record<HabitatIdV2, HabitatRuleV2>> = {
  water: {
    baseCostNature: 10n,
    baseProductionPerSecondTenths: 3n,
    costGrowth: [115n, 100n],
  },
  grass: {
    baseCostNature: 28n,
    baseProductionPerSecondTenths: 12n,
    costGrowth: [117n, 100n],
  },
  forest: {
    baseCostNature: 90n,
    baseProductionPerSecondTenths: 48n,
    costGrowth: [119n, 100n],
  },
  mountain: {
    baseCostNature: 300n,
    baseProductionPerSecondTenths: 160n,
    costGrowth: [121n, 100n],
  },
  'crystal-cavern': {
    baseCostNature: 1_200n,
    baseProductionPerSecondTenths: 640n,
    costGrowth: [123n, 100n],
  },
  'ancient-grove': {
    baseCostNature: 4_800n,
    baseProductionPerSecondTenths: 2_560n,
    costGrowth: [125n, 100n],
  },
};

export function habitatBaseCostAtomsV2(habitat: HabitatIdV2): bigint {
  return HABITAT_RULES_V2[habitat].baseCostNature * NATURE_ATOMS_PER_NATURE_V2;
}

export function habitatBaseProductionAtomsPerSecondV2(habitat: HabitatIdV2): bigint {
  return (
    HABITAT_RULES_V2[habitat].baseProductionPerSecondTenths * (NATURE_ATOMS_PER_NATURE_V2 / 10n)
  );
}

export type PurchasedHabitatMilestones = Readonly<
  Partial<Record<HabitatIdV2, readonly HabitatUpgradeMilestone[]>>
>;

/** Returns purchasable milestone upgrades; prices and command semantics are deliberately unset. */
export function availableHabitatMilestoneUpgrades(
  habitatLevel: number,
  purchased: readonly number[] = [],
): HabitatUpgradeMilestone[] {
  if (!Number.isSafeInteger(habitatLevel) || habitatLevel < 0)
    throw new RangeError('Habitat level must be a non-negative safe integer.');
  const bought = new Set<number>();
  for (const milestone of purchased) {
    if (
      !(HABITAT_UPGRADE_MILESTONES as readonly number[]).includes(milestone) ||
      bought.has(milestone)
    )
      throw new RangeError('Purchased habitat milestones must be unique supported values.');
    bought.add(milestone);
  }
  return HABITAT_UPGRADE_MILESTONES.filter(
    (milestone) => habitatLevel >= milestone && !bought.has(milestone),
  );
}

/** Each purchased milestone doubles production, capped at the proposed ×16 ceiling. */
export function habitatProductionUpgradeMultiplier(purchasedCount: number): number {
  if (!Number.isSafeInteger(purchasedCount) || purchasedCount < 0)
    throw new RangeError('Purchased upgrade count must be a non-negative safe integer.');
  return Math.min(MAX_HABITAT_PRODUCTION_MULTIPLIER, 2 ** Math.min(purchasedCount, 4));
}
