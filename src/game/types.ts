export const GENERATOR_VERSION = 1 as const;
export const BOARD_SIZE = 7 as const;

export const REGIONS = [
  { id: 'clearing', name: 'Clearing', unlockAt: 0, color: 'moss' },
  { id: 'dry-basin', name: 'Dry Basin', unlockAt: 2, color: 'sand' },
  { id: 'forgotten-grove', name: 'Forgotten Grove', unlockAt: 4, color: 'fern' },
  { id: 'broken-highlands', name: 'Broken Highlands', unlockAt: 7, color: 'stone' },
  { id: 'island-heart', name: 'Island Heart', unlockAt: 10, color: 'heart' },
] as const;

export type RegionId = (typeof REGIONS)[number]['id'];
export type Habitat = 'water' | 'grass' | 'forest';
export type Terrain = 'meadow' | 'shore' | 'rock' | 'heart';

export interface Cell {
  x: number;
  y: number;
  region: RegionId;
  terrain: Terrain;
  habitat: Habitat | null;
  placeable: boolean;
  witnessCell: boolean;
}

export interface Island {
  seed: string;
  generatorVersion: typeof GENERATOR_VERSION;
  cells: Cell[];
  heartIndex: number;
}

export interface Inventory {
  water: number;
  grass: number;
  forest: number;
}

export interface GameState {
  island: Island;
  inventory: Inventory;
  unlockedThrough: number;
  claimedRegions: RegionId[];
  actionCount: number;
  complete: boolean;
  history: Array<{
    cells: Cell[];
    inventory: Inventory;
    unlockedThrough: number;
    claimedRegions: RegionId[];
  }>;
  demo: boolean;
}

export interface GameEvent {
  kind: 'placed' | 'removed' | 'region-unlocked' | 'island-complete';
  message: string;
  region?: RegionId;
}

export type GameAction =
  | { type: 'place'; index: number; habitat: Habitat }
  | { type: 'remove'; index: number }
  | { type: 'undo' }
  | { type: 'reset'; seed?: string };

export const STARTER_INVENTORY: Inventory = { water: 1, grass: 1, forest: 0 };
export const DEMO_INVENTORY: Inventory = { water: 20, grass: 20, forest: 20 };
export const REWARDS: Record<RegionId, Partial<Inventory>> = {
  clearing: {},
  'dry-basin': { water: 1, grass: 2 },
  'forgotten-grove': { forest: 2, grass: 1 },
  'broken-highlands': { water: 1, grass: 2 },
  'island-heart': { water: 1, forest: 1 },
};
