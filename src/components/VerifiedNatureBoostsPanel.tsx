import type { V3GameplayCommand } from '../v3/types';

export interface VerifiedNatureBoostsState {
  natureSurgeCost: string;
  natureSurgeRemainingMs: number;
  canBuyNatureSurge: boolean;
  fertileSoilLevel: number;
  fertileSoilMaxLevel: number;
  fertileSoilNextCost: string | null;
  canBuyFertileSoil: boolean;
  timeBloomUsed: boolean;
  timeBloomCost: string | null;
  canBuyTimeBloom: boolean;
  timeBloomUnavailableReason?: string | null;
}

interface VerifiedNatureBoostsPanelProps {
  rulesVersion: number;
  upgrades: VerifiedNatureBoostsState | null;
  pending?: boolean;
  onCommand: (command: V3GameplayCommand) => void;
}

export function VerifiedNatureBoostsPanel({
  rulesVersion,
  upgrades,
  pending = false,
  onCommand,
}: VerifiedNatureBoostsPanelProps) {
  if (rulesVersion !== 3) {
    return (
      <section className="living-verified-boosts" aria-label="Live Nature upgrades">
        <h3 className="living-verified-boosts-title">Nature boosts</h3>
        <p className="living-verified-empty" role="status">
          Nature Surge, Fertile Soil, and Time Bloom require a Rules V3 Live run.
        </p>
      </section>
    );
  }

  if (!upgrades) {
    return (
      <section className="living-verified-boosts" aria-label="Live Nature upgrades">
        <h3 className="living-verified-boosts-title">Nature boosts</h3>
        <p className="living-verified-empty" role="status">Syncing Live upgrade status…</p>
      </section>
    );
  }

  const surgeSeconds = Math.ceil(upgrades.natureSurgeRemainingMs / 1_000);
  const soilMaxed = upgrades.fertileSoilLevel >= upgrades.fertileSoilMaxLevel;

  return (
    <section className="living-verified-boosts" aria-label="Live Nature upgrades">
      <h3 className="living-verified-boosts-title">Nature boosts</h3>
      <div className="living-boosts" aria-label="Live upgrade purchases">
        <button
          type="button"
          data-upgrade-state={surgeSeconds > 0 ? 'active' : upgrades.canBuyNatureSurge ? 'available' : 'unaffordable'}
          disabled={pending || !upgrades.canBuyNatureSurge}
          aria-label={`Nature Surge · ${upgrades.natureSurgeCost} Nature${surgeSeconds > 0 ? ` · active ${surgeSeconds} seconds` : ''}`}
          onClick={() => onCommand({ type: 'buy-temporary-upgrade', upgrade: 'nature-surge' })}
        >
          <span>
            <strong>Nature Surge</strong>
            <small>
              4× production · 30 sec{surgeSeconds > 0 ? ` · Active ${surgeSeconds}s remaining` : ''}
            </small>
          </span>
          <b>{upgrades.canBuyNatureSurge ? `Buy · ${upgrades.natureSurgeCost} N` : `Need ${upgrades.natureSurgeCost} N`}</b>
        </button>

        <button
          type="button"
          data-upgrade-state={soilMaxed ? 'maxed' : upgrades.canBuyFertileSoil ? 'available' : 'unaffordable'}
          disabled={pending || soilMaxed || !upgrades.canBuyFertileSoil}
          aria-label={soilMaxed
            ? `Fertile Soil maxed at level ${upgrades.fertileSoilLevel}`
            : `Buy Fertile Soil level ${upgrades.fertileSoilLevel + 1} for ${upgrades.fertileSoilNextCost ?? '—'} Nature`}
          onClick={() => onCommand({ type: 'buy-fertile-soil' })}
        >
          <span>
            <strong>Fertile Soil · {upgrades.fertileSoilLevel}/{upgrades.fertileSoilMaxLevel}</strong>
            <small>+10% production per level</small>
          </span>
          <b>{soilMaxed ? 'MAX' : upgrades.canBuyFertileSoil ? `Buy · ${upgrades.fertileSoilNextCost} N` : `Need ${upgrades.fertileSoilNextCost ?? '—'} N`}</b>
        </button>

        <button
          type="button"
          data-upgrade-state={upgrades.timeBloomUsed ? 'used' : upgrades.canBuyTimeBloom ? 'available' : 'locked'}
          disabled={pending || upgrades.timeBloomUsed || !upgrades.canBuyTimeBloom}
          aria-label={upgrades.timeBloomUsed
            ? 'Time Bloom used this run'
            : `Buy Time Bloom for ${upgrades.timeBloomCost ?? '—'} Nature`}
          onClick={() => onCommand({ type: 'buy-time-bloom' })}
        >
          <span>
            <strong>Time Bloom</strong>
            <small>
              Costs {upgrades.timeBloomCost ? `${upgrades.timeBloomCost} N` : '20 sec of production'}
              {' · Instantly grants 30 sec · once per run'}
            </small>
          </span>
          <b>
            {upgrades.timeBloomUsed
              ? 'Used this run'
              : upgrades.canBuyTimeBloom
                ? `Buy · ${upgrades.timeBloomCost} N`
                : upgrades.timeBloomUnavailableReason ?? `Need ${upgrades.timeBloomCost ?? '—'} N`}
          </b>
        </button>
      </div>
    </section>
  );
}
