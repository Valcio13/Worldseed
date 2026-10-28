import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccount, useChainId, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { useV3Settlement } from './useV3Settlement';

const mocks = vi.hoisted(() => ({
  readContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  getTransactionReceipt: vi.fn(),
  writeContractAsync: vi.fn(),
  getCheckpointAttestation: vi.fn(),
  refetchers: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useChainId: vi.fn(),
  usePublicClient: vi.fn(),
  useReadContract: vi.fn(),
  useWriteContract: vi.fn(),
}));
vi.mock('../../blockchain/config', () => ({ TARGET_CHAIN_ID: 743_111 }));
vi.mock('../config', () => ({
  v3ContractAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  v3ContractAbi: [],
  isV3Configured: () => true,
}));
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    v3Api: { getCheckpointAttestation: mocks.getCheckpointAttestation },
  };
});

const wallet = '0x1234567890123456789012345678901234567890' as const;
const otherWallet = '0x9876543210987654321098765432109876543210' as const;
const transactionHash = `0x${'12'.repeat(32)}` as `0x${string}`;
const zeroHash = `0x${'00'.repeat(32)}` as const;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.refetchers.clear();
  vi.mocked(useAccount).mockReturnValue({ address: wallet } as never);
  vi.mocked(useChainId).mockReturnValue(743_111);
  vi.mocked(usePublicClient).mockReturnValue({
    readContract: mocks.readContract,
    waitForTransactionReceipt: mocks.waitForTransactionReceipt,
    getTransactionReceipt: mocks.getTransactionReceipt,
  } as never);
  vi.mocked(useWriteContract).mockReturnValue({ writeContractAsync: mocks.writeContractAsync } as never);
  vi.mocked(useReadContract).mockImplementation(((options: { functionName?: string } | undefined) => {
    const functionName = (options as { functionName: string }).functionName;
    const data = functionName === 'activeRunId'
      ? 7n
      : functionName === 'currentSeasonId'
        ? 42n
        : functionName === 'attestationNonce'
          ? 9n
          : functionName === 'runs'
            ? [42n, 1, 123n, 0, 1, zeroHash]
            : 0n;
    let refetch = mocks.refetchers.get(functionName);
    if (!refetch) {
      refetch = vi.fn(async () => ({ data }));
      mocks.refetchers.set(functionName, refetch);
    }
    return { data, isLoading: false, refetch } as never;
  }) as never);
  mocks.readContract.mockResolvedValue([42n, 1, 123n, 0, 1, zeroHash]);
  mocks.writeContractAsync.mockResolvedValue(transactionHash);
  mocks.waitForTransactionReceipt.mockRejectedValue(
    Object.assign(new Error('Receipt wait timed out'), { name: 'TimeoutError' }),
  );
  mocks.getTransactionReceipt.mockRejectedValue(new Error('Transaction receipt not found'));
  mocks.getCheckpointAttestation.mockResolvedValue({
    attestation: {
      player: wallet,
      runId: '7',
      seasonId: '42',
      chainId: '743111',
      verifyingContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      scoreTier: 1,
      natureCollectedAtoms: '0',
      nonce: '9',
      issuedAt: '1790000000',
      expiresAt: '1790000300',
      rulesVersion: 1,
      signerEpoch: 1,
      upgradeChoicesHash: zeroHash,
      actionType: 'RECORD_POINTS',
    },
    signature: `0x${'ab'.repeat(65)}`,
    digest: zeroHash,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useV3Settlement pending receipt recovery', () => {
  it('persists an uncertain transaction and blocks a duplicate settlement submission', async () => {
    const { result } = renderHook(() => useV3Settlement('session-token'));

    await act(async () => {
      await expect(result.current.recordPoints()).rejects.toThrow(/timed out/i);
    });

    expect(result.current.status).toBe('uncertain');
    expect(result.current.canSettle).toBe(false);
    expect(JSON.parse(localStorage.getItem(`worldseed:v3:pending-settlement:${wallet}`) ?? 'null'))
      .toMatchObject({ wallet, action: 'recordPoints', transactionHash });
    await expect(result.current.recordPoints()).rejects.toThrow(/previous settlement transaction is still pending/i);
    expect(mocks.writeContractAsync).toHaveBeenCalledOnce();

    await waitFor(() => expect(mocks.getTransactionReceipt).toHaveBeenCalled());
  });

  it('clears the previous wallet transaction status when switching to a wallet without a pending settlement', async () => {
    const key = `worldseed:v3:pending-settlement:${wallet}`;
    localStorage.setItem(key, JSON.stringify({ wallet, action: 'recordPoints', transactionHash }));
    const { result, rerender } = renderHook(() => useV3Settlement('session-token'));

    expect(result.current.status).toBe('uncertain');
    vi.mocked(useAccount).mockReturnValue({ address: otherWallet } as never);
    rerender();

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.transactionHash).toBeNull();
    expect(result.current.canSettle).toBe(true);
    expect(localStorage.getItem(key)).not.toBeNull();
  });
});
