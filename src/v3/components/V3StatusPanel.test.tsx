import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { V3StatusPanel } from './V3StatusPanel';
import type { V3RunState } from '../types';
import { TARGET_NETWORK_LABEL } from '../../blockchain/networkPresentation';

const runState: V3RunState = {
  wallet: '0x0000000000000000000000000000000000000001',
  runId: 1n,
  run: null,
  seasonId: 1n,
  seasonalPP: 18n,
  seasonalCP: 3n,
  seasonalHighScoreTier: 35,
  rebirthThresholdTier: 35,
  nextCpMilestoneTier: 42,
  lifetimeCP: 12n,
  lifetimeNatureCollectedAtoms: 1_234_567_890_123n,
  totalAccumulatedRebirthScore: 77n,
  seasonalAccumulatedRebirthScore: 0n,
  seasonRebirths: 0,
  upgradeLevels: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
  loading: false,
  error: null,
  isConfigured: true,
  isCorrectChain: true,
  canAccessV3: true,
  isStarting: false,
};

describe('V3StatusPanel', () => {
  afterEach(() => cleanup());

  it('shows verified lifetime Nature, accumulated score, and point balances', () => {
    render(<V3StatusPanel runState={runState} />);

    expect(screen.getByText('1.234567890123')).toBeTruthy();
    expect(screen.getByText('77')).toBeTruthy();
    expect(screen.getByText('18')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('does not promise CP for a milestone when seasonal caps may prevent the award', () => {
    render(<V3StatusPanel runState={runState} />);

    expect(screen.getByText('Tier 42 · CP award may be capped')).toBeTruthy();
  });

  it('shows the selected network when the wallet is connected to the wrong chain', () => {
    render(
      <V3StatusPanel
        runState={{ ...runState, isCorrectChain: false, canAccessV3: false }}
      />,
    );

    expect(screen.getByText(`Switch to ${TARGET_NETWORK_LABEL}`)).toBeInTheDocument();
  });
});
