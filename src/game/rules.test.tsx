import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WagmiProvider } from 'wagmi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../components/App';
import { wagmiConfig } from '../blockchain/config';
import witnessVector from '../../shared/witness-v1.json';
import { generateIsland, WITNESS } from './generateIsland';
import { applyAction, createGameState, healthyAt, healthyCount, isHeartComplete } from './rules';
import type { GameState } from './types';

vi.mock('../persistence/localSave', () => ({
  loadGuestGame: async () => null,
  saveGuestGame: async () => undefined,
}));

afterEach(() => cleanup());

function playWitness(seed: string): GameState {
  let game = createGameState(seed, false);
  for (const step of WITNESS) {
    const index = step.y * 7 + step.x;
    const result =
      step.type === 'place'
        ? applyAction(game, { type: 'place', index, habitat: step.habitat })
        : applyAction(game, { type: 'remove', index });
    expect(result.error, `${step.type} (${step.x},${step.y}) on ${seed}`).toBeUndefined();
    game = result.state;
  }
  return game;
}

describe('deterministic island generation', () => {
  it('matches the shared Solidity action vector for generator version 1', () => {
    const encoded = WITNESS.map((step) => {
      const cell = step.y * 7 + step.x;
      const habitat =
        step.type === 'remove'
          ? 0
          : step.habitat === 'water'
            ? 1
            : step.habitat === 'grass'
              ? 2
              : 3;
      return cell * 4 + habitat;
    });
    expect(witnessVector.generatorVersion).toBe(1);
    expect(encoded).toEqual(witnessVector.actions);
  });

  it('repeats the same versioned map for the same seed', () => {
    expect(generateIsland('seed-a')).toEqual(generateIsland('seed-a'));
    expect(generateIsland('seed-a').generatorVersion).toBe(1);
  });

  it('keeps every constructive witness cell placeable over 100,000 diverse seeds', () => {
    const failures: string[] = [];
    for (let i = 0; i < 100_000; i += 1) {
      const island = generateIsland(`witness-${i}`);
      for (const step of WITNESS) {
        const cell = island.cells[step.y * 7 + step.x]!;
        if (!cell.placeable || cell.region === 'island-heart') {
          failures.push(`${i}:${step.x},${step.y}`);
          break;
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('has an executable solo completion witness for representative seed boundaries', () => {
    for (const seed of ['0', '1', '4294967295', 'minimum', 'maximum', 'worldseed-demo-001']) {
      const game = playWitness(seed);
      expect(game.unlockedThrough).toBe(4);
      expect(healthyCount(game.island.cells)).toBeGreaterThanOrEqual(12);
      expect(isHeartComplete(game.island.cells, game.unlockedThrough)).toBe(true);
      expect(game.complete).toBe(true);
      expect(game.inventory.water).toBeGreaterThanOrEqual(0);
      expect(game.inventory.grass).toBeGreaterThanOrEqual(0);
      expect(game.inventory.forest).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('habitat and milestone rules', () => {
  it('keeps guest demo resources unlimited without touching wallet rewards', () => {
    let game = createGameState('infinite-demo', true);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const placed = applyAction(game, { type: 'place', index: 8, habitat: 'water' });
      expect(placed.error).toBeUndefined();
      const gathered = applyAction(placed.state, { type: 'remove', index: 8 });
      expect(gathered.error).toBeUndefined();
      game = gathered.state;
    }
    expect(game.inventory.water).toBe(20);
    expect(game.demo).toBe(true);
  });

  it('does not count diagonal adjacency for healthy grass', () => {
    const island = generateIsland('health-test');
    island.cells[1 * 7 + 1]!.habitat = 'water';
    island.cells[2 * 7 + 2]!.habitat = 'grass';
    expect(healthyAt(island.cells, 2 * 7 + 2)).toBe(false);
  });

  it('awards the Dry Basin milestone once and keeps it after removal', () => {
    let game = createGameState('milestone-test', false);
    game = applyAction(game, { type: 'place', index: 1 * 7 + 1, habitat: 'water' }).state;
    const placedGrass = applyAction(game, { type: 'place', index: 2 * 7 + 1, habitat: 'grass' });
    expect(placedGrass.state.claimedRegions).toContain('dry-basin');
    expect(placedGrass.state.inventory.water).toBe(1);
    expect(placedGrass.state.inventory.grass).toBe(2);
    const removed = applyAction(placedGrass.state, { type: 'remove', index: 2 * 7 + 1 });
    expect(removed.state.claimedRegions.filter((region) => region === 'dry-basin')).toHaveLength(1);
    expect(removed.state.inventory.grass).toBe(3);
  });

  it('rejects placements into locked regions and prevents negative inventory', () => {
    const game = createGameState('locked-test', false);
    const locked = applyAction(game, { type: 'place', index: 2 * 7 + 2, habitat: 'water' });
    expect(locked.error).toMatch(/mist/i);
    const exhausted = applyAction(game, { type: 'place', index: 1 * 7 + 1, habitat: 'forest' });
    expect(exhausted.error).toMatch(/No forest/i);
    expect(exhausted.state.inventory.forest).toBe(0);
  });
});

describe('first guest journey', () => {
  it('shows a recoverable screen and technical details when the lazy game screen fails', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onRetry = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function BrokenGame(): never {
      throw new Error('fixture chunk fetch failed');
    }

    render(
      <PuzzleLoadBoundary onBack={onBack} onRetry={onRetry}>
        <BrokenGame />
      </PuzzleLoadBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/grove game did not load/i);
    expect(screen.getByText(/Loading error: fixture chunk fetch failed/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /reload and try again/i }));
    await user.click(screen.getByRole('button', { name: /return to island/i }));
    await user.click(screen.getByText('Show loading error details'));
    expect(screen.getByText(/^Error: fixture chunk fetch failed/)).toBeInTheDocument();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('opens the tutorial, places healthy Water and Grass, and unlocks the next region', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>,
    );

    await user.click(screen.getByRole('button', { name: /how to play/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /let’s restore/i }));

    await user.hover(screen.getByRole('gridcell', { name: /clearing, row 1, column 1/i }));
    expect(screen.getByRole('gridcell', { name: /invalid preview/i })).toHaveAttribute(
      'title',
      'That tile cannot hold a habitat.',
    );

    await user.click(screen.getByRole('gridcell', { name: /clearing, row 2, column 2/i }));
    expect(screen.getByRole('gridcell', { name: /clearing, row 2, column 2, water/i })).toHaveClass(
      'tile--just-restored',
    );
    await user.click(screen.getByRole('button', { name: /grass/i }));
    await user.click(screen.getByRole('gridcell', { name: /clearing, row 3, column 2/i }));

    expect(
      screen.getByRole('gridcell', { name: /clearing, row 2, column 2, water, healthy/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('gridcell', { name: /clearing, row 3, column 2, grass, healthy/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Dry Basin')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /regions & details/i }));
    expect(screen.getByText('Dry Basin')).toBeInTheDocument();
    expect(screen.queryByText(/save progress/i)).not.toBeInTheDocument();
  });

  it('starts and saves a practice 2048 round without a wallet or contract', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>,
    );

    await user.click(screen.getAllByRole('button', { name: /play 2048/i })[0]!);
    await user.click(await screen.findByRole('button', { name: /start practice/i }));
    for (const direction of ['left', 'up', 'right', 'down']) {
      await user.click(screen.getByRole('button', { name: `Move ${direction}` }));
    }

    await waitFor(() => {
      const save = JSON.parse(localStorage.getItem('worldseed:2048:practice:v1') ?? 'null');
      expect(save?.state?.validMoves).toBeGreaterThan(0);
    });
    expect(Object.keys(localStorage).some((key) => key.startsWith('worldseed:2048:pending:'))).toBe(
      false,
    );
    expect(screen.getByText('PRACTICE · NO REWARDS')).toBeInTheDocument();
  });

  it('opens the Traveling Merchant and World Tree from their island landmarks', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>,
    );

    await user.click(screen.getByRole('button', { name: /traveling merchant habitat supplies/i }));
    expect(screen.getByRole('dialog', { name: /traveling merchant/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /traveling merchant/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /open world tree community progress/i }));
    expect(screen.getByRole('dialog', { name: /world tree/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /open seed shrine 2048 grove game/i }));
    expect(await screen.findByRole('heading', { name: /grow your grove/i })).toBeInTheDocument();
  });

  it('keeps all 49 cells available under the compact HUD and opens game panels', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>,
    );

    expect(screen.getAllByRole('gridcell')).toHaveLength(49);
    const grass = screen.getByRole('button', { name: /select grass, unlimited demo supply/i });
    await user.click(grass);
    expect(grass).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /regions & details/i }));
    expect(screen.getByRole('dialog', { name: /island details/i })).toBeInTheDocument();
    expect(screen.getByText('Dry Basin')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /island details/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /open game settings/i }));
    const settings = screen.getByRole('dialog', { name: /game settings/i });
    expect(settings).toBeInTheDocument();
    const soundToggle = screen.getByText('Island sounds').closest('button');
    expect(soundToggle).not.toBeNull();
    await user.click(soundToggle!);
    expect(soundToggle).toHaveAttribute('aria-pressed', 'false');
    expect(within(settings).getByText('Off')).toBeInTheDocument();
  });
});
