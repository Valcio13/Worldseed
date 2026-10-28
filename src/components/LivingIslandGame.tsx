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
import { LivingIslandScreen, type LivingIslandMode } from './LivingIslandScreen';
import { AudioSettings } from './AudioSettings';
import { V3IslandProgression } from './V3IntegrationShell';
import type { V3IslandSnapshot } from '../v3/components/V3VerifiedGameplay';
import './LivingIsland.css';
import { islandGrowthStage } from './islandGrowthStage';

export function LivingIslandGame() {
  const account = useAccount();
  const chainId = useChainId();
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const [economy, setEconomy] = useState<EconomyState>(() =>
    createEconomyState(seasonIdAt(Date.now())),
  );
  const [loaded, setLoaded] = useState(false);
  const [saveReady, setSaveReady] = useState(false);
  const [saveLabel, setSaveLabel] = useState('Loading save');
  const [notice, setNotice] = useState('');
  const [saveDecision, setSaveDecision] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [mode, setMode] = useState<LivingIslandMode>('guest');
  const [verifiedIsland, setVerifiedIsland] = useState<V3IslandSnapshot | null>(null);
  const [verifiedHeartAction, setVerifiedHeartAction] = useState<(() => void) | null>(null);
  const restorationRef = useRef(createGameState('guest-living-island'));
  const legacyRestorationRef = useRef<ReturnType<typeof createGameState> | undefined>(undefined);
  const lastCheckpointRef = useRef<number | null>(null);
  const nextSeasonStart = seasonStartAt(economy.seasonId + 1);
  const verifiedModeEnabled = isV3IdleIntegrationEnabled();

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
            setNotice('A new weekly season has begun. Your island is ready to grow again.');
          else if (restored.secondsApplied > 0)
            setNotice(`Welcome back. Your island grew while you were away.`);
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
          setNotice(
            'Guest play is available for this session, but local saving could not be opened.',
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
        setNotice('A new weekly season has begun. Your island is ready to grow again.');
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
        setNotice('A new weekly season has begun. Your island is ready to grow again.');
      } else
        setNotice(
          'Your device clock is earlier than the active season; this action was not applied.',
        );
      return;
    }
    if (result.error) {
      setNotice(result.error);
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
    setNotice(result.events.map((event) => event.message).join(' '));
  }

  async function keepPlaying() {
    try {
      await archiveIncompatibleSave();
      setEconomy(createEconomyState(seasonIdAt(Date.now())));
      restorationRef.current = createGameState(`guest-${Date.now()}`);
      setSaveDecision(false);
      setSaveReady(true);
      setSaveError(false);
      setNotice('A fresh Living Island is ready. The older save was backed up.');
    } catch {
      setNotice('The older save could not be backed up, so it remains untouched.');
    }
  }

  async function handleWallet() {
    try {
      if (account.isConnected) {
        if (chainId !== TARGET_CHAIN_ID) await switchChainAsync({ chainId: TARGET_CHAIN_ID });
        else disconnect();
      } else if (connectors[0]) await connectAsync({ connector: connectors[0] });
      else setNotice('No browser wallet was found. Guest play does not require a wallet.');
    } catch (error) {
      setNotice(transactionFailureMessage(error, 'Wallet request'));
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
    }
    setMode(nextMode);
  }

  const acceptVerifiedHeartAction = useCallback((action: (() => void) | null) => {
    setVerifiedHeartAction(() => action);
  }, []);

  return (
    <>
      <LivingIslandScreen
        state={economy}
        mode={mode}
        verifiedModeEnabled={verifiedModeEnabled}
        verifiedIsland={verifiedIsland}
        verifiedHeartAction={verifiedHeartAction}
        onModeChange={changeMode}
        nextSeasonStart={nextSeasonStart}
        saveLabel={loaded ? saveLabel : 'Loading save'}
        walletControl={walletControl}
        audioControls={<AudioSettings />}
        verifiedProgression={
          verifiedModeEnabled && mode === 'verified' ? (
            <V3IslandProgression
              onSnapshotChange={setVerifiedIsland}
              onHeartActionReady={acceptVerifiedHeartAction}
            />
          ) : undefined
        }
        notice={notice}
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
