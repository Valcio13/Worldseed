import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
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
  loadGuestSave: async () => ({ kind: 'empty' }),
  saveGuestSave: async () => undefined,
  archiveIncompatibleSave: async () => undefined,
}));

afterEach(() => cleanup());

function playWitness(seed: string, demo = false): GameState {
  let game = createGameState(seed, demo);
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

  it('completes the guest loop with starter supplies and milestone rewards', () => {
    const game = playWitness('guest-playthrough', true);
    expect(game.demo).toBe(true);
    expect(game.complete).toBe(true);
    expect(game.unlockedThrough).toBe(4);
    expect(game.inventory.water).toBeGreaterThanOrEqual(0);
    expect(game.inventory.grass).toBeGreaterThanOrEqual(0);
    expect(game.inventory.forest).toBeGreaterThanOrEqual(0);
  });
});

describe('habitat and milestone rules', () => {
  it('gives guest mode a finite, recoverable resource loop', () => {
    let game = createGameState('infinite-demo', true);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const placed = applyAction(game, { type: 'place', index: 8, habitat: 'water' });
      expect(placed.error).toBeUndefined();
      const gathered = applyAction(placed.state, { type: 'remove', index: 8 });
      expect(gathered.error).toBeUndefined();
      game = gathered.state;
    }
    expect(game.inventory.water).toBe(1);
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
  it('gathers Nature from the Heart and buys the first automatic habitat', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>,
    );

    for (let click = 0; click < 10; click += 1) {
      await user.click(screen.getByRole('button', { name: /click the island heart to collect 1 nature/i }));
    }
    await user.click(screen.getByRole('button', { name: /buy 1 water/i }));
    expect(screen.getByTestId('nature-counter')).toHaveTextContent('0');
    expect(screen.getAllByText('0.3').length).toBeGreaterThan(0);
    expect(screen.getByText(/bought 1 water habitat/i)).toBeInTheDocument();
  });

  it('presents the Living Island as the primary screen with the four core actions', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>,
    );

    expect(screen.getByRole('region', { name: /living island, seed stage/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /island resources/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /habitat shop/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /rebirth/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /upgrades/i })).toBeInTheDocument();
    expect(screen.queryByRole('gridcell')).not.toBeInTheDocument();
  });

  it('keeps wallet controls minimal and leaves restoration landmarks out of the primary screen', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>,
    );

    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.queryByRole('gridcell')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /traveling merchant/i })).not.toBeInTheDocument();
  });

  it('offers simple habitat purchases without manual tile controls', () => {
    localStorage.clear();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>,
    );

    expect(screen.getByRole('button', { name: /buy 1 water/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /buy maximum grass/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /place/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument();
  });
});
