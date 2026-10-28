import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from 'wagmi';
import {
  applyOfflineProgress,
  clickIslandHeart,
  createEconomyState,
  performRebirth,
  resetForNewSeason,
  seasonIdAt,
  seasonStartAt,
  type ActionResult,
  type EconomyState,
} from '../incremental/engine';
import { createGameState } from '../game/rules';
import { playIslandSound } from '../game/sound';
import {
  archiveIncompatibleSave,
  loadGuestSave,
  restoreGuestProgress,
  saveGuestSave,
} from '../persistence/localSave';
import { TARGET_CHAIN_ID, TARGET_CHAIN_NAME } from '../blockchain/config';
import { transactionFailureMessage } from '../blockchain/transactions';
import { isV3IdleIntegrationEnabled } from '../integration/featureFlags';
import { clearV3AuthSession } from '../v3/hooks/useV3Auth';
import { LivingIslandScreen, type LivingIslandMode } from './LivingIslandScreen';
import { AudioSettings } from './AudioSettings';
import {
  V3IslandProgression,
  type V3LivingProfile,
  type V3LivingSettlementControls,
} from './V3IntegrationShell';
import type { V3IslandSnapshot } from '../v3/components/V3VerifiedGameplay';
import type { V3IslandActionHandlers } from '../v3/components/V3VerifiedGameplay';
import './LivingIsland.css';
import { islandGrowthStage } from './islandGrowthStage';

const MODE_PREFERENCE_KEY = 'worldseed:play-mode:v1';

export function initialLivingIslandMode(
  savedPreference: string | null,
  isProduction: boolean,
  liveEnabled: boolean,
): LivingIslandMode {
  if (savedPreference === 'guest') return 'guest';
  if ((savedPreference === 'live' || savedPreference === 'verified') && liveEnabled)
    return 'verified';
  return isProduction && liveEnabled ? 'verified' : 'guest';
}

function readModePreference(): string | null {
  try {
    return window.localStorage.getItem(MODE_PREFERENCE_KEY);
  } catch {
    return null;
  }
}

export function LivingIslandGame() {
  const account = useAccount();
  const chainId = useChainId();
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const verifiedModeEnabled = isV3IdleIntegrationEnabled();
  const [economy, setEconomy] = useState<EconomyState>(() =>
    createEconomyState(seasonIdAt(Date.now())),
  );
  const [loaded, setLoaded] = useState(false);
  const [saveReady, setSaveReady] = useState(false);
  const [saveLabel, setSaveLabel] = useState('Loading save');
  const [notice, setNotice] = useState<{
    id: number;
    message: string;
    important: boolean;
  } | null>(null);
  const noticeIdRef = useRef(0);
  const [saveDecision, setSaveDecision] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [mode, setMode] = useState<LivingIslandMode>(() =>
    initialLivingIslandMode(readModePreference(), import.meta.env.PROD, verifiedModeEnabled),
  );
  const [verifiedIsland, setVerifiedIsland] = useState<V3IslandSnapshot | null>(null);
  const [verifiedHeartAction, setVerifiedHeartAction] = useState<(() => boolean) | null>(null);
  const [verifiedActions, setVerifiedActions] = useState<V3IslandActionHandlers | null>(null);
  const [verifiedProfile, setVerifiedProfile] = useState<V3LivingProfile | null>(null);
  const [verifiedSettlement, setVerifiedSettlement] = useState<V3LivingSettlementControls | null>(null);
  const restorationRef = useRef(createGameState('guest-living-island'));
  const legacyRestorationRef = useRef<ReturnType<typeof createGameState> | undefined>(undefined);
  const lastCheckpointRef = useRef<number | null>(null);
  const nextSeasonStart = seasonStartAt(economy.seasonId + 1);

  function showNotice(message: string, important = false) {
    setNotice({ id: ++noticeIdRef.current, message, important });
  }

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(
      () => setNotice((current) => (current?.id === notice.id ? null : current)),
      notice.important ? 15_000 : 5_000,
    );
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    let alive = true;
    void loadGuestSave()
      .then(async (result) => {
        if (!alive) return;
        if (result.kind === 'current') {
          const now = Date.now();
          const restored = restoreGuestProgress(result.save, now);
          restorationRef.current = restored.restoration;
          legacyRestorationRef.current = result.save.legacyRestoration;
          await saveGuestSave(
            restored.state,
            restored.restoration,
            result.save.legacyRestoration,
            now,
          );
          if (!alive) return;
          setEconomy(restored.state);
          lastCheckpointRef.current = now;
          if (restored.seasonChanged)
            showNotice('A new weekly season has begun. Your island is ready to grow again.');
          else if (restored.secondsApplied > 0)
            showNotice('Welcome back. Your island grew while you were away.');
          setSaveReady(true);
        } else if (result.kind === 'legacy') {
          // Keep the old restoration save attached for compatibility while beginning the incremental game.
          restorationRef.current = result.restoration;
          setSaveReady(true);
        } else if (result.kind === 'incompatible') {
          setSaveDecision(true);
        } else {
          setSaveReady(true);
        }
      })
      .catch(() => {
        if (alive) {
          setSaveError(true);
          setSaveLabel('Local save unavailable');
          showNotice(
            'Guest play is available for this session, but local saving could not be opened.',
            true,
          );
        }
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!loaded || !saveReady || saveDecision || saveError) return;
    const timer = window.setTimeout(() => {
      setSaveLabel('Saving');
      void saveGuestSave(economy, restorationRef.current, legacyRestorationRef.current)
        .then(() => setSaveLabel('Saved'))
        .catch(() => {
          setSaveError(true);
          setSaveLabel('Save unavailable');
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [economy, loaded, saveReady, saveDecision, saveError]);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      const season = seasonIdAt(now);
      if (season > economy.seasonId) {
        lastCheckpointRef.current = now;
        restorationRef.current = createGameState(`season-${season}`);
        setEconomy((previous) => resetForNewSeason(previous, season));
        showNotice('A new weekly season has begun. Your island is ready to grow again.');
      } else if (season === economy.seasonId) {
        const checkpoint = lastCheckpointRef.current ?? now;
        lastCheckpointRef.current = now;
        setEconomy((previous) =>
          previous.seasonId === season
            ? applyOfflineProgress(previous, checkpoint, now).state
            : previous,
        );
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [loaded, economy.seasonId]);

  function applyResult(result: ActionResult) {
    const season = seasonIdAt(Date.now());
    if (season !== economy.seasonId) {
      if (season > economy.seasonId) {
        lastCheckpointRef.current = Date.now();
        restorationRef.current = createGameState(`season-${season}`);
        setEconomy((previous) => resetForNewSeason(previous, season));
        showNotice('A new weekly season has begun. Your island is ready to grow again.');
      } else
        showNotice(
          'Your device clock is earlier than the active season; this action was not applied.',
          true,
        );
      return;
    }
    if (result.error) {
      showNotice(result.error, true);
      return;
    }
    const rebirth = result.events.some((event) => event.kind === 'rebirth');
    const evolved = islandGrowthStage(result.state) !== islandGrowthStage(economy);
    if (rebirth) playIslandSound('rebirth');
    else if (evolved || result.events.some((event) => event.kind === 'milestone'))
      playIslandSound('evolution');
    else if (result.events.some((event) => event.kind === 'heart-click'))
      playIslandSound('collect');
    else if (result.events.some((event) => event.kind === 'habitat-bought'))
      playIslandSound('habitat');
    else if (result.events.some((event) => event.kind === 'upgrade-bought'))
      playIslandSound('upgrade');
    setEconomy(result.state);
    showNotice(result.events.map((event) => event.message).join(' '));
  }

  async function keepPlaying() {
    try {
      await archiveIncompatibleSave();
      setEconomy(createEconomyState(seasonIdAt(Date.now())));
      restorationRef.current = createGameState(`guest-${Date.now()}`);
      setSaveDecision(false);
      setSaveReady(true);
      setSaveError(false);
      showNotice('A fresh Living Island is ready. The older save was backed up.');
    } catch {
      showNotice('The older save could not be backed up, so it remains untouched.', true);
    }
  }

  async function handleWallet() {
    try {
      if (account.isConnected) {
        if (chainId !== TARGET_CHAIN_ID) await switchChainAsync({ chainId: TARGET_CHAIN_ID });
        else {
          clearV3AuthSession();
          disconnect();
        }
      } else if (connectors[0]) await connectAsync({ connector: connectors[0] });
      else showNotice('No browser wallet was found. Guest play does not require a wallet.');
    } catch (error) {
      showNotice(transactionFailureMessage(error, 'Wallet request'), true);
    }
  }

  const walletControl = (
    <button
      className="living-wallet-button"
      type="button"
      onClick={() => void handleWallet()}
      disabled={connecting || switching}
    >
      {connecting
        ? 'Connecting…'
        : switching
          ? 'Switching…'
          : account.isConnected
            ? chainId === TARGET_CHAIN_ID
              ? `${account.address?.slice(0, 6)}…${account.address?.slice(-4)}`
              : `Switch to ${TARGET_CHAIN_NAME}`
            : 'Connect wallet'}
    </button>
  );

  function changeMode(nextMode: LivingIslandMode) {
    if (nextMode === 'guest') {
      setVerifiedIsland(null);
      setVerifiedHeartAction(null);
      setVerifiedActions(null);
      setVerifiedProfile(null);
      setVerifiedSettlement(null);
    }
    setMode(nextMode);
    try {
      window.localStorage.setItem(MODE_PREFERENCE_KEY, nextMode === 'verified' ? 'live' : 'guest');
    } catch {
      // A mode preference is optional; guest and Live progression remain separate either way.
    }
  }

  const acceptVerifiedHeartAction = useCallback((action: (() => boolean) | null) => {
    setVerifiedHeartAction(() => action);
  }, []);

  const acceptVerifiedIsland = useCallback((next: V3IslandSnapshot | null) => {
    setVerifiedIsland((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  }, []);

  const acceptVerifiedActions = useCallback((next: V3IslandActionHandlers | null) => {
    setVerifiedActions((previous) => {
      if (
        previous?.pending === next?.pending &&
        previous?.heartClickPending === next?.heartClickPending &&
        previous?.pendingHeartClicks === next?.pendingHeartClicks &&
        previous?.buyHabitat === next?.buyHabitat &&
        previous?.buyProductionUpgrade === next?.buyProductionUpgrade &&
        previous?.flushPendingCommands === next?.flushPendingCommands
      ) return previous;
      return next;
    });
  }, []);

  const acceptVerifiedProfile = useCallback((next: V3LivingProfile | null) => {
    setVerifiedProfile((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  }, []);

  const acceptVerifiedSettlement = useCallback((next: V3LivingSettlementControls | null) => {
    setVerifiedSettlement((previous) => {
      if (previous?.pending === next?.pending && previous?.canSettle === next?.canSettle)
        return previous;
      return next;
    });
  }, []);

  return (
    <>
      <LivingIslandScreen
        state={economy}
        mode={mode}
        verifiedModeEnabled={verifiedModeEnabled}
        verifiedIsland={verifiedIsland}
        verifiedHeartAction={verifiedHeartAction}
        verifiedActions={verifiedActions}
        verifiedProfile={verifiedProfile}
        verifiedSettlement={verifiedSettlement}
        onModeChange={changeMode}
        nextSeasonStart={nextSeasonStart}
        saveLabel={loaded ? saveLabel : 'Loading save'}
        walletControl={walletControl}
        audioControls={<AudioSettings />}
        verifiedProgression={
          verifiedModeEnabled && mode === 'verified' ? (
            <V3IslandProgression
              onSnapshotChange={acceptVerifiedIsland}
              onHeartActionReady={acceptVerifiedHeartAction}
              onActionHandlersReady={acceptVerifiedActions}
              onProfileChange={acceptVerifiedProfile}
              onSettlementControlsReady={acceptVerifiedSettlement}
            />
          ) : undefined
        }
        notice={notice?.message}
        noticeImportant={notice?.important ?? false}
        onNoticeDismiss={() => setNotice(null)}
        onHeartClick={() => applyResult(clickIslandHeart(economy))}
        onStateChange={applyResult}
        onRebirth={() => applyResult(performRebirth(economy))}
      />
      {saveDecision && (
        <div className="living-save-overlay">
          <section role="dialog" aria-modal="true" aria-labelledby="living-save-title">
            <span className="living-eyebrow">LOCAL SAVE</span>
            <h2 id="living-save-title">An older save needs a backup</h2>
            <p>Back up the unrecognized save before starting a new Living Island.</p>
            <button type="button" onClick={() => void keepPlaying()}>
              Back up and continue
            </button>
          </section>
        </div>
      )}
    </>
  );
}
