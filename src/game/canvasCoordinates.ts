export const BOARD_SIZE = 7;

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function gridToCanvas(column: number, row: number, tilePixels: number): CanvasPoint {
  return { x: column * tilePixels, y: row * tilePixels };
}

export function canvasToGrid(
  clientX: number,
  clientY: number,
  bounds: CanvasBounds,
  size = BOARD_SIZE,
): number | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const column = Math.floor(((clientX - bounds.left) / bounds.width) * size);
  const row = Math.floor(((clientY - bounds.top) / bounds.height) * size);
  if (column < 0 || column >= size || row < 0 || row >= size) return null;
  return row * size + column;
}

export function isGridPoint(column: number, row: number, size = BOARD_SIZE): boolean {
  return column >= 0 && column < size && row >= 0 && row < size;
}
