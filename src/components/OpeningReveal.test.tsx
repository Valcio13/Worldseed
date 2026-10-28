import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpeningReveal } from './OpeningReveal';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OpeningReveal', () => {
  it('shows the official Worldseed logo while leaving the game render independent', () => {
    render(
      <>
        <OpeningReveal />
        <main data-testid="game-underlay">Playable game</main>
      </>,
    );

    expect(screen.getByTestId('opening-reveal')).toBeInTheDocument();
    expect(screen.getByTestId('opening-reveal').querySelector('img')).toHaveAttribute(
      'alt',
      'Worldseed',
    );
    expect(screen.getByTestId('opening-reveal').querySelector('img')).toHaveAttribute(
      'src',
      '/assets/branding/worldseed-logo.png',
    );
    expect(screen.getByTestId('game-underlay')).toBeInTheDocument();
  });

  it('removes the overlay after the 1.5 second reveal without replaying on rerender', () => {
    vi.useFakeTimers();
    const view = render(<OpeningReveal />);

    act(() => vi.advanceTimersByTime(900));
    view.rerender(<OpeningReveal />);
    expect(screen.getByTestId('opening-reveal')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(599));
    expect(screen.getByTestId('opening-reveal')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('opening-reveal')).not.toBeInTheDocument();
  });

  it('skips the overlay when reduced motion is preferred', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

    render(<OpeningReveal />);

    expect(screen.queryByTestId('opening-reveal')).not.toBeInTheDocument();
  });
});
