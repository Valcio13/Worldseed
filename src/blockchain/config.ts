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

export const gameContractAbi = parseAbi([
  'function startIsland(uint32 seed)',
  'function saveProgress(uint64 expectedCursor, uint8[] actions)',
  'function finishIsland(uint64 expectedCursor, uint8[] actions, bytes32 snapshotHash)',
  'function islandState(address player) view returns (bool started, bool complete, uint8 unlockedThrough, uint64 cursor, uint32 seed, uint8[49] habitats, uint16[3] inventory, bool[5] claimed)',
  'function currentWeek() view returns (uint256)',
  'function weeklyContributions(uint256 week) view returns (uint32)',
  'function goldBalances(address player) view returns (uint256)',
  'function buyHabitat(uint8 habitat, uint16 quantity)',
]);
