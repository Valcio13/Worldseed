import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCanonicalRun,
  NATURE_SCALE,
  seasonEndAtMilliseconds,
  seasonIdAtMilliseconds,
  serializeCanonicalRun,
  type CanonicalRunState,
} from '../../incremental/rulesV1';
import * as rulesV2 from '../../incremental/rulesV2';
import * as rulesV3 from '../../incremental/rulesV3';
import { serializeCanonicalRun as serializeVersionedCanonicalRun } from '../../incremental/versionedRules';
import type { V3CommandQueueState } from '../types';
import { V3VerifiedGameplay } from './V3VerifiedGameplay';
import { parseV3CanonicalState } from '../canonicalState';
import { V3ApiError } from '../api';

const { useV3CommandsMock } = vi.hoisted(() => ({ useV3CommandsMock: vi.fn() }));
vi.mock('../hooks/useV3Commands', () => ({ useV3Commands: useV3CommandsMock }));

const runId = '7';
const token = 'verified-session';
const startedAtMs = Date.UTC(2026, 9, 26);
const wallet = '0x0000000000000000000000000000000000000001' as `0x${string}`;
const submitCommandMock = vi.fn();
const enqueueCommandMock = vi.fn(() => true);
const recoverStateMock = vi.fn();
const retryCommandMock = vi.fn();
const clearCompletedMock = vi.fn();
const enqueueHeartClickMock = vi.fn(() => true);
const discardQueuedHeartClicksMock = vi.fn();
const flushPendingCommandsMock = vi.fn(async () => undefined);
const snapshotChangeMock = vi.fn();
const heartActionReadyMock = vi.fn();
const actionHandlersReadyMock = vi.fn();

function canonicalState(): CanonicalRunState {
  const base = createCanonicalRun({
    runId,
    seasonId: seasonIdAtMilliseconds(startedAtMs),
    startedAtMs,
    seasonalPP: 0n,
    existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
    seasonRebirths: 0,
    upgradeChoices: [],
  });
  return { ...base, natureAtoms: 100n * NATURE_SCALE, earnedNatureAtoms: 100n * NATURE_SCALE };
}

function canonicalStateV2(): rulesV2.CanonicalRunState {
  const base = rulesV2.createCanonicalRun({
    runId,
    seasonId: seasonIdAtMilliseconds(startedAtMs),
    startedAtMs,
    seasonalPP: 0n,
    existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
    seasonRebirths: 0,
    upgradeChoices: [],
  });
  return {
    ...base,
    natureAtoms: 100_000n * rulesV2.NATURE_SCALE,
    earnedNatureAtoms: 100_000n * rulesV2.NATURE_SCALE,
    habitats: { ...base.habitats, water: 10 },
  };
}

function canonicalStateV3(): rulesV3.CanonicalRunState {
  const base = rulesV3.createCanonicalRun({
    runId,
    seasonId: rulesV3.seasonIdAtMilliseconds(startedAtMs),
    startedAtMs,
    seasonalPP: 0n,
    existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
    seasonRebirths: 0,
    upgradeChoices: [],
  });
  return {
    ...base,
    natureAtoms: 5_000n * rulesV3.NATURE_SCALE,
    earnedNatureAtoms: 5_000n * rulesV3.NATURE_SCALE,
    habitats: { ...base.habitats, water: 1 },
    fertileSoilLevel: 2,
    temporaryMs: { ...base.temporaryMs, 'nature-surge': 12_345 },
  };
}

function queueState(commands: V3CommandQueueState['commands'] = []): V3CommandQueueState {
  return {
    commands,
    cursor: { runId, currentSequence: 0, expectedSequence: 0, rulesVersion: 1 },
    sessionToken: token,
    isSubmitting: false,
    recoveringCursor: false,
    queuedHeartClicks: 0,
    heartQueueBlocked: false,
    pendingCount: 0,
    confirmedCount: 0,
    failedCount: commands.filter(command => command.status === 'failed').length,
  };
}

function renderVerified(
  commands: V3CommandQueueState['commands'] = [],
  override?: V3CommandQueueState,
) {
  useV3CommandsMock.mockReturnValue({
    state: override ?? queueState(commands),
    submitCommand: submitCommandMock,
    enqueueCommand: enqueueCommandMock,
    retryCommand: retryCommandMock,
    recoverState: recoverStateMock,
    clearCompleted: clearCompletedMock,
    enqueueHeartClick: enqueueHeartClickMock,
    discardQueuedHeartClicks: discardQueuedHeartClicksMock,
    flushPendingCommands: flushPendingCommandsMock,
  });
  return render(
    <V3VerifiedGameplay
      runId={runId}
      sessionToken={token}
      onSnapshotChange={snapshotChangeMock}
      onHeartActionReady={heartActionReadyMock}
      onActionHandlersReady={actionHandlersReadyMock}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  recoverStateMock.mockResolvedValue({
    cursor: { runId, sequence: 0, rulesVersion: 1 },
    canonicalState: serializeCanonicalRun(canonicalState()),
    scoreTier: 0,
    wallet,
  });
  submitCommandMock.mockResolvedValue('verified-command-id');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('verified Living Island adapter', () => {
  it('parses a V2 snapshot through the version-aware helper', () => {
    const state = canonicalStateV2();
    const parsed = parseV3CanonicalState(serializeVersionedCanonicalRun(state), { runId, sequence: 0 });
    expect(parsed.rulesVersion).toBe(2);
    expect(parsed.runId).toBe(runId);
  });

  it('publishes V3 upgrade fields and action handlers from canonical state', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(startedAtMs + 1_000);
    const state = canonicalStateV3();
    recoverStateMock.mockResolvedValueOnce({
      cursor: { runId, sequence: 0, rulesVersion: 3 },
      canonicalState: serializeVersionedCanonicalRun(state),
      scoreTier: 0,
      wallet,
    });
    renderVerified();
    await waitFor(() => expect(snapshotChangeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rulesVersion: 3,
        verifiedNatureBoosts: expect.objectContaining({
          natureSurgeCost: '1.5K',
          natureSurgeRemainingMs: 11_345,
          canBuyNatureSurge: true,
          fertileSoilLevel: 2,
          fertileSoilMaxLevel: 5,
          fertileSoilNextCost: '3K',
          canBuyFertileSoil: true,
          timeBloomUsed: false,
          timeBloomCost: expect.any(String),
          canBuyTimeBloom: true,
        }),
      }),
    ));
    const handlers = actionHandlersReadyMock.mock.calls.at(-1)?.[0];
    expect(handlers).toEqual(expect.objectContaining({
      buyNatureSurge: expect.any(Function),
      buyFertileSoil: expect.any(Function),
      buyTimeBloom: expect.any(Function),
      sendGameplayCommand: expect.any(Function),
    }));
  });

  it('loads verifier state and routes Heart clicks as verified commands', async () => {
    renderVerified();
    await waitFor(() =>
      expect(snapshotChangeMock).toHaveBeenLastCalledWith({
        nature: '100',
        estimatedNature: '100',
        earnedNature: '100',
        productionPerSecond: '0',
        visualHabitatLevelCount: 0,
        scoreTier: 0,
        rulesVersion: 1,
        pendingHeartClicks: 0,
        verifiedNatureBoosts: null,
        habitats: expect.arrayContaining([
          expect.objectContaining({ id: 'water', level: 0, nextCost: '10' }),
          expect.objectContaining({ id: 'grass', level: 0 }),
          expect.objectContaining({ id: 'forest', level: 0 }),
        ]),
      }),
    );
    expect(recoverStateMock).toHaveBeenCalledOnce();

    await waitFor(() => expect(heartActionReadyMock).toHaveBeenLastCalledWith(expect.any(Function)));
    const heartAction = heartActionReadyMock.mock.calls.at(-1)?.[0] as (() => void) | null;
    expect(heartAction).toBeTypeOf('function');
    heartAction?.();
    await waitFor(() => expect(enqueueHeartClickMock).toHaveBeenCalledOnce());
  });

  it('retries a newly started run while the verifier waits for chain confirmation', async () => {
    vi.useFakeTimers();
    recoverStateMock
      .mockRejectedValueOnce(new V3ApiError(
        'No run exists for this authenticated wallet.',
        'RUN_NOT_FOUND',
        404,
      ))
      .mockResolvedValueOnce({
        cursor: { runId, sequence: 0, rulesVersion: 1 },
        canonicalState: serializeCanonicalRun(canonicalState()),
        scoreTier: 0,
        wallet,
      });
    renderVerified();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recoverStateMock).toHaveBeenCalledOnce();
    expect(screen.queryByText('No run exists for this authenticated wallet.')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(recoverStateMock).toHaveBeenCalledTimes(2);
    expect(snapshotChangeMock).toHaveBeenCalled();
  });

  it('projects confirmed passive production for display without changing the confirmed Nature balance', async () => {
    const state = {
      ...canonicalState(),
      natureAtoms: 100n * NATURE_SCALE,
      habitats: { ...canonicalState().habitats, water: 1 },
      lastServerTimeMs: Date.now() - 2_000,
    };
    recoverStateMock.mockResolvedValueOnce({
      cursor: { runId, sequence: 0, rulesVersion: 1 },
      canonicalState: serializeCanonicalRun(state),
      scoreTier: 0,
      wallet,
    });
    renderVerified();

    await waitFor(() => expect(snapshotChangeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ nature: '100', estimatedNature: expect.any(String) }),
    ));
    const snapshot = snapshotChangeMock.mock.calls.at(-1)?.[0];
    expect(Number(snapshot.nature)).toBe(100);
    expect(Number(snapshot.estimatedNature)).toBeGreaterThan(100);
  });

  it('shows queued Heart clicks in estimated Nature before verifier confirmation', async () => {
    const queued = queueState();
    queued.queuedHeartClicks = 2;
    renderVerified([], queued);

    await waitFor(() => expect(snapshotChangeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ nature: '100', estimatedNature: '102', pendingHeartClicks: 2 }),
    ));
  });

  it('projects queued Heart clicks and habitat purchases in order for the island view', async () => {
    const queued = queueState([
      {
        commandId: 'heart-pending', payload: { type: 'heart-click', quantity: 2 },
        expectedSequence: 0, submittedAt: Date.now(), status: 'queued',
      },
      {
        commandId: 'water-pending', payload: { type: 'buy-habitat', habitat: 'water', quantity: 1 },
        expectedSequence: 1, submittedAt: Date.now(), status: 'queued',
      },
    ]);
    renderVerified([], queued);

    await waitFor(() => expect(snapshotChangeMock).toHaveBeenLastCalledWith(expect.objectContaining({
      nature: '100',
      estimatedNature: '92',
      productionPerSecond: expect.not.stringMatching(/^0$/),
      habitats: expect.arrayContaining([expect.objectContaining({ id: 'water', level: 1 })]),
    })));
  });

  it('stops the passive Nature estimate at the run season boundary', async () => {
    const base = canonicalState();
    const seasonEnd = seasonEndAtMilliseconds(base.seasonId);
    vi.spyOn(Date, 'now').mockReturnValue(seasonEnd + 5_000);
    const state = {
      ...base,
      natureAtoms: 100n * NATURE_SCALE,
      habitats: { ...base.habitats, water: 1 },
      lastServerTimeMs: seasonEnd - 2_000,
    };
    recoverStateMock.mockResolvedValueOnce({
      cursor: { runId, sequence: 0, rulesVersion: 1 },
      canonicalState: serializeCanonicalRun(state),
      scoreTier: 0,
      wallet,
    });
    renderVerified();

    await waitFor(() => expect(snapshotChangeMock).toHaveBeenCalled());
    const snapshot = snapshotChangeMock.mock.calls.at(-1)?.[0];
    expect(Number(snapshot.nature)).toBe(100);
    expect(Number(snapshot.estimatedNature)).toBeLessThanOrEqual(102.1);
  });

  it('updates the island snapshot from a confirmed habitat receipt without a second recovery request', async () => {
    const view = renderVerified();
    await waitFor(() => expect(snapshotChangeMock).toHaveBeenCalled());
    const boughtState = {
      ...canonicalState(),
      sequence: 1,
      natureAtoms: 90n * NATURE_SCALE,
      habitats: { ...canonicalState().habitats, water: 1 },
      lastServerTimeMs: Date.now(),
    };
    const command = {
      commandId: 'confirmed-water-buy',
      payload: { type: 'buy-habitat' as const, habitat: 'water' as const, quantity: 1 },
      expectedSequence: 0,
      submittedAt: Date.now(),
      status: 'confirmed' as const,
      receipt: {
        accepted: true,
        commandId: 'confirmed-water-buy',
        cursor: { runId, sequence: 1, rulesVersion: 1 },
        serverTimeMs: Date.now(),
        canonicalState: serializeCanonicalRun(boughtState),
        creditedAtoms: '0',
        spentAtoms: (10n * NATURE_SCALE).toString(),
        scoreTier: 0,
      },
    };
    const confirmedQueue = queueState([command]);
    confirmedQueue.cursor.currentSequence = 1;
    confirmedQueue.cursor.expectedSequence = 1;
    useV3CommandsMock.mockReturnValue({
      state: confirmedQueue,
      submitCommand: submitCommandMock,
      retryCommand: retryCommandMock,
      recoverState: recoverStateMock,
      clearCompleted: clearCompletedMock,
      enqueueHeartClick: enqueueHeartClickMock,
      discardQueuedHeartClicks: discardQueuedHeartClicksMock,
      flushPendingCommands: flushPendingCommandsMock,
    });
    view.rerender(
      <V3VerifiedGameplay
        runId={runId}
        sessionToken={token}
        onSnapshotChange={snapshotChangeMock}
        onHeartActionReady={heartActionReadyMock}
        onActionHandlersReady={actionHandlersReadyMock}
      />,
    );

    await waitFor(() => expect(snapshotChangeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nature: '90',
        habitats: expect.arrayContaining([expect.objectContaining({ id: 'water', level: 1 })]),
      }),
    ));
    expect(recoverStateMock).toHaveBeenCalledOnce();
  });

  it('publishes V1 habitat state and routes purchases through verified commands', async () => {
    const serverState = { ...canonicalState(), habitats: { water: 2, grass: 1, forest: 0 } };
    recoverStateMock.mockResolvedValueOnce({
      cursor: { runId, sequence: 0, rulesVersion: 1 },
      canonicalState: serializeCanonicalRun(serverState),
      scoreTier: 0,
      wallet,
    });
    renderVerified();
    await waitFor(() => expect(actionHandlersReadyMock).toHaveBeenLastCalledWith(expect.objectContaining({
      pending: false,
      buyHabitat: expect.any(Function),
      buyProductionUpgrade: expect.any(Function),
    })));
    const handlers = actionHandlersReadyMock.mock.calls.at(-1)?.[0];
    expect(snapshotChangeMock).toHaveBeenLastCalledWith(expect.objectContaining({
      habitats: expect.arrayContaining([expect.objectContaining({ id: 'water', level: 2 })]),
    }));
    handlers.buyHabitat('water', 1);
    await waitFor(() => expect(enqueueCommandMock).toHaveBeenCalledWith({
      type: 'buy-habitat', habitat: 'water', quantity: 1,
    }));
  });

  it('keeps V1 run state on its original three habitats with no V2 upgrades', async () => {
    renderVerified();
    await waitFor(() => expect(snapshotChangeMock).toHaveBeenLastCalledWith(expect.objectContaining({
      rulesVersion: 1,
      habitats: expect.arrayContaining([
        expect.objectContaining({ id: 'water', productionUpgrades: [] }),
        expect.objectContaining({ id: 'grass', productionUpgrades: [] }),
        expect.objectContaining({ id: 'forest', productionUpgrades: [] }),
      ]),
    })));
    const snapshot = snapshotChangeMock.mock.calls.at(-1)?.[0];
    expect(snapshot.habitats).toHaveLength(3);
    expect(snapshot.habitats.map((habitat: { id: string }) => habitat.id)).not.toContain('mountain');
  });

  it('publishes all six V2 habitats and milestone availability by level and affordability', async () => {
    const base = canonicalStateV2();
    const state = {
      ...base,
      habitats: { ...base.habitats, water: 25 },
      habitatProductionUpgrades: {
        ...base.habitatProductionUpgrades,
        water: [10] as rulesV2.HabitatUpgradeMilestone[],
      },
    };
    recoverStateMock.mockResolvedValueOnce({
      cursor: { runId, sequence: 0, rulesVersion: 2 },
      canonicalState: serializeVersionedCanonicalRun(state),
      scoreTier: 0,
      wallet,
    });
    renderVerified();

    await waitFor(() => expect(snapshotChangeMock).toHaveBeenLastCalledWith(expect.objectContaining({
      rulesVersion: 2,
      habitats: expect.arrayContaining([
        expect.objectContaining({ id: 'mountain' }),
        expect.objectContaining({ id: 'crystal-cavern' }),
        expect.objectContaining({ id: 'ancient-grove' }),
        expect.objectContaining({
          id: 'water', level: 25, purchasedUpgradeCount: 1,
          productionUpgrades: expect.arrayContaining([
            expect.objectContaining({ milestone: 10, purchased: true }),
            expect.objectContaining({ milestone: 25, available: true }),
          ]),
        }),
      ]),
    })));
    expect(snapshotChangeMock.mock.calls.at(-1)?.[0].habitats).toHaveLength(6);
  });

  it('publishes a V2 milestone action that submits the canonical command', async () => {
    const state = canonicalStateV2();
    recoverStateMock.mockResolvedValueOnce({
      cursor: { runId, sequence: 0, rulesVersion: 2 },
      canonicalState: serializeVersionedCanonicalRun(state),
      scoreTier: 0,
      wallet,
    });
    renderVerified();

    await waitFor(() => expect(actionHandlersReadyMock).toHaveBeenLastCalledWith(expect.objectContaining({
      buyProductionUpgrade: expect.any(Function),
    })));
    actionHandlersReadyMock.mock.calls.at(-1)?.[0].buyProductionUpgrade('water');
    await waitFor(() => expect(enqueueCommandMock).toHaveBeenCalledWith({
      type: 'buy-habitat-production-upgrade',
      habitat: 'water',
      milestone: 10,
    }));
  });

  it('retains verifier-accepted state after a rejected purchase', async () => {
    const failed = {
      commandId: 'rejected-1',
      payload: { type: 'buy-habitat', habitat: 'water', quantity: 1 } as const,
      expectedSequence: 0,
      submittedAt: Date.now(),
      status: 'failed' as const,
      error: 'Not enough Nature.',
    };
    renderVerified([failed]);
    await waitFor(() =>
      expect(snapshotChangeMock).toHaveBeenLastCalledWith(expect.objectContaining({ nature: '100' })),
    );
    expect(screen.getByText('Not enough Nature.')).toBeTruthy();
    expect(snapshotChangeMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      nature: '100',
      habitats: expect.arrayContaining([expect.objectContaining({ id: 'water', level: 0 })]),
    }));
  });

  it('explains a rejected Heart batch and lets the player discard it to continue', async () => {
    const rejected = {
      commandId: 'rejected-heart',
      payload: { type: 'heart-click', quantity: 4 } as const,
      expectedSequence: 0,
      submittedAt: Date.now(),
      status: 'failed' as const,
      error: 'Season expired.',
    };
    const blockedQueue = queueState([rejected]);
    blockedQueue.queuedHeartClicks = 4;
    blockedQueue.heartQueueBlocked = true;
    renderVerified([rejected], blockedQueue);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Season expired.'));
    const discard = screen.getByRole('button', { name: 'Discard rejected actions and continue' });
    fireEvent.click(discard);
    expect(discardQueuedHeartClicksMock).toHaveBeenCalledOnce();
  });
});
