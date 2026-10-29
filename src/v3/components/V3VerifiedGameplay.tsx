import { useCallback, useEffect, useRef, useState } from 'react';
import * as rulesV1 from '../../incremental/rulesV1';
import * as rulesV2 from '../../incremental/rulesV2';
import * as rulesV3 from '../../incremental/rulesV3';
import { applyCanonicalCommand } from '../../incremental/versionedRules';
import { productionPerSecondAtoms as productionPerSecondV1 } from '../../incremental/rulesV1';
import { productionPerSecondAtoms as productionPerSecondV2 } from '../../incremental/rulesV2';
import { productionPerSecondAtoms as productionPerSecondV3 } from '../../incremental/rulesV3';
import { formatValue, type BigValue } from '../../incremental/decimal';
import { V3ApiError } from '../api';
import { useV3Commands } from '../hooks/useV3Commands';
import {
  createHabitatProductionUpgradeCommand,
  createHabitatPurchaseCommand,
  habitatLevelForVerifiedState,
  habitatPurchaseCostForVerifiedState,
  habitatsForVerifiedState,
  isV1VerifiedState,
  isV3VerifiedState,
  nextHabitatProductionMilestone,
  parseV3CanonicalState,
  purchasedHabitatProductionMilestones,
  type V3VerifiedCanonicalState,
} from '../canonicalState';
import type { V3Command, V3GameplayCommand, V3HabitatKind } from '../types';
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
  /** Last server-confirmed spendable balance. */
  nature: string;
  /** Visual estimate from confirmed production and elapsed client time; never authoritative. */
  estimatedNature: string;
  earnedNature: string;
  productionPerSecond: string;
  /** Habitat sum capped to the existing 15-level visual-stage ceiling. */
  visualHabitatLevelCount: number;
  scoreTier: number;
  rulesVersion: number;
  /** Heart clicks queued or submitted locally but not yet accepted by the verifier. */
  pendingHeartClicks?: number;
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
  verifiedNatureBoosts: {
    natureSurgeCost: string;
    natureSurgeRemainingMs: number;
    canBuyNatureSurge: boolean;
    fertileSoilLevel: number;
    fertileSoilMaxLevel: number;
    fertileSoilNextCost: string | null;
    canBuyFertileSoil: boolean;
    timeBloomUsed: boolean;
    timeBloomCost: string | null;
    canBuyTimeBloom: boolean;
    timeBloomUnavailableReason?: string | null;
  } | null;
}

const RUN_CONFIRMATION_RECOVERY_WINDOW_MS = 60_000;

export interface V3IslandActionHandlers {
  pending: boolean;
  heartClickPending: boolean;
  pendingHeartClicks: number;
  buyHabitat: (habitat: V3HabitatKind, quantity: number) => void;
  buyProductionUpgrade: (habitat: V3HabitatKind) => void;
  buyNatureSurge: () => void;
  buyFertileSoil: () => void;
  buyTimeBloom: () => void;
  sendGameplayCommand: (command: V3GameplayCommand) => void;
  flushPendingCommands: () => Promise<void>;
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

function projectQueuedGameplay(
  confirmed: VerifiedSnapshot,
  commands: V3Command[],
  bufferedHeartClicks: number,
): VerifiedSnapshot {
  let projected = confirmed;
  const pending = commands.filter(command =>
    command.status === 'queued' || command.status === 'pending' || command.status === 'uncertain',
  );
  for (const command of pending) {
    try {
      const result = applyCanonicalCommand(projected.state, command.payload, Date.now());
      projected = {
        state: result.state,
        scoreTier: rulesV1.scoreTierFromEarnedNature(result.state.earnedNatureAtoms),
      };
    } catch {
      // Stop at the first locally unaffordable/invalid action. The verifier remains authoritative.
      break;
    }
  }
  let remainingClicks = bufferedHeartClicks;
  while (remainingClicks > 0) {
    const quantity = Math.min(remainingClicks, 100);
    try {
      const result = applyCanonicalCommand(projected.state, {
        type: 'heart-click',
        quantity,
      }, Date.now());
      projected = {
        state: result.state,
        scoreTier: rulesV1.scoreTierFromEarnedNature(result.state.earnedNatureAtoms),
      };
    } catch {
      // Heart click cap and all validation still come from canonical rules.
      break;
    }
    remainingClicks -= quantity;
  }
  return projected;
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
  if (isV1VerifiedState(state)) return productionPerSecondV1(state);
  return isV3VerifiedState(state)
    ? productionPerSecondV3(state)
    : productionPerSecondV2(state);
}

function projectNatureForDisplay(
  state: V3VerifiedCanonicalState,
  nowMs = Date.now(),
): V3VerifiedCanonicalState {
  const seasonEnd = rulesV1.seasonEndAtMilliseconds(state.seasonId);
  const displayTimeMs = Math.min(nowMs, seasonEnd - 1);
  const elapsedMs = Math.max(0, displayTimeMs - state.lastServerTimeMs);
  if (elapsedMs === 0) return state;
  if (isV3VerifiedState(state)) {
    try {
      return rulesV3.advanceCanonicalRun(state, displayTimeMs);
    } catch {
      return state;
    }
  }
  const estimatedAtoms =
    state.natureAtoms + (productionPerSecond(state) * BigInt(elapsedMs)) / 1_000n;
  return { ...state, natureAtoms: estimatedAtoms };
}

function toIslandSnapshot(
  next: VerifiedSnapshot,
  nowMs = Date.now(),
  pendingHeartClicks = 0,
  confirmedState?: V3VerifiedCanonicalState,
): V3IslandSnapshot {
  const displayState = projectNatureForDisplay(next.state, nowMs);
  const estimatedNatureAtoms = displayState.natureAtoms;
  const habitats = habitatsForVerifiedState(displayState).map((id) => {
    const level = habitatLevelForVerifiedState(displayState, id) ?? 0;
    const nextCost = habitatPurchaseCostForVerifiedState(displayState, id, 1);
    const upgrades = purchasedHabitatProductionMilestones(displayState, id);
    const nextMilestone = nextHabitatProductionMilestone(displayState, id);
    return {
      id,
      level,
      nextCost: nextCost === null ? null : formatNatureAtoms(nextCost),
      canBuyOne: nextCost !== null && nextCost <= estimatedNatureAtoms,
      maxAffordable: maxAffordableQuantity({ ...displayState, natureAtoms: estimatedNatureAtoms }, id),
      purchasedUpgradeCount: upgrades.length,
      productionUpgrades: isV1VerifiedState(displayState)
        ? []
        : rulesV2.HABITAT_UPGRADE_MILESTONES.map((milestone) => {
            const cost = rulesV2.habitatProductionUpgradeCost(id as rulesV2.Habitat, milestone);
            return {
              milestone,
              cost: formatNatureAtoms(cost),
              purchased: upgrades.includes(milestone),
              available:
                nextMilestone === milestone && level >= milestone && cost <= estimatedNatureAtoms,
            };
          }),
    };
  });
  const v3State = isV3VerifiedState(displayState) ? displayState : null;
  const natureSurgeCostAtoms = rulesV3.temporaryUpgradeCostAtoms('nature-surge');
  const fertileSoilNextCostAtoms = v3State ? rulesV3.fertileSoilCostAtoms(v3State) : null;
  const timeBloomCostAtoms = v3State ? rulesV3.timeBloomCostAtoms(v3State) : null;
  return {
    nature: formatNatureAtoms(confirmedState?.natureAtoms ?? next.state.natureAtoms),
    estimatedNature: formatNatureAtoms(estimatedNatureAtoms),
    earnedNature: formatNatureAtoms(next.state.earnedNatureAtoms),
    productionPerSecond: formatNatureAtoms(productionPerSecond(displayState)),
    visualHabitatLevelCount: Object.values(next.state.habitats).reduce(
      (total, level) => (total >= 15 - level ? 15 : total + level),
      0,
    ),
    scoreTier: next.scoreTier,
    rulesVersion: next.state.rulesVersion,
    pendingHeartClicks,
    habitats,
    verifiedNatureBoosts: v3State ? {
      natureSurgeCost: formatNatureAtoms(natureSurgeCostAtoms),
      natureSurgeRemainingMs: v3State.temporaryMs['nature-surge'],
      canBuyNatureSurge:
        v3State.status === 'active' && estimatedNatureAtoms >= natureSurgeCostAtoms,
      fertileSoilLevel: v3State.fertileSoilLevel,
      fertileSoilMaxLevel: rulesV3.FERTILE_SOIL_MAX_LEVEL,
      fertileSoilNextCost:
        fertileSoilNextCostAtoms === null ? null : formatNatureAtoms(fertileSoilNextCostAtoms),
      canBuyFertileSoil:
        v3State.status === 'active' &&
        v3State.fertileSoilLevel < rulesV3.FERTILE_SOIL_MAX_LEVEL &&
        fertileSoilNextCostAtoms !== null && estimatedNatureAtoms >= fertileSoilNextCostAtoms,
      timeBloomUsed: v3State.timeBloomUsed,
      timeBloomCost: timeBloomCostAtoms === null ? null : formatNatureAtoms(timeBloomCostAtoms),
      canBuyTimeBloom:
        v3State.status === 'active' &&
        !v3State.timeBloomUsed &&
        productionPerSecond(v3State) > 0n &&
        timeBloomCostAtoms !== null && estimatedNatureAtoms >= timeBloomCostAtoms,
      timeBloomUnavailableReason:
        v3State.timeBloomUsed ? 'Already used this run.' :
        productionPerSecond(v3State) === 0n ? 'Build a habitat first.' : null,
    } : null,
  };
}

export function V3VerifiedGameplay({
  runId,
  sessionToken,
  onSnapshotChange,
  onHeartActionReady,
  onActionHandlersReady,
}: V3VerifiedGameplayProps & {
  onSnapshotChange?: (snapshot: V3IslandSnapshot | null) => void;
  onHeartActionReady?: (action: (() => boolean) | null) => void;
  onActionHandlersReady?: (handlers: V3IslandActionHandlers | null) => void;
}) {
  const queue = useV3Commands(runId, sessionToken);
  const enqueueHeartClick = queue.enqueueHeartClick;
  const discardQueuedHeartClicks = queue.discardQueuedHeartClicks;
  const enqueueCommand = queue.enqueueCommand;
  const recoverState = queue.recoverState;
  const [snapshot, setSnapshot] = useState<VerifiedSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [heartQueueError, setHeartQueueError] = useState<string | null>(null);
  const acceptedSequence = useRef(-1);

  const acceptSnapshot = useCallback((next: VerifiedSnapshot) => {
    if (next.state.sequence < acceptedSequence.current) return;
    acceptedSequence.current = next.state.sequence;
    setSnapshot(next);
    setSnapshotError(null);
    onSnapshotChange?.(toIslandSnapshot(next));
  }, [onSnapshotChange]);

  useEffect(() => {
    if (!snapshot || !onSnapshotChange) return;
    const projected = projectQueuedGameplay(snapshot, queue.state?.commands ?? [], queue.state?.queuedHeartClicks ?? 0);
    const pendingClicks = (queue.state?.queuedHeartClicks ?? 0) + (queue.state?.commands ?? []).reduce(
      (total, command) => total + (
        command.payload.type === 'heart-click' &&
        (command.status === 'queued' || command.status === 'pending' || command.status === 'uncertain')
          ? command.payload.quantity ?? 1
          : 0
      ),
      0,
    );
    const timer = window.setInterval(
      () => onSnapshotChange(toIslandSnapshot(projected, Date.now(), pendingClicks, snapshot.state)),
      1_000,
    );
    onSnapshotChange(toIslandSnapshot(projected, Date.now(), pendingClicks, snapshot.state));
    return () => window.clearInterval(timer);
  }, [onSnapshotChange, queue.state?.commands, queue.state?.queuedHeartClicks, snapshot]);

  useEffect(() => {
    let current = true;
    let retryTimer: number | undefined;
    const retryUntil = Date.now() + RUN_CONFIRMATION_RECOVERY_WINDOW_MS;
    const sync = async () => {
      try {
        const recovery = await recoverState();
        if (!current) return;
        if (recovery) {
          acceptSnapshot(readSnapshot(
            recovery.canonicalState,
            runId,
            recovery.scoreTier,
            recovery.cursor.sequence,
          ));
        } else {
          retryTimer = window.setTimeout(() => void sync(), 1_500);
        }
      } catch (error) {
        if (!current) return;
        const awaitingRunConfirmation =
          error instanceof V3ApiError && error.code === 'RUN_NOT_FOUND';
        if (awaitingRunConfirmation && Date.now() < retryUntil) {
          retryTimer = window.setTimeout(() => void sync(), 1_500);
          return;
        }
        const retryable = !(error instanceof V3ApiError) ||
          error.code === 'RECOVERY_FAILED' || error.status === 429 || error.status >= 500;
        if (retryable) {
          retryTimer = window.setTimeout(() => {
            setSnapshotError(null);
            void sync();
          }, 1_500);
        } else {
          setSnapshotError(awaitingRunConfirmation
            ? 'The verifier has not confirmed this run yet. Retry recovery in a moment.'
            : error instanceof Error ? error.message : 'Could not recover Live run.');
        }
      }
    };
    void sync();
    return () => {
      current = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
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

  const pendingHeartClicks = (queue.state?.queuedHeartClicks ?? 0) + (commands ?? []).reduce(
    (total, command) => total + (
      command.payload.type === 'heart-click' &&
        (command.status === 'queued' || command.status === 'pending' || command.status === 'uncertain')
        ? command.payload.quantity ?? 1
        : 0
    ),
    0,
  );
  // Ordinary actions remain interactive while the ordered journal drains in the background.
  const actionsDisabled = !snapshot || Boolean(queue.state?.recoveringCursor || queue.state?.heartQueueBlocked);
  const heartClickPending =
    (queue.state?.queuedHeartClicks ?? 0) > 0 ||
    (commands ?? []).some(command =>
      command.payload.type === 'heart-click' &&
      (command.status === 'pending' || command.status === 'uncertain')
    );
  const failedQueuedCommand = [...(commands ?? [])].reverse().find(command => command.status === 'failed');

  const send = useCallback((command: V3GameplayCommand) => {
    if (!enqueueCommand(command)) setHeartQueueError('Could not save this action locally. Please try again.');
    else setHeartQueueError(null);
  }, [enqueueCommand]);

  const submitHeartClick = useCallback((): boolean => {
    if (!enqueueHeartClick()) {
      setHeartQueueError('Heart clicks are queued locally while Live progress syncs. Resolve the queue before continuing.');
      return false;
    }
    setHeartQueueError(null);
    return true;
  }, [enqueueHeartClick]);

  const discardRejectedHeartClicks = useCallback(() => {
    discardQueuedHeartClicks();
    setHeartQueueError(null);
  }, [discardQueuedHeartClicks]);

  const canCollectHeart = Boolean(
    snapshot && !queue.state?.recoveringCursor && !queue.state?.heartQueueBlocked &&
      pendingHeartClicks < 1_000,
  );

  const buyHabitat = useCallback((habitat: V3HabitatKind, quantity: number) => {
    if (!snapshot) return;
    const base = projectQueuedGameplay(snapshot, queue.state?.commands ?? [], queue.state?.queuedHeartClicks ?? 0).state;
    const command = createHabitatPurchaseCommand(
      projectNatureForDisplay(base),
      habitat,
      quantity,
    );
    if (command) send(command);
  }, [queue.state?.commands, queue.state?.queuedHeartClicks, send, snapshot]);

  const buyProductionUpgrade = useCallback((habitat: V3HabitatKind) => {
    if (!snapshot) return;
    const base = projectQueuedGameplay(snapshot, queue.state?.commands ?? [], queue.state?.queuedHeartClicks ?? 0).state;
    const command = createHabitatProductionUpgradeCommand(
      projectNatureForDisplay(base),
      habitat,
    );
    if (command) send(command);
  }, [queue.state?.commands, queue.state?.queuedHeartClicks, send, snapshot]);

  const sendV3BoostCommand = useCallback((command: V3GameplayCommand) => {
    if (!snapshot || !isV3VerifiedState(snapshot.state) || snapshot.state.status !== 'active') return;
    const projected = projectQueuedGameplay(
      snapshot,
      queue.state?.commands ?? [],
      queue.state?.queuedHeartClicks ?? 0,
    ).state;
    try {
      applyCanonicalCommand(projected, command, Math.max(Date.now(), projected.lastServerTimeMs));
      send(command);
    } catch {
      // Use the same canonical rules for immediate affordances; verifier remains authoritative.
    }
  }, [queue.state?.commands, queue.state?.queuedHeartClicks, send, snapshot]);
  const buyNatureSurge = useCallback(() => sendV3BoostCommand({
    type: 'buy-temporary-upgrade', upgrade: 'nature-surge',
  }), [sendV3BoostCommand]);
  const buyFertileSoil = useCallback(() => sendV3BoostCommand({ type: 'buy-fertile-soil' }), [sendV3BoostCommand]);
  const buyTimeBloom = useCallback(() => sendV3BoostCommand({ type: 'buy-time-bloom' }), [sendV3BoostCommand]);

  useEffect(() => {
    onActionHandlersReady?.(snapshot ? {
      pending: actionsDisabled,
      heartClickPending,
      pendingHeartClicks,
      buyHabitat,
      buyProductionUpgrade,
      buyNatureSurge,
      buyFertileSoil,
      buyTimeBloom,
      sendGameplayCommand: sendV3BoostCommand,
      flushPendingCommands: queue.flushPendingCommands,
    } : null);
    return () => onActionHandlersReady?.(null);
  }, [actionsDisabled, buyHabitat, buyProductionUpgrade, buyNatureSurge, buyFertileSoil, buyTimeBloom, sendV3BoostCommand, heartClickPending, onActionHandlersReady, pendingHeartClicks, queue.flushPendingCommands, snapshot]);

  useEffect(() => {
    onHeartActionReady?.(canCollectHeart ? submitHeartClick : null);
    return () => onHeartActionReady?.(null);
  }, [canCollectHeart, onHeartActionReady, submitHeartClick]);

  useEffect(() => () => onSnapshotChange?.(null), [onSnapshotChange]);

  return (
    <section className="v3-verified-runtime" aria-label="Live run activity">
      {snapshotError && <p className="living-notice" role="alert">{snapshotError}</p>}
      {heartQueueError && <p className="living-notice" role="alert">{heartQueueError}</p>}
      {!snapshot && !snapshotError && <p className="living-notice" role="status">Syncing your run…</p>}
      {queue.state?.heartQueueBlocked && (
        <div className="living-notice" role="alert">
          <span>
            A Live action was rejected; dependent queued actions were not sent{failedQueuedCommand?.error ? `: ${failedQueuedCommand.error}` : '.'}
          </span>
          <button type="button" onClick={discardRejectedHeartClicks}>
            Discard rejected actions and continue
          </button>
        </div>
      )}
      {queue.state && (
          <V3CommandQueue
          queueState={queue.state}
          onRetry={commandId => { void queue.retryCommand(commandId).catch(() => undefined); }}
          onDiscardQueuedHeartClicks={discardRejectedHeartClicks}
          onRecover={() => {
            setSnapshotError(null);
            void queue.recoverState()
              .then(recovery => {
                if (recovery)
                  acceptSnapshot(readSnapshot(recovery.canonicalState, runId, recovery.scoreTier, recovery.cursor.sequence));
              })
              .catch(error => setSnapshotError(error instanceof Error ? error.message : 'Could not recover Live run.'));
          }}
          onClear={queue.clearCompleted}
          />
      )}
    </section>
  );
}
