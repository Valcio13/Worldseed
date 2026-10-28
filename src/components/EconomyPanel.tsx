import {
  buyHabitat,
  buyPPUpgrade,
  buyTemporaryUpgrade,
  calculateBuyQuantity,
  habitatBulkCost,
  habitatUnitCost,
  habitatProductionPerSecond,
  PP_UPGRADE_CONFIG,
  ppUpgradeCost,
  rebirthRequirement,
  rebirthReward,
  canRebirth,
  type ActionResult,
  type BuyAmount,
  type EconomyState,
  type HabitatKind,
  type PPUpgrade,
  type TemporaryUpgrade,
} from '../incremental/engine';
import { compareValues, formatValue } from '../incremental/decimal';

const HABITATS: Array<{ id: HabitatKind; label: string; icon: string; hint: string }> = [
  { id: 'water', label: 'Water', icon: '≈', hint: 'Supports every growing island.' },
  { id: 'grass', label: 'Grass', icon: '✿', hint: 'Gains strength beside Water.' },
  { id: 'forest', label: 'Forest', icon: '♧', hint: 'Strong production beside Grass.' },
];
const AMOUNTS: BuyAmount[] = [1, 10, 100, 'max'];
const PP_UPGRADES: PPUpgrade[] = ['growth', 'efficiency', 'awakening', 'rebirth'];

interface EconomyPanelProps {
  state: EconomyState;
  nextSeasonStart: number;
  onHeartClick: () => void;
  onStateChange: (result: ActionResult) => void;
  onRebirth: () => void;
}

function timeUntil(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((timestamp - Date.now()) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}

function utcResetLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(timestamp);
}

export function EconomyPanel({
  state,
  nextSeasonStart,
  onHeartClick,
  onStateChange,
  onRebirth,
}: EconomyPanelProps) {
  const requirement = rebirthRequirement(state);
  const exponentDelta = state.runNature.exponent - requirement.exponent;
  const progress =
    exponentDelta > 250
      ? 100
      : exponentDelta < -250
        ? 0
        : Math.min(
            100,
            (state.runNature.mantissa / requirement.mantissa) * 10 ** exponentDelta * 100,
          );
  const reward = rebirthReward(state);

  function send(result: ActionResult) {
    onStateChange(result);
  }

  return (
    <div className="economy-panel" aria-label="Island growth and upgrades">
      <div className="game-panel-heading">
        <span className="game-panel-kicker">GUEST SEASON {state.seasonId}</span>
        <strong>Grow your island</strong>
      </div>
      <div className="economy-objective">
        <span>Begin with the Heart</span>
        <p>Click the Island Heart for Nature, then grow habitats to earn more every second.</p>
        <button type="button" className="heart-click-button" onClick={onHeartClick}>
          <span aria-hidden="true">✧</span> Click Island Heart <b>+1 Nature</b>
        </button>
      </div>

      <section className="economy-habitat-shop" aria-label="Habitat upgrades">
        <h3>Habitat growth</h3>
        {HABITATS.map(({ id, label, icon, hint }) => {
          return (
            <article className={`economy-habitat economy-habitat--${id}`} key={id}>
              <div className="economy-habitat-heading">
                <span className="economy-habitat-icon" aria-hidden="true">
                  {icon}
                </span>
                <span>
                  <b>{label}</b>
                  <small>Level {state.habitats[id]}</small>
                </span>
                <strong>
                  {formatValue(habitatProductionPerSecond(state, id))}
                  <small>/sec</small>
                </strong>
              </div>
              <p>{hint}</p>
              <div
                className="economy-habitat-buy"
                role="group"
                aria-label={`Buy ${label} habitats`}
              >
                {AMOUNTS.map((amount) => {
                  const quantity = calculateBuyQuantity(state, id, amount);
                  const affordable =
                    quantity > 0 &&
                    compareValues(habitatBulkCost(state, id, quantity), state.nature) <= 0;
                  return (
                    <button
                      key={String(amount)}
                      type="button"
                      disabled={!affordable}
                      onClick={() => send(buyHabitat(state, id, amount))}
                      aria-label={`Buy ${amount === 'max' ? 'maximum' : amount} ${label}`}
                    >
                      {amount === 'max' ? 'Max' : amount}
                    </button>
                  );
                })}
              </div>
              <small className="economy-next-cost">
                Next: {formatValue(habitatUnitCost(state, id))} Nature
              </small>
            </article>
          );
        })}
      </section>

      <section className="economy-boosts" aria-label="Temporary production boosts">
        <h3>Seasonal boosts</h3>
        {(['sunny-season', 'deep-roots'] as TemporaryUpgrade[]).map((upgrade) => {
          const config =
            upgrade === 'sunny-season'
              ? { label: 'Sunny Season', cost: 150, seconds: 60 }
              : { label: 'Deep Roots', cost: 1_500, seconds: 90 };
          return (
            <button
              className="economy-boost-button"
              type="button"
              key={upgrade}
              onClick={() => send(buyTemporaryUpgrade(state, upgrade))}
              disabled={compareValues(state.nature, { mantissa: config.cost, exponent: 0 }) < 0}
            >
              <span>
                {config.label}
                <small>{config.seconds}s · 2× / 3× Nature</small>
              </span>
              <b>
                {state.temporaryUpgrades[upgrade] > 0
                  ? `${Math.ceil(state.temporaryUpgrades[upgrade])}s`
                  : `${config.cost} N`}
              </b>
            </button>
          );
        })}
      </section>

      <section className="economy-rebirth" aria-label="Rebirth progress">
        <div className="economy-section-heading">
          <h3>Rebirth</h3>
          <b>{state.seasonRebirths} this season</b>
        </div>
        <p>
          Reach {formatValue(requirement)} total run Nature. You can keep growing after it unlocks.
        </p>
        <div
          className="economy-rebirth-track"
          role="progressbar"
          aria-label="Rebirth progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="economy-rebirth-reward">
          Next rebirth: <b>+{reward.pp} PP</b> · <b>+{reward.cp} simulated CP</b>
        </div>
        <button
          className="primary-button economy-rebirth-button"
          type="button"
          disabled={!canRebirth(state)}
          onClick={onRebirth}
        >
          Rebirth and grow stronger
        </button>
      </section>

      <details className="economy-pp-tree">
        <summary>Seasonal upgrades · {state.seasonalPP} PP</summary>
        <p className="simulated-points-note">
          Guest PP and CP are simulated locally and never become wallet rewards.
        </p>
        {PP_UPGRADES.map((upgrade) => (
          <button
            className="economy-pp-upgrade"
            key={upgrade}
            type="button"
            disabled={
              state.seasonalPP < ppUpgradeCost(state, upgrade) ||
              state.personalUpgrades[upgrade] >= 100
            }
            onClick={() => send(buyPPUpgrade(state, upgrade))}
          >
            <span>
              <b>
                {PP_UPGRADE_CONFIG[upgrade].label} {state.personalUpgrades[upgrade]}
              </b>
              <small>{PP_UPGRADE_CONFIG[upgrade].description}</small>
            </span>
            <strong>{ppUpgradeCost(state, upgrade)} PP</strong>
          </button>
        ))}
      </details>

      <div className="economy-season-note">
        <strong>Next reset in {timeUntil(nextSeasonStart)}</strong>
        <span>Monday {utcResetLabel(nextSeasonStart)} UTC</span>
        <small>
          Local simulated points · {state.seasonalPP} PP · {state.seasonalCP} CP this season ·{' '}
          {state.lifetimeCP} lifetime CP. These are separate from wallet rewards.
        </small>
      </div>
    </div>
  );
}
