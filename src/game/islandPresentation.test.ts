import { describe, expect, it } from 'vitest';
import { generateIsland } from './generateIsland';
import {
  characterPresentationClasses,
  clampCameraOffset,
  logicalTileAtPoint,
  residentsNearCell,
  stepResident,
  visibleResidents,
} from './islandPresentation';

describe('island presentation helpers', () => {
  it('selects idle and walking sprite states and keeps horizontal facing', () => {
    expect(characterPresentationClasses('tavi', false, false)).toEqual([
      'resident--tavi',
      'resident--idle',
    ]);
    expect(characterPresentationClasses('tavi', true, true)).toEqual([
      'resident--tavi',
      'resident--walking',
      'resident--facing-left',
    ]);
  });

  it('maps pointer coordinates to the same logical tile at different zoom levels', () => {
    const unzoomed = { left: 100, top: 50, width: 700, height: 700 };
    const zoomed = { left: 20, top: 10, width: 1050, height: 1050 };
    expect(logicalTileAtPoint(350, 300, unzoomed)).toBe(16);
    expect(logicalTileAtPoint(395, 385, zoomed)).toBe(16);
    expect(logicalTileAtPoint(99, 200, unzoomed)).toBeNull();
  });

  it('keeps camera movement centered and bounded by the zoom overflow', () => {
    expect(clampCameraOffset(200, 700, 1.2)).toBeCloseTo(70);
    expect(clampCameraOffset(-200, 700, 1.2)).toBeCloseTo(-70);
    expect(clampCameraOffset(20, 700, 0.8)).toBe(0);
  });

  it('reveals a gentle population as healthy habitats and forests grow', () => {
    expect(visibleResidents(0, 0).map(({ id }) => id)).toEqual(['pip']);
    expect(visibleResidents(2, 0).map(({ id }) => id)).toContain('pip');
    expect(visibleResidents(4, 1).map(({ id }) => id)).toEqual(
      expect.arrayContaining(['pip', 'moss', 'tavi', 'luma']),
    );
    expect(visibleResidents(12, 3).map(({ id }) => id)).toEqual(
      expect.arrayContaining(['rowan', 'pip', 'moss', 'tavi', 'luma']),
    );
  });

  it('selects only neighbors for a restoration reaction', () => {
    const residents = [
      { id: 'near', name: 'Near', kind: 'animal' as const, x: 2, y: 2 },
      { id: 'diagonal', name: 'Diagonal', kind: 'villager' as const, x: 3, y: 3 },
      { id: 'far', name: 'Far', kind: 'spirit' as const, x: 5, y: 5 },
    ];
    expect(residentsNearCell(residents, 2 * 7 + 3).map(({ id }) => id)).toEqual([
      'near',
      'diagonal',
    ]);
    expect(residentsNearCell(residents, -1)).toEqual([]);
  });

  it('moves inhabitants one safe step without crossing water or rock obstacles', () => {
    const cells = generateIsland('inhabitants').cells;
    const resident = { id: 'test', name: 'Test', kind: 'animal' as const, x: 1, y: 1 };
    cells[1 * 7 + 2]!.habitat = 'water';
    const stepped = stepResident(resident, cells, 4, () => 0.99);
    expect(Math.abs(stepped.x - resident.x) + Math.abs(stepped.y - resident.y)).toBeLessThanOrEqual(
      1,
    );
    expect(cells[stepped.y * 7 + stepped.x]?.habitat).not.toBe('water');
    expect(['rock', 'shore', 'heart']).not.toContain(cells[stepped.y * 7 + stepped.x]?.terrain);
  });

  it('never moves residents into hidden regions', () => {
    const cells = generateIsland('inhabitants-locked').cells;
    const resident = { id: 'test', name: 'Test', kind: 'animal' as const, x: 1, y: 1 };
    const stepped = stepResident(resident, cells, 0, () => 0.99);
    expect(cells[stepped.y * 7 + stepped.x]?.region).toBe('clearing');
  });
});
