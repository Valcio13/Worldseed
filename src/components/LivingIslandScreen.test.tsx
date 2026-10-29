import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HABITAT_UPGRADE_MILESTONES,
  HABITATS,
  habitatProductionPerSecond,
  habitatProductionUpgradeCost,
  buyHabitatProductionUpgrade,
  createEconomyState,
  performRebirth,
  rebirthRequirement,
  type EconomyState,
} from '../incremental/engine';
import { formatValue, valueFromNumber } from '../incremental/decimal';
import { LivingIslandScreen, type LivingIslandScreenProps } from './LivingIslandScreen';
import { islandGrowthStage, islandGrowthStageProgress } from './islandGrowthStage';
import './LivingIsland.css';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderScreen(
  state: EconomyState,
  onStateChange = vi.fn(),
  notificationProps: Partial<
    Pick<
      LivingIslandScreenProps,
      'notice' | 'noticeImportant' | 'onNoticeDismiss' | 'audioControls' | 'walletControl'
    >
  > = {},
) {
  return render(
    <LivingIslandScreen
      state={state}
      nextSeasonStart={Date.UTC(2026, 10, 2)}
      saveLabel="Saved"
      onHeartClick={vi.fn()}
      onStateChange={onStateChange}
      onRebirth={vi.fn()}
      {...notificationProps}
    />,
  );
}

describe('Living Island screen', () => {
  it('closes header dropdowns on outside click or Escape', () => {
    renderScreen(createEconomyState(1), vi.fn(), {
      audioControls: (
        <details className="audio-settings" open>
          <summary>Audio</summary>
          <button type="button">Pause music</button>
        </details>
      ),
      walletControl: (
        <details className="v3-living-account" open>
          <summary>Wallet</summary>
          <button type="button">Disconnect</button>
        </details>
      ),
    });

    const audio = document.querySelector('.audio-settings');
    const wallet = document.querySelector('.v3-living-account');
    expect(audio).toHaveAttribute('open');
    expect(wallet).toHaveAttribute('open');

    fireEvent.click(screen.getByRole('button', { name: 'Pause music' }));
    expect(audio).toHaveAttribute('open');
    expect(wallet).not.toHaveAttribute('open');

    fireEvent.click(document.body);
    expect(audio).not.toHaveAttribute('open');

    (audio as unknown as { open: boolean }).open = true;
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(audio).not.toHaveAttribute('open');
  });

  it('shows a compact dismissible toast and marks important notices as alerts', () => {
    const dismiss = vi.fn();
    const { container, rerender } = renderScreen(createEconomyState(1), vi.fn(), {
      notice: 'Welcome back. Your island grew while you were away.',
      onNoticeDismiss: dismiss,
    });

    const toast = container.querySelector('.living-notice');
    expect(toast).toHaveClass('living-notice');
    expect(toast).toHaveTextContent('Welcome back. Your island grew while you were away.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(dismiss).toHaveBeenCalledOnce();

    rerender(
      <LivingIslandScreen
        state={createEconomyState(1)}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        saveLabel="Saved"
        onHeartClick={vi.fn()}
        onStateChange={vi.fn()}
        onRebirth={vi.fn()}
        notice="Local saving is unavailable."
        noticeImportant
      />,
    );
    expect(screen.getByRole('alert')).toHaveClass('living-notice--important');
  });

  it('uses the official logo as accessible header branding without duplicate wordmark text', () => {
    const { container } = renderScreen(createEconomyState(1));
    const brand = screen.getByRole('link', { name: 'Worldseed' });

    expect(brand.querySelector('img')).toHaveAttribute(
      'src',
      '/assets/branding/worldseed-logo.png',
    );
    expect(brand.querySelector('img')).toHaveAttribute('alt', 'Worldseed');
    expect(brand).not.toHaveTextContent('worldseed');
    expect(container.querySelector('.living-brand-seed')).not.toBeInTheDocument();
  });

  it('keeps the resource bar with the island column and the control panel beside it', () => {
    const { container } = renderScreen(createEconomyState(1));
    const layout = container.querySelector<HTMLElement>('.living-desktop-layout');
    const islandColumn = container.querySelector<HTMLElement>('.living-island-column');
    const controlPanel = screen.getByRole('complementary', { name: 'Game controls' });

    expect(layout).toContainElement(islandColumn);
    expect(layout).toContainElement(controlPanel);
    expect(islandColumn).toContainElement(screen.getByRole('region', { name: 'Island resources' }));
    expect(islandColumn).toContainElement(screen.getByRole('region', { name: /Living Island/ }));
    expect(controlPanel).toContainElement(container.querySelector('.living-rebirth-card'));
    expect(controlPanel).toContainElement(container.querySelector('.living-shop'));
    expect(controlPanel).toContainElement(container.querySelector('.living-upgrades-card'));
    expect(container.querySelector('.living-shop .living-resource-chip')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.living-scene')).toHaveLength(1);
    expect(container.querySelectorAll('.living-control-panel')).toHaveLength(1);
  });

  it('groups Nature Boosts inside the existing seasonal progression shop card', () => {
    const { container } = renderScreen(createEconomyState(1));
    const upgradesCard = container.querySelector('.living-upgrades-card');
    const boosts = screen.getByRole('region', { name: 'NATURE BOOSTS' });

    expect(upgradesCard).toContainElement(boosts);
    expect(screen.getByRole('button', { name: /Nature Surge · 1500 Nature/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Fertile Soil level 1/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Time Bloom requires a habitat' })).toBeDisabled();
  });

  it('collects Nature from the large Island Heart interaction', () => {
    const onHeartClick = vi.fn();
    render(
      <LivingIslandScreen
        state={createEconomyState(1)}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        saveLabel="Saved"
        onHeartClick={onHeartClick}
        onStateChange={vi.fn()}
        onRebirth={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /Click the Island Heart to collect 1 Nature/ }),
    );
    expect(onHeartClick).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /Click the Island Heart/ })).toHaveAttribute(
      'title',
      'Click to collect +1 Nature',
    );
    expect(screen.getByText('+1 Nature')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Click the Island Heart/ })).toHaveClass(
      'island-heart--clicked',
    );
  });

  it('renders the island and resources from verified values and routes Heart clicks away from guest state', () => {
    const localHeartClick = vi.fn();
    const verifiedHeartClick = vi.fn();
    const verifiedIsland = {
      nature: '456',
      estimatedNature: '456',
      earnedNature: '600',
      productionPerSecond: '12',
      visualHabitatLevelCount: 5,
      verifiedNatureBoosts: null,
      pendingHeartClicks: 0,
      scoreTier: 35,
      rulesVersion: 1,
      habitats: [],
    };
    render(
      <LivingIslandScreen
        state={createEconomyState(1)}
        mode="verified"
        verifiedModeEnabled
        verifiedIsland={verifiedIsland}
        verifiedHeartAction={verifiedHeartClick}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        saveLabel="Saved"
        verifiedProgression={<section aria-label="Verified progression controls" />}
        onModeChange={vi.fn()}
        onHeartClick={localHeartClick}
        onStateChange={vi.fn()}
        onRebirth={vi.fn()}
      />,
    );

    expect(screen.getByTestId('verified-nature-counter')).toHaveTextContent('~456');
    expect(screen.getByText('600')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Live Living Island, growing stage' })).toHaveClass(
      'living-scene--growing',
    );
    expect(screen.getByRole('heading', { name: 'Habitat shop' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rebirth' })).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Click the Live Island Heart to collect 1 Nature' }),
    );
    expect(verifiedHeartClick).toHaveBeenCalledOnce();
    expect(localHeartClick).not.toHaveBeenCalled();
    expect(screen.getByText('+1 Nature')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guest' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows estimated Rebirth rewards separately from settled balances and refreshes them with score tier', () => {
    const verifiedIsland = {
      nature: '456',
      estimatedNature: '456',
      earnedNature: '600',
      productionPerSecond: '12',
      visualHabitatLevelCount: 5,
      verifiedNatureBoosts: null,
      pendingHeartClicks: 0,
      scoreTier: 35,
      rulesVersion: 1,
      habitats: [],
    };
    const openStartRun = vi.fn();
    const props = {
      state: createEconomyState(1),
      mode: 'verified' as const,
      verifiedModeEnabled: true,
      verifiedIsland,
      verifiedProfile: {
        activeRun: true,
        runId: '1',
        authenticated: true,
        ready: true,
        seasonalPP: '10',
        seasonalCP: '3',
        rewardRules: {
          rebirthThresholdTier: 35,
          ppStep: 10,
          ppPerRebirthCap: 1_000n,
          ppBase: 1n,
          seasonPPCap: 100_000n,
          seasonCPCap: 100_000n,
          cpMilestoneStep: 7,
        },
        totalSeasonCP: '3',
        maxSeasonPoints: '1000000',
        lifetimeCP: '3',
        lifetimeNature: '600',
        accumulatedScore: '35',
        seasonalAccumulatedScore: '35',
        seasonalHighScoreTier: 0,
        nextCpMilestoneTier: 42,
        rebirthThresholdTier: 35,
        seasonRebirths: 0,
        upgradeLevels: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
        wallet: '0x0000000000000000000000000000000000000001',
        error: null,
      },
      verifiedSettlement: {
        pending: false,
        canSettle: true,
        openStartRun,
        recordPoints: vi.fn(),
        rebirth: vi.fn(),
      },
      nextSeasonStart: Date.UTC(2026, 10, 2),
      saveLabel: 'Saved',
      onHeartClick: vi.fn(),
      onStateChange: vi.fn(),
      onRebirth: vi.fn(),
    };
    const { rerender } = render(<LivingIslandScreen {...props} />);

    expect(screen.getByText(/Settled balances/)).toBeInTheDocument();
    expect(screen.getByLabelText('Estimated Rebirth rewards')).toHaveTextContent('+1 PP · +0 CP');
    const islandScene = screen.getByRole('region', { name: /Live Living Island/ });
    const liveStats = screen.getByRole('region', { name: 'Live account stats' });
    expect(
      islandScene.compareDocumentPosition(liveStats) &
        window.Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    rerender(
      <LivingIslandScreen
        {...props}
        verifiedIsland={{ ...verifiedIsland, scoreTier: 42 }}
      />,
    );
    expect(screen.getByLabelText('Estimated Rebirth rewards')).toHaveTextContent('+1 PP · +1 CP');
    expect(screen.getByText(/Next CP milestone after Rebirth/)).toHaveTextContent('49');

    rerender(
      <LivingIslandScreen
        {...props}
        verifiedIsland={null}
        verifiedProfile={{ ...props.verifiedProfile, activeRun: false }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start a Live run' }));
    expect(openStartRun).toHaveBeenCalledOnce();
  });

  it('keeps Live Heart clicks enabled while queued Heart commands sync', () => {
    const heart = vi.fn();
    render(
      <LivingIslandScreen
        state={createEconomyState(1)}
        mode="verified"
        verifiedModeEnabled
        verifiedIsland={{
          nature: '1', estimatedNature: '1', earnedNature: '1', productionPerSecond: '0',
          visualHabitatLevelCount: 0, verifiedNatureBoosts: null, pendingHeartClicks: 0, scoreTier: 0, rulesVersion: 1, habitats: [],
        }}
        verifiedHeartAction={heart}
        verifiedActions={{
          pending: true,
          heartClickPending: true,
          pendingHeartClicks: 2,
          buyHabitat: vi.fn(),
          buyProductionUpgrade: vi.fn(),
          buyNatureSurge: vi.fn(),
          buyFertileSoil: vi.fn(),
          buyTimeBloom: vi.fn(),
          sendGameplayCommand: vi.fn(),
          flushPendingCommands: vi.fn(async () => undefined),
        }}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        saveLabel="Saved"
        onHeartClick={vi.fn()}
        onStateChange={vi.fn()}
        onRebirth={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', {
      name: 'Click the Live Island Heart to collect 1 Nature',
    });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(heart).toHaveBeenCalledOnce();
    expect(screen.getByText('+1 Nature')).toBeInTheDocument();
  });

  it('routes verified habitat purchases to V3 and never touches the guest economy handler', () => {
    const onStateChange = vi.fn();
    const buyHabitat = vi.fn();
    render(
      <LivingIslandScreen
        state={createEconomyState(1)}
        mode="verified"
        verifiedIsland={{
          nature: '456',
          estimatedNature: '456',
          earnedNature: '600',
          productionPerSecond: '12',
          visualHabitatLevelCount: 1,
          verifiedNatureBoosts: null,
          pendingHeartClicks: 0,
          scoreTier: 1,
          rulesVersion: 1,
          habitats: [{
            id: 'water', level: 1, nextCost: '10', canBuyOne: true,
            maxAffordable: 2, purchasedUpgradeCount: 0, productionUpgrades: [],
          }],
        }}
        verifiedActions={{
          pending: false,
          heartClickPending: false,
          pendingHeartClicks: 0,
          buyHabitat,
          buyProductionUpgrade: vi.fn(),
          buyNatureSurge: vi.fn(),
          buyFertileSoil: vi.fn(),
          buyTimeBloom: vi.fn(),
          sendGameplayCommand: vi.fn(),
          flushPendingCommands: vi.fn(async () => undefined),
        }}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        saveLabel="Saved"
        onHeartClick={vi.fn()}
        onStateChange={onStateChange}
        onRebirth={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Buy 1 Live Water' }));
    expect(buyHabitat).toHaveBeenCalledWith('water', 1);
    expect(onStateChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('verified-nature-counter')).toHaveTextContent('456');
  });

  it('mounts Rules V3 Live upgrades and routes all three commands through verified actions', () => {
    const sendGameplayCommand = vi.fn();
    render(
      <LivingIslandScreen
        state={createEconomyState(1)}
        mode="verified"
        verifiedIsland={{
          nature: '8,000',
          estimatedNature: '8,000',
          earnedNature: '8,000',
          productionPerSecond: '12',
          visualHabitatLevelCount: 5,
          scoreTier: 5,
          rulesVersion: 3,
          pendingHeartClicks: 0,
          verifiedNatureBoosts: {
            natureSurgeCost: '1,500',
            natureSurgeRemainingMs: 0,
            canBuyNatureSurge: true,
            fertileSoilLevel: 1,
            fertileSoilMaxLevel: 5,
            fertileSoilNextCost: '2,000',
            canBuyFertileSoil: true,
            timeBloomUsed: false,
            timeBloomCost: '240',
            canBuyTimeBloom: true,
          },
          habitats: [],
        }}
        verifiedActions={{
          pending: false,
          heartClickPending: false,
          pendingHeartClicks: 0,
          buyHabitat: vi.fn(),
          buyProductionUpgrade: vi.fn(),
          buyNatureSurge: vi.fn(),
          buyFertileSoil: vi.fn(),
          buyTimeBloom: vi.fn(),
          sendGameplayCommand,
          flushPendingCommands: vi.fn(async () => undefined),
        }}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        saveLabel="Saved"
        onHeartClick={vi.fn()}
        onStateChange={vi.fn()}
        onRebirth={vi.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: 'Live Nature upgrades' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Nature Surge/ }));
    fireEvent.click(screen.getByRole('button', { name: /Fertile Soil level 2/ }));
    fireEvent.click(screen.getByRole('button', { name: /Buy Time Bloom/ }));
    expect(sendGameplayCommand.mock.calls).toEqual([
      [{ type: 'buy-temporary-upgrade', upgrade: 'nature-surge' }],
      [{ type: 'buy-fertile-soil' }],
      [{ type: 'buy-time-bloom' }],
    ]);
  });

  it('reroutes a walk that would pass behind the Heart, then returns to idle', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(1.3 / (2 * Math.PI))
      .mockReturnValueOnce(1);
    const base = createEconomyState(1);
    const flourishing: EconomyState = {
      ...base,
      habitats: { ...base.habitats, water: 15 },
    };
    renderScreen(flourishing);

    const moss = screen.getByTestId('island-creature-moss');
    const animate = vi.fn(
      (_keyframes: Parameters<Element['animate']>[0], _options?: Parameters<Element['animate']>[1]) =>
        ({ cancel: vi.fn(), onfinish: null }) as unknown as Animation,
    );
    Object.defineProperty(moss, 'animate', { configurable: true, value: animate });
    expect(moss).toHaveAttribute('data-walking', 'false');
    expect(moss).toHaveStyle({ left: '23%', top: '60%' });
    act(() => vi.advanceTimersByTime(2_200));
    expect(moss).toHaveAttribute('data-walking', 'true');
    expect(Number.parseFloat(moss.style.left)).toBeGreaterThan(50);
    expect(Number.parseFloat(moss.style.left)).toBeLessThan(60);
    expect(Number.parseFloat(moss.style.top)).toBeGreaterThan(60);
    expect(animate).toHaveBeenCalledOnce();
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 1250, easing: 'ease-in-out' });
    expect(moss).toHaveAttribute('data-facing', 'right');
    expect(moss.querySelector('.island-creature-sprite')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_300));
    expect(moss).toHaveAttribute('data-walking', 'false');
  });

  it('keeps creatures still when reduced motion is requested', () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const base = createEconomyState(1);
    renderScreen({ ...base, habitats: { ...base.habitats, water: 15 } });
    const moss = screen.getByTestId('island-creature-moss');

    act(() => vi.advanceTimersByTime(20_000));
    expect(moss).toHaveAttribute('data-walking', 'false');
    expect(moss).toHaveStyle({ left: '23%', top: '60%' });
  });

  it('lets creatures wander broadly while keeping their sprite footprint inside the island', () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'matchMedia',
      vi.fn((_query: string) => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const base = createEconomyState(1);
    renderScreen({ ...base, habitats: { ...base.habitats, water: 15 } });
    const moss = screen.getByTestId('island-creature-moss');

    act(() => vi.advanceTimersByTime(4_000));

    const left = Number.parseFloat(moss.style.left);
    const top = Number.parseFloat(moss.style.top);
    expect(left).not.toBe(23);
    for (const x of [left + 1, left + 9]) {
      for (const y of [top + 1, top + 25]) {
        const normalizedX = (x - 50) / 46;
        const normalizedY = (y - 50) / 47;
        expect(normalizedX ** 2 + normalizedY ** 2).toBeLessThanOrEqual(0.92);
      }
    }
  });

  it('places mobile creatures on the island surface before they begin wandering', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('max-width: 700px'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const base = createEconomyState(1);
    renderScreen({ ...base, habitats: { ...base.habitats, water: 15 } });

    expect(screen.getByTestId('island-creature-moss')).toHaveStyle({ left: '22%', top: '58%' });
    expect(screen.getByTestId('island-creature-pip')).toHaveStyle({ left: '72%', top: '35%' });
    expect(screen.getByTestId('island-creature-luma')).toHaveStyle({ left: '70%', top: '52%' });
    expect(screen.getByTestId('island-creature-caretaker')).toHaveStyle({ left: '33%', top: '64%' });
    expect(screen.getByTestId('island-creature-villager')).toHaveStyle({ left: '74%', top: '52%' });
  });

  it('passes habitat purchases through the existing economy action', () => {
    const state = { ...createEconomyState(1), nature: valueFromNumber(10) };
    const onStateChange = vi.fn();
    renderScreen(state, onStateChange);
    fireEvent.click(screen.getByRole('button', { name: 'Buy 1 Water' }));
    expect(onStateChange).toHaveBeenCalledOnce();
    expect(onStateChange.mock.calls[0]?.[0].state.habitats.water).toBe(1);
    expect(screen.getAllByText('Level 0 · 0 Nature/sec')).toHaveLength(6);
  });

  it('offers fixed 1x, 10x, 100x, and max habitat purchase quantities', () => {
    const state = { ...createEconomyState(1), nature: valueFromNumber(1_000_000_000) };
    const onStateChange = vi.fn();
    renderScreen(state, onStateChange);

    fireEvent.click(screen.getByRole('button', { name: 'Buy 10 Water' }));
    fireEvent.click(screen.getByRole('button', { name: 'Buy 100 Water' }));

    expect(onStateChange).toHaveBeenCalledTimes(2);
    expect(onStateChange.mock.calls[0]?.[0].state.habitats.water).toBe(10);
    expect(onStateChange.mock.calls[1]?.[0].state.habitats.water).toBe(100);
    expect(screen.getByRole('button', { name: 'Buy maximum Water' })).toBeEnabled();
  });

  it('shows and purchases all six habitats through the guest economy when affordable', () => {
    const state = { ...createEconomyState(1), nature: valueFromNumber(100_000) };
    const onStateChange = vi.fn();
    renderScreen(state, onStateChange);

    for (const habitat of [
      'Water',
      'Grass',
      'Forest',
      'Mountain',
      'Crystal Cavern',
      'Ancient Grove',
    ]) {
      expect(screen.getByText(habitat)).toBeVisible();
    }
    for (const habitat of HABITATS) {
      const label =
        habitat === 'crystal-cavern'
          ? 'Crystal Cavern'
          : habitat === 'ancient-grove'
            ? 'Ancient Grove'
            : habitat[0]!.toUpperCase() + habitat.slice(1);
      fireEvent.click(screen.getByRole('button', { name: `Buy 1 ${label}` }));
    }
    expect(onStateChange).toHaveBeenCalledTimes(HABITATS.length);
    HABITATS.forEach((habitat, index) => {
      expect(onStateChange.mock.calls[index]?.[0].state.habitats[habitat]).toBe(1);
    });
  });

  it('uses authoritative milestone costs, sequential states, production, and purchase actions', () => {
    const base = createEconomyState(1);
    const state = {
      ...base,
      nature: valueFromNumber(1_000),
      habitats: { ...base.habitats, water: 50 },
    };
    const onStateChange = vi.fn();
    const view = render(
      <LivingIslandScreen
        state={state}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        saveLabel="Saved"
        onHeartClick={vi.fn()}
        onStateChange={onStateChange}
        onRebirth={vi.fn()}
      />,
    );

    fireEvent.click(document.querySelector('.living-habitat--water summary')!);
    const waterRows = document.querySelectorAll('.living-habitat--water .living-habitat-upgrade');
    expect(waterRows).toHaveLength(HABITAT_UPGRADE_MILESTONES.length);
    expect([...waterRows].map((row) => row.getAttribute('data-upgrade-state'))).toEqual([
      'available',
      'locked',
      'locked',
      'locked',
    ]);
    expect(document.querySelector('.living-habitat--water')).toHaveTextContent(
      `Cost · ${formatValue(habitatProductionUpgradeCost('water', 0))} N`,
    );
    const predictedState = {
      ...state,
      habitatProductionUpgrades: { ...state.habitatProductionUpgrades, water: 1 },
    };
    expect(waterRows[0]).toHaveTextContent(
      `Production after upgrade: ${formatValue(habitatProductionPerSecond(predictedState, 'water'))} Nature/sec`,
    );
    fireEvent.click(screen.getByRole('button', { name: /Water level 10 upgrade · Buy/ }));
    expect(onStateChange).toHaveBeenCalledOnce();
    const purchased = onStateChange.mock.calls[0]![0].state;
    expect(purchased.habitatProductionUpgrades?.water).toBe(1);
    expect(purchased.nature).toEqual(valueFromNumber(0));
    expect(buyHabitatProductionUpgrade(purchased, 'water').error).toMatch(/Not enough Nature/);

    view.rerender(
      <LivingIslandScreen
        state={purchased}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        saveLabel="Saved"
        onHeartClick={vi.fn()}
        onStateChange={vi.fn()}
        onRebirth={vi.fn()}
      />,
    );
    expect(
      [...document.querySelectorAll('.living-habitat--water .living-habitat-upgrade')].map((row) =>
        row.getAttribute('data-upgrade-state'),
      ),
    ).toEqual(['purchased', 'unaffordable', 'locked', 'locked']);
    expect(
      screen.getByRole('button', { name: /Water level 10 upgrade · Purchased/ }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: /Water level 25 upgrade · Need/ })).toBeDisabled();
  });

  it('renders the unaffordable state from the engine milestone price', () => {
    const base = createEconomyState(1);
    const state = {
      ...base,
      habitats: { ...base.habitats, mountain: 10 },
      nature: valueFromNumber(1),
    };
    renderScreen(state);
    fireEvent.click(document.querySelector('.living-habitat--mountain summary')!);
    const row = document.querySelector('.living-habitat--mountain .living-habitat-upgrade');
    expect(row).toHaveAttribute('data-upgrade-state', 'unaffordable');
    expect(row).toHaveTextContent(
      `Cost · ${formatValue(habitatProductionUpgradeCost('mountain', 0))} N`,
    );
    expect(screen.getByRole('button', { name: /Mountain level 10 upgrade · Need/ })).toBeDisabled();
  });

  it('keeps unavailable actions disabled and reports save status', () => {
    renderScreen(createEconomyState(1));
    expect(screen.getByRole('button', { name: 'Buy 1 Water' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rebirth →' })).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Rebirth' })).toBeVisible();
    expect(screen.getByText(/Keep growing your island to reach the Nature goal/)).toBeVisible();
    expect(document.querySelector('.living-rebirth-progress-copy')).toHaveTextContent(
      `0 / ${formatValue(rebirthRequirement(createEconomyState(1)))} Nature`,
    );
    expect(screen.getByText('Saved')).toBeVisible();
  });

  it('enables eligible Rebirth, shows the existing rewards, and presents the completed state', () => {
    const base = createEconomyState(1);
    const goal = rebirthRequirement(base);
    const eligible: EconomyState = { ...base, nature: goal, runNature: goal };
    const onRebirth = vi.fn();
    const view = render(
      <LivingIslandScreen
        state={eligible}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        saveLabel="Saved"
        onHeartClick={vi.fn()}
        onStateChange={vi.fn()}
        onRebirth={onRebirth}
      />,
    );

    expect(screen.getByText('Nature goal reached — Rebirth is ready.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rebirth →' })).toBeEnabled();
    expect(document.querySelector('.living-rebirth-reward')).toHaveTextContent('+1 PP');
    expect(document.querySelector('.living-rebirth-reward')).toHaveTextContent('+1 simulated CP');
    fireEvent.click(screen.getByRole('button', { name: 'Rebirth →' }));
    expect(onRebirth).toHaveBeenCalledOnce();

    const completed = performRebirth(eligible).state;
    view.rerender(
      <LivingIslandScreen
        state={completed}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        saveLabel="Saved"
        onHeartClick={vi.fn()}
        onStateChange={vi.fn()}
        onRebirth={onRebirth}
      />,
    );
    expect(document.querySelector('.living-pp-chip')).toHaveTextContent('1 PP');
    expect(screen.getByText('1 this season')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rebirth →' })).toBeDisabled();
    expect(screen.getByText(/Keep growing your island/)).toBeVisible();
  });

  it('shows the four visual stages from existing habitat milestone counts', () => {
    const base = createEconomyState(1);
    const withLevels = (levels: number): EconomyState => ({
      ...base,
      habitats: { water: levels, grass: 0, forest: 0 },
    });
    const stages = [
      {
        levels: 0,
        name: 'seed',
        trees: 0,
        flowers: 0,
        creatures: [],
        campsite: false,
        edgeDetails: 1,
        earthEdgeDetails: 0,
        sprites: ['rock-pebble.png'],
      },
      {
        levels: 1,
        name: 'sprout',
        trees: 1,
        flowers: 2,
        creatures: ['moss'],
        campsite: false,
        edgeDetails: 3,
        earthEdgeDetails: 0,
        sprites: [
          'pine-tree-small.png',
          'flower-yellow.png',
          'flower-white.png',
          'bush-small.png',
        ],
      },
      {
        levels: 5,
        name: 'growing',
        trees: 3,
        flowers: 4,
        creatures: ['moss', 'pip', 'caretaker'],
        campsite: false,
        edgeDetails: 5,
        earthEdgeDetails: 1,
        sprites: [
          'pine-tree-small.png',
          'pine-tree-thin.png',
          'flower-yellow.png',
          'flower-white.png',
          'mushroom-redcap.png',
          'bush-round.png',
          'bush-small.png',
          'rock-pebble.png',
          'mushroom-redcap.png',
        ],
      },
      {
        levels: 15,
        name: 'flourishing',
        trees: 4,
        flowers: 7,
        creatures: ['moss', 'pip', 'luma', 'caretaker', 'villager'],
        campsite: true,
        edgeDetails: 8,
        earthEdgeDetails: 2,
        sprites: [
          'pine-tree-small.png',
          'pine-tree-thin.png',
          'leafy-tree-grove.png',
          'bush-small.png',
          'bush-wide.png',
          'bush-round.png',
          'flower-yellow.png',
          'flower-white.png',
          'mushroom-redcap.png',
          'rock-pebble.png',
          'rock-boulder.png',
          'mushroom-redcap.png',
        ],
      },
    ] as const;

    for (const stage of stages) {
      const state = withLevels(stage.levels);
      expect(islandGrowthStage(state)).toBe(stage.name);
      const growthProgress = islandGrowthStageProgress(state);
      const expectedProgress =
        stage.name === 'seed'
          ? 0
          : stage.name === 'sprout'
            ? 20
            : stage.name === 'growing'
              ? 33
              : 100;
      expect(growthProgress.progress).toBe(expectedProgress);
      const { container } = renderScreen(state);
      const island = screen.getByRole('region', {
        name: `Guest Living Island, ${stage.name} stage`,
      });
      expect(island).toHaveClass(`living-scene--${stage.name}`);
      expect(island.querySelector('.living-island-land')).toHaveAttribute(
        'data-terrain-surface',
        'craftpix',
      );
      expect(island.querySelector('.living-island-land')).toHaveStyle({ overflow: 'visible' });
      expect(island.querySelector('.island-terrain-preview-toggle')).toBeNull();
      expect(island.querySelectorAll('.living-tree')).toHaveLength(stage.trees);
      expect(island.querySelectorAll('.island-sprout')).toHaveLength(stage.flowers);
      expect(island.querySelectorAll('.island-edge-detail')).toHaveLength(stage.edgeDetails);
      expect(island.querySelectorAll('[data-edge-material="earth"]')).toHaveLength(
        stage.earthEdgeDetails,
      );
      expect(island.querySelector('[data-testid="island-campsite"]') !== null).toBe(stage.campsite);
      expect(
        [...island.querySelectorAll<HTMLElement>('.island-creature')].map(
          (creature) => creature.dataset.creature,
        ),
      ).toEqual([...stage.creatures]);
      for (const creature of stage.creatures) {
        expect(island.querySelector(`[data-testid="island-creature-${creature}"]`)).toHaveClass(
          `island-creature--${creature}`,
        );
      }
      const spriteNames = [...island.querySelectorAll<HTMLElement>('[data-craftpix-sprite]')].map(
        (sprite) => sprite.dataset.craftpixSprite!,
      );
      expect(spriteNames).toEqual(expect.arrayContaining([...stage.sprites]));
      expect(island.querySelectorAll('.scene-firefly')).toHaveLength(
        stage.name === 'seed' ? 1 : stage.name === 'sprout' ? 2 : stage.name === 'growing' ? 3 : 4,
      );
      expect(island.querySelectorAll('.scene-distant-island')).toHaveLength(
        stage.name === 'seed' ? 0 : stage.name === 'sprout' ? 1 : stage.name === 'growing' ? 2 : 3,
      );
      expect(island.querySelectorAll('.water-glint')).toHaveLength(
        stage.name === 'seed' ? 1 : stage.name === 'sprout' ? 2 : stage.name === 'growing' ? 4 : 6,
      );
      if (stage.campsite) {
        expect(island.querySelector('[data-testid="island-campsite"] img')).toHaveAttribute(
          'src',
          '/assets/environment/living-island-campsite.png',
        );
      }
      expect(
        screen.getByRole('progressbar', { name: `Growth progress to ${growthProgress.next}` }),
      ).toHaveAttribute('aria-valuenow', String(expectedProgress));
      expect(container.querySelector('.island-heart-sprite')).toBeTruthy();
      cleanup();
    }
  });
});
