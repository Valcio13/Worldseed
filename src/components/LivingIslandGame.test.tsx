import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { valueFromNumber } from '../incremental/decimal';
import { createEconomyState, type EconomyState } from '../incremental/engine';
import { seasonIdAt } from '../incremental/season';
import { LivingIslandGame } from './LivingIslandGame';
import * as islandAudio from '../game/sound';
import { updateAudioPreferences } from '../game/sound';

const mocks = vi.hoisted(() => ({
  loadGuestSave: vi.fn(),
  saveGuestSave: vi.fn(),
  restoreGuestProgress: vi.fn(),
  archiveIncompatibleSave: vi.fn(),
}));

vi.mock('../persistence/localSave', () => mocks);
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false, address: undefined }),
  useChainId: () => 0,
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [], isPending: false }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
}));
vi.mock('../blockchain/config', () => ({
  TARGET_CHAIN_ID: 743111,
  TARGET_CHAIN_NAME: 'Hemi Sepolia',
}));

beforeEach(() => {
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  updateAudioPreferences({ musicEnabled: false, muted: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  updateAudioPreferences({ musicEnabled: false, muted: false });
  vi.restoreAllMocks();
});

describe('Living Island guest persistence', () => {
  it('retries blocked startup music directly from the island Heart interaction', async () => {
    updateAudioPreferences({ musicEnabled: true, muted: false, musicVolume: 0.14 });
    mocks.loadGuestSave.mockResolvedValue({ kind: 'empty' });
    mocks.saveGuestSave.mockResolvedValue(undefined);
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(Object.assign(new Error('Autoplay blocked'), { name: 'NotAllowedError' }))
      .mockResolvedValue(undefined);
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    render(<LivingIslandGame />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledOnce();

    const heart = screen.getByRole('button', { name: /Click the Island Heart/ });
    fireEvent.pointerDown(heart);
    fireEvent.click(heart);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('automatically dismisses ordinary welcome-back notifications after five seconds', async () => {
    vi.useFakeTimers();
    const state = createEconomyState(seasonIdAt(Date.now()));
    mocks.loadGuestSave.mockResolvedValue({
      kind: 'current',
      save: { schemaVersion: 3, savedAt: Date.now(), economy: state, restoration: {} },
    });
    mocks.restoreGuestProgress.mockReturnValue({
      state,
      restoration: {},
      savedAt: Date.now(),
      seasonChanged: false,
      secondsApplied: 30,
    });
    mocks.saveGuestSave.mockResolvedValue(undefined);
    render(<LivingIslandGame />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('.living-notice')).toHaveTextContent('Welcome back.');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(document.querySelector('.living-notice')).toHaveTextContent('Welcome back.');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.queryByText('Welcome back. Your island grew while you were away.')).not.toBeInTheDocument();
  });

  it('loads the guest save path and saves Heart progress through the existing save API', async () => {
    const playSound = vi.spyOn(islandAudio, 'playIslandSound');
    vi.useFakeTimers();
    mocks.loadGuestSave.mockResolvedValue({ kind: 'empty' });
    mocks.saveGuestSave.mockResolvedValue(undefined);
    render(<LivingIslandGame />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: /Click the Island Heart/ }));
    expect(playSound).toHaveBeenCalledWith('collect');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(701);
      await Promise.resolve();
    });

    expect(mocks.saveGuestSave).toHaveBeenCalled();
    const savedEconomy = mocks.saveGuestSave.mock.calls.at(-1)?.[0];
    expect(savedEconomy.nature).toEqual(valueFromNumber(1));
    expect(screen.getByTestId('nature-counter').textContent).toBe('1');
  });

  it('saves a six-habitat production upgrade and restores it after a fresh mount', async () => {
    vi.useFakeTimers();
    const restoration = {};
    let persistedEconomy: EconomyState = {
      ...createEconomyState(seasonIdAt(Date.now())),
      nature: valueFromNumber(100_000),
      habitats: {
        water: 0,
        grass: 0,
        forest: 0,
        mountain: 10,
        'crystal-cavern': 0,
        'ancient-grove': 0,
      },
    };
    const loadSavedEconomy = () => ({
      kind: 'current' as const,
      save: {
        schemaVersion: 3 as const,
        savedAt: Date.now(),
        economy: persistedEconomy,
        restoration,
      },
    });
    mocks.loadGuestSave.mockImplementation(async () => loadSavedEconomy());
    mocks.restoreGuestProgress.mockImplementation((save, now) => ({
      state: save.economy,
      restoration: save.restoration,
      savedAt: now,
      seasonChanged: false,
      secondsApplied: 0,
    }));
    mocks.saveGuestSave.mockImplementation(async (economy) => {
      persistedEconomy = economy;
    });

    const firstMount = render(<LivingIslandGame />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(document.querySelector('.living-habitat--mountain summary')!);
    fireEvent.click(screen.getByRole('button', { name: /Mountain level 10 upgrade · Buy/ }));
    expect(
      screen.getByRole('button', { name: /Mountain level 10 upgrade · Purchased/ }),
    ).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(701);
      await Promise.resolve();
    });
    expect(persistedEconomy.habitatProductionUpgrades?.mountain).toBe(1);
    expect(persistedEconomy.habitats.mountain).toBe(10);

    firstMount.unmount();
    render(<LivingIslandGame />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('.living-habitat--mountain summary')).toHaveTextContent('1/4');
    fireEvent.click(document.querySelector('.living-habitat--mountain summary')!);
    expect(
      screen.getByRole('button', { name: /Mountain level 10 upgrade · Purchased/ }),
    ).toBeDisabled();
    expect(screen.getByText(/Level 10 ·/)).toBeVisible();
  });
});
