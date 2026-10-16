import { env, exit } from 'node:process';
import {
  selectBitcoinTransaction,
  selectEvmSourceTransaction,
  SourceUnavailableError,
} from '../src/expeditions/sources';

const ethereumUrl = env.ETHEREUM_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const hemiUrl = env.HEMI_SEPOLIA_RPC_URL ?? 'https://testnet.rpc.hemi.network/rpc';
const bitcoinUrl = env.BITCOIN_TESTNET4_API_URL ?? 'https://mempool.space/testnet4/api';
const startedAt = Date.now();

const results = await Promise.allSettled([
  selectEvmSourceTransaction('ethereum', ethereumUrl, {
    ethereumSepoliaRpcUrl: ethereumUrl,
    hemiSepoliaRpcUrl: hemiUrl,
  }),
  selectEvmSourceTransaction('hemi', hemiUrl, {
    ethereumSepoliaRpcUrl: ethereumUrl,
    hemiSepoliaRpcUrl: hemiUrl,
  }),
  selectBitcoinTransaction({
    ethereumSepoliaRpcUrl: ethereumUrl,
    hemiSepoliaRpcUrl: hemiUrl,
    bitcoinTestnet4ApiUrl: bitcoinUrl,
  }),
]);

const sources = ['ethereum', 'hemi', 'bitcoin'] as const;
const report = Object.fromEntries(
  results.map((result, index) => {
    if (result.status === 'rejected') {
      const configuredUrl = [ethereumUrl, hemiUrl, bitcoinUrl].find((url) =>
        String(result.reason instanceof Error ? result.reason.message : result.reason).includes(
          url,
        ),
      );
      const errorMessage =
        result.reason instanceof SourceUnavailableError
          ? result.reason.message
          : result.reason instanceof Error
            ? result.reason.message
            : 'Provider request failed.';
      return [
        sources[index],
        {
          ok: false,
          error: configuredUrl
            ? errorMessage.replaceAll(configuredUrl, '[configured provider]')
            : errorMessage,
        },
      ];
    }
    const row = result.value;
    return [
      sources[index],
      {
        ok: true,
        networkId: row.networkId,
        providerId: row.providerId,
        txHash: row.txHash,
        blockHash: row.blockHash,
        blockNumber: row.blockNumber,
        transactionIndex: row.transactionIndex,
        confirmations: row.confirmations,
        requiredConfirmations: row.requiredConfirmations,
      },
    ];
  }),
);

console.log(JSON.stringify({ elapsedMs: Date.now() - startedAt, sources: report }, null, 2));
if (results.some((result) => result.status === 'rejected')) exit(1);
