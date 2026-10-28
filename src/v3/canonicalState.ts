/** Version-aware frontend helpers for authoritative verifier state. */
import * as rulesV1 from '../incremental/rulesV1';
import * as rulesV2 from '../incremental/rulesV2';
import * as rulesV3 from '../incremental/rulesV3';
import { deserializeCanonicalRun, type CanonicalRunState } from '../incremental/versionedRules';
import type { V3GameplayCommand, V3HabitatKind } from './types';

export type V3VerifiedCanonicalState = CanonicalRunState;
export type V1HabitatId = rulesV1.Habitat;
export type V2HabitatId = rulesV2.Habitat;
export type V3HabitatId = rulesV3.Habitat;

export function parseV3CanonicalState(
  serialized: string,
  expected?: { runId?: string; sequence?: number },
): V3VerifiedCanonicalState {
  const state = deserializeCanonicalRun(serialized);
  if (expected?.runId !== undefined && state.runId !== expected.runId)
    throw new Error('Verifier returned state for a different run.');
  if (expected?.sequence !== undefined && state.sequence !== expected.sequence)
    throw new Error('Verifier returned state for a different command sequence.');
  return state;
}

export function isV1VerifiedState(
  state: V3VerifiedCanonicalState,
): state is rulesV1.CanonicalRunState {
  return state.rulesVersion === rulesV1.RULES_VERSION;
}

export function isV2VerifiedState(
  state: V3VerifiedCanonicalState,
): state is rulesV2.CanonicalRunState {
  return state.rulesVersion === rulesV2.RULES_VERSION;
}

export function isV3VerifiedState(
  state: V3VerifiedCanonicalState,
): state is rulesV3.CanonicalRunState {
  return state.rulesVersion === rulesV3.RULES_VERSION;
}

/** Returns only habitats that exist in this run's pinned rules version. */
export function habitatsForVerifiedState(
  state: V3VerifiedCanonicalState,
): readonly V3HabitatKind[] {
  return isV1VerifiedState(state) ? rulesV1.HABITATS : rulesV2.HABITATS;
}

/** Newer habitat IDs are absent from V1 state rather than silently materialized at level zero. */
export function habitatLevelForVerifiedState(
  state: V3VerifiedCanonicalState,
  habitat: V3HabitatKind,
): number | null {
  if (isV1VerifiedState(state)) {
    return (rulesV1.HABITATS as readonly string[]).includes(habitat)
      ? state.habitats[habitat as rulesV1.Habitat]
      : null;
  }
  return state.habitats[habitat];
}

export function purchasedHabitatProductionMilestones(
  state: V3VerifiedCanonicalState,
  habitat: V3HabitatKind,
): readonly rulesV2.HabitatUpgradeMilestone[] {
  if (isV1VerifiedState(state)) return [];
  return state.habitatProductionUpgrades[habitat];
}

export function nextHabitatProductionMilestone(
  state: V3VerifiedCanonicalState,
  habitat: V3HabitatKind,
): rulesV2.HabitatUpgradeMilestone | null {
  if (isV1VerifiedState(state)) return null;
  const purchased = state.habitatProductionUpgrades[habitat];
  const next = rulesV2.HABITAT_UPGRADE_MILESTONES[purchased.length];
  return next !== undefined && state.habitats[habitat] >= next ? next : null;
}

export function habitatPurchaseCostForVerifiedState(
  state: V3VerifiedCanonicalState,
  habitat: V3HabitatKind,
  quantity: number,
): bigint | null {
  if (isV1VerifiedState(state)) {
    if (!(rulesV1.HABITATS as readonly string[]).includes(habitat)) return null;
    return rulesV1.habitatPurchaseCost(state, habitat as rulesV1.Habitat, quantity);
  }
  return isV3VerifiedState(state)
    ? rulesV3.habitatPurchaseCost(state, habitat, quantity)
    : rulesV2.habitatPurchaseCost(state, habitat, quantity);
}

/**
 * Builds a purchase command only when it is legal and affordable in the supplied snapshot.
 * The verifier remains authoritative; this is a stale-state-safe UI affordance, not validation.
 */
export function createHabitatPurchaseCommand(
  state: V3VerifiedCanonicalState,
  habitat: V3HabitatKind,
  quantity: number,
): V3GameplayCommand | null {
  if (state.status !== 'active') return null;
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > rulesV1.MAX_COMMAND_PURCHASE)
    return null;
  const cost = habitatPurchaseCostForVerifiedState(state, habitat, quantity);
  if (cost === null || cost > state.natureAtoms) return null;
  return { type: 'buy-habitat', habitat, quantity };
}

/**
 * Builds a V2-only milestone command when the next sequential milestone is owned and affordable.
 * V1 runs cannot produce this command, preserving their original three-habitat rules.
 */
export function createHabitatProductionUpgradeCommand(
  state: V3VerifiedCanonicalState,
  habitat: V3HabitatKind,
): Extract<V3GameplayCommand, { type: 'buy-habitat-production-upgrade' }> | null {
  if (isV1VerifiedState(state) || state.status !== 'active') return null;
  const milestone = nextHabitatProductionMilestone(state, habitat);
  if (milestone === null) return null;
  const cost = rulesV2.habitatProductionUpgradeCost(habitat, milestone);
  if (cost > state.natureAtoms) return null;
  return { type: 'buy-habitat-production-upgrade', habitat, milestone };
}
