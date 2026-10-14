import { describe, expect, it } from 'vitest';
import { cosmeticTileVariant, terrainLayerForCell } from './terrainArt';

describe('pixel terrain rendering metadata', () => {
  it('maps damaged ground, shoreline, habitats, and the heart to readable art layers', () => {
    expect(terrainLayerForCell('meadow', null)).toBe('grass');
    expect(terrainLayerForCell('shore', null)).toBe('water');
    expect(terrainLayerForCell('rock', null)).toBe('damaged');
    expect(terrainLayerForCell('meadow', 'water')).toBe('water');
    expect(terrainLayerForCell('meadow', 'grass')).toBe('grass');
    expect(terrainLayerForCell('meadow', 'forest')).toBe('forest');
    expect(terrainLayerForCell('heart', null)).toBe('heart');
  });

  it('keeps cosmetic tile variations stable for a seed and coordinate', () => {
    expect(cosmeticTileVariant('island-123', 3, 4)).toBe(cosmeticTileVariant('island-123', 3, 4));
    expect(cosmeticTileVariant('island-123', 3, 4)).not.toBe(
      cosmeticTileVariant('different-seed', 3, 4),
    );
    expect([0, 1, 2]).toContain(cosmeticTileVariant('island-123', 6, 6));
  });
});
