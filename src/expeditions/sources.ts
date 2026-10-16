import type { SourceId, SourceTransaction } from './model';
import { EXPEDITION_NETWORKS } from './model';
import type { Hex } from 'viem';

export interface SourceProviderConfig {
  ethereumSepoliaRpcUrl: string;
  hemiSepoliaRpcUrl: string;
  bitcoinTestnet4ApiUrl?: string;
  fetcher?: typeof fetch;
  randomUint32?: () => number;
  now?: () => number;
}

export class SourceUnavailableError extends Error {
  readonly retryable = true;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SourceUnavailableError';
  }
}

export function assertExpectedEvmChainId(source: 'ethereum' | 'hemi', chainHex: string): void {
  const expected = EXPEDITION_NETWORKS[source].chainId;
  try {
    if (BigInt(chainHex) === BigInt(expected)) return;
  } catch {
    // An invalid chain ID response is treated as an unavailable/misconfigured source.
  }
  throw new SourceUnavailableError(
    `${EXPEDITION_NETWORKS[source].name} provider has the wrong chain ID.`,
  );
}

function randomBelow(maxExclusive: number, random: () => number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0)
    throw new RangeError('Invalid random range');
  const range = 0x1_0000_0000;
  const limit = Math.floor(range / maxExclusive) * maxExclusive;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const value = random() >>> 0;
    if (value < limit) return value % maxExclusive;
  }
  throw new SourceUnavailableError('Secure source selection could not obtain unbiased randomness.');
}

function secureRandomUint32(): number {
  const value = new Uint32Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0]!;
}

async function rpc<T>(
  url: string,
  method: string,
  params: unknown[],
  fetcher: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new SourceUnavailableError('Source RPC request timed out or failed.');
  }
  if (!response.ok)
    throw new SourceUnavailableError(`Source RPC returned HTTP ${response.status}.`);
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error || body.result === undefined)
    throw new SourceUnavailableError('Source RPC returned an error or empty result.');
  return body.result;
}

export async function selectEvmSourceTransaction(
  source: 'ethereum' | 'hemi',
  url: string,
  config: SourceProviderConfig,
): Promise<SourceTransaction> {
  const fetcher = config.fetcher ?? fetch;
  const net = EXPEDITION_NETWORKS[source];
  const chainHex = await rpc<string>(url, 'eth_chainId', [], fetcher);
  assertExpectedEvmChainId(source, chainHex);
  const tipHex = await rpc<string>(url, 'eth_blockNumber', [], fetcher);
  const tip = BigInt(tipHex);
  const upper = tip - BigInt(net.confirmations);
  if (upper < 1n)
    throw new SourceUnavailableError(`${net.name} has no sufficiently confirmed blocks yet.`);
  const lower = upper - BigInt(net.recentBlockWindow - 1);
  const count = Number(upper - (lower > 1n ? lower : 1n) + 1n);
  const first =
    (lower > 1n ? lower : 1n) +
    BigInt(randomBelow(count, config.randomUint32 ?? secureRandomUint32));
  const block = await rpc<{ hash: Hex; number: string; transactions: Array<{ hash: Hex }> } | null>(
    url,
    'eth_getBlockByNumber',
    [`0x${first.toString(16)}`, true],
    fetcher,
  );
  if (!block?.hash || block.transactions.length === 0)
    throw new SourceUnavailableError(
      `${net.name} selected block has no transactions; retry issuance.`,
    );
  const txIndex = randomBelow(block.transactions.length, config.randomUint32 ?? secureRandomUint32);
  const tx = block.transactions[txIndex]!;
  const receipt = await rpc<{ status: string; blockHash: Hex; blockNumber: string } | null>(
    url,
    'eth_getTransactionReceipt',
    [tx.hash],
    fetcher,
  );
  const canonical = await rpc<{ hash: Hex } | null>(
    url,
    'eth_getBlockByNumber',
    [block.number, false],
    fetcher,
  );
  if (
    BigInt(block.number) !== first ||
    !receipt ||
    receipt.blockHash.toLowerCase() !== block.hash.toLowerCase() ||
    BigInt(receipt.blockNumber) !== BigInt(block.number) ||
    canonical?.hash.toLowerCase() !== block.hash.toLowerCase()
  )
    throw new SourceUnavailableError(
      `${net.name} selected transaction is no longer canonical; retry issuance.`,
    );
  const confirmations = Number(tip - BigInt(block.number) + 1n);
  if (confirmations < net.confirmations)
    throw new SourceUnavailableError(
      `${net.name} transaction no longer meets the confirmation policy.`,
    );
  return {
    source,
    networkId: net.id,
    networkName: net.name,
    txHash: tx.hash,
    blockHash: block.hash,
    blockNumber: BigInt(block.number).toString(),
    transactionIndex: txIndex,
    confirmations,
    requiredConfirmations: net.confirmations,
    providerId: new URL(url).host,
    observedAt: (config.now ?? Date.now)(),
  };
}

export async function selectBitcoinTransaction(
  config: SourceProviderConfig,
): Promise<SourceTransaction> {
  const base = (config.bitcoinTestnet4ApiUrl ?? 'https://mempool.space/testnet4/api').replace(
    /\/$/,
    '',
  );
  const fetcher = config.fetcher ?? fetch;
  const get = async <T>(path: string): Promise<T> => {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, { signal: AbortSignal.timeout(12_000) });
    } catch {
      throw new SourceUnavailableError('Bitcoin Testnet4 provider request timed out or failed.');
    }
    if (!response.ok)
      throw new SourceUnavailableError(
        `Bitcoin Testnet4 provider returned HTTP ${response.status}.`,
      );
    return (await response.json()) as T;
  };
  const getText = async (path: string): Promise<string> => {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, { signal: AbortSignal.timeout(12_000) });
    } catch {
      throw new SourceUnavailableError('Bitcoin Testnet4 provider request timed out or failed.');
    }
    if (!response.ok)
      throw new SourceUnavailableError(
        `Bitcoin Testnet4 provider returned HTTP ${response.status}.`,
      );
    return (await response.text()).trim();
  };
  let tip: Response;
  try {
    tip = await fetcher(`${base}/blocks/tip/height`, { signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new SourceUnavailableError('Bitcoin Testnet4 provider request timed out or failed.');
  }
  if (!tip.ok)
    throw new SourceUnavailableError(`Bitcoin Testnet4 provider returned HTTP ${tip.status}.`);
  const tipHeight = Number(await tip.text());
  const net = EXPEDITION_NETWORKS.bitcoin;
  if (!Number.isSafeInteger(tipHeight) || tipHeight < 1)
    throw new SourceUnavailableError('Bitcoin Testnet4 provider returned an invalid tip height.');
  const safeHeight = tipHeight - net.confirmations;
  if (safeHeight < 1)
    throw new SourceUnavailableError('Bitcoin Testnet4 has no sufficiently confirmed blocks yet.');
  const lowest = Math.max(1, safeHeight - net.recentBlockWindow + 1);
  const height =
    lowest + randomBelow(safeHeight - lowest + 1, config.randomUint32 ?? secureRandomUint32);
  const blockHash = await getText(`/block-height/${height}`);
  const txids = await get<string[]>(`/block/${blockHash}/txids`);
  if (txids.length < 2)
    throw new SourceUnavailableError(
      'Selected Bitcoin block has no non-coinbase transactions; retry issuance.',
    );
  const transactionIndex =
    1 + randomBelow(txids.length - 1, config.randomUint32 ?? secureRandomUint32);
  const hash = txids[transactionIndex]!;
  const block = await get<{ id: string; height: number }>(`/block/${blockHash}`);
  const canonicalHash = await getText(`/block-height/${height}`);
  if (block.id !== blockHash || block.height !== height || canonicalHash !== blockHash)
    throw new SourceUnavailableError(
      'Bitcoin Testnet4 selection is no longer canonical; retry issuance.',
    );
  return {
    source: 'bitcoin',
    networkId: net.id,
    networkName: 'Bitcoin Testnet4',
    txHash: `0x${hash}` as Hex,
    blockHash: `0x${blockHash}` as Hex,
    blockNumber: String(height),
    transactionIndex,
    confirmations: tipHeight - height + 1,
    requiredConfirmations: net.confirmations,
    providerId: new URL(base).host,
    observedAt: (config.now ?? Date.now)(),
  };
}

export async function selectSourceTransactions(
  config: SourceProviderConfig,
): Promise<Record<SourceId, SourceTransaction>> {
  const [ethereum, hemi, bitcoin] = await Promise.all([
    selectEvmSourceTransaction('ethereum', config.ethereumSepoliaRpcUrl, config),
    selectEvmSourceTransaction('hemi', config.hemiSepoliaRpcUrl, config),
    selectBitcoinTransaction(config),
  ]);
  return { ethereum, hemi, bitcoin };
}
