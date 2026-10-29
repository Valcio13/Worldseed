import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createEconomyState } from '../incremental/engine';
import { LivingIslandScreen } from './LivingIslandScreen';
import './LivingIsland.css';

afterEach(cleanup);

describe('Living Island creature sprite frames', () => {
  it('aligns desktop creatures to the actual 56px atlas-cell grid', () => {
    const base = createEconomyState(1);
    render(
      <LivingIslandScreen
        state={{ ...base, habitats: { ...base.habitats, water: 15 } }}
        nextSeasonStart={Date.UTC(2026, 10, 2)}
        saveLabel="Saved"
        onHeartClick={() => undefined}
        onStateChange={() => undefined}
        onRebirth={() => undefined}
      />,
    );

    const offsets = ['moss', 'pip', 'luma', 'caretaker', 'villager'].map((name) =>
      window
        .getComputedStyle(screen.getByTestId(`island-creature-${name}`))
        .getPropertyValue('--creature-sprite-x')
        .trim(),
    );
    expect(offsets).toEqual(['-168px', '-224px', '-280px', '0px', '-112px']);
  });
});
