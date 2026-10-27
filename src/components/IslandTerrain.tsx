import type { Cell } from '../game/types';
import { IslandCanvas } from './IslandCanvas';

/** Compatibility wrapper retained while the Canvas renderer becomes the island visual layer. */
export function IslandTerrain(props: {
  cells: Cell[];
  seed: string;
  unlockedThrough: number;
  complete: boolean;
}) {
  return <IslandCanvas {...props} />;
}
