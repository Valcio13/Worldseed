import { useEffect, useRef } from 'react';
import { REGIONS, type Cell } from '../game/types';
import { cosmeticTileVariant, terrainLayerForCell } from '../game/terrainArt';

const CELL_PIXELS = 16;
const BOARD_SIZE = 7;
const PALETTE = {
  grass: ['#8fc879', '#94cc7b', '#89c273'],
  water: ['#62b8c0', '#68bec4', '#5eb2bc'],
  forest: ['#74ae70', '#79b274', '#70a86d'],
  damaged: ['#b99b6b', '#bda071', '#b39467'],
  heart: ['#8fc879', '#94cc7b', '#89c273'],
};

type PixelContext = CanvasRenderingContext2D;

function pixel(context: PixelContext, x: number, y: number, color: string, width = 1, height = 1) {
  context.fillStyle = color;
  context.fillRect(x, y, width, height);
}

function drawFlower(context: PixelContext, x: number, y: number, variant: number) {
  const petal = variant % 2 ? '#fff0a8' : '#fff4d0';
  pixel(context, x, y + 1, '#4e8c53', 1, 3);
  pixel(context, x - 1, y, petal);
  pixel(context, x + 1, y, petal);
  pixel(context, x, y - 1, petal);
  pixel(context, x, y, variant % 3 ? '#e99c70' : '#f0bf58');
}

function drawTree(context: PixelContext, x: number, y: number, variant: number) {
  const shade = variant % 2 ? '#387452' : '#326d50';
  const light = variant % 2 ? '#70ad6e' : '#79b875';
  pixel(context, x + 3, y + 7, '#795b43', 2, 4);
  pixel(context, x + 2, y + 5, '#477f54', 4, 2);
  pixel(context, x + 1, y + 3, shade, 6, 3);
  pixel(context, x + 2, y + 2, shade, 4, 4);
  pixel(context, x + 3, y + 1, light, 3, 2);
  pixel(context, x + 2, y + 3, light, 2, 2);
}

function drawHeartTree(context: PixelContext, x: number, y: number, restored: boolean) {
  const canopy = restored ? '#67a965' : '#a49267';
  const glow = restored ? '#f6db86' : '#e0c780';
  pixel(context, x + 7, y + 8, '#745640', 2, 5);
  pixel(context, x + 5, y + 6, canopy, 6, 3);
  pixel(context, x + 4, y + 4, canopy, 8, 3);
  pixel(context, x + 6, y + 2, canopy, 4, 3);
  pixel(context, x + 7, y + 1, glow, 2, 2);
  if (restored) pixel(context, x + 3, y + 5, '#f8e8aa');
}

function drawCell(
  context: PixelContext,
  cells: Cell[],
  index: number,
  seed: string,
  ripple: number,
  complete: boolean,
) {
  const cell = cells[index];
  if (!cell) return;
  const x = cell.x * CELL_PIXELS;
  const y = cell.y * CELL_PIXELS;
  const variant = cosmeticTileVariant(seed, cell.x, cell.y);
  const layer = terrainLayerForCell(cell.terrain, cell.habitat);
  const colorSet = PALETTE[layer];
  pixel(context, x, y, colorSet[variant % colorSet.length]!, CELL_PIXELS, CELL_PIXELS);

  // A quiet one-pixel seam keeps tile targeting legible while matching habitats flow together.
  pixel(context, x, y + CELL_PIXELS - 0.5, 'rgba(48, 91, 66, 0.13)', CELL_PIXELS, 0.5);
  pixel(context, x + CELL_PIXELS - 0.5, y, 'rgba(48, 91, 66, 0.13)', 0.5, CELL_PIXELS);

  if (layer === 'water') {
    const offset = ripple % 5;
    pixel(context, x + 3 + offset, y + 4, '#b0e6d5', 5, 1);
    pixel(context, x + 6 - offset, y + 10, '#3c9ca9', 4, 1);
    pixel(context, x + 2, y + 13, '#86d2cb', 3, 1);
  } else if (layer === 'forest') {
    pixel(context, x + 2, y + 12, '#4d8958', 11, 2);
    drawTree(context, x + 1, y + 2, variant);
    if (variant % 3 !== 0) drawTree(context, x + 8, y + 5, variant + 1);
  } else if (layer === 'damaged') {
    pixel(context, x + 3, y + 4, '#c9aa78', 3, 2);
    pixel(context, x + 10, y + 9, '#887653', 2, 1);
    pixel(context, x + 6, y + 12, '#d5b780', 2, 1);
    if (variant === 0) pixel(context, x + 12, y + 3, '#759a5e', 1, 2);
  } else if (cell.terrain === 'heart') {
    drawHeartTree(context, x, y, complete);
  } else if (cell.habitat === 'grass') {
    drawFlower(context, x + 7, y + 7, variant);
    pixel(context, x + 3, y + 12, '#4f9456', 1, 2);
    pixel(context, x + 4, y + 11, '#67a95f', 1, 2);
  } else {
    // Natural grass is quiet; fixed coordinate noise keeps the base from appearing tiled.
    if (variant === 1) drawFlower(context, x + 12, y + 10, variant);
    pixel(context, x + 3 + (variant % 4), y + 5, '#75b66b', 1, 2);
    pixel(context, x + 4 + (variant % 4), y + 4, '#78ba70', 1, 2);
  }
}

function drawIsland(
  context: PixelContext,
  cells: Cell[],
  seed: string,
  ripple: number,
  unlockedThrough: number,
  complete: boolean,
) {
  context.clearRect(0, 0, BOARD_SIZE * CELL_PIXELS, BOARD_SIZE * CELL_PIXELS);
  context.imageSmoothingEnabled = false;
  cells.forEach((cell, index) => {
    drawCell(context, cells, index, seed, ripple, complete);
    if (cell && cell.region && cell.region !== 'clearing') {
      // Locked land remains readable beneath the familiar, light mist treatment.
      if (REGIONS.findIndex(({ id }) => id === cell.region) > unlockedThrough) {
        pixel(
          context,
          cell.x * CELL_PIXELS,
          cell.y * CELL_PIXELS,
          'rgba(236, 239, 208, 0.25)',
          CELL_PIXELS - 0.5,
          CELL_PIXELS - 0.5,
        );
      }
    }
  });
}

export function IslandTerrain({
  cells,
  seed,
  unlockedThrough,
  complete,
}: {
  cells: Cell[];
  seed: string;
  unlockedThrough: number;
  complete: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window.CanvasRenderingContext2D === 'undefined') return;
    const context = canvas.getContext('2d');
    if (!context) return;
    canvas.width = BOARD_SIZE * CELL_PIXELS * 2;
    canvas.height = BOARD_SIZE * CELL_PIXELS * 2;
    context.scale(2, 2);
    let ripple = 0;
    const render = () => drawIsland(context, cells, seed, ripple, unlockedThrough, complete);
    render();
    const animation = window.setInterval(() => {
      ripple = (ripple + 1) % 5;
      render();
    }, 720);
    return () => window.clearInterval(animation);
  }, [cells, seed, unlockedThrough, complete]);

  return <canvas ref={canvasRef} className="island-terrain" aria-hidden="true" />;
}
