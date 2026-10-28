import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { V3RunState } from '../types';
import { V3RunControls } from './V3RunControls';

function makeRunState(seasonalPP: bigint, growth = 0): V3RunState {
  return {
    wallet: '0x0000000000000000000000000000000000000001',
    runId: 0n,
    run: null,
    seasonId: 1n,
    seasonalPP,
    seasonalCP: 0n,
    seasonalHighScoreTier: 0,
    rebirthThresholdTier: 35,
    nextCpMilestoneTier: 42,
    lifetimeCP: 0n,
    lifetimeNatureCollectedAtoms: 0n,
    totalAccumulatedRebirthScore: 0n,
    seasonalAccumulatedRebirthScore: 0n,
    seasonRebirths: 1,
    upgradeLevels: { growth, efficiency: 0, awakening: 0, rebirth: 0 },
    loading: false,
    error: null,
    isConfigured: true,
    isCorrectChain: true,
    canAccessV3: true,
    isStarting: false,
  };
}

afterEach(cleanup);

describe('V3 Start Run PP allocation', () => {
  it('limits allocation to available PP and shows the remaining balance', () => {
    const onStartRun = vi.fn(async () => undefined);
    render(
      <V3RunControls
        runState={makeRunState(1n)}
        transactionState="idle"
        onStartRun={onStartRun}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Increase Growth' }));

    expect(screen.getByText(/Remaining: 0/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Increase Growth' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Increase Efficiency' })).toBeDisabled();
    const startButton = screen.getByRole('button', { name: /Start Verified Run/ });
    expect(startButton).toBeEnabled();
    fireEvent.click(startButton);
    expect(onStartRun).toHaveBeenCalledWith([{ upgradeId: 0, quantity: 1 }]);
  });

  it('uses the existing escalating cost for the next level', () => {
    render(
      <V3RunControls
        runState={makeRunState(2n, 2)}
        transactionState="idle"
        onStartRun={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByText('Next level: 3 PP')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Increase Growth' })).toBeDisabled();
    expect(screen.getByText(/Remaining: 2/)).toBeInTheDocument();
  });

  it('revalidates the selected allocation against the latest PP before Start Run', () => {
    const onStartRun = vi.fn(async () => undefined);
    const view = render(
      <V3RunControls
        runState={makeRunState(3n)}
        transactionState="idle"
        onStartRun={onStartRun}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Increase Growth' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase Growth' }));
    expect(screen.getByText(/Remaining: 0/)).toBeInTheDocument();

    view.rerender(
      <V3RunControls
        runState={makeRunState(1n)}
        transactionState="idle"
        onStartRun={onStartRun}
      />,
    );
    const startButton = screen.getByRole('button', { name: /Start Verified Run/ });
    expect(startButton).toBeDisabled();

    expect(onStartRun).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/cost 3 PP, but only 1 PP is available/i);
  });
});
