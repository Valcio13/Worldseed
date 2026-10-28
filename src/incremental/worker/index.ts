import { defineChain, isAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LocalVerifier } from '../localVerifier';
import { V3AttestationIssuer } from '../server/attestationIssuer';
import { D1VerifierStore } from '../server/d1VerifierStore';
import { V3ChainStateReader, createV3RpcClient } from '../server/v3ChainReader';
import { WorkersWalletSessions } from '../server/workersWalletSessions';
import { createWorkerVerifierHandler } from './httpHandler';
import type { WorldseedWorkerEnv } from './env';

function required(value: string | undefined, name: string): string {
  if (!value || value.startsWith('REPLACE_')) throw new Error(`Missing Worker setting ${name}.`);
  return value;
}

function configured(env: WorldseedWorkerEnv) {
  const chainId = Number(required(env.V3_CHAIN_ID, 'V3_CHAIN_ID'));
  const deploymentBlock = BigInt(required(env.V3_DEPLOYMENT_BLOCK, 'V3_DEPLOYMENT_BLOCK'));
  const confirmations = Number(required(env.V3_CONFIRMATIONS, 'V3_CONFIRMATIONS'));
  const rpcUrl = required(env.V3_RPC_URL, 'V3_RPC_URL');
  const contractAddress = required(env.V3_CONTRACT_ADDRESS, 'V3_CONTRACT_ADDRESS') as Address;
  const privateKey = required(
    env.V3_ATTESTER_PRIVATE_KEY,
    'V3_ATTESTER_PRIVATE_KEY',
  ) as `0x${string}`;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('V3_CHAIN_ID is invalid.');
  if (deploymentBlock < 1n) throw new Error('V3_DEPLOYMENT_BLOCK must be a positive integer.');
  if (!Number.isSafeInteger(confirmations) || confirmations < 1)
    throw new Error('V3_CONFIRMATIONS must be at least one.');
  if (!isAddress(contractAddress) || /^0x0{40}$/i.test(contractAddress))
    throw new Error('V3_CONTRACT_ADDRESS is invalid.');
  if (!/^https:\/\//i.test(rpcUrl)) throw new Error('V3_RPC_URL must use HTTPS.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey))
    throw new Error('V3_ATTESTER_PRIVATE_KEY has invalid format.');
  const originList = required(env.V3_ALLOWED_ORIGINS, 'V3_ALLOWED_ORIGINS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    originList.length === 0 ||
    originList.some((origin) => {
      const parsed = new URL(origin);
      const localOrigin =
        parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      return parsed.origin !== origin || (parsed.protocol !== 'https:' && !localOrigin);
    })
  )
    throw new Error(
      'V3_ALLOWED_ORIGINS must contain HTTPS origins, with HTTP allowed only for loopback development.',
    );
  const origins = new Set(originList);
  const chain = defineChain({
    id: chainId,
    name: `Worldseed V3 chain ${chainId}`,
    nativeCurrency: { name: 'Native Token', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const store = new D1VerifierStore(env.WORLDSEED_DB);
  const reader = new V3ChainStateReader({
    config: {
      chain,
      rpcUrl,
      contractAddress,
      confirmations,
      deploymentBlock,
      activeRunStatus: 1,
      nowMilliseconds: Date.now,
    },
    checkpoints: store,
    client: createV3RpcClient(chain, rpcUrl),
  });
  const sessions = new WorkersWalletSessions(
    store,
    reader,
    new Map([[String(chainId), contractAddress]]),
    origins,
  );
  const verifier = new LocalVerifier(sessions, reader, store, { nowMilliseconds: Date.now });
  const signer = privateKeyToAccount(privateKey);
  const issuer = new V3AttestationIssuer(store, reader, signer, BigInt(chainId), contractAddress);
  const handler = createWorkerVerifierHandler({
    allowedOrigins: origins,
    store,
    sessions,
    verifier,
    chain: reader,
    issuer,
  });
  return { handler, origins };
}

export default {
  async fetch(request: Request, env: WorldseedWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/v3/') || url.pathname === '/health') {
      try {
        return await configured(env).handler(request);
      } catch {
        return Response.json(
          {
            code: 'VERIFIER_UNAVAILABLE',
            message: 'Verifier configuration or service is unavailable.',
          },
          {
            status: 503,
            headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
          },
        );
      }
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return Response.json(
      { code: 'NOT_FOUND', message: 'Verifier route not found.' },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  },
};
