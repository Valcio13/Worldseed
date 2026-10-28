import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { V3StatusPanel } from './V3StatusPanel';
import type { V3RunState } from '../types';

const runState: V3RunState = {
  wallet: '0x0000000000000000000000000000000000000001',
  runId: 1n,
  run: null,
  seasonId: 1n,
  seasonalPP: 0n,
  seasonalCP: 0n,
  seasonalHighScoreTier: 35,
  rebirthThresholdTier: 35,
  nextCpMilestoneTier: 42,
  lifetimeCP: 0n,
  lifetimeNatureCollectedAtoms: 0n,
  totalAccumulatedRebirthScore: 0n,
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
  it('does not promise CP for a milestone when seasonal caps may prevent the award', () => {
    render(<V3StatusPanel runState={runState} />);

    expect(screen.getByText('Tier 42 · CP award may be capped')).toBeTruthy();
  });
});
