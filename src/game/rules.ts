import {
  BOARD_SIZE,
  REGIONS,
  REWARDS,
  type Cell,
  type GameEvent,
  type GameState,
  type Inventory,
  type RegionId,
} from './types';
import { generateIsland, regionIndex } from './generateIsland';

export function healthyAt(cells: Cell[], index: number): boolean {
  const cell = cells[index];
  if (!cell?.habitat) return false;
  if (cell.habitat === 'water') return true;
  const neighbors = orthogonalNeighbors(index);
  if (cell.habitat === 'grass')
    return neighbors.some((neighbor) => cells[neighbor]?.habitat === 'water');
  const hasWater = neighbors.some((neighbor) => cells[neighbor]?.habitat === 'water');
  const hasHealthyGrass = neighbors.some(
    (neighbor) => cells[neighbor]?.habitat === 'grass' && isHealthyGrass(cells, neighbor),
  );
  return hasWater && hasHealthyGrass;
}

function isHealthyGrass(cells: Cell[], index: number): boolean {
  return (
    cells[index]?.habitat === 'grass' &&
    orthogonalNeighbors(index).some((neighbor) => cells[neighbor]?.habitat === 'water')
  );
}

export function orthogonalNeighbors(index: number): number[] {
  const x = index % BOARD_SIZE;
  const y = Math.floor(index / BOARD_SIZE);
  return [
    ...(x > 0 ? [index - 1] : []),
    ...(x < BOARD_SIZE - 1 ? [index + 1] : []),
    ...(y > 0 ? [index - BOARD_SIZE] : []),
    ...(y < BOARD_SIZE - 1 ? [index + BOARD_SIZE] : []),
  ];
}

export function healthyCount(cells: Cell[], throughRegion = Number.POSITIVE_INFINITY): number {
  return cells.reduce(
    (total, cell, index) =>
      total + (regionIndex(cell.region) <= throughRegion && healthyAt(cells, index) ? 1 : 0),
    0,
  );
}

export function healthyForestCount(cells: Cell[]): number {
  return cells.reduce(
    (total, cell, index) => total + (cell.habitat === 'forest' && healthyAt(cells, index) ? 1 : 0),
    0,
  );
}

export function isHeartComplete(cells: Cell[], unlockedThrough: number): boolean {
  if (unlockedThrough < 4 || healthyCount(cells) < 12 || healthyForestCount(cells) < 3)
    return false;
  const heart = cells.findIndex((cell) => cell.terrain === 'heart');
  if (heart < 0) return false;
  // Under the locked ecology rule, every healthy Forest is adjacent to Water.
  // This flood fill still checks the stated path explicitly for auditability.
  const starts = cells.flatMap((cell, index) =>
    cell.habitat === 'water' && healthyAt(cells, index) ? [index] : [],
  );
  const seen = new Set(starts);
  const queue = [...starts];
  while (queue.length) {
    const current = queue.shift()!;
    if (
      cells[current]?.habitat === 'forest' &&
      healthyAt(cells, current) &&
      orthogonalNeighbors(heart).includes(current)
    )
      return true;
    for (const neighbor of orthogonalNeighbors(current)) {
      if (!seen.has(neighbor) && cells[neighbor]?.habitat && healthyAt(cells, neighbor)) {
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return false;
}

export function createGameState(seed = 'worldseed-demo-001', demo = true): GameState {
  return {
    island: generateIsland(seed),
    // Guest mode follows the same small resource loop as a wallet island. The
    // guaranteed witness route and milestone rewards keep the puzzle solvable,
    // while gathering lets players recover from a mistaken placement.
    inventory: { water: 1, grass: 1, forest: 0 },
    unlockedThrough: 0,
    claimedRegions: ['clearing'],
    actionCount: 0,
    complete: false,
    history: [],
    demo,
  };
}

function copyInventory(inventory: Inventory): Inventory {
  return { ...inventory };
}

function checkpoint(state: GameState): GameState['history'][number] {
  return {
    cells: state.island.cells.map((cell) => ({ ...cell })),
    inventory: copyInventory(state.inventory),
    unlockedThrough: state.unlockedThrough,
    claimedRegions: [...state.claimedRegions],
  };
}

function addReward(inventory: Inventory, region: RegionId): Inventory {
  const reward = REWARDS[region];
  return {
    water: inventory.water + (reward.water ?? 0),
    grass: inventory.grass + (reward.grass ?? 0),
    forest: inventory.forest + (reward.forest ?? 0),
  };
}

export function applyAction(
  state: GameState,
  action: Exclude<import('./types').GameAction, { type: 'undo' | 'reset' }>,
): { state: GameState; events: GameEvent[]; error?: string } {
  const cell = state.island.cells[action.index];
  if (!cell) return { state, events: [], error: 'That tile is outside the island.' };
  const maxAccessible = state.unlockedThrough;
  if (regionIndex(cell.region) > maxAccessible)
    return { state, events: [], error: 'That region is still covered by mist.' };
  const previous = checkpoint(state);
  let cells = state.island.cells.map((candidate) => ({ ...candidate }));
  let inventory = copyInventory(state.inventory);
  const events: GameEvent[] = [];

  if (action.type === 'place') {
    if (!cell.placeable) return { state, events, error: 'That tile cannot hold a habitat.' };
    if (cell.habitat)
      return { state, events, error: 'Remove the existing habitat before placing another.' };
    if (inventory[action.habitat] <= 0)
      return { state, events, error: `No ${action.habitat} left in your pouch.` };
    cells[action.index] = { ...cells[action.index]!, habitat: action.habitat };
    inventory[action.habitat] -= 1;
    events.push({ kind: 'placed', message: `${capitalize(action.habitat)} placed.` });
  } else {
    if (!cell.habitat) return { state, events, error: 'There is no habitat to gather here.' };
    inventory[cell.habitat] += 1;
    cells[action.index] = { ...cells[action.index]!, habitat: null };
    events.push({
      kind: 'removed',
      message: `${capitalize(cell.habitat)} returned to your pouch.`,
    });
  }

  let unlockedThrough = state.unlockedThrough;
  let claimedRegions = [...state.claimedRegions];
  while (unlockedThrough < REGIONS.length - 1) {
    const nextIndex = unlockedThrough + 1;
    const nextRegion = REGIONS[nextIndex]!;
    if (healthyCount(cells, unlockedThrough) < nextRegion.unlockAt) break;
    unlockedThrough = nextIndex;
    claimedRegions.push(nextRegion.id);
    inventory = addReward(inventory, nextRegion.id);
    events.push({
      kind: 'region-unlocked',
      region: nextRegion.id,
      message: `${nextRegion.name} restored. New resources gathered.`,
    });
  }

  const complete = isHeartComplete(cells, unlockedThrough);
  if (complete && !state.complete)
    events.push({
      kind: 'island-complete',
      message: 'The Island Heart is whole. Your island is restored!',
    });
  return {
    state: {
      ...state,
      island: { ...state.island, cells },
      inventory,
      unlockedThrough,
      claimedRegions,
      actionCount: state.actionCount + 1,
      complete,
      history: [...state.history, previous].slice(-50),
    },
    events,
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
