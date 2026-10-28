import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerifiedNatureBoostsPanel, type VerifiedNatureBoostsState } from './VerifiedNatureBoostsPanel';

const readyUpgrades: VerifiedNatureBoostsState = {
  natureSurgeCost: '1,500',
  natureSurgeRemainingMs: 12_250,
  canBuyNatureSurge: true,
  fertileSoilLevel: 2,
  fertileSoilMaxLevel: 5,
  fertileSoilNextCost: '3,000',
  canBuyFertileSoil: false,
  timeBloomUsed: true,
  timeBloomCost: '240',
  canBuyTimeBloom: false,
};

afterEach(cleanup);

describe('Verified Nature boosts', () => {
  it.each([1, 2])('keeps the purchases unavailable in Live V%s', (rulesVersion) => {
    render(
      <VerifiedNatureBoostsPanel
        rulesVersion={rulesVersion}
        upgrades={readyUpgrades}
        onCommand={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('require a Rules V3 Live run');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows active time, soil level and used Time Bloom, and submits canonical commands', () => {
    const onCommand = vi.fn();
    render(
      <VerifiedNatureBoostsPanel
        rulesVersion={3}
        upgrades={readyUpgrades}
        onCommand={onCommand}
      />,
    );

    expect(screen.getByText(/Active 13s remaining/)).toBeInTheDocument();
    expect(screen.getByText('Fertile Soil · 2/5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Time Bloom used this run' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Nature Surge/ }));
    expect(onCommand).toHaveBeenCalledWith({
      type: 'buy-temporary-upgrade',
      upgrade: 'nature-surge',
    });
  });

  it('submits the permanent and once-per-run purchase commands when available', () => {
    const onCommand = vi.fn();
    render(
      <VerifiedNatureBoostsPanel
        rulesVersion={3}
        upgrades={{
          ...readyUpgrades,
          natureSurgeRemainingMs: 0,
          fertileSoilLevel: 4,
          canBuyFertileSoil: true,
          timeBloomUsed: false,
          canBuyTimeBloom: true,
        }}
        onCommand={onCommand}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Fertile Soil level 5/ }));
    fireEvent.click(screen.getByRole('button', { name: /Buy Time Bloom/ }));
    expect(onCommand).toHaveBeenNthCalledWith(1, { type: 'buy-fertile-soil' });
    expect(onCommand).toHaveBeenNthCalledWith(2, { type: 'buy-time-bloom' });
  });
});
