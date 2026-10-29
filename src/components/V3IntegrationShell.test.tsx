import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { V3IslandProgression } from './V3IntegrationShell';

const {
  useV3RunMock,
  useV3AuthMock,
  useStartRunFlowMock,
  useV3SettlementMock,
  useAccountMock,
  useConnectMock,
  useDisconnectMock,
  useSwitchChainMock,
  verifiedGameplayMock,
} = vi.hoisted(() => ({
  useV3RunMock: vi.fn(),
  useV3AuthMock: vi.fn(),
  useStartRunFlowMock: vi.fn(),
  useV3SettlementMock: vi.fn(),
  useAccountMock: vi.fn(),
  useConnectMock: vi.fn(),
  useDisconnectMock: vi.fn(),
  useSwitchChainMock: vi.fn(),
  verifiedGameplayMock: vi.fn(),
}));

vi.mock('../v3/hooks/useV3Run', () => ({ useV3Run: useV3RunMock }));
vi.mock('../v3/hooks/useV3Auth', () => ({ useV3Auth: useV3AuthMock }));
vi.mock('../v3/hooks/useStartRunFlow', () => ({ useStartRunFlow: useStartRunFlowMock }));
vi.mock('../v3/hooks/useV3Settlement', () => ({ useV3Settlement: useV3SettlementMock }));
vi.mock('../v3/components/V3VerifiedGameplay', () => ({
  V3VerifiedGameplay: (props: { runId: string; sessionToken: string }) => {
    verifiedGameplayMock(props);
    return <section aria-label="Verified runtime" />;
  },
}));
vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>();
  return {
    ...actual,
    useAccount: useAccountMock,
    useConnect: useConnectMock,
    useDisconnect: useDisconnectMock,
    useSwitchChain: useSwitchChainMock,
  };
});
vi.mock('../v3/components/V3StatusPanel', () => ({
  V3StatusPanel: () => <div>Technical run status</div>,
}));

const connectAsync = vi.fn();
const disconnect = vi.fn();
const switchChainAsync = vi.fn();
const refetch = vi.fn();
const callbacks = () => ({
  onSnapshotChange: vi.fn(),
  onHeartActionReady: vi.fn(),
  onActionHandlersReady: vi.fn(),
  onProfileChange: vi.fn(),
  onSettlementControlsReady: vi.fn(),
});

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
    lifetimeNatureCollectedAtoms: 0n,
    totalAccumulatedRebirthScore: 0n,
    seasonalAccumulatedRebirthScore: 0n,
    upgradeLevels: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
    loading: false,
    error: null,
    isConfigured: true,
    isCorrectChain: true,
    canAccessV3: false,
    isStarting: false,
    refetch,
    startRun: vi.fn(),
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
    authenticate: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  };
}

function startFlow(overrides: Record<string, unknown> = {}) {
  return {
    state: { status: 'idle', error: null, transactionHash: null },
    start: vi.fn(),
    retry: vi.fn(),
    reset: vi.fn(),
    nextRunId: 1n,
    refreshNextRunId: vi.fn(),
    canRetry: false,
    ...overrides,
  };
}

function renderProgression() {
  return render(<V3IslandProgression {...callbacks()} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useV3RunMock.mockReturnValue(runState());
  useV3AuthMock.mockReturnValue(authState());
  useStartRunFlowMock.mockReturnValue(startFlow());
  useV3SettlementMock.mockReturnValue({
    status: 'idle', action: null, transactionHash: null, error: null,
    canSettle: false, recordPoints: vi.fn(), rebirth: vi.fn(),
  });
  useAccountMock.mockReturnValue({ status: 'disconnected' });
  useConnectMock.mockReturnValue({ connectAsync, connectors: [{ id: 'injected' }], isPending: false });
  useDisconnectMock.mockReturnValue({ disconnect });
  useSwitchChainMock.mockReturnValue({ switchChainAsync, isPending: false });
});

afterEach(() => cleanup());

describe('Living Island verified controls', () => {
  it('shows when the saved wallet connection is being restored after refresh', () => {
    useAccountMock.mockReturnValue({ status: 'reconnecting' });
    const authenticate = vi.fn();
    useV3AuthMock.mockReturnValue(authState({ authenticate }));
    renderProgression();
    fireEvent.click(screen.getByText('Live account'));
    expect(screen.getByRole('status')).toHaveTextContent('Restoring the wallet connection');
    expect(screen.getByRole('button', { name: 'Restoring wallet…' })).toBeDisabled();
    expect(connectAsync).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('offers an explicit new sign in when the verifier session expired', () => {
    useV3RunMock.mockReturnValue(runState({
      wallet: '0x0000000000000000000000000000000000000001',
      runId: 7n,
      run: { status: 'ACTIVE' },
    }));
    const authenticate = vi.fn();
    useV3AuthMock.mockReturnValue(authState({
      error: 'Session expired',
      canAuthenticate: true,
      authenticate,
    }));
    renderProgression();
    fireEvent.click(document.querySelector('.v3-living-account summary')!);
    const signInButton = screen.getByRole('button', { name: 'Sign in again' });
    expect(signInButton).toBeEnabled();
    fireEvent.click(signInButton);
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it('keeps wallet controls and technical activity compact and collapsible', () => {
    const { container } = renderProgression();
    expect(container.querySelector('.v3-living-account')?.hasAttribute('open')).toBe(false);
    expect(container.querySelector('.v3-advanced-activity')?.hasAttribute('open')).toBe(false);
    expect(screen.getByText('Advanced')).toBeTruthy();

    fireEvent.click(screen.getByText('Advanced'));
    expect(container.querySelector('.v3-advanced-activity')?.hasAttribute('open')).toBe(true);
    fireEvent.click(screen.getByText('Live account'));
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
  });

  it('connects from the compact Verified account menu', () => {
    renderProgression();
    fireEvent.click(screen.getByText('Live account'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(connectAsync).toHaveBeenCalledWith({ connector: { id: 'injected' } });
  });

  it('prompts to reconnect a disconnected Live wallet and offers Guest mode', () => {
    const address = '0x0000000000000000000000000000000000000001';
    const onSwitchToGuest = vi.fn();
    useV3AuthMock.mockReturnValue(authState({
      wallet: address,
      isAuthenticated: true,
      sessionToken: 'retained-session',
    }));

    render(<V3IslandProgression {...callbacks()} onSwitchToGuest={onSwitchToGuest} />);

    expect(screen.getByRole('dialog', { name: 'Reconnect your wallet' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect wallet' }));
    expect(connectAsync).toHaveBeenCalledWith({ connector: { id: 'injected' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue as Guest' }));
    expect(onSwitchToGuest).toHaveBeenCalledOnce();
  });

  it('opens Start Run in a dedicated scrollable dialog instead of the account dropdown', () => {
    const address = '0x0000000000000000000000000000000000000001';
    useV3RunMock.mockReturnValue(runState({
      wallet: address,
      isCorrectChain: true,
      canAccessV3: true,
    }));
    useV3AuthMock.mockReturnValue(authState({
      wallet: address,
      isAuthenticated: true,
      sessionToken: 'session-token',
    }));

    renderProgression();
    fireEvent.click(screen.getByText(`${address.slice(0, 6)}…${address.slice(-4)}`));
    fireEvent.click(screen.getByRole('button', { name: 'Start a Live run' }));

    expect(screen.getByRole('dialog', { name: 'Prepare your run' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start Verified Run →' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Start Run dialog' }));
    expect(screen.queryByRole('dialog', { name: 'Prepare your run' })).toBeNull();
  });

  it('ends authentication and disconnects only after the player explicitly requests it', () => {
    const address = '0x0000000000000000000000000000000000000001';
    const logout = vi.fn();
    useAccountMock.mockReturnValue({ status: 'connected', address });
    useV3RunMock.mockReturnValue(runState({ wallet: address, isCorrectChain: true }));
    useV3AuthMock.mockReturnValue(authState({ wallet: address, logout }));

    renderProgression();
    fireEvent.click(document.querySelector('.v3-living-account summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect 0x0000…0001' }));

    expect(logout).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('keeps an active verified run inside Advanced rather than a second dashboard', () => {
    useV3RunMock.mockReturnValue(runState({
      wallet: '0x0000000000000000000000000000000000000001',
      runId: 7n,
      run: { status: 'ACTIVE' },
      canAccessV3: true,
    }));
    useV3AuthMock.mockReturnValue(authState({
      wallet: '0x0000000000000000000000000000000000000001',
      isAuthenticated: true,
      sessionToken: 'session-token',
    }));

    renderProgression();
    expect(document.querySelector('.v3-advanced-activity')?.hasAttribute('open')).toBe(false);
    expect(verifiedGameplayMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: '7', sessionToken: 'session-token',
    }));
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByRole('region', { name: 'Verified runtime' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Verified Progression' })).toBeNull();
  });
});
