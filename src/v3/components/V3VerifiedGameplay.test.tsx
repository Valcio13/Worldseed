import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCanonicalRun,
  NATURE_SCALE,
  seasonIdAtMilliseconds,
  serializeCanonicalRun,
  type CanonicalRunState,
} from '../../incremental/rulesV1';
import * as rulesV2 from '../../incremental/rulesV2';
import { serializeCanonicalRun as serializeVersionedCanonicalRun } from '../../incremental/versionedRules';
import type { V3CommandQueueState } from '../types';
import { V3VerifiedGameplay } from './V3VerifiedGameplay';
import { parseV3CanonicalState } from '../canonicalState';

const { useV3CommandsMock } = vi.hoisted(() => ({ useV3CommandsMock: vi.fn() }));
vi.mock('../hooks/useV3Commands', () => ({ useV3Commands: useV3CommandsMock }));

const runId = '7';
const token = 'verified-session';
const startedAtMs = Date.UTC(2026, 9, 26);
const wallet = '0x0000000000000000000000000000000000000001' as `0x${string}`;
const submitCommandMock = vi.fn();
const recoverStateMock = vi.fn();
const retryCommandMock = vi.fn();
const clearCompletedMock = vi.fn();
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

function queueState(commands: V3CommandQueueState['commands'] = []): V3CommandQueueState {
  return {
    commands,
    cursor: { runId, currentSequence: 0, expectedSequence: 0, rulesVersion: 1 },
    sessionToken: token,
    isSubmitting: false,
    recoveringCursor: false,
    pendingCount: 0,
    confirmedCount: 0,
    failedCount: commands.filter(command => command.status === 'failed').length,
  };
}

function renderVerified(commands: V3CommandQueueState['commands'] = []) {
  useV3CommandsMock.mockReturnValue({
    state: queueState(commands),
    submitCommand: submitCommandMock,
    retryCommand: retryCommandMock,
    recoverState: recoverStateMock,
    clearCompleted: clearCompletedMock,
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
afterEach(() => cleanup());

describe('verified Living Island adapter', () => {
  it('parses a V2 snapshot through the version-aware helper', () => {
    const state = canonicalStateV2();
    const parsed = parseV3CanonicalState(serializeVersionedCanonicalRun(state), { runId, sequence: 0 });
    expect(parsed.rulesVersion).toBe(2);
    expect(parsed.runId).toBe(runId);
  });

  it('loads verifier state and routes Heart clicks as verified commands', async () => {
    renderVerified();
    await waitFor(() =>
      expect(snapshotChangeMock).toHaveBeenLastCalledWith({
        nature: '100',
        earnedNature: '100',
        productionPerSecond: '0',
        visualHabitatLevelCount: 0,
        scoreTier: 0,
        rulesVersion: 1,
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
    await waitFor(() => expect(submitCommandMock).toHaveBeenCalledWith({ type: 'heart-click' }));
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
    await waitFor(() => expect(submitCommandMock).toHaveBeenCalledWith({
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
    await waitFor(() => expect(submitCommandMock).toHaveBeenCalledWith({
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
});
