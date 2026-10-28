import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStartRunFlow } from './useStartRunFlow';

const { useAccountMock, useChainIdMock, useReadContractMock, refetchMock } = vi.hoisted(() => ({
  useAccountMock: vi.fn(),
  useChainIdMock: vi.fn(),
  useReadContractMock: vi.fn(),
  refetchMock: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: useAccountMock,
  useChainId: useChainIdMock,
  useReadContract: useReadContractMock,
}));

vi.mock('../config', () => ({
  v3ContractAbi: [],
  v3ContractAddress: '0x1234567890123456789012345678901234567890',
  isV3Configured: () => true,
}));

vi.mock('../../blockchain/config', () => ({ TARGET_CHAIN_ID: 743111 }));

describe('useStartRunFlow integration', () => {
  beforeEach(() => {
    useAccountMock.mockReturnValue({ address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' });
    useChainIdMock.mockReturnValue(743111);
    useReadContractMock.mockReturnValue({ data: 0n, refetch: refetchMock });
    refetchMock.mockReset().mockResolvedValue({ data: 1n });
  });

  it('allows the first run when the contract counter is zero and confirms after the transaction callback', async () => {
    const onStartRun = vi.fn().mockResolvedValue(`0x${'12'.repeat(32)}`);
    const { result } = renderHook(() =>
      useStartRunFlow({
        onAuthRequired: async () => 'session-for-run-1',
        onStartRun,
      }),
    );

    expect(result.current.nextRunId).toBe(1n);

    let started = false;
    await act(async () => {
      started = await result.current.start([]);
    });

    expect(started).toBe(true);
    expect(onStartRun).toHaveBeenCalledOnce();
    expect(onStartRun).toHaveBeenCalledWith('session-for-run-1', []);
    expect(refetchMock).toHaveBeenCalledOnce();
    expect(result.current.state.status).toBe('success');
    expect(result.current.state.transactionHash).toBe(`0x${'12'.repeat(32)}`);
  });
});
