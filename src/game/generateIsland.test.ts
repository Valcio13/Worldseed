import { describe, expect, it } from 'vitest';
import { generateIsland, generateIslandV2 } from './generateIsland';

describe('candidate island generator v2', () => {
  it('produces stable, transaction-seed-specific terrain without changing the puzzle mask', () => {
    const firstSeed = `0x${'11'.repeat(32)}`;
    const secondSeed = `0x${'22'.repeat(32)}`;
    const first = generateIslandV2(firstSeed);
    expect(generateIslandV2(firstSeed)).toEqual(first);
    expect(first.generatorVersion).toBe(2);
    const second = generateIslandV2(secondSeed);
    expect(first.cells.map(({ terrain }) => terrain)).not.toEqual(
      second.cells.map(({ terrain }) => terrain),
    );

    const v1 = generateIsland(firstSeed);
    expect(first.cells.map(({ placeable }) => placeable)).toEqual(
      v1.cells.map(({ placeable }) => placeable),
    );
    expect(first.cells.map(({ witnessCell }) => witnessCell)).toEqual(
      v1.cells.map(({ witnessCell }) => witnessCell),
    );
    expect(
      first.cells
        .filter(({ witnessCell }) => witnessCell)
        .every(({ terrain }) => terrain === 'meadow'),
    ).toBe(true);
  });
});
