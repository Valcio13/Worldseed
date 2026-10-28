/**
 * V3 Verifier API Client
 *
 * Typed HTTP client for the Cloudflare Worker V3 verifier.
 * The Worker serves at `/api/v3/*` on the same origin.
 * See docs/v3-verifier-api.md for the complete API contract.
 */

import type {
  V3CommandReceipt,
  V3HabitatKind,
  V3RunCursor,
  V3UpgradeKind,
  V3GameplayCommand,
} from './types';
import { IS_HEMI_MAINNET } from '../blockchain/config';
export type { V3CommandReceipt, V3RunCursor } from './types';

// Base URL for API calls. Can include a path prefix (e.g., http://localhost:8788).
// Do NOT include /api/v3 here; it will be prepended to each endpoint path.
const API_BASE = IS_HEMI_MAINNET
  ? import.meta.env.VITE_VERIFIER_API_URL_MAINNET || ''
  : import.meta.env.VITE_VERIFIER_API_URL || '';

/**
 * API Error with structured response
 */
export class V3ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly errorResponse?: V3ErrorResponse,
  ) {
    super(message);
    this.name = 'V3ApiError';
  }
}

/**
 * Error response structure from API
 */
export interface V3ErrorResponse {
  code: string;
  message: string;
  expectedSequence?: number;
  recovery?: {
    cursor: V3RunCursor;
    canonicalState: string;
  };
}

/**
 * Challenge request for authentication
 */
export interface V3ChallengeRequest {
  wallet: `0x${string}`;
  chainId: string;
  verifyingContract: `0x${string}`;
  runId: string;
}

/**
 * Challenge response
 */
export interface V3ChallengeResponse {
  challengeId: string;
  message: string;
  expiresAtMs: number;
}

/**
 * Challenge completion
 */
export interface V3ChallengeCompletion {
  challengeId: string;
  signature: `0x${string}`;
}

/**
 * Session token response
 */
export interface V3SessionResponse {
  sessionToken: string;
  expiresAtMs: number;
}

/**
 * Upgrade choice for start-run
 */
export interface V3UpgradeChoiceInput {
  upgradeId: V3UpgradeKind;
  quantity: number;
}

/**
 * Start run attestation request
 */
export interface V3StartAttestationRequest {
  upgradeChoices?: V3UpgradeChoiceInput[];
}

/**
 * Start run attestation response
 */
export interface V3ScoreAttestation {
  player: `0x${string}`;
  runId: string;
  seasonId: string;
  chainId: string;
  verifyingContract: `0x${string}`;
  scoreTier: number;
  natureCollectedAtoms: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  rulesVersion: number;
  signerEpoch: number;
  upgradeChoicesHash: `0x${string}`;
  actionType: 'START_RUN' | 'RECORD_POINTS' | 'REBIRTH';
}

/**
 * Start run attestation response with signature
 */
export interface V3StartAttestationResponse {
  attestation: V3ScoreAttestation;
  signature: `0x${string}`;
  digest: `0x${string}`;
  upgradeChoices: Array<{ upgradeId: number; quantity: number }>;
}

/**
 * Run cursor
 */
/**
 * Canonical run state as JSON string with decimal amounts
 */
export interface V3RunRecoveryResponse {
  cursor: V3RunCursor;
  canonicalState: string;
  scoreTier: number;
  wallet: `0x${string}`;
}

/**
 * Command submitted to verifier
 */
export interface V3CommandEnvelope {
  commandId: string;
  expectedSequence: number;
  command: V3GameplayCommand;
}

/**
 * Translate and validate UI gameplay commands to verifier command format.
 * This function ensures type safety and explicitly rejects unsupported operations.
 */
export function translateGameplayCommand(uiCommand: unknown): V3GameplayCommand {
  if (!uiCommand || typeof uiCommand !== 'object') {
    throw new Error('Invalid gameplay command: must be an object');
  }

  const cmd = uiCommand as Record<string, unknown>;
  const type = cmd.type;

  // Explicitly supported commands
  if (type === 'heart-click') {
    const quantity = cmd.quantity;
    if (
      quantity !== undefined &&
      (!Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 100)
    ) {
      throw new Error('Invalid Heart batch quantity. Must be an integer from 1 through 100.');
    }
    return quantity === undefined
      ? { type: 'heart-click' }
      : { type: 'heart-click', quantity: quantity as number };
  }
  if (type === 'sync') {
    return { type };
  }

  if (type === 'buy-habitat') {
    const habitat = cmd.habitat;
    const quantity = cmd.quantity;
    if (
      !['water', 'grass', 'forest', 'mountain', 'crystal-cavern', 'ancient-grove'].includes(
        String(habitat),
      )
    ) {
      throw new Error(`Unsupported habitat: ${habitat}.`);
    }
    if (
      !Number.isInteger(quantity as unknown) ||
      (quantity as number) < 1 ||
      (quantity as number) > 1000
    ) {
      throw new Error(`Invalid quantity: ${quantity}. Must be an integer from 1 through 1000.`);
    }
    return {
      type: 'buy-habitat',
      habitat: habitat as V3HabitatKind,
      quantity: quantity as number,
    };
  }

  if (type === 'buy-habitat-production-upgrade') {
    const habitat = cmd.habitat;
    const milestone = cmd.milestone;
    if (
      !['water', 'grass', 'forest', 'mountain', 'crystal-cavern', 'ancient-grove'].includes(
        String(habitat),
      )
    )
      throw new Error(`Unsupported habitat: ${habitat}.`);
    if (![10, 25, 50, 100].includes(milestone as number))
      throw new Error(`Invalid production-upgrade milestone: ${milestone}.`);
    return {
      type: 'buy-habitat-production-upgrade',
      habitat: habitat as V3HabitatKind,
      milestone: milestone as 10 | 25 | 50 | 100,
    };
  }

  if (type === 'buy-temporary-upgrade') {
    const upgrade = cmd.upgrade;
    if (!['sunny-season', 'deep-roots', 'nature-surge'].includes(String(upgrade))) {
      throw new Error(`Unsupported temporary upgrade: ${upgrade}.`);
    }
    return {
      type: 'buy-temporary-upgrade',
      upgrade: upgrade as 'sunny-season' | 'deep-roots' | 'nature-surge',
    };
  }

  if (type === 'buy-fertile-soil' || type === 'buy-time-bloom') return { type };

  // Explicit rejection of unsupported commands
  throw new Error(`Unsupported gameplay command type: ${type}.`);
}

/**
 * Command receipt from server (authoritative)
 */
/**
 * Checkpoint attestation response
 */
export interface V3CheckpointAttestation {
  attestation: V3ScoreAttestation;
  signature: `0x${string}`;
  digest: `0x${string}`;
}

/**
 * Rebirth attestation response
 */
export interface V3RebirthAttestation {
  attestation: V3ScoreAttestation;
  signature: `0x${string}`;
  digest: `0x${string}`;
}

/**
 * Health check response
 */
export interface V3HealthResponse {
  ok: boolean;
}

/**
 * Parse verifier error response
 */
function parseErrorResponse(data: unknown): V3ErrorResponse {
  if (typeof data === 'object' && data !== null && 'code' in data && 'message' in data) {
    return data as V3ErrorResponse;
  }
  return { code: 'UNKNOWN', message: 'Unknown error' };
}

/**
 * Make a request to the verifier API
 */
async function makeRequest<T>(
  path: string,
  options: {
    method: 'GET' | 'POST';
    body?: object;
    sessionToken?: string;
  },
): Promise<T> {
  // Build the full URL with proper path handling
  // path should start with /api/v3/ for API calls, or / for health endpoint
  let url: string;
  if (API_BASE.startsWith('http')) {
    // Absolute URL (production)
    url = new URL(path, API_BASE).href;
  } else if (API_BASE) {
    // Relative URL with custom base (e.g., http://localhost:8788)
    url = `${API_BASE}${path}`;
  } else {
    // Default to relative URL from current origin
    url = path;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (options.sessionToken) {
    headers['Authorization'] = `Bearer ${options.sessionToken}`;
  }

  const fetchOptions: RequestInit = {
    method: options.method,
    headers,
  };

  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);
  const data = await response.json();

  if (!response.ok) {
    const error = parseErrorResponse(data);
    throw new V3ApiError(error.message, error.code, response.status, error);
  }

  return data as T;
}

/**
 * V3 API Client
 */
export const v3Api = {
  /**
   * Check API health
   * Health endpoint is at the root level, not under /api/v3
   */
  async health(): Promise<V3HealthResponse> {
    let url: string;
    if (API_BASE.startsWith('http')) {
      url = new URL('/health', API_BASE).href;
    } else if (API_BASE) {
      url = `${API_BASE}/health`;
    } else {
      url = '/health';
    }
    const response = await fetch(url);
    return response.json();
  },

  /**
   * Request authentication challenge
   */
  async requestChallenge(req: V3ChallengeRequest): Promise<V3ChallengeResponse> {
    return makeRequest('/api/v3/auth/challenge', {
      method: 'POST',
      body: req,
    });
  },

  /**
   * Complete authentication with signed challenge
   */
  async completeChallenge(req: V3ChallengeCompletion): Promise<V3SessionResponse> {
    return makeRequest('/api/v3/auth/complete', {
      method: 'POST',
      body: req,
    });
  },

  /**
   * Get start run attestation
   */
  async getStartAttestation(
    _runId: string,
    req: V3StartAttestationRequest,
    sessionToken: string,
  ): Promise<V3StartAttestationResponse> {
    return makeRequest('/api/v3/runs/start-attestation', {
      method: 'POST',
      body: req,
      sessionToken,
    });
  },

  /**
   * Recover run state
   */
  async recoverRun(runId: string, sessionToken: string): Promise<V3RunRecoveryResponse> {
    return makeRequest(`/api/v3/runs/${runId}/recover`, {
      method: 'GET',
      sessionToken,
    });
  },

  /**
   * Submit a gameplay command
   */
  async submitCommand(
    runId: string,
    cmd: V3CommandEnvelope,
    sessionToken: string,
  ): Promise<V3CommandReceipt> {
    if (
      typeof cmd.commandId !== 'string' ||
      cmd.commandId.length < 1 ||
      cmd.commandId.length > 128
    ) {
      throw new Error('Invalid commandId: must contain 1 through 128 characters.');
    }
    if (!Number.isSafeInteger(cmd.expectedSequence) || cmd.expectedSequence < 0) {
      throw new Error('Invalid expectedSequence: must be a nonnegative safe integer.');
    }
    // Validate and translate the command
    const validatedCommand = translateGameplayCommand(cmd.command);
    const validatedEnvelope: V3CommandEnvelope = {
      ...cmd,
      command: validatedCommand,
    };
    return makeRequest(`/api/v3/runs/${runId}/commands`, {
      method: 'POST',
      body: validatedEnvelope,
      sessionToken,
    });
  },

  /**
   * Get checkpoint attestation
   */
  async getCheckpointAttestation(
    runId: string,
    sessionToken: string,
  ): Promise<V3CheckpointAttestation> {
    return makeRequest(`/api/v3/runs/${runId}/record-attestation`, {
      method: 'POST',
      body: {},
      sessionToken,
    });
  },

  /**
   * Get rebirth attestation
   */
  async getRebirthAttestation(runId: string, sessionToken: string): Promise<V3RebirthAttestation> {
    return makeRequest(`/api/v3/runs/${runId}/rebirth-attestation`, {
      method: 'POST',
      body: {},
      sessionToken,
    });
  },
};

/**
 * Development-only mock API for testing without backend
 */
export function createMockV3Api() {
  let mockSequence = 0;

  return {
    async health() {
      return { ok: true };
    },

    async requestChallenge() {
      return {
        challengeId: 'mock-challenge-123',
        message: 'Sign this message to authenticate',
        expiresAtMs: Date.now() + 5 * 60 * 1000,
      };
    },

    async completeChallenge() {
      return {
        sessionToken: 'mock-session-token-' + Math.random().toString(36).slice(2),
        expiresAtMs: Date.now() + 15 * 60 * 1000,
      };
    },

    async getStartAttestation(
      runId: string,
      req: V3StartAttestationRequest,
    ): Promise<V3StartAttestationResponse> {
      return {
        attestation: {
          player: '0x0000000000000000000000000000000000000000' as `0x${string}`,
          runId,
          seasonId: '0',
          chainId: '1',
          verifyingContract: '0x0000000000000000000000000000000000000000' as `0x${string}`,
          scoreTier: 0,
          natureCollectedAtoms: '0',
          nonce: '0',
          issuedAt: String(Math.floor(Date.now() / 1000)),
          expiresAt: String(Math.floor(Date.now() / 1000) + 300),
          rulesVersion: 1,
          signerEpoch: 1,
          upgradeChoicesHash:
            '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
          actionType: 'START_RUN',
        },
        signature:
          '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        digest:
          '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        upgradeChoices:
          req.upgradeChoices?.map((u) => ({
            upgradeId:
              u.upgradeId === 'growth'
                ? 0
                : u.upgradeId === 'efficiency'
                  ? 1
                  : u.upgradeId === 'awakening'
                    ? 2
                    : 3,
            quantity: u.quantity,
          })) || [],
      };
    },

    async recoverRun(runId: string) {
      return {
        cursor: { runId, sequence: mockSequence, rulesVersion: 1 },
        canonicalState: JSON.stringify({
          natureAtoms: '0',
          earnedNatureAtoms: '0',
          habitats: { water: 0, grass: 0, forest: 0 },
        }),
        scoreTier: 0,
        wallet: '0x0000000000000000000000000000000000000000' as `0x${string}`,
      };
    },

    async submitCommand(_runId: string, cmd: V3CommandEnvelope): Promise<V3CommandReceipt> {
      mockSequence++;
      let credited = '0';
      if ((cmd.command as { type: string }).type === 'heart-click') {
        credited = '1000000000000';
      }
      return {
        accepted: true,
        commandId: cmd.commandId,
        cursor: { runId: 'mock-run', sequence: mockSequence, rulesVersion: 1 },
        serverTimeMs: Date.now(),
        canonicalState: JSON.stringify({}),
        creditedAtoms: credited,
        spentAtoms: '0',
        scoreTier: 0,
      };
    },

    async getCheckpointAttestation() {
      return {
        attestation: {} as V3ScoreAttestation,
        signature: '0x' as `0x${string}`,
        digest: '0x' as `0x${string}`,
      };
    },

    async getRebirthAttestation() {
      return {
        attestation: {} as V3ScoreAttestation,
        signature: '0x' as `0x${string}`,
        digest: '0x' as `0x${string}`,
      };
    },
  };
}
