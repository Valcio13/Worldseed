import { REGIONS, type Cell } from './types';
import { cosmeticTileVariant, terrainLayerForCell } from './terrainArt';
import { gridToCanvas } from './canvasCoordinates';

export const RENDER_TILE_PIXELS = 64;
const BOARD_SIZE = 7;
export type SpriteMap = Map<string, HTMLImageElement>;

const PALETTE = {
  grass: ['#8fc879', '#94cc7b', '#89c273'],
  water: ['#62b8c0', '#68bec4', '#5eb2bc'],
  forest: ['#74ae70', '#79b274', '#70a86d'],
  damaged: ['#b99b6b', '#bda071', '#b39467'],
  heart: ['#8fc879', '#94cc7b', '#89c273'],
} as const;

function fillFallback(
  context: CanvasRenderingContext2D,
  cell: Cell,
  variant: number,
  complete: boolean,
) {
  const { x, y } = gridToCanvas(cell.x, cell.y, RENDER_TILE_PIXELS);
  const layer = terrainLayerForCell(cell.terrain, cell.habitat);
  const colorSet = PALETTE[layer];
  context.fillStyle = colorSet[variant % colorSet.length]!;
  context.fillRect(x, y, RENDER_TILE_PIXELS, RENDER_TILE_PIXELS);
  const s = RENDER_TILE_PIXELS / 16;
  if (layer === 'water') {
    context.fillStyle = '#b0e6d5';
    context.fillRect(x + 12 * s, y + 15 * s, 20 * s, 3 * s);
  } else if (layer === 'forest') {
    context.fillStyle = '#326d50';
    context.fillRect(x + 8 * s, y + 8 * s, 32 * s, 28 * s);
    context.fillStyle = '#79b875';
    context.fillRect(x + 20 * s, y + 5 * s, 18 * s, 14 * s);
  } else if (layer === 'damaged') {
    context.fillStyle = '#8b7656';
    context.fillRect(x + 8 * s, y + 44 * s, 8 * s, 4 * s);
    context.fillStyle = '#d2b47e';
    context.fillRect(x + 24 * s, y + 22 * s, 8 * s, 4 * s);
  } else if (cell.terrain === 'heart') {
    context.fillStyle = '#745640';
    context.fillRect(x + 28 * s, y + 32 * s, 8 * s, 20 * s);
    context.fillStyle = complete ? '#67a965' : '#a49267';
    context.fillRect(x + 20 * s, y + 16 * s, 24 * s, 20 * s);
    context.fillStyle = '#f6db86';
    context.fillRect(x + 28 * s, y + 8 * s, 8 * s, 8 * s);
  } else {
    context.fillStyle = '#4f9456';
    context.fillRect(x + 16 * s, y + 44 * s, 4 * s, 8 * s);
  }
}

function drawOcean(context: CanvasRenderingContext2D, size: number, tick: number) {
  context.fillStyle = '#62b8c0';
  context.fillRect(0, 0, size, size);
  context.fillStyle = 'rgba(192, 239, 218, 0.38)';
  for (let x = 12; x < size; x += 94) {
    const y = (tick * 3 + x * 2) % Math.max(1, size - 10);
    context.fillRect(x, y, 22, 3);
    context.fillRect(x + 11, y + 7, 13, 2);
  }
}

export function renderIsland(
  context: CanvasRenderingContext2D,
  cells: Cell[],
  seed: string,
  unlockedThrough: number,
  complete: boolean,
  sprites: SpriteMap,
  tick = 0,
) {
  const size = BOARD_SIZE * RENDER_TILE_PIXELS;
  context.save();
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, size, size);
  drawOcean(context, size, tick);
  cells.forEach((cell) => {
    const variant = cosmeticTileVariant(seed, cell.x, cell.y);
    const layer = terrainLayerForCell(cell.terrain, cell.habitat);
    const spriteLayer = cell.terrain === 'shore' ? 'shore' : layer;
    const { x, y } = gridToCanvas(cell.x, cell.y, RENDER_TILE_PIXELS);
    const sprite = sprites.get(`terrain.${spriteLayer}.${spriteLayer === 'heart' ? 0 : variant}`);
    if (sprite) context.drawImage(sprite, x, y, RENDER_TILE_PIXELS, RENDER_TILE_PIXELS);
    else fillFallback(context, cell, variant, complete);

    if (layer === 'water') {
      const neighbor = (dx: number, dy: number) =>
        cells.find((candidate) => candidate.x === cell.x + dx && candidate.y === cell.y + dy);
      const needsFoam = (dx: number, dy: number) => {
        const adjacent = neighbor(dx, dy);
        return !adjacent || terrainLayerForCell(adjacent.terrain, adjacent.habitat) !== 'water';
      };
      const foam = (direction: string) => {
        const overlay = sprites.get(`overlay.foam.${direction}`);
        if (overlay) context.drawImage(overlay, x, y, RENDER_TILE_PIXELS, RENDER_TILE_PIXELS);
      };
      if (needsFoam(0, -1)) foam('north');
      if (needsFoam(1, 0)) foam('east');
      if (needsFoam(0, 1)) foam('south');
      if (needsFoam(-1, 0)) foam('west');
    }

    if (REGIONS.findIndex((region) => region.id === cell.region) > unlockedThrough) {
      context.fillStyle = 'rgba(236, 239, 208, 0.25)';
      context.fillRect(x, y, RENDER_TILE_PIXELS - 2, RENDER_TILE_PIXELS - 2);
    }
  });
  context.restore();
}
