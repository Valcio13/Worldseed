import { describe, expect, it } from 'vitest';
import vectors from './v3TestVectors.json';
import {
  createCanonicalRun,
  habitatPurchaseCost,
  ppUpgradeCost,
  advanceCanonicalRun,
  productionPerSecondAtoms,
  scoreTierFromEarnedNature,
  seasonIdAtMilliseconds,
  type Habitat,
} from './rulesV1';

describe('published cross-language V3 arithmetic vectors', () => {
  const initial = createCanonicalRun({
    runId: 'vector-run',
    seasonId: 0,
    startedAtMs: 345_600_000,
    seasonalPP: 0n,
    existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
    seasonRebirths: 0,
    upgradeChoices: [],
  });

  it('matches exact score tiers, including fractional zero and uint16 saturation', () => {
    for (const vector of vectors.score) {
      const atoms =
        typeof vector.earnedNatureAtomsPowerOfTen === 'number'
          ? 10n ** BigInt(vector.earnedNatureAtomsPowerOfTen)
          : BigInt(vector.earnedNatureAtoms);
      expect(scoreTierFromEarnedNature(atoms)).toBe(vector.scoreTier);
    }
  });

  it('matches integer-ceiling habitat costs and exact PP upgrade costs', () => {
    for (const vector of vectors.habitatCost)
      expect(
        habitatPurchaseCost(initial, vector.habitat as Habitat, vector.quantity).toString(),
      ).toBe(vector.costAtoms);
    expect(
      ppUpgradeCost(vectors.ppUpgradeCost.initialLevel, vectors.ppUpgradeCost.quantity).toString(),
    ).toBe(vectors.ppUpgradeCost.cost);
  });

  it('matches cost-ceiling and fractional production-floor vectors with carried remainder', () => {
    const costState = createCanonicalRun({
      runId: 'ceil-vector',
      seasonId: 0,
      startedAtMs: 345_600_000,
      seasonalPP: 0n,
      existingUpgrades: {
        growth: 0,
        efficiency: vectors.rounding.costCeil.efficiencyLevel,
        awakening: 0,
        rebirth: 0,
      },
      seasonRebirths: 0,
      upgradeChoices: [],
    });
    expect(
      habitatPurchaseCost(costState, 'water', vectors.rounding.costCeil.quantity).toString(),
    ).toBe(vectors.rounding.costCeil.costAtoms);

    let productionState = createCanonicalRun({
      runId: 'floor-vector',
      seasonId: 0,
      startedAtMs: 345_600_000,
      seasonalPP: 0n,
      existingUpgrades: {
        growth: vectors.rounding.productionFloor.growthLevel,
        efficiency: 0,
        awakening: 0,
        rebirth: 0,
      },
      seasonRebirths: 0,
      upgradeChoices: [],
    });
    productionState = { ...productionState, habitats: vectors.rounding.productionFloor.habitats };
    expect(productionPerSecondAtoms(productionState).toString()).toBe(
      vectors.rounding.productionFloor.rateAtomsPerSecond,
    );
    productionState = advanceCanonicalRun(
      productionState,
      345_600_000 + vectors.rounding.productionFloor.durationMs,
    );
    expect(productionState.earnedNatureAtoms.toString()).toBe(
      vectors.rounding.productionFloor.earnedNatureAtoms,
    );
    expect(productionState.productionRemainderMilliAtoms.toString()).toBe(
      vectors.rounding.productionFloor.remainderMilliAtoms,
    );
  });

  it('matches Monday UTC season start and end boundaries', () => {
    for (const vector of vectors.seasonBoundaries)
      expect(seasonIdAtMilliseconds(vector.timestampMs)).toBe(vector.seasonId);
  });
});
