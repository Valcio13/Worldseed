/**
 * V3 Status Panel Component
 *
 * Displays run status, score tier, season info, and progression.
 */

import { useMemo } from 'react';
import type { V3RunState } from '../types';
import { TARGET_NETWORK_LABEL, V3_CONTRACT_ADDRESS_ENV } from '../../blockchain/networkPresentation';

interface V3StatusPanelProps {
  runState: V3RunState;
  onRefetch?: () => void;
}

const STATUS_LABELS: Record<string, { label: string; description: string }> = {
  NONE: { label: 'No Active Run', description: 'Start a new run to begin earning verified points' },
  ACTIVE: { label: 'Run Active', description: 'Your run is in progress' },
  REBORN: { label: 'Reborn', description: 'Run completed, awaiting new run' },
  EXPIRED: { label: 'Expired', description: 'Run expired due to season end' },
  ABANDONED: { label: 'Abandoned', description: 'Run was voluntarily abandoned' },
};

const SCORE_TIER_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Seedling',
  2: 'Sapling',
  3: 'Sprout',
  4: 'Sapling+',
  5: 'Tree',
  10: 'Tree+',
  20: 'Old Growth',
  50: 'Ancient',
  100: 'Legendary',
};

const NATURE_SCALE = 1_000_000_000_000n;

/** Formats contract atom values for display only; the underlying verified value stays a bigint. */
function formatNatureAtoms(atoms: bigint): string {
  const whole = atoms / NATURE_SCALE;
  const fraction = (atoms % NATURE_SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  const formattedWhole = new Intl.NumberFormat().format(whole);
  return fraction ? `${formattedWhole}.${fraction}` : formattedWhole;
}

function getScoreTierLabel(tier: number): string {
  const tiers = Object.keys(SCORE_TIER_LABELS)
    .map(Number)
    .sort((a, b) => a - b);
  let label = 'None';
  for (const t of tiers) {
    if (tier >= t) label = SCORE_TIER_LABELS[t];
    else break;
  }
  return label;
}

export function V3StatusPanel({ runState, onRefetch }: V3StatusPanelProps) {
  const {
    wallet,
    runId,
    run,
    seasonalPP,
    seasonalCP,
    lifetimeCP,
    seasonRebirths,
    loading,
    error,
    isConfigured,
    isCorrectChain,
    canAccessV3,
  } = runState;

  const statusInfo = useMemo(() => {
    if (!canAccessV3) {
      if (!isConfigured)
        return { label: 'V3 Not Configured', description: 'Contract address not set' };
      if (!wallet) return { label: 'Wallet Required', description: 'Connect wallet to access V3' };
      if (!isCorrectChain) return { label: 'Wrong Network', description: `Switch to ${TARGET_NETWORK_LABEL}` };
    }
    return run ? STATUS_LABELS[run.status] : STATUS_LABELS.NONE;
  }, [canAccessV3, isConfigured, wallet, isCorrectChain, run]);

  if (loading) {
    return (
      <div className="v3-status-panel v3-status-panel--loading" aria-label="V3 run status">
        <div className="v3-status-loading">
          <span className="v3-spinner" aria-hidden="true" />
          <span>Loading V3 status...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="v3-status-panel v3-status-panel--error" aria-label="V3 run status">
        <div className="v3-status-error">
          <span>Error loading V3 status</span>
          <small>{error}</small>
          {onRefetch && (
            <button type="button" onClick={onRefetch} className="v3-retry-button">
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="v3-status-panel" aria-label="V3 run status">
      <div className="v3-panel-heading">
        <span className="v3-panel-kicker">VERIFIED RUN</span>
        <strong>{statusInfo.label}</strong>
      </div>

      <p className="v3-status-description">{statusInfo.description}</p>

      {canAccessV3 && (
        <dl className="v3-status-details" aria-label="Verified lifetime and season totals">
          <div className="v3-status-item">
            <dt>Lifetime Nature</dt>
            <dd>{formatNatureAtoms(runState.lifetimeNatureCollectedAtoms)}</dd>
          </div>
          <div className="v3-status-item">
            <dt>Accumulated Rebirth score</dt>
            <dd>{new Intl.NumberFormat().format(runState.totalAccumulatedRebirthScore)}</dd>
          </div>
          <div className="v3-status-item">
            <dt>Season PP</dt>
            <dd>{seasonalPP.toString()}</dd>
          </div>
          <div className="v3-status-item">
            <dt>Season CP</dt>
            <dd>{seasonalCP.toString()}</dd>
          </div>
          <div className="v3-status-item">
            <dt>Lifetime CP</dt>
            <dd>{lifetimeCP.toString()}</dd>
          </div>
          <div className="v3-status-item">
            <dt>Highest settled tier</dt>
            <dd>{runState.seasonalHighScoreTier}</dd>
          </div>
          <div className="v3-status-item">
            <dt>Next CP milestone</dt>
            <dd>
              {runState.nextCpMilestoneTier === null
                ? 'All score milestones reached'
                : `Tier ${runState.nextCpMilestoneTier} · CP award may be capped`}
            </dd>
          </div>
        </dl>
      )}

      {runId > 0n && (
        <dl className="v3-status-details">
          <div className="v3-status-item">
            <dt>Run ID</dt>
            <dd>#{runId.toString()}</dd>
          </div>

          {run && (
            <>
              <div className="v3-status-item">
                <dt>Season</dt>
                <dd>{run.seasonId.toString()}</dd>
              </div>

              <div className="v3-status-item">
                <dt>Score Tier</dt>
                <dd>
                  <span className="v3-tier-badge">
                    {getScoreTierLabel(run.lastRecordedScoreTier)}
                  </span>
                </dd>
              </div>

              <div className="v3-status-item">
                <dt>Started</dt>
                <dd>{new Date(Number(run.startedAt) * 1000).toLocaleDateString()}</dd>
              </div>
            </>
          )}

          <div className="v3-status-item">
            <dt>Rebirths</dt>
            <dd>{seasonRebirths} this season</dd>
          </div>
        </dl>
      )}

      {!isConfigured && (
        <div className="v3-config-notice">
          <span className="v3-notice-icon" aria-hidden="true">
            ⚠
          </span>
          <span>V3 contract address not configured. Set {V3_CONTRACT_ADDRESS_ENV}.</span>
        </div>
      )}

      {!canAccessV3 && isConfigured && (
        <div className="v3-access-notice">
          {!wallet ? (
            <span>Connect your wallet to start a verified run.</span>
          ) : !isCorrectChain ? (
            <span>Switch to {TARGET_NETWORK_LABEL} to access V3.</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
