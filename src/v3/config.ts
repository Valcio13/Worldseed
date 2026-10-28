/**
 * V3 Blockchain Configuration
 *
 * Configuration for the V3 contract and wallet integration.
 */

import { parseAbi } from 'viem';
import { IS_HEMI_MAINNET } from '../blockchain/config';

// V3 Contract ABI - functions defined in WorldseedGameV3.sol
export const v3ContractAbi = parseAbi([
  // Read functions
  'function owner() view returns (address)',
  'function attester() view returns (address)',
  'function paused() view returns (bool)',
  'function activeRulesVersion() view returns (uint32)',
  'function currentSeasonId() view returns (uint64)',
  'function seasonStart(uint64 seasonId) view returns (uint64)',
  'function seasonEnd(uint64 seasonId) view returns (uint64)',
  'function seasonIdAt(uint64 timestamp) view returns (uint64)',
  'function nextRunId(address player) view returns (uint64)',
  'function activeRunId(address player) view returns (uint64)',
  'function runs(address player, uint64 runId) view returns (uint64 seasonId, uint8 status, uint64 startedAt, uint16 lastRecordedScoreTier, uint32 rulesVersion, bytes32 upgradeChoicesHash)',
  'function attestationNonce(address player) view returns (uint64)',
  'function seasonalPP(address player, uint64 seasonId) view returns (uint256)',
  'function seasonalCP(address player, uint64 seasonId) view returns (uint256)',
  'function totalSeasonCP(uint64 seasonId) view returns (uint256)',
  'function MAX_SEASON_POINTS() view returns (uint256)',
  'function seasonalHighScoreTier(address player, uint64 seasonId) view returns (uint16)',
  'function lifetimeCP(address player) view returns (uint256)',
  'function lifetimeNatureCollectedAtoms(address player) view returns (uint256)',
  'function totalAccumulatedRebirthScore(address player) view returns (uint256)',
  'function seasonalAccumulatedRebirthScore(address player, uint64 seasonId) view returns (uint256)',
  'function seasonalRebirths(address player, uint64 seasonId) view returns (uint32)',
  'function seasonalUpgradeLevel(address player, uint64 seasonId, uint8 upgradeId) view returns (uint16)',
  'function rewardRules(uint32 version) view returns (uint16 rebirthThresholdTier, uint16 ppStep, uint16 ppPerRebirthCap, uint32 ppBase, uint32 seasonPPCap, uint32 seasonCPCap, uint16 maxUpgradeLevel, uint16 cpMilestoneStep)',
  'function hashUpgradeChoices((uint8,uint16)[]) view returns (bytes32)',
  'function domainSeparator() view returns (bytes32)',

  // Write functions
  'function startRun((address,uint64,uint64,uint256,address,uint16,uint256,uint64,uint64,uint64,uint32,uint32,bytes32,uint8) a, (uint8,uint16)[] choices, bytes signature)',
  'function recordPoints((address,uint64,uint64,uint256,address,uint16,uint256,uint64,uint64,uint64,uint32,uint32,bytes32,uint8) a, bytes signature)',
  'function rebirth((address,uint64,uint64,uint256,address,uint16,uint256,uint64,uint64,uint64,uint32,uint32,bytes32,uint8) a, bytes signature)',
  'function abandonRun(uint64 runId)',
  'function pause()',
  'function unpause()',
  'function proposeAttester(address proposed)',
  'function cancelAttesterProposal()',
  'function acceptAttester()',
  'function proposeOwnershipTransfer(address proposed)',
  'function acceptOwnership()',
  'function proposeRewardRules(uint32 version, (uint16,uint16,uint16,uint32,uint32,uint32,uint16,uint16) rules)',
  'function activateRewardRules(uint32 version)',
]);

// V3 Contract Events (for decoding logs)
export const v3ContractEvents = parseAbi([
  'event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event AttesterProposed(address indexed previousAttester, address indexed proposedAttester, uint64 activatesAt)',
  'event AttesterProposalCancelled(address indexed cancelledAttester)',
  'event AttesterChanged(address indexed previousAttester, address indexed newAttester, uint32 signerEpoch)',
  'event PauseChanged(bool paused)',
  'event RewardRulesProposed(uint32 indexed rulesVersion, uint64 activatesAt)',
  'event RewardRulesActivated(uint32 indexed rulesVersion)',
  'event RunStarted(address indexed player, uint64 indexed runId, uint64 indexed seasonId, uint32 rulesVersion, bytes32 upgradeChoicesHash, uint64 startedAt, (uint8,uint16)[] upgradeChoices)',
  'event PointsRecorded(address indexed player, uint64 indexed runId, uint16 scoreTier, uint64 nonce)',
  'event RebirthSettled(address indexed player, uint64 indexed runId, uint64 indexed seasonId, uint16 scoreTier, uint256 ppAwarded, uint256 cpAwarded, uint64 nonce, uint32 rulesVersion, uint256 natureCollectedAtoms)',
  'event RunAbandoned(address indexed player, uint64 indexed runId, uint64 indexed seasonId)',
  'event RunExpired(address indexed player, uint64 indexed runId, uint64 indexed seasonId)',
]);

// V3 Contract Address - set via environment variable
const v3Address = IS_HEMI_MAINNET
  ? import.meta.env.VITE_WORLDSEED_V3_MAINNET_CONTRACT_ADDRESS
  : import.meta.env.VITE_WORLDSEED_V3_CONTRACT_ADDRESS;

export const v3ContractAddress =
  v3Address && /^0x[a-fA-F0-9]{40}$/.test(v3Address) ? (v3Address as `0x${string}`) : undefined;

// EIP-712 Domain for V3
export const V3_DOMAIN = {
  name: 'Worldseed V3',
  version: '1',
} as const;

// Helper to check if V3 is configured
export const isV3Configured = () => !!v3ContractAddress;
