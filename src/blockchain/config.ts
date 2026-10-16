import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { hemiSepolia } from 'viem/chains';
import { isAddress, parseAbi } from 'viem';

export const wagmiConfig = createConfig({
  chains: [hemiSepolia],
  connectors: [injected()],
  transports: { [hemiSepolia.id]: http() },
});

export const TARGET_CHAIN_ID = hemiSepolia.id;
export const TARGET_CHAIN_NAME = hemiSepolia.name;

const address = import.meta.env.VITE_WORLDSEED_CONTRACT_ADDRESS;
export const gameContractAddress = address && isAddress(address) ? address : undefined;
const v2Address = import.meta.env.VITE_WORLDSEED_V2_CONTRACT_ADDRESS;
export const expeditionContractAddress = v2Address && isAddress(v2Address) ? v2Address : undefined;

export const gameContractAbi = parseAbi([
  'function startIsland(uint32 seed)',
  'function saveProgress(uint64 expectedCursor, uint8[] actions)',
  'function finishIsland(uint64 expectedCursor, uint8[] actions, bytes32 snapshotHash)',
  'function islandState(address player) view returns (bool started, bool complete, uint8 unlockedThrough, uint64 cursor, uint32 seed, uint8[49] habitats, uint16[3] inventory, bool[5] claimed)',
  'function currentWeek() view returns (uint256)',
  'function weeklyContributions(uint256 week) view returns (uint32)',
  'function puzzleState(address player) view returns (bool active, uint8 mode, uint16 moves, uint32 score, uint32 seed, uint32 rngState, uint8[16] board)',
  'function staminaState(address player) view returns (uint8 available, uint64 nextRegenerationAt)',
  'function goldBalances(address player) view returns (uint256)',
  'function startPuzzleRound(uint8 mode) returns (uint32 seed)',
  'function savePuzzleMoves(uint16 expectedMoves, uint8[] directions, bool cashOut)',
  'function buyHabitat(uint8 habitat, uint16 quantity)',
]);

export const expeditionContractAbi = parseAbi([
  'function startExpedition((address player,uint64 expeditionNumber,bytes32 sourceCommitment,bytes32[3] candidateSeeds,bytes32 combinedCharacterSeed,uint32 islandGeneratorVersion,uint32 characterGeneratorVersion,uint32 sourceSelectionPolicyVersion,uint64 issuedAt,uint64 expiresAt) set,uint8 selectedIndex,bytes signature) returns (uint64 expeditionId)',
  'function saveProgress(uint64 expeditionId,uint64 expectedCursor,uint8[] actions)',
  'function finishExpedition(uint64 expeditionId,uint64 expectedCursor,uint8[] actions,bytes32 snapshotHash)',
  'function abandonExpedition(uint64 expeditionId)',
  'function buyHabitat(uint64 expeditionId,uint8 habitat,uint16 quantity)',
  'function contributeWorldTree(uint64 expeditionId,uint32 amount) returns (bytes32 contributionId)',
  'function nextExpeditionNumber(address player) view returns (uint64)',
  'function nextExpeditionId(address player) view returns (uint64)',
  'function activeExpeditionId(address player) view returns (uint64)',
  'function expeditionState(address player,uint64 id) view returns (uint8 lifecycle,uint8 selectedIndex,uint8 unlockedThrough,uint64 cursor,bytes32 seed,bytes32 sourceCommitment,bytes32 combinedCharacterSeed,uint64 startedAt,uint32[3] generatorVersions)',
  'function expeditionBoard(address player,uint64 id) view returns (uint8[49] habitats,uint16[3] inventory,bool[5] claimed)',
  'function goldBalances(address player) view returns (uint256)',
  'function currentWeek() view returns (uint256)',
  'function weeklyContributions(uint256 week) view returns (uint32)',
  'function startPuzzleRound(uint64 expeditionId,uint8 mode) returns (uint32 seed)',
  'function savePuzzleMoves(uint16 expectedMoves,uint8[] directions,bool cashOut)',
  'function puzzleState(address player) view returns (bool active,uint8 mode,uint16 moves,uint32 score,uint32 seed,uint32 rngState,uint64 expeditionId,uint8[16] board)',
  'function staminaState(address player) view returns (uint8 available,uint64 nextRegenerationAt)',
]);
