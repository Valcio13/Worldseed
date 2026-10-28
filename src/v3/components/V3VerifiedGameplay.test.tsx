import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import * as islandAudio from '../../game/sound';

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
  return render(<V3VerifiedGameplay runId={runId} sessionToken={token} />);
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
    const playSound = vi.spyOn(islandAudio, 'playIslandSound');
    renderVerified();
    expect(await screen.findByTestId('verified-nature')).toHaveTextContent('100');
    expect(screen.getByTestId('verified-production')).toHaveTextContent('0 / sec');
    expect(recoverStateMock).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Verified Heart click' }));
    await waitFor(() => expect(submitCommandMock).toHaveBeenCalledWith({ type: 'heart-click' }));
    await waitFor(() => expect(playSound).toHaveBeenCalledWith('collect'));
  });

  it('routes habitat purchases through the verifier and displays canonical habitat levels', async () => {
    const serverState = { ...canonicalState(), habitats: { water: 2, grass: 1, forest: 0 } };
    recoverStateMock.mockResolvedValueOnce({
      cursor: { runId, sequence: 0, rulesVersion: 1 },
      canonicalState: serializeCanonicalRun(serverState),
      scoreTier: 0,
      wallet,
    });
    renderVerified();
    expect(await screen.findByTestId('verified-habitat-water')).toHaveTextContent('2');

    fireEvent.click(screen.getByRole('button', { name: 'Buy 1 verified Water' }));
    await waitFor(() => expect(submitCommandMock).toHaveBeenCalledWith({
      type: 'buy-habitat', habitat: 'water', quantity: 1,
    }));
  });

  it('keeps V1 runs on their original three habitats', async () => {
    renderVerified();
    expect(await screen.findByRole('region', { name: 'Water habitat' })).toBeTruthy();
    expect(screen.getAllByLabelText(/habitat$/)).toHaveLength(3);
    expect(screen.queryByRole('region', { name: 'Mountain habitat' })).toBeNull();
    expect(screen.queryByText('Production upgrades')).toBeNull();
  });

  it('renders all six V2 habitats and shows milestone availability by level and affordability', async () => {
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

    expect(await screen.findByRole('region', { name: 'Mountain habitat' })).toBeTruthy();
    expect(screen.getAllByLabelText(/habitat$/)).toHaveLength(6);
    expect(screen.getAllByText('Locked · requires level 50')).toHaveLength(6);
    expect(screen.getByText('Purchased')).toBeTruthy();
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Buy Water level 25 production upgrade' })).toBeEnabled();
  });

  it('submits the canonical V2 milestone command from the available upgrade control', async () => {
    const playSound = vi.spyOn(islandAudio, 'playIslandSound');
    const state = canonicalStateV2();
    recoverStateMock.mockResolvedValueOnce({
      cursor: { runId, sequence: 0, rulesVersion: 2 },
      canonicalState: serializeVersionedCanonicalRun(state),
      scoreTier: 0,
      wallet,
    });
    renderVerified();

    fireEvent.click(await screen.findByRole('button', { name: 'Buy Water level 10 production upgrade' }));
    await waitFor(() => expect(submitCommandMock).toHaveBeenCalledWith({
      type: 'buy-habitat-production-upgrade',
      habitat: 'water',
      milestone: 10,
    }));
    await waitFor(() => expect(playSound).toHaveBeenCalledWith('upgrade'));
  });

  it('shows a rejected purchase without changing verifier-accepted Nature or habitat counts', async () => {
    const failed = {
      commandId: 'rejected-1',
      payload: { type: 'buy-habitat', habitat: 'water', quantity: 1 } as const,
      expectedSequence: 0,
      submittedAt: Date.now(),
      status: 'failed' as const,
      error: 'Not enough Nature.',
    };
    renderVerified([failed]);
    expect(await screen.findByTestId('verified-nature')).toHaveTextContent('100');
    expect(screen.getByTestId('verified-habitat-water')).toHaveTextContent('0');
    expect(screen.getByText('Not enough Nature.')).toBeTruthy();
  });
});
