import {
  BOARD_SIZE,
  GENERATOR_VERSION,
  REGIONS,
  type Cell,
  type Island,
  type RegionId,
} from './types';

const regionAt = (x: number): RegionId => {
  if (x <= 1) return 'clearing';
  if (x === 2) return 'dry-basin';
  if (x === 3) return 'forgotten-grove';
  if (x <= 5) return 'broken-highlands';
  return 'island-heart';
};

// Reserved cells form a fixed completion witness. Visual variation is confined to
// cells outside this set, so every seed preserves the same legal solo route.
export const WITNESS = [
  { type: 'place', x: 1, y: 1, habitat: 'water' },
  { type: 'place', x: 1, y: 2, habitat: 'grass' },
  { type: 'place', x: 2, y: 1, habitat: 'water' },
  { type: 'place', x: 2, y: 0, habitat: 'grass' },
  { type: 'place', x: 2, y: 2, habitat: 'forest' },
  { type: 'place', x: 1, y: 0, habitat: 'forest' },
  { type: 'place', x: 0, y: 1, habitat: 'grass' },
  { type: 'place', x: 4, y: 1, habitat: 'water' },
  { type: 'place', x: 4, y: 0, habitat: 'grass' },
  { type: 'place', x: 4, y: 2, habitat: 'grass' },
  { type: 'remove', x: 4, y: 2 },
  { type: 'remove', x: 4, y: 1 },
  { type: 'place', x: 4, y: 2, habitat: 'water' },
  { type: 'place', x: 5, y: 2, habitat: 'water' },
  { type: 'place', x: 4, y: 3, habitat: 'grass' },
  { type: 'place', x: 5, y: 3, habitat: 'forest' },
  { type: 'place', x: 5, y: 1, habitat: 'grass' },
] as const;

const witnessIndices = new Set(WITNESS.map(({ x, y }) => y * BOARD_SIZE + x));
const heartIndex = 3 * BOARD_SIZE + 6;

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

function nextRandom(state: { value: number }): number {
  let x = state.value;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.value = x >>> 0 || 1;
  return state.value / 0x1_0000_0000;
}

export function generateIsland(seed: string): Island {
  const random = { value: hashSeed(seed) };
  const cells: Cell[] = [];

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const index = y * BOARD_SIZE + x;
      const isHeart = index === heartIndex;
      const isWitness = witnessIndices.has(index);
      const isEdge = x === 0 || y === 0 || x === BOARD_SIZE - 1 || y === BOARD_SIZE - 1;
      const randomRock =
        !isWitness && x === 6 && y > 0 && y < BOARD_SIZE - 1 && nextRandom(random) < 0.24;
      const terrain = isHeart
        ? 'heart'
        : isEdge && !isWitness
          ? 'shore'
          : randomRock
            ? 'rock'
            : 'meadow';
      const placeable = x < 6 && (!isEdge || isWitness);
      cells.push({
        x,
        y,
        region: regionAt(x),
        terrain,
        habitat: null,
        placeable,
        witnessCell: isWitness,
      });
    }
  }

  return { seed, generatorVersion: GENERATOR_VERSION, cells, heartIndex };
}

export function regionIndex(region: RegionId): number {
  return REGIONS.findIndex((candidate) => candidate.id === region);
}
