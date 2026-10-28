import { describe, expect, it } from 'vitest';
import {
  HABITAT_EXPANSION_RULES_VERSION,
  HABITAT_IDS_V2,
  HABITAT_RULES_V2,
  HABITAT_UPGRADE_MILESTONES,
  availableHabitatMilestoneUpgrades,
  habitatBaseCostAtomsV2,
  habitatBaseProductionAtomsPerSecondV2,
  habitatProductionUpgradeMultiplier,
} from './habitatExpansionV2';

describe('isolated six-habitat ruleset proposal', () => {
  it('is explicitly versioned separately from the active V1 rules', () => {
    expect(HABITAT_EXPANSION_RULES_VERSION).toBe(2);
    expect(HABITAT_IDS_V2).toEqual([
      'water',
      'grass',
      'forest',
      'mountain',
      'crystal-cavern',
      'ancient-grove',
    ]);
  });

  it('keeps the approved provisional costs, rates, and scaling values exact', () => {
    expect(HABITAT_RULES_V2.mountain).toEqual({
      baseCostNature: 300n,
      baseProductionPerSecondTenths: 160n,
      costGrowth: [121n, 100n],
    });
    expect(HABITAT_RULES_V2['crystal-cavern']).toEqual({
      baseCostNature: 1_200n,
      baseProductionPerSecondTenths: 640n,
      costGrowth: [123n, 100n],
    });
    expect(HABITAT_RULES_V2['ancient-grove']).toEqual({
      baseCostNature: 4_800n,
      baseProductionPerSecondTenths: 2_560n,
      costGrowth: [125n, 100n],
    });
  });

  it('preserves exact existing habitat production tenths in the isolated proposal', () => {
    expect(HABITAT_RULES_V2.water.baseProductionPerSecondTenths).toBe(3n);
    expect(HABITAT_RULES_V2.grass.baseProductionPerSecondTenths).toBe(12n);
    expect(HABITAT_RULES_V2.forest.baseProductionPerSecondTenths).toBe(48n);
  });

  it('normalizes approved values to canonical Nature atoms without floating point', () => {
    expect(habitatBaseCostAtomsV2('mountain')).toBe(300_000_000_000_000n);
    expect(habitatBaseProductionAtomsPerSecondV2('mountain')).toBe(16_000_000_000_000n);
    expect(habitatBaseCostAtomsV2('crystal-cavern')).toBe(1_200_000_000_000_000n);
    expect(habitatBaseProductionAtomsPerSecondV2('crystal-cavern')).toBe(64_000_000_000_000n);
    expect(habitatBaseCostAtomsV2('ancient-grove')).toBe(4_800_000_000_000_000n);
    expect(habitatBaseProductionAtomsPerSecondV2('ancient-grove')).toBe(256_000_000_000_000n);
  });

  it('unlocks one unpurchased upgrade at each owned-habitat threshold', () => {
    expect(HABITAT_UPGRADE_MILESTONES).toEqual([10, 25, 50, 100]);
    expect(availableHabitatMilestoneUpgrades(24)).toEqual([10]);
    expect(availableHabitatMilestoneUpgrades(50, [10, 25])).toEqual([50]);
    expect(availableHabitatMilestoneUpgrades(100, [10, 25, 50, 100])).toEqual([]);
  });

  it('models one doubling per purchase and caps at ×16 without defining prices', () => {
    expect([0, 1, 2, 3, 4, 10].map(habitatProductionUpgradeMultiplier)).toEqual([
      1, 2, 4, 8, 16, 16,
    ]);
  });

  it('rejects invalid ownership levels and duplicate or unsupported milestones', () => {
    expect(() => availableHabitatMilestoneUpgrades(-1)).toThrow(RangeError);
    expect(() => availableHabitatMilestoneUpgrades(10, [10, 10])).toThrow(RangeError);
    expect(() => availableHabitatMilestoneUpgrades(10, [20])).toThrow(RangeError);
    expect(() => habitatProductionUpgradeMultiplier(-1)).toThrow(RangeError);
  });
});
