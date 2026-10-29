import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  HABITATS as ECONOMY_HABITATS,
  HABITAT_UPGRADE_MILESTONES,
  buyHabitat,
  buyHabitatProductionUpgrade,
  buyPPUpgrade,
  calculateBuyQuantity,
  habitatBulkCost,
  habitatProductionPerSecond,
  habitatProductionUpgradeCost,
  PP_UPGRADE_CONFIG,
  ppUpgradeCost,
  rebirthRequirement,
  rebirthReward,
  canRebirth,
  productionPerSecond,
  type ActionResult,
  type EconomyState,
  type BuyAmount,
  type HabitatKind,
  type PPUpgrade,
} from '../incremental/engine';
import { compareValues, formatValue } from '../incremental/decimal';
import { NatureBoostsPanel } from './NatureBoostsPanel';
import { VerifiedNatureBoostsPanel } from './VerifiedNatureBoostsPanel';
import {
  islandGrowthStage,
  islandGrowthStageForHabitatCount,
  islandGrowthStageProgress,
  islandGrowthStageProgressForHabitatCount,
  type IslandGrowthStage,
} from './islandGrowthStage';
import type { V3IslandSnapshot } from '../v3/components/V3VerifiedGameplay';
import type { V3IslandActionHandlers } from '../v3/components/V3VerifiedGameplay';
import { V3_UPGRADE_CONFIG, type V3UpgradeKind } from '../v3/types';
import { calculateV3RebirthRewardPreview } from '../v3/rebirthRewardPreview';
import { v3Api, type V3SeasonalLeaderboardResponse } from '../v3/api';
import type { V3LivingProfile, V3LivingSettlementControls } from './V3IntegrationShell';

type HabitatUpgradeState = 'locked' | 'available' | 'unaffordable' | 'purchased';

const HABITAT_PRESENTATION: Record<
  HabitatKind,
  { name: string; icon: string; description: string }
> = {
  water: {
    name: 'Water',
    icon: '≈',
    description: 'A cool stream brings life.',
  },
  grass: {
    name: 'Grass',
    icon: '✿',
    description: 'Green ground spreads across the isle.',
  },
  forest: {
    name: 'Forest',
    icon: '♧',
    description: 'Trees shelter a thriving island.',
  },
  mountain: {
    name: 'Mountain',
    icon: '▲',
    description: 'A high ridge reaches into the clouds.',
  },
  'crystal-cavern': {
    name: 'Crystal Cavern',
    icon: '◇',
    description: 'A quiet cavern glimmers beneath the isle.',
  },
  'ancient-grove': {
    name: 'Ancient Grove',
    icon: '✣',
    description: 'Old roots hold a flourishing sanctuary.',
  },
};
const PP_UPGRADES: PPUpgrade[] = ['growth', 'efficiency', 'awakening', 'rebirth'];

const CRAFTPIX_ASSET_ROOT = '/assets/third-party/craftpix/island/';
const CRAFTPIX_STAGE_DECORATIONS: Record<
  IslandGrowthStage,
  Array<{ file: string; placement: string }>
> = {
  seed: [{ file: 'rock-pebble.png', placement: 'seed-rock' }],
  sprout: [
    { file: 'bush-small.png', placement: 'sprout-bush' },
    { file: 'flower-white.png', placement: 'sprout-edge-flower' },
  ],
  growing: [
    { file: 'bush-round.png', placement: 'growing-bush' },
    { file: 'rock-pebble.png', placement: 'growing-pebble' },
    { file: 'bush-small.png', placement: 'growing-bush-small' },
    { file: 'mushroom-redcap.png', placement: 'growing-upper-mushroom' },
    { file: 'flower-yellow.png', placement: 'growing-edge-flower' },
  ],
  flourishing: [
    { file: 'leafy-tree-grove.png', placement: 'flourishing-grove' },
    { file: 'bush-small.png', placement: 'flourishing-bush-small' },
    { file: 'bush-wide.png', placement: 'flourishing-bush-wide' },
    { file: 'bush-round.png', placement: 'flourishing-bush-round' },
    { file: 'rock-pebble.png', placement: 'flourishing-pebble' },
    { file: 'rock-boulder.png', placement: 'flourishing-boulder' },
    { file: 'flower-white.png', placement: 'flourishing-upper-flower' },
    { file: 'mushroom-redcap.png', placement: 'flourishing-upper-mushroom' },
    { file: 'bush-small.png', placement: 'flourishing-right-bush' },
    { file: 'rock-pebble.png', placement: 'flourishing-right-pebble' },
  ],
};

const ISLAND_EDGE_DETAIL_COUNT: Record<IslandGrowthStage, number> = {
  seed: 1,
  sprout: 3,
  growing: 5,
  flourishing: 8,
};

const ISLAND_CREATURES: Record<IslandGrowthStage, IslandCreatureKind[]> = {
  seed: [],
  sprout: ['moss'],
  growing: ['moss', 'pip', 'caretaker'],
  flourishing: ['moss', 'pip', 'luma', 'caretaker', 'villager'],
};

type IslandCreatureKind = 'moss' | 'pip' | 'luma' | 'caretaker' | 'villager';
type CreaturePosition = { left: number; top: number };
type CreatureWanderArea = {
  start: CreaturePosition;
  walkMs: number;
};

const CREATURE_WANDER_AREAS: Record<
  IslandCreatureKind,
  { desktop: CreatureWanderArea; mobile: CreatureWanderArea }
> = {
  moss: {
    desktop: { start: { left: 23, top: 60 }, walkMs: 1250 },
    mobile: { start: { left: 22, top: 58 }, walkMs: 1050 },
  },
  pip: {
    desktop: { start: { left: 76, top: 39 }, walkMs: 1450 },
    mobile: { start: { left: 72, top: 35 }, walkMs: 1200 },
  },
  luma: {
    desktop: { start: { left: 69, top: 55 }, walkMs: 1650 },
    mobile: { start: { left: 70, top: 52 }, walkMs: 1450 },
  },
  caretaker: {
    desktop: { start: { left: 36, top: 65 }, walkMs: 1550 },
    mobile: { start: { left: 33, top: 64 }, walkMs: 1350 },
  },
  villager: {
    desktop: { start: { left: 74, top: 52 }, walkMs: 1750 },
    mobile: { start: { left: 74, top: 52 }, walkMs: 1500 },
  },
};

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

function formatSeasonNature(atoms: string): string {
  try {
    const value = BigInt(atoms);
    const scale = 1_000_000_000_000n;
    const whole = value / scale;
    const fraction = (value % scale).toString().padStart(12, '0').slice(0, 2);
    return `${whole.toLocaleString()}${fraction === '00' ? '' : `.${fraction.replace(/0$/, '')}`}`;
  } catch {
    return '—';
  }
}

function leaderboardCPPercent(current: string | undefined, target: string | undefined): number {
  try {
    const amount = BigInt(current ?? '0');
    const cap = BigInt(target ?? '0');
    if (cap <= 0n) return 0;
    return Number((amount >= cap ? 10_000n : (amount * 10_000n) / cap)) / 100;
  } catch {
    return 0;
  }
}

function formatCP(value: string | undefined): string {
  try {
    return BigInt(value ?? '0').toLocaleString();
  } catch {
    return '—';
  }
}

function formatSeasonDateRange(seasonEndsAt: string | undefined): string {
  if (!seasonEndsAt) return 'UTC dates loading';
  try {
    const end = Number(BigInt(seasonEndsAt)) * 1_000;
    const start = end - 7 * 24 * 60 * 60 * 1_000;
    const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `${date.format(start)} – ${date.format(end)} UTC`;
  } catch {
    return 'UTC dates unavailable';
  }
}

function formatSeasonCountdown(secondsRemaining: number): string {
  const remaining = Math.max(0, Math.floor(secondsRemaining));
  const days = Math.floor(remaining / 86_400);
  const hours = Math.floor((remaining % 86_400) / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  const seconds = remaining % 60;
  return days > 0
    ? `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`
    : `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

function getSeasonSecondsRemaining(
  confirmedTimestamp: string | undefined,
  seasonEndsAt: string | undefined,
  elapsedSeconds: number,
): number | undefined {
  if (!confirmedTimestamp || !seasonEndsAt || !/^\d+$/.test(confirmedTimestamp) || !/^\d+$/.test(seasonEndsAt)) {
    return undefined;
  }
  return Math.max(0, Number(BigInt(seasonEndsAt) - BigInt(confirmedTimestamp)) - elapsedSeconds);
}

function creatureFitsIslandSurface(position: CreaturePosition, compact: boolean): boolean {
  const halfWidth = compact ? 6 : 5;
  const halfHeight = compact ? 10 : 13;
  const left = [position.left + 1, position.left + halfWidth * 2 - 1];
  const top = [position.top + 1, position.top + halfHeight * 2 - 1];

  return left.every((x) => top.every((y) => {
    const normalizedX = (x - 50) / 46;
    const normalizedY = (y - 50) / 47;
    return normalizedX * normalizedX + normalizedY * normalizedY <= 0.92;
  }));
}

function creatureAvoidsHeart(position: CreaturePosition, compact: boolean): boolean {
  const centerX = position.left + (compact ? 6 : 5);
  const centerY = position.top + (compact ? 10 : 13);
  const normalizedX = (centerX - 50) / 13;
  const normalizedY = (centerY - 55) / 21;
  return normalizedX * normalizedX + normalizedY * normalizedY > 1.04;
}

function creaturePathAvoidsHeart(
  from: CreaturePosition,
  to: CreaturePosition,
  compact: boolean,
): boolean {
  const distance = Math.hypot(to.left - from.left, to.top - from.top);
  const samples = Math.max(2, Math.ceil(distance / 2));

  for (let index = 1; index < samples; index += 1) {
    const progress = index / samples;
    const point = {
      left: from.left + (to.left - from.left) * progress,
      top: from.top + (to.top - from.top) * progress,
    };
    if (!creatureAvoidsHeart(point, compact)) return false;
  }

  return true;
}

function randomIslandPosition(compact: boolean, fallback: CreaturePosition): CreaturePosition {
  const halfWidth = compact ? 6 : 5;
  const halfHeight = compact ? 10 : 13;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * 0.72;
    const candidate = {
      left: 50 + Math.cos(angle) * 40 * radius - halfWidth,
      top: 50 + Math.sin(angle) * 40 * radius - halfHeight,
    };
    if (
      creatureFitsIslandSurface(candidate, compact) &&
      creatureAvoidsHeart(candidate, compact) &&
      creaturePathAvoidsHeart(fallback, candidate, compact)
    ) {
      return candidate;
    }
  }

  return fallback;
}

function IslandCreature({ creature }: { creature: IslandCreatureKind }) {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches === true,
  );
  const area = CREATURE_WANDER_AREAS[creature][compact ? 'mobile' : 'desktop'];
  const [position, setPosition] = useState(area.start);
  const positionRef = useRef(area.start);
  const elementRef = useRef<HTMLSpanElement | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const compactRef = useRef(compact);
  const [walking, setWalking] = useState(false);
  const [facingLeft, setFacingLeft] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    const syncViewport = () => {
      const nextCompact = window.matchMedia?.('(max-width: 700px)').matches === true;
      if (compactRef.current === nextCompact) return;
      compactRef.current = nextCompact;
      const nextArea = CREATURE_WANDER_AREAS[creature][nextCompact ? 'mobile' : 'desktop'];
      positionRef.current = nextArea.start;
      setPosition(nextArea.start);
      setWalking(false);
      setCompact(nextCompact);
    };
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, [creature]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      setReduceMotion(query.matches);
      if (query.matches) setWalking(false);
    };
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    if (reduceMotion) return;

    let timer: number | undefined;
    let cancelled = false;
    const scheduleWander = () => {
      timer = window.setTimeout(() => {
        if (cancelled) return;
        const next = randomIslandPosition(compact, positionRef.current);
        if (next.left === positionRef.current.left && next.top === positionRef.current.top) {
          setWalking(false);
          scheduleWander();
          return;
        }
        const from = positionRef.current;
        setFacingLeft(next.left < from.left);
        positionRef.current = next;
        setPosition(next);
        setWalking(true);
        const element = elementRef.current;
        if (element && typeof element.animate === 'function') {
          animationRef.current?.cancel();
          const animation = element.animate(
            [
              { left: `${from.left}%`, top: `${from.top}%` },
              { left: `${next.left}%`, top: `${next.top}%` },
            ],
            { duration: area.walkMs, easing: 'ease-in-out', fill: 'both' },
          );
          animationRef.current = animation;
          animation.onfinish = () => {
            animation.cancel();
            if (animationRef.current === animation) animationRef.current = null;
          };
        }
        timer = window.setTimeout(() => {
          if (cancelled) return;
          setWalking(false);
          scheduleWander();
        }, area.walkMs);
      }, 2200 + Math.random() * 2400);
    };

    scheduleWander();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      animationRef.current?.cancel();
      animationRef.current = null;
    };
  }, [area, reduceMotion]);

  return (
    <span
      className={`island-creature island-creature--${creature}${walking ? ' island-creature--walking' : ''}${facingLeft ? ' island-creature--facing-left' : ''}`}
      data-creature={creature}
      data-walking={walking}
      data-facing={facingLeft ? 'left' : 'right'}
      data-testid={`island-creature-${creature}`}
      ref={elementRef}
      style={{ left: `${position.left}%`, top: `${position.top}%` }}
    >
      <i className="island-creature-sprite" />
    </span>
  );
}

export interface LivingIslandScreenProps {
  state: EconomyState;
  mode?: LivingIslandMode;
  verifiedModeEnabled?: boolean;
  verifiedIsland?: V3IslandSnapshot | null;
  verifiedHeartAction?: (() => boolean | void) | null;
  verifiedActions?: V3IslandActionHandlers | null;
  verifiedProfile?: V3LivingProfile | null;
  verifiedSettlement?: V3LivingSettlementControls | null;
  nextSeasonStart: number;
  saveLabel: string;
  walletControl?: ReactNode;
  audioControls?: ReactNode;
  verifiedProgression?: ReactNode;
  onModeChange?: (mode: LivingIslandMode) => void;
  notice?: string;
  noticeImportant?: boolean;
  onNoticeDismiss?: () => void;
  onHeartClick: () => boolean | void;
  onStateChange: (result: ActionResult) => void;
  onRebirth: () => void;
}

export type LivingIslandMode = 'guest' | 'verified';

function formatLiveNature(atoms: string): string {
  try {
    const value = BigInt(atoms);
    const scale = 1_000_000_000_000n;
    const whole = value / scale;
    const fraction = (value % scale).toString().padStart(12, '0').replace(/0+$/, '');
    return `${new Intl.NumberFormat().format(whole)}${fraction ? `.${fraction}` : ''}`;
  } catch {
    return '—';
  }
}

function VerifiedStatsPanel({ profile }: { profile: V3LivingProfile }) {
  const formatInteger = (value: string) => {
    try {
      return new Intl.NumberFormat().format(BigInt(value));
    } catch {
      return '—';
    }
  };
  return (
    <section className="v3-status-panel living-live-stats" aria-label="Live account stats">
      <div className="v3-panel-heading">
        <span className="v3-panel-kicker">LIVE ACCOUNT</span>
        <strong>{profile.activeRun ? `Run #${profile.runId}` : 'No Active Run'}</strong>
      </div>
      <p className="v3-status-description">
        {profile.activeRun ? 'Verified progression for your current run' : 'Start a Live run to begin earning verified points'}
      </p>
      <dl className="v3-status-details" aria-label="Live lifetime and season totals">
        <div className="v3-status-item"><dt>Lifetime Nature</dt><dd>{formatLiveNature(profile.lifetimeNature)}</dd></div>
        <div className="v3-status-item"><dt>Accumulated Rebirth score</dt><dd>{formatInteger(profile.accumulatedScore)}</dd></div>
        <div className="v3-status-item"><dt>Season PP</dt><dd>{formatInteger(profile.seasonalPP)}</dd></div>
        <div className="v3-status-item"><dt>Season CP</dt><dd>{formatInteger(profile.seasonalCP)}</dd></div>
        <div className="v3-status-item"><dt>Lifetime CP</dt><dd>{formatInteger(profile.lifetimeCP)}</dd></div>
        <div className="v3-status-item"><dt>Highest settled tier</dt><dd>{profile.seasonalHighScoreTier}</dd></div>
        <div className="v3-status-item"><dt>Next CP milestone</dt><dd>{profile.nextCpMilestoneTier === null ? 'All milestones reached' : `Tier ${profile.nextCpMilestoneTier}`}</dd></div>
      </dl>
    </section>
  );
}

function HabitatBuySelector({
  value,
  onChange,
}: {
  value: BuyAmount;
  onChange: (amount: BuyAmount) => void;
}) {
  const options: BuyAmount[] = [1, 10, 100, 'max'];
  return (
    <div className="living-habitat-buy-quantity" role="group" aria-label="Habitat purchase quantity">
      {options.map((amount) => (
        <button
          key={amount}
          type="button"
          aria-pressed={value === amount}
          onClick={() => onChange(amount)}
        >
          {amount === 'max' ? 'Max' : `${amount}x`}
        </button>
      ))}
    </div>
  );
}

function VerifiedIslandPanel({
  island,
  profile,
  actions,
  settlement,
  habitatBuyAmount,
  setHabitatBuyAmount,
}: {
  island: V3IslandSnapshot | null;
  profile: V3LivingProfile | null;
  actions: V3IslandActionHandlers | null;
  settlement: V3LivingSettlementControls | null;
  habitatBuyAmount: BuyAmount;
  setHabitatBuyAmount: (amount: BuyAmount) => void;
}) {
  const scoreTier = island?.scoreTier ?? 0;
  const rebirthGoal = profile?.rebirthThresholdTier ?? 0;
  const progress = rebirthGoal > 0 ? Math.min(100, (scoreTier / rebirthGoal) * 100) : 0;
  const rewardPreview =
    island && profile?.ready && profile.rewardRules &&
    profile.totalSeasonCP !== null && profile.totalSeasonCP !== undefined &&
    profile.maxSeasonPoints !== null && profile.maxSeasonPoints !== undefined
      ? calculateV3RebirthRewardPreview({
          scoreTier,
          seasonalHighScoreTier: profile.seasonalHighScoreTier,
          seasonalPP: BigInt(profile.seasonalPP),
          seasonalCP: BigInt(profile.seasonalCP),
          totalSeasonCP: BigInt(profile.totalSeasonCP),
          lifetimeCP: BigInt(profile.lifetimeCP),
          maxSeasonPoints: BigInt(profile.maxSeasonPoints),
          rules: profile.rewardRules,
        })
      : null;
  const hasEligibleRewardPreview = Boolean(
    rewardPreview && rebirthGoal > 0 && scoreTier >= rebirthGoal,
  );
  const canRebirth = Boolean(
    island && profile?.activeRun && profile.authenticated && settlement?.canSettle &&
      !settlement.pending && rebirthGoal > 0 && scoreTier >= rebirthGoal,
  );
  const habitatNames: Record<string, { name: string; icon: string; description: string }> = {
    water: { name: 'Water', icon: '≈', description: 'A cool stream brings life.' },
    grass: { name: 'Grass', icon: '✿', description: 'Green ground spreads across the isle.' },
    forest: { name: 'Forest', icon: '♧', description: 'Trees shelter a thriving island.' },
    mountain: { name: 'Mountain', icon: '▲', description: 'A high ridge reaches into the clouds.' },
    'crystal-cavern': { name: 'Crystal Cavern', icon: '◇', description: 'A quiet cavern glimmers beneath the isle.' },
    'ancient-grove': { name: 'Ancient Grove', icon: '✣', description: 'Old roots hold a flourishing sanctuary.' },
  };
  const upgradeKinds: V3UpgradeKind[] = ['growth', 'efficiency', 'awakening'];

  return (
    <>
      <article className="living-rebirth-card" id="rebirth" aria-labelledby="living-rebirth-title">
        <div className="living-section-heading">
          <div>
            <span className="living-eyebrow">VERIFIED RUN</span>
            <h2 id="living-rebirth-title">Rebirth</h2>
          </div>
          <span className="living-rebirth-count">
            {profile?.ready ? profile.seasonRebirths : '—'} this season
          </span>
        </div>
        <p className="living-rebirth-progress-copy">
          Score tier <strong>{island ? scoreTier : '—'}</strong> / <strong>{rebirthGoal || '—'}</strong>
        </p>
        <div
          className="living-rebirth-track"
          role="progressbar"
          aria-label="Live Rebirth progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <i style={{ width: `${progress}%` }} />
        </div>
        {!profile?.activeRun ? (
          <p className="living-rebirth-locked" role="status">
            {profile?.authenticated
              ? 'Start a Live run to begin earning verified points.'
              : 'Open Live account to authenticate and start a run.'}
          </p>
        ) : !island ? (
          <p className="living-rebirth-locked" role="status">Syncing Live island progress. Open Advanced if this takes too long.</p>
        ) : canRebirth ? (
          <p className="living-rebirth-ready" role="status">Rebirth is ready. Rewards settle from this Live run.</p>
        ) : (
          <p className="living-rebirth-locked" role="status">
            {profile?.authenticated
              ? `Reach score tier ${rebirthGoal} to unlock Rebirth.`
              : 'Authenticate this run to settle Live progress.'}
          </p>
        )}
        {!profile?.activeRun && profile?.authenticated && settlement?.openStartRun && (
          <button
            type="button"
            className="living-rebirth-button living-rebirth-button--secondary living-rebirth-button--start-run"
            onClick={settlement.openStartRun}
          >
            Start a Live run <span aria-hidden="true">→</span>
          </button>
        )}
        <div className="living-rebirth-reward">
          <span>Settled balances</span>
          Seasonal PP <strong>{profile?.ready ? profile.seasonalPP : '—'}</strong>
          <span>·</span>
          Seasonal CP <strong>{profile?.ready ? profile.seasonalCP : '—'}</strong>
        </div>
        <div className="living-rebirth-reward">
          {hasEligibleRewardPreview ? 'Next CP milestone after Rebirth' : 'Next CP milestone'}{' '}
          <strong>{profile?.ready
            ? hasEligibleRewardPreview
              ? rewardPreview?.nextCpMilestoneTier ?? '—'
              : profile.nextCpMilestoneTier ?? '—'
            : '—'}</strong>
        </div>
        {rewardPreview && scoreTier >= rebirthGoal && (
          <div className="living-rebirth-preview" aria-label="Estimated Rebirth rewards">
            <span>Estimated this Rebirth</span>
            <strong>+{rewardPreview.pp.toString()} PP · +{rewardPreview.cp.toString()} CP</strong>
            {(rewardPreview.ppCapped || rewardPreview.cpCapped) && (
              <small>Reward caps may limit the final amount.</small>
            )}
          </div>
        )}
        <div className="living-verified-rebirth-actions">
          <button
            type="button"
            className="living-rebirth-button living-rebirth-button--secondary"
            onClick={() => settlement?.recordPoints()}
            disabled={!island || !profile?.authenticated || !settlement?.canSettle || settlement.pending}
          >
            Record Points
          </button>
          <button
            className="living-rebirth-button"
            type="button"
            onClick={() => settlement?.rebirth()}
            disabled={!canRebirth}
          >
            {settlement?.pending ? 'Settling…' : <>Rebirth <span>→</span></>}
          </button>
        </div>
        {settlement?.error && <p className="living-rebirth-locked" role="alert">{settlement.error}</p>}
      </article>

      <section className="living-shop" aria-labelledby="habitat-shop-title">
        <div className="living-section-heading living-shop-heading">
          <div>
            <span className="living-eyebrow">VERIFIER-ACCEPTED PROGRESS</span>
            <h1 id="habitat-shop-title">Habitat shop</h1>
          </div>
          <HabitatBuySelector value={habitatBuyAmount} onChange={setHabitatBuyAmount} />
        </div>
        {!island?.habitats.length ? (
          <p className="living-verified-empty" role="status">
            {profile?.activeRun
              ? profile.authenticated
                ? 'Syncing this Live run’s habitats. Open Advanced if this takes too long.'
                : 'Authenticate to load this run’s habitats.'
              : 'Start a Live run to unlock its habitat shop.'}
          </p>
        ) : (
          <div className="living-habitat-list">
            {island.habitats.map((habitat) => {
              const info = habitatNames[habitat.id];
              const quantity = habitatBuyAmount === 'max' ? habitat.maxAffordable : habitatBuyAmount;
              const costKey = habitatBuyAmount === 1 ? 'one' : habitatBuyAmount === 10 ? 'ten' : habitatBuyAmount === 100 ? 'hundred' : 'max';
              const cost = habitat.purchaseCosts[costKey];
              return (
                <article className={`living-habitat living-habitat--${habitat.id}`} key={habitat.id}>
                  <span className="living-habitat-icon" aria-hidden="true">{info.icon}</span>
                  <div className="living-habitat-copy">
                    <strong>{info.name}</strong>
                    <span>Level {habitat.level}</span>
                    <small>{info.description}</small>
                  </div>
                  <div className="living-habitat-actions">
                    <button
                      type="button"
                      onClick={() => actions?.buyHabitat(habitat.id, quantity)}
                      disabled={!actions || actions.pending || quantity < 1 || habitat.maxAffordable < quantity}
                      aria-label={`Buy ${habitatBuyAmount === 'max' ? `maximum (${quantity})` : `${quantity}`} ${info.name} for ${cost ?? 'unknown cost'} Nature`}
                    >
                      <span>{habitatBuyAmount === 'max' ? `Buy max · ${quantity}` : `Buy ${quantity}×`}</span>
                      <small>{cost === null ? '—' : `${cost} Nature`}</small>
                    </button>
                  </div>
                  {habitat.productionUpgrades.length > 0 && (
                    <details className="living-habitat-upgrades">
                      <summary aria-label={`${info.name} Live milestone upgrades`}>
                        Milestone upgrades <span>{habitat.purchasedUpgradeCount}/4</span>
                      </summary>
                      <div className="living-habitat-upgrade-list">
                        {habitat.productionUpgrades.map((upgrade) => (
                          <div
                            className={`living-habitat-upgrade living-habitat-upgrade--${upgrade.purchased ? 'purchased' : upgrade.available ? 'available' : 'locked'}`}
                            key={upgrade.milestone}
                          >
                            <span>
                              <strong>Level {upgrade.milestone}</strong>
                              <small>{upgrade.purchased ? 'Purchased' : `${upgrade.cost} Nature`}</small>
                            </span>
                            {!upgrade.purchased && (
                              <span className="living-habitat-upgrade-meta">
                                <button
                                  type="button"
                                  disabled={!upgrade.available || !actions || actions.pending}
                                  onClick={() => actions?.buyProductionUpgrade(habitat.id)}
                                  aria-label={`Buy ${info.name} level ${upgrade.milestone} production upgrade`}
                                >
                                  {upgrade.available ? 'Buy upgrade' : habitat.level < upgrade.milestone ? `Locked · Level ${upgrade.milestone}` : 'Locked · previous upgrade'}
                                </button>
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                      <small className="living-habitat-upgrade-note">V2 Live run · sequential upgrades</small>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <article className="living-upgrades-card">
        <div className="living-section-heading">
          <div>
            <span className="living-eyebrow">VERIFIED SEASON</span>
            <h2>Upgrades</h2>
          </div>
          <span className="living-pp-chip">{profile?.ready ? profile.seasonalPP : '—'} PP</span>
        </div>
        <div className="living-verified-ledger">
          <span>Season CP <strong>{profile?.ready ? profile.seasonalCP : '—'}</strong></span>
          <span>Lifetime CP <strong>{profile?.ready ? profile.lifetimeCP : '—'}</strong></span>
          <span>Lifetime Nature <strong>{profile?.ready ? formatVerifiedAtoms(profile.lifetimeNature) : '—'}</strong></span>
          <span>Accumulated Rebirth score <strong>{profile?.ready ? formatVerifiedCount(profile.accumulatedScore) : '—'}</strong></span>
        </div>
        <VerifiedNatureBoostsPanel
          rulesVersion={island?.rulesVersion ?? 0}
          upgrades={island?.verifiedNatureBoosts ?? null}
          pending={!actions || actions.pending}
          onCommand={actions?.sendGameplayCommand ?? (() => undefined)}
        />
        <div className="living-upgrade-list">
          {upgradeKinds.map((kind) => (
            <div className="living-upgrade living-upgrade--read-only" key={kind}>
              <span>
                  <strong>{V3_UPGRADE_CONFIG[kind].label} <small>Lv. {profile?.ready ? profile.upgradeLevels[kind] : '—'}</small></strong>
                <small>{V3_UPGRADE_CONFIG[kind].description}</small>
              </span>
              <b>{profile?.activeRun ? 'Run-start choice' : 'Next run'}</b>
            </div>
          ))}
        </div>
        <p className="living-verified-empty">
          Live PP choices are applied when a run starts. Guest-only temporary boosts are unavailable here.
        </p>
      </article>
    </>
  );
}

function rebirthProgress(state: EconomyState): number {
  const goal = rebirthRequirement(state);
  const difference = state.runNature.exponent - goal.exponent;
  if (difference < -250) return 0;
  if (difference > 250) return 100;
  return Math.max(
    0,
    Math.min(100, (state.runNature.mantissa / goal.mantissa) * 10 ** difference * 100),
  );
}

function timeUntil(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((timestamp - Date.now()) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}

function formatVerifiedAtoms(value: string | undefined): string {
  if (!value) return '—';
  try {
    const atoms = BigInt(value);
    const scale = 1_000_000_000_000n;
    const whole = atoms / scale;
    const fraction = (atoms % scale).toString().padStart(12, '0').replace(/0+$/, '');
    return fraction
      ? `${new Intl.NumberFormat().format(whole)}.${fraction}`
      : new Intl.NumberFormat().format(whole);
  } catch {
    return '—';
  }
}

function formatVerifiedCount(value: string | undefined): string {
  if (!value) return '0';
  try {
    return new Intl.NumberFormat().format(BigInt(value));
  } catch {
    return '0';
  }
}

function LivingIsland({
  state,
  mode,
  verifiedIsland,
  onHeartClick,
  actionPending = false,
}: {
  state: EconomyState;
  mode: LivingIslandMode;
  verifiedIsland: V3IslandSnapshot | null;
  onHeartClick: (() => boolean | void) | null;
  actionPending?: boolean;
}) {
  const isVerified = mode === 'verified';
  const stage = isVerified
    ? verifiedIsland
      ? islandGrowthStageForHabitatCount(verifiedIsland.visualHabitatLevelCount)
      : 'seed'
    : islandGrowthStage(state);
  const stageProgress = isVerified
    ? verifiedIsland
      ? islandGrowthStageProgressForHabitatCount(verifiedIsland.visualHabitatLevelCount)
      : null
    : islandGrowthStageProgress(state);
  const visibleTrees =
    stage === 'flourishing' ? 4 : stage === 'growing' ? 3 : stage === 'sprout' ? 1 : 0;
  const visibleFlora =
    stage === 'flourishing' ? 7 : stage === 'growing' ? 4 : stage === 'sprout' ? 2 : 0;
  const visibleStones = stage === 'flourishing' ? 5 : stage === 'growing' ? 2 : 0;
  const visibleFireflies =
    stage === 'flourishing' ? 4 : stage === 'growing' ? 3 : stage === 'sprout' ? 2 : 1;
  const distantIslandCount =
    stage === 'flourishing' ? 3 : stage === 'growing' ? 2 : stage === 'sprout' ? 1 : 0;
  const waterGlintCount = stage === 'flourishing' ? 6 : stage === 'growing' ? 4 : stage === 'sprout' ? 2 : 1;
  const edgeDetailCount = ISLAND_EDGE_DETAIL_COUNT[stage];
  const [heartClicks, setHeartClicks] = useState(0);

  return (
    <section
      className={`living-scene living-scene--${stage}`}
      aria-label={
        isVerified
          ? verifiedIsland
            ? `Live Living Island, ${stage} stage`
            : 'Live Living Island, waiting for an active run'
          : `Guest Living Island, ${stage} stage`
      }
    >
      <div className="living-scene-sky" aria-hidden="true">
        <div className="scene-distant-islands">
          {Array.from({ length: distantIslandCount }, (_, index) => (
            <i
              className={`scene-distant-island scene-distant-island--${index + 1}`}
              key={`distant-island-${index}`}
            />
          ))}
        </div>
        <i className="pixel-cloud pixel-cloud--one" />
        <i className="pixel-cloud pixel-cloud--two" />
        <span className="scene-spark scene-spark--one">✦</span>
        <span className="scene-spark scene-spark--two">✧</span>
        {Array.from({ length: visibleFireflies }, (_, index) => (
          <i
            key={`firefly-${index}`}
            className={`scene-firefly scene-firefly--${index + 1}`}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="living-island-water" aria-hidden="true">
        {Array.from({ length: waterGlintCount }, (_, index) => (
          <i
            className="water-glint"
            key={`water-glint-${index}`}
            style={{
              left: `${9 + ((index * 23) % 82)}%`,
              top: `${17 + ((index * 19) % 69)}%`,
              animationDelay: `${index * -1.3}s`,
            }}
          />
        ))}
      </div>
      <div
        className="living-island-land"
        aria-hidden="true"
        data-terrain-surface="craftpix"
      >
        {Array.from({ length: edgeDetailCount }, (_, index) => (
          <i
            key={`edge-detail-${index}`}
            className={`island-edge-detail island-edge-detail--${index + 1}`}
            data-edge-material={index === 4 || index === 5 ? 'earth' : 'grass'}
            data-testid="island-edge-detail"
          />
        ))}
        <div className="island-ground-decoration-layer">
          {Array.from({ length: visibleFlora }, (_, index) => {
            const file =
              index % 3 === 0
                ? 'flower-yellow.png'
                : index % 3 === 1
                  ? 'flower-white.png'
                  : 'mushroom-redcap.png';
            return (
              <img
                key={`flora-${index}`}
                className={`island-sprout island-sprout--${index + 1}`}
                src={`${CRAFTPIX_ASSET_ROOT}${file}`}
                alt=""
                data-craftpix-sprite={file}
              />
            );
          })}
        </div>
        {Array.from({ length: visibleTrees }, (_, index) => (
          <img
            key={index}
            className={`living-tree living-tree--${index + 1}${index % 2 ? ' living-tree--thin' : ''}`}
            src={`${CRAFTPIX_ASSET_ROOT}${index % 2 ? 'pine-tree-thin.png' : 'pine-tree-small.png'}`}
            alt=""
            data-craftpix-sprite={index % 2 ? 'pine-tree-thin.png' : 'pine-tree-small.png'}
          />
        ))}
        <div className="island-ground-decoration-layer">
          {Array.from({ length: visibleStones }, (_, index) => (
            <i key={`stone-${index}`} className={`island-stone island-stone--${index + 1}`} />
          ))}
          {CRAFTPIX_STAGE_DECORATIONS[stage].map(({ file, placement }) => (
            <img
              key={placement}
              className={`craftpix-decoration craftpix-decoration--${placement}`}
              src={`${CRAFTPIX_ASSET_ROOT}${file}`}
              alt=""
              aria-hidden="true"
              data-craftpix-sprite={file}
            />
          ))}
        </div>
        {stage === 'flourishing' && (
          <div className="island-campsite" data-testid="island-campsite" aria-hidden="true">
            <img src="/assets/environment/living-island-campsite.png" alt="" />
            <i className="island-campsite-ember" />
          </div>
        )}
        <div className="island-creature-layer" aria-hidden="true">
          {ISLAND_CREATURES[stage].map((creature) => (
            <IslandCreature creature={creature} key={creature} />
          ))}
        </div>
      </div>
      <button
        className={`island-heart${heartClicks ? ' island-heart--clicked' : ''}`}
        type="button"
        disabled={isVerified && (!onHeartClick || actionPending)}
        onClick={() => {
          if (!onHeartClick) return;
          if (onHeartClick() !== false) setHeartClicks((clicks) => clicks + 1);
        }}
        aria-label={
          isVerified ? 'Click the Live Island Heart to collect 1 Nature' : 'Click the Island Heart to collect 1 Nature'
        }
        title={isVerified ? 'Live click · +1 Nature' : 'Click to collect +1 Nature'}
      >
        <span key={heartClicks} className="island-heart-sprite" aria-hidden="true" />
        {heartClicks > 0 && (
          <span key={`feedback-${heartClicks}`} className="heart-click-feedback" aria-hidden="true">
            +1 Nature
          </span>
        )}
        <span className="island-heart-label">
          {isVerified ? 'Live • Collect Nature' : 'Collect Nature'}
        </span>
        <strong>+1</strong>
      </button>
      <div className="island-stage-info">
        <div className="island-stage-label">
          <span /> {isVerified && !verifiedIsland ? 'Waiting for Live run' : stage}
        </div>
        {stageProgress && (
          <div
            className="island-stage-progress"
            role="progressbar"
            aria-label={`Growth progress to ${stageProgress.next}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={stageProgress.progress}
          >
            <span>{stage === 'flourishing' ? 'Max growth' : `Next · ${stageProgress.next}`}</span>
            <div className="island-stage-progress-track" aria-hidden="true">
              <i style={{ width: `${stageProgress.progress}%` }} />
            </div>
            <b>
              {stageProgress.total}/{stageProgress.target}
            </b>
          </div>
        )}
      </div>
    </section>
  );
}

export function LivingIslandScreen({
  state,
  mode = 'guest',
  verifiedModeEnabled = false,
  verifiedIsland = null,
  verifiedHeartAction = null,
  verifiedActions = null,
  verifiedProfile = null,
  verifiedSettlement = null,
  nextSeasonStart,
  saveLabel,
  walletControl,
  audioControls,
  verifiedProgression,
  onModeChange = () => undefined,
  notice,
  noticeImportant = false,
  onNoticeDismiss,
  onHeartClick,
  onStateChange,
  onRebirth,
}: LivingIslandScreenProps) {
  const reward = rebirthReward(state);
  const progress = rebirthProgress(state);
  const [habitatBuyAmount, setHabitatBuyAmount] = useState<BuyAmount>(1);
  const [howToPlayOpen, setHowToPlayOpen] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [leaderboard, setLeaderboard] = useState<V3SeasonalLeaderboardResponse | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [leaderboardReceivedAt, setLeaderboardReceivedAt] = useState(0);
  const [leaderboardClock, setLeaderboardClock] = useState(0);
  const [noticePresentation, setNoticePresentation] = useState<{
    text: string;
    important: boolean;
    exiting: boolean;
  } | null>(null);
  const noticeExitTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  useEffect(() => {
    const dialog = document.querySelector('.living-how-to-play-dialog') as unknown as {
      open: boolean;
      showModal: () => void;
      close: () => void;
    } | null;
    if (!dialog) return;
    if (howToPlayOpen && !dialog.open) dialog.showModal();
    if (!howToPlayOpen && dialog.open) dialog.close();
  }, [howToPlayOpen]);

  useEffect(() => {
    const dialog = document.querySelector('.living-leaderboard-dialog') as unknown as {
      open: boolean;
      showModal: () => void;
      close: () => void;
    } | null;
    if (!dialog) return;
    if (leaderboardOpen && !dialog.open) dialog.showModal();
    if (!leaderboardOpen && dialog.open) dialog.close();
  }, [leaderboardOpen]);

  useEffect(() => {
    if (!leaderboardOpen) return;
    const timer = window.setInterval(() => setLeaderboardClock(window.performance.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [leaderboardOpen]);

  const refreshLeaderboard = async () => {
    setLeaderboardLoading(true);
    setLeaderboardError(null);
    try {
      setLeaderboard(await v3Api.seasonalLeaderboard());
      const now = window.performance.now();
      setLeaderboardReceivedAt(now);
      setLeaderboardClock(now);
    } catch {
      setLeaderboardError('Leaderboard is temporarily unavailable. Please try again.');
    } finally {
      setLeaderboardLoading(false);
    }
  };

  useEffect(() => {
    const dropdownSelector = '.audio-settings, .v3-living-account, .v3-advanced-activity';
    const closeOtherDropdowns = (event: globalThis.MouseEvent) => {
      const target = event.target as { closest?: (selector: string) => unknown } | null;
      const activeDropdown = target?.closest?.(dropdownSelector) as { open: boolean } | null;

      document.querySelectorAll(dropdownSelector).forEach((element) => {
        const dropdown = element as unknown as { open: boolean };
        if (dropdown !== activeDropdown) dropdown.open = false;
      });
    };
    const closeDropdownsOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const dropdowns = Array.from(document.querySelectorAll(dropdownSelector));
      const openDropdown = dropdowns.find(
        (element) => (element as unknown as { open: boolean }).open,
      );
      if (!openDropdown) return;
      event.preventDefault();
      dropdowns.forEach((element) => {
        (element as unknown as { open: boolean }).open = false;
      });
      (openDropdown.querySelector('summary') as unknown as { focus: () => void } | null)?.focus();
    };

    document.addEventListener('click', closeOtherDropdowns);
    document.addEventListener('keydown', closeDropdownsOnEscape);
    return () => {
      document.removeEventListener('click', closeOtherDropdowns);
      document.removeEventListener('keydown', closeDropdownsOnEscape);
    };
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- Keep a toast mounted briefly for its exit animation. */
  useEffect(() => {
    if (noticeExitTimer.current) window.clearTimeout(noticeExitTimer.current);
    if (notice) {
      setNoticePresentation({ text: notice, important: noticeImportant, exiting: false });
      return;
    }

    setNoticePresentation((current) => (current ? { ...current, exiting: true } : null));
    noticeExitTimer.current = window.setTimeout(() => setNoticePresentation(null), 180);
    return () => {
      if (noticeExitTimer.current) window.clearTimeout(noticeExitTimer.current);
    };
  }, [notice, noticeImportant]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const leaderboardElapsedSeconds = Math.max(0, leaderboardClock - leaderboardReceivedAt) / 1_000;
  const seasonSecondsRemaining = getSeasonSecondsRemaining(
    leaderboard?.confirmedTimestamp,
    leaderboard?.seasonEndsAt,
    leaderboardElapsedSeconds,
  );

  return (
    <div className="living-game">
      <header className={`living-topbar${verifiedModeEnabled ? ' living-topbar--modes' : ''}`}>
        <a className="living-brand" href="#living-home">
          <img
            className="living-brand-logo"
            src="/assets/branding/worldseed-logo.png"
            alt="Worldseed"
          />
        </a>
        <div className="living-topbar-meta">
          {verifiedModeEnabled ? (
            <div className="living-mode-switch" role="group" aria-label="Progression mode">
              <button
                type="button"
                aria-pressed={mode === 'guest'}
                onClick={() => onModeChange('guest')}
              >
                Guest
              </button>
              <button
                type="button"
                aria-pressed={mode === 'verified'}
                onClick={() => onModeChange('verified')}
              >
                Live
              </button>
            </div>
          ) : (
            <span className="v3-mode-badge" title="Guest progress is saved locally in this browser">
              Guest
            </span>
          )}
          <button
            className="living-help-trigger"
            type="button"
            aria-label="How to play"
            aria-haspopup="dialog"
            onClick={() => setHowToPlayOpen(true)}
          >
            <span>How to play</span>
            <b aria-hidden="true">?</b>
          </button>
          {verifiedModeEnabled && (
            <button
              className="living-help-trigger living-leaderboard-trigger"
              type="button"
              aria-haspopup="dialog"
              onClick={() => {
                setLeaderboardOpen(true);
                void refreshLeaderboard();
              }}
            >
              Leaderboard
            </button>
          )}
          {mode === 'guest' && (
            <span
              className={`living-save living-save--${saveLabel === 'Saved' ? 'saved' : 'pending'}`}
              role="status"
              aria-label={`Guest local save: ${saveLabel}`}
            >
              <i /> <span>{saveLabel}</span>
            </span>
          )}
          {audioControls}
          {mode === 'verified' ? verifiedProgression : walletControl}
        </div>
      </header>

      <main className="living-main" id="living-home">
        <div className="living-desktop-layout">
          <div className="living-island-column">
            <section className="living-resource-bar" aria-label="Island resources">
              <div className="living-resource living-resource--nature">
                <span>{mode === 'verified' ? 'Live Nature · estimated' : 'Guest Nature'}</span>
                <strong data-testid={mode === 'verified' ? 'verified-nature-counter' : 'nature-counter'}>
                  {mode === 'verified'
                    ? verifiedIsland
                      ? `~${verifiedIsland.estimatedNature}`
                      : '—'
                    : formatValue(state.nature)}
                </strong>
                {mode === 'verified' && (verifiedIsland?.pendingHeartClicks ?? 0) > 0 && (
                  <small aria-live="polite">{verifiedIsland?.pendingHeartClicks ?? 0} Heart clicks syncing</small>
                )}
              </div>
              <div className="living-resource">
                <span>{mode === 'verified' ? 'Earned this run' : 'Growing'}</span>
                <strong>
                  {mode === 'verified' ? verifiedIsland?.earnedNature ?? '—' : formatValue(state.runNature)}
                  {mode === 'guest' && <small> this run</small>}
                </strong>
              </div>
              <div className="living-resource">
                <span>Production</span>
                <strong>
                  {mode === 'verified'
                    ? verifiedIsland?.productionPerSecond ?? '—'
                    : formatValue(productionPerSecond(state))}{' '}
                  <small>/ sec</small>
                </strong>
              </div>
            </section>

            <LivingIsland
              state={state}
              mode={mode}
              verifiedIsland={verifiedIsland}
              onHeartClick={mode === 'verified' ? verifiedHeartAction : onHeartClick}
              actionPending={
                mode === 'verified' &&
                (Boolean(verifiedSettlement?.pending) ||
                  Boolean(verifiedActions?.pending && !verifiedActions.heartClickPending))
              }
            />
            {mode === 'verified' && verifiedProfile?.ready && (
              <VerifiedStatsPanel profile={verifiedProfile} />
            )}
          </div>
          <aside className="living-control-panel" aria-label="Game controls">
            {mode === 'guest' ? (
              <>
                <article
              className="living-rebirth-card"
              id="rebirth"
              aria-labelledby="living-rebirth-title"
            >
              <div className="living-section-heading">
                <div>
                  <span className="living-eyebrow">A NEW BEGINNING</span>
                  <h2 id="living-rebirth-title">Rebirth</h2>
                </div>
                <span className="living-rebirth-count">{state.seasonRebirths} this season</span>
              </div>
              <p className="living-rebirth-progress-copy">
                This run: <strong>{formatValue(state.runNature)}</strong> /{' '}
                <strong>{formatValue(rebirthRequirement(state))} Nature</strong>
              </p>
              <div
                className="living-rebirth-track"
                role="progressbar"
                aria-label="Rebirth progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
              >
                <i style={{ width: `${progress}%` }} />
              </div>
              {!canRebirth(state) && (
                <p className="living-rebirth-locked" role="status">
                  Keep growing your island to reach the Nature goal and unlock Rebirth.
                </p>
              )}
              {canRebirth(state) && (
                <p className="living-rebirth-ready" role="status">
                  Nature goal reached — Rebirth is ready.
                </p>
              )}
              <div className="living-rebirth-reward">
                Next rebirth <strong>+{reward.pp} PP</strong>
                <span>·</span>
                <strong>+{reward.cp} simulated CP</strong>
              </div>
              <button
                className="living-rebirth-button"
                type="button"
                onClick={onRebirth}
                disabled={!canRebirth(state)}
              >
                Rebirth <span>→</span>
              </button>
                </article>

                <section className="living-shop" aria-labelledby="habitat-shop-title">
              <div className="living-section-heading living-shop-heading">
                <div>
                  <span className="living-eyebrow">HELP YOUR ISLAND GROW</span>
                  <h1 id="habitat-shop-title">Habitat shop</h1>
                </div>
                <HabitatBuySelector value={habitatBuyAmount} onChange={setHabitatBuyAmount} />
              </div>
              <div className="living-habitat-list">
                {ECONOMY_HABITATS.map((id) => {
                  const { name, icon, description } = HABITAT_PRESENTATION[id];
                  const owned = state.habitats[id] ?? 0;
                  const max = calculateBuyQuantity(state, id, 'max');
                  const purchaseQuantity = habitatBuyAmount === 'max' ? max : habitatBuyAmount;
                  const purchaseCost = purchaseQuantity > 0
                    ? habitatBulkCost(state, id, purchaseQuantity)
                    : null;
                  const affordable = purchaseQuantity > 0 &&
                    (habitatBuyAmount === 'max' || calculateBuyQuantity(state, id, habitatBuyAmount) === habitatBuyAmount) &&
                    purchaseCost !== null && compareValues(purchaseCost, state.nature) <= 0;
                  const purchaseLabel = habitatBuyAmount === 'max'
                    ? `Buy max · ${max}`
                    : `Buy ${habitatBuyAmount}×`;
                  const purchasedUpgradeCount = state.habitatProductionUpgrades?.[id] ?? 0;
                  const habitatProduction = habitatProductionPerSecond(state, id);
                  return (
                    <article className={`living-habitat living-habitat--${id}`} key={id}>
                      <span className="living-habitat-icon" aria-hidden="true">
                        {icon}
                      </span>
                      <div className="living-habitat-copy">
                        <strong>{name}</strong>
                        <span>
                          Level {owned} · {formatValue(habitatProduction)} Nature/sec
                        </span>
                        <small>{purchasedUpgradeCount}/4 production upgrades</small>
                        <small>{description}</small>
                      </div>
                      <div className="living-habitat-actions">
                        <button
                          type="button"
                          onClick={() => onStateChange(buyHabitat(state, id, habitatBuyAmount))}
                          disabled={!affordable}
                          aria-label={`${purchaseLabel} ${name} for ${purchaseCost === null ? 'unknown cost' : `${formatValue(purchaseCost)} Nature`}`}
                        >
                          <span>{purchaseLabel}</span>
                          <small>{purchaseCost === null ? '—' : `${formatValue(purchaseCost)} Nature`}</small>
                        </button>
                      </div>
                      <details className="living-habitat-upgrades">
                        <summary aria-label={`${name} milestone upgrades`}>
                          Milestone upgrades <span>{purchasedUpgradeCount}/4</span>
                        </summary>
                        <div className="living-habitat-upgrade-list">
                          {HABITAT_UPGRADE_MILESTONES.map((milestone, index) => {
                            const cost = habitatProductionUpgradeCost(id, index);
                            const isPurchased = index < purchasedUpgradeCount;
                            const isNext = index === purchasedUpgradeCount;
                            const isLevelUnlocked = owned >= milestone;
                            const upgradeState: HabitatUpgradeState = isPurchased
                              ? 'purchased'
                              : !isNext || !isLevelUnlocked
                                ? 'locked'
                                : compareValues(state.nature, cost) >= 0
                                  ? 'available'
                                  : 'unaffordable';
                            const projectedState = {
                              ...state,
                              habitatProductionUpgrades: {
                                ...state.habitatProductionUpgrades,
                                [id]: index + 1,
                              },
                            };
                            const projectedRate = habitatProductionPerSecond(projectedState, id);
                            const actionLabel =
                              upgradeState === 'purchased'
                                ? 'Purchased'
                                : upgradeState === 'available'
                                  ? `Buy · ${formatValue(cost)} Nature`
                                  : upgradeState === 'unaffordable'
                                    ? `Need ${formatValue(cost)} Nature`
                                    : isNext
                                      ? `Locked · Level ${owned}/${milestone}`
                                      : 'Locked · previous upgrade';
                            return (
                              <div
                                className={`living-habitat-upgrade living-habitat-upgrade--${upgradeState}`}
                                key={milestone}
                                data-upgrade-state={upgradeState}
                              >
                                <span>
                                  <strong>Level {milestone}</strong>
                                  <small>
                                    Production after upgrade: {formatValue(projectedRate)}{' '}
                                    Nature/sec
                                  </small>
                                </span>
                                <span className="living-habitat-upgrade-meta">
                                  Cost · {formatValue(cost)} N
                                  <button
                                    type="button"
                                    disabled={upgradeState !== 'available'}
                                    aria-label={`${name} level ${milestone} upgrade · ${actionLabel}`}
                                    onClick={() =>
                                      onStateChange(buyHabitatProductionUpgrade(state, id))
                                    }
                                  >
                                    {actionLabel}
                                  </button>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        <small className="living-habitat-upgrade-note">
                          {purchasedUpgradeCount} of 4 upgrades purchased · sequential milestones
                        </small>
                      </details>
                    </article>
                  );
                })}
              </div>
                </section>
                <article className="living-upgrades-card">
              <div className="living-section-heading">
                <div>
                  <span className="living-eyebrow">SEASONAL PROGRESSION</span>
                  <h2>Upgrades</h2>
                </div>
                <span className="living-pp-chip">{state.seasonalPP} PP</span>
              </div>
              <div className="living-upgrade-list">
                {PP_UPGRADES.map((upgrade) => {
                  const cost = ppUpgradeCost(state, upgrade);
                  return (
                    <button
                      className="living-upgrade"
                      type="button"
                      key={upgrade}
                      disabled={state.seasonalPP < cost || state.personalUpgrades[upgrade] >= 100}
                      onClick={() => onStateChange(buyPPUpgrade(state, upgrade))}
                    >
                      <span>
                        <strong>
                          {PP_UPGRADE_CONFIG[upgrade].label}{' '}
                          <small>Lv. {state.personalUpgrades[upgrade]}</small>
                        </strong>
                        <small>{PP_UPGRADE_CONFIG[upgrade].description}</small>
                      </span>
                      <b>{cost} PP</b>
                    </button>
                  );
                })}
              </div>
              <NatureBoostsPanel state={state} onStateChange={onStateChange} />
                </article>
              </>
            ) : (
              <>
                {((verifiedActions?.pending && !verifiedActions.heartClickPending) || verifiedSettlement?.pending) && (
                  <p className="living-verified-pending" role="status" aria-live="polite">
                    <i aria-hidden="true" /> Syncing Live progress…
                  </p>
                )}
                <VerifiedIslandPanel
                  island={verifiedIsland}
                  profile={verifiedProfile}
                  actions={verifiedActions}
                  settlement={verifiedSettlement}
                  habitatBuyAmount={habitatBuyAmount}
                  setHabitatBuyAmount={setHabitatBuyAmount}
                />
              </>
            )}
          </aside>
        </div>

        {mode === 'guest' && (
          <footer className="living-footer">
            {`Guest progress is saved in this browser · simulated points are not wallet rewards · reset in ${timeUntil(nextSeasonStart)}`}
          </footer>
        )}
      </main>
      {noticePresentation && (
        <div
          className={`living-notice${noticePresentation.important ? ' living-notice--important' : ''}${noticePresentation.exiting ? ' living-notice--exiting' : ''}`}
          role={noticePresentation.important ? 'alert' : 'status'}
          aria-live={noticePresentation.important ? 'assertive' : 'polite'}
        >
          <span>{noticePresentation.text}</span>
          <button type="button" onClick={onNoticeDismiss} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      )}
      <dialog
        className="living-how-to-play-dialog"
        aria-labelledby="living-how-to-play-title"
        onClose={() => setHowToPlayOpen(false)}
      >
        <header>
          <div>
            <div className="living-guide-title-row">
              <span className="living-guide-emblem" aria-hidden="true">✿</span>
              <div>
                <span className="living-eyebrow">YOUR FIELD GUIDE</span>
                <h2 id="living-how-to-play-title">How to play</h2>
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close How to play"
            onClick={() => setHowToPlayOpen(false)}
          >
            ×
          </button>
        </header>
        <div className="living-how-to-play-content">
          <p className="living-how-to-play-intro">
            {mode === 'verified'
              ? 'Restore your Live island, then settle progress securely through the verifier.'
              : 'Restore your island, grow your Nature, and begin each new run stronger.'}
          </p>
          <ol>
            {mode === 'verified' ? (
              <>
                <li><strong>Start a Live run.</strong><span>Open your Live account and start a run. Guest progress stays separate.</span></li>
                <li><strong>Collect and build.</strong><span>Click the Island Heart for Nature, then buy habitats to generate Nature over time.</span></li>
                <li><strong>Record or Rebirth.</strong><span>Record Points saves an optional checkpoint. Reach the score goal and Rebirth to settle rewards.</span></li>
                <li><strong>Continue.</strong><span>After Rebirth settles, start another Live run and use your available seasonal PP.</span></li>
              </>
            ) : (
              <>
                <li><strong>Collect Nature.</strong><span>Click the glowing Island Heart to gather Nature.</span></li>
                <li><strong>Grow production.</strong><span>Spend Nature on habitats; they generate Nature automatically. Habitat upgrades boost their production.</span></li>
                <li><strong>Use boosts.</strong><span>Nature boosts can speed up a run when their costs and requirements are met.</span></li>
                <li><strong>Rebirth.</strong><span>Reach the Nature goal to reset this run and earn simulated seasonal points for upgrades.</span></li>
              </>
            )}
          </ol>
          <p className="living-how-to-play-note">
            {mode === 'verified'
              ? 'Live rewards are verifier-backed. Guest saves and simulated rewards never convert into Live rewards.'
              : 'Guest progress is saved in this browser. Guest points are simulated and are not wallet rewards.'}
          </p>
        </div>
      </dialog>
      <dialog
        className="living-how-to-play-dialog living-leaderboard-dialog"
        aria-labelledby="living-leaderboard-title"
        onClose={() => setLeaderboardOpen(false)}
      >
        <header>
          <div className="living-leaderboard-title-row">
            <span className="living-leaderboard-emblem" aria-hidden="true">✦</span>
            <div>
              <span className="living-eyebrow">LIVE SEASON</span>
              <h2 id="living-leaderboard-title">Island keepers</h2>
            </div>
          </div>
          <button type="button" aria-label="Close leaderboard" onClick={() => setLeaderboardOpen(false)}>
            ×
          </button>
        </header>
        <div className="living-how-to-play-content living-leaderboard-content">
          <section className="living-season-summary" aria-label="Current global season">
            <div className="living-season-index">
              <span>SEASON</span>
              <strong>{leaderboard?.seasonNumber ? BigInt(leaderboard.seasonNumber).toLocaleString() : '—'}</strong>
            </div>
            <div className="living-season-dates">
              <span>This contract’s season</span>
              <strong>{formatSeasonDateRange(leaderboard?.seasonEndsAt)}</strong>
              <small>
                Onchain week ID {leaderboard?.seasonId ? BigInt(leaderboard.seasonId).toLocaleString() : '—'} · global across contracts
              </small>
            </div>
            <div className="living-season-countdown" aria-live="polite">
              <span>Reset in</span>
              <strong>{seasonSecondsRemaining === undefined ? '—' : formatSeasonCountdown(seasonSecondsRemaining)}</strong>
            </div>
          </section>
          <p className="living-leaderboard-subtitle">Rankings use confirmed Rebirth settlements.</p>
          <section className="living-community-cp" aria-label="Community seasonal CP progress">
            <div className="living-community-cp-heading">
              <span className="living-community-cp-icon" aria-hidden="true">✦</span>
              <strong>Community points</strong>
              <b>{formatCP(leaderboard?.communityCP)} <small>/ {formatCP(leaderboard?.communityCPCap)} CP cap</small></b>
            </div>
            <div
              className="living-community-cp-track"
              role="progressbar"
              aria-label="Community seasonal CP cap"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={leaderboardCPPercent(leaderboard?.communityCP, leaderboard?.communityCPCap)}
            >
              <i style={{ width: `${leaderboardCPPercent(leaderboard?.communityCP, leaderboard?.communityCPCap)}%` }} />
            </div>
            <small>Verified CP earned by everyone this season.</small>
          </section>
          <p className="living-leaderboard-note">
            Nature totals are added when a run settles. Unfinished runs are not counted yet.
          </p>
          {leaderboardLoading && <p role="status">Updating confirmed results…</p>}
          {leaderboardError && <p role="alert">{leaderboardError}</p>}
          {leaderboard?.indexing && (
            <p role="status">Indexing confirmed season history. Reopen or refresh to continue.</p>
          )}
          <div className="living-leaderboard-list" aria-label="Season rankings">
            {leaderboard?.entries.map((entry) => (
              <article className="living-leaderboard-entry" key={entry.wallet}>
                <div className="living-leaderboard-rank">{entry.rank}</div>
                <div className="living-leaderboard-player">
                  <span>Island keeper</span>
                  <code>{`${entry.wallet.slice(0, 6)}…${entry.wallet.slice(-4)}`}</code>
                </div>
                <div className="living-leaderboard-stat">
                  <span>Nature</span>
                  <strong>{formatSeasonNature(entry.settledNatureAtoms)}</strong>
                </div>
                <div className="living-leaderboard-stat living-leaderboard-stat--cp">
                  <span>Season CP</span>
                  <strong>{entry.cpEarned}</strong>
                </div>
              </article>
            ))}
            {leaderboard && leaderboard.entries.length === 0 && !leaderboardLoading && (
              <div className="living-leaderboard-empty">
                <span aria-hidden="true">✿</span>
                <strong>No settled runs yet</strong>
                <small>Be the first to complete a Live Rebirth this season.</small>
              </div>
            )}
          </div>
          <button className="living-primary-button" type="button" onClick={() => void refreshLeaderboard()} disabled={leaderboardLoading}>
            {leaderboardLoading ? 'Updating…' : 'Refresh leaderboard'}
          </button>
        </div>
      </dialog>
    </div>
  );
}
