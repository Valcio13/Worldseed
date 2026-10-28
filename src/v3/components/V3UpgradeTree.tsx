/**
 * V3 Upgrade Tree Component
 *
 * Displays available PP upgrades and their costs.
 */

import type { V3RunState, V3UpgradeKind, V3UpgradeConfig } from '../types';
import { V3_UPGRADE_CONFIG } from '../types';

interface V3UpgradeTreeProps {
  runState: V3RunState;
  onBuyUpgrade?: (upgrade: V3UpgradeKind, quantity: number) => void;
  /** Cost in PP for each upgrade level */
  upgradeCosts?: Record<V3UpgradeKind, number>;
}

const DEFAULT_UPGRADE_COSTS: Record<V3UpgradeKind, number> = {
  growth: 1,
  efficiency: 1,
  awakening: 1,
  rebirth: 1,
};

export function V3UpgradeTree({
  runState,
  onBuyUpgrade,
  upgradeCosts = DEFAULT_UPGRADE_COSTS,
}: V3UpgradeTreeProps) {
  const { seasonalPP, upgradeLevels, canAccessV3 } = runState;

  if (!canAccessV3) {
    return (
      <div className="v3-upgrade-tree v3-upgrade-tree--disabled">
        <div className="v3-upgrade-notice">
          <span>Connect wallet to access upgrades</span>
        </div>
      </div>
    );
  }

  const upgrades = (Object.values(V3_UPGRADE_CONFIG) as V3UpgradeConfig[]).filter(
    (upgrade) => upgrade.id !== 'rebirth',
  );

  return (
    <div className="v3-upgrade-tree" aria-label="V3 upgrade tree">
      <div className="v3-panel-heading">
        <span className="v3-panel-kicker">PERSONAL UPGRADES</span>
        <strong>Upgrade Tree</strong>
        <span className="v3-pp-display">{seasonalPP.toString()} PP available</span>
      </div>

      <ul className="v3-upgrade-list" role="list">
        {upgrades.map((upgrade) => {
          const currentLevel = upgradeLevels[upgrade.id];
          const cost = upgradeCosts[upgrade.id];
          const isMaxed = currentLevel >= upgrade.maxLevel;

          return (
            <li key={upgrade.id} className="v3-upgrade-item">
              <div className="v3-upgrade-header">
                <span className="v3-upgrade-name">
                  {upgrade.label}
                  <span className="v3-upgrade-level">Lv. {currentLevel}</span>
                </span>
                {!isMaxed && (
                  <span className="v3-upgrade-cost">{cost * (currentLevel + 1)} PP</span>
                )}
                {isMaxed && <span className="v3-upgrade-maxed">MAX</span>}
              </div>

              <p className="v3-upgrade-description">{upgrade.description}</p>

              <div className="v3-upgrade-progress">
                <div
                  className="v3-upgrade-progress-track"
                  role="progressbar"
                  aria-valuenow={currentLevel}
                  aria-valuemin={0}
                  aria-valuemax={upgrade.maxLevel}
                >
                  <span
                    className="v3-upgrade-progress-fill"
                    style={{ width: `${(currentLevel / upgrade.maxLevel) * 100}%` }}
                  />
                </div>
                <span className="v3-upgrade-progress-label">
                  {currentLevel} / {upgrade.maxLevel}
                </span>
              </div>

              {!isMaxed && (
                <div className="v3-upgrade-buy">
                  {[1, 5, 10].map((amount) => {
                    const totalCost = cost * amount;
                    const canAffordAmount = seasonalPP >= BigInt(totalCost);
                    return (
                      <button
                        key={amount}
                        type="button"
                        className="v3-upgrade-buy-button"
                        disabled={!canAffordAmount}
                        onClick={() => onBuyUpgrade?.(upgrade.id, amount)}
                        aria-label={`Buy ${amount} ${upgrade.label} for ${totalCost} PP`}
                      >
                        +{amount}
                      </button>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
