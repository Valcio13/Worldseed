import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import '../styles.css';

vi.mock('../integration/featureFlags', () => ({ isV3IdleIntegrationEnabled: () => false }));
vi.mock('../persistence/localSave', () => ({
  archiveIncompatibleSave: vi.fn(),
  loadGuestSave: vi.fn().mockResolvedValue({ kind: 'empty' }),
  restoreGuestProgress: vi.fn(),
  saveGuestSave: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>();
  return {
    ...actual,
    useAccount: () => ({ isConnected: false, address: undefined }),
    useChainId: () => 0,
    useConnect: () => ({ connectAsync: vi.fn(), connectors: [], isPending: false }),
    useDisconnect: () => ({ disconnect: vi.fn() }),
    useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
  };
});

afterEach(() => {
  cleanup();
  document.body.classList.remove('worldseed-app-scroll');
  vi.clearAllMocks();
});

describe('active application screen', () => {
  it('mounts Rebirth in the guest app and enables document scrolling on desktop', () => {
    const { container } = render(<App />);

    expect(screen.getByRole('heading', { name: 'Habitat shop' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Rebirth' })).toBeVisible();
    expect(container.querySelector('[data-testid="opening-reveal"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rebirth →' })).toBeDisabled();
    expect(document.body).toHaveClass('worldseed-app-scroll');
    expect(window.getComputedStyle(document.body).overflowY).toBe('auto');
  });
});
