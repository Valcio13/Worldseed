import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { valueFromNumber, valueToNumber } from '../incremental/decimal';
import { createEconomyState } from '../incremental/engine';
import { NatureBoostsPanel } from './NatureBoostsPanel';

afterEach(cleanup);

describe('NatureBoostsPanel', () => {
  it('shows costs and effects and disables purchases the guest cannot afford', () => {
    const state = createEconomyState(1);
    render(<NatureBoostsPanel state={state} onStateChange={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'NATURE BOOSTS' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Sunny Season · 150 Nature/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Nature Surge · 1500 Nature/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Fertile Soil level 1 for 1K Nature/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Time Bloom requires a habitat' })).toBeDisabled();
    expect(screen.getByText(/2× production · 60 sec/)).toBeTruthy();
    expect(screen.getByText(/4× production · 30 sec/)).toBeTruthy();
  });

  it('shows Fertile Soil run level and sends an affordable purchase to the guest state handler', () => {
    const state = {
      ...createEconomyState(1),
      nature: valueFromNumber(2_000),
    };
    const onStateChange = vi.fn();
    render(<NatureBoostsPanel state={state} onStateChange={onStateChange} />);

    fireEvent.click(screen.getByRole('button', { name: /Fertile Soil level 1 for 1K Nature/ }));

    expect(onStateChange).toHaveBeenCalledOnce();
    const result = onStateChange.mock.calls[0]![0];
    expect(result.state.fertileSoilLevel).toBe(1);
    expect(valueToNumber(result.state.nature)).toBe(1_000);
  });

  it('shows Time Bloom as used after purchase and keeps it disabled for the rest of the run', () => {
    const base = createEconomyState(1);
    const state = {
      ...base,
      nature: valueFromNumber(6),
      habitats: { ...base.habitats, water: 1 },
    };
    const onStateChange = vi.fn();
    const { rerender } = render(<NatureBoostsPanel state={state} onStateChange={onStateChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Buy Time Bloom for 6 Nature' }));

    const result = onStateChange.mock.calls[0]![0];
    expect(result.state.timeBloomUsed).toBe(true);
    expect(valueToNumber(result.state.runNature)).toBeCloseTo(9);
    rerender(<NatureBoostsPanel state={result.state} onStateChange={onStateChange} />);
    expect(screen.getByRole('button', { name: 'Time Bloom used this run' })).toBeDisabled();
  });

  it('explains that an active temporary boost purchase refreshes its timer', () => {
    const state = {
      ...createEconomyState(1),
      nature: valueFromNumber(1_500),
      temporaryUpgrades: { 'sunny-season': 0, 'deep-roots': 0, 'nature-surge': 10 },
    };
    const onStateChange = vi.fn();
    render(<NatureBoostsPanel state={state} onStateChange={onStateChange} />);

    const surge = screen.getByRole('button', {
      name: 'Nature Surge · 1500 Nature · active 10 seconds, purchase refreshes',
    });
    expect(surge).toBeEnabled();
    expect(screen.getByText(/Active 10s; purchase refreshes/)).toBeTruthy();
    fireEvent.click(surge);
    expect(onStateChange.mock.calls[0]![0].state.temporaryUpgrades['nature-surge']).toBe(30);
  });
});
