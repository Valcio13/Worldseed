/**
 * V3 Run Controls Component
 *
 * Provides Start Run, Record Points, and Rebirth controls.
 */

import { useState } from 'react';
import type { V3RunState, V3UpgradeKind, TransactionState } from '../types';
import { V3_UPGRADE_CONFIG } from '../types';
import { ppUpgradeCost } from '../../incremental/rulesV1';

interface V3RunControlsProps {
  runState: V3RunState;
  transactionState: TransactionState;
  onStartRun?: (upgrades: Array<{ upgradeId: number; quantity: number }>) => Promise<void>;
  onRecordPoints?: () => Promise<void>;
  onRebirth?: () => Promise<void>;
  onAbandonRun?: () => Promise<void>;
}

const UPGRADE_IDS: Record<V3UpgradeKind, number> = {
  growth: 0,
  efficiency: 1,
  awakening: 2,
  rebirth: 3,
};

function selectedUpgradeCost(
  selected: Record<V3UpgradeKind, number>,
  currentLevels: Record<V3UpgradeKind, number>,
): bigint {
  return (Object.keys(selected) as V3UpgradeKind[]).reduce((total, upgrade) => {
    const quantity = selected[upgrade];
    return quantity > 0
      ? total + ppUpgradeCost(currentLevels[upgrade], quantity)
      : total;
  }, 0n);
}

export function V3RunControls({
  runState,
  transactionState,
  onStartRun,
  onRecordPoints,
  onRebirth,
  onAbandonRun,
}: V3RunControlsProps) {
  const {
    wallet,
    runId,
    run,
    canAccessV3,
    isStarting,
    seasonalPP,
    seasonalCP,
    lifetimeCP,
    seasonRebirths,
    upgradeLevels,
  } = runState;
  const [selectedUpgrades, setSelectedUpgrades] = useState<Record<V3UpgradeKind, number>>({
    growth: 0,
    efficiency: 0,
    awakening: 0,
    rebirth: 0,
  });
  const allocationCost = selectedUpgradeCost(selectedUpgrades, upgradeLevels);
  const allocationAffordable = allocationCost <= seasonalPP;
  const remainingPP = allocationAffordable ? seasonalPP - allocationCost : 0n;
  const allocationError = allocationAffordable
    ? null
    : `Selected upgrades cost ${allocationCost} PP, but only ${seasonalPP} PP is available.`;

  const hasActiveRun = runId > 0n && run?.status === 'ACTIVE';
  const isProcessing = transactionState === 'pending' || isStarting;

  const handleStartRun = async () => {
    if (!onStartRun) return;
    if (!allocationAffordable) return;

    const upgrades = Object.entries(selectedUpgrades)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => ({ upgradeId: UPGRADE_IDS[id as V3UpgradeKind], quantity: qty }));

    await onStartRun(upgrades);
  };

  const handleUpgradeSelect = (upgrade: V3UpgradeKind, delta: number) => {
    setSelectedUpgrades((prev) => {
      const newValue = Math.max(0, prev[upgrade] + delta);
      const maxLevel = Math.max(0, V3_UPGRADE_CONFIG[upgrade].maxLevel - upgradeLevels[upgrade]);
      const nextValue = Math.min(newValue, maxLevel);
      if (nextValue > prev[upgrade]) {
        const currentAllocationCost = selectedUpgradeCost(prev, upgradeLevels);
        const nextLevelCost = ppUpgradeCost(upgradeLevels[upgrade] + prev[upgrade], 1);
        if (currentAllocationCost + nextLevelCost > seasonalPP) return prev;
      }
      return { ...prev, [upgrade]: nextValue };
    });
  };

  // Not configured state
  if (!canAccessV3 && runState.isConfigured === false) {
    return (
      <div className="v3-run-controls v3-run-controls--unconfigured">
        <div className="v3-controls-notice">
          <span className="v3-notice-icon" aria-hidden="true">
            ⚙
          </span>
          <div>
            <strong>V3 Not Configured</strong>
            <p>Set VITE_WORLDSEED_V3_CONTRACT_ADDRESS to enable verified runs.</p>
          </div>
        </div>
      </div>
    );
  }

  // Wallet not connected
  if (!wallet) {
    return (
      <div className="v3-run-controls v3-run-controls--needs-wallet">
        <div className="v3-controls-notice">
          <span className="v3-notice-icon" aria-hidden="true">
            👛
          </span>
          <div>
            <strong>Connect Wallet</strong>
            <p>Connect your wallet to start a verified run and earn real rewards.</p>
          </div>
        </div>
      </div>
    );
  }

  // Wrong network
  if (!runState.isCorrectChain) {
    return (
      <div className="v3-run-controls v3-run-controls--wrong-network">
        <div className="v3-controls-notice">
          <span className="v3-notice-icon" aria-hidden="true">
            🔗
          </span>
          <div>
            <strong>Wrong Network</strong>
            <p>Switch to Hemi Sepolia to access V3 verified runs.</p>
          </div>
        </div>
      </div>
    );
  }

  // No active run - show start options
  if (!hasActiveRun) {
    return (
      <div className="v3-run-controls" aria-label="V3 run controls">
        <div className="v3-panel-heading">
          <span className="v3-panel-kicker">VERIFIED PROGRESSION</span>
          <strong>Start Your Run</strong>
        </div>

        <div className="v3-start-info">
          <p>
            Start a verified run to earn Community Points (CP) on the separate V3 seasonal ledger.
            Your progress is recorded on-chain and verified by the V3 protocol.
          </p>
        </div>

        <div className="v3-start-upgrades">
          <h4>Starting Upgrades (Optional)</h4>
          <p>
            Available seasonal PP: {seasonalPP.toString()} · Remaining: {remainingPP.toString()}
          </p>
          <p className="v3-upgrades-hint">
            Choose upgrades before starting; they are applied atomically with the Start Run
            transaction.
          </p>

          {(Object.keys(V3_UPGRADE_CONFIG) as V3UpgradeKind[])
            .filter((upgradeId) => upgradeId !== 'rebirth')
            .map((upgradeId) => {
              const config = V3_UPGRADE_CONFIG[upgradeId];
              const level = selectedUpgrades[upgradeId];
              const maxSelectableLevel = Math.max(0, config.maxLevel - upgradeLevels[upgradeId]);

              return (
                <div key={upgradeId} className="v3-start-upgrade-row">
                  <span className="v3-start-upgrade-name">
                    {config.label}
                    <small>{config.description}</small>
                    <small>Current level: {upgradeLevels[upgradeId]}</small>
                    {level < maxSelectableLevel && (
                      <small>
                        Next level: {ppUpgradeCost(upgradeLevels[upgradeId] + level, 1).toString()} PP
                      </small>
                    )}
                  </span>
                  <div className="v3-start-upgrade-controls">
                    <button
                      type="button"
                      className="v3-upgrade-adjust"
                      disabled={level <= 0}
                      onClick={() => handleUpgradeSelect(upgradeId, -1)}
                      aria-label={`Decrease ${config.label}`}
                    >
                      −
                    </button>
                    <span className="v3-upgrade-level-display">{level}</span>
                    <button
                      type="button"
                      className="v3-upgrade-adjust"
                      disabled={
                        level >= maxSelectableLevel ||
                        ppUpgradeCost(upgradeLevels[upgradeId] + level, 1) > remainingPP
                      }
                      onClick={() => handleUpgradeSelect(upgradeId, 1)}
                      aria-label={`Increase ${config.label}`}
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
        </div>

        <div className="v3-start-actions">
          {allocationError && <p role="alert">{allocationError}</p>}
          <button
            type="button"
            className="v3-primary-button"
            onClick={handleStartRun}
            disabled={isProcessing || !allocationAffordable}
          >
            {isProcessing ? (
              <>
                <span className="v3-spinner" aria-hidden="true" />
                Starting Run...
              </>
            ) : (
              <>
                Start Verified Run <span>→</span>
              </>
            )}
          </button>

          <p className="v3-start-note">
            This requires a blockchain transaction. Guest progress remains separate.
          </p>
        </div>
      </div>
    );
  }

  // Has active run - show run actions
  return (
    <div className="v3-run-controls v3-run-controls--active" aria-label="V3 run controls">
      <div className="v3-panel-heading">
        <span className="v3-panel-kicker">RUN #{runId.toString()}</span>
        <strong>Run Controls</strong>
      </div>

      <div className="v3-run-actions">
        {/* Record Points - optional checkpoint */}
        <button
          type="button"
          className="v3-secondary-button"
          onClick={onRecordPoints}
          disabled={isProcessing || !onRecordPoints}
        >
          <span>Record Points</span>
          <small>Checkpoint your score (optional)</small>
        </button>

        {/* Rebirth - required for claiming rewards */}
        <button
          type="button"
          className="v3-primary-button"
          onClick={onRebirth}
          disabled={isProcessing || !onRebirth}
        >
          <span>Rebirth</span>
          <small>End this run and claim seasonal rewards</small>
        </button>
      </div>

      <div className="v3-run-stats">
        <div className="v3-stat-item">
          <span>Season CP</span>
          <strong>{seasonalCP.toString()}</strong>
        </div>
        <div className="v3-stat-item">
          <span>Lifetime CP</span>
          <strong>{lifetimeCP.toString()}</strong>
        </div>
        <div className="v3-stat-item">
          <span>Rebirths</span>
          <strong>{seasonRebirths}</strong>
        </div>
      </div>

      {/* Abandon option */}
      <details className="v3-abandon-section">
        <summary>Need to start over?</summary>
        <p>
          Abandoning your run will forfeit all progress this season. You can start a new run after
          abandoning.
        </p>
        <button
          type="button"
          className="v3-danger-button"
          onClick={onAbandonRun}
          disabled={isProcessing}
        >
          Abandon Run
        </button>
      </details>
    </div>
  );
}

export type { V3RunControlsProps } from '../types';
