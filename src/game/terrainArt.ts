import type { Habitat, Terrain } from './types';

export type TerrainLayer = 'grass' | 'water' | 'forest' | 'damaged' | 'heart';

export function terrainLayerForCell(terrain: Terrain, habitat: Habitat | null): TerrainLayer {
  if (terrain === 'heart') return 'heart';
  if (habitat === 'water') return 'water';
  if (habitat === 'grass') return 'grass';
  if (habitat === 'forest') return 'forest';
  if (terrain === 'shore') return 'water';
  if (terrain === 'rock') return 'damaged';
  return 'grass';
}

/** Stable visual variation from the generated island seed and board coordinates. */
export function cosmeticTileVariant(seed: string, x: number, y: number): number {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ x, 16777619);
  hash = Math.imul(hash ^ y, 16777619);
  return (hash >>> 0) % 3;
}
