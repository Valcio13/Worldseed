import { generateIslandV2 } from '../game/generateIsland';
import type { IslandCandidate } from './model';

export function getCandidatePreview(candidate: IslandCandidate) {
  const island = generateIslandV2(candidate.seed);
  return {
    seed: island.seed,
    generatorVersion: island.generatorVersion,
    cells: island.cells.map(({ terrain, placeable, witnessCell }) => ({
      terrain,
      placeable,
      witnessCell,
    })),
  };
}
