import { afterEach, describe, expect, it, vi } from 'vitest';

const TESTNET_GAME_ADDRESS = '0x1111111111111111111111111111111111111111';
const MAINNET_GAME_ADDRESS = '0x2222222222222222222222222222222222222222';
const TESTNET_V3_ADDRESS = '0x3333333333333333333333333333333333333333';
const MAINNET_V3_ADDRESS = '0x4444444444444444444444444444444444444444';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('selected Hemi network configuration', () => {
  it('selects Hemi Mainnet chain, addresses, and verifier URL when explicitly configured', async () => {
    vi.stubEnv('VITE_WORLDSEED_NETWORK', 'hemi-mainnet');
    // A V3-only Mainnet launch intentionally has no legacy V1 contract.
    vi.stubEnv('VITE_WORLDSEED_MAINNET_CONTRACT_ADDRESS', '');
    vi.stubEnv('VITE_WORLDSEED_CONTRACT_ADDRESS', TESTNET_GAME_ADDRESS);
    vi.stubEnv('VITE_WORLDSEED_V3_MAINNET_CONTRACT_ADDRESS', MAINNET_V3_ADDRESS);
    vi.stubEnv('VITE_WORLDSEED_V3_CONTRACT_ADDRESS', TESTNET_V3_ADDRESS);
    vi.stubEnv('VITE_VERIFIER_API_URL_MAINNET', 'https://hemi-mainnet-verifier.example');
    vi.stubEnv('VITE_VERIFIER_API_URL', 'https://hemi-sepolia-verifier.example');

    const { wagmiConfig, TARGET_CHAIN_ID, gameContractAddress } = await import('./config');
    const { TARGET_NETWORK_LABEL, V3_CONTRACT_ADDRESS_ENV } = await import('./networkPresentation');
    const { v3ContractAddress } = await import('../v3/config');
    const { v3Api } = await import('../v3/api');
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    expect(TARGET_CHAIN_ID).toBe(43111);
    expect(wagmiConfig.chains.map(({ id }) => id)).toEqual([43111]);
    expect(gameContractAddress).toBeUndefined();
    expect(v3ContractAddress).toBe(MAINNET_V3_ADDRESS);
    expect(TARGET_NETWORK_LABEL).toBe('Hemi Mainnet');
    expect(V3_CONTRACT_ADDRESS_ENV).toBe('VITE_WORLDSEED_V3_MAINNET_CONTRACT_ADDRESS');

    await v3Api.health();
    expect(fetchMock).toHaveBeenCalledWith('https://hemi-mainnet-verifier.example/health');
  });

  it('keeps Hemi Sepolia as the development default and selects its addresses and verifier', async () => {
    vi.stubEnv('VITE_WORLDSEED_NETWORK', '');
    vi.stubEnv('VITE_WORLDSEED_CONTRACT_ADDRESS', TESTNET_GAME_ADDRESS);
    vi.stubEnv('VITE_WORLDSEED_MAINNET_CONTRACT_ADDRESS', MAINNET_GAME_ADDRESS);
    vi.stubEnv('VITE_WORLDSEED_V3_CONTRACT_ADDRESS', TESTNET_V3_ADDRESS);
    vi.stubEnv('VITE_WORLDSEED_V3_MAINNET_CONTRACT_ADDRESS', MAINNET_V3_ADDRESS);
    vi.stubEnv('VITE_VERIFIER_API_URL', 'https://hemi-sepolia-verifier.example');
    vi.stubEnv('VITE_VERIFIER_API_URL_MAINNET', 'https://hemi-mainnet-verifier.example');

    const { wagmiConfig, TARGET_CHAIN_ID, TARGET_CHAIN_NAME, gameContractAddress } =
      await import('./config');
    const { TARGET_NETWORK_LABEL, V3_CONTRACT_ADDRESS_ENV } = await import('./networkPresentation');
    const { v3ContractAddress } = await import('../v3/config');
    const { v3Api } = await import('../v3/api');
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    expect(TARGET_CHAIN_ID).toBe(743111);
    expect(TARGET_CHAIN_NAME).toBe('Hemi Sepolia');
    expect(TARGET_NETWORK_LABEL).toBe('Hemi Sepolia');
    expect(wagmiConfig.chains.map(({ id }) => id)).toEqual([743111]);
    expect(gameContractAddress).toBe(TESTNET_GAME_ADDRESS);
    expect(v3ContractAddress).toBe(TESTNET_V3_ADDRESS);
    expect(V3_CONTRACT_ADDRESS_ENV).toBe('VITE_WORLDSEED_V3_CONTRACT_ADDRESS');

    await v3Api.health();
    expect(fetchMock).toHaveBeenCalledWith('https://hemi-sepolia-verifier.example/health');
  });
});
