import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareValues, formatValue, valueFromNumber } from '../incremental/decimal';
import {
  clickIslandHeart,
  createEconomyState,
  productionPerSecond,
  type ActionResult,
  type EconomyState,
} from '../incremental/engine';
import { EconomyPanel } from './EconomyPanel';

afterEach(() => cleanup());

describe('guest economy gameplay', () => {
  it('turns Heart clicks into Nature and habitat purchases into passive production', () => {
    let state: EconomyState = createEconomyState(1);
    const onStateChange = vi.fn((result: ActionResult) => {
      state = result.state;
    });
    const onHeartClick = vi.fn(() => {
      state = clickIslandHeart(state).state;
    });

    const { rerender } = render(
      <EconomyPanel
        state={state}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        onHeartClick={onHeartClick}
        onStateChange={onStateChange}
        onRebirth={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Click Island Heart/ }));
    expect(onHeartClick).toHaveBeenCalledOnce();
    expect(state.nature).toEqual(valueFromNumber(1));

    state = { ...state, nature: valueFromNumber(10) };
    rerender(
      <EconomyPanel
        state={state}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        onHeartClick={onHeartClick}
        onStateChange={onStateChange}
        onRebirth={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Buy 1 Water' }));

    expect(onStateChange).toHaveBeenCalledOnce();
    expect(state.habitats.water).toBe(1);
    expect(compareValues(state.nature, valueFromNumber(0))).toBe(0);
    expect(formatValue(productionPerSecond(state))).toBe('0.3');

    rerender(
      <EconomyPanel
        state={state}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        onHeartClick={onHeartClick}
        onStateChange={onStateChange}
        onRebirth={() => undefined}
      />,
    );
    expect(screen.getByText('Level 1')).toBeTruthy();
    expect(screen.getByText('0.3')).toBeTruthy();
    expect(
      screen.getByRole('progressbar', { name: 'Rebirth progress' }).getAttribute('aria-valuenow'),
    ).toBe('0');
  });
});
