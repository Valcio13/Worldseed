import { describe, expect, it } from 'vitest';
import { createCanonicalRun as createV1Run, HABITATS as HABITATS_V1 } from '../incremental/rulesV1';
import {
  applyCanonicalCommand as applyV2Command,
  createCanonicalRun as createV2Run,
  HABITATS as HABITATS_V2,
  NATURE_SCALE,
  serializeCanonicalRun as serializeV2Run,
} from '../incremental/rulesV2';
import {
  createCanonicalRun as createV3Run,
  serializeCanonicalRun as serializeV3Run,
} from '../incremental/rulesV3';
import { serializeCanonicalRun as serializeV1Run } from '../incremental/rulesV1';
import {
  createHabitatProductionUpgradeCommand,
  createHabitatPurchaseCommand,
  habitatLevelForVerifiedState,
  habitatsForVerifiedState,
  isV3VerifiedState,
  nextHabitatProductionMilestone,
  parseV3CanonicalState,
  purchasedHabitatProductionMilestones,
} from './canonicalState';

const MONDAY_EPOCH_MS = 4 * 24 * 60 * 60 * 1_000;
const upgrades = { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 } as const;
const runInput = {
  runId: 'frontend-compat-run',
  seasonId: 0,
  startedAtMs: MONDAY_EPOCH_MS,
  seasonalPP: 0n,
  existingUpgrades: upgrades,
  seasonRebirths: 0,
  upgradeChoices: [],
};

describe('V3 version-aware canonical frontend state', () => {
  it('keeps a serialized V1 run on its original three-habitat state and rejects V2-only commands', () => {
    const state = parseV3CanonicalState(serializeV1Run(createV1Run(runInput)), {
      runId: runInput.runId,
      sequence: 0,
    });

    expect(state.rulesVersion).toBe(1);
    expect(habitatsForVerifiedState(state)).toEqual(HABITATS_V1);
    expect(habitatLevelForVerifiedState(state, 'forest')).toBe(0);
    expect(habitatLevelForVerifiedState(state, 'mountain')).toBeNull();
    expect(state.habitats).toEqual({ water: 0, grass: 0, forest: 0 });
    expect(purchasedHabitatProductionMilestones(state, 'water')).toEqual([]);
    expect(createHabitatPurchaseCommand(state, 'mountain', 1)).toBeNull();
    expect(createHabitatProductionUpgradeCommand(state, 'water')).toBeNull();
  });

  it('exposes all V2 habitats and only creates eligible, affordable sequential upgrade commands', () => {
    const empty = createV2Run({ ...runInput, runId: 'v2-frontend-run' });
    expect(habitatsForVerifiedState(empty)).toEqual(HABITATS_V2);
    expect(createHabitatProductionUpgradeCommand(empty, 'water')).toBeNull();

    const withTenWater = {
      ...empty,
      natureAtoms: 20_000n * NATURE_SCALE,
      habitats: { ...empty.habitats, water: 10 },
    };
    expect(habitatLevelForVerifiedState(withTenWater, 'water')).toBe(10);
    expect(createHabitatPurchaseCommand(withTenWater, 'ancient-grove', 1)).toEqual({
      type: 'buy-habitat',
      habitat: 'ancient-grove',
      quantity: 1,
    });
    expect(createHabitatProductionUpgradeCommand(withTenWater, 'water')).toEqual({
      type: 'buy-habitat-production-upgrade',
      habitat: 'water',
      milestone: 10,
    });

    const boughtTen = applyV2Command(
      withTenWater,
      { type: 'buy-habitat-production-upgrade', habitat: 'water', milestone: 10 },
      MONDAY_EPOCH_MS,
    ).state;
    const recovered = parseV3CanonicalState(serializeV2Run(boughtTen), {
      runId: boughtTen.runId,
      sequence: 1,
    });
    expect(recovered.rulesVersion).toBe(2);
    expect(purchasedHabitatProductionMilestones(recovered, 'water')).toEqual([10]);
    expect(nextHabitatProductionMilestone(recovered, 'water')).toBeNull();
    expect(createHabitatProductionUpgradeCommand(recovered, 'water')).toBeNull();
  });

  it('parses Rules V3 fields while preserving V1/V2-only upgrade availability', () => {
    const state = parseV3CanonicalState(
      serializeV3Run(
        createV3Run({
          ...runInput,
          runId: 'v3-frontend-run',
        }),
      ),
    );
    expect(state.rulesVersion).toBe(3);
    expect(habitatsForVerifiedState(state)).toEqual(HABITATS_V2);
    expect(isV3VerifiedState(state)).toBe(true);
    if (!isV3VerifiedState(state)) throw new Error('Expected rules V3 state.');
    expect(state.temporaryMs['nature-surge']).toBe(0);
    expect(state.fertileSoilLevel).toBe(0);
    expect(state.timeBloomUsed).toBe(false);
    expect(createHabitatProductionUpgradeCommand(state, 'water')).toBeNull();
  });

  it('does not build purchase commands for a settled run', () => {
    const state = createV2Run({ ...runInput, runId: 'settled-run' });
    const settled = {
      ...state,
      status: 'reborn' as const,
      habitats: { ...state.habitats, water: 10 },
    };
    expect(createHabitatPurchaseCommand(settled, 'water', 1)).toBeNull();
    expect(createHabitatProductionUpgradeCommand(settled, 'water')).toBeNull();
  });

  it('rejects snapshots whose run or command sequence does not match the request', () => {
    const state = serializeV1Run(createV1Run(runInput));
    expect(() => parseV3CanonicalState(state, { runId: 'another-run' })).toThrow(/different run/);
    expect(() => parseV3CanonicalState(state, { sequence: 1 })).toThrow(
      /different command sequence/,
    );
  });
});
