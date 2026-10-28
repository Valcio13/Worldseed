import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  HABITATS as ECONOMY_HABITATS,
  HABITAT_UPGRADE_MILESTONES,
  buyHabitat,
  buyHabitatProductionUpgrade,
  buyPPUpgrade,
  calculateBuyQuantity,
  habitatProductionPerSecond,
  habitatProductionUpgradeCost,
  habitatUnitCost,
  PP_UPGRADE_CONFIG,
  ppUpgradeCost,
  rebirthRequirement,
  rebirthReward,
  canRebirth,
  productionPerSecond,
  type ActionResult,
  type EconomyState,
  type HabitatKind,
  type PPUpgrade,
} from '../incremental/engine';
import { compareValues, formatValue } from '../incremental/decimal';
import { NatureBoostsPanel } from './NatureBoostsPanel';
import {
  islandGrowthStage,
  islandGrowthStageForHabitatCount,
  islandGrowthStageProgress,
  islandGrowthStageProgressForHabitatCount,
  type IslandGrowthStage,
} from './islandGrowthStage';
import type { V3IslandSnapshot } from '../v3/components/V3VerifiedGameplay';

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

const ISLAND_CREATURES: Record<IslandGrowthStage, Array<'moss' | 'pip' | 'luma'>> = {
  seed: [],
  sprout: ['moss'],
  growing: ['moss', 'pip'],
  flourishing: ['moss', 'pip', 'luma'],
};

type IslandCreatureKind = 'moss' | 'pip' | 'luma';
type CreaturePosition = { left: number; top: number };
type CreatureWanderArea = {
  start: CreaturePosition;
  left: [number, number];
  top: [number, number];
  walkMs: number;
};

const CREATURE_WANDER_AREAS: Record<
  IslandCreatureKind,
  { desktop: CreatureWanderArea; mobile: CreatureWanderArea }
> = {
  moss: {
    desktop: { start: { left: 23, top: 60 }, left: [20, 27], top: [58, 63], walkMs: 1250 },
    mobile: { start: { left: 2, top: 58 }, left: [0, 5], top: [57, 60], walkMs: 1050 },
  },
  pip: {
    desktop: { start: { left: 76, top: 39 }, left: [72, 80], top: [35, 45], walkMs: 1450 },
    mobile: { start: { left: 84, top: 25 }, left: [82, 86], top: [21, 28], walkMs: 1200 },
  },
  luma: {
    desktop: { start: { left: 69, top: 55 }, left: [67, 75], top: [52, 61], walkMs: 1650 },
    mobile: { start: { left: 78, top: 45 }, left: [76, 80], top: [43, 50], walkMs: 1450 },
  },
};

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

function randomBetween([min, max]: [number, number]): number {
  return min + Math.random() * (max - min);
}

function IslandCreature({ creature }: { creature: IslandCreatureKind }) {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches === true,
  );
  const area = CREATURE_WANDER_AREAS[creature][compact ? 'mobile' : 'desktop'];
  const [position, setPosition] = useState(area.start);
  const positionRef = useRef(area.start);
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
        const next = { left: randomBetween(area.left), top: randomBetween(area.top) };
        setFacingLeft(next.left < positionRef.current.left);
        positionRef.current = next;
        setPosition(next);
        setWalking(true);
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
    };
  }, [area, reduceMotion]);

  return (
    <span
      className={`island-creature island-creature--${creature}${walking ? ' island-creature--walking' : ''}${facingLeft ? ' island-creature--facing-left' : ''}`}
      data-creature={creature}
      data-walking={walking}
      data-facing={facingLeft ? 'left' : 'right'}
      data-testid={`island-creature-${creature}`}
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
  verifiedHeartAction?: (() => void) | null;
  nextSeasonStart: number;
  saveLabel: string;
  walletControl?: ReactNode;
  audioControls?: ReactNode;
  verifiedProgression?: ReactNode;
  onModeChange?: (mode: LivingIslandMode) => void;
  notice?: string;
  onHeartClick: () => void;
  onStateChange: (result: ActionResult) => void;
  onRebirth: () => void;
}

export type LivingIslandMode = 'guest' | 'verified';

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

function LivingIsland({
  state,
  mode,
  verifiedIsland,
  onHeartClick,
}: {
  state: EconomyState;
  mode: LivingIslandMode;
  verifiedIsland: V3IslandSnapshot | null;
  onHeartClick: (() => void) | null;
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
            ? `Verified Living Island, ${stage} stage`
            : 'Verified Living Island, waiting for an active run'
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
        {Array.from({ length: visibleTrees }, (_, index) => (
          <img
            key={index}
            className={`living-tree living-tree--${index + 1}${index % 2 ? ' living-tree--thin' : ''}`}
            src={`${CRAFTPIX_ASSET_ROOT}${index % 2 ? 'pine-tree-thin.png' : 'pine-tree-small.png'}`}
            alt=""
            data-craftpix-sprite={index % 2 ? 'pine-tree-thin.png' : 'pine-tree-small.png'}
          />
        ))}
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
        disabled={isVerified && !onHeartClick}
        onClick={() => {
          if (!onHeartClick) return;
          onHeartClick();
          if (!isVerified) setHeartClicks((clicks) => clicks + 1);
        }}
        aria-label={
          isVerified ? 'Click the verified Island Heart to collect 1 Nature' : 'Click the Island Heart to collect 1 Nature'
        }
        title={isVerified ? 'Verified click · +1 Nature' : 'Click to collect +1 Nature'}
      >
        <span key={heartClicks} className="island-heart-sprite" aria-hidden="true" />
        {heartClicks > 0 && (
          <span key={`feedback-${heartClicks}`} className="heart-click-feedback" aria-hidden="true">
            +1 Nature
          </span>
        )}
        <span className="island-heart-label">
          {isVerified ? 'Verified · Collect Nature' : 'Collect Nature'}
        </span>
        <strong>+1</strong>
      </button>
      <div className="island-stage-info">
        <div className="island-stage-label">
          <span /> {isVerified && !verifiedIsland ? 'Waiting for verified run' : stage}
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
  nextSeasonStart,
  saveLabel,
  walletControl,
  audioControls,
  verifiedProgression,
  onModeChange = () => undefined,
  notice,
  onHeartClick,
  onStateChange,
  onRebirth,
}: LivingIslandScreenProps) {
  const reward = rebirthReward(state);
  const progress = rebirthProgress(state);

  return (
    <div className="living-game">
      <header className={`living-topbar${verifiedModeEnabled ? ' living-topbar--modes' : ''}`}>
        <a className="living-brand" href="#living-home" aria-label="Worldseed home">
          <span className="living-brand-seed" aria-hidden="true">
            ✦
          </span>
          <span>worldseed</span>
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
                Verified
              </button>
            </div>
          ) : (
            <span className="v3-mode-badge" title="Guest progress is saved locally in this browser">
              Guest
            </span>
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
          {walletControl}
        </div>
      </header>

      <main className="living-main" id="living-home">
        <div className="living-desktop-layout">
          <div className="living-island-column">
            <section className="living-resource-bar" aria-label="Island resources">
              <div className="living-resource living-resource--nature">
                <span>{mode === 'verified' ? 'Verified Nature' : 'Guest Nature'}</span>
                <strong data-testid={mode === 'verified' ? 'verified-nature-counter' : 'nature-counter'}>
                  {mode === 'verified' ? verifiedIsland?.nature ?? '—' : formatValue(state.nature)}
                </strong>
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
            />
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
              <div className="living-section-heading">
                <div>
                  <span className="living-eyebrow">HELP YOUR ISLAND GROW</span>
                  <h1 id="habitat-shop-title">Habitat shop</h1>
                </div>
                <span className="living-resource-chip">{formatValue(state.nature)} Nature</span>
              </div>
              <div className="living-habitat-list">
                {ECONOMY_HABITATS.map((id) => {
                  const { name, icon, description } = HABITAT_PRESENTATION[id];
                  const owned = state.habitats[id] ?? 0;
                  const one = calculateBuyQuantity(state, id, 1);
                  const max = calculateBuyQuantity(state, id, 'max');
                  const oneCost = habitatUnitCost(state, id);
                  const oneAffordable = one > 0 && compareValues(oneCost, state.nature) <= 0;
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
                          onClick={() => onStateChange(buyHabitat(state, id, 1))}
                          disabled={!oneAffordable}
                          aria-label={`Buy 1 ${name}`}
                        >
                          +1 <small>{formatValue(oneCost)}</small>
                        </button>
                        <button
                          type="button"
                          onClick={() => onStateChange(buyHabitat(state, id, 'max'))}
                          disabled={max === 0}
                          aria-label={`Buy maximum ${name}`}
                        >
                          Max
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
              verifiedProgression
            )}
          </aside>
        </div>

        {notice && (
          <p className="living-notice" role="status" aria-live="polite">
            {notice}
          </p>
        )}
        <footer className="living-footer">
          {mode === 'guest'
            ? `Guest progress is saved in this browser · simulated points are not wallet rewards · reset in ${timeUntil(nextSeasonStart)}`
            : 'Verified progress is sourced from the V3 verifier and contract. Guest saves are separate.'}
        </footer>
      </main>
    </div>
  );
}
