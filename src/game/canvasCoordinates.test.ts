import { describe, expect, it } from 'vitest';
import { canvasToGrid, gridToCanvas, isGridPoint } from './canvasCoordinates';

describe('canvas coordinate mapping', () => {
  it('maps a grid cell to logical canvas pixels', () => {
    expect(gridToCanvas(3, 4, 64)).toEqual({ x: 192, y: 256 });
  });

  it('maps pointer coordinates back to the seven by seven grid', () => {
    expect(canvasToGrid(250, 280, { left: 10, top: 20, width: 448, height: 448 })).toBe(31);
  });

  it('rejects clicks outside the canvas grid', () => {
    const bounds = { left: 10, top: 20, width: 448, height: 448 };
    expect(canvasToGrid(9, 20, bounds)).toBeNull();
    expect(canvasToGrid(458, 20, bounds)).toBeNull();
  });

  it('validates grid points without creating decorative cells', () => {
    expect(isGridPoint(0, 0)).toBe(true);
    expect(isGridPoint(6, 6)).toBe(true);
    expect(isGridPoint(7, 6)).toBe(false);
  });
});
