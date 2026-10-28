import {
  buyFertileSoil,
  buyTemporaryUpgrade,
  buyTimeBloom,
  FERTILE_SOIL_MAX_LEVEL,
  fertileSoilCost,
  productionPerSecond,
  timeBloomCost,
  type ActionResult,
  type EconomyState,
  type TemporaryUpgrade,
} from '../incremental/engine';
import { compareValues, formatValue } from '../incremental/decimal';

const TEMPORARY_BOOSTS: Array<{
  id: TemporaryUpgrade;
  label: string;
  effect: string;
  cost: number;
}> = [
  { id: 'sunny-season', label: 'Sunny Season', effect: '2× production · 60 sec', cost: 150 },
  { id: 'deep-roots', label: 'Deep Roots', effect: '3× production · 90 sec', cost: 1_500 },
  { id: 'nature-surge', label: 'Nature Surge', effect: '4× production · 30 sec', cost: 1_500 },
];

interface NatureBoostsPanelProps {
  state: EconomyState;
  onStateChange: (result: ActionResult) => void;
}

/** Guest-only shop purchases; intentionally not connected to verified command state. */
export function NatureBoostsPanel({ state, onStateChange }: NatureBoostsPanelProps) {
  const soilLevel = state.fertileSoilLevel ?? 0;
  const soilCost = fertileSoilCost(state);
  const bloomCost = timeBloomCost(state);
  const hasProduction = compareValues(productionPerSecond(state), { mantissa: 0, exponent: 0 }) > 0;

  return (
    <section aria-labelledby="nature-boosts-title">
      <h3 id="nature-boosts-title" className="living-eyebrow">NATURE BOOSTS</h3>
      <div className="living-boosts" aria-label="Nature Boost purchases">
        {TEMPORARY_BOOSTS.map(({ id, label, effect, cost }) => {
          const remaining = state.temporaryUpgrades[id] ?? 0;
          return (
            <button
              type="button"
              key={id}
              onClick={() => onStateChange(buyTemporaryUpgrade(state, id))}
              disabled={compareValues(state.nature, { mantissa: cost, exponent: 0 }) < 0}
              aria-label={`${label} · ${cost} Nature${remaining > 0 ? ` · active ${Math.ceil(remaining)} seconds, purchase refreshes` : ''}`}
            >
              <span>
                <strong>{label}</strong>
                <small>{effect}{remaining > 0 ? ` · Active ${Math.ceil(remaining)}s; purchase refreshes` : ''}</small>
              </span>
              <b>{cost} N</b>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onStateChange(buyFertileSoil(state))}
          disabled={soilLevel >= FERTILE_SOIL_MAX_LEVEL || compareValues(state.nature, soilCost) < 0}
          aria-label={
            soilLevel >= FERTILE_SOIL_MAX_LEVEL
              ? 'Fertile Soil maxed for this run'
              : `Buy Fertile Soil level ${soilLevel + 1} for ${formatValue(soilCost)} Nature`
          }
        >
          <span>
            <strong>Fertile Soil · {soilLevel}/{FERTILE_SOIL_MAX_LEVEL}</strong>
            <small>+10% production per level · resets on Rebirth</small>
          </span>
          <b>{soilLevel >= FERTILE_SOIL_MAX_LEVEL ? 'MAX' : `${formatValue(soilCost)} N`}</b>
        </button>
        <button
          type="button"
          onClick={() => onStateChange(buyTimeBloom(state))}
          disabled={Boolean(state.timeBloomUsed) || !hasProduction || compareValues(state.nature, bloomCost) < 0}
          aria-label={
            state.timeBloomUsed
              ? 'Time Bloom used this run'
              : hasProduction
                ? `Buy Time Bloom for ${formatValue(bloomCost)} Nature`
                : 'Time Bloom requires a habitat'
          }
        >
          <span>
            <strong>Time Bloom</strong>
            <small>Instantly grants 30 sec of production · once per run</small>
          </span>
          <b>{state.timeBloomUsed ? 'Used' : hasProduction ? `${formatValue(bloomCost)} N` : 'Build a habitat'}</b>
        </button>
      </div>
    </section>
  );
}
