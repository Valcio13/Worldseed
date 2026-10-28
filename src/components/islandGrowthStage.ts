import { totalHabitatLevels, type EconomyState } from '../incremental/engine';

export type IslandGrowthStage = 'seed' | 'sprout' | 'growing' | 'flourishing';

const STAGE_TARGETS: Record<IslandGrowthStage, number> = {
  seed: 1,
  sprout: 5,
  growing: 15,
  flourishing: 15,
};
const NEXT_STAGE_LABEL: Record<IslandGrowthStage, string> = {
  seed: 'Sprout',
  sprout: 'Growing',
  growing: 'Flourishing',
  flourishing: 'Flourishing',
};

export function islandGrowthStageForHabitatCount(habitats: number): IslandGrowthStage {
  if (habitats >= STAGE_TARGETS.growing) return 'flourishing';
  if (habitats >= STAGE_TARGETS.sprout) return 'growing';
  if (habitats >= STAGE_TARGETS.seed) return 'sprout';
  return 'seed';
}

export function islandGrowthStageProgressForHabitatCount(total: number) {
  const stage = islandGrowthStageForHabitatCount(total);
  const target = STAGE_TARGETS[stage];
  return {
    total: Math.min(total, target),
    target,
    next: NEXT_STAGE_LABEL[stage],
    progress: stage === 'flourishing' ? 100 : Math.min(100, Math.round((total / target) * 100)),
  };
}

/** Visual thresholds reuse the existing habitat milestones and do not affect the economy. */
export function islandGrowthStage(state: EconomyState): IslandGrowthStage {
  return islandGrowthStageForHabitatCount(totalHabitatLevels(state));
}

/** Display-only progress toward the next existing visual growth threshold. */
export function islandGrowthStageProgress(state: EconomyState) {
  return islandGrowthStageProgressForHabitatCount(totalHabitatLevels(state));
}
