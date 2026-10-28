import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from './ThemeProvider';
import { THEME_STORAGE_KEY } from './themeContext';
import { useWorldseedTheme } from './useWorldseedTheme';
import { ThemeToggle } from '../components/ThemeToggle';

function ThemeReadout() {
  const { theme } = useWorldseedTheme();
  return <output aria-label="Current theme">{theme}</output>;
}

describe('Worldseed theme', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = '';
  });

  afterEach(() => cleanup());

  it('defaults existing players to Light Mode', () => {
    render(
      <ThemeProvider>
        <ThemeReadout />
      </ThemeProvider>,
    );

    expect(screen.getByLabelText('Current theme')).toHaveTextContent('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('restores Dark Mode and persists changes from the toggle', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(
      <ThemeProvider>
        <ThemeReadout />
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(screen.getByLabelText('Current theme')).toHaveTextContent('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    const toggle = screen.getByRole('button', { name: 'Switch to light mode' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);

    expect(screen.getByLabelText('Current theme')).toHaveTextContent('light');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    cleanup();
    render(
      <ThemeProvider>
        <ThemeReadout />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText('Current theme')).toHaveTextContent('light');
  });
});
