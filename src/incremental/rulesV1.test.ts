import { describe, expect, it } from 'vitest';
import {
  applyCanonicalCommand,
  advanceCanonicalRun,
  createCanonicalRun,
  habitatPurchaseCost,
  MAX_NATURE_ATOMS,
  MAX_SCORE_TIER,
  NATURE_SCALE,
  productionPerSecondAtoms,
  scoreTierFromEarnedNature,
  seasonIdAtMilliseconds,
  type CanonicalRunState,
} from './rulesV1';

const MONDAY_EPOCH_MS = 4 * 24 * 60 * 60 * 1_000;

function freshRun(overrides: Partial<CanonicalRunState> = {}): CanonicalRunState {
  return {
    ...createCanonicalRun({
      runId: 'run-1',
      seasonId: 0,
      startedAtMs: MONDAY_EPOCH_MS,
      seasonalPP: 0n,
      existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
      seasonRebirths: 0,
      upgradeChoices: [],
    }),
    ...overrides,
  };
}

describe('canonical rules v1', () => {
  it('normalizes zero and every sub-Nature fractional score to tier zero', () => {
    expect(scoreTierFromEarnedNature(0n)).toBe(0);
    expect(scoreTierFromEarnedNature(1n)).toBe(0);
    expect(scoreTierFromEarnedNature(NATURE_SCALE - 1n)).toBe(0);
    expect(scoreTierFromEarnedNature(NATURE_SCALE)).toBe(0);
  });

  it('uses exact integer bucket thresholds and saturates at uint16 max', () => {
    expect(scoreTierFromEarnedNature(1_249_999_999_999n)).toBe(0);
    expect(scoreTierFromEarnedNature(1_250_000_000_000n)).toBe(1);
    expect(scoreTierFromEarnedNature(1_500_000_000_000n)).toBe(2);
    expect(scoreTierFromEarnedNature(2_000_000_000_000n)).toBe(3);
    expect(scoreTierFromEarnedNature(MAX_NATURE_ATOMS)).toBe(MAX_SCORE_TIER);
  });

  it('is monotonic over generated integer values, including exponent boundaries', () => {
    const values = [
      0n,
      1n,
      NATURE_SCALE - 1n,
      NATURE_SCALE,
      1_249_999_999_999n,
      1_250_000_000_000n,
      9_999_999_999_999n,
      10_000_000_000_000n,
      10n ** 30n,
      10n ** 100n,
      10n ** 1000n,
      10n ** 9000n,
      MAX_NATURE_ATOMS,
    ];
    for (let value = 1n; value <= 2_000n; value += 1n) values.push(value * value * 987_654_321n);
    values.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    let previous = 0;
    for (const value of values) {
      const score = scoreTierFromEarnedNature(value);
      expect(score).toBeGreaterThanOrEqual(previous);
      expect(Number.isSafeInteger(score)).toBe(true);
      expect(score).toBeLessThanOrEqual(MAX_SCORE_TIER);
      previous = score;
    }
  });

  it('does not lower earned Nature when a purchase spends the whole stock', () => {
    let state = freshRun();
    for (let index = 1; index <= 10; index += 1)
      state = applyCanonicalCommand(state, { type: 'heart-click' }, MONDAY_EPOCH_MS + index).state;
    const earnedBefore = state.earnedNatureAtoms;
    const scoreBefore = scoreTierFromEarnedNature(earnedBefore);
    state = applyCanonicalCommand(
      state,
      { type: 'buy-habitat', habitat: 'water', quantity: 1 },
      MONDAY_EPOCH_MS + 11,
    ).state;
    expect(state.natureAtoms).toBe(0n);
    expect(state.earnedNatureAtoms).toBe(earnedBefore);
    expect(scoreTierFromEarnedNature(state.earnedNatureAtoms)).toBe(scoreBefore);
  });

  it('credits bounded Heart batches exactly and rejects quantities above the batch limit', () => {
    const result = applyCanonicalCommand(
      freshRun(),
      { type: 'heart-click', quantity: 100 },
      MONDAY_EPOCH_MS,
    );
    expect(result.creditedAtoms).toBe(100n * NATURE_SCALE);
    expect(result.state.natureAtoms).toBe(100n * NATURE_SCALE);
    expect(result.state.earnedNatureAtoms).toBe(100n * NATURE_SCALE);
    expect(() => applyCanonicalCommand(
      freshRun(),
      { type: 'heart-click', quantity: 101 },
      MONDAY_EPOCH_MS,
    )).toThrow(/Heart batch/);
  });

  it('keeps PP upgrade settlement atomic and excludes its starting grant from earned Nature', () => {
    const state = createCanonicalRun({
      runId: 'run-2',
      seasonId: 0,
      startedAtMs: MONDAY_EPOCH_MS,
      seasonalPP: 10n,
      existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
      seasonRebirths: 0,
      upgradeChoices: [{ upgradeId: 'awakening', quantity: 1 }],
    });
    expect(state.seasonalPP).toBe(9n);
    expect(state.natureAtoms).toBe(5n * NATURE_SCALE);
    expect(state.earnedNatureAtoms).toBe(0n);
    expect(() =>
      createCanonicalRun({
        runId: 'run-bad',
        seasonId: 0,
        startedAtMs: MONDAY_EPOCH_MS,
        seasonalPP: 0n,
        existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
        seasonRebirths: 0,
        upgradeChoices: [{ upgradeId: 'awakening', quantity: 1 }],
      }),
    ).toThrow('Not enough seasonal PP');
  });

  it('calculates geometric multi-purchase costs as the sum of individually rounded costs', () => {
    const state = freshRun();
    expect(habitatPurchaseCost(state, 'water', 2)).toBe(21_500_000_000_000n);
  });

  it('applies server elapsed production in integer atoms and carries sub-atom remainder', () => {
    const withWater = freshRun({ habitats: { water: 1, grass: 0, forest: 0 } });
    expect(productionPerSecondAtoms(withWater)).toBe(300_000_000_000n);
    const first = applyCanonicalCommand(withWater, { type: 'sync' }, MONDAY_EPOCH_MS + 1).state;
    expect(first.natureAtoms).toBe(300_000_000n);
    expect(first.earnedNatureAtoms).toBe(300_000_000n);
    expect(first.productionRemainderMilliAtoms).toBe(0n);
  });

  it('caps a passive interval at eight hours and cannot accrue again from the same elapsed gap', () => {
    const state = freshRun({ habitats: { water: 1, grass: 0, forest: 0 } });
    const nineHours = MONDAY_EPOCH_MS + 9 * 60 * 60 * 1_000;
    const capped = advanceCanonicalRun(state, nineHours);
    expect(capped.activeMilliseconds).toBe(8 * 60 * 60 * 1_000);
    expect(capped.earnedNatureAtoms).toBe(8_640n * NATURE_SCALE);
    expect(advanceCanonicalRun(capped, nineHours).earnedNatureAtoms).toBe(capped.earnedNatureAtoms);
  });

  it('refuses to accrue production at or across the season boundary', () => {
    const state = freshRun({ habitats: { water: 1, grass: 0, forest: 0 } });
    expect(() => advanceCanonicalRun(state, MONDAY_EPOCH_MS + 7 * 24 * 60 * 60 * 1_000)).toThrow(
      'Run season has ended',
    );
  });

  it('implements the guest Monday UTC season index exactly', () => {
    expect(seasonIdAtMilliseconds(MONDAY_EPOCH_MS)).toBe(0);
    expect(seasonIdAtMilliseconds(MONDAY_EPOCH_MS + 7 * 24 * 60 * 60 * 1_000)).toBe(1);
    expect(seasonIdAtMilliseconds(MONDAY_EPOCH_MS - 1)).toBe(-1);
  });
});
