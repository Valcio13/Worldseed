import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { valueFromNumber } from '../incremental/decimal';
import { createEconomyState, type EconomyState } from '../incremental/engine';
import { seasonIdAt } from '../incremental/season';
import { LivingIslandGame, withLiveActionSounds } from './LivingIslandGame';
import { initialLivingIslandMode } from './livingIslandMode';
import * as islandAudio from '../game/sound';
import { updateAudioPreferences } from '../game/sound';

const mocks = vi.hoisted(() => ({
  loadGuestSave: vi.fn(),
  saveGuestSave: vi.fn(),
  restoreGuestProgress: vi.fn(),
  archiveIncompatibleSave: vi.fn(),
  walletConnected: false,
  walletAddress: undefined as string | undefined,
  chainId: 0,
  v3Enabled: false,
  clearAuthSession: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('../persistence/localSave', () => mocks);
vi.mock('../integration/featureFlags', () => ({
  isV3IdleIntegrationEnabled: () => mocks.v3Enabled,
}));
vi.mock('../v3/hooks/useV3Auth', () => ({ clearV3AuthSession: mocks.clearAuthSession }));
vi.mock('./V3IntegrationShell', async () => {
  const React = await import('react');
  return {
    V3IslandProgression: ({ onProfileChange }: { onProfileChange: (profile: unknown) => void }) => {
      React.useEffect(() => {
        onProfileChange({
          activeRun: false,
          runId: null,
          authenticated: false,
          ready: true,
          seasonalPP: '0',
          seasonalCP: '0',
          rewardRules: {
            rebirthThresholdTier: 35,
            ppStep: 10,
            ppPerRebirthCap: 100n,
            ppBase: 1n,
            seasonPPCap: 100_000n,
            seasonCPCap: 100_000n,
            cpMilestoneStep: 7,
          },
          totalSeasonCP: '0',
          maxSeasonPoints: '1000000',
          lifetimeCP: '0',
          lifetimeNature: '0',
          accumulatedScore: '0',
          seasonalAccumulatedScore: '0',
          seasonalHighScoreTier: 0,
          nextCpMilestoneTier: 42,
          rebirthThresholdTier: 35,
          seasonRebirths: 0,
          upgradeLevels: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
          wallet: null,
          error: null,
        });
      }, [onProfileChange]);
      return React.createElement('span', { 'data-testid': 'mock-v3-progression' });
    },
  };
});
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: mocks.walletConnected, address: mocks.walletAddress }),
  useChainId: () => mocks.chainId,
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [], isPending: false }),
  useDisconnect: () => ({ disconnect: mocks.disconnect }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
}));
vi.mock('../blockchain/config', () => ({
  TARGET_CHAIN_ID: 743111,
  TARGET_CHAIN_NAME: 'Hemi Sepolia',
}));

beforeEach(() => {
  mocks.walletConnected = false;
  mocks.walletAddress = undefined;
  mocks.chainId = 0;
  mocks.v3Enabled = false;
  localStorage.removeItem('worldseed:play-mode:v1');
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
  it('accepts a Live profile with bigint reward rules without crashing serialization', async () => {
    mocks.v3Enabled = true;
    localStorage.setItem('worldseed:play-mode:v1', 'live');
    mocks.loadGuestSave.mockResolvedValue({ kind: 'empty' });
    mocks.saveGuestSave.mockResolvedValue(undefined);

    render(<LivingIslandGame />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('mock-v3-progression')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('VERIFIED RUN')).toBeInTheDocument();
  });

  it('clears Live authentication when explicitly disconnecting from Guest mode', async () => {
    mocks.walletConnected = true;
    mocks.walletAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    mocks.chainId = 743111;
    localStorage.setItem('worldseed:play-mode:v1', 'guest');
    mocks.loadGuestSave.mockResolvedValue({ kind: 'empty' });
    mocks.saveGuestSave.mockResolvedValue(undefined);
    render(<LivingIslandGame />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: /0xabcd…abcd/ }));

    expect(mocks.clearAuthSession).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it('defaults fresh production visitors to Live, keeps local development on Guest, and respects explicit preferences', () => {
    expect(initialLivingIslandMode(null, true, true)).toBe('verified');
    expect(initialLivingIslandMode(null, false, true)).toBe('guest');
    expect(initialLivingIslandMode('guest', true, true)).toBe('guest');
    expect(initialLivingIslandMode('live', true, true)).toBe('verified');
    expect(initialLivingIslandMode('live', true, false)).toBe('guest');
  });

  it('retries blocked startup music directly from the island Heart interaction', async () => {
    updateAudioPreferences({ musicEnabled: true, muted: false, musicVolume: 0.14 });
    mocks.loadGuestSave.mockResolvedValue({ kind: 'empty' });
    mocks.saveGuestSave.mockResolvedValue(undefined);
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(
        Object.assign(new Error('Autoplay blocked'), { name: 'NotAllowedError' }),
      )
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
    expect(document.querySelector('.living-notice')).toHaveClass('living-notice--exiting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(
      screen.queryByText('Welcome back. Your island grew while you were away.'),
    ).not.toBeInTheDocument();
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

  it('plays the existing habitat and upgrade sounds for accepted Live actions', () => {
    const playSound = vi.spyOn(islandAudio, 'playIslandSound');
    const habitat = vi.fn();
    const upgrade = vi.fn();
    const actions = withLiveActionSounds({
      pending: false,
      heartClickPending: false,
      pendingHeartClicks: 0,
      buyHabitat: habitat,
      buyProductionUpgrade: upgrade,
      buyNatureSurge: vi.fn(),
      buyFertileSoil: vi.fn(),
      buyTimeBloom: vi.fn(),
      sendGameplayCommand: vi.fn(),
      flushPendingCommands: vi.fn().mockResolvedValue(undefined),
    });

    actions.buyHabitat('water', 1);
    actions.buyProductionUpgrade('water');

    expect(habitat).toHaveBeenCalledWith('water', 1);
    expect(upgrade).toHaveBeenCalledWith('water');
    expect(playSound).toHaveBeenNthCalledWith(1, 'habitat');
    expect(playSound).toHaveBeenNthCalledWith(2, 'upgrade');
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
