// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineChain } from 'viem';
import { SqliteVerifierStore } from './sqliteVerifierStore';
import { hashUpgradeChoices } from './upgradeChoices';
import { V3ChainStateReader } from './v3ChainReader';

const contract = '0x0000000000000000000000000000000000000002';
const wallet = '0x0000000000000000000000000000000000000003';
const blockHash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;
const choiceList = [{ upgradeId: 'growth' as const, quantity: 1 }];
const commitment = hashUpgradeChoices(choiceList);
const chain = defineChain({
  id: 31_337,
  name: 'Local V3',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup(
  actualChainId = 31_337,
  options: {
    head?: bigint;
    logAt?: bigint;
    failFirstLogQuery?: boolean;
    rulesVersion?: number;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'worldseed-chain-reader-'));
  directories.push(directory);
  const checkpoints = new SqliteVerifierStore(join(directory, 'reader.sqlite'));
  let failedLogQuery = false;
  const queriedRanges: Array<[bigint, bigint]> = [];
  const reorgedBlocks = new Map<number, string>();
  const fakeClient = {
    getChainId: async () => actualChainId,
    getBlockNumber: async () => options.head ?? 12n,
    getCode: async () => '0x6000',
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      hash: reorgedBlocks.get(Number(blockNumber)) ?? blockHash(Number(blockNumber)),
      parentHash: blockHash(Math.max(0, Number(blockNumber) - 1)),
      timestamp: 345_700n,
    }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'currentSeasonId') return 0;
      if (functionName === 'activeRunId') return 42n;
      if (functionName === 'runs')
        return [0n, 1, 345_700n, 0, options.rulesVersion ?? 1, commitment];
      if (functionName === 'seasonalRebirths') return 0;
      if (functionName === 'attestationNonce') return 9n;
      if (functionName === 'signerEpoch') return 2;
      if (functionName === 'seasonalPP') return 9n;
      if (functionName === 'seasonalUpgradeLevel') return 1;
      if (functionName === 'isValidSignature') return '0x1626ba7e';
      throw new Error(`Unexpected function ${functionName}`);
    },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      queriedRanges.push([fromBlock, toBlock]);
      if (options.failFirstLogQuery && !failedLogQuery) {
        failedLogQuery = true;
        throw new Error('temporary RPC failure');
      }
      const eventBlock = options.logAt ?? 10n;
      if (eventBlock < fromBlock || eventBlock > toBlock) return [];
      return [
        {
          blockNumber: eventBlock,
          blockHash: blockHash(Number(eventBlock)),
          args: {
            player: wallet,
            runId: 42n,
            seasonId: 0n,
            rulesVersion: options.rulesVersion ?? 1,
            upgradeChoicesHash: commitment,
            startedAt: 345_700n,
            upgradeChoices: [{ upgradeId: 0, quantity: 1 }],
          },
        },
      ];
    },
  };
  const reader = new V3ChainStateReader({
    config: {
      chain,
      rpcUrl: 'http://127.0.0.1:8545',
      contractAddress: contract,
      confirmations: 2,
      deploymentBlock: 10n,
      activeRunStatus: 1,
      nowMilliseconds: () => 1_000,
    },
    checkpoints,
    client: fakeClient as never,
  });
  return { reader, checkpoints, fakeClient, queriedRanges, reorgedBlocks };
}

const session = {
  wallet,
  chainId: 31_337n,
  verifyingContract: contract,
  sessionId: 's',
  runId: '42',
  origin: 'https://worldseed.example',
};

describe('confirmed V3 chain state reader', () => {
  it('reconstructs only a confirmed active run and verifies the committed upgrade array', async () => {
    const { reader, checkpoints } = setup();
    const run = await reader.getRunContext(session, '42');
    expect(run).toMatchObject({
      player: wallet,
      chainId: 31_337n,
      active: true,
      currentSeasonId: 0,
    });
    expect(run?.input).toMatchObject({
      runId: '42',
      seasonId: 0,
      startedAtMs: 345_700_000,
      seasonalPP: 10n,
      existingUpgrades: { growth: 0 },
      upgradeChoices: choiceList,
    });
    expect(checkpoints.getChainCheckpoint('31337', contract)?.blockNumber).toBe(11);
    await expect(reader.getConfirmedNonceObservation(wallet)).resolves.toMatchObject({
      chainId: '31337',
      verifyingContract: contract,
      blockNumber: 11,
      blockHash: blockHash(11),
      confirmations: 2,
      nonce: '9',
      signerEpoch: 2,
    });
    checkpoints.close();
  });

  it('preserves the rules version pinned to a V2 run for verifier recovery', async () => {
    const { reader, checkpoints } = setup(31_337, { rulesVersion: 2 });
    const context = await reader.getRunContext(session, '42');
    expect(context?.rulesVersion).toBe(2);
    checkpoints.close();
  });

  it('fails closed on wrong RPC chain ID and does not expose a run', async () => {
    const { reader, checkpoints } = setup(1);
    expect(await reader.getRunContext(session, '42')).toBeNull();
    checkpoints.close();
  });

  it('requires loopback or HTTPS RPC URLs', () => {
    const { checkpoints } = setup();
    expect(
      () =>
        new V3ChainStateReader({
          config: {
            chain,
            rpcUrl: 'http://rpc.example',
            contractAddress: contract,
            confirmations: 2,
            deploymentBlock: 10n,
            activeRunStatus: 1,
            nowMilliseconds: () => 1,
          },
          checkpoints,
        }),
    ).toThrow(/HTTPS/);
    checkpoints.close();
  });

  it('scans a large history in bounded pages and reuses the confirmed recovered event', async () => {
    const { reader, checkpoints, queriedRanges } = setup(31_337, { head: 2_507n, logAt: 2_300n });
    await expect(reader.getRunContext(session, '42')).rejects.toMatchObject({
      code: 'RECOVERY_FAILED',
    });
    await expect(reader.getRunContext(session, '42')).rejects.toMatchObject({
      code: 'RECOVERY_FAILED',
    });
    const recovered = await reader.getRunContext(session, '42');
    expect(recovered?.input.upgradeChoices).toEqual(choiceList);
    expect(queriedRanges).toEqual([
      [10n, 1_009n],
      [1_010n, 2_009n],
      [2_010n, 2_506n],
    ]);
    expect(queriedRanges.every(([from, to]) => to - from + 1n <= 1_000n)).toBe(true);
    expect(await reader.getRunContext(session, '42')).toMatchObject({ active: true });
    expect(queriedRanges).toHaveLength(3);
    checkpoints.close();
  });

  it('resumes from persisted progress after a reader restart', async () => {
    const { reader, checkpoints, fakeClient, queriedRanges } = setup(31_337, {
      head: 3_007n,
      logAt: 1_500n,
    });
    await expect(reader.getRunContext(session, '42')).rejects.toMatchObject({
      code: 'RECOVERY_FAILED',
    });
    const restarted = new V3ChainStateReader({
      config: {
        chain,
        rpcUrl: 'http://127.0.0.1:8545',
        contractAddress: contract,
        confirmations: 2,
        deploymentBlock: 10n,
        activeRunStatus: 1,
        nowMilliseconds: () => 1_000,
      },
      checkpoints,
      client: fakeClient as never,
    });
    const recovered = await restarted.getRunContext(session, '42');
    expect(recovered?.input.upgradeChoices).toEqual(choiceList);
    expect(queriedRanges).toEqual([
      [10n, 1_009n],
      [1_010n, 2_009n],
    ]);
    checkpoints.close();
  });

  it('does not advance the cursor after an RPC failure and retries the same page', async () => {
    const { reader, checkpoints, queriedRanges } = setup(31_337, { failFirstLogQuery: true });
    await expect(reader.getRunContext(session, '42')).rejects.toMatchObject({
      code: 'RECOVERY_FAILED',
    });
    const recovered = await reader.getRunContext(session, '42');
    expect(recovered?.input.upgradeChoices).toEqual(choiceList);
    expect(queriedRanges).toEqual([
      [10n, 11n],
      [10n, 11n],
    ]);
    checkpoints.close();
  });

  it('restarts a scanned page when its canonical boundary is reorganized', async () => {
    const { reader, checkpoints, queriedRanges, reorgedBlocks } = setup(31_337, {
      head: 1_201n,
      logAt: 2_000n,
    });
    await expect(reader.getRunContext(session, '42')).rejects.toMatchObject({
      code: 'RECOVERY_FAILED',
    });
    reorgedBlocks.set(1_009, `0x${'ef'.repeat(32)}`);
    await expect(reader.getRunContext(session, '42')).rejects.toMatchObject({
      code: 'RECOVERY_FAILED',
    });
    expect(queriedRanges).toEqual([
      [10n, 1_009n],
      [10n, 1_009n],
    ]);
    expect(
      (
        await checkpoints.getRunStartedEventScan({
          chainId: '31337',
          verifyingContract: contract,
          player: wallet,
          runId: '42',
          seasonId: '0',
        })
      )?.scannedBlockHash,
    ).toBe(reorgedBlocks.get(1_009));
    checkpoints.close();
  });
});
