import { describe, expect, it } from 'vitest';
import {
  assertExpectedEvmChainId,
  selectEvmSourceTransaction,
  selectBitcoinTransaction,
  SourceUnavailableError,
} from './sources';

describe('source network guards', () => {
  it('rejects a provider that is not the configured Ethereum Sepolia chain', async () => {
    expect(() => assertExpectedEvmChainId('ethereum', '0x1')).toThrow(SourceUnavailableError);
    expect(() => assertExpectedEvmChainId('hemi', '0x1')).toThrow(SourceUnavailableError);
    expect(() => assertExpectedEvmChainId('hemi', '0xb56c7')).not.toThrow();
  });

  it('converts RPC throttling and request timeouts into retryable safe errors', async () => {
    const throttled = await selectEvmSourceTransaction('ethereum', 'https://secret.example/rpc', {
      ethereumSepoliaRpcUrl: 'https://secret.example/rpc',
      hemiSepoliaRpcUrl: 'https://unused.example',
      fetcher: async () => new Response('rate limited', { status: 429 }),
    }).catch((error: unknown) => error);
    expect(throttled).toBeInstanceOf(SourceUnavailableError);
    expect((throttled as Error).message).toContain('HTTP 429');
    expect((throttled as Error).message).not.toContain('secret.example');

    let timeoutSignalAttached = false;
    const timedOut = await selectEvmSourceTransaction('hemi', 'https://hemi.example/rpc', {
      ethereumSepoliaRpcUrl: 'https://unused.example',
      hemiSepoliaRpcUrl: 'https://hemi.example/rpc',
      fetcher: async (_input, init) => {
        timeoutSignalAttached = init?.signal instanceof AbortSignal;
        throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      },
    }).catch((error: unknown) => error);
    expect(timeoutSignalAttached).toBe(true);
    expect(timedOut).toBeInstanceOf(SourceUnavailableError);
    expect((timedOut as Error).message).not.toContain('hemi.example');
  });

  it('does not expose provider-supplied RPC error text', async () => {
    const failure = await selectEvmSourceTransaction('ethereum', 'https://rpc.example/key-secret', {
      ethereumSepoliaRpcUrl: 'https://rpc.example/key-secret',
      hemiSepoliaRpcUrl: 'https://unused.example',
      fetcher: async () =>
        Response.json({ jsonrpc: '2.0', id: 1, error: { message: 'denied key-secret' } }),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SourceUnavailableError);
    expect((failure as Error).message).not.toContain('key-secret');
  });

  it('selects a canonical confirmed Sepolia transaction and records its provenance', async () => {
    const blockHash = `0x${'11'.repeat(32)}` as const;
    const txHash = `0x${'22'.repeat(32)}` as const;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      let result: unknown;
      switch (request.method) {
        case 'eth_chainId':
          result = '0xaa36a7';
          break;
        case 'eth_blockNumber':
          result = '0x100';
          break;
        case 'eth_getBlockByNumber':
          result =
            request.params[1] === true
              ? { hash: blockHash, number: request.params[0], transactions: [{ hash: txHash }] }
              : { hash: blockHash };
          break;
        case 'eth_getTransactionReceipt':
          result = { status: '0x1', blockHash, blockNumber: '0x75' };
          break;
        default:
          throw new Error(`Unexpected RPC method ${request.method}`);
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result });
    };
    const transaction = await selectEvmSourceTransaction('ethereum', 'https://rpc.example', {
      ethereumSepoliaRpcUrl: 'https://rpc.example',
      hemiSepoliaRpcUrl: 'https://unused.example',
      fetcher,
      randomUint32: () => 0,
      now: () => 50,
    });
    expect(transaction.txHash).toBe(txHash);
    expect(transaction.networkId).toBe('eip155:11155111');
    expect(transaction.confirmations).toBeGreaterThanOrEqual(12);
    expect(transaction.requiredConfirmations).toBe(12);
    expect(transaction.blockHash).toBe(blockHash);
  });

  it('uses Bitcoin Testnet4 raw height responses and excludes coinbase from selection', async () => {
    const blockHash = 'aa'.repeat(32);
    const txid = 'bb'.repeat(32);
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/blocks/tip/height')) return new Response('1000');
      if (path.endsWith('/block-height/851')) return new Response(blockHash);
      if (path.endsWith(`/block/${blockHash}/txids`)) return Response.json(['00'.repeat(32), txid]);
      if (path.endsWith(`/block/${blockHash}`))
        return Response.json({ id: blockHash, height: 851 });
      throw new Error(`Unexpected Testnet4 endpoint ${path}`);
    };
    const transaction = await selectBitcoinTransaction({
      ethereumSepoliaRpcUrl: 'https://unused.example',
      hemiSepoliaRpcUrl: 'https://unused.example',
      bitcoinTestnet4ApiUrl: 'https://mempool.example/testnet4/api',
      fetcher,
      randomUint32: () => 0,
      now: () => 75,
    });
    expect(transaction.source).toBe('bitcoin');
    expect(transaction.txHash).toBe(`0x${txid}`);
    expect(transaction.transactionIndex).toBe(1);
    expect(transaction.networkId).toBe('bitcoin:testnet4');
    expect(transaction.confirmations).toBeGreaterThanOrEqual(6);
  });
});
