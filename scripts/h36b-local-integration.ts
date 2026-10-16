/* eslint-disable no-undef, @typescript-eslint/no-explicit-any */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, exit } from 'node:process';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  recoverTypedDataAddress,
  type Hex,
} from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { candidateTypedData } from '../src/expeditions/issuer';

const root = process.cwd();
const temp = resolve(root, '.wrangler/h36b-runtime');
const dbName = `worldseed-h36b-local-${Date.now()}`;
const rpcUrl = 'http://127.0.0.1:8545';
const pagesUrl = 'http://127.0.0.1:8788';
const hardhatCli = resolve(root, 'node_modules/hardhat/dist/src/cli.js');
const wranglerCli = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const children: ChildProcess[] = [];
let phase = 'initialization';
let pagesLogs = '';

function start(cli: string, args: string[], output = false) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: temp,
    env: { ...env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
    stdio: output ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    windowsHide: true,
  });
  children.push(child);
  return child;
}

async function waitFor(label: string, test: () => Promise<boolean>) {
  for (let i = 0; i < 60; i += 1) {
    if (await test()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${label} did not become ready.`);
}

async function post(path: string, value: unknown) {
  const response = await fetch(`${pagesUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Pages ${path} returned HTTP ${response.status} with non-JSON content.`);
  }
  return { status: response.status, body };
}

async function issue(player: ReturnType<typeof privateKeyToAccount>, number: number) {
  const challenge = await post('/api/expedition/challenge', {
    player: player.address,
    purpose: 'issue',
    expeditionNumber: number,
  });
  if (challenge.status !== 200) throw new Error(`Challenge failed: ${challenge.status}`);
  const signature = await player.signMessage({ message: challenge.body.message });
  const issued = await post('/api/expedition/candidates', {
    player: player.address,
    challengeId: challenge.body.challengeId,
    signature,
  });
  if (issued.status !== 200)
    throw new Error(`Candidate issuance failed: ${issued.status} ${issued.body.error ?? ''}`);
  return issued.body.candidateSet;
}

async function issueWithRetry(player: ReturnType<typeof privateKeyToAccount>, number: number) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      return await issue(player, number);
    } catch (error) {
      lastError = error;
      await resetLocalRateLimit();
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Candidate issuance retries exhausted.');
}

async function select(player: ReturnType<typeof privateKeyToAccount>, set: any, source: string) {
  const challenge = await post('/api/expedition/challenge', {
    player: player.address,
    purpose: 'select',
    commitment: set.commitment,
    source,
    expeditionNumber: set.expeditionNumber,
  });
  if (challenge.status !== 200) throw new Error(`Selection challenge failed: ${challenge.status}`);
  const signature = await player.signMessage({ message: challenge.body.message });
  return post('/api/expedition/selection', {
    player: player.address,
    expeditionNumber: set.expeditionNumber,
    challengeId: challenge.body.challengeId,
    signature,
    commitment: set.commitment,
    source,
  });
}

async function resetLocalRateLimit() {
  const response = await fetch(`${pagesUrl}/api/h36b-reset`, { method: 'POST' });
  if (!response.ok) throw new Error('Local D1 rate-limit reset failed.');
}

async function main() {
  if (existsSync(temp)) throw new Error('Temporary integration directory already exists.');
  mkdirSync(temp, { recursive: true });
  cpSync(resolve(root, 'dist'), resolve(temp, 'dist'), { recursive: true });
  cpSync(resolve(root, 'functions'), resolve(temp, 'functions'), { recursive: true });
  cpSync(resolve(root, 'src/expeditions'), resolve(temp, 'src/expeditions'), { recursive: true });
  cpSync(resolve(root, 'db/migrations'), resolve(temp, 'db/migrations'), { recursive: true });
  writeFileSync(
    resolve(temp, 'functions/api/h36b-reset.ts'),
    "export async function onRequestPost({ env }: any) { await env.WORLDSEED_DB.prepare('DELETE FROM challenge_rate_limits').run(); await env.WORLDSEED_DB.prepare('DELETE FROM issuance_challenges').run(); return new Response('ok'); }\n",
    { flag: 'wx' },
  );
  writeFileSync(
    resolve(temp, 'wrangler.jsonc'),
    JSON.stringify({
      name: dbName,
      compatibility_date: '2026-10-14',
      pages_build_output_dir: './dist',
      d1_databases: [
        {
          binding: 'WORLDSEED_DB',
          database_name: dbName,
          database_id: '00000000-0000-4000-8000-000000000001',
          migrations_dir: 'db/migrations',
        },
      ],
    }),
    { flag: 'wx' },
  );
  const owner = mnemonicToAccount('test test test test test test test test test test test junk');
  const player = privateKeyToAccount(generatePrivateKey());
  const attesterKey = generatePrivateKey();
  const attester = privateKeyToAccount(attesterKey);
  const chain = defineChain({
    id: 743111,
    name: 'Disposable local Hemi test chain',
    nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
  const playerWallet = createWalletClient({ account: player, chain, transport: http(rpcUrl) });

  phase = 'starting local EVM';
  start(hardhatCli, ['node', '--chain-id', '743111', '--hostname', '127.0.0.1', '--port', '8545']);
  await waitFor(
    'local EVM',
    async () => (await publicClient.getChainId().catch(() => 0)) === 743111,
  );
  const funding = await ownerWallet.sendTransaction({
    to: player.address,
    value: parseEther('10'),
  });
  const fundingReceipt = await publicClient.waitForTransactionReceipt({ hash: funding });
  if (fundingReceipt.status !== 'success') throw new Error('Disposable player funding failed.');

  phase = 'deploying disposable V2';
  const artifact = JSON.parse(
    readFileSync(
      resolve(root, 'artifacts/contracts/WorldseedGameV2.sol/WorldseedGameV2.json'),
      'utf8',
    ),
  ) as { abi: readonly unknown[]; bytecode: Hex };
  const deployment = await ownerWallet.deployContract({
    abi: artifact.abi as never,
    bytecode: artifact.bytecode,
    args: [owner.address, attester.address],
  });
  const deployed = await publicClient.waitForTransactionReceipt({ hash: deployment });
  if (deployed.status !== 'success' || !deployed.contractAddress)
    throw new Error('V2 deployment failed.');
  const onchainAttester = await publicClient.readContract({
    address: deployed.contractAddress,
    abi: artifact.abi as never,
    functionName: 'attester',
  });
  if (String(onchainAttester).toLowerCase() !== attester.address.toLowerCase())
    throw new Error('Attester mismatch before issuance.');

  phase = 'starting isolated Pages Functions';
  const bindings = [
    `WORLDSEED_ATTESTATION_PRIVATE_KEY=${attesterKey}`,
    `WORLDSEED_V2_ATTESTER_ADDRESS=${attester.address}`,
    `WORLDSEED_V2_CONTRACT_ADDRESS=${deployed.contractAddress}`,
    'ETHEREUM_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com',
    'HEMI_SEPOLIA_RPC_URL=https://testnet.rpc.hemi.network/rpc',
    'BITCOIN_TESTNET4_API_URL=https://mempool.space/testnet4/api',
  ];
  const pages = start(
    wranglerCli,
    [
      'pages',
      'dev',
      'dist',
      '--ip',
      '127.0.0.1',
      '--port',
      '8788',
      '--log-level',
      'error',
      '--show-interactive-dev-session=false',
      ...bindings.flatMap((binding) => ['--binding', binding]),
    ],
    true,
  );
  pages.stdout?.on('data', (chunk: Buffer) => {
    pagesLogs = `${pagesLogs}${chunk.toString()}`.slice(-6000);
  });
  pages.stderr?.on('data', (chunk: Buffer) => {
    pagesLogs = `${pagesLogs}${chunk.toString()}`.slice(-6000);
  });
  await waitFor(
    'Pages Functions',
    async () =>
      await fetch(pagesUrl)
        .then((r) => r.ok)
        .catch(() => false),
  );

  phase = 'applying disposable D1 schema';
  const migration = spawnSync(
    process.execPath,
    [
      wranglerCli,
      '--config',
      resolve(temp, 'wrangler.jsonc'),
      'd1',
      'execute',
      dbName,
      '--local',
      '--command',
      'CREATE TABLE IF NOT EXISTS candidate_sets (player TEXT NOT NULL, expedition_number INTEGER NOT NULL, commitment TEXT NOT NULL, payload TEXT NOT NULL, selected_source TEXT, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (player, expedition_number)); CREATE TABLE IF NOT EXISTS issuance_challenges (id TEXT PRIMARY KEY, player TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS issuance_challenges_expiry ON issuance_challenges(expires_at); CREATE TABLE IF NOT EXISTS challenge_rate_limits (player TEXT NOT NULL, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL, PRIMARY KEY (player, window_start));',
    ],
    {
      cwd: temp,
      env: { ...env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  if (migration.status !== 0) throw new Error('D1 schema setup failed.');

  phase = 'issuing and persisting live candidates';
  const first = await issueWithRetry(player, 1);
  const [refreshA, refreshB] = await Promise.all([
    issueWithRetry(player, 1),
    issueWithRetry(player, 1),
  ]);
  if (first.commitment !== refreshA.commitment || first.commitment !== refreshB.commitment)
    throw new Error('Concurrent refresh changed candidate commitment.');
  const typed = candidateTypedData(first, deployed.contractAddress);
  const recovered = await recoverTypedDataAddress({ ...typed, signature: first.signature });
  if (recovered.toLowerCase() !== attester.address.toLowerCase())
    throw new Error('Candidate signature recovery mismatch.');
  if (
    first.candidates.some(
      (candidate: any) =>
        candidate.transaction.confirmations < candidate.transaction.requiredConfirmations,
    )
  )
    throw new Error('Candidate provenance is under-confirmed.');
  await resetLocalRateLimit();
  const selected = await select(player, first, first.candidates[0].source);
  if (selected.status !== 200) throw new Error('Selection lock failed.');
  const changed = await select(player, first, first.candidates[1].source);
  if (changed.status !== 409) throw new Error('Candidate reselection was not rejected.');
  const badWallet = privateKeyToAccount(generatePrivateKey());
  const badChallenge = await post('/api/expedition/challenge', {
    player: badWallet.address,
    purpose: 'issue',
    expeditionNumber: 1,
  });
  const wrongWallet = await post('/api/expedition/candidates', {
    player: player.address,
    challengeId: badChallenge.body.challengeId,
    signature: await badWallet.signMessage({ message: badChallenge.body.message }),
  });
  if (wrongWallet.status !== 401) throw new Error('Wrong wallet was not rejected.');

  phase = 'starting and abandoning first local expedition';
  const index = first.candidates.findIndex(
    (candidate: any) => candidate.source === first.candidates[0].source,
  );
  const candidateSet = {
    player: player.address,
    expeditionNumber: BigInt(first.expeditionNumber),
    sourceCommitment: first.sourceCommitment,
    candidateSeeds: first.candidates.map((candidate: any) => candidate.seed) as [Hex, Hex, Hex],
    combinedCharacterSeed: first.combinedCharacterSeed,
    islandGeneratorVersion: first.islandGeneratorVersion,
    characterGeneratorVersion: first.characterGeneratorVersion,
    sourceSelectionPolicyVersion: first.sourceSelectionPolicyVersion,
    issuedAt: BigInt(first.issuedAt),
    expiresAt: BigInt(first.expiresAt),
  };
  const startHash = await playerWallet.writeContract({
    address: deployed.contractAddress,
    abi: artifact.abi as never,
    functionName: 'startExpedition',
    args: [candidateSet, index, first.signature],
  });
  const startReceipt = await publicClient.waitForTransactionReceipt({ hash: startHash });
  if (startReceipt.status !== 'success') throw new Error('startExpedition reverted.');
  const state = (await publicClient.readContract({
    address: deployed.contractAddress,
    abi: artifact.abi as never,
    functionName: 'expeditionState',
    args: [player.address, 1n],
  })) as readonly unknown[];
  if (String(state[4]).toLowerCase() !== first.candidates[index].seed.toLowerCase())
    throw new Error('Onchain selected seed differs from preview.');
  const abandonHash = await playerWallet.writeContract({
    address: deployed.contractAddress,
    abi: artifact.abi as never,
    functionName: 'abandonExpedition',
    args: [1n],
  });
  const abandonReceipt = await publicClient.waitForTransactionReceipt({ hash: abandonHash });
  if (abandonReceipt.status !== 'success') throw new Error('Abandonment reverted.');

  phase = 'issuing second expedition';
  // Clear only the disposable local service's rate-limit tables; production policy is unchanged.
  await resetLocalRateLimit();
  const second = await issueWithRetry(player, 2);
  if (
    second.commitment === first.commitment ||
    second.candidates.some(
      (candidate: any, i: number) =>
        candidate.transaction.txHash === first.candidates[i].transaction.txHash,
    )
  )
    throw new Error('Second expedition reused the first candidate set.');
  const secondSelected = await select(player, second, second.candidates[0].source);
  if (secondSelected.status !== 200) throw new Error('Second selection failed.');
  const secondSet = {
    ...candidateSet,
    expeditionNumber: 2n,
    sourceCommitment: second.sourceCommitment,
    candidateSeeds: second.candidates.map((candidate: any) => candidate.seed) as [Hex, Hex, Hex],
    combinedCharacterSeed: second.combinedCharacterSeed,
    issuedAt: BigInt(second.issuedAt),
    expiresAt: BigInt(second.expiresAt),
    signature: second.signature,
  };
  const secondHash = await playerWallet.writeContract({
    address: deployed.contractAddress,
    abi: artifact.abi as never,
    functionName: 'startExpedition',
    args: [secondSet, 0, second.signature],
  });
  const secondReceipt = await publicClient.waitForTransactionReceipt({ hash: secondHash });
  if (secondReceipt.status !== 'success') throw new Error('Second start reverted.');

  console.log(
    JSON.stringify(
      {
        ok: true,
        contractAddress: deployed.contractAddress,
        deploymentTransaction: deployment,
        deploymentGasUsed: deployed.gasUsed.toString(),
        startTransaction: startHash,
        startGasUsed: startReceipt.gasUsed.toString(),
        abandonTransaction: abandonHash,
        abandonGasUsed: abandonReceipt.gasUsed.toString(),
        secondStartTransaction: secondHash,
        secondStartGasUsed: secondReceipt.gasUsed.toString(),
        attesterAddress: attester.address,
        selectedSource: first.candidates[0].source,
        candidateCommitment: first.commitment,
        secondCommitment: second.commitment,
        checks: [
          'onchain attester match',
          'live ETH/HEMI/BTC provenance',
          'D1 persistence',
          'concurrent refresh idempotency',
          'EIP-712 recovery',
          'selection lock',
          'wrong-wallet rejection',
          'seed parity',
          'abandonment',
          'new candidate set',
          'second expedition',
        ],
      },
      null,
      2,
    ),
  );
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(
    `H3.6B local integration failed during ${phase}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n${pagesLogs}`,
  );
} finally {
  for (const child of children) child.kill();
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((done) =>
          child.exitCode === null ? child.once('exit', () => done()) : done(),
        ),
    ),
  );
  if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
}
if (failed) exit(1);
