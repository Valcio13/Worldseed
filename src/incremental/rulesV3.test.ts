import { describe, expect, it } from 'vitest';
import {
  applyCanonicalCommand,
  createCanonicalRun as createV3Run,
  deserializeCanonicalRun,
  fertileSoilCostAtoms,
  FERTILE_SOIL_MAX_LEVEL,
  NATURE_SCALE,
  productionPerSecondAtoms,
  serializeCanonicalRun,
  timeBloomCostAtoms,
  type CanonicalRunState,
} from './rulesV3';
import {
  applyCanonicalCommand as applyVersionedCommand,
  createCanonicalRun,
  deserializeCanonicalRun as deserializeVersionedRun,
  serializeCanonicalRun as serializeVersionedRun,
} from './versionedRules';

const MONDAY_EPOCH_MS = 4 * 24 * 60 * 60 * 1_000;
const emptyUpgrades = { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 } as const;

function run(): CanonicalRunState {
  return createV3Run({
    runId: 'v3-run-1',
    seasonId: 0,
    startedAtMs: MONDAY_EPOCH_MS,
    seasonalPP: 0n,
    existingUpgrades: emptyUpgrades,
    seasonRebirths: 0,
    upgradeChoices: [],
  });
}

function withNature(nature: bigint, overrides: Partial<CanonicalRunState> = {}): CanonicalRunState {
  return { ...run(), natureAtoms: nature, ...overrides };
}

describe('canonical rules v3 Nature upgrades', () => {
  it('keeps V1 and V2 dispatch pinned to their original state and serialization', () => {
    const input = {
      runId: 'pinned',
      seasonId: 0,
      startedAtMs: MONDAY_EPOCH_MS,
      seasonalPP: 0n,
      existingUpgrades: emptyUpgrades,
      seasonRebirths: 0,
      upgradeChoices: [],
    };
    const v1 = createCanonicalRun(1, input);
    const v2 = createCanonicalRun(2, input);
    const v3 = createCanonicalRun(3, input);
    expect(v1.rulesVersion).toBe(1);
    expect(v2.rulesVersion).toBe(2);
    expect(v3.rulesVersion).toBe(3);
    expect('fertileSoilLevel' in v1).toBe(false);
    expect('fertileSoilLevel' in v2).toBe(false);
    expect(() => applyVersionedCommand(v1, { type: 'buy-fertile-soil' }, MONDAY_EPOCH_MS)).toThrow(
      /Unsupported command/,
    );
    expect(() => applyVersionedCommand(v2, { type: 'buy-time-bloom' }, MONDAY_EPOCH_MS)).toThrow(
      /Unsupported command/,
    );
    expect(deserializeVersionedRun(serializeVersionedRun(v3)).rulesVersion).toBe(3);
    expect(deserializeCanonicalRun(serializeCanonicalRun(run())).rulesVersion).toBe(3);
  });

  it('buys Nature Surge for 1,500 Nature, refreshes its 30-second timer, and expires at the exact boundary', () => {
    const state = withNature(5_000n * NATURE_SCALE, { habitats: { ...run().habitats, water: 1 } });
    const baseRate = productionPerSecondAtoms(state);
    const first = applyCanonicalCommand(
      state,
      { type: 'buy-temporary-upgrade', upgrade: 'nature-surge' },
      MONDAY_EPOCH_MS,
    );
    expect(first.spentAtoms).toBe(1_500n * NATURE_SCALE);
    expect(first.state.temporaryMs['nature-surge']).toBe(30_000);
    expect(productionPerSecondAtoms(first.state)).toBe(baseRate * 4n);

    const nearExpiry = applyCanonicalCommand(
      first.state,
      { type: 'sync' },
      MONDAY_EPOCH_MS + 29_999,
    ).state;
    expect(nearExpiry.temporaryMs['nature-surge']).toBe(1);
    const refresh = applyCanonicalCommand(
      nearExpiry,
      { type: 'buy-temporary-upgrade', upgrade: 'nature-surge' },
      MONDAY_EPOCH_MS + 29_999,
    );
    expect(refresh.state.temporaryMs['nature-surge']).toBe(30_000);
    const expired = applyCanonicalCommand(
      refresh.state,
      { type: 'sync' },
      MONDAY_EPOCH_MS + 59_999,
    ).state;
    expect(expired.temporaryMs['nature-surge']).toBe(0);
    expect(productionPerSecondAtoms(expired)).toBe(baseRate);
  });

  it('stacks V3 production multipliers multiplicatively with existing temporary boosts', () => {
    const state = withNature(10_000n * NATURE_SCALE, {
      habitats: { ...run().habitats, water: 1 },
      temporaryMs: { 'sunny-season': 10_000, 'deep-roots': 10_000, 'nature-surge': 0 },
    });
    const existingBoostRate = productionPerSecondAtoms(state);
    const surge = applyCanonicalCommand(
      state,
      { type: 'buy-temporary-upgrade', upgrade: 'nature-surge' },
      MONDAY_EPOCH_MS,
    ).state;
    expect(productionPerSecondAtoms(surge)).toBe(existingBoostRate * 4n);
  });

  it('rejects serialized temporary timers beyond their configured maximum', () => {
    const malformed = {
      ...run(),
      temporaryMs: { 'sunny-season': 0, 'deep-roots': 0, 'nature-surge': 30_001 },
    };
    expect(() => deserializeCanonicalRun(serializeCanonicalRun(malformed))).toThrow(
      /Temporary upgrade duration is invalid/,
    );
  });

  it('charges Fertile Soil 1,000 times the next level and applies a cumulative integer 10% factor, capped at five', () => {
    let state = withNature(15_000n * NATURE_SCALE, { habitats: { ...run().habitats, water: 1 } });
    const initialRate = productionPerSecondAtoms(state);
    const costs: bigint[] = [];
    for (let level = 1; level <= FERTILE_SOIL_MAX_LEVEL; level++) {
      expect(fertileSoilCostAtoms(state)).toBe(BigInt(level * 1_000) * NATURE_SCALE);
      const result = applyCanonicalCommand(state, { type: 'buy-fertile-soil' }, MONDAY_EPOCH_MS);
      costs.push(result.spentAtoms);
      expect(result.state.fertileSoilLevel).toBe(level);
      expect(productionPerSecondAtoms(result.state)).toBeGreaterThanOrEqual(
        productionPerSecondAtoms(state),
      );
      state = result.state;
    }
    expect(costs).toEqual([1, 2, 3, 4, 5].map((level) => BigInt(level * 1_000) * NATURE_SCALE));
    expect(productionPerSecondAtoms(state)).toBeGreaterThanOrEqual((initialRate * 15n) / 10n);
    expect(() =>
      applyCanonicalCommand(state, { type: 'buy-fertile-soil' }, MONDAY_EPOCH_MS),
    ).toThrow(/level cap/);
  });

  it('rejects unaffordable upgrades and does not change state or sequence', () => {
    const noNature = run();
    for (const command of [
      { type: 'buy-temporary-upgrade', upgrade: 'nature-surge' } as const,
      { type: 'buy-fertile-soil' } as const,
      { type: 'buy-time-bloom' } as const,
    ]) {
      expect(() => applyCanonicalCommand(noNature, command, MONDAY_EPOCH_MS)).toThrow(
        /Not enough Nature|Build a habitat/,
      );
    }
    expect(noNature.sequence).toBe(0);
    expect(noNature.natureAtoms).toBe(0n);
  });

  it('Time Bloom costs 20 seconds, credits 30 seconds, and increases earned Nature only by credited grant', () => {
    const state = withNature(100n * NATURE_SCALE, {
      earnedNatureAtoms: 80n * NATURE_SCALE,
      habitats: { ...run().habitats, water: 1 },
    });
    const rate = productionPerSecondAtoms(state);
    expect(timeBloomCostAtoms(state)).toBe(rate * 20n);
    const result = applyCanonicalCommand(state, { type: 'buy-time-bloom' }, MONDAY_EPOCH_MS);
    expect(result.spentAtoms).toBe(rate * 20n);
    expect(result.creditedAtoms).toBe(rate * 30n);
    expect(result.state.natureAtoms).toBe(state.natureAtoms + rate * 10n);
    expect(result.state.earnedNatureAtoms).toBe(state.earnedNatureAtoms + rate * 30n);
    expect(result.state.timeBloomUsed).toBe(true);
    expect(() =>
      applyCanonicalCommand(result.state, { type: 'buy-time-bloom' }, MONDAY_EPOCH_MS),
    ).toThrow(/already been used/);
  });

  it('allows Time Bloom when near the balance cap but counts only the grant actually credited', () => {
    const state = withNature(10n ** 9_375n, {
      earnedNatureAtoms: 10n ** 9_375n,
      habitats: { ...run().habitats, water: 1 },
    });
    const rate = productionPerSecondAtoms(state);
    const result = applyCanonicalCommand(state, { type: 'buy-time-bloom' }, MONDAY_EPOCH_MS);
    expect(result.spentAtoms).toBe(rate * 20n);
    expect(result.creditedAtoms).toBe(rate * 20n);
    expect(result.state.earnedNatureAtoms).toBe(state.earnedNatureAtoms);
    expect(result.state.natureAtoms).toBe(state.natureAtoms);
  });
});
