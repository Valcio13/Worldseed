import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { V3IntegrationShell, V3IslandProgression } from './V3IntegrationShell';

const {
  useV3RunMock,
  useV3AuthMock,
  useStartRunFlowMock,
  useV3SettlementMock,
  verifiedGameplayMock,
  useConnectMock,
  useDisconnectMock,
  useSwitchChainMock,
} = vi.hoisted(() => ({
  useV3RunMock: vi.fn(),
  useV3AuthMock: vi.fn(),
  useStartRunFlowMock: vi.fn(),
  useV3SettlementMock: vi.fn(),
  verifiedGameplayMock: vi.fn(),
  useConnectMock: vi.fn(),
  useDisconnectMock: vi.fn(),
  useSwitchChainMock: vi.fn(),
}));

vi.mock('../v3/hooks/useV3Run', () => ({ useV3Run: useV3RunMock }));
vi.mock('../v3/hooks/useV3Auth', () => ({ useV3Auth: useV3AuthMock }));
vi.mock('../v3/hooks/useStartRunFlow', () => ({ useStartRunFlow: useStartRunFlowMock }));
vi.mock('../v3/hooks/useV3Settlement', () => ({ useV3Settlement: useV3SettlementMock }));
vi.mock('../v3/components/V3VerifiedGameplay', () => ({
  V3VerifiedGameplay: (props: { runId: string; sessionToken: string }) => {
    verifiedGameplayMock(props);
    return <section aria-label="Verified gameplay" />;
  },
}));
vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>();
  return {
    ...actual,
    useConnect: useConnectMock,
    useDisconnect: useDisconnectMock,
    useSwitchChain: useSwitchChainMock,
  };
});
vi.mock('../v3/components/V3StatusPanel', () => ({
  V3StatusPanel: () => <div>Read-only V3 status</div>,
}));

const refetchMock = vi.fn();
const startRunMock = vi.fn();
const authenticateMock = vi.fn();
const logoutMock = vi.fn();
const startMock = vi.fn();
const retryMock = vi.fn();
const connectAsyncMock = vi.fn();
const disconnectMock = vi.fn();
const switchChainAsyncMock = vi.fn();
const injectedConnector = { id: 'injected' };

function StatefulGuestGame() {
  const [progress, setProgress] = useState(0);
  return (
    <button type="button" onClick={() => setProgress((value) => value + 1)}>
      Guest progress {progress}
    </button>
  );
}

function runState(overrides: Record<string, unknown> = {}) {
  return {
    wallet: null,
    runId: 0n,
    run: null,
    seasonId: 1n,
    seasonalPP: 0n,
    seasonalCP: 0n,
    seasonalHighScoreTier: 0,
    rebirthThresholdTier: 35,
    nextCpMilestoneTier: 42,
    lifetimeCP: 0n,
    seasonRebirths: 0,
    upgradeLevels: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
    loading: false,
    error: null,
    isConfigured: true,
    isCorrectChain: true,
    canAccessV3: false,
    isStarting: false,
    refetch: refetchMock,
    startRun: startRunMock,
    abandonRun: vi.fn(),
    ...overrides,
  };
}

function authState(overrides: Record<string, unknown> = {}) {
  return {
    status: 'idle',
    sessionToken: null,
    expiresAtMs: null,
    error: null,
    wallet: null,
    isAuthenticated: false,
    isConfigured: true,
    isCorrectChain: true,
    canAuthenticate: false,
    authenticate: authenticateMock,
    logout: logoutMock,
    ...overrides,
  };
}

function startFlow(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      status: 'idle',
      sessionToken: null,
      error: null,
      errorCode: null,
      transactionHash: null,
      retryCount: 0,
    },
    start: startMock,
    retry: retryMock,
    reset: vi.fn(),
    nextRunId: 1n,
    refreshNextRunId: vi.fn().mockResolvedValue(undefined),
    canRetry: true,
    ...overrides,
  };
}

describe('V3IntegrationShell', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    useV3RunMock.mockReturnValue(runState());
    useV3AuthMock.mockReturnValue(authState());
    useStartRunFlowMock.mockReturnValue(startFlow());
    useV3SettlementMock.mockReturnValue({
      status: 'idle',
      action: null,
      transactionHash: null,
      error: null,
      canSettle: false,
      recordPoints: vi.fn().mockResolvedValue('0xrecord'),
      rebirth: vi.fn().mockResolvedValue('0xrebirth'),
    });
    verifiedGameplayMock.mockReset();
    useConnectMock.mockReturnValue({
      connectAsync: connectAsyncMock,
      connectors: [injectedConnector],
      isPending: false,
    });
    useDisconnectMock.mockReturnValue({ disconnect: disconnectMock });
    useSwitchChainMock.mockReturnValue({
      switchChainAsync: switchChainAsyncMock,
      isPending: false,
    });
    refetchMock.mockReset();
    startRunMock.mockReset();
    authenticateMock.mockReset();
    logoutMock.mockReset();
    startMock.mockReset();
    retryMock.mockReset();
    connectAsyncMock.mockReset();
    disconnectMock.mockReset();
    switchChainAsyncMock.mockReset();
  });

  it('embeds verified progression in one collapsible island panel without mode navigation', () => {
    render(<V3IslandProgression onSnapshotChange={vi.fn()} onHeartActionReady={vi.fn()} />);

    expect(screen.getByText('Verified mode · Hemi Sepolia')).toBeTruthy();
    expect(screen.getByText('Read-only V3 status')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Worldseed game mode' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull();
  });

  it('opens on the existing guest game without mounting wallet-linked V3 state', () => {
    render(<V3IntegrationShell guestGame={<div>Existing island gameplay</div>} />);

    expect(screen.getByText('Existing island gameplay')).toBeTruthy();
    expect(useV3RunMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Guest game' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('preserves guest gameplay state while switching to Verified and back', () => {
    const { container } = render(<V3IntegrationShell guestGame={<StatefulGuestGame />} />);

    fireEvent.click(screen.getByRole('button', { name: 'Guest progress 0' }));
    expect(screen.getByRole('button', { name: 'Guest progress 1' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));
    expect(screen.getByText('Read-only V3 status')).toBeTruthy();
    expect(container.querySelector('.v3-integration-guest')?.textContent).toContain(
      'Guest progress 1',
    );
    expect(container.querySelector('.v3-integration-guest')?.hasAttribute('hidden')).toBe(true);
    expect(screen.getByText(/Guest saves are never converted into wallet rewards/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Wallet authentication' })).toBeTruthy();
    expect(screen.getByText(/Connect a wallet to authenticate/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Return to guest game' }));
    expect(screen.getByRole('button', { name: 'Guest progress 1' })).toBeTruthy();
  });

  it('shows wrong-chain guidance and disables wallet authentication on another network', () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    useV3RunMock.mockReturnValue(runState({ wallet, isCorrectChain: false }));
    useV3AuthMock.mockReturnValue(authState({ wallet, isCorrectChain: false }));
    render(<V3IntegrationShell guestGame={<div>Existing island gameplay</div>} />);

    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));

    expect(screen.getByText('Switch to Hemi Sepolia before authenticating.')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Authenticate wallet' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByText('Wrong Network')).toBeTruthy();
  });

  it('connects a browser wallet from the Verified view', () => {
    render(<V3IntegrationShell guestGame={<div>Existing island gameplay</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));

    expect(connectAsyncMock).toHaveBeenCalledWith({ connector: injectedConnector });
  });

  it('offers the Hemi Sepolia switch action on the wrong chain', () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    useV3RunMock.mockReturnValue(runState({ wallet, isCorrectChain: false }));
    useV3AuthMock.mockReturnValue(authState({ wallet, isCorrectChain: false }));
    render(<V3IntegrationShell guestGame={<div>Existing island gameplay</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Hemi Sepolia' }));

    expect(switchChainAsyncMock).toHaveBeenCalledWith({ chainId: 743111 });
  });

  it('authenticates the wallet for the next run', () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    useV3RunMock.mockReturnValue(runState({ wallet, canAccessV3: true }));
    useV3AuthMock.mockReturnValue(authState({ wallet, canAuthenticate: true }));
    render(<V3IntegrationShell guestGame={<div>Existing island gameplay</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));

    fireEvent.click(screen.getByRole('button', { name: 'Authenticate wallet' }));
    expect(authenticateMock).toHaveBeenCalledWith('1');
  });

  it('authenticates an existing active run using that run ID', () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    useV3RunMock.mockReturnValue(
      runState({ wallet, runId: 7n, run: { status: 'ACTIVE' }, canAccessV3: true }),
    );
    useV3AuthMock.mockReturnValue(authState({ wallet, canAuthenticate: true }));
    useStartRunFlowMock.mockReturnValue(startFlow({ nextRunId: 8n }));
    render(<V3IntegrationShell guestGame={<div>Existing island gameplay</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));

    fireEvent.click(screen.getByRole('button', { name: 'Authenticate wallet' }));
    expect(authenticateMock).toHaveBeenCalledWith('7');
  });

  it('connects the Start Run control to the existing authenticated run flow', () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    useV3RunMock.mockReturnValue(runState({ wallet, canAccessV3: true }));
    useV3AuthMock.mockReturnValue(
      authState({ wallet, canAuthenticate: true, isAuthenticated: true, sessionToken: 'token' }),
    );
    render(<V3IntegrationShell guestGame={<div>Existing island gameplay</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));

    fireEvent.click(screen.getByRole('button', { name: 'Increase Growth' }));
    fireEvent.click(screen.getByRole('button', { name: /Start Verified Run/ }));
    expect(startMock).toHaveBeenCalledWith([{ upgradeId: 'growth', quantity: 1 }]);
  });

  it('displays pending and confirmed Start Run states', () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    useV3RunMock.mockReturnValue(runState({ wallet, canAccessV3: true }));
    useV3AuthMock.mockReturnValue(
      authState({ wallet, canAuthenticate: true, isAuthenticated: true, sessionToken: 'token' }),
    );
    useStartRunFlowMock.mockReturnValue(
      startFlow({ state: { ...startFlow().state, status: 'confirming' } }),
    );
    const { rerender } = render(
      <V3IntegrationShell guestGame={<div>Existing island gameplay</div>} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));
    expect(screen.getByText('Confirming Start Run transaction…')).toBeTruthy();

    useStartRunFlowMock.mockReturnValue(
      startFlow({
        state: { ...startFlow().state, status: 'success', transactionHash: '0xabc' },
      }),
    );
    rerender(<V3IntegrationShell guestGame={<div>Existing island gameplay</div>} />);
    expect(screen.getByText('Run confirmed · 0xabc')).toBeTruthy();
  });

  it('enables Record Points and Rebirth for an authenticated active run', () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    const recordPoints = vi.fn().mockResolvedValue('0xrecord');
    const rebirth = vi.fn().mockResolvedValue('0xrebirth');
    useV3RunMock.mockReturnValue(
      runState({ wallet, runId: 7n, run: { status: 'ACTIVE' }, canAccessV3: true }),
    );
    useV3AuthMock.mockReturnValue(
      authState({ wallet, canAuthenticate: true, isAuthenticated: true, sessionToken: 'token' }),
    );
    useV3SettlementMock.mockReturnValue({
      status: 'idle',
      action: null,
      transactionHash: null,
      error: null,
      canSettle: true,
      recordPoints,
      rebirth,
    });
    render(<V3IntegrationShell guestGame={<div>Existing island gameplay</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));

    fireEvent.click(screen.getByRole('button', { name: /Record Points/ }));
    fireEvent.click(screen.getByRole('button', { name: /Rebirth/ }));
    expect(recordPoints).toHaveBeenCalledOnce();
    expect(rebirth).toHaveBeenCalledOnce();
  });

  it('keeps settlement actions disabled until the wallet session is authenticated', () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    useV3RunMock.mockReturnValue(
      runState({ wallet, runId: 7n, run: { status: 'ACTIVE' }, canAccessV3: true }),
    );
    useV3AuthMock.mockReturnValue(authState({ wallet, canAuthenticate: true }));
    render(<V3IntegrationShell guestGame={<div>Existing island gameplay</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));
    expect(screen.getByRole('button', { name: /Record Points/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Rebirth/ })).toBeDisabled();
  });

  it('ends the settled run session and binds authentication to the next run', async () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    const logout = vi.fn();
    const refreshNextRunId = vi.fn().mockResolvedValue(undefined);
    const rebirth = vi.fn().mockResolvedValue('0xrebirth');
    useV3RunMock.mockReturnValue(
      runState({ wallet, runId: 7n, run: { status: 'ACTIVE' }, canAccessV3: true }),
    );
    useV3AuthMock.mockReturnValue(
      authState({
        wallet,
        canAuthenticate: true,
        isAuthenticated: true,
        sessionToken: 'run-7',
        logout,
      }),
    );
    useStartRunFlowMock.mockReturnValue(startFlow({ nextRunId: 8n, refreshNextRunId }));
    useV3SettlementMock.mockReturnValue({
      status: 'idle',
      action: null,
      transactionHash: null,
      error: null,
      canSettle: true,
      recordPoints: vi.fn(),
      rebirth,
    });
    const { rerender } = render(<V3IntegrationShell guestGame={<div>Island</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));
    fireEvent.click(screen.getByRole('button', { name: /Rebirth/ }));
    expect(rebirth).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(logout).toHaveBeenCalledOnce();
      expect(refreshNextRunId).toHaveBeenCalledOnce();
    });

    useV3RunMock.mockReturnValue(runState({ wallet, canAccessV3: true }));
    useV3AuthMock.mockReturnValue(authState({ wallet, canAuthenticate: true }));
    useStartRunFlowMock.mockReturnValue(startFlow({ nextRunId: 8n }));
    rerender(<V3IntegrationShell guestGame={<div>Island</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Authenticate wallet' }));
    expect(authenticateMock).toHaveBeenCalledWith('8');
  });

  it('mounts verified gameplay for the authenticated active run', async () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    useV3RunMock.mockReturnValue(
      runState({ wallet, runId: 7n, run: { status: 'ACTIVE' }, canAccessV3: true }),
    );
    useV3AuthMock.mockReturnValue(
      authState({ wallet, isAuthenticated: true, sessionToken: 'verified-session' }),
    );
    render(<V3IntegrationShell guestGame={<div>Existing island gameplay</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));

    expect(verifiedGameplayMock).toHaveBeenCalledWith({
      runId: '7',
      sessionToken: 'verified-session',
      onSnapshotChange: undefined,
      onHeartActionReady: undefined,
    });
    expect(await screen.findByRole('region', { name: 'Verified gameplay' })).toBeTruthy();
  });

  it('keeps guest gameplay hidden and intact while verified gameplay is exercised', () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    useV3RunMock.mockReturnValue(
      runState({ wallet, runId: 7n, run: { status: 'ACTIVE' }, canAccessV3: true }),
    );
    useV3AuthMock.mockReturnValue(
      authState({ wallet, isAuthenticated: true, sessionToken: 'verified-session' }),
    );
    const { container } = render(<V3IntegrationShell guestGame={<StatefulGuestGame />} />);
    fireEvent.click(screen.getByRole('button', { name: 'Guest progress 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verified progression' }));

    expect(screen.getByRole('region', { name: 'Verified gameplay' })).toBeTruthy();
    expect(container.querySelector('.v3-integration-guest')?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Return to guest game' }));
    expect(screen.getByRole('button', { name: 'Guest progress 1' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Verified gameplay' })).toBeNull();
  });
});
