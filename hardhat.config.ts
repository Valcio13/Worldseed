import { configVariable, defineConfig } from 'hardhat/config';
import hardhatViem from '@nomicfoundation/hardhat-viem';
import hardhatNodeTestRunner from '@nomicfoundation/hardhat-node-test-runner';

export default defineConfig({
  plugins: [hardhatViem, hardhatNodeTestRunner],
  solidity: {
    profiles: {
      default: { version: '0.8.24' },
      production: {
        version: '0.8.24',
        settings: {
          optimizer: { enabled: true, runs: 500 },
          viaIR: true,
          evmVersion: 'shanghai',
        },
      },
    },
  },
  networks: {
    hemiSepolia: {
      type: 'http',
      chainType: 'op',
      url: configVariable('HEMI_SEPOLIA_RPC_URL'),
      accounts: [configVariable('HEMI_SEPOLIA_PRIVATE_KEY')],
    },
    hemiMainnet: {
      type: 'http',
      chainType: 'op',
      url: configVariable('HEMI_MAINNET_RPC_URL'),
      accounts: [configVariable('HEMI_MAINNET_PRIVATE_KEY')],
    },
  },
  paths: {
    sources: './contracts',
    tests: { nodejs: './contract-test' },
    cache: './cache',
    artifacts: './artifacts',
  },
});
