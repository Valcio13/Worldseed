import { useCallback, useEffect, useRef, useState } from 'react';
import * as rulesV1 from '../../incremental/rulesV1';
import * as rulesV2 from '../../incremental/rulesV2';
import { productionPerSecondAtoms as productionPerSecondV1 } from '../../incremental/rulesV1';
import { productionPerSecondAtoms as productionPerSecondV2 } from '../../incremental/rulesV2';
import { formatValue, type BigValue } from '../../incremental/decimal';
import { useV3Commands } from '../hooks/useV3Commands';
import {
  createHabitatProductionUpgradeCommand,
  createHabitatPurchaseCommand,
  habitatLevelForVerifiedState,
  habitatPurchaseCostForVerifiedState,
  habitatsForVerifiedState,
  isV1VerifiedState,
  nextHabitatProductionMilestone,
  parseV3CanonicalState,
  purchasedHabitatProductionMilestones,
  type V3VerifiedCanonicalState,
} from '../canonicalState';
import type { V3GameplayCommand, V3HabitatKind } from '../types';
import { V3CommandQueue } from './V3CommandQueue';

interface V3VerifiedGameplayProps {
  runId: string;
  sessionToken: string;
}

interface VerifiedSnapshot {
  state: V3VerifiedCanonicalState;
  scoreTier: number;
}

export interface V3IslandSnapshot {
  nature: string;
  earnedNature: string;
  productionPerSecond: string;
  /** Habitat sum capped to the existing 15-level visual-stage ceiling. */
  visualHabitatLevelCount: number;
  scoreTier: number;
  rulesVersion: number;
  habitats: Array<{
    id: V3HabitatKind;
    level: number;
    nextCost: string | null;
    canBuyOne: boolean;
    maxAffordable: number;
    purchasedUpgradeCount: number;
    productionUpgrades: Array<{
      milestone: number;
      cost: string;
      purchased: boolean;
      available: boolean;
    }>;
  }>;
}

export interface V3IslandActionHandlers {
  pending: boolean;
  buyHabitat: (habitat: V3HabitatKind, quantity: number) => void;
  buyProductionUpgrade: (habitat: V3HabitatKind) => void;
}

function formatNatureAtoms(atoms: bigint): string {
  if (atoms === 0n) return '0';
  const digits = atoms.toString();
  const significantDigits = Math.min(4, digits.length);
  const leadingDigits = Number(digits.slice(0, significantDigits));
  const mantissa = leadingDigits / 10 ** (significantDigits - 1);
  const value: BigValue = { mantissa, exponent: digits.length - 13 };
  if (value.exponent < -2) return '<0.01';
  return formatValue(value);
}

function readSnapshot(
  serialized: string,
  runId: string,
  scoreTier: number,
  expectedSequence: number,
): VerifiedSnapshot {
  const state = parseV3CanonicalState(serialized, { runId, sequence: expectedSequence });
  return { state, scoreTier };
}

function maxAffordableQuantity(state: V3VerifiedCanonicalState, habitat: V3HabitatKind): number {
  const level = habitatLevelForVerifiedState(state, habitat);
  if (level === null) return 0;
  const levelCapacity = Number.MAX_SAFE_INTEGER - level;
  let low = 0;
  let high = Math.min(rulesV1.MAX_COMMAND_PURCHASE, levelCapacity);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const cost = habitatPurchaseCostForVerifiedState(state, habitat, middle);
    if (cost !== null && cost <= state.natureAtoms) low = middle;
    else high = middle - 1;
  }
  return low;
}

function productionPerSecond(state: V3VerifiedCanonicalState): bigint {
  return isV1VerifiedState(state)
    ? productionPerSecondV1(state)
    : productionPerSecondV2(state);
}

export function V3VerifiedGameplay({
  runId,
  sessionToken,
  onSnapshotChange,
  onHeartActionReady,
  onActionHandlersReady,
}: V3VerifiedGameplayProps & {
  onSnapshotChange?: (snapshot: V3IslandSnapshot | null) => void;
  onHeartActionReady?: (action: (() => void) | null) => void;
  onActionHandlersReady?: (handlers: V3IslandActionHandlers | null) => void;
}) {
  const queue = useV3Commands(runId, sessionToken);
  const recoverState = queue.recoverState;
  const submitCommand = queue.submitCommand;
  const [snapshot, setSnapshot] = useState<VerifiedSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const acceptedSequence = useRef(-1);

  const acceptSnapshot = useCallback((next: VerifiedSnapshot) => {
    if (next.state.sequence < acceptedSequence.current) return;
    acceptedSequence.current = next.state.sequence;
    setSnapshot(next);
    setSnapshotError(null);
    const habitats = habitatsForVerifiedState(next.state).map((id) => {
      const level = habitatLevelForVerifiedState(next.state, id) ?? 0;
      const nextCost = habitatPurchaseCostForVerifiedState(next.state, id, 1);
      const upgrades = purchasedHabitatProductionMilestones(next.state, id);
      const nextMilestone = nextHabitatProductionMilestone(next.state, id);
      return {
        id,
        level,
        nextCost: nextCost === null ? null : formatNatureAtoms(nextCost),
        canBuyOne: nextCost !== null && nextCost <= next.state.natureAtoms,
        maxAffordable: maxAffordableQuantity(next.state, id),
        purchasedUpgradeCount: upgrades.length,
        productionUpgrades: isV1VerifiedState(next.state)
          ? []
          : rulesV2.HABITAT_UPGRADE_MILESTONES.map((milestone) => {
              const cost = rulesV2.habitatProductionUpgradeCost(id as rulesV2.Habitat, milestone);
              return {
                milestone,
                cost: formatNatureAtoms(cost),
                purchased: upgrades.includes(milestone),
                available:
                  nextMilestone === milestone && level >= milestone && cost <= next.state.natureAtoms,
              };
            }),
      };
    });
    onSnapshotChange?.({
      nature: formatNatureAtoms(next.state.natureAtoms),
      earnedNature: formatNatureAtoms(next.state.earnedNatureAtoms),
      productionPerSecond: formatNatureAtoms(productionPerSecond(next.state)),
      visualHabitatLevelCount: Object.values(next.state.habitats).reduce(
        (total, level) => (total >= 15 - level ? 15 : total + level),
        0,
      ),
      scoreTier: next.scoreTier,
      rulesVersion: next.state.rulesVersion,
      habitats,
    });
  }, [onSnapshotChange]);

  useEffect(() => {
    let current = true;
    void recoverState()
      .then(recovery => {
        if (!current || !recovery) return;
        acceptSnapshot(readSnapshot(
          recovery.canonicalState,
          runId,
          recovery.scoreTier,
          recovery.cursor.sequence,
        ));
      })
      .catch(error => {
        if (current)
          setSnapshotError(error instanceof Error ? error.message : 'Could not recover verified run.');
      });
    return () => { current = false; };
  }, [acceptSnapshot, recoverState, runId]);

  const commands = queue.state?.commands;
  useEffect(() => {
    for (const command of commands ?? []) {
      if (command.status !== 'confirmed' || !command.receipt) continue;
      try {
        acceptSnapshot(readSnapshot(
          command.receipt.canonicalState,
          runId,
          command.receipt.scoreTier,
          command.receipt.cursor.sequence,
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid verifier receipt.';
        globalThis.queueMicrotask(() => setSnapshotError(message));
      }
    }
  }, [acceptSnapshot, commands, runId]);

  const hasUnresolvedCommand = (commands ?? []).some(command =>
    command.status === 'pending' || command.status === 'uncertain'
  );
  const actionsDisabled = !snapshot || queue.state?.recoveringCursor || queue.state?.isSubmitting || hasUnresolvedCommand;

  const send = useCallback(async (command: V3GameplayCommand) => {
    try {
      await submitCommand(command);
    } catch {
      // The queue retains the verifier error/status and renders its retry path.
    }
  }, [submitCommand]);

  const submitHeartClick = useCallback(() => {
    void send({ type: 'heart-click' });
  }, [send]);

  const buyHabitat = useCallback((habitat: V3HabitatKind, quantity: number) => {
    if (!snapshot) return;
    const command = createHabitatPurchaseCommand(snapshot.state, habitat, quantity);
    if (command) void send(command);
  }, [send, snapshot]);

  const buyProductionUpgrade = useCallback((habitat: V3HabitatKind) => {
    if (!snapshot) return;
    const command = createHabitatProductionUpgradeCommand(snapshot.state, habitat);
    if (command) void send(command);
  }, [send, snapshot]);

  useEffect(() => {
    onActionHandlersReady?.(snapshot ? {
      pending: actionsDisabled,
      buyHabitat,
      buyProductionUpgrade,
    } : null);
    return () => onActionHandlersReady?.(null);
  }, [actionsDisabled, buyHabitat, buyProductionUpgrade, onActionHandlersReady, snapshot]);

  useEffect(() => {
    onHeartActionReady?.(actionsDisabled ? null : submitHeartClick);
    return () => onHeartActionReady?.(null);
  }, [actionsDisabled, onHeartActionReady, submitHeartClick]);

  useEffect(() => () => onSnapshotChange?.(null), [onSnapshotChange]);

  return (
    <section className="v3-verified-runtime" aria-label="Verified run activity">
      {snapshotError && <p className="living-notice" role="alert">{snapshotError}</p>}
      {!snapshot && !snapshotError && <p className="living-notice" role="status">Syncing verified island…</p>}
      {queue.state && (
          <V3CommandQueue
          queueState={queue.state}
          onRetry={commandId => { void queue.retryCommand(commandId).catch(() => undefined); }}
          onRecover={() => {
            setSnapshotError(null);
            void queue.recoverState()
              .then(recovery => {
                if (recovery)
                  acceptSnapshot(readSnapshot(recovery.canonicalState, runId, recovery.scoreTier, recovery.cursor.sequence));
              })
              .catch(error => setSnapshotError(error instanceof Error ? error.message : 'Could not recover verified run.'));
          }}
          onClear={queue.clearCompleted}
          />
      )}
    </section>
  );
}
