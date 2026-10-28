import { useRef, useState, type ReactNode } from 'react';
import { useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { V3RunControls } from '../v3/components/V3RunControls';
import { V3StatusPanel } from '../v3/components/V3StatusPanel';
import { V3VerifiedGameplay } from '../v3/components/V3VerifiedGameplay';
import type { V3IslandSnapshot } from '../v3/components/V3VerifiedGameplay';
import { useStartRunFlow } from '../v3/hooks/useStartRunFlow';
import { useV3Auth } from '../v3/hooks/useV3Auth';
import { useV3Run } from '../v3/hooks/useV3Run';
import { useV3Settlement } from '../v3/hooks/useV3Settlement';
import type { V3UpgradeKind } from '../v3/types';
import { TARGET_CHAIN_ID } from '../blockchain/config';
import './V3IntegrationShell.css';

interface V3IntegrationShellProps {
  guestGame: ReactNode;
}

/** Optional integration entry point. Guest gameplay remains the primary playable experience. */
export function V3IntegrationShell({ guestGame }: V3IntegrationShellProps) {
  const [view, setView] = useState<'guest' | 'verified'>('guest');

  return (
    <div className="v3-integration-shell">
      <nav className="v3-integration-nav" aria-label="Worldseed game mode">
        <button type="button" aria-pressed={view === 'guest'} onClick={() => setView('guest')}>
          Guest game
        </button>
        <button
          type="button"
          aria-pressed={view === 'verified'}
          onClick={() => setView('verified')}
        >
          Verified progression
        </button>
      </nav>

      <div className="v3-integration-guest" hidden={view !== 'guest'}>
        {guestGame}
      </div>
      {view === 'verified' && <VerifiedProgression onReturnToGuest={() => setView('guest')} />}
    </div>
  );
}

/** Verified wallet flow embedded alongside the guest island, without replacing its screen. */
export function V3IslandProgression({
  onSnapshotChange,
  onHeartActionReady,
}: {
  onSnapshotChange: (snapshot: V3IslandSnapshot | null) => void;
  onHeartActionReady: (action: (() => void) | null) => void;
}) {
  return (
    <details className="v3-island-mode" open>
      <summary>Verified mode · Hemi Sepolia</summary>
      <VerifiedProgression
        compact
        onSnapshotChange={onSnapshotChange}
        onHeartActionReady={onHeartActionReady}
      />
    </details>
  );
}

function VerifiedProgression({
  onReturnToGuest,
  compact = false,
  onSnapshotChange,
  onHeartActionReady,
}: {
  onReturnToGuest?: () => void;
  compact?: boolean;
  onSnapshotChange?: (snapshot: V3IslandSnapshot | null) => void;
  onHeartActionReady?: (action: (() => void) | null) => void;
}) {
  const runState = useV3Run();
  const auth = useV3Auth();
  const settlement = useV3Settlement(auth.isAuthenticated ? auth.sessionToken : null);
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const [walletError, setWalletError] = useState<string | null>(null);
  const activeVerifiedRunId =
    runState.runId > 0n && runState.run?.status === 'ACTIVE'
      ? runState.runId.toString()
      : undefined;
  const startFlow = useStartRunFlow({
    onAuthRequired: async () => {
      if (!auth.isAuthenticated || !auth.sessionToken)
        throw new Error('Authenticate your wallet before starting a verified run.');
      return auth.sessionToken;
    },
    onStartRun: async (sessionToken, upgrades) => {
      const hash = await runState.startRun(sessionToken, upgrades);
      await Promise.allSettled([runState.refetch()]);
      return hash;
    },
  });
  const authenticationRunId = activeVerifiedRunId ?? startFlow.nextRunId?.toString();
  const lastStartChoices = useRef<Array<{ upgradeId: V3UpgradeKind; quantity: number }>>([]);
  // The current hook's derived access flag can be undefined before wallet/config state settles.
  const statusRunState = { ...runState, canAccessV3: Boolean(runState.canAccessV3) };
  const hasActiveRun = runState.runId > 0n && runState.run?.status === 'ACTIVE';
  const isAuthenticating = ['requesting-challenge', 'signing', 'completing'].includes(auth.status);
  const canAuthenticate = Boolean(auth.canAuthenticate && authenticationRunId !== undefined);
  const walletBusy = connecting || switching;
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
    if (!canAuthenticate || authenticationRunId === undefined) return;
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
    const upgradeNames: V3UpgradeKind[] = ['growth', 'efficiency', 'awakening', 'rebirth'];
    const choices = upgrades.map(({ upgradeId, quantity }) => {
      const upgradeIdName = upgradeNames[upgradeId];
      if (!upgradeIdName) throw new Error(`Unknown V3 upgrade ID: ${upgradeId}`);
      return { upgradeId: upgradeIdName, quantity };
    });
    lastStartChoices.current = choices;
    await startFlow.start(choices);
  }

  const canSettleRun = Boolean(
    hasActiveRun && auth.isAuthenticated && settlement.canSettle && !runState.loading,
  );

  async function recordRunPoints() {
    try {
      await settlement.recordPoints();
      await runState.refetch();
    } catch {
      // The settlement hook exposes the failure state for the UI below.
    }
  }

  async function rebirthRun() {
    try {
      await settlement.rebirth();
      // A confirmed rebirth closes this run and makes the next session bind to
      // counter + 1. End the old run-bound verifier session before refreshing.
      auth.logout();
      await Promise.allSettled([runState.refetch(), startFlow.refreshNextRunId()]);
    } catch {
      // The settlement hook exposes the failure/uncertain state for recovery.
    }
  }

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

  return (
    <section className={`v3-integration-page${compact ? ' v3-integration-page--embedded' : ''}`}>
      <header className="v3-integration-heading">
        <div>
          <p>WORLDSEED V3</p>
          <h1>Verified progression</h1>
        </div>
        {!compact && (
          <div className="v3-integration-heading-actions">
            <button type="button" onClick={() => void handleWalletAction()} disabled={walletBusy}>
              {connecting
                ? 'Connecting wallet…'
                : switching
                  ? 'Switching network…'
                  : !runState.wallet
                    ? 'Connect wallet'
                    : !runState.isCorrectChain
                      ? 'Switch to Hemi Sepolia'
                      : `Disconnect ${runState.wallet.slice(0, 6)}…${runState.wallet.slice(-4)}`}
            </button>
            {onReturnToGuest && (
              <button type="button" onClick={onReturnToGuest}>
                Return to guest game
              </button>
            )}
          </div>
        )}
      </header>
      <p className="v3-integration-explanation">
        Guest play is available without a wallet. Verified progress is separate and requires a
        connected wallet on Hemi Sepolia. Guest saves are never converted into wallet rewards.
      </p>
      <V3StatusPanel runState={statusRunState} onRefetch={() => void runState.refetch()} />
      <section className="v3-integration-auth" aria-label="Wallet authentication">
        <div className="v3-integration-section-heading">
          <h2>Wallet authentication</h2>
          <strong>{auth.isAuthenticated ? 'Authenticated' : auth.status}</strong>
        </div>
        <p aria-live="polite">
          {auth.isAuthenticated
            ? `Wallet ${auth.wallet?.slice(0, 6)}…${auth.wallet?.slice(-4)} is authenticated for this session.`
            : !auth.isConfigured
              ? 'V3 is not configured. Set the V3 contract address to enable authentication.'
              : !auth.wallet
                ? 'Connect a wallet to authenticate.'
                : !auth.isCorrectChain
                  ? 'Switch to Hemi Sepolia before authenticating.'
                  : authenticationRunId === undefined
                    ? 'Waiting for the contract to provide the next run ID before signing.'
                    : auth.status === 'signing'
                      ? 'Confirm the sign-in message in your wallet. This message does not authorize a transaction.'
                      : auth.status === 'completing' || auth.status === 'requesting-challenge'
                        ? 'Completing wallet authentication…'
                        : (auth.error ??
                          'Authenticate this wallet before starting a verified run.')}
        </p>
        {auth.error && (
          <p className="v3-integration-error" role="alert">
            {auth.error}
          </p>
        )}
        {walletError && (
          <p className="v3-integration-error" role="alert">
            {walletError}
          </p>
        )}
        {auth.isAuthenticated ? (
          <button type="button" onClick={auth.logout} className="v3-integration-action">
            End wallet session
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void authenticateWallet()}
            disabled={!canAuthenticate || isAuthenticating}
            className="v3-integration-action"
          >
            {isAuthenticating ? 'Authenticating…' : 'Authenticate wallet'}
          </button>
        )}
      </section>

      {flowMessage && (
        <p
          className={`v3-integration-flow-status v3-integration-flow-status--${flowStatus}`}
          role={flowStatus === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {flowMessage}
        </p>
      )}

      {(!runState.canAccessV3 || auth.isAuthenticated || hasActiveRun) &&
        (hasActiveRun ? (
          <>
            <V3RunControls
              runState={statusRunState}
              transactionState={transactionState}
              onRecordPoints={canSettleRun ? recordRunPoints : undefined}
              onRebirth={canSettleRun ? rebirthRun : undefined}
              onAbandonRun={async () => {
                await runState.abandonRun(runState.runId);
                auth.logout();
                await runState.refetch();
                await startFlow.refreshNextRunId();
              }}
            />
            {settlement.status !== 'idle' && (
              <p
                className={`v3-integration-flow-status v3-integration-flow-status--${transactionState}`}
                role={
                  settlement.status === 'failed' || settlement.status === 'uncertain'
                    ? 'alert'
                    : 'status'
                }
                aria-live="polite"
              >
                {settlement.error ??
                  (settlement.status === 'confirmed'
                    ? `${settlement.action === 'recordPoints' ? 'Record Points' : 'Rebirth'} confirmed${settlement.transactionHash ? ` · ${settlement.transactionHash}` : ''}`
                    : `${settlement.action === 'recordPoints' ? 'Record Points' : 'Rebirth'} ${settlement.status.replaceAll('-', ' ')}…`)}
              </p>
            )}
            {!auth.isAuthenticated && (
              <p role="status">Authenticate for this run before recording points or rebirthing.</p>
            )}
          </>
        ) : (
          <V3RunControls
            runState={statusRunState}
            transactionState={transactionState}
            onStartRun={startVerifiedRun}
          />
        ))}

      {hasActiveRun && auth.isAuthenticated && activeVerifiedRunId && auth.sessionToken && (
        <V3VerifiedGameplay
          key={activeVerifiedRunId}
          runId={activeVerifiedRunId}
          sessionToken={auth.sessionToken}
          onSnapshotChange={onSnapshotChange}
          onHeartActionReady={onHeartActionReady}
        />
      )}

      {flowStatus === 'error' &&
        startFlow.canRetry &&
        auth.isAuthenticated &&
        !runState.isStarting && (
          <button
            type="button"
            className="v3-integration-action"
            onClick={() => void startFlow.retry(lastStartChoices.current)}
          >
            Retry Start Run
          </button>
        )}
    </section>
  );
}
