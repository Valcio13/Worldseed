import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEconomyState } from '../incremental/engine';
import { ThemeProvider } from '../theme/ThemeProvider';
import '../theme/theme.css';
import { THEME_STORAGE_KEY } from '../theme/themeContext';
import { AudioSettings } from './AudioSettings';
import { LivingIslandScreen, type LivingIslandMode } from './LivingIslandScreen';

beforeEach(() => {
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
  vi.restoreAllMocks();
});

describe('theme toggle in the Living Island header', () => {
  it.each<LivingIslandMode>(['guest', 'verified'])(
    'switches theme while %s mode is active',
    (mode) => {
      render(
        <ThemeProvider>
          <LivingIslandScreen
            state={createEconomyState(1)}
            mode={mode}
            verifiedModeEnabled
            verifiedIsland={null}
            nextSeasonStart={Date.UTC(2026, 10, 2)}
            saveLabel="Saved"
            audioControls={<AudioSettings />}
            onHeartClick={() => undefined}
            onStateChange={() => undefined}
            onRebirth={() => undefined}
          />
        </ThemeProvider>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));

      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    },
  );

  it('changes the island to a night sky and softens only its terrain layers', () => {
    render(
      <ThemeProvider>
        <LivingIslandScreen
          state={createEconomyState(1)}
          nextSeasonStart={Date.UTC(2026, 10, 2)}
          saveLabel="Saved"
          audioControls={<AudioSettings />}
          onHeartClick={() => undefined}
          onStateChange={() => undefined}
          onRebirth={() => undefined}
        />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));

    const scene = document.querySelector<HTMLElement>('.living-scene')!;
    const land = document.querySelector<HTMLElement>('.living-island-land')!;
    const heart = document.querySelector<HTMLElement>('.island-heart-sprite')!;
    expect(window.getComputedStyle(scene).backgroundImage).toContain('linear-gradient');
    expect(window.getComputedStyle(land).backgroundImage).toContain('grass-field-tile.png');
    expect(window.getComputedStyle(land).filter).toBe('none');
    expect(window.getComputedStyle(heart).filter).toContain('drop-shadow');
  });
});
