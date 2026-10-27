import { useEffect, useRef } from 'react';
import { loadSprites } from '../game/spriteLoader';
import { renderIsland, type SpriteMap } from '../game/renderIsland';
import type { Cell } from '../game/types';

const SPRITE_PATHS: Record<string, string> = Object.fromEntries(
  [
    'barren_0',
    'barren_1',
    'barren_2',
    'grass_0',
    'grass_1',
    'grass_2',
    'forest_0',
    'forest_1',
    'forest_2',
    'water_0',
    'water_1',
    'water_2',
    'shore_0',
    'shore_1',
    'shore_2',
  ]
    .map((name) => {
      const [layer, variant] = name.split('_');
      return [`terrain.${layer}.${variant}`, `/assets/pixel-fantasy/terrain/${name}.png`];
    })
    .concat([
      ['terrain.heart.0', '/assets/pixel-fantasy/terrain/heart_0.png'],
      ['overlay.foam.north', '/assets/pixel-fantasy/terrain/foam_north.png'],
      ['overlay.foam.south', '/assets/pixel-fantasy/terrain/foam_south.png'],
      ['overlay.foam.east', '/assets/pixel-fantasy/terrain/foam_east.png'],
      ['overlay.foam.west', '/assets/pixel-fantasy/terrain/foam_west.png'],
    ]),
) as Record<string, string>;

export function IslandCanvas({
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
  const spritesRef = useRef<SpriteMap>(new Map());

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const logicalSize = 7 * 64;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = logicalSize * dpr;
    canvas.height = logicalSize * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    let tick = 0;
    let frame = 0;
    let cancelled = false;
    const draw = () =>
      renderIsland(context, cells, seed, unlockedThrough, complete, spritesRef.current, tick);
    draw();
    void loadSprites(SPRITE_PATHS).then((sprites) => {
      if (!cancelled) {
        spritesRef.current = sprites;
        draw();
      }
    });
    const animate = () => {
      if (!cancelled && document.visibilityState !== 'hidden') {
        tick = (tick + 1) % 60;
        draw();
      }
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [cells, seed, unlockedThrough, complete]);

  return <canvas ref={canvasRef} className="island-terrain" aria-hidden="true" />;
}
