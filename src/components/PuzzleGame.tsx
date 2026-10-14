import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useAccount,
  useChainId,
  useConnect,
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
  requireSuccessfulReceipt,
  transactionFailureMessage,
  withGasSafetyMargin,
} from '../blockchain/transactions';
import {
  applyPuzzleMove,
  CASH_OUT_AFTER,
  createPuzzleRound,
  directionFromCode,
  DIRECTION_CODES,
  MAX_SAVED_MOVES,
  MAX_ROUND_MOVES,
  MODES,
  type Direction,
  type PuzzleMode,
  type PuzzleState,
} from '../puzzle/engine';

const MODE_ORDER: PuzzleMode[] = ['relaxed', 'standard', 'challenging'];
const MODE_CODE: Record<PuzzleMode, number> = { relaxed: 0, standard: 1, challenging: 2 };
const MODE_BY_CODE: PuzzleMode[] = MODE_ORDER;
const PRACTICE_KEY = 'worldseed:2048:practice:v1';

interface StoredPractice {
  state: PuzzleState;
}

interface StoredPending {
  seed: string;
  cursor: number;
  directions: number[];
}

function pendingKey(address: string) {
  return `worldseed:2048:pending:${address.toLowerCase()}:v1`;
}

function modeForCode(code: number): PuzzleMode {
  return MODE_BY_CODE[code] ?? 'standard';
}

function displayTile(exponent: number): string {
  return exponent === 0 ? '' : String(2 ** exponent);
}

function randomSeed(): number {
  return window.crypto.getRandomValues(new Uint32Array(1))[0] || 0x6d2b79f5;
}

function loadPractice(): PuzzleState | null {
  try {
    const stored = JSON.parse(
      localStorage.getItem(PRACTICE_KEY) ?? 'null',
    ) as StoredPractice | null;
    if (stored?.state?.board?.length === 16 && stored.state.mode in MODES) return stored.state;
  } catch {
    // A malformed local practice save can be safely replaced.
  }
  return null;
}

export function PuzzleGame({ onBack }: { onBack: () => void }) {
  const account = useAccount();
  const chainId = useChainId();
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID });
  const chainPuzzle = useReadContract({
    address: gameContractAddress,
    abi: gameContractAbi,
    functionName: 'puzzleState',
    args: account.address ? [account.address] : undefined,
    query: { enabled: Boolean(gameContractAddress && account.address) },
  });
  const staminaQuery = useReadContract({
    address: gameContractAddress,
    abi: gameContractAbi,
    functionName: 'staminaState',
    args: account.address ? [account.address] : undefined,
    query: { enabled: Boolean(gameContractAddress && account.address) },
  });
  const goldQuery = useReadContract({
    address: gameContractAddress,
    abi: gameContractAbi,
    functionName: 'goldBalances',
    args: account.address ? [account.address] : undefined,
    query: { enabled: Boolean(gameContractAddress && account.address) },
  });

  const [initialPractice] = useState(loadPractice);
  const [playType, setPlayType] = useState<'practice' | 'rewarded'>('practice');
  const [mode, setMode] = useState<PuzzleMode>(initialPractice?.mode ?? 'standard');
  const [game, setGame] = useState<PuzzleState | null>(initialPractice);
  const [pendingDirections, setPendingDirections] = useState<number[]>([]);
  const [confirmedMoves, setConfirmedMoves] = useState(0);
  const [txState, setTxState] = useState<'idle' | 'pending' | 'failed'>('idle');
  const [notice, setNotice] = useState(
    initialPractice
      ? 'Your practice round has been restored on this device.'
      : 'Slide tiles together to grow a seedling into a grove.',
  );
  const [scorePulse, setScorePulse] = useState(0);
  const [spawnedIndex, setSpawnedIndex] = useState<number | undefined>();
  const touchStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const walletReady = Boolean(
    account.address && chainId === TARGET_CHAIN_ID && gameContractAddress,
  );
  const hasActiveChainRound = Boolean(chainPuzzle.data?.[0]);
  const currentMode = game?.mode ?? mode;
  const stamina = Number(staminaQuery.data?.[0] ?? 5);
  const nextStaminaAt = Number(staminaQuery.data?.[1] ?? 0);
  const gold = Number(goldQuery.data ?? 0n);
  const topTile = useMemo(() => Math.max(0, ...(game?.board ?? [])), [game?.board]);

  useEffect(() => {
    if (playType !== 'practice' || !game) return;
    try {
      localStorage.setItem(PRACTICE_KEY, JSON.stringify({ state: game } satisfies StoredPractice));
    } catch {
      console.warn('Practice works, but this browser could not save the round locally.');
    }
  }, [game, playType]);

  useEffect(() => {
    if (playType !== 'rewarded' || !account.address || !chainPuzzle.data) return;
    const [active, modeCode, moves, score, seed, rngState, board] = chainPuzzle.data;
    if (!seed) {
      const timer = window.setTimeout(() => {
        setGame(null);
        setConfirmedMoves(0);
        setPendingDirections([]);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const restored: PuzzleState = {
      seed,
      rngState,
      mode: modeForCode(modeCode),
      board: board.map(Number),
      score,
      validMoves: moves,
      over: !active,
      reached2048: board.includes(11),
    };
    let queued: number[] = [];
    try {
      const saved = JSON.parse(
        localStorage.getItem(pendingKey(account.address)) ?? 'null',
      ) as StoredPending | null;
      if (
        saved?.seed === String(seed) &&
        saved.cursor === moves &&
        Array.isArray(saved.directions)
      ) {
        for (const code of saved.directions) {
          const direction = directionFromCode(code);
          if (!direction || queued.length >= MAX_SAVED_MOVES) break;
          const next = applyPuzzleMove(restored, direction);
          if (!next.valid) break;
          Object.assign(restored, next.state);
          queued.push(code);
        }
      }
    } catch {
      // The confirmed onchain board remains recoverable if local pending data is damaged.
    }
    const timer = window.setTimeout(() => {
      setGame(restored);
      setMode(restored.mode);
      setConfirmedMoves(moves);
      setPendingDirections(queued);
      setNotice(
        queued.length
          ? `Round resumed with ${queued.length} unsubmitted moves.`
          : active
            ? 'Your rewarded round is restored from Hemi Sepolia.'
            : `Round settled at ${score.toLocaleString()} points. Earned Gold is in your wallet ledger.`,
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [playType, account.address, chainPuzzle.data]);

  useEffect(() => {
    if (playType !== 'rewarded' || !account.address || !game) return;
    try {
      localStorage.setItem(
        pendingKey(account.address),
        JSON.stringify({
          seed: String(game.seed),
          cursor: confirmedMoves,
          directions: pendingDirections,
        } satisfies StoredPending),
      );
    } catch {
      console.warn('Could not save the pending 2048 move queue.');
    }
  }, [playType, account.address, game, confirmedMoves, pendingDirections]);

  function move(direction: Direction) {
    if (!game || game.over || txState === 'pending') return;
    if (playType === 'rewarded' && pendingDirections.length >= MAX_SAVED_MOVES) {
      setNotice('Save these 20 moves onchain before continuing your rewarded round.');
      return;
    }
    const result = applyPuzzleMove(game, direction);
    if (!result.valid) {
      setNotice('That slide does not change the board, so it does not use a move.');
      return;
    }
    setGame(result.state);
    setSpawnedIndex(result.spawned?.index);
    if (result.scoreIncrease) setScorePulse(result.scoreIncrease);
    setNotice(
      result.state.over
        ? result.state.validMoves >= MAX_ROUND_MOVES
          ? 'The 200 move round limit is reached. Settle this round to receive its verified reward.'
          : 'No more slides are possible. Settle the round to receive its verified reward.'
        : result.state.reached2048 && !game.reached2048
          ? '2048! Your grove has reached the great tree. Keep growing your score.'
          : result.merged
            ? `${result.merged} merge${result.merged === 1 ? '' : 's'} · +${result.scoreIncrease} points.`
            : 'A new tile sprouted.',
    );
    if (playType === 'rewarded') {
      setPendingDirections((directions) => [...directions, DIRECTION_CODES[direction]]);
    }
    window.setTimeout(() => setSpawnedIndex(undefined), 250);
    if (result.scoreIncrease) window.setTimeout(() => setScorePulse(0), 650);
  }

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof window.HTMLElement &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName))
      )
        return;
      const map: Record<string, Direction> = {
        ArrowLeft: 'left',
        a: 'left',
        A: 'left',
        ArrowRight: 'right',
        d: 'right',
        D: 'right',
        ArrowUp: 'up',
        w: 'up',
        W: 'up',
        ArrowDown: 'down',
        s: 'down',
        S: 'down',
      };
      const direction = map[event.key];
      if (direction) {
        event.preventDefault();
        move(direction);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function connectWallet() {
    try {
      if (!account.isConnected) {
        if (!connectors[0]) throw new Error('No browser wallet was found.');
        await connectAsync({ connector: connectors[0] });
      } else if (chainId !== TARGET_CHAIN_ID) {
        await switchChainAsync({ chainId: TARGET_CHAIN_ID });
      }
    } catch (error) {
      setNotice(transactionFailureMessage(error, 'Wallet connection'));
    }
  }

  async function startRewardedRound() {
    if (!walletReady || !publicClient || hasActiveChainRound) return;
    setTxState('pending');
    try {
      const args = [MODE_CODE[mode]] as const;
      const gas = withGasSafetyMargin(
        await publicClient.estimateContractGas({
          address: gameContractAddress!,
          abi: gameContractAbi,
          functionName: 'startPuzzleRound',
          args,
          account: account.address!,
        }),
      );
      const hash = await writeContractAsync({
        address: gameContractAddress!,
        abi: gameContractAbi,
        functionName: 'startPuzzleRound',
        args,
        gas,
        chainId: TARGET_CHAIN_ID,
      });
      await requireSuccessfulReceipt((onReplaced) =>
        publicClient.waitForTransactionReceipt({
          hash,
          onReplaced: ({ reason }) => onReplaced(reason),
        }),
      );
      await Promise.all([chainPuzzle.refetch(), staminaQuery.refetch()]);
      setTxState('idle');
      setNotice('Rewarded round started. Your stamina and seed are secured on Hemi Sepolia.');
    } catch (error) {
      setTxState('failed');
      setNotice(transactionFailureMessage(error, 'Rewarded round start'));
    }
  }

  async function saveRewardedMoves(cashOut: boolean) {
    if (!walletReady || !publicClient || !game || !hasActiveChainRound || txState === 'pending')
      return;
    if (pendingDirections.length === 0 && !cashOut) return;
    if (cashOut && game.validMoves < CASH_OUT_AFTER && !game.over) {
      setNotice('Voluntary cash-out unlocks after 20 valid moves.');
      return;
    }
    const batch = pendingDirections.slice(0, MAX_SAVED_MOVES);
    setTxState('pending');
    try {
      const hash = await writeContractAsync({
        address: gameContractAddress!,
        abi: gameContractAbi,
        functionName: 'savePuzzleMoves',
        args: [confirmedMoves, batch, cashOut],
        chainId: TARGET_CHAIN_ID,
      });
      await requireSuccessfulReceipt((onReplaced) =>
        publicClient.waitForTransactionReceipt({
          hash,
          onReplaced: ({ reason }) => onReplaced(reason),
        }),
      );
      setPendingDirections((directions) => directions.slice(batch.length));
      await Promise.all([chainPuzzle.refetch(), goldQuery.refetch(), staminaQuery.refetch()]);
      setTxState('idle');
      setNotice(
        cashOut
          ? 'Round settled. Verified Gold has been added to your wallet ledger.'
          : 'Move batch confirmed on Hemi Sepolia.',
      );
    } catch (error) {
      setTxState('failed');
      setNotice(transactionFailureMessage(error, 'Rewarded move save'));
    }
  }

  function beginPractice() {
    setPlayType('practice');
    const seed = randomSeed();
    setGame(createPuzzleRound(seed, mode));
    setNotice('A new practice board is ready. Practice never earns spendable Gold.');
  }

  return (
    <div className="app-shell puzzle-app">
      <header className="topbar">
        <button className="brand brand-button" type="button" onClick={onBack}>
          <span className="brand-seed" aria-hidden="true">
            ✦
          </span>
          <span>worldseed</span>
        </button>
        <div className="topbar-right">
          <span
            className={`puzzle-mode-chip ${playType === 'practice' ? 'puzzle-mode-chip--practice' : ''}`}
          >
            {playType === 'practice' ? 'PRACTICE · NO REWARDS' : 'REWARDED · HEMI SEPOLIA'}
          </span>
          <button
            className="wallet-button"
            type="button"
            onClick={connectWallet}
            disabled={connecting || switching}
          >
            {connecting
              ? 'Connecting…'
              : switching
                ? 'Switching…'
                : account.isConnected
                  ? `${account.address?.slice(0, 6)}…${account.address?.slice(-4)}`
                  : 'Connect wallet'}
          </button>
        </div>
      </header>

      <main className="puzzle-layout">
        <div className="puzzle-heading-row">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-line" /> THE GROVE GAME
            </div>
            <h1>
              Grow your <em>grove.</em>
            </h1>
            <p>Slide matching tiles together and see how far a little seed can grow.</p>
          </div>
          <button className="puzzle-back-button" type="button" onClick={onBack}>
            ← Island restoration
          </button>
        </div>

        <section className="puzzle-card" aria-label="2048 game">
          <div className="puzzle-score-row">
            <div>
              <small>SCORE</small>
              <strong>{(game?.score ?? 0).toLocaleString()}</strong>
            </div>
            <div>
              <small>BEST TILE</small>
              <strong>{displayTile(topTile) || '—'}</strong>
            </div>
            <div>
              <small>VALID MOVES</small>
              <strong>
                {game?.validMoves ?? 0}
                <i> / {MAX_ROUND_MOVES}</i>
              </strong>
            </div>
            {playType === 'rewarded' && (
              <div>
                <small>GOLD</small>
                <strong>{gold.toLocaleString()}</strong>
              </div>
            )}
          </div>
          <div className="puzzle-board-frame">
            <div
              className={`puzzle-board ${scorePulse ? 'puzzle-board--score' : ''}`}
              role="grid"
              tabIndex={0}
              aria-label="2048 four by four tile board"
              onPointerDown={(event) => {
                touchStart.current = { x: event.clientX, y: event.clientY };
              }}
              onPointerUp={(event) => {
                const start = touchStart.current;
                touchStart.current = undefined;
                if (!start) return;
                const dx = event.clientX - start.x;
                const dy = event.clientY - start.y;
                if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
                move(
                  Math.abs(dx) > Math.abs(dy)
                    ? dx > 0
                      ? 'right'
                      : 'left'
                    : dy > 0
                      ? 'down'
                      : 'up',
                );
              }}
            >
              {(game?.board ?? Array(16).fill(0)).map((tile, index) => (
                <div
                  className={`puzzle-tile puzzle-tile--${Math.min(tile, 11)} ${tile && spawnedIndex === index ? 'puzzle-tile--spawned' : ''}`}
                  role="gridcell"
                  aria-label={tile ? `${2 ** tile}` : 'empty'}
                  key={index}
                >
                  {displayTile(tile)}
                </div>
              ))}
              {game?.over && (
                <div className="puzzle-over" role="status">
                  <strong>
                    {game.validMoves >= MAX_ROUND_MOVES ? 'Round complete' : 'The grove is full'}
                  </strong>
                  <span>Final score · {game.score.toLocaleString()}</span>
                </div>
              )}
            </div>
          </div>
          <div className="puzzle-directions" aria-label="Move controls">
            <button type="button" onClick={() => move('left')} aria-label="Move left">
              ←
            </button>
            <button type="button" onClick={() => move('up')} aria-label="Move up">
              ↑
            </button>
            <button type="button" onClick={() => move('down')} aria-label="Move down">
              ↓
            </button>
            <button type="button" onClick={() => move('right')} aria-label="Move right">
              →
            </button>
            <span>Arrow keys or WASD · swipe on touch</span>
          </div>
          {scorePulse > 0 && (
            <div className="score-increase" aria-live="polite">
              +{scorePulse}
            </div>
          )}
        </section>

        <aside className="puzzle-controls">
          <section className="panel-card puzzle-round-card">
            <div className="card-kicker">ROUND TYPE</div>
            <div className="puzzle-round-tabs">
              <button
                className={playType === 'practice' ? 'active' : ''}
                type="button"
                onClick={() => setPlayType('practice')}
              >
                Practice
              </button>
              <button
                className={playType === 'rewarded' ? 'active' : ''}
                type="button"
                onClick={() => {
                  setPlayType('rewarded');
                  if (!account.isConnected || chainId !== TARGET_CHAIN_ID) void connectWallet();
                }}
              >
                Rewarded
              </button>
            </div>
            <p>
              {playType === 'practice'
                ? 'Unlimited rounds · no stamina · no spendable Gold.'
                : 'Verified rounds use stamina and settle Gold through the contract.'}
            </p>
            {playType === 'rewarded' && (
              <div className="puzzle-stamina">
                <span>STAMINA</span>
                <strong>{stamina} / 5</strong>
                <small>
                  {nextStaminaAt
                    ? `Next refill ${new Date(nextStaminaAt * 1000).toLocaleTimeString()}`
                    : 'Full · +1 every 30 minutes'}
                </small>
              </div>
            )}
          </section>

          <section className="panel-card puzzle-mode-card">
            <div className="card-kicker">CHOOSE YOUR GROVE</div>
            <div className="puzzle-difficulty-list">
              {MODE_ORDER.map((item) => (
                <button
                  className={currentMode === item ? 'selected' : ''}
                  type="button"
                  key={item}
                  disabled={playType === 'rewarded' && hasActiveChainRound}
                  onClick={() => setMode(item)}
                >
                  <span>
                    <strong>{MODES[item].label}</strong>
                    <small>
                      {100 - MODES[item].fourPercent}% 2 tiles · {MODES[item].fourPercent}% 4 tiles
                    </small>
                  </span>
                  <b>{item === 'relaxed' ? '⅜×' : item === 'standard' ? '½×' : '⅝×'}</b>
                </button>
              ))}
            </div>
            <small className="puzzle-mode-note">
              Gold multiplier applies to your verified score at settlement.
            </small>
          </section>

          {playType === 'practice' ? (
            <button className="primary-button puzzle-action" type="button" onClick={beginPractice}>
              {game ? 'Start new practice round' : 'Start practice'} <span>→</span>
            </button>
          ) : (
            <section className="panel-card puzzle-chain-card">
              {!gameContractAddress ? (
                <p>
                  Rewarded play is unavailable until a verified Hemi Sepolia contract address is
                  configured. Practice is ready now.
                </p>
              ) : !account.isConnected || chainId !== TARGET_CHAIN_ID ? (
                <p>Connect a wallet on {TARGET_CHAIN_NAME} to start a verified round.</p>
              ) : hasActiveChainRound ? (
                <>
                  <strong>Active round resumed</strong>
                  {pendingDirections.length > 0 && (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void saveRewardedMoves(false)}
                      disabled={txState === 'pending'}
                    >
                      Save {pendingDirections.length} move
                      {pendingDirections.length === 1 ? '' : 's'}
                    </button>
                  )}
                  {game?.over && (
                    <button
                      className="primary-button puzzle-action"
                      type="button"
                      onClick={() => void saveRewardedMoves(false)}
                      disabled={txState === 'pending'}
                    >
                      Settle verified score <span>→</span>
                    </button>
                  )}
                  {!game?.over && game && game.validMoves >= CASH_OUT_AFTER && (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void saveRewardedMoves(true)}
                      disabled={txState === 'pending'}
                    >
                      Cash out for Gold
                    </button>
                  )}
                  {!game?.over && pendingDirections.length >= MAX_SAVED_MOVES && (
                    <p className="puzzle-save-hint">
                      Save this 20 move checkpoint to keep playing.
                    </p>
                  )}
                </>
              ) : (
                <button
                  className="primary-button puzzle-action"
                  type="button"
                  onClick={() => void startRewardedRound()}
                  disabled={txState === 'pending' || stamina === 0}
                >
                  {txState === 'pending'
                    ? 'Waiting for confirmation…'
                    : stamina === 0
                      ? 'No stamina available'
                      : 'Start rewarded round'}{' '}
                  <span>→</span>
                </button>
              )}
              {txState === 'failed' && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setTxState('idle')}
                >
                  Dismiss transaction error
                </button>
              )}
            </section>
          )}

          <p className="puzzle-live-notice" role="status" aria-live="polite">
            {notice}
          </p>
          <p className="puzzle-rules-note">
            Reach 20 valid moves to cash out early. Natural game-over and move 200 settle
            automatically. Unsaved rewarded moves stay on this device until saved.
          </p>
        </aside>
      </main>
    </div>
  );
}
