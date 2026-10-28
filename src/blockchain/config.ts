import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { hemi, hemiSepolia } from 'viem/chains';
import { isAddress, parseAbi } from 'viem';

// The build explicitly selects one Hemi network. Unknown/omitted values retain
// the existing Sepolia default so local development cannot silently target mainnet.
export const IS_HEMI_MAINNET = import.meta.env.VITE_WORLDSEED_NETWORK === 'hemi-mainnet';
const targetChain = IS_HEMI_MAINNET ? hemi : hemiSepolia;

export const wagmiConfig = IS_HEMI_MAINNET
  ? createConfig({
      chains: [hemi],
      connectors: [injected()],
      transports: { [hemi.id]: http() },
    })
  : createConfig({
      chains: [hemiSepolia],
      connectors: [injected()],
      transports: { [hemiSepolia.id]: http() },
    });

export const TARGET_CHAIN_ID = targetChain.id;
export const TARGET_CHAIN_NAME = targetChain.name;

const address = IS_HEMI_MAINNET
  ? import.meta.env.VITE_WORLDSEED_MAINNET_CONTRACT_ADDRESS
  : import.meta.env.VITE_WORLDSEED_CONTRACT_ADDRESS;
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
