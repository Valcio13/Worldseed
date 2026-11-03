/**
 * Reproducible, isolated simulation of the canonical V3 rules and contract reward config.
 * Run with: npx tsx investigations/economy/verifiedEconomyBalanceInvestigation.ts
 * This file does not change the canonical rules or contract.
 */
import * as rulesV1 from '../../src/incremental/rulesV1';
import * as rulesV2 from '../../src/incremental/rulesV2';

type Rules = typeof rulesV2;
type CanonicalState = rulesV2.CanonicalRunState;
type Strategy = 'active' | 'balanced' | 'mostly-passive';
type Threshold = { name: string; tier: number };

const NATURE_SCALE = rulesV2.NATURE_SCALE;
const SEASON_PP_CAP = 100_000n;
const SEASON_CP_CAP = 100_000n;
const GLOBAL_SEASON_CP_CAP = 1_000_000n;
const PP_BASE = 1;
const PP_STEP = 10;
const PP_REBIRTH_CAP = 1_000;
const CP_BASE = 1;
const CP_STEP = 25;
const CP_REBIRTH_CAP = 1_000;
// Canonical rules expire runs at a weekly season boundary. End 10 minutes before it
// so even the passive strategy can be sampled without crossing into a new season.
const MAX_SECONDS = 7 * 24 * 60 * 60 - 10 * 60;
const SNAPSHOTS = [2 * 60 * 60, 24 * 60 * 60, MAX_SECONDS] as const;
const MIN_RUN_AGES = [0, 5 * 60, 10 * 60] as const;

const STRATEGY_CONFIG: Record<Strategy, { clickBatch: number; intervalSeconds: number }> = {
  active: { clickBatch: 50, intervalSeconds: 10 },
  balanced: { clickBatch: 10, intervalSeconds: 10 },
  'mostly-passive': { clickBatch: 1, intervalSeconds: 10 * 60 },
};

const HABITATS_BY_VERSION = {
  1: ['water', 'grass', 'forest'] as const,
  2: [...rulesV2.HABITATS],
};

interface SimulationSnapshot {
  atSeconds: number;
  rebirths: number;
  firstRebirthAtSeconds: number | null;
  lastRebirthTimesSeconds: number[];
  lastRebirthIntervalsSeconds: number[];
  totalPPEarned: number;
  seasonalPPBalance: number;
  growthLevelsPurchased: number;
  currentGrowthLevel: number;
  currentTier: number;
  currentHabitats: Record<string, number>;
  peakHabitatLevels: Record<string, number>;
  totalMilestoneUpgradesPurchased: number;
  peakMilestonesByHabitat: Record<string, number>;
  highestSinglePPReward: number;
  highestSingleCPReward: number;
  seasonalCP: number;
  stoppedAtSeasonCap: boolean;
  gateBlockedPulses: number;
  gateBlockedSeconds: number;
  firstEligibleAtSeconds: number | null;
  firstMilestoneAtSeconds: number | null;
}

function selectRules(version: 1 | 2): Rules {
  return (version === 1 ? rulesV1 : rulesV2) as unknown as Rules;
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

/** Exact arithmetic equivalent of N same-timestamp heart-click commands. */
function advanceAndClickBatch(
  rules: Rules,
  before: CanonicalState,
  serverTimeMs: number,
  clicks: number,
): CanonicalState {
  const advanced = rules.advanceCanonicalRun(before, serverTimeMs);
  if (clicks === 0) return advanced;
  const generated = BigInt(clicks) * NATURE_SCALE;
  const credited = min(generated, rules.MAX_NATURE_ATOMS - advanced.natureAtoms);
  const earned = min(credited, rules.MAX_NATURE_ATOMS - advanced.earnedNatureAtoms);
  return {
    ...advanced,
    natureAtoms: advanced.natureAtoms + credited,
    earnedNatureAtoms: advanced.earnedNatureAtoms + earned,
    sequence: advanced.sequence + clicks,
  };
}

function applyContractReward(tier: number, threshold: number) {
  const delta = Math.max(0, tier - threshold);
  return {
    pp: Math.min(PP_REBIRTH_CAP, PP_BASE + Math.floor(delta / PP_STEP)),
    cp: Math.min(CP_REBIRTH_CAP, CP_BASE + Math.floor(delta / CP_STEP)),
  };
}

function chooseGrowthQuantity(rules: Rules, currentLevel: number, availablePP: bigint): number {
  let quantity = 0;
  for (let candidate = 1; candidate <= rules.MAX_UPGRADE_LEVEL - currentLevel; candidate += 1) {
    if (rules.ppUpgradeCost(currentLevel, candidate) > availablePP) break;
    quantity = candidate;
  }
  return quantity;
}

function startNextRun(
  rules: Rules,
  version: 1 | 2,
  prior: CanonicalState,
  startTimeMs: number,
  seasonalPP: bigint,
): { state: CanonicalState; ppSpent: bigint; growthPurchased: number } {
  const growthLevel = prior.upgrades.growth;
  const quantity = chooseGrowthQuantity(rules, growthLevel, seasonalPP);
  const choices = quantity > 0 ? [{ upgradeId: 'growth' as const, quantity }] : [];
  const ppSpent = quantity > 0 ? rules.ppUpgradeCost(growthLevel, quantity) : 0n;
  const next = rules.createCanonicalRun({
    runId: `sim-${version}-${startTimeMs}`,
    seasonId: prior.seasonId,
    startedAtMs: startTimeMs,
    seasonalPP,
    existingUpgrades: prior.upgrades,
    seasonRebirths: prior.seasonRebirths + 1,
    upgradeChoices: choices,
  });
  return { state: next, ppSpent, growthPurchased: quantity };
}

interface Candidate {
  state: CanonicalState;
  spend: bigint;
  rateGain: bigint;
}

function nextBestPurchase(rules: Rules, version: 1 | 2, state: CanonicalState): Candidate | null {
  const beforeRate = rules.productionPerSecondAtoms(state);
  let best: Candidate | null = null;
  const consider = (command: rulesV2.GameplayCommand) => {
    try {
      const result = rules.applyCanonicalCommand(state, command, state.lastServerTimeMs);
      const rateGain = rules.productionPerSecondAtoms(result.state) - beforeRate;
      if (result.spentAtoms <= 0n || rateGain <= 0n) return;
      if (!best || result.spentAtoms * best.rateGain < best.spend * rateGain)
        best = { state: result.state, spend: result.spentAtoms, rateGain };
    } catch {
      // The existing canonical rule function is the affordability and validity check.
    }
  };

  for (const habitat of HABITATS_BY_VERSION[version])
    consider({ type: 'buy-habitat', habitat, quantity: 1 });

  if (version === 2) {
    const milestoneCost = rules.habitatProductionUpgradeCost;
    const milestones = rules.HABITAT_UPGRADE_MILESTONES;
    for (const habitat of rules.HABITATS) {
      const purchased = state.habitatProductionUpgrades[habitat];
      const milestone = milestones[purchased.length];
      if (milestone !== undefined)
        consider({ type: 'buy-habitat-production-upgrade', habitat, milestone });
    }
    // Keep the module API touch explicit in case V2 later changes the purchase function.
    void milestoneCost;
  }
  return best;
}

function buyPaybackInvestments(
  rules: Rules,
  version: 1 | 2,
  state: CanonicalState,
): {
  state: CanonicalState;
  milestonePurchases: number;
  peakHabitatLevels: Record<string, number>;
} {
  const candidate = nextBestPurchase(rules, version, state);
  const next = candidate?.state ?? state;
  const milestonePurchases = Number(
    version === 2 &&
      candidate !== null &&
      candidate.state.habitatProductionUpgrades !== state.habitatProductionUpgrades,
  );
  const peakHabitatLevels: Record<string, number> = {};
  for (const habitat of HABITATS_BY_VERSION[version])
    peakHabitatLevels[habitat] = next.habitats[habitat];
  return { state: next, milestonePurchases, peakHabitatLevels };
}

function snapshot(
  state: CanonicalState,
  version: 1 | 2,
  atSeconds: number,
  rebirthTimes: number[],
  totalPPEarned: number,
  seasonalPP: bigint,
  growthLevelsPurchased: number,
  seasonalCP: number,
  highestPP: number,
  highestCP: number,
  milestonePurchases: number,
  peakHabitatLevels: Record<string, number>,
  peakMilestonesByHabitat: Record<string, number>,
  stoppedAtSeasonCap: boolean,
  gateBlockedPulses: number,
  gateBlockedSeconds: number,
  firstEligibleAtSeconds: number | null,
  firstMilestoneAtSeconds: number | null,
): SimulationSnapshot {
  const intervals = rebirthTimes.slice(1).map((second, index) => second - rebirthTimes[index]!);
  return {
    atSeconds,
    rebirths: rebirthTimes.length,
    firstRebirthAtSeconds: rebirthTimes[0] ?? null,
    lastRebirthTimesSeconds: rebirthTimes.slice(-5),
    lastRebirthIntervalsSeconds: intervals.slice(-5),
    totalPPEarned,
    seasonalPPBalance: Number(seasonalPP),
    growthLevelsPurchased,
    currentGrowthLevel: state.upgrades.growth,
    currentTier: rulesForVersion(version).scoreTierFromEarnedNature(state.earnedNatureAtoms),
    currentHabitats: Object.fromEntries(
      HABITATS_BY_VERSION[version].map((habitat) => [habitat, state.habitats[habitat]]),
    ),
    peakHabitatLevels,
    totalMilestoneUpgradesPurchased: milestonePurchases,
    peakMilestonesByHabitat,
    highestSinglePPReward: highestPP,
    highestSingleCPReward: highestCP,
    seasonalCP,
    stoppedAtSeasonCap,
    gateBlockedPulses,
    gateBlockedSeconds,
    firstEligibleAtSeconds,
    firstMilestoneAtSeconds,
  };
}

const RULE_CACHE: Record<1 | 2, Rules> = {
  1: selectRules(1),
  2: selectRules(2),
};
function rulesForVersion(version: 1 | 2): Rules {
  return RULE_CACHE[version];
}

function simulate(
  version: 1 | 2,
  threshold: Threshold,
  strategy: Strategy,
  minRunAgeSeconds: number,
): SimulationSnapshot[] {
  const rules = selectRules(version);
  const config = STRATEGY_CONFIG[strategy];
  const initialSeason = rules.seasonIdAtMilliseconds(Date.UTC(2026, 9, 26));
  const seasonStartSeconds =
    rules.SEASON_EPOCH_MONDAY_SECONDS + (initialSeason + 1) * rules.SEASON_LENGTH_SECONDS;
  const startMs = seasonStartSeconds * 1_000;
  const simulationEnd = MAX_SECONDS;
  const seasonId = rules.seasonIdAtMilliseconds(startMs);
  let state = rules.createCanonicalRun({
    runId: `sim-${version}-0`,
    seasonId,
    startedAtMs: startMs,
    seasonalPP: 0n,
    existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
    seasonRebirths: 0,
    upgradeChoices: [],
  });
  let seasonalPP = 0n;
  let seasonalCP = 0;
  let totalPPEarned = 0;
  let highestPP = 0;
  let highestCP = 0;
  let growthLevelsPurchased = 0;
  let milestonePurchases = 0;
  let peakHabitatLevels: Record<string, number> = {};
  const peakMilestonesByHabitat: Record<string, number> = {};
  let stoppedAtSeasonCap = false;
  let timeSeconds = 0;
  let runStartedAtSeconds = 0;
  let firstEligibleAtSeconds: number | null = null;
  let firstRunEligibleAtSeconds: number | null = null;
  let firstMilestoneAtSeconds: number | null = null;
  let gateBlockedPulses = 0;
  let gateBlockedSeconds = 0;
  const rebirthTimes: number[] = [];
  const captures: SimulationSnapshot[] = [];
  let nextSnapshot = 0;

  while (timeSeconds < simulationEnd && nextSnapshot < SNAPSHOTS.length) {
    timeSeconds = Math.min(simulationEnd, timeSeconds + config.intervalSeconds);
    const nowMs = startMs + timeSeconds * 1_000;
    state = advanceAndClickBatch(rules, state, nowMs, config.clickBatch);
    const purchases = buyPaybackInvestments(rules, version, state);
    state = purchases.state;
    milestonePurchases += purchases.milestonePurchases;
    if (purchases.milestonePurchases > 0 && firstMilestoneAtSeconds === null)
      firstMilestoneAtSeconds = timeSeconds;
    for (const [habitat, level] of Object.entries(purchases.peakHabitatLevels))
      peakHabitatLevels[habitat] = Math.max(peakHabitatLevels[habitat] ?? 0, level);
    if (version === 2) {
      for (const habitat of rules.HABITATS)
        peakMilestonesByHabitat[habitat] = Math.max(
          peakMilestonesByHabitat[habitat] ?? 0,
          state.habitatProductionUpgrades[habitat].length,
        );
    }

    const tier = rules.scoreTierFromEarnedNature(state.earnedNatureAtoms);
    if (tier >= threshold.tier && firstEligibleAtSeconds === null)
      firstEligibleAtSeconds = timeSeconds;
    if (tier >= threshold.tier && firstRunEligibleAtSeconds === null)
      firstRunEligibleAtSeconds = timeSeconds;
    const oldEnough = timeSeconds - runStartedAtSeconds >= minRunAgeSeconds;
    if (tier >= threshold.tier && !oldEnough) {
      gateBlockedPulses += 1;
      gateBlockedSeconds += config.intervalSeconds;
    }
    if (tier >= threshold.tier && oldEnough && !stoppedAtSeasonCap) {
      const reward = applyContractReward(tier, threshold.tier);
      if (
        seasonalPP + BigInt(reward.pp) > SEASON_PP_CAP ||
        seasonalCP + reward.cp > SEASON_CP_CAP ||
        seasonalCP + reward.cp > GLOBAL_SEASON_CP_CAP
      ) {
        stoppedAtSeasonCap = true;
      } else {
        seasonalPP += BigInt(reward.pp);
        seasonalCP += reward.cp;
        totalPPEarned += reward.pp;
        highestPP = Math.max(highestPP, reward.pp);
        highestCP = Math.max(highestCP, reward.cp);
        rebirthTimes.push(timeSeconds);
        const started = startNextRun(rules, version, state, nowMs, seasonalPP);
        state = started.state;
        runStartedAtSeconds = timeSeconds;
        firstEligibleAtSeconds = null;
        seasonalPP -= started.ppSpent;
        growthLevelsPurchased += started.growthPurchased;
      }
    }

    while (nextSnapshot < SNAPSHOTS.length && timeSeconds === SNAPSHOTS[nextSnapshot]) {
      captures.push(
        snapshot(
          state,
          version,
          timeSeconds,
          rebirthTimes,
          totalPPEarned,
          seasonalPP,
          growthLevelsPurchased,
          seasonalCP,
          highestPP,
          highestCP,
          milestonePurchases,
          { ...peakHabitatLevels },
          { ...peakMilestonesByHabitat },
          stoppedAtSeasonCap,
          gateBlockedPulses,
          gateBlockedSeconds,
          firstRunEligibleAtSeconds,
          firstMilestoneAtSeconds,
        ),
      );
      nextSnapshot += 1;
    }
  }

  return captures;
}

function checkSameTimestampClickBatch() {
  const rules = selectRules(1);
  const initialSeason = rules.seasonIdAtMilliseconds(Date.UTC(2026, 9, 26));
  const startMs =
    (rules.SEASON_EPOCH_MONDAY_SECONDS + (initialSeason + 1) * rules.SEASON_LENGTH_SECONDS) * 1_000;
  const seasonId = rules.seasonIdAtMilliseconds(startMs);
  const initial = rules.createCanonicalRun({
    runId: 'batch-equivalence',
    seasonId,
    startedAtMs: startMs,
    seasonalPP: 0n,
    existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
    seasonRebirths: 0,
    upgradeChoices: [],
  });
  let sequential = initial;
  for (let click = 0; click < 25; click += 1)
    sequential = rules.applyCanonicalCommand(
      sequential,
      { type: 'heart-click' },
      initial.lastServerTimeMs,
    ).state;
  const batched = advanceAndClickBatch(rules, initial, initial.lastServerTimeMs, 25);
  if (
    sequential.natureAtoms !== batched.natureAtoms ||
    sequential.earnedNatureAtoms !== batched.earnedNatureAtoms ||
    sequential.sequence !== batched.sequence
  )
    throw new Error('Batched click simulation diverged from canonical repeated commands.');

  for (const tier of [28, 35, 42, 84]) {
    const thresholdAtoms = 10n ** BigInt(tier / 7 + 12);
    if (
      rules.scoreTierFromEarnedNature(thresholdAtoms - 1n) !== tier - 1 ||
      rules.scoreTierFromEarnedNature(thresholdAtoms) !== tier
    )
      throw new Error(`Tier ${tier} Nature boundary is not exact.`);
  }
}

function main() {
  checkSameTimestampClickBatch();
  const configurations: Array<{ version: 1 | 2; threshold: Threshold }> = [
    { version: 1, threshold: { name: 'tier-35', tier: 35 } },
    { version: 2, threshold: { name: 'tier-42', tier: 42 } },
  ];
  const rows = [];
  for (const { version, threshold } of configurations) {
    for (const minRunAgeSeconds of MIN_RUN_AGES) {
      for (const strategy of Object.keys(STRATEGY_CONFIG) as Strategy[]) {
        rows.push({
          version,
          threshold: threshold.name,
          minRunAgeSeconds,
          strategy,
          snapshots: simulate(version, threshold, strategy, minRunAgeSeconds),
        });
      }
    }
  }
  for (const { version, threshold, minRunAgeSeconds, strategy, snapshots } of rows) {
    const compact = snapshots.map((result) => {
      const peakHabitatTotal = Object.values(result.peakHabitatLevels).reduce(
        (sum, level) => sum + level,
        0,
      );
      const peakMilestones = Object.values(result.peakMilestonesByHabitat).reduce(
        (sum, level) => sum + level,
        0,
      );
      return [
        result.atSeconds,
        result.firstRebirthAtSeconds,
        result.rebirths,
        result.totalPPEarned,
        result.seasonalCP,
        result.currentGrowthLevel,
        result.highestSinglePPReward,
        result.highestSingleCPReward,
        result.lastRebirthIntervalsSeconds.at(-1) ?? null,
        peakHabitatTotal,
        result.totalMilestoneUpgradesPurchased,
        peakMilestones,
        result.stoppedAtSeasonCap,
        result.firstEligibleAtSeconds,
        result.gateBlockedSeconds,
        result.firstMilestoneAtSeconds,
      ];
    });
    console.log(
      `${version}|${threshold}|minAge=${minRunAgeSeconds}|${strategy}|${JSON.stringify(compact)}`,
    );
  }
}

main();
