import { mkdirSync } from 'node:fs';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { defineChain, isAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LocalVerifier } from '../localVerifier';
import { V3AttestationIssuer } from './attestationIssuer';
import { createLocalVerifierHttpServer } from './httpVerifier';
import { SqliteVerifierStore } from './sqliteVerifierStore';
import { EoaAndContractWalletMessageVerifier, SqliteWalletSessions } from './walletSessions';
import { createV3RpcClient, V3ChainStateReader } from './v3ChainReader';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required local setting ${name}.`);
  return value;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.WORLDSEED_V3_LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
  const contractAddress = required('WORLDSEED_V3_LOCAL_CONTRACT_ADDRESS') as Address;
  const privateKey = required('WORLDSEED_V3_LOCAL_ATTESTER_PRIVATE_KEY') as `0x${string}`;
  if (!isAddress(contractAddress)) throw new Error('Local V3 contract address is invalid.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey))
    throw new Error('Local attester key has an invalid format.');
  const rpc = new URL(rpcUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname))
    throw new Error('Local verifier refuses non-loopback RPC URLs.');

  const chainId = 31_337;
  const chain = defineChain({
    id: chainId,
    name: 'Worldseed Local V3',
    nativeCurrency: { name: 'Local Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createV3RpcClient(chain, rpcUrl);
  if ((await client.getChainId()) !== chainId)
    throw new Error('Local RPC must report chain ID 31337.');
  const signer = privateKeyToAccount(privateKey);
  const databasePath = resolve(
    process.env.WORLDSEED_V3_LOCAL_DB_PATH ?? '.local/worldseed-v3.sqlite',
  );
  mkdirSync(dirname(databasePath), { recursive: true });
  const now = () => Date.now();
  const store = new SqliteVerifierStore(databasePath);
  const reader = new V3ChainStateReader({
    config: {
      chain,
      rpcUrl,
      contractAddress,
      confirmations: 1,
      deploymentBlock: 1n,
      activeRunStatus: 1,
      nowMilliseconds: now,
    },
    checkpoints: store,
    client,
  });
  const attester = await reader.getAttesterAddress();
  if (attester.toLowerCase() !== signer.address.toLowerCase()) {
    store.close();
    throw new Error('Local signer does not match the contract attester.');
  }
  const origin = process.env.WORLDSEED_V3_LOCAL_ALLOWED_ORIGIN ?? 'http://localhost:5173';
  const origins = new Set([origin]);
  const sessions = new SqliteWalletSessions(
    store,
    new EoaAndContractWalletMessageVerifier(reader),
    {
      deployments: new Map([[String(chainId), contractAddress]]),
      allowedOrigins: origins,
      nowMilliseconds: now,
    },
  );
  const verifier = new LocalVerifier(sessions, reader, store, { nowMilliseconds: now });
  const issuer = new V3AttestationIssuer(store, reader, signer, BigInt(chainId), contractAddress);
  const server = createLocalVerifierHttpServer({
    allowedOrigins: origins,
    store,
    sessions,
    verifier,
    chain: reader,
    issuer,
  });
  const port = Number(process.env.WORLDSEED_V3_LOCAL_PORT ?? '8788');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    store.close();
    throw new Error('Local verifier port must be between 0 and 65535.');
  }
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not bind local verifier socket.');
  console.info(`Worldseed local verifier: http://127.0.0.1:${address.port}`);
  console.info(`Contract: ${contractAddress}; attester: ${attester}; chain ID: ${chainId}`);
  const close = () =>
    server.close(() => {
      store.close();
    });
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch(() => {
  // RPC client errors may include the configured URL, which can contain provider credentials.
  // Keep startup diagnostics useful without forwarding raw exception text to logs.
  console.error('Local verifier failed to start. Check local configuration and RPC availability.');
  process.exitCode = 1;
});
