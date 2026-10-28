/**
 * Worldseed V3 Frontend
 *
 * Wallet-linked verified gameplay components and hooks.
 *
 * @packageDocumentation
 */

// Types (excluding types that come from api.ts to avoid duplication)
export type {
  V3RunState,
  V3Run,
  V3UpgradeKind,
  V3HabitatKind,
  V3ActionType,
  V3CanonicalState,
  V3Command,
  V3CommandQueueState,
  V3CursorState,
  V3GameplayCommand,
} from './types';

// Version-aware canonical state parsing and purchase command helpers.
export {
  createHabitatProductionUpgradeCommand,
  createHabitatPurchaseCommand,
  habitatLevelForVerifiedState,
  habitatPurchaseCostForVerifiedState,
  habitatsForVerifiedState,
  isV1VerifiedState,
  isV2VerifiedState,
  isV3VerifiedState,
  nextHabitatProductionMilestone,
  parseV3CanonicalState,
  purchasedHabitatProductionMilestones,
} from './canonicalState';
export type { V1HabitatId, V2HabitatId, V3HabitatId, V3VerifiedCanonicalState } from './canonicalState';

// Configuration
export {
  v3ContractAbi,
  v3ContractAddress,
  v3ContractEvents,
  V3_DOMAIN,
  isV3Configured,
} from './config';

// API Client (exports the API types and client functions)
export { v3Api, createMockV3Api, V3ApiError, translateGameplayCommand } from './api';
export type {
  V3ChallengeRequest,
  V3ChallengeResponse,
  V3ChallengeCompletion,
  V3SessionResponse,
  V3StartAttestationRequest,
  V3StartAttestationResponse,
  V3ScoreAttestation,
  V3RunCursor,
  V3RunRecoveryResponse,
  V3CommandEnvelope,
  V3CommandReceipt,
  V3CheckpointAttestation,
  V3RebirthAttestation,
  V3HealthResponse,
  V3ErrorResponse,
} from './api';

// Components
export * from './components';

// Hooks
export * from './hooks';
