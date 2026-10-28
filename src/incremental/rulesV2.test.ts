import { describe, expect, it } from 'vitest';
import {
  applyCanonicalCommand,
  createCanonicalRun,
  deserializeCanonicalRun,
  HABITATS,
  habitatProductionUpgradeCost,
  NATURE_SCALE,
  productionPerSecondAtoms,
  serializeCanonicalRun,
  type CanonicalRunState,
} from './rulesV2';

const MONDAY_EPOCH_MS = 4 * 24 * 60 * 60 * 1_000;
const emptyUpgrades = { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 } as const;

function run(): CanonicalRunState {
  return createCanonicalRun({
    runId: 'v2-run-1',
    seasonId: 0,
    startedAtMs: MONDAY_EPOCH_MS,
    seasonalPP: 0n,
    existingUpgrades: emptyUpgrades,
    seasonRebirths: 0,
    upgradeChoices: [],
  });
}

function fundedRun(overrides: Partial<CanonicalRunState> = {}): CanonicalRunState {
  return {
    ...run(),
    natureAtoms: 100_000_000n * NATURE_SCALE,
    ...overrides,
  };
}

describe('canonical rules v2 habitat expansion', () => {
  it('creates six-habitat state and purchases each approved habitat deterministically', () => {
    let state = fundedRun();
    expect(HABITATS).toEqual([
      'water',
      'grass',
      'forest',
      'mountain',
      'crystal-cavern',
      'ancient-grove',
    ]);

    for (const habitat of HABITATS) {
      const prior = state;
      const result = applyCanonicalCommand(
        state,
        { type: 'buy-habitat', habitat, quantity: 1 },
        MONDAY_EPOCH_MS,
      );
      expect(result.state.habitats[habitat]).toBe(1);
      expect(result.state.natureAtoms).toBe(prior.natureAtoms - result.spentAtoms);
      state = result.state;
    }

    expect(state.habitats).toEqual({
      water: 1,
      grass: 1,
      forest: 1,
      mountain: 1,
      'crystal-cavern': 1,
      'ancient-grove': 1,
    });
    expect(productionPerSecondAtoms(state)).toBeGreaterThan(0n);
  });

  it('applies sequential ownership milestones at base cost × milestone squared, without Efficiency discounts', () => {
    for (const habitat of HABITATS) {
      const levels = { ...run().habitats, [habitat]: 100 };
      let state = fundedRun({ habitats: levels });
      let previousProduction = productionPerSecondAtoms(state);
      for (const milestone of [10, 25, 50, 100] as const) {
        const result = applyCanonicalCommand(
          state,
          { type: 'buy-habitat-production-upgrade', habitat, milestone },
          MONDAY_EPOCH_MS,
        );
        expect(result.spentAtoms).toBe(habitatProductionUpgradeCost(habitat, milestone));
        expect(result.state.habitatProductionUpgrades[habitat]).toEqual(
          [10, 25, 50, 100].slice(0, [10, 25, 50, 100].indexOf(milestone) + 1),
        );
        expect(productionPerSecondAtoms(result.state)).toBeGreaterThanOrEqual(
          previousProduction * 2n,
        );
        previousProduction = productionPerSecondAtoms(result.state);
        state = result.state;
      }
      expect(state.habitatProductionUpgrades[habitat]).toHaveLength(4);
    }

    const efficiencyLevels = { ...run().habitats, mountain: 10 };
    const noEfficiency = fundedRun({ habitats: efficiencyLevels });
    const withEfficiency = fundedRun({
      habitats: efficiencyLevels,
      upgrades: { ...emptyUpgrades, efficiency: 10 },
    });
    const priceWithoutEfficiency = applyCanonicalCommand(
      noEfficiency,
      { type: 'buy-habitat-production-upgrade', habitat: 'mountain', milestone: 10 },
      MONDAY_EPOCH_MS,
    ).spentAtoms;
    const priceWithEfficiency = applyCanonicalCommand(
      withEfficiency,
      { type: 'buy-habitat-production-upgrade', habitat: 'mountain', milestone: 10 },
      MONDAY_EPOCH_MS,
    ).spentAtoms;
    expect(priceWithEfficiency).toBe(priceWithoutEfficiency);
  });

  it('rejects skipped milestones and milestones without enough owned habitats', () => {
    expect(() =>
      applyCanonicalCommand(
        fundedRun({ habitats: { ...run().habitats, water: 25 } }),
        { type: 'buy-habitat-production-upgrade', habitat: 'water', milestone: 25 },
        MONDAY_EPOCH_MS,
      ),
    ).toThrow(/sequentially/);
    expect(() =>
      applyCanonicalCommand(
        fundedRun({ habitats: { ...run().habitats, water: 9 } }),
        { type: 'buy-habitat-production-upgrade', habitat: 'water', milestone: 10 },
        MONDAY_EPOCH_MS,
      ),
    ).toThrow(/ownership milestone/);
  });

  it('serializes upgrade state and begins a fresh run with upgrades reset', () => {
    const levels = { ...run().habitats, 'crystal-cavern': 10 };
    const upgraded = applyCanonicalCommand(
      fundedRun({ habitats: levels }),
      { type: 'buy-habitat-production-upgrade', habitat: 'crystal-cavern', milestone: 10 },
      MONDAY_EPOCH_MS,
    ).state;
    const recovered = deserializeCanonicalRun(serializeCanonicalRun(upgraded));
    expect(recovered.habitatProductionUpgrades['crystal-cavern']).toEqual([10]);

    const nextRun = createCanonicalRun({
      runId: 'v2-run-2',
      seasonId: 0,
      startedAtMs: MONDAY_EPOCH_MS,
      seasonalPP: recovered.seasonalPP,
      existingUpgrades: recovered.upgrades,
      seasonRebirths: 1,
      upgradeChoices: [],
    });
    expect(
      Object.values(nextRun.habitatProductionUpgrades).every((items) => items.length === 0),
    ).toBe(true);
  });
});
