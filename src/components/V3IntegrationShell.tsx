import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { V3RunControls } from '../v3/components/V3RunControls';
import { V3VerifiedGameplay } from '../v3/components/V3VerifiedGameplay';
import type {
  V3IslandActionHandlers,
  V3IslandSnapshot,
} from '../v3/components/V3VerifiedGameplay';
import { useStartRunFlow } from '../v3/hooks/useStartRunFlow';
import { useV3Auth } from '../v3/hooks/useV3Auth';
import { useV3Run } from '../v3/hooks/useV3Run';
import { useV3Settlement } from '../v3/hooks/useV3Settlement';
import type { V3RewardRules, V3UpgradeKind } from '../v3/types';
import { TARGET_CHAIN_ID } from '../blockchain/config';
import { TARGET_NETWORK_LABEL } from '../blockchain/networkPresentation';
import { playIslandSound } from '../game/sound';
import './V3IntegrationShell.css';

export interface V3LivingProfile {
  activeRun: boolean;
  runId: string | null;
  authenticated: boolean;
  ready: boolean;
  seasonalPP: string;
  seasonalCP: string;
  rewardRules: V3RewardRules | null;
  totalSeasonCP: string | null;
  maxSeasonPoints: string | null;
  lifetimeCP: string;
  lifetimeNature: string;
  accumulatedScore: string;
  seasonalAccumulatedScore: string;
  seasonalHighScoreTier: number;
  nextCpMilestoneTier: number | null;
  rebirthThresholdTier: number;
  seasonRebirths: number;
  upgradeLevels: Record<V3UpgradeKind, number>;
  wallet: string | null;
  error: string | null;
}

export interface V3LivingSettlementControls {
  pending: boolean;
  canSettle: boolean;
  error?: string | null;
  openStartRun: () => void;
  recordPoints: () => void;
  rebirth: () => void;
}

/** Verified account, run, and activity controls embedded in the Living Island header. */
export function V3IslandProgression({
  onSnapshotChange,
  onHeartActionReady,
  onActionHandlersReady,
  onProfileChange,
  onSettlementControlsReady,
  onSwitchToGuest,
}: {
  onSnapshotChange: (snapshot: V3IslandSnapshot | null) => void;
  onHeartActionReady: (action: (() => boolean) | null) => void;
  onActionHandlersReady: (handlers: V3IslandActionHandlers | null) => void;
  onProfileChange: (profile: V3LivingProfile | null) => void;
  onSettlementControlsReady: (controls: V3LivingSettlementControls | null) => void;
  onSwitchToGuest?: () => void;
}) {
  return <VerifiedProgression
    onSnapshotChange={onSnapshotChange}
    onHeartActionReady={onHeartActionReady}
    onActionHandlersReady={onActionHandlersReady}
    onProfileChange={onProfileChange}
    onSettlementControlsReady={onSettlementControlsReady}
    onSwitchToGuest={onSwitchToGuest}
  />;
}

function VerifiedProgression({
  onSnapshotChange,
  onHeartActionReady,
  onActionHandlersReady,
  onProfileChange,
  onSettlementControlsReady,
  onSwitchToGuest,
}: {
  onSnapshotChange: (snapshot: V3IslandSnapshot | null) => void;
  onHeartActionReady: (action: (() => boolean) | null) => void;
  onActionHandlersReady: (handlers: V3IslandActionHandlers | null) => void;
  onProfileChange: (profile: V3LivingProfile | null) => void;
  onSettlementControlsReady: (controls: V3LivingSettlementControls | null) => void;
  onSwitchToGuest?: () => void;
}) {
  const runState = useV3Run();
  const auth = useV3Auth();
  const settlement = useV3Settlement(auth.isAuthenticated ? auth.sessionToken : null);
  const settlementRef = useRef(settlement);
  const runStateRef = useRef(runState);
  const startFlowRef = useRef<ReturnType<typeof useStartRunFlow> | null>(null);
  const flushPendingCommandsRef = useRef<(() => Promise<void>) | null>(null);
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const walletAccount = useAccount();
  const [walletError, setWalletError] = useState<string | null>(null);
  const [startRunOpen, setStartRunOpen] = useState(false);
  const activeVerifiedRunId =
    runState.runId > 0n && runState.run?.status === 'ACTIVE'
      ? runState.runId.toString()
      : undefined;
  const startFlow = useStartRunFlow({
    onAuthRequired: async () => {
      if (!auth.isAuthenticated || !auth.sessionToken)
        throw new Error('Authenticate your wallet before starting a Live run.');
      return auth.sessionToken;
    },
    onStartRun: async (sessionToken, upgrades) => {
      const hash = await runState.startRun(sessionToken, upgrades);
      await Promise.allSettled([runState.refetch()]);
      return hash;
    },
  });
  useEffect(() => {
    settlementRef.current = settlement;
    runStateRef.current = runState;
    startFlowRef.current = startFlow;
  }, [auth, runState, settlement, startFlow]);
  const authenticationRunId = activeVerifiedRunId ?? startFlow.nextRunId?.toString();
  const lastStartChoices = useRef<Array<{ upgradeId: V3UpgradeKind; quantity: number }>>([]);
  const forwardActionHandlers = useCallback((handlers: V3IslandActionHandlers | null) => {
    flushPendingCommandsRef.current = handlers?.flushPendingCommands ?? null;
    onActionHandlersReady(handlers);
  }, [onActionHandlersReady]);
  // The current hook's derived access flag can be undefined before wallet/config state settles.
  const statusRunState = { ...runState, canAccessV3: Boolean(runState.canAccessV3) };
  const hasActiveRun = runState.runId > 0n && runState.run?.status === 'ACTIVE';
  const isAuthenticating = ['requesting-challenge', 'signing', 'completing'].includes(auth.status);

  useEffect(() => {
    if (!startRunOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setStartRunOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [startRunOpen]);
  const canAuthenticate = Boolean(auth.canAuthenticate && authenticationRunId !== undefined);
  const walletReconnecting = walletAccount.status === 'reconnecting';
  const walletReady = walletAccount.status === 'connected';
  const walletBusy = connecting || switching || walletReconnecting;
  const flowBusy = [
    'fetching-next-run-id',
    'authenticating',
    'requesting-attestation',
    'submitting-transaction',
    'confirming',
  ].includes(startFlow.state.status);
  const transactionState =
    startFlow.state.status === 'success' || settlement.status === 'confirmed'
      ? 'confirmed'
      : startFlow.state.status === 'error' ||
          settlement.status === 'failed' ||
          settlement.status === 'uncertain'
        ? 'failed'
        : flowBusy ||
            ['requesting-attestation', 'wallet-pending', 'confirming'].includes(settlement.status)
          ? 'pending'
          : 'idle';

  async function authenticateWallet() {
    if (!walletReady || !canAuthenticate || authenticationRunId === undefined) return;
    await auth.authenticate(authenticationRunId);
  }

  async function handleWalletAction() {
    setWalletError(null);
    try {
      if (!runState.wallet) {
        const connector = connectors[0];
        if (!connector)
          throw new Error('No browser wallet was found. Install a wallet extension to continue.');
        await connectAsync({ connector });
      } else if (!runState.isCorrectChain) {
        await switchChainAsync({ chainId: TARGET_CHAIN_ID });
      } else {
        auth.logout();
        disconnect();
      }
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Wallet request failed.');
    }
  }

  async function startVerifiedRun(upgrades: Array<{ upgradeId: number; quantity: number }>) {
    if (!walletReady) throw new Error('Wait for your wallet to finish reconnecting, then try again.');
    const upgradeNames: V3UpgradeKind[] = ['growth', 'efficiency', 'awakening', 'rebirth'];
    const choices = upgrades.map(({ upgradeId, quantity }) => {
      const upgradeIdName = upgradeNames[upgradeId];
      if (!upgradeIdName) throw new Error(`Unknown V3 upgrade ID: ${upgradeId}`);
      return { upgradeId: upgradeIdName, quantity };
    });
    lastStartChoices.current = choices;
    await startFlow.start(choices);
  }

  const openStartRun = useCallback(() => setStartRunOpen(true), []);

  const canSettleRun = Boolean(
    hasActiveRun && walletReady && auth.isAuthenticated && settlement.canSettle && !runState.loading,
  );

  const recordRunPoints = useCallback(async () => {
    try {
      if (!walletReady) throw new Error('Wait for your wallet to finish reconnecting, then try again.');
      await flushPendingCommandsRef.current?.();
      await settlementRef.current.recordPoints();
      await runStateRef.current.refetch();
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Live actions must sync before recording points.');
    }
  }, [walletReady]);

  const rebirthRun = useCallback(async () => {
    try {
      if (!walletReady) throw new Error('Wait for your wallet to finish reconnecting, then try again.');
      await flushPendingCommandsRef.current?.();
      await settlementRef.current.rebirth();
      playIslandSound('rebirth');
      // Keep the wallet session across runs. The verifier authorizes each new
      // run against the connected wallet and confirmed chain state.
      const flow = startFlowRef.current;
      await Promise.allSettled([
        runStateRef.current.refetch(),
        flow?.refreshNextRunId() ?? Promise.resolve(),
      ]);
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Live actions must sync before Rebirth.');
    }
  }, [walletReady]);

  const playerProfile = useMemo<V3LivingProfile>(() => ({
    activeRun: hasActiveRun,
    runId: hasActiveRun ? runState.runId.toString() : null,
    authenticated: auth.isAuthenticated,
    ready: Boolean(runState.canAccessV3 && !runState.loading),
    seasonalPP: runState.seasonalPP.toString(),
    seasonalCP: runState.seasonalCP.toString(),
    rewardRules: runState.rewardRules ?? null,
    totalSeasonCP: runState.totalSeasonCP?.toString() ?? null,
    maxSeasonPoints: runState.maxSeasonPoints?.toString() ?? null,
    lifetimeCP: runState.lifetimeCP.toString(),
    lifetimeNature: runState.lifetimeNatureCollectedAtoms.toString(),
    accumulatedScore: runState.totalAccumulatedRebirthScore.toString(),
    seasonalAccumulatedScore: runState.seasonalAccumulatedRebirthScore.toString(),
    seasonalHighScoreTier: runState.seasonalHighScoreTier,
    nextCpMilestoneTier: runState.nextCpMilestoneTier,
    rebirthThresholdTier: runState.rebirthThresholdTier,
    seasonRebirths: runState.seasonRebirths,
    upgradeLevels: {
      growth: runState.upgradeLevels.growth,
      efficiency: runState.upgradeLevels.efficiency,
      awakening: runState.upgradeLevels.awakening,
      rebirth: runState.upgradeLevels.rebirth,
    },
    wallet: runState.wallet,
    error: walletError ?? runState.error ?? auth.error ?? null,
  }), [
    auth.error,
    auth.isAuthenticated,
    hasActiveRun,
    runState.canAccessV3,
    runState.error,
    runState.lifetimeCP,
    runState.lifetimeNatureCollectedAtoms,
    runState.loading,
    runState.nextCpMilestoneTier,
    runState.rebirthThresholdTier,
    runState.runId,
    runState.rewardRules,
    runState.seasonalAccumulatedRebirthScore,
    runState.seasonalCP,
    runState.totalSeasonCP,
    runState.maxSeasonPoints,
    runState.seasonalHighScoreTier,
    runState.seasonalPP,
    runState.seasonRebirths,
    runState.totalAccumulatedRebirthScore,
    runState.upgradeLevels.awakening,
    runState.upgradeLevels.efficiency,
    runState.upgradeLevels.growth,
    runState.upgradeLevels.rebirth,
    runState.wallet,
    walletError,
  ]);

  const settlementControls = useMemo<V3LivingSettlementControls>(() => ({
    pending: transactionState === 'pending',
    canSettle: canSettleRun,
    error: walletError,
    openStartRun,
    recordPoints: () => void recordRunPoints(),
    rebirth: () => void rebirthRun(),
  }), [canSettleRun, openStartRun, recordRunPoints, rebirthRun, transactionState, walletError]);

  useEffect(() => onProfileChange(playerProfile), [onProfileChange, playerProfile]);
  useEffect(() => onSettlementControlsReady(settlementControls), [onSettlementControlsReady, settlementControls]);
  useEffect(() => () => {
    onProfileChange(null);
    onSettlementControlsReady(null);
    onActionHandlersReady(null);
    onHeartActionReady(null);
    onSnapshotChange(null);
  }, [onActionHandlersReady, onHeartActionReady, onProfileChange, onSettlementControlsReady, onSnapshotChange]);

  const flowStatus = startFlow.state.status;
  const flowMessage =
    flowStatus === 'success'
      ? `Run confirmed${startFlow.state.transactionHash ? ` · ${startFlow.state.transactionHash}` : ''}`
      : flowStatus === 'confirming'
        ? 'Confirming Start Run transaction…'
        : flowStatus === 'submitting-transaction'
          ? 'Submitting Start Run transaction…'
          : flowStatus === 'requesting-attestation'
            ? 'Requesting verifier attestation…'
            : flowStatus === 'authenticating'
              ? 'Preparing authenticated wallet session…'
              : flowStatus === 'error'
                ? (startFlow.state.error ?? 'Start Run failed.')
                : null;

  const disconnectLabel = walletReconnecting
    ? 'Restoring wallet…'
    : !runState.wallet
      ? 'Connect wallet'
    : !runState.isCorrectChain
      ? `Switch to ${TARGET_NETWORK_LABEL}`
      : `Disconnect ${runState.wallet.slice(0, 6)}…${runState.wallet.slice(-4)}`;

  const walletReconnectRequired =
    walletAccount.status === 'disconnected' &&
    Boolean(auth.wallet && (auth.isAuthenticated || auth.error === 'Session expired'));

  return (
    <div className="v3-living-tools">
      {walletReconnectRequired && (
        <div className="v3-wallet-reconnect-backdrop">
          <section
            className="v3-wallet-reconnect-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="v3-wallet-reconnect-title"
          >
            <span className="v3-wallet-reconnect-eyebrow">LIVE RUN PAUSED</span>
            <h2 id="v3-wallet-reconnect-title">Reconnect your wallet</h2>
            <p>
              {auth.isAuthenticated
                ? 'Your Live session is still available. Reconnect the same wallet to resume this run.'
                : 'Reconnect the same wallet, then sign in again to resume this run.'}
            </p>
            <button type="button" onClick={() => void handleWalletAction()} disabled={walletBusy}>
              {walletBusy ? 'Reconnecting…' : 'Reconnect wallet'}
            </button>
            <button
              type="button"
              className="v3-wallet-reconnect-guest"
              onClick={onSwitchToGuest}
            >
              Continue as Guest
            </button>
          </section>
        </div>
      )}
      <details className="v3-living-account">
        <summary>
          {runState.wallet ? `${runState.wallet.slice(0, 6)}…${runState.wallet.slice(-4)}` : 'Live account'}
          <span>{auth.isAuthenticated ? ' · ready' : ''}</span>
        </summary>
        <div className="v3-living-account-panel">
          <p className="v3-living-account-mode">Live · {TARGET_NETWORK_LABEL}</p>
          <p>Guest progress is simulated. Live rewards require an authenticated verifier-backed run.</p>
          {walletReconnecting && (
            <p role="status" aria-live="polite">Restoring the wallet connection saved by your browser…</p>
          )}
          <button type="button" onClick={() => void handleWalletAction()} disabled={walletBusy}>
            {connecting ? 'Connecting…' : switching ? 'Switching…' : disconnectLabel}
          </button>
          {runState.wallet && runState.isCorrectChain && (
            <>
              <p aria-live="polite">
                {auth.isAuthenticated
                  ? 'Wallet authenticated for this run.'
                  : !auth.isConfigured
                    ? 'Verifier is not configured.'
                    : authenticationRunId === undefined
                      ? 'Waiting for the next run ID.'
                      : isAuthenticating
                        ? 'Confirm the sign-in message in your wallet.'
                        : auth.error ?? 'Authenticate to load and play a Live run.'}
              </p>
              {auth.isAuthenticated ? (
                <button type="button" onClick={auth.logout}>End session</button>
              ) : (
                <button
                  type="button"
                  onClick={() => void authenticateWallet()}
                  disabled={!walletReady || !canAuthenticate || isAuthenticating}
                >
                  {isAuthenticating
                    ? 'Authenticating…'
                    : auth.error === 'Session expired'
                      ? 'Sign in again'
                      : 'Authenticate wallet'}
                </button>
              )}
              {!hasActiveRun && auth.isAuthenticated && (
                <button
                  type="button"
                  className="v3-start-run-trigger"
                  onClick={() => setStartRunOpen(true)}
                  disabled={!walletReady}
                >
                  {walletReconnecting ? 'Restoring wallet…' : 'Start a Live run'}
                </button>
              )}
            </>
          )}
          {(walletError || auth.error) && (
            <p className="v3-living-error" role="alert">{walletError ?? auth.error}</p>
          )}
          {flowMessage && (
            <p className={`v3-living-flow v3-living-flow--${flowStatus}`} role={flowStatus === 'error' ? 'alert' : 'status'} aria-live="polite">
              {flowMessage}
            </p>
          )}
          {flowStatus === 'error' && startFlow.canRetry && auth.isAuthenticated && !runState.isStarting && (
            <button type="button" onClick={() => void startFlow.retry(lastStartChoices.current)}>
              Retry Start Run
            </button>
          )}
        </div>
      </details>

      {startRunOpen && !hasActiveRun && auth.isAuthenticated && (
        <div
          className="v3-start-run-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setStartRunOpen(false);
            }
          }}
        >
          <section
            className="v3-start-run-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="v3-start-run-dialog-title"
          >
            <header>
              <div>
                <span>LIVE MODE</span>
                <h2 id="v3-start-run-dialog-title">Prepare your run</h2>
              </div>
              <button
                type="button"
                className="v3-start-run-close"
                aria-label="Close Start Run dialog"
                autoFocus
                onClick={() => {
                  setStartRunOpen(false);
                }}
              >
                ×
              </button>
            </header>
            <V3RunControls
              runState={statusRunState}
              transactionState={transactionState}
              onStartRun={startVerifiedRun}
            />
          </section>
        </div>
      )}

      <details className="v3-advanced-activity">
        <summary>Advanced</summary>
        <div className="v3-advanced-panel">
        {settlement.status !== 'idle' && (
          <p className={`v3-living-flow v3-living-flow--${transactionState}`} role={settlement.status === 'failed' || settlement.status === 'uncertain' ? 'alert' : 'status'} aria-live="polite">
            {settlement.error ??
              (settlement.status === 'confirmed'
                ? `${settlement.action === 'recordPoints' ? 'Record Points' : 'Rebirth'} confirmed${settlement.transactionHash ? ` · ${settlement.transactionHash}` : ''}`
                : `${settlement.action === 'recordPoints' ? 'Record Points' : 'Rebirth'} ${settlement.status.replaceAll('-', ' ')}…`)}
          </p>
        )}
        {hasActiveRun && (
          <details className="v3-abandon-section">
            <summary>Abandon this run</summary>
            <p>Abandoning forfeits this run's Nature and habitat progress.</p>
            <button
              type="button"
              onClick={async () => {
                try {
                  await flushPendingCommandsRef.current?.();
                  await runState.abandonRun(runState.runId);
                  auth.logout();
                  await runState.refetch();
                  await startFlow.refreshNextRunId();
                } catch (error) {
                  setWalletError(error instanceof Error ? error.message : 'Live actions must sync before abandoning.');
                }
              }}
              disabled={transactionState === 'pending'}
            >
              Abandon Live run
            </button>
          </details>
        )}
        {hasActiveRun && auth.isAuthenticated && activeVerifiedRunId && auth.sessionToken && (
          <V3VerifiedGameplay
            key={activeVerifiedRunId}
            runId={activeVerifiedRunId}
            sessionToken={auth.sessionToken}
            onSnapshotChange={onSnapshotChange}
            onHeartActionReady={onHeartActionReady}
            onActionHandlersReady={forwardActionHandlers}
          />
        )}
        {hasActiveRun && !auth.isAuthenticated && (
          <p role="status">Authenticate in Live account to recover this run's state.</p>
        )}
        </div>
      </details>
    </div>
  );
}
