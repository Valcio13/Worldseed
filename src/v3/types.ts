/**
 * V3 Frontend Types
 *
 * Type definitions for V3 wallet-linked gameplay.
 * These types mirror the V3 contract and verifier protocol.
 */

// V3 Contract Types

export type V3RunStatus = 'NONE' | 'ACTIVE' | 'REBORN' | 'EXPIRED' | 'ABANDONED';

export interface V3Run {
  seasonId: bigint;
  status: V3RunStatus;
  startedAt: bigint;
  lastRecordedScoreTier: number;
  rulesVersion: number;
  upgradeChoicesHash: `0x${string}`;
}

export interface V3UpgradeChoice {
  upgradeId: number; // 0: growth, 1: efficiency, 2: awakening, 3: rebirth
  quantity: number;
}

export type V3ActionType = 'NONE' | 'START_RUN' | 'RECORD_POINTS' | 'REBIRTH';

export interface V3ScoreAttestation {
  player: `0x${string}`;
  runId: bigint;
  seasonId: bigint;
  chainId: bigint;
  verifyingContract: `0x${string}`;
  scoreTier: number;
  natureCollectedAtoms: bigint;
  nonce: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
  rulesVersion: number;
  signerEpoch: number;
  upgradeChoicesHash: `0x${string}`;
  actionType: V3ActionType;
}

// Frontend State Types

export interface V3RunState {
  /** Wallet address */
  wallet: `0x${string}` | null;
  /** Current active run ID (0 if none) */
  runId: bigint;
  /** Run details from contract */
  run: V3Run | null;
  /** Current season ID */
  seasonId: bigint;
  /** Player's seasonal PP */
  seasonalPP: bigint;
  /** Player's seasonal CP */
  seasonalCP: bigint;
  /** Best successfully settled verified score tier in this season. */
  seasonalHighScoreTier: number;
  /** Current run's versioned threshold, or active version threshold when no run is open. */
  rebirthThresholdTier: number;
  /** Next score milestone at which a new CP is earned, or null at the tier ceiling. */
  nextCpMilestoneTier: number | null;
  /** Player's lifetime CP */
  lifetimeCP: bigint;
    /** Total Nature collected across verified runs, in atom units. */
    lifetimeNatureCollectedAtoms: bigint;
    /** Lifetime accumulated score from verified Rebirths. */
    totalAccumulatedRebirthScore: bigint;
    /** Current season's accumulated verified Rebirth score. */
    seasonalAccumulatedRebirthScore: bigint;
  /** Number of rebirths this season */
  seasonRebirths: number;
  /** Current upgrade levels */
  upgradeLevels: Record<V3UpgradeKind, number>;
  /** Loading state */
  loading: boolean;
  /** Error state */
  error: string | null;
  /** V3 is configured with contract address */
  isConfigured: boolean;
  /** Wallet is on correct chain */
  isCorrectChain: boolean;
  /** Can access V3 features (connected + correct chain + configured) */
  canAccessV3: boolean;
  /** Currently starting a run */
  isStarting: boolean;
}

export type V3UpgradeKind = 'growth' | 'efficiency' | 'awakening' | 'rebirth';

export interface V3UpgradeConfig {
  id: V3UpgradeKind;
  label: string;
  description: string;
  maxLevel: number;
}

export const V3_UPGRADE_CONFIG: Record<V3UpgradeKind, V3UpgradeConfig> = {
  growth: {
    id: 'growth',
    label: 'Growth',
    description: 'Increase all Nature production by 50% per level.',
    maxLevel: 100,
  },
  efficiency: {
    id: 'efficiency',
    label: 'Efficiency',
    description: 'Reduce habitat upgrade costs by 10% per level.',
    maxLevel: 100,
  },
  awakening: {
    id: 'awakening',
    label: 'Awakening',
    description: 'Start future runs with 5 Nature per level and lower their rebirth goal.',
    maxLevel: 100,
  },
  rebirth: {
    id: 'rebirth',
    label: 'Rebirth',
    description: 'Disabled in verified V3 until this upgrade has a defined benefit.',
    maxLevel: 100,
  },
};

// Command Queue Types

export type CommandStatus = 'queued' | 'pending' | 'confirmed' | 'failed' | 'uncertain';

/** Persisted command metadata for idempotent retries */
export interface V3PersistedCommand {
  /** Stable client-generated idempotency key (1-128 chars) */
  commandId: string;
  /** The exact command payload for retries */
  payload: V3GameplayCommand;
  /** Expected sequence when submitted */
  expectedSequence: number;
  /** Submission timestamp */
  submittedAt: number;
  /** Earliest time a locally queued batch may be sent. */
  notBefore?: number;
  /** Last receipt from server (if confirmed) */
  receipt?: V3CommandReceipt;
}

export interface V3Command extends V3PersistedCommand {
  /** Current status, including locally persisted commands waiting their ordered turn. */
  status: CommandStatus;
  /** When confirmed */
  confirmedAt?: number;
  /** Error details if failed */
  error?: string;
  /** Display info from receipt */
  creditedAtoms?: string;
  spentAtoms?: string;
  scoreTier?: number;
}

/** Cursor state tracking */
export interface V3CursorState {
  runId: string;
  currentSequence: number;
  expectedSequence: number;
  rulesVersion: number;
}

export interface V3CommandQueueState {
  /** Persisted commands in order */
  commands: V3Command[];
  /** Current cursor from server (authoritative) */
  cursor: V3CursorState;
  /** Session token for API calls */
  sessionToken: string | null;
  /** Whether currently submitting a command */
  isSubmitting: boolean;
  /** Recovery state if needed */
  recoveringCursor: boolean;
  /** Repeatable Heart clicks captured locally while a prior command is in flight. */
  queuedHeartClicks: number;
  /** Persisted first-click deadline so a queued batch survives refreshes. */
  heartBatchDueAt?: number | null;
  /** A definite server rejection blocks automatic replay until the player resolves it. */
  heartQueueBlocked?: boolean;
  /** Last error from recovery attempt */
  recoveryError?: string;
  // Computed properties (added by hook)
  pendingCount?: number;
  confirmedCount?: number;
  failedCount?: number;
}

// Transaction State Types

export type TransactionState = 'idle' | 'pending' | 'confirmed' | 'failed';

export interface V3Transaction {
  type: V3ActionType;
  state: TransactionState;
  hash?: `0x${string}`;
  error?: string;
  /** Associated run/command info */
  runId?: bigint;
  nonce?: bigint;
}

// Season Types

export interface V3SeasonInfo {
  id: bigint;
  startTime: bigint;
  endTime: bigint;
  totalCP: bigint;
}

// Verifier Protocol Types (for API adapter)

export interface V3CommandRequest {
  sessionToken: string;
  runId: string;
  commandId: string;
  expectedSequence: number;
  command: V3GameplayCommand;
  clientTimestampMs?: number;
}

export type V3HabitatKind =
  'water' | 'grass' | 'forest' | 'mountain' | 'crystal-cavern' | 'ancient-grove';

export type V3HabitatUpgradeMilestone = 10 | 25 | 50 | 100;

export type V3GameplayCommand =
  | { type: 'heart-click'; quantity?: number }
  | { type: 'sync' }
  | { type: 'buy-habitat'; habitat: V3HabitatKind; quantity: number }
  | {
      type: 'buy-habitat-production-upgrade';
      habitat: V3HabitatKind;
      milestone: V3HabitatUpgradeMilestone;
    }
  | { type: 'buy-temporary-upgrade'; upgrade: 'sunny-season' | 'deep-roots' };

export interface V3CommandReceipt {
  accepted: boolean;
  commandId: string;
  cursor: V3RunCursor;
  serverTimeMs: number;
  canonicalState: string;
  creditedAtoms: string;
  spentAtoms: string;
  scoreTier: number;
}

export interface V3RunCursor {
  runId: string;
  sequence: number;
  rulesVersion: number;
}

export interface V3CanonicalState {
  rulesVersion: 1 | 2;
  natureAtoms: string;
  earnedNatureAtoms: string;
  habitats: Partial<Record<V3HabitatKind, number>>;
  habitatProductionUpgrades?: Partial<Record<V3HabitatKind, V3HabitatUpgradeMilestone[]>>;
  upgrades: Record<V3UpgradeKind, number>;
}

export interface V3VerifierError {
  code: string;
  message: string;
  expectedSequence?: number;
  recovery?: {
    cursor: V3RunCursor;
    canonicalState: string;
  };
}

// API Response Types

export interface V3ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: V3VerifierError;
}
// Component Props Types

export interface V3StatusPanelProps {
  runState: V3RunState;
  onRefetch?: () => void;
}

export interface V3CommandQueueProps {
  queueState: V3CommandQueueState;
  onRetry?: (commandId: string) => void;
  onClear?: () => void;
}

export interface V3UpgradeTreeProps {
  runState: V3RunState;
  onBuyUpgrade?: (upgrade: V3UpgradeKind, quantity: number) => void;
  upgradeCosts?: Record<V3UpgradeKind, number>;
}

export interface V3RunControlsProps {
  runState: V3RunState;
  transactionState: TransactionState;
  onStartRun?: (upgrades: Array<{ upgradeId: number; quantity: number }>) => Promise<void>;
  onRecordPoints?: () => Promise<void>;
  onRebirth?: () => Promise<void>;
  onAbandonRun?: () => Promise<void>;
}
