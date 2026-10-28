import { describe, expect, it } from 'vitest';
import { compareValues, formatValue, valueFromNumber, valueToNumber } from './decimal';
import {
  buyHabitat,
  buyHabitatProductionUpgrade,
  buyFertileSoil,
  buyPPUpgrade,
  buyTemporaryUpgrade,
  buyTimeBloom,
  applyOfflineProgress,
  canRebirth,
  clickIslandHeart,
  createEconomyState,
  HABITAT_BASE_COST,
  HABITAT_BASE_RATE,
  HABITAT_COST_GROWTH,
  habitatBulkCost,
  habitatProductionPerSecond,
  habitatProductionUpgradeCost,
  fertileSoilCost,
  habitatUnitCost,
  performRebirth,
  productionPerSecond,
  rebirthReward,
  resetForNewSeason,
  seasonIdAt,
  tickEconomy,
  timeBloomCost,
  validateEconomyState,
  HABITAT_UPGRADE_MILESTONES,
  REBIRTH_MULTIPLIERS,
  rebirthRequirement,
} from './engine';

describe('guest incremental economy', () => {
  it('starts with zero Nature and starts progression with a Heart click', () => {
    const start = createEconomyState(1);
    expect(start.nature).toEqual(valueFromNumber(0));
    expect(productionPerSecond(start)).toEqual(valueFromNumber(0));
    const click = clickIslandHeart(start);
    expect(click.state.nature).toEqual(valueFromNumber(1));
    expect(click.state.lifetimeNature).toEqual(valueFromNumber(1));
  });

  it('computes bulk prices as the exact geometric upgrade cost', () => {
    const base = createEconomyState(1);
    const state = {
      ...base,
      nature: habitatBulkCost(base, 'water', 10),
    };
    const one = habitatUnitCost(state, 'water');
    const ten = habitatBulkCost(state, 'water', 10);
    expect(compareValues(ten, one)).toBe(1);
    const bought = buyHabitat(state, 'water', 10);
    expect(bought.error).toBeUndefined();
    expect(bought.state.habitats.water).toBe(10);
    expect(compareValues(bought.state.nature, valueFromNumber(0))).toBe(0);
    expect(buyHabitat(state, 'water', 'max').state.habitats.water).toBeGreaterThan(0);
  });

  it('supports habitat levels beyond the physical island tile count', () => {
    const state = { ...createEconomyState(1), nature: valueFromNumber(1e100) };
    const result = buyHabitat(state, 'water', 100);
    expect(result.error).toBeUndefined();
    expect(result.state.habitats.water).toBe(100);
    expect(Number.isFinite(productionPerSecond(result.state).mantissa)).toBe(true);
  });

  it('uses the approved six-habitat base values and exact milestone price formula', () => {
    const habitats = [
      ['water', 10, 0.3, 1.15],
      ['grass', 28, 1.2, 1.17],
      ['forest', 90, 4.8, 1.19],
      ['mountain', 300, 16, 1.21],
      ['crystal-cavern', 1_200, 64, 1.23],
      ['ancient-grove', 4_800, 256, 1.25],
    ] as const;
    for (const [habitat, baseCost, rate, growth] of habitats) {
      const level = { ...createEconomyState(1), habitats: { ...createEconomyState(1).habitats, [habitat]: 1 } };
      expect(valueToNumber(HABITAT_BASE_COST[habitat])).toBe(baseCost);
      expect(HABITAT_BASE_RATE[habitat]).toBe(rate);
      expect(HABITAT_COST_GROWTH[habitat]).toBe(growth);
      expect(valueToNumber(habitatProductionPerSecond(level, habitat))).toBe(rate);
      expect(HABITAT_UPGRADE_MILESTONES).toEqual([10, 25, 50, 100]);
      HABITAT_UPGRADE_MILESTONES.forEach((quantity, index) => {
        expect(valueToNumber(habitatProductionUpgradeCost(habitat, index))).toBe(
          baseCost * quantity * quantity,
        );
      });
    }
    expect(valueToNumber(habitatProductionUpgradeCost('water', 1))).toBe(6_250);
  });

  it('unlocks sequential habitat upgrades at quantity milestones and doubles only that habitat', () => {
    const start = {
      ...createEconomyState(1),
      nature: valueFromNumber(200_000),
      habitats: {
        ...createEconomyState(1).habitats,
        water: 100,
        grass: 100,
      },
    };
    const beforeWater = habitatProductionPerSecond(start, 'water');
    const beforeGrass = habitatProductionPerSecond(start, 'grass');
    expect(buyHabitatProductionUpgrade({ ...start, habitats: { ...start.habitats, water: 9 } }, 'water').error)
      .toMatch(/Own 10/);
    const first = buyHabitatProductionUpgrade(start, 'water');
    expect(first.error).toBeUndefined();
    expect(first.state.habitatProductionUpgrades?.water).toBe(1);
    expect(valueToNumber(habitatProductionPerSecond(first.state, 'water'))).toBeCloseTo(
      2 * valueToNumber(beforeWater),
    );
    expect(habitatProductionPerSecond(first.state, 'grass')).toEqual(beforeGrass);
    expect(valueToNumber(first.state.nature)).toBe(199_000);

    const second = buyHabitatProductionUpgrade(first.state, 'water');
    expect(second.error).toBeUndefined();
    expect(valueToNumber(second.state.nature)).toBe(192_750);
    expect(valueToNumber(habitatProductionPerSecond(second.state, 'water'))).toBeCloseTo(
      4 * valueToNumber(beforeWater),
    );
    const exhausted = buyHabitatProductionUpgrade(
      { ...second.state, nature: valueFromNumber(0) },
      'grass',
    );
    expect(exhausted.error).toMatch(/Not enough Nature/);
    expect(buyHabitatProductionUpgrade(second.state, 'water').error).toBeUndefined();
    const fourth = buyHabitatProductionUpgrade(
      buyHabitatProductionUpgrade(
        buyHabitatProductionUpgrade(second.state, 'water').state,
        'water',
      ).state,
      'water',
    );
    expect(fourth.state.habitatProductionUpgrades?.water).toBe(4);
    expect(valueToNumber(habitatProductionPerSecond(fourth.state, 'water'))).toBeCloseTo(
      16 * valueToNumber(beforeWater),
    );
    expect(buyHabitatProductionUpgrade(fourth.state, 'water').error).toMatch(/fully upgraded/);
  });

  it('applies every sequential production upgrade correctly for all six habitats', () => {
    for (const habitat of ['water', 'grass', 'forest', 'mountain', 'crystal-cavern', 'ancient-grove'] as const) {
      let state = {
        ...createEconomyState(1),
        nature: valueFromNumber(1e12),
        habitats: { ...createEconomyState(1).habitats, [habitat]: 100 },
      };
      const before = habitatProductionPerSecond(state, habitat);
      for (let index = 0; index < HABITAT_UPGRADE_MILESTONES.length; index += 1) {
        const purchase = buyHabitatProductionUpgrade(state, habitat);
        expect(purchase.error).toBeUndefined();
        state = purchase.state;
        expect(state.habitatProductionUpgrades?.[habitat]).toBe(index + 1);
      }
      expect(valueToNumber(habitatProductionPerSecond(state, habitat))).toBeCloseTo(
        valueToNumber(before) * 16,
      );
      expect(buyHabitatProductionUpgrade(state, habitat).error).toMatch(/fully upgraded/);
    }
  });

  it('validates habitat upgrade save data and preserves compatibility with pre-expansion saves', () => {
    const oldSave = createEconomyState(1);
    const legacySave = {
      ...oldSave,
      habitats: { water: 0, grass: 0, forest: 0 },
    };
    delete legacySave.habitatProductionUpgrades;
    expect(validateEconomyState(legacySave)).toBe(true);
    const migratedGameplay = buyHabitat(
      { ...legacySave, nature: valueFromNumber(300) },
      'mountain',
      1,
    );
    expect(migratedGameplay.error).toBeUndefined();
    expect(migratedGameplay.state.habitats.mountain).toBe(1);
    expect(validateEconomyState({
      ...oldSave,
      habitatProductionUpgrades: { water: 1, grass: 0, forest: 0 },
    })).toBe(false);
    expect(validateEconomyState({
      ...oldSave,
      habitats: { ...oldSave.habitats, water: 25 },
      habitatProductionUpgrades: { water: 1 },
    })).toBe(true);
  });

  it('generates Nature, applies adjacency and milestones, and expires temporary boosts', () => {
    let state = createEconomyState(1);
    state = { ...state, habitats: { water: 1, grass: 1, forest: 1 } };
    const base = productionPerSecond(state);
    expect(compareValues(base, valueFromNumber(6))).toBe(1);
    const boosted = buyTemporaryUpgrade({ ...state, nature: valueFromNumber(200) }, 'sunny-season');
    expect(boosted.error).toBeUndefined();
    expect(compareValues(productionPerSecond(boosted.state), base)).toBe(1);
    const after = tickEconomy(boosted.state, 61);
    expect(after.temporaryUpgrades['sunny-season']).toBe(0);
    expect(compareValues(after.lifetimeNature, valueFromNumber(0))).toBe(1);
  });

  it('expires temporary boosts at the exact time during online ticks', () => {
    const state = {
      ...createEconomyState(1),
      habitats: { ...createEconomyState(1).habitats, water: 1 },
      nature: valueFromNumber(200),
    };
    const bought = buyTemporaryUpgrade(state, 'sunny-season');
    const after = tickEconomy(bought.state, 61);

    expect(valueToNumber(after.nature)).toBeCloseTo(86.3, 8);
    expect(after.temporaryUpgrades['sunny-season']).toBe(0);
  });

  it('lets Nature Surge refresh its timer, charges again, and rejects unaffordable purchases', () => {
    const start = {
      ...createEconomyState(1),
      nature: valueFromNumber(1_500),
      habitats: { ...createEconomyState(1).habitats, water: 1 },
    };
    expect(buyTemporaryUpgrade({ ...start, nature: valueFromNumber(1_499) }, 'nature-surge').error)
      .toMatch(/Need 1500 Nature/);
    const first = buyTemporaryUpgrade(start, 'nature-surge');
    expect(first.error).toBeUndefined();
    expect(first.state.temporaryUpgrades['nature-surge']).toBe(30);
    expect(valueToNumber(productionPerSecond(first.state))).toBeCloseTo(1.2, 8);
    const afterTenSeconds = tickEconomy(first.state, 10);
    expect(afterTenSeconds.temporaryUpgrades['nature-surge']).toBe(20);
    const refreshed = buyTemporaryUpgrade(
      { ...afterTenSeconds, nature: valueFromNumber(1_500) },
      'nature-surge',
    );
    expect(refreshed.state.temporaryUpgrades['nature-surge']).toBe(30);
    expect(valueToNumber(refreshed.state.nature)).toBe(0);
  });

  it('caps run-only Fertile Soil at five additive 10% levels and resets it on Rebirth', () => {
    let state = {
      ...createEconomyState(1),
      nature: valueFromNumber(20_000),
      runNature: valueFromNumber(2_000),
      habitats: { ...createEconomyState(1).habitats, water: 1 },
    };
    expect(buyFertileSoil({ ...state, nature: valueFromNumber(999) }).error)
      .toMatch(/Not enough Nature/);
    const baseRate = valueToNumber(habitatProductionPerSecond(state, 'water'));
    for (let level = 0; level < 5; level += 1) {
      expect(valueToNumber(fertileSoilCost(state))).toBe((level + 1) * 1_000);
      const purchase = buyFertileSoil(state);
      expect(purchase.error).toBeUndefined();
      state = purchase.state;
      expect(state.fertileSoilLevel).toBe(level + 1);
    }
    expect(valueToNumber(habitatProductionPerSecond(state, 'water'))).toBeCloseTo(baseRate * 1.5);
    expect(buyFertileSoil(state).error).toMatch(/fully enriched/);
    const rebirth = performRebirth(state);
    expect(rebirth.state.fertileSoilLevel).toBe(0);
  });

  it('resets all temporary boost timers and the Time Bloom limit on Rebirth', () => {
    const base = createEconomyState(1);
    const state = {
      ...base,
      nature: valueFromNumber(2_000),
      runNature: valueFromNumber(2_000),
      temporaryUpgrades: { 'sunny-season': 12, 'deep-roots': 18, 'nature-surge': 6 },
      timeBloomUsed: true,
    };

    const rebirth = performRebirth(state);
    expect(rebirth.state.temporaryUpgrades).toEqual({
      'sunny-season': 0,
      'deep-roots': 0,
      'nature-surge': 0,
    });
    expect(rebirth.state.timeBloomUsed).toBe(false);
  });

  it('grants Time Bloom once per run, rejects insufficient Nature, persists, and resets on Rebirth', () => {
    const base = createEconomyState(1);
    const start = {
      ...base,
      nature: valueFromNumber(6),
      habitats: { ...base.habitats, water: 1 },
    };
    expect(buyTimeBloom({ ...base, nature: valueFromNumber(10) }).error).toMatch(/Build a habitat/);
    expect(valueToNumber(timeBloomCost(start))).toBeCloseTo(6);
    expect(buyTimeBloom({ ...start, nature: valueFromNumber(5.99) }).error).toMatch(/Not enough Nature/);
    const bloomed = buyTimeBloom(start);
    expect(bloomed.error).toBeUndefined();
    expect(valueToNumber(bloomed.state.nature)).toBeCloseTo(9);
    expect(valueToNumber(bloomed.state.runNature)).toBeCloseTo(9);
    expect(valueToNumber(bloomed.state.lifetimeNature)).toBeCloseTo(9);
    expect(bloomed.state.timeBloomUsed).toBe(true);
    expect(buyTimeBloom(bloomed.state).error).toMatch(/already been used/);
    const rebirth = performRebirth({
      ...bloomed.state,
      nature: valueFromNumber(2_000),
      runNature: valueFromNumber(2_000),
    });
    expect(rebirth.state.timeBloomUsed).toBe(false);
  });

  it('accepts older guest saves without the new shop purchase fields', () => {
    const older: unknown = JSON.parse(JSON.stringify({
      ...createEconomyState(1),
      temporaryUpgrades: { 'sunny-season': 0, 'deep-roots': 0 },
      fertileSoilLevel: undefined,
      timeBloomUsed: undefined,
    }));
    expect(validateEconomyState(older)).toBe(true);
  });

  it('awards PP and CP only on rebirth, resets the run, and applies PP upgrades next run', () => {
    let state = createEconomyState(1);
    state = {
      ...state,
      runNature: valueFromNumber(5_000),
      nature: valueFromNumber(5_000),
      seasonalPP: 2,
    };
    expect(canRebirth(state)).toBe(true);
    const reward = rebirthReward(state);
    const result = performRebirth(state);
    expect(result.state.seasonalPP).toBe(state.seasonalPP + reward.pp);
    expect(result.state.seasonalCP).toBe(reward.cp);
    expect(result.state.lifetimeCP).toBe(reward.cp);
    expect(result.state.habitats).toEqual({
      water: 0, grass: 0, forest: 0, mountain: 0, 'crystal-cavern': 0, 'ancient-grove': 0,
    });
    const upgradedRun = buyHabitatProductionUpgrade(
      {
        ...result.state,
        nature: valueFromNumber(1_000),
        habitats: { ...result.state.habitats, water: 10 },
      },
      'water',
    ).state;
    const rebirthedAgain = performRebirth({ ...upgradedRun, runNature: valueFromNumber(3_000) }).state;
    expect(rebirthedAgain.habitatProductionUpgrades).toEqual({
      water: 0, grass: 0, forest: 0, mountain: 0, 'crystal-cavern': 0, 'ancient-grove': 0,
    });
    const upgraded = buyPPUpgrade(result.state, 'growth');
    expect(upgraded.state.personalUpgrades.growth).toBe(1);
    expect(
      compareValues(
        productionPerSecond({ ...upgraded.state, habitats: { water: 1, grass: 1, forest: 1 } }),
        productionPerSecond({ ...result.state, habitats: { water: 1, grass: 1, forest: 1 } }),
      ),
    ).toBe(1);
    expect(performRebirth(result.state).error).toMatch(/Nature goal/);
  });

  it('preserves early Rebirth reward rounding and caps the Nature-derived PP base at 10', () => {
    const start = createEconomyState(1);
    expect(rebirthReward({ ...start, runNature: valueFromNumber(2_000) }).pp).toBe(1);
    expect(rebirthReward({ ...start, runNature: valueFromNumber(8_000) }).pp).toBe(2);
    expect(rebirthReward({ ...start, runNature: valueFromNumber(242_000) }).pp).toBe(10);
    expect(rebirthReward({ ...start, runNature: valueFromNumber(2_000_000) }).pp).toBe(10);
  });

  it('applies Rebirth PP upgrade bonuses after the Nature-derived reward cap', () => {
    const start = createEconomyState(1);
    const atCap = {
      ...start,
      runNature: valueFromNumber(242_000),
      personalUpgrades: { ...start.personalUpgrades, rebirth: 4 },
    };
    expect(rebirthReward(atCap).pp).toBe(20);
    expect(
      rebirthReward({
        ...atCap,
        personalUpgrades: { ...atCap.personalUpgrades, rebirth: 100 },
      }).pp,
    ).toBe(260);
  });

  it('raises the effective Rebirth goal above Awakening starting Nature only when needed', () => {
    const start = createEconomyState(1);
    const atAwakening = (awakening: number, seasonRebirths = 0) => ({
      ...start,
      seasonRebirths,
      personalUpgrades: { ...start.personalUpgrades, awakening },
    });
    const level16 = atAwakening(16);
    const level17 = atAwakening(17);
    const level100 = atAwakening(100);

    expect(valueToNumber(rebirthRequirement(level16))).toBeCloseTo(83.57023700045);
    expect(valueToNumber(rebirthRequirement(level17))).toBe(285);
    expect(valueToNumber(rebirthRequirement(level100))).toBe(700);
    expect(valueToNumber(rebirthRequirement(atAwakening(100, REBIRTH_MULTIPLIERS.length - 1)))).toBe(740);
    expect(canRebirth({ ...level17, runNature: valueFromNumber(85) })).toBe(false);
    expect(canRebirth({ ...level17, runNature: valueFromNumber(285) })).toBe(true);
    expect(canRebirth({ ...level100, runNature: valueFromNumber(500) })).toBe(false);
    expect(canRebirth({ ...level100, runNature: valueFromNumber(700) })).toBe(true);
  });

  it('keeps existing guest saves valid and applies the effective goal without migration', () => {
    const persistedGuestSave = {
      ...createEconomyState(1),
      nature: valueFromNumber(85),
      runNature: valueFromNumber(85),
      personalUpgrades: { growth: 0, efficiency: 0, awakening: 17, rebirth: 0 },
    };
    expect(validateEconomyState(persistedGuestSave)).toBe(true);
    expect(persistedGuestSave.schemaVersion).toBe(1);
    expect(canRebirth(persistedGuestSave)).toBe(false);
    expect(performRebirth(persistedGuestSave).error).toMatch(/Nature goal/);
    expect(
      performRebirth({ ...persistedGuestSave, nature: valueFromNumber(285), runNature: valueFromNumber(285) })
        .error,
    ).toBeUndefined();
  });

  it('rejects invalid or non-finite saved economy numbers', () => {
    const valid = createEconomyState(1);
    expect(validateEconomyState({ ...valid, runNature: { mantissa: Number.POSITIVE_INFINITY, exponent: 0 } })).toBe(false);
    expect(validateEconomyState({ ...valid, nature: { mantissa: Number.NaN, exponent: 0 } })).toBe(false);
    expect(validateEconomyState({
      ...valid,
      personalUpgrades: { ...valid.personalUpgrades, awakening: Number.NaN },
    })).toBe(false);
    expect(validateEconomyState({
      ...valid,
      personalUpgrades: { ...valid.personalUpgrades, rebirth: Number.POSITIVE_INFINITY },
    })).toBe(false);
  });

  it('keeps late-game PP rewards finite and preserves the existing Nature ratio ceiling', () => {
    const start = createEconomyState(1);
    const lateGame = { ...start, runNature: valueFromNumber(1e300) };
    expect(rebirthReward(lateGame)).toEqual({ pp: 10, cp: 12 });
    expect(rebirthReward({
      ...lateGame,
      personalUpgrades: { ...start.personalUpgrades, rebirth: 100 },
    })).toEqual({ pp: 260, cp: 12 });
  });

  it('resets seasonal PP, upgrades, and CP while preserving lifetime records', () => {
    const played = {
      ...createEconomyState(10),
      seasonalPP: 4,
      seasonalCP: 7,
      lifetimeCP: 9,
      seasonRebirths: 3,
      lifetimeRebirths: 8,
      personalUpgrades: { growth: 2, efficiency: 1, awakening: 0, rebirth: 0 },
      achievements: ['first-rebirth'],
    };
    const fresh = resetForNewSeason(played, 11);
    expect(fresh.seasonalPP).toBe(0);
    expect(fresh.personalUpgrades.growth).toBe(0);
    expect(fresh.lifetimeCP).toBe(9);
    expect(fresh.lifetimeRebirths).toBe(8);
    expect(fresh.seasonRecords.at(-1)).toEqual(
      expect.objectContaining({ seasonId: 10, rebirths: 3, communityPoints: 7 }),
    );
    expect(fresh.achievements).toEqual(['first-rebirth']);
  });

  it('uses Monday 00:00 UTC season boundaries', () => {
    const before = Date.UTC(2026, 9, 26, 0, 0) - 1;
    const monday = Date.UTC(2026, 9, 26, 0, 0);
    expect(seasonIdAt(before)).toBe(seasonIdAt(monday) - 1);
    expect(seasonIdAt(Date.UTC(2026, 9, 29, 12, 0))).toBe(seasonIdAt(monday));
    expect(seasonIdAt(Date.UTC(2026, 10, 2, 0, 0))).toBe(seasonIdAt(monday) + 1);
    expect(new Date(monday).getUTCDay()).toBe(1);
    expect(formatValue(valueFromNumber(2500))).toBe('2.5K');
  });

  it('archives a season once and never rolls back to an older season id', () => {
    const played = {
      ...createEconomyState(10),
      seasonRebirths: 2,
      seasonalCP: 4,
      lifetimeCP: 7,
    };
    const next = resetForNewSeason(played, 12);
    expect(next.seasonRecords).toEqual([
      expect.objectContaining({
        seasonId: 10,
        rebirths: 2,
        communityPoints: 4,
        personalPointsAtEnd: 0,
        habitatsAtEnd: {
          water: 0, grass: 0, forest: 0, mountain: 0, 'crystal-cavern': 0, 'ancient-grove': 0,
        },
      }),
    ]);
    expect(resetForNewSeason(played, 12)).toEqual(next);
    expect(resetForNewSeason(next, 11)).toBe(next);
  });

  it('caps local offline production at eight hours using the saved production state', () => {
    const monday = Date.UTC(2026, 9, 26);
    const seasonId = seasonIdAt(monday);
    const state = { ...createEconomyState(seasonId), habitats: { water: 1, grass: 0, forest: 0 } };
    const result = applyOfflineProgress(state, monday + 1_000, monday + 11 * 60 * 60 * 1000);
    expect(result.secondsApplied).toBe(8 * 60 * 60);
    expect(valueToNumber(result.state.nature)).toBeCloseTo(0.3 * 8 * 60 * 60, 8);
    expect(result.state.lifetimeNature).toEqual(result.state.nature);
  });

  it('does not apply offline gains over a season boundary or negative elapsed time', () => {
    const monday = Date.UTC(2026, 9, 26);
    const state = {
      ...createEconomyState(seasonIdAt(monday)),
      habitats: { water: 1, grass: 0, forest: 0 },
    };
    expect(applyOfflineProgress(state, monday - 1_000, monday + 1_000).secondsApplied).toBe(0);
    expect(applyOfflineProgress(state, monday + 1_000, monday).secondsApplied).toBe(0);
  });

  it('expires temporary multipliers during offline accrual instead of extending them', () => {
    const monday = Date.UTC(2026, 9, 26);
    const state = {
      ...createEconomyState(seasonIdAt(monday)),
      habitats: { water: 1, grass: 0, forest: 0 },
      temporaryUpgrades: { 'sunny-season': 10, 'deep-roots': 0, 'nature-surge': 0 },
    };
    const result = applyOfflineProgress(state, monday + 1_000, monday + 31_000);
    expect(valueToNumber(result.state.nature)).toBeCloseTo(12, 8);
    expect(result.state.temporaryUpgrades['sunny-season']).toBe(0);
  });

  it('expires Nature Surge during offline accrual at its exact 30-second boundary', () => {
    const monday = Date.UTC(2026, 9, 26);
    const state = {
      ...createEconomyState(seasonIdAt(monday)),
      habitats: { water: 1, grass: 0, forest: 0 },
      temporaryUpgrades: { 'sunny-season': 0, 'deep-roots': 0, 'nature-surge': 10 },
    };
    const result = applyOfflineProgress(state, monday + 1_000, monday + 31_000);
    expect(valueToNumber(result.state.nature)).toBeCloseTo(18, 8);
    expect(result.state.temporaryUpgrades['nature-surge']).toBe(0);
  });
});
