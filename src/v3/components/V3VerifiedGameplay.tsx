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

const HABITAT_PRESENTATION: Record<V3HabitatKind, { name: string; symbol: string }> = {
  water: { name: 'Water', symbol: '≈' },
  grass: { name: 'Grass', symbol: '✿' },
  forest: { name: 'Forest', symbol: '♧' },
  mountain: { name: 'Mountain', symbol: '▲' },
  'crystal-cavern': { name: 'Crystal Cavern', symbol: '◇' },
  'ancient-grove': { name: 'Ancient Grove', symbol: '♧' },
};

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

export function V3VerifiedGameplay({ runId, sessionToken }: V3VerifiedGameplayProps) {
  const queue = useV3Commands(runId, sessionToken);
  const recoverState = queue.recoverState;
  const [snapshot, setSnapshot] = useState<VerifiedSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const acceptedSequence = useRef(-1);

  const acceptSnapshot = useCallback((next: VerifiedSnapshot) => {
    if (next.state.sequence < acceptedSequence.current) return;
    acceptedSequence.current = next.state.sequence;
    setSnapshot(next);
    setSnapshotError(null);
  }, []);

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

  async function send(command: V3GameplayCommand) {
    try {
      await queue.submitCommand(command);
    } catch {
      // The queue retains the verifier error/status and renders its retry path.
    }
  }

  return (
    <section className="v3-integration-auth" aria-label="Verified gameplay">
      <div className="v3-integration-section-heading">
        <h2>Verified island</h2>
        <strong>{snapshot ? `Run ${runId} · Tier ${snapshot.scoreTier}` : 'Recovering run'}</strong>
      </div>

      {snapshotError && <p className="v3-integration-error" role="alert">{snapshotError}</p>}
      {!snapshot && !snapshotError && <p role="status">Loading verifier-accepted run state…</p>}

      {snapshot && (
        <>
          <div className="v3-integration-section-heading" aria-label="Verified resources">
            <span>Nature</span>
            <strong data-testid="verified-nature">{formatNatureAtoms(snapshot.state.natureAtoms)}</strong>
          </div>
          <p>
            Production: <strong data-testid="verified-production">
              {formatNatureAtoms(productionPerSecond(snapshot.state))} / sec
            </strong>
          </p>
          <p>Earned this run: {formatNatureAtoms(snapshot.state.earnedNatureAtoms)} Nature</p>

          <button
            type="button"
            className="v3-integration-action"
            disabled={actionsDisabled}
            onClick={() => void send({ type: 'heart-click' })}
            aria-label="Verified Heart click"
          >
            Click Island Heart · +1 Nature
          </button>

          <div aria-label="Verified habitat purchases">
            {habitatsForVerifiedState(snapshot.state).map((id) => {
              const { name, symbol } = HABITAT_PRESENTATION[id];
              const level = habitatLevelForVerifiedState(snapshot.state, id);
              const hasLevelCapacity = level !== null && level < Number.MAX_SAFE_INTEGER;
              const cost = hasLevelCapacity ? habitatPurchaseCostForVerifiedState(snapshot.state, id, 1) : null;
              const maxQuantity = maxAffordableQuantity(snapshot.state, id);
              const purchasedMilestones = purchasedHabitatProductionMilestones(snapshot.state, id);
              const nextMilestone = nextHabitatProductionMilestone(snapshot.state, id);
              const hasV2Milestones = !isV1VerifiedState(snapshot.state);
              return (
                <section key={id} aria-label={`${name} habitat`}>
                  <h3>{symbol} {name}</h3>
                  <p>
                    Level <strong data-testid={`verified-habitat-${id}`}>{level}</strong>
                  </p>
                  <p>Next habitat: {cost === null ? 'level cap reached' : `${formatNatureAtoms(cost)} Nature`}</p>
                  <button
                    type="button"
                    className="v3-integration-action"
                    disabled={actionsDisabled || cost === null || snapshot.state.natureAtoms < cost}
                    onClick={() => {
                      const command = createHabitatPurchaseCommand(snapshot.state, id, 1);
                      if (command) void send(command);
                    }}
                    aria-label={`Buy 1 verified ${name}`}
                  >
                    Buy 1 {name}
                  </button>
                  <button
                    type="button"
                    className="v3-integration-action"
                    disabled={actionsDisabled || maxQuantity === 0}
                    onClick={() => {
                      const command = createHabitatPurchaseCommand(snapshot.state, id, maxQuantity);
                      if (command) void send(command);
                    }}
                    aria-label={`Buy maximum verified ${name}`}
                  >
                    Buy max ({maxQuantity})
                  </button>
                  {hasV2Milestones && (
                    <div aria-label={`${name} production upgrades`}>
                      <h4>Production upgrades</h4>
                      {rulesV2.HABITAT_UPGRADE_MILESTONES.map(milestone => {
                        const purchased = purchasedMilestones.includes(milestone);
                        const isNext = nextMilestone === milestone;
                        const milestoneCost = rulesV2.habitatProductionUpgradeCost(id as rulesV2.Habitat, milestone);
                        const affordable = snapshot.state.natureAtoms >= milestoneCost;
                        const available = isNext && affordable;
                        const status = purchased
                          ? 'Purchased'
                          : level !== null && level < milestone
                            ? `Locked · requires level ${milestone}`
                            : available
                              ? 'Available'
                            : isNext && !affordable
                              ? 'Unaffordable'
                              : 'Locked · previous upgrade required';
                        return (
                          <div key={milestone}>
                            <span>Ownership level {milestone}</span>
                            <span>{purchased ? status : `${formatNatureAtoms(milestoneCost)} Nature`}</span>
                            {!purchased && <span>{status}</span>}
                            {!purchased && (
                              <button
                                type="button"
                                className="v3-integration-action"
                                disabled={actionsDisabled || !available}
                                onClick={() => {
                                  const command = createHabitatProductionUpgradeCommand(snapshot.state, id);
                                  if (command) void send(command);
                                }}
                                aria-label={`Buy ${name} level ${milestone} production upgrade`}
                              >
                                Buy level {milestone} upgrade
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

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
