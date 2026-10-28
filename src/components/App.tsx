import {
  useLayoutEffect,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { keccak256, toBytes } from 'viem';
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from 'wagmi';
import {
  gameContractAbi,
  gameContractAddress,
  TARGET_CHAIN_ID,
  TARGET_CHAIN_NAME,
} from '../blockchain/config';
import {
  applyAction,
  createGameState,
  healthyAt,
  healthyCount,
  isHeartComplete,
} from '../game/rules';
import { REGIONS, type GameEvent, type GameState, type Habitat } from '../game/types';
import {
  characterPresentationClasses,
  clampCameraOffset,
  logicalTileAtPoint,
  residentsNearCell,
  stepResident,
  visibleResidents,
  type Resident,
} from '../game/islandPresentation';
import { playIslandSound } from '../game/sound';
import { requireSuccessfulReceipt, transactionFailureMessage } from '../blockchain/transactions';
import { IslandTerrain } from './IslandTerrain';
import { EconomyPanel } from './EconomyPanel';
import {
  clickIslandHeart,
  createEconomyState,
  performRebirth,
  productionPerSecond,
  resetForNewSeason,
  seasonIdAt,
  seasonStartAt,
  applyOfflineProgress,
  type ActionResult,
  type EconomyState,
} from '../incremental/engine';
import { formatValue } from '../incremental/decimal';
import {
  archiveIncompatibleSave,
  loadGuestSave,
  restoreGuestProgress,
  saveGuestSave,
} from '../persistence/localSave';
import { LivingIslandGame } from './LivingIslandGame';
import { OpeningReveal } from './OpeningReveal';

const HABITATS: Array<{ id: Habitat; label: string; mark: string; tone: string }> = [
  { id: 'water', label: 'Water', mark: '≈', tone: 'water' },
  { id: 'grass', label: 'Grass', mark: '✿', tone: 'grass' },
  { id: 'forest', label: 'Forest', mark: '♧', tone: 'forest' },
];

const REGION_COPY: Record<string, string> = {
  clearing: 'A quiet place to begin.',
  'dry-basin': 'Bring water and green life back to the basin.',
  'forgotten-grove': 'Healthy ground invites the forest home.',
  'broken-highlands': 'Life climbs into the high country.',
  'island-heart': 'The Heart waits for a healthy connection.',
};

function actionHabitatCode(
  tool: 'place' | 'gather',
  habitat: Habitat,
  existing: Habitat | null | undefined,
) {
  if (tool === 'gather') return 0;
  return habitatCode(habitat ?? existing);
}

function habitatCode(habitat: Habitat | null | undefined): number {
  return habitat === 'water' ? 1 : habitat === 'grass' ? 2 : habitat === 'forest' ? 3 : 0;
}

function walletSaveKey(address: string): string {
  return `worldseed:onchain:${address.toLowerCase()}`;
}

function soundPreference(): boolean {
  try {
    return localStorage.getItem('worldseed:sound') !== 'off';
  } catch {
    return true;
  }
}

export function App() {
  useLayoutEffect(() => {
    document.body.classList.add('worldseed-app-scroll');
    return () => document.body.classList.remove('worldseed-app-scroll');
  }, []);

  return (
    <>
      <OpeningReveal />
      <LivingIslandGame />
    </>
  );
}

/** Retained as a compatibility reference; the restoration board is no longer the primary game. */
export function LegacyRestorationGame() {
  const account = useAccount();
  const chainId = useChainId();
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID });
  const chainState = useReadContract({
    address: gameContractAddress,
    abi: gameContractAbi,
    functionName: 'islandState',
    args: account.address ? [account.address] : undefined,
    query: {
      enabled: Boolean(gameContractAddress && account.address && chainId === TARGET_CHAIN_ID),
    },
  });
  const currentWeek = useReadContract({
    address: gameContractAddress,
    abi: gameContractAbi,
    functionName: 'currentWeek',
    query: { enabled: Boolean(gameContractAddress) },
  });
  const worldTree = useReadContract({
    address: gameContractAddress,
    abi: gameContractAbi,
    functionName: 'weeklyContributions',
    args: currentWeek.data === undefined ? undefined : [currentWeek.data],
    query: { enabled: Boolean(gameContractAddress && currentWeek.data !== undefined) },
  });
  const goldBalance = useReadContract({
    address: gameContractAddress,
    abi: gameContractAbi,
    functionName: 'goldBalances',
    args: account.address ? [account.address] : undefined,
    query: { enabled: Boolean(gameContractAddress && account.address) },
  });
  const { writeContractAsync } = useWriteContract();
  const [game, setGame] = useState<GameState>(() => createGameState(`guest-${Date.now()}`));
  const [economy, setEconomy] = useState<EconomyState>(() =>
    createEconomyState(seasonIdAt(Date.now())),
  );
  const nextSeasonStart = seasonStartAt(economy.seasonId + 1);
  const [chainCursor, setChainCursor] = useState(0n);
  const [pendingActions, setPendingActions] = useState<number[]>([]);
  const [transactionState, setTransactionState] = useState<
    'idle' | 'pending' | 'confirmed' | 'failed'
  >('idle');
  const [selected, setSelected] = useState<Habitat>('water');
  const [tool, setTool] = useState<'place' | 'gather' | 'inspect'>('place');
  const [notice, setNotice] = useState(
    'Choose a habitat, then place it beside the right neighbors.',
  );
  const [showTutorial, setShowTutorial] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showIslandDetails, setShowIslandDetails] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [localSaveReady, setLocalSaveReady] = useState(false);
  const [legacyRestoration, setLegacyRestoration] = useState<GameState | undefined>();
  const [saveDecision, setSaveDecision] = useState<'legacy' | 'incompatible' | null>(null);
  const [saveState, setSaveState] = useState<'saving' | 'saved' | 'error'>('saving');
  const [shopHabitat, setShopHabitat] = useState<Habitat>('grass');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [cameraZoom, setCameraZoom] = useState(1);
  const [cameraPan, setCameraPan] = useState({ x: 0, y: 0 });
  const [showMerchant, setShowMerchant] = useState(false);
  const [showWorldTree, setShowWorldTree] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(soundPreference);
  const [freshTile, setFreshTile] = useState<number | null>(null);
  const [reactingResidents, setReactingResidents] = useState<string[]>([]);
  const [sceneEvent, setSceneEvent] = useState<'unlock' | 'complete' | null>(null);
  const [residentPositions, setResidentPositions] = useState<
    Record<string, Pick<Resident, 'x' | 'y'>>
  >({});
  const [residentFacing, setResidentFacing] = useState<Record<string, -1 | 1>>({});
  const [walkingResidents, setWalkingResidents] = useState<string[]>([]);
  const boardRef = useRef<HTMLDivElement>(null);
  const guestRestorationRef = useRef(game);
  const lastEconomyCheckpointRef = useRef<number | null>(null);
  const residentLayerRef = useRef<HTMLDivElement>(null);
  const residentPositionsRef = useRef(residentPositions);
  const residentFacingRef = useRef(residentFacing);
  const walkingTimeoutRef = useRef<number | null>(null);
  const cameraPanRef = useRef(cameraPan);
  const reactionTimeoutRef = useRef<number | null>(null);
  const freshTileTimeoutRef = useRef<number | null>(null);
  const sceneEventTimeoutRef = useRef<number | null>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
    moved: boolean;
  } | null>(null);
  const suppressTileClickRef = useRef(false);

  useEffect(() => {
    let alive = true;
    loadGuestSave()
      .then(async (result) => {
        if (!alive) return;
        if (result.kind === 'current') {
          const save = result.save;
          const now = Date.now();
          const restored = restoreGuestProgress(save, now);
          // Commit the new timestamp together with the granted offline progress before exposing
          // it, so a reload cannot claim the same interval twice.
          await saveGuestSave(restored.state, restored.restoration, save.legacyRestoration, now);
          if (!alive) return;
          setEconomy(restored.state);
          setGame(restored.restoration);
          guestRestorationRef.current = restored.restoration;
          setLegacyRestoration(save.legacyRestoration);
          lastEconomyCheckpointRef.current = now;
          setLocalSaveReady(true);
          if (restored.seasonChanged) {
            setNotice('A new weekly guest season has begun. The previous season was archived.');
          } else if (restored.secondsApplied > 0) {
            setNotice(
              `Welcome back. Local offline growth was applied for ${Math.floor(restored.secondsApplied / 60)} minutes.`,
            );
          }
        } else if (result.kind === 'legacy') {
          setLegacyRestoration(result.restoration);
          setSaveDecision('legacy');
          setLocalSaveReady(true);
        } else if (result.kind === 'incompatible') {
          setSaveDecision('incompatible');
        } else {
          setLocalSaveReady(true);
        }
      })
      .catch(() => {
        if (alive)
          setNotice('Local save is unavailable here. Guest play still works for this session.');
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (reactionTimeoutRef.current !== null) window.clearTimeout(reactionTimeoutRef.current);
      if (freshTileTimeoutRef.current !== null) window.clearTimeout(freshTileTimeoutRef.current);
      if (sceneEventTimeoutRef.current !== null) window.clearTimeout(sceneEventTimeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!loaded || !localSaveReady || saveDecision) return;
    const timer = window.setTimeout(() => {
      setSaveState('saving');
      saveGuestSave(economy, guestRestorationRef.current, legacyRestoration)
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [economy, game, legacyRestoration, loaded, localSaveReady, saveDecision]);

  useEffect(() => {
    if (game.demo) guestRestorationRef.current = game;
  }, [game]);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      const wallClockSeason = seasonIdAt(now);
      if (wallClockSeason > economy.seasonId) {
        lastEconomyCheckpointRef.current = now;
        setEconomy((previous) => resetForNewSeason(previous, wallClockSeason));
        setGame((previous) =>
          previous.demo ? createGameState(`season-${wallClockSeason}`) : previous,
        );
        setNotice('A new weekly guest season has begun. The previous season was archived.');
      } else if (wallClockSeason === economy.seasonId && game.demo) {
        const previousCheckpoint = lastEconomyCheckpointRef.current ?? now;
        lastEconomyCheckpointRef.current = now;
        setEconomy((previous) =>
          previous.seasonId === wallClockSeason
            ? applyOfflineProgress(previous, previousCheckpoint, now).state
            : previous,
        );
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [economy.seasonId, game.demo, loaded]);

  const totalHealthy = useMemo(() => healthyCount(game.island.cells, game.unlockedThrough), [game]);
  const healthyForests = useMemo(
    () =>
      game.island.cells.reduce(
        (count, cell, index) =>
          count + (cell.habitat === 'forest' && healthyAt(game.island.cells, index) ? 1 : 0),
        0,
      ),
    [game.island.cells],
  );
  const residentRoster = useMemo(
    () => visibleResidents(totalHealthy, healthyForests),
    [totalHealthy, healthyForests],
  );
  const residents = residentRoster.map((resident) => ({
    ...resident,
    ...residentPositions[resident.id],
  }));
  const heartReady = isHeartComplete(game.island.cells, game.unlockedThrough);
  const worldPoints = Number(worldTree.data ?? 0);
  const treeStage = Math.min(4, Math.floor(worldPoints / 25));
  const treeStageNames = ['Seedling', 'Sapling', 'Canopy', 'Grove', 'Old-growth'];

  useEffect(() => {
    try {
      localStorage.setItem('worldseed:sound', soundEnabled ? 'on' : 'off');
    } catch {
      // Sound preference is optional and never affects the game state.
    }
  }, [soundEnabled]);

  useEffect(() => {
    residentPositionsRef.current = residentPositions;
  }, [residentPositions]);

  useEffect(() => {
    residentFacingRef.current = residentFacing;
  }, [residentFacing]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const currentPositions = residentPositionsRef.current;
      const next = { ...currentPositions };
      const movedIds: string[] = [];
      const nextFacing = { ...residentFacingRef.current };
      const ids = new Set(residentRoster.map(({ id }) => id));
      for (const resident of residentRoster) {
        const current = { ...resident, ...currentPositions[resident.id] };
        const moved = stepResident(current, game.island.cells, game.unlockedThrough);
        if (moved.x !== current.x || moved.y !== current.y) {
          next[resident.id] = { x: moved.x, y: moved.y };
          movedIds.push(resident.id);
          if (moved.x !== current.x) nextFacing[resident.id] = moved.x < current.x ? -1 : 1;
        }
      }
      for (const id of Object.keys(next)) {
        if (!ids.has(id)) {
          delete next[id];
          delete nextFacing[id];
        }
      }
      const removedResidents = Object.keys(next).length !== Object.keys(currentPositions).length;
      if (removedResidents || movedIds.length) {
        residentPositionsRef.current = next;
        setResidentPositions(next);
      }
      if (removedResidents || movedIds.length) {
        residentFacingRef.current = nextFacing;
        setResidentFacing(nextFacing);
      }
      if (movedIds.length) {
        setWalkingResidents(movedIds);
        if (walkingTimeoutRef.current !== null) window.clearTimeout(walkingTimeoutRef.current);
        walkingTimeoutRef.current = window.setTimeout(() => {
          setWalkingResidents([]);
          walkingTimeoutRef.current = null;
        }, 1800);
      }
    }, 2100);
    return () => {
      window.clearInterval(timer);
      if (walkingTimeoutRef.current !== null) window.clearTimeout(walkingTimeoutRef.current);
    };
  }, [game.island.cells, game.unlockedThrough, residentRoster]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showMerchant) setShowMerchant(false);
      else if (showWorldTree) setShowWorldTree(false);
      else if (showIslandDetails) setShowIslandDetails(false);
      else if (showSettings) setShowSettings(false);
      else if (showTutorial) setShowTutorial(false);
      else if (sceneEvent) setSceneEvent(null);
      else if (tool !== 'place') {
        setTool('place');
        setNotice('Restoration tool selected.');
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [
    showMerchant,
    showWorldTree,
    showIslandDetails,
    showSettings,
    showTutorial,
    sceneEvent,
    tool,
  ]);

  useEffect(() => {
    const state = chainState.data;
    if (!state || !state[0] || !account.address) return;
    const restored = createGameState(String(state[4]), false);
    restored.island.cells = restored.island.cells.map((cell, index) => ({
      ...cell,
      habitat:
        state[5][index] === 0
          ? null
          : (['', 'water', 'grass', 'forest'][state[5][index]!] as Habitat),
    }));
    restored.inventory = { water: state[6][0]!, grass: state[6][1]!, forest: state[6][2]! };
    restored.unlockedThrough = state[2];
    restored.claimedRegions = REGIONS.filter((_, index) => state[7][index]).map(
      (region) => region.id,
    );
    restored.actionCount = Number(state[3]);
    restored.complete = state[1];
    let queued: number[] = [];
    try {
      const saved = JSON.parse(localStorage.getItem(walletSaveKey(account.address)) ?? 'null') as {
        seed?: string;
        cursor?: string;
        actions?: unknown;
      } | null;
      if (
        saved?.seed === restored.island.seed &&
        saved.cursor === String(state[3]) &&
        Array.isArray(saved.actions)
      ) {
        for (const code of saved.actions) {
          if (!Number.isInteger(code) || code < 0 || code > 195) break;
          const habitat = code % 4;
          const action =
            habitat === 0
              ? { type: 'remove' as const, index: Math.floor(code / 4) }
              : {
                  type: 'place' as const,
                  index: Math.floor(code / 4),
                  habitat: ['', 'water', 'grass', 'forest'][habitat] as Habitat,
                };
          const next = applyAction(restored, action);
          if (next.error) break;
          Object.assign(restored, next.state);
          queued.push(code);
        }
      }
    } catch {
      // Confirmed contract state remains the recovery source if local data is malformed.
    }
    const timer = window.setTimeout(() => {
      setGame(restored);
      setChainCursor(state[3]);
      setPendingActions(queued);
      setNotice(
        queued.length
          ? `Restored ${queued.length} unsaved local actions.`
          : 'Your confirmed Hemi Sepolia island has been restored from the contract.',
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [chainState.data, account.address]);

  useEffect(() => {
    if (game.demo || !account.address) return;
    try {
      localStorage.setItem(
        walletSaveKey(account.address),
        JSON.stringify({
          seed: game.island.seed,
          cursor: String(chainCursor),
          actions: pendingActions,
        }),
      );
    } catch {
      console.warn('Could not persist the pending wallet action queue.');
    }
  }, [game, pendingActions, chainCursor, account.address]);

  useEffect(() => {
    if (game.demo || pendingActions.length === 0) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [game.demo, pendingActions.length]);

  function applyEconomyResult(result: ActionResult) {
    const wallClockSeason = seasonIdAt(Date.now());
    if (wallClockSeason !== economy.seasonId) {
      if (wallClockSeason > economy.seasonId) {
        setEconomy((previous) => resetForNewSeason(previous, wallClockSeason));
        setGame((previous) =>
          previous.demo ? createGameState(`season-${wallClockSeason}`) : previous,
        );
        setNotice('The season ended before that action. Your new guest season has started.');
      } else {
        setNotice(
          'Your device clock is earlier than the active guest season; this action was not applied.',
        );
      }
      return;
    }
    if (result.error) {
      setNotice(result.error);
      return;
    }
    setEconomy(result.state);
    setNotice(result.events.map((event) => event.message).join(' ') || 'Island economy updated.');
  }

  function beginWithLegacyIsland(keepIsland: boolean) {
    const oldIsland = legacyRestoration;
    const restoration =
      keepIsland && oldIsland ? oldIsland : createGameState(`guest-${Date.now()}`);
    setGame(restoration);
    guestRestorationRef.current = restoration;
    setLegacyRestoration(oldIsland);
    setEconomy(createEconomyState(seasonIdAt(Date.now())));
    setSaveDecision(null);
    setLocalSaveReady(true);
    setNotice(
      keepIsland
        ? 'Older island kept as an optional restoration puzzle.'
        : 'Older island kept safely; a fresh island is ready.',
    );
  }

  async function beginAfterIncompatibleSave() {
    try {
      await archiveIncompatibleSave();
      setEconomy(createEconomyState(seasonIdAt(Date.now())));
      const restoration = createGameState(`guest-${Date.now()}`);
      setGame(restoration);
      guestRestorationRef.current = restoration;
      setSaveDecision(null);
      setLocalSaveReady(true);
    } catch {
      setNotice('Could not back up the older save, so it was left untouched.');
    }
  }

  function act(index: number) {
    const target = game.island.cells[index];
    if (tool === 'inspect') {
      const name = REGIONS.find((region) => region.id === target?.region)?.name ?? 'Island';
      setNotice(
        `${name} · ${target?.terrain === 'heart' ? 'Island Heart landmark' : target?.habitat ? `${target.habitat}${healthyAt(game.island.cells, index) ? ' · thriving' : ' · needs a neighbor'}` : target?.terrain === 'rock' ? 'Ancient stone' : 'Open ground'}.`,
      );
      return;
    }
    const result = applyAction(
      game,
      tool === 'place' ? { type: 'place', index, habitat: selected } : { type: 'remove', index },
    );
    if (result.error) {
      setNotice(result.error);
      return;
    }
    setGame(result.state);
    const reactionIds = residentsNearCell(residents, index).map(({ id }) => id);
    setReactingResidents(reactionIds);
    if (reactionTimeoutRef.current !== null) window.clearTimeout(reactionTimeoutRef.current);
    reactionTimeoutRef.current = window.setTimeout(() => {
      setReactingResidents([]);
      reactionTimeoutRef.current = null;
    }, 900);
    if (tool === 'place') {
      setFreshTile(index);
      if (freshTileTimeoutRef.current !== null) window.clearTimeout(freshTileTimeoutRef.current);
      freshTileTimeoutRef.current = window.setTimeout(() => {
        setFreshTile(null);
        freshTileTimeoutRef.current = null;
      }, 800);
    }
    const completed = result.events.some((event) => event.kind === 'island-complete');
    const unlocked = result.events.some((event) => event.kind === 'region-unlocked');
    if (completed || unlocked) {
      setSceneEvent(completed ? 'complete' : 'unlock');
      if (sceneEventTimeoutRef.current !== null) window.clearTimeout(sceneEventTimeoutRef.current);
      sceneEventTimeoutRef.current = window.setTimeout(() => {
        setSceneEvent(null);
        sceneEventTimeoutRef.current = null;
      }, 1800);
    }
    if (soundEnabled) {
      playIslandSound(
        completed ? 'complete' : unlocked ? 'unlock' : selected === 'water' ? 'water' : selected,
      );
    }
    if (!game.demo) {
      const code = actionHabitatCode(tool, selected, game.island.cells[index]?.habitat);
      setPendingActions((actions) => [...actions, index * 4 + code]);
    }
    setNotice(
      result.events.map((event: GameEvent) => event.message).join(' ') || 'Island updated.',
    );
  }

  function cancelTool() {
    setTool('place');
    setNotice('Restoration tool selected.');
  }

  function zoomCamera(delta: number) {
    const nextZoom = Math.max(0.84, Math.min(1.34, cameraZoom + delta));
    const boardSize = boardRef.current?.clientWidth ?? 600;
    setCameraZoom(nextZoom);
    const nextPan = {
      x: clampCameraOffset(cameraPanRef.current.x, boardSize, nextZoom),
      y: clampCameraOffset(cameraPanRef.current.y, boardSize, nextZoom),
    };
    cameraPanRef.current = nextPan;
    setCameraPan(nextPan);
  }

  function resetCamera() {
    cameraPanRef.current = { x: 0, y: 0 };
    setCameraPan({ x: 0, y: 0 });
    setCameraZoom(1);
  }

  function handleCameraDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      tool === 'place' ||
      event.button !== 0 ||
      (event.target instanceof window.HTMLElement && event.target.closest('.camera-controls'))
    )
      return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: cameraPanRef.current.x,
      panY: cameraPanRef.current.y,
      moved: false,
    };
  }

  function handleCameraMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 5) {
      drag.moved = true;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Camera movement still works within the scene on browsers without pointer capture.
      }
    }
    if (!drag.moved) return;
    const boardSize = boardRef.current?.clientWidth ?? 600;
    const nextPan = {
      x: clampCameraOffset(drag.panX + dx, boardSize, cameraZoom),
      y: clampCameraOffset(drag.panY + dy, boardSize, cameraZoom),
    };
    cameraPanRef.current = nextPan;
    if (boardRef.current) {
      boardRef.current.style.transform = `translate(${nextPan.x}px, ${nextPan.y}px) scale(${cameraZoom})`;
    }
    if (residentLayerRef.current) {
      residentLayerRef.current.style.transform = `translate(${nextPan.x}px, ${nextPan.y}px) scale(${cameraZoom})`;
    }
  }

  function handleCameraUp() {
    if (dragRef.current?.moved) {
      setCameraPan(cameraPanRef.current);
      suppressTileClickRef.current = true;
      window.setTimeout(() => (suppressTileClickRef.current = false), 0);
    }
    dragRef.current = null;
  }

  function undo() {
    const previous = game.history.at(-1);
    if (!previous) {
      setNotice('There is nothing to undo yet.');
      return;
    }
    const changedIndex = game.island.cells.findIndex(
      (cell, index) => cell.habitat !== previous.cells[index]?.habitat,
    );
    if (changedIndex < 0) return;
    if (!game.demo && previous.unlockedThrough < game.unlockedThrough) {
      setNotice(
        'A confirmed region milestone stays claimed. Gather a habitat to get that resource back.',
      );
      return;
    }
    const revertedHabitat = previous.cells[changedIndex]?.habitat ?? null;
    const inverse = revertedHabitat
      ? { type: 'place' as const, index: changedIndex, habitat: revertedHabitat }
      : { type: 'remove' as const, index: changedIndex };
    const result = applyAction(game, inverse);
    if (result.error) {
      setNotice(result.error);
      return;
    }
    setGame({ ...result.state, history: game.history.slice(0, -1) });
    if (!game.demo)
      setPendingActions((actions) => [...actions, changedIndex * 4 + habitatCode(revertedHabitat)]);
    setNotice(
      game.demo
        ? 'Last local action undone.'
        : 'Last action queued for an onchain undo. Save progress to confirm it.',
    );
  }

  function restartDemo() {
    setGame(createGameState(`guest-${Date.now()}`, true));
    setSelected('water');
    setTool('place');
    resetCamera();
    setSceneEvent(null);
    setShowIslandDetails(false);
    setNotice('A fresh optional restoration island is ready. Your incremental run is unchanged.');
  }

  async function startOnchainIsland() {
    if (!account.address || chainId !== TARGET_CHAIN_ID || !gameContractAddress || !publicClient)
      return;
    setTransactionState('pending');
    try {
      const seed = window.crypto.getRandomValues(new Uint32Array(1))[0]!;
      const hash = await writeContractAsync({
        address: gameContractAddress,
        abi: gameContractAbi,
        functionName: 'startIsland',
        args: [seed],
        chainId: TARGET_CHAIN_ID,
      });
      await requireSuccessfulReceipt((onReplaced) =>
        publicClient.waitForTransactionReceipt({
          hash,
          onReplaced: ({ reason }) => onReplaced(reason),
        }),
      );
      setTransactionState('confirmed');
      setPendingActions([]);
      setChainCursor(0n);
      await chainState.refetch();
      setNotice('Island started on Hemi Sepolia. Your starter Water and Grass are onchain.');
    } catch (error) {
      setTransactionState('failed');
      setNotice(transactionFailureMessage(error, 'Island start'));
    }
  }

  async function saveProgress() {
    if (!account.address || !gameContractAddress || !publicClient || pendingActions.length === 0)
      return;
    setTransactionState('pending');
    const batch = pendingActions.slice(0, 20);
    try {
      const hash = await writeContractAsync({
        address: gameContractAddress,
        abi: gameContractAbi,
        functionName: 'saveProgress',
        args: [chainCursor, batch],
        chainId: TARGET_CHAIN_ID,
      });
      await requireSuccessfulReceipt((onReplaced) =>
        publicClient.waitForTransactionReceipt({
          hash,
          onReplaced: ({ reason }) => onReplaced(reason),
        }),
      );
      setChainCursor((cursor) => cursor + BigInt(batch.length));
      setPendingActions((actions) => actions.slice(batch.length));
      setTransactionState('confirmed');
      void worldTree.refetch().catch(() => undefined);
      setNotice(`Saved ${batch.length} restoration actions on Hemi Sepolia.`);
    } catch (error) {
      setTransactionState('failed');
      setNotice(transactionFailureMessage(error, 'Save Progress'));
    }
  }

  async function finishOnchainIsland() {
    if (!account.address || !gameContractAddress || !publicClient || !game.complete) return;
    if (pendingActions.length > 20) {
      setNotice('Save the pending actions in batches of 20 or fewer before finishing.');
      return;
    }
    setTransactionState('pending');
    try {
      const snapshot = keccak256(
        toBytes(
          JSON.stringify({
            seed: game.island.seed,
            cells: game.island.cells,
            inventory: game.inventory,
          }),
        ),
      );
      const hash = await writeContractAsync({
        address: gameContractAddress,
        abi: gameContractAbi,
        functionName: 'finishIsland',
        args: [chainCursor, pendingActions, snapshot],
        chainId: TARGET_CHAIN_ID,
      });
      await requireSuccessfulReceipt((onReplaced) =>
        publicClient.waitForTransactionReceipt({
          hash,
          onReplaced: ({ reason }) => onReplaced(reason),
        }),
      );
      setChainCursor((cursor) => cursor + BigInt(pendingActions.length));
      setPendingActions([]);
      setTransactionState('confirmed');
      void worldTree.refetch().catch(() => undefined);
      setNotice(
        'Island completion confirmed. Your restoration added 2 points to this week’s World Tree.',
      );
    } catch (error) {
      setTransactionState('failed');
      setNotice(transactionFailureMessage(error, 'Island completion'));
    }
  }

  async function buyHabitat() {
    if (
      game.demo ||
      !account.address ||
      chainId !== TARGET_CHAIN_ID ||
      !gameContractAddress ||
      !publicClient ||
      pendingActions.length > 0 ||
      transactionState === 'pending'
    )
      return;
    const habitCode: Record<Habitat, number> = { water: 1, grass: 2, forest: 3 };
    const price: Record<Habitat, number> = { water: 2_000, grass: 1_000, forest: 3_000 };
    if (BigInt(price[shopHabitat]) > (goldBalance.data ?? 0n)) {
      setNotice('There is not enough committed Gold for that habitat yet.');
      return;
    }
    setTransactionState('pending');
    try {
      const hash = await writeContractAsync({
        address: gameContractAddress,
        abi: gameContractAbi,
        functionName: 'buyHabitat',
        args: [habitCode[shopHabitat], 1],
        chainId: TARGET_CHAIN_ID,
      });
      await requireSuccessfulReceipt((onReplaced) =>
        publicClient.waitForTransactionReceipt({
          hash,
          onReplaced: ({ reason }) => onReplaced(reason),
        }),
      );
      await Promise.all([goldBalance.refetch(), chainState.refetch()]);
      setTransactionState('confirmed');
      setNotice(
        `${shopHabitat} added to your pouch for ${price[shopHabitat].toLocaleString()} Gold.`,
      );
    } catch (error) {
      setTransactionState('failed');
      setNotice(transactionFailureMessage(error, 'Habitat purchase'));
    }
  }

  async function handleWallet() {
    try {
      if (account.isConnected) {
        if (chainId !== TARGET_CHAIN_ID) {
          await switchChainAsync({ chainId: TARGET_CHAIN_ID });
          setNotice(`Wallet switched to ${TARGET_CHAIN_NAME}. The demo island remains local.`);
        } else {
          disconnect();
          setNotice('Wallet disconnected. Your guest island remains saved in this browser.');
        }
      } else if (connectors[0]) {
        await connectAsync({ connector: connectors[0] });
        setNotice(
          'Wallet connected on Hemi Sepolia. Guest demo actions do not create onchain rewards.',
        );
      } else {
        setNotice(
          'No browser wallet was found. Install a wallet extension to connect on Hemi Sepolia.',
        );
      }
    } catch (error) {
      setNotice(transactionFailureMessage(error, 'Wallet request'));
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Worldseed home">
          <span className="brand-seed" aria-hidden="true">
            ✦
          </span>
          <span>worldseed</span>
        </a>
        <div className="topbar-right">
          <button
            className="tutorial-button"
            type="button"
            aria-label="How to play"
            onClick={() => setShowTutorial(true)}
          >
            Help
          </button>
          <button
            className="settings-button"
            type="button"
            onClick={() => setShowSettings(true)}
            aria-label="Open game settings"
          >
            ⚙
          </button>
          <button
            className="sound-button"
            type="button"
            aria-label={soundEnabled ? 'Mute island sounds' : 'Enable island sounds'}
            aria-pressed={soundEnabled}
            onClick={() => setSoundEnabled((enabled) => !enabled)}
          >
            {soundEnabled ? '♫' : '♩'}
          </button>
          <div className="week-chip">
            <span className="week-dot" /> {game.demo ? 'DEMO ISLAND' : 'HEMI SEPOLIA'}
          </div>
          <button
            className="wallet-button"
            type="button"
            onClick={handleWallet}
            disabled={connecting || switching}
          >
            {connecting
              ? 'Connecting…'
              : switching
                ? 'Switching…'
                : account.isConnected
                  ? chainId === TARGET_CHAIN_ID
                    ? `${account.address?.slice(0, 6)}…${account.address?.slice(-4)}`
                    : 'Switch to Hemi Sepolia'
                  : 'Connect wallet'}{' '}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </header>

      <main id="top" className="main-layout">
        {game.demo && (
          <section className="incremental-hud" aria-label="Seasonal guest economy">
            <div className="incremental-stat incremental-stat--nature">
              <span>Nature</span>
              <strong>{formatValue(economy.nature)}</strong>
            </div>
            <div className="incremental-stat">
              <span>Nature per second</span>
              <strong>
                {formatValue(productionPerSecond(economy))}
                <small> / sec</small>
              </strong>
            </div>
            <div className="incremental-stat">
              <span>This run</span>
              <strong>
                {formatValue(economy.runNature)}
                <small> Nature</small>
              </strong>
            </div>
            <div className="incremental-stat">
              <span>Season rebirths</span>
              <strong>{economy.seasonRebirths}</strong>
            </div>
            <span className="economy-guest-label">Guest · simulated points</span>
          </section>
        )}
        <section className="game-hud" aria-label="Quick island controls and status">
          <div className="habitat-toolbar" role="group" aria-label="Choose a habitat">
            {HABITATS.map((habitat) => (
              <button
                key={habitat.id}
                className={`quick-habitat quick-habitat--${habitat.tone} ${selected === habitat.id && tool === 'place' ? 'quick-habitat--selected' : ''}`}
                type="button"
                aria-pressed={selected === habitat.id && tool === 'place'}
                aria-label={`Select ${habitat.label}, ${game.inventory[habitat.id]} available`}
                onClick={() => {
                  setTool('place');
                  setSelected(habitat.id);
                }}
              >
                <span aria-hidden="true">{habitat.mark}</span>
                <b>{habitat.label}</b>
                <small>{game.inventory[habitat.id]}</small>
              </button>
            ))}
          </div>
          <div className="compact-progress" aria-label={`${totalHealthy} of 12 habitats restored`}>
            <div>
              <span>Island health</span>
              <strong>
                {totalHealthy}
                <small> / 12</small>
              </strong>
            </div>
            <div className="compact-progress-track" aria-hidden="true">
              <i style={{ width: `${Math.min(100, (totalHealthy / 12) * 100)}%` }} />
            </div>
          </div>
          <div className="compact-chain-status" aria-live="polite">
            <span className={`status-pip status-pip--${transactionState}`} />
            <span>
              {game.demo
                ? saveState === 'saved'
                  ? 'Guest saved'
                  : saveState === 'saving'
                    ? 'Saving…'
                    : 'Local save unavailable'
                : transactionState === 'pending'
                  ? 'Transaction pending'
                  : transactionState === 'failed'
                    ? 'Transaction failed'
                    : pendingActions.length
                      ? `${pendingActions.length} unsaved`
                      : 'Progress synced'}
            </span>
            {!game.demo && gameContractAddress && account.isConnected && (
              <strong className="compact-gold">
                {Number(goldBalance.data ?? 0n).toLocaleString()} G
              </strong>
            )}
          </div>
          <button
            className="details-toggle"
            type="button"
            onClick={() => setShowIslandDetails((show) => !show)}
            aria-expanded={showIslandDetails}
          >
            Regions & details <span aria-hidden="true">⌄</span>
          </button>
        </section>

        <section className="game-layout" aria-label="Island restoration game">
          <aside
            className="game-journal game-journal--economy"
            aria-label="Growth and restoration journal"
          >
            {game.demo ? (
              <EconomyPanel
                state={economy}
                nextSeasonStart={nextSeasonStart}
                onHeartClick={() => applyEconomyResult(clickIslandHeart(economy))}
                onStateChange={applyEconomyResult}
                onRebirth={() => applyEconomyResult(performRebirth(economy))}
              />
            ) : (
              <p className="economy-wallet-notice">
                The incremental economy is guest-only in this prototype. Your connected island and
                contract rules are unchanged.
              </p>
            )}
            <details className="restoration-journal">
              <summary>Optional restoration puzzle · {totalHealthy} healthy tiles</summary>
              <p>
                {game.complete
                  ? 'The Island Heart is whole.'
                  : `Restore tiles to uncover ${REGIONS[game.unlockedThrough + 1]?.name ?? 'the final reach'}. This is optional and does not block rebirth.`}
              </p>
              <button
                type="button"
                className="journal-open-button"
                onClick={() => setShowIslandDetails(true)}
              >
                Open restoration journal <span aria-hidden="true">→</span>
              </button>
            </details>
          </aside>

          <div className="board-column">
            {game.demo &&
              account.isConnected &&
              gameContractAddress &&
              chainId === TARGET_CHAIN_ID && (
                <div className="chain-action-card">
                  <div>
                    <strong>Ready to make it yours?</strong>
                    <small>
                      Start a permanent island on Hemi Sepolia. Guest progress stays separate.
                    </small>
                  </div>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() =>
                      chainState.data?.[0] ? chainState.refetch() : startOnchainIsland()
                    }
                    disabled={transactionState === 'pending' || chainState.isLoading}
                  >
                    {transactionState === 'pending'
                      ? 'Waiting for wallet…'
                      : chainState.data?.[0]
                        ? 'Open my island'
                        : 'Start island'}{' '}
                    <span>→</span>
                  </button>
                </div>
              )}
            {game.demo && account.isConnected && !gameContractAddress && (
              <div className="chain-action-card">
                <div>
                  <strong>Contract address not configured</strong>
                  <small>
                    Set VITE_WORLDSEED_CONTRACT_ADDRESS after deploying the Hemi Sepolia contract.
                  </small>
                </div>
              </div>
            )}
            <div className="board-heading">
              <div>
                <div className="island-kicker">
                  ISLAND 001 <span>·</span> GENERATOR V1
                </div>
                <h2>
                  Shattered Isles{' '}
                  <span className="seed-tag">{game.demo ? 'GUEST' : 'ONCHAIN'}</span>
                </h2>
              </div>
              <div className={`save-indicator save-indicator--${saveState}`} aria-live="polite">
                <span className="save-dot" />
                {!game.demo
                  ? pendingActions.length > 0
                    ? `${pendingActions.length} unsaved`
                    : `Synced · ${chainCursor}`
                  : saveState === 'saved'
                    ? 'Saved locally'
                    : saveState === 'saving'
                      ? 'Saving…'
                      : 'Save unavailable'}
              </div>
            </div>

            <div className="island-frame">
              <div className="board-decoration board-decoration--top" aria-hidden="true">
                <span>✧</span>
                <i />
                <b>RESTORATION IN PROGRESS</b>
                <i />
                <span>✧</span>
              </div>
              <div className="board-wrap">
                <div
                  className={`board-viewport ${cameraZoom > 1 ? 'board-viewport--zoomed' : ''} ${game.complete ? 'board-viewport--complete' : ''}`}
                  onPointerDown={handleCameraDown}
                  onPointerMove={handleCameraMove}
                  onPointerUp={handleCameraUp}
                  onPointerCancel={handleCameraUp}
                  onWheel={(event) => {
                    event.preventDefault();
                    zoomCamera(event.deltaY < 0 ? 0.06 : -0.06);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    cancelTool();
                  }}
                >
                  <div
                    className={`board ${tool !== 'place' ? 'board--pannable' : ''}`}
                    ref={boardRef}
                    role="grid"
                    aria-label="Seven by seven island map"
                    style={{
                      transform: `translate(${cameraPan.x}px, ${cameraPan.y}px) scale(${cameraZoom})`,
                    }}
                  >
                    <IslandTerrain
                      cells={game.island.cells}
                      seed={game.island.seed}
                      unlockedThrough={game.unlockedThrough}
                      complete={game.complete}
                    />
                    {game.island.cells.map((cell, index) => {
                      const locked =
                        REGIONS.findIndex((region) => region.id === cell.region) >
                        game.unlockedThrough;
                      const healthy = healthyAt(game.island.cells, index);
                      const habitat = HABITATS.find((candidate) => candidate.id === cell.habitat);
                      const regionName =
                        REGIONS.find((region) => region.id === cell.region)?.name ?? 'Island';
                      const terrainMark =
                        cell.terrain === 'heart'
                          ? '✧'
                          : cell.terrain === 'rock'
                            ? '◆'
                            : cell.terrain === 'shore'
                              ? '·'
                              : '';
                      const preview =
                        hoverIndex === index && tool === 'place' && !locked
                          ? applyAction(game, { type: 'place', index, habitat: selected })
                          : null;
                      const previewCopy = preview
                        ? preview.error
                          ? ` · invalid preview: ${preview.error}`
                          : ` · preview ${selected}, ${healthyAt(preview.state.island.cells, index) ? 'healthy' : 'needs a neighbor'}`
                        : '';
                      return (
                        <button
                          className={`tile tile--${cell.terrain} ${cell.habitat ? `tile--has-${cell.habitat}` : ''} ${healthy ? 'tile--healthy' : ''} ${locked ? 'tile--locked' : ''} ${cell.terrain === 'heart' ? 'tile--landmark' : ''} ${preview ? (preview.error ? 'tile--preview-invalid' : 'tile--preview-valid') : ''} ${freshTile === index ? `tile--just-restored tile--just-restored-${selected}` : ''}`}
                          key={index}
                          type="button"
                          role="gridcell"
                          disabled={locked && cell.terrain !== 'heart'}
                          aria-label={`${regionName}, row ${cell.y + 1}, column ${cell.x + 1}${cell.terrain === 'heart' ? (game.demo ? ', Island Heart, click for 1 Nature' : ', Island Heart') : locked ? ', hidden by mist' : ''}${cell.habitat ? `, ${cell.habitat}${healthy ? ', healthy' : ', needs a neighbor'}` : ''}${previewCopy}`}
                          title={
                            locked
                              ? 'A little more restoration will lift the mist.'
                              : preview?.error
                                ? preview.error
                                : `${regionName}${cell.habitat ? ` · ${cell.habitat}${healthy ? ' · healthy' : ' · needs a neighbor'}` : ' · open ground'}${previewCopy}`
                          }
                          onMouseEnter={() => setHoverIndex(index)}
                          onMouseLeave={() => setHoverIndex(null)}
                          onFocus={() => setHoverIndex(index)}
                          onBlur={() => setHoverIndex(null)}
                          onClick={(event) => {
                            if (suppressTileClickRef.current) return;
                            if (cell.terrain === 'heart') {
                              if (game.demo) applyEconomyResult(clickIslandHeart(economy));
                              else
                                setNotice(
                                  'The incremental economy is available in Guest mode. Your connected island is unchanged.',
                                );
                              return;
                            }
                            const bounds = boardRef.current?.getBoundingClientRect();
                            act(
                              bounds
                                ? (logicalTileAtPoint(event.clientX, event.clientY, bounds) ??
                                    index)
                                : index,
                            );
                          }}
                        >
                          {locked ? (
                            <span className="mist-mark" aria-hidden="true">
                              ···
                            </span>
                          ) : preview && !preview.error && !cell.habitat ? (
                            <span
                              className={`habitat-mark habitat-mark--${selected} placement-ghost`}
                              aria-hidden="true"
                            >
                              {HABITATS.find((candidate) => candidate.id === selected)?.mark}
                            </span>
                          ) : habitat ? (
                            <span
                              className={`habitat-mark habitat-mark--${habitat.tone}`}
                              aria-hidden="true"
                            >
                              {habitat.mark}
                            </span>
                          ) : (
                            <span className="terrain-mark" aria-hidden="true">
                              {terrainMark}
                            </span>
                          )}
                          {cell.habitat && !healthy && !locked && (
                            <span className="health-ring" aria-hidden="true" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <div
                    className="resident-layer"
                    ref={residentLayerRef}
                    aria-hidden="true"
                    style={{
                      transform: `translate(${cameraPan.x}px, ${cameraPan.y}px) scale(${cameraZoom})`,
                    }}
                  >
                    {residents.map((resident) => (
                      <span
                        className={`resident resident--${resident.kind} ${characterPresentationClasses(resident.id, walkingResidents.includes(resident.id), residentFacing[resident.id] === -1).join(' ')} ${reactingResidents.includes(resident.id) ? 'resident--reacting' : ''}`}
                        key={resident.id}
                        title={resident.name}
                        style={{
                          left: `${((resident.x + 0.5) / 7) * 100}%`,
                          top: `${((resident.y + 0.5) / 7) * 100}%`,
                        }}
                      ></span>
                    ))}
                  </div>
                  {sceneEvent && (
                    <div className={`scene-event scene-event--${sceneEvent}`} aria-live="polite">
                      <span>{sceneEvent === 'complete' ? '✦' : '✧'}</span>
                      {sceneEvent === 'complete'
                        ? 'The Island Heart is whole!'
                        : 'A new region blooms!'}
                      <button
                        type="button"
                        onClick={() => setSceneEvent(null)}
                        aria-label="Skip celebration"
                      >
                        ×
                      </button>
                    </div>
                  )}
                  {game.complete && <div className="heart-pulse" aria-hidden="true" />}
                  <div className="camera-controls" role="group" aria-label="Island camera">
                    <button type="button" onClick={() => zoomCamera(0.1)} aria-label="Zoom in">
                      +
                    </button>
                    <span>{Math.round(cameraZoom * 100)}%</span>
                    <button type="button" onClick={() => zoomCamera(-0.1)} aria-label="Zoom out">
                      −
                    </button>
                    <button type="button" onClick={resetCamera} aria-label="Reset camera">
                      ⌂
                    </button>
                  </div>
                </div>
              </div>
              <div className="landmark-strip" aria-label="Island landmarks">
                <button
                  type="button"
                  className="landmark landmark--merchant"
                  aria-label="Open Traveling Merchant habitat supplies"
                  onClick={() => setShowMerchant(true)}
                >
                  <span aria-hidden="true">
                    <i className="landmark-character landmark-character--merchant" />
                  </span>
                  <b>Traveling Merchant</b>
                  <small>habitat supplies</small>
                </button>
                <button
                  type="button"
                  className="landmark landmark--tree"
                  aria-label="Open World Tree community progress"
                  onClick={() => setShowWorldTree(true)}
                >
                  <span aria-hidden="true">✣</span>
                  <b>World Tree</b>
                  <small>{worldPoints} weekly points</small>
                </button>
              </div>
              <div className="board-decoration board-decoration--bottom" aria-hidden="true">
                <span>✦</span>
                <b>WATER · GRASS · FOREST</b>
                <span>✦</span>
              </div>
            </div>

            <div className="board-tools">
              <div className="action-tools" role="group" aria-label="Island action">
                <button
                  className={`tool-button tool-button--place ${tool === 'place' ? 'tool-button--active' : ''}`}
                  onClick={() => setTool('place')}
                  type="button"
                >
                  <span>＋</span> Place
                </button>
                <button
                  className={`tool-button tool-button--remove ${tool === 'gather' ? 'tool-button--active' : ''}`}
                  onClick={() => setTool('gather')}
                  type="button"
                >
                  <span>⌫</span> Remove
                </button>
                <button
                  className={`tool-button tool-button--inspect ${tool === 'inspect' ? 'tool-button--active' : ''}`}
                  onClick={() => setTool('inspect')}
                  type="button"
                >
                  <span>⌕</span> Inspect
                </button>
              </div>
              <button
                className="undo-button"
                type="button"
                onClick={undo}
                disabled={game.history.length === 0}
              >
                <span>↶</span> Undo
              </button>
              {game.demo && (
                <button className="restart-button" type="button" onClick={restartDemo}>
                  New demo ↻
                </button>
              )}
            </div>
            {!game.demo && (
              <div className="chain-sync-row">
                <span>
                  {transactionState === 'pending'
                    ? 'Transaction pending…'
                    : transactionState === 'failed'
                      ? 'Transaction failed · retry available'
                      : transactionState === 'confirmed'
                        ? 'Transaction confirmed'
                        : `Cursor ${chainCursor} · ${pendingActions.length} queued`}
                </span>
                <div>
                  <button
                    className="tool-button"
                    type="button"
                    onClick={saveProgress}
                    disabled={transactionState === 'pending' || pendingActions.length === 0}
                  >
                    Save Progress{' '}
                    {pendingActions.length > 0 ? `(${Math.min(20, pendingActions.length)})` : ''}
                  </button>
                  {game.complete && (
                    <button
                      className="primary-button"
                      type="button"
                      onClick={finishOnchainIsland}
                      disabled={transactionState === 'pending'}
                    >
                      Finish island <span>→</span>
                    </button>
                  )}
                </div>
              </div>
            )}
            {notice !== 'Choose a habitat, then place it beside the right neighbors.' && (
              <p className="live-notice" role="status" aria-live="polite">
                <span className="notice-spark">✦</span>
                {notice}
              </p>
            )}
          </div>

          <aside className="game-locations" aria-label="Island locations">
            <div className="game-panel-heading">
              <span className="game-panel-kicker">LOCATIONS</span>
              <strong>Island landmarks</strong>
            </div>
            <button
              type="button"
              className="location-button location-button--merchant"
              onClick={() => setShowMerchant(true)}
            >
              <span aria-hidden="true">♟</span>
              <span>
                <b>Traveling Merchant</b>
                <small>Habitat supplies</small>
              </span>
            </button>
            <button
              type="button"
              className="location-button location-button--tree"
              onClick={() => setShowWorldTree(true)}
            >
              <span aria-hidden="true">✣</span>
              <span>
                <b>World Tree</b>
                <small>{worldPoints} weekly points</small>
              </span>
            </button>
          </aside>

          {showIslandDetails && (
            <div
              className="details-overlay"
              role="dialog"
              aria-modal="true"
              aria-labelledby="island-details-title"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setShowIslandDetails(false);
              }}
            >
              <div className="details-panel">
                <div className="details-panel-heading">
                  <h2 id="island-details-title">Island details</h2>
                  <button
                    className="modal-close"
                    type="button"
                    onClick={() => setShowIslandDetails(false)}
                    aria-label="Close island details"
                  >
                    ×
                  </button>
                </div>
                <aside className="side-panel" aria-label="Restoration status">
                  <section className="panel-card inventory-card">
                    <div className="card-heading">
                      <div>
                        <div className="card-kicker">YOUR POUCH</div>
                        <h3>Available habitats</h3>
                      </div>
                      <span className="pouch-icon">◒</span>
                    </div>
                    <div className="inventory-list">
                      {HABITATS.map((habitat) => (
                        <button
                          key={habitat.id}
                          type="button"
                          className={`inventory-item ${selected === habitat.id && tool === 'place' ? 'inventory-item--selected' : ''}`}
                          onClick={() => {
                            setTool('place');
                            setSelected(habitat.id);
                          }}
                          aria-pressed={selected === habitat.id && tool === 'place'}
                        >
                          <span className={`inventory-symbol inventory-symbol--${habitat.tone}`}>
                            {habitat.mark}
                          </span>
                          <span className="inventory-name">{habitat.label}</span>
                          <span className="inventory-count">{game.inventory[habitat.id]}</span>
                        </button>
                      ))}
                    </div>
                    <div className="inventory-hint">
                      Select a habitat, then choose a clear tile.
                    </div>
                  </section>

                  {!game.demo && account.isConnected && gameContractAddress && (
                    <section className="panel-card shop-card" aria-label="Grove keeper shop">
                      <div className="card-heading">
                        <div>
                          <div className="card-kicker">GROVE KEEPER</div>
                          <h3>Habitat supplies</h3>
                        </div>
                        <strong className="shop-gold">
                          {Number(goldBalance.data ?? 0n).toLocaleString()} G
                        </strong>
                      </div>
                      <label className="shop-choice">
                        <span>Choose a habitat</span>
                        <select
                          value={shopHabitat}
                          onChange={(event) => setShopHabitat(event.target.value as Habitat)}
                        >
                          <option value="water">Water · 2,000 Gold</option>
                          <option value="grass">Grass · 1,000 Gold</option>
                          <option value="forest">Forest · 3,000 Gold</option>
                        </select>
                      </label>
                      <button
                        className="secondary-button shop-buy-button"
                        type="button"
                        onClick={() => void buyHabitat()}
                        disabled={
                          chainId !== TARGET_CHAIN_ID ||
                          pendingActions.length > 0 ||
                          transactionState === 'pending'
                        }
                      >
                        {pendingActions.length > 0
                          ? 'Save island progress first'
                          : 'Buy one habitat'}
                      </button>
                      <small className="shop-note">
                        Purchases atomically spend verified Gold and add onchain inventory. Prices
                        are provisional.
                      </small>
                    </section>
                  )}

                  <section className="panel-card progress-card">
                    <div className="card-heading">
                      <div>
                        <div className="card-kicker">ISLAND RESTORATION</div>
                        <h3>Healthy habitats</h3>
                      </div>
                      <span className="count-badge">
                        {totalHealthy}
                        <small> / 12</small>
                      </span>
                    </div>
                    <div
                      className="progress-track"
                      aria-label={`${totalHealthy} of 12 healthy habitats`}
                    >
                      <span style={{ width: `${Math.min(100, (totalHealthy / 12) * 100)}%` }} />
                    </div>
                    <div className="forest-counter">
                      <span className="forest-icon">♧</span> Healthy forests{' '}
                      <strong>
                        {
                          game.island.cells.filter(
                            (cell, index) =>
                              cell.habitat === 'forest' && healthyAt(game.island.cells, index),
                          ).length
                        }
                        <small> / 3</small>
                      </strong>
                    </div>
                    <div className="region-list">
                      {REGIONS.map((region, index) => {
                        const unlocked = index <= game.unlockedThrough;
                        const done = game.claimedRegions.includes(region.id) && index < 4;
                        return (
                          <div
                            key={region.id}
                            className={`region-row ${unlocked ? 'region-row--unlocked' : ''} ${done ? 'region-row--done' : ''}`}
                          >
                            <span className="region-check">
                              {done ? '✓' : unlocked ? '·' : '○'}
                            </span>
                            <span className="region-copy">
                              <strong>{region.name}</strong>
                              <small>
                                {unlocked
                                  ? REGION_COPY[region.id]
                                  : `${region.unlockAt} healthy habitats to uncover`}
                              </small>
                            </span>
                            <span className="region-status">
                              {done ? 'RESTORED' : unlocked ? 'OPEN' : 'MIST'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  <section className={`heart-card ${heartReady ? 'heart-card--ready' : ''}`}>
                    <div className="heart-orbit" aria-hidden="true">
                      <span>✦</span>
                    </div>
                    <div className="heart-copy">
                      <div className="card-kicker">THE FINAL REACH</div>
                      <h3>{game.complete ? 'Island restored' : 'Island Heart'}</h3>
                      <p>
                        {game.complete
                          ? 'Your care brought this island back to life.'
                          : 'Connect healthy life to the Heart to finish your restoration.'}
                      </p>
                    </div>
                    <div className="heart-status">
                      {game.complete ? 'COMPLETE' : heartReady ? 'READY' : 'IN PROGRESS'}
                    </div>
                  </section>

                  <button
                    className="world-tree-card"
                    type="button"
                    onClick={() => setShowWorldTree(true)}
                    aria-label="Open weekly World Tree contribution details"
                  >
                    <div className="tree-art" aria-hidden="true">
                      <span className={`tree-crown tree-crown--stage-${treeStage}`}>✣</span>
                      <span className="tree-trunk">│</span>
                      <span className="tree-roots">⌁</span>
                    </div>
                    <div className="tree-info">
                      <div className="card-kicker">
                        THE WORLD TREE{' '}
                        <span className="tree-live">
                          <i /> {gameContractAddress ? 'WEEKLY' : 'DEMO'}
                        </span>
                      </div>
                      <strong>A little growth, together.</strong>
                      <div className="tree-progress">
                        <span
                          style={{
                            width: `${Math.min(100, worldPoints)}%`,
                          }}
                        />
                      </div>
                      <small>
                        {gameContractAddress
                          ? `${treeStageNames[treeStage]} · ${worldPoints} / 100 confirmed points this week`
                          : 'Preview only · no contract configured'}
                      </small>
                    </div>
                  </button>
                </aside>
              </div>
            </div>
          )}
        </section>

        <footer className="page-footer">
          <span>
            WORLDSEED <b>·</b> SHATTERED ISLES
          </span>
          <span>GUEST DEMO · NO WALLET REQUIRED</span>
          <button
            type="button"
            onClick={() =>
              setNotice(
                'Guest progress is stored in this browser only. It can never be converted into wallet rewards.',
              )
            }
          >
            About demo
          </button>
        </footer>
      </main>

      {showMerchant && (
        <div
          className="modal-backdrop landmark-backdrop"
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && setShowMerchant(false)}
        >
          <section
            className="landmark-modal merchant-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="merchant-title"
          >
            <button
              className="modal-close"
              type="button"
              onClick={() => setShowMerchant(false)}
              aria-label="Close merchant"
            >
              ×
            </button>
            <div className="landmark-modal-icon landmark-modal-icon--merchant" aria-hidden="true">
              <i className="landmark-character landmark-character--merchant" />
            </div>
            <div className="card-kicker">A FRIEND ON THE ROAD</div>
            <h2 id="merchant-title">The Traveling Merchant</h2>
            <p>Trade verified Gold for habitat supplies to help your onchain island grow.</p>
            {!game.demo && account.isConnected && gameContractAddress ? (
              <>
                <div className="merchant-balance">
                  Your pouch · {Number(goldBalance.data ?? 0n).toLocaleString()} Gold
                </div>
                <label className="shop-choice">
                  <span>Choose a habitat</span>
                  <select
                    value={shopHabitat}
                    onChange={(event) => setShopHabitat(event.target.value as Habitat)}
                  >
                    <option value="water">Water · 2,000 Gold</option>
                    <option value="grass">Grass · 1,000 Gold</option>
                    <option value="forest">Forest · 3,000 Gold</option>
                  </select>
                </label>
                <button
                  className="primary-button merchant-buy"
                  type="button"
                  onClick={() => void buyHabitat()}
                  disabled={
                    chainId !== TARGET_CHAIN_ID ||
                    pendingActions.length > 0 ||
                    transactionState === 'pending'
                  }
                >
                  {transactionState === 'pending'
                    ? 'Waiting for confirmation…'
                    : pendingActions.length
                      ? 'Save island progress first'
                      : 'Buy one habitat'}
                </button>
                <small className="shop-note">
                  Purchases spend onchain Gold and credit your island inventory.
                </small>
              </>
            ) : (
              <div className="merchant-note">
                <strong>
                  {game.demo ? 'Guest islands are a free preview.' : 'Wallet island required.'}
                </strong>
                <span>
                  {account.isConnected
                    ? 'Close this window and open your Hemi Sepolia island from the island start prompt to use verified Gold.'
                    : 'Connect a wallet and open its Hemi Sepolia island to shop with verified Gold.'}
                </span>
                {!account.isConnected && (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void handleWallet()}
                  >
                    Connect wallet
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {showWorldTree && (
        <div
          className="modal-backdrop landmark-backdrop"
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && setShowWorldTree(false)}
        >
          <section
            className="landmark-modal tree-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tree-title"
          >
            <button
              className="modal-close"
              type="button"
              onClick={() => setShowWorldTree(false)}
              aria-label="Close World Tree"
            >
              ×
            </button>
            <div className="landmark-modal-icon landmark-modal-icon--tree" aria-hidden="true">
              ✣
            </div>
            <div className="card-kicker">GROWING TOGETHER</div>
            <h2 id="tree-title">The World Tree</h2>
            <p>Every confirmed island restoration adds a little life to the shared canopy.</p>
            <div className="tree-modal-progress">
              <span style={{ width: `${Math.min(100, worldPoints)}%` }} />
            </div>
            <strong className="tree-modal-total">
              {worldPoints} <small>/ 100 weekly points</small>
            </strong>
            <p className="tree-modal-note">
              {gameContractAddress
                ? 'Community total from confirmed Hemi Sepolia contributions.'
                : 'Preview tree · community progress appears when the Hemi Sepolia contract is configured.'}
            </p>
          </section>
        </div>
      )}

      {showSettings && (
        <div
          className="modal-backdrop game-settings-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowSettings(false);
          }}
        >
          <section
            className="game-settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <button
              className="modal-close"
              type="button"
              onClick={() => setShowSettings(false)}
              aria-label="Close settings"
            >
              ×
            </button>
            <div className="card-kicker">YOUR ISLAND, YOUR PACE</div>
            <h2 id="settings-title">Game settings</h2>
            <button
              className="settings-row"
              type="button"
              aria-pressed={soundEnabled}
              onClick={() => setSoundEnabled((enabled) => !enabled)}
            >
              <span>Island sounds</span>
              <strong>{soundEnabled ? 'On' : 'Off'}</strong>
            </button>
            <button className="settings-row" type="button" onClick={resetCamera}>
              <span>Island camera</span>
              <strong>Reset zoom and pan</strong>
            </button>
            <button
              className="settings-row"
              type="button"
              onClick={() => {
                setShowSettings(false);
                setShowTutorial(true);
              }}
            >
              <span>Need a hand?</span>
              <strong>Open the guide</strong>
            </button>
            <p className="settings-footnote">
              {game.demo
                ? 'Guest progress saves in this browser.'
                : `Network · ${TARGET_CHAIN_NAME}`}
            </p>
          </section>
        </div>
      )}

      {saveDecision && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="save-decision-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-decision-title"
          >
            <div className="card-kicker">LOCAL SAVE</div>
            <h2 id="save-decision-title">
              {saveDecision === 'legacy' ? 'Older island save found' : 'Unrecognized save format'}
            </h2>
            <p>
              {saveDecision === 'legacy'
                ? 'Your old restoration island will stay stored. Choose whether to open it as an optional puzzle or begin with a fresh island.'
                : 'This save cannot be safely converted. It will remain untouched; back it up before beginning the new economy.'}
            </p>
            {saveDecision === 'legacy' ? (
              <div className="save-decision-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => beginWithLegacyIsland(true)}
                >
                  Keep old island
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => beginWithLegacyIsland(false)}
                >
                  Start fresh
                </button>
              </div>
            ) : (
              <button
                className="primary-button"
                type="button"
                onClick={() => void beginAfterIncompatibleSave()}
              >
                Back up old save and start
              </button>
            )}
          </section>
        </div>
      )}

      {showTutorial && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowTutorial(false);
          }}
        >
          <section
            className="tutorial-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tutorial-title"
          >
            <button
              className="modal-close"
              type="button"
              onClick={() => setShowTutorial(false)}
              aria-label="Close tutorial"
            >
              ×
            </button>
            <div className="eyebrow">
              <span className="eyebrow-line" /> YOUR FIRST FEW STEPS
            </div>
            <h2 id="tutorial-title">
              Grow a living island
              <br />
              <em>show you the way.</em>
            </h2>
            <ol className="tutorial-steps">
              <li>
                <span>01</span>
                <div>
                  <strong>Gather Nature</strong>
                  <p>
                    Click the Island Heart to collect 1 Nature. Nature is also shown in the top bar.
                  </p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>Grow habitats</strong>
                  <p>
                    Buy Water, Grass, and Forest levels to generate Nature every second. Neighbors
                    and milestones improve production; use bulk-buy buttons when you can.
                  </p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>Rebirth to grow stronger</strong>
                  <p>
                    Reach the run goal to reset your habitats for seasonal PP and simulated CP.
                    Spend PP on upgrades before your next run.
                  </p>
                </div>
              </li>
            </ol>
            <button className="primary-button" type="button" onClick={() => setShowTutorial(false)}>
              Start growing <span>→</span>
            </button>
            <p className="modal-footnote">
              The 7×7 restoration puzzle remains optional. Guest PP and CP are local simulations,
              not wallet rewards.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
