import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useChainId, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import type { Hex } from 'viem';
import { TARGET_CHAIN_ID } from '../../blockchain/config';
import {
  requireSuccessfulReceipt,
  ReplacedTransactionError,
  RevertedTransactionError,
  transactionFailureMessage,
} from '../../blockchain/transactions';
import { v3Api, V3ApiError } from '../api';
import { v3ContractAbi, v3ContractAddress, isV3Configured } from '../config';
import {
  submitV3Settlement,
  type V3SettlementAction,
  type V3SettlementExpectation,
} from '../settlement';

export type V3SettlementStatus =
  | 'idle'
  | 'requesting-attestation'
  | 'wallet-pending'
  | 'confirming'
  | 'confirmed'
  | 'failed'
  | 'uncertain';

export interface V3SettlementState {
  status: V3SettlementStatus;
  action: V3SettlementAction | null;
  transactionHash: Hex | null;
  error: string | null;
}

const initialState: V3SettlementState = {
  status: 'idle',
  action: null,
  transactionHash: null,
  error: null,
};

interface PendingSettlement {
  wallet: string;
  action: V3SettlementAction;
  transactionHash: Hex;
}

function pendingSettlementKey(wallet: string): string {
  return `worldseed:v3:pending-settlement:${wallet.toLowerCase()}`;
}

function readPendingSettlement(wallet?: string): PendingSettlement | null {
  if (!wallet || typeof window === 'undefined') return null;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(pendingSettlementKey(wallet)) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const pending = value as Partial<PendingSettlement>;
    if (
      typeof pending.wallet !== 'string' || pending.wallet.toLowerCase() !== wallet.toLowerCase() ||
      (pending.action !== 'recordPoints' && pending.action !== 'rebirth') ||
      typeof pending.transactionHash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(pending.transactionHash)
    ) return null;
    return pending as PendingSettlement;
  } catch {
    return null;
  }
}

function writePendingSettlement(pending: PendingSettlement): void {
  try {
    window.localStorage.setItem(pendingSettlementKey(pending.wallet), JSON.stringify(pending));
  } catch {
    // In-memory receipt reconciliation still prevents duplicate submissions this session.
  }
}

function clearPendingSettlement(pending: PendingSettlement): void {
  try {
    const stored = readPendingSettlement(pending.wallet);
    if (stored?.transactionHash === pending.transactionHash)
      window.localStorage.removeItem(pendingSettlementKey(pending.wallet));
  } catch {
    // A storage failure must not alter the onchain receipt result.
  }
}

/** Isolated V3 settlement hook; no component or command-queue wiring is performed here. */
export function useV3Settlement(sessionToken: string | null) {
  const account = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<V3SettlementState>(() => {
    const pending = readPendingSettlement(account.address);
    return pending
      ? {
          status: 'uncertain',
          action: pending.action,
          transactionHash: pending.transactionHash,
          error: 'Checking the previous transaction before allowing another submission.',
        }
      : initialState;
  });
  const pendingTransactionRef = useRef<PendingSettlement | null>(
    readPendingSettlement(account.address),
  );
  const executionInProgress = useRef(false);
  const enabled = Boolean(isV3Configured() && account.address && chainId === TARGET_CHAIN_ID);

  const activeRun = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'activeRunId',
    args: account.address ? [account.address] : undefined,
    query: { enabled },
  });
  const season = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'currentSeasonId',
    query: { enabled },
  });
  const nonce = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'attestationNonce',
    args: account.address ? [account.address] : undefined,
    query: { enabled },
  });
  const seasonalPP = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalPP',
    args: account.address && season.data !== undefined ? [account.address, season.data] : undefined,
    query: { enabled: enabled && season.data !== undefined },
  });
  const seasonalCP = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalCP',
    args: account.address && season.data !== undefined ? [account.address, season.data] : undefined,
    query: { enabled: enabled && season.data !== undefined },
  });
  const seasonalHighScoreTier = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalHighScoreTier',
    args: account.address && season.data !== undefined ? [account.address, season.data] : undefined,
    query: { enabled: enabled && season.data !== undefined },
  });
  const lifetimeCP = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'lifetimeCP',
    args: account.address ? [account.address] : undefined,
    query: { enabled },
  });
  const seasonRebirths = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalRebirths',
    args: account.address && season.data !== undefined ? [account.address, season.data] : undefined,
    query: { enabled: enabled && season.data !== undefined },
  });
  const upgradeLevel0 = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalUpgradeLevel',
    args:
      account.address && season.data !== undefined ? [account.address, season.data, 0] : undefined,
    query: { enabled: enabled && season.data !== undefined },
  });
  const upgradeLevel1 = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalUpgradeLevel',
    args:
      account.address && season.data !== undefined ? [account.address, season.data, 1] : undefined,
    query: { enabled: enabled && season.data !== undefined },
  });
  const upgradeLevel2 = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalUpgradeLevel',
    args:
      account.address && season.data !== undefined ? [account.address, season.data, 2] : undefined,
    query: { enabled: enabled && season.data !== undefined },
  });
  const upgradeLevel3 = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalUpgradeLevel',
    args:
      account.address && season.data !== undefined ? [account.address, season.data, 3] : undefined,
    query: { enabled: enabled && season.data !== undefined },
  });
  const run = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'runs',
    args: account.address && activeRun.data ? [account.address, activeRun.data] : undefined,
    query: { enabled: enabled && Boolean(activeRun.data && activeRun.data > 0n) },
  });

  const refetchActiveRun = activeRun.refetch;
  const refetchSeason = season.refetch;
  const refetchNonce = nonce.refetch;
  const refetchRun = run.refetch;
  const refetchSeasonalPP = seasonalPP.refetch;
  const refetchSeasonalCP = seasonalCP.refetch;
  const refetchSeasonalHighScoreTier = seasonalHighScoreTier.refetch;
  const refetchLifetimeCP = lifetimeCP.refetch;
  const refetchSeasonRebirths = seasonRebirths.refetch;
  const refetchUpgradeLevel0 = upgradeLevel0.refetch;
  const refetchUpgradeLevel1 = upgradeLevel1.refetch;
  const refetchUpgradeLevel2 = upgradeLevel2.refetch;
  const refetchUpgradeLevel3 = upgradeLevel3.refetch;
  const refresh = useCallback(async () => {
    await Promise.all([
      refetchActiveRun(),
      refetchSeason(),
      refetchNonce(),
      refetchRun(),
      refetchSeasonalPP(),
      refetchSeasonalCP(),
      refetchSeasonalHighScoreTier(),
      refetchLifetimeCP(),
      refetchSeasonRebirths(),
      refetchUpgradeLevel0(),
      refetchUpgradeLevel1(),
      refetchUpgradeLevel2(),
      refetchUpgradeLevel3(),
    ]);
  }, [
    refetchActiveRun,
    refetchSeason,
    refetchNonce,
    refetchRun,
    refetchSeasonalPP,
    refetchSeasonalCP,
    refetchSeasonalHighScoreTier,
    refetchLifetimeCP,
    refetchSeasonRebirths,
    refetchUpgradeLevel0,
    refetchUpgradeLevel1,
    refetchUpgradeLevel2,
    refetchUpgradeLevel3,
  ]);

  useEffect(() => {
    const pending = readPendingSettlement(account.address);
    pendingTransactionRef.current = pending;
    if (!pending) return;
    setState({
      status: 'uncertain',
      action: pending.action,
      transactionHash: pending.transactionHash,
      error: 'Checking the previous transaction before allowing another submission.',
    });
  }, [account.address]);

  useEffect(() => {
    const pending = pendingTransactionRef.current;
    if (
      state.status !== 'uncertain' || !pending || !publicClient ||
      pending.wallet !== account.address?.toLowerCase()
    ) return;
    let current = true;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const checkReceipt = async () => {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: pending.transactionHash });
        if (!current) return;
        clearPendingSettlement(pending);
        pendingTransactionRef.current = null;
        if (receipt.status === 'success') {
          let refreshError: string | null = null;
          try { await refresh(); } catch { refreshError = 'Transaction confirmed, but balances could not be refreshed.'; }
          if (current) setState({
            status: 'confirmed',
            action: pending.action,
            transactionHash: pending.transactionHash,
            error: refreshError,
          });
        } else {
          setState({
            status: 'failed',
            action: pending.action,
            transactionHash: pending.transactionHash,
            error: 'The previous settlement transaction reverted. You can try again.',
          });
        }
      } catch {
        if (!current) return;
        setState((previous) => ({
          ...previous,
          status: 'uncertain',
          action: pending.action,
          transactionHash: pending.transactionHash,
          error: 'The previous transaction is still awaiting confirmation. Worldseed will not submit it twice.',
        }));
        timer = globalThis.setTimeout(() => void checkReceipt(), 3_000);
      }
    };
    void checkReceipt();
    return () => {
      current = false;
      if (timer) globalThis.clearTimeout(timer);
    };
  }, [account.address, publicClient, refresh, state.status, state.transactionHash]);

  const execute = useCallback(
    async (action: V3SettlementAction): Promise<Hex> => {
      if (executionInProgress.current)
        throw new Error('A settlement transaction is already being submitted.');
      if (pendingTransactionRef.current)
        throw new Error('The previous settlement transaction is still pending. Wait for it to confirm before trying again.');
      executionInProgress.current = true;
      setState({ status: 'requesting-attestation', action, transactionHash: null, error: null });
      let submittedHash: Hex | null = null;
      let refreshFailed = false;
      let walletPromptStarted = false;
      try {
        const contractAddress = v3ContractAddress;
        if (
          !enabled ||
          !account.address ||
          !contractAddress ||
          !publicClient ||
          !writeContractAsync
        )
          throw new Error('Connect a wallet on Hemi Sepolia and configure the V3 contract first.');
        if (!sessionToken)
          throw new Error('Wallet session expired. Authenticate again to continue.');
        if (activeRun.isLoading || season.isLoading || nonce.isLoading || run.isLoading)
          throw new Error('Onchain run state is still loading. Try again shortly.');
        if (
          !activeRun.data ||
          activeRun.data === 0n ||
          !run.data ||
          season.data === undefined ||
          nonce.data === undefined
        )
          throw new Error('No active onchain run is available for settlement.');
        if (Number(run.data[1]) !== 1 || run.data[0] !== season.data)
          throw new Error('The active run is not eligible in the current season.');

        const [activeRunRead, seasonRead, nonceRead] = await Promise.all([
          refetchActiveRun(),
          refetchSeason(),
          refetchNonce(),
        ]);
        const runId = activeRunRead.data;
        const seasonId = seasonRead.data;
        const currentNonce = nonceRead.data;
        if (!runId || runId === 0n || seasonId === undefined || currentNonce === undefined)
          throw new Error('Could not refresh authoritative onchain run state. Try again.');
        const currentRun = await publicClient.readContract({
          address: contractAddress,
          abi: v3ContractAbi,
          functionName: 'runs',
          args: [account.address, runId],
        });
        if (Number(currentRun[1]) !== 1 || currentRun[0] !== seasonId)
          throw new Error('The active run is no longer eligible in the current season.');

        const expected: V3SettlementExpectation = {
          wallet: account.address,
          runId,
          seasonId,
          chainId: BigInt(TARGET_CHAIN_ID),
          verifyingContract: contractAddress,
          nonce: currentNonce,
        };
        const hash = await submitV3Settlement({
          action,
          sessionToken,
          expected,
          api: v3Api,
          write: async (method, tuple, signature) => {
            if (method === 'recordPoints')
              return writeContractAsync({
                address: contractAddress,
                abi: v3ContractAbi,
                functionName: 'recordPoints',
                args: [tuple, signature],
                chainId: TARGET_CHAIN_ID,
              });
            return writeContractAsync({
              address: contractAddress,
              abi: v3ContractAbi,
              functionName: 'rebirth',
              args: [tuple, signature],
              chainId: TARGET_CHAIN_ID,
            });
          },
          waitForReceipt: (hash) =>
            requireSuccessfulReceipt((onReplaced) =>
              publicClient.waitForTransactionReceipt({
                hash,
                onReplaced: ({ reason }) => onReplaced(reason),
              }),
            ),
          callbacks: {
            onPhase: (status) => {
              if (status === 'wallet-pending') walletPromptStarted = true;
              setState((current) => ({ ...current, status }));
            },
            onTransactionHash: (transactionHash) => {
              submittedHash = transactionHash;
              if (account.address) {
                const pending = {
                  wallet: account.address,
                  action,
                  transactionHash,
                } satisfies PendingSettlement;
                pendingTransactionRef.current = pending;
                writePendingSettlement(pending);
              }
              setState((current) => ({ ...current, transactionHash }));
            },
            onConfirmed: refresh,
            onRefreshFailed: () => {
              refreshFailed = true;
            },
          },
        });
        setState({
          status: 'confirmed',
          action,
          transactionHash: hash,
          error: refreshFailed
            ? 'Transaction confirmed, but the latest onchain balances could not be refreshed.'
            : null,
        });
        if (account.address) {
          const submitted = { wallet: account.address, action, transactionHash: hash } satisfies PendingSettlement;
          clearPendingSettlement(submitted);
          pendingTransactionRef.current = null;
        }
        return hash;
      } catch (error) {
        const terminalReceipt = error instanceof RevertedTransactionError || error instanceof ReplacedTransactionError;
        if (terminalReceipt && pendingTransactionRef.current) {
          clearPendingSettlement(pendingTransactionRef.current);
          pendingTransactionRef.current = null;
        }
        const uncertain = submittedHash !== null && !terminalReceipt;
        setState((current) => ({
          ...current,
          status: uncertain ? 'uncertain' : 'failed',
          action,
          error:
            error instanceof V3ApiError
              ? error.message
              : !walletPromptStarted && submittedHash === null && error instanceof Error
                ? error.message
                : transactionFailureMessage(
                    error,
                    action === 'recordPoints' ? 'Record Points' : 'Rebirth',
                  ),
        }));
        throw error;
      } finally {
        executionInProgress.current = false;
      }
    },
    [
      enabled,
      account.address,
      publicClient,
      writeContractAsync,
      sessionToken,
      activeRun.isLoading,
      activeRun.data,
      refetchActiveRun,
      season.isLoading,
      season.data,
      refetchSeason,
      nonce.isLoading,
      nonce.data,
      refetchNonce,
      run.isLoading,
      run.data,
      refresh,
    ],
  );

  return {
    ...state,
    canSettle: enabled && Boolean(sessionToken) && !pendingTransactionRef.current,
    seasonalPP: seasonalPP.data ?? 0n,
    seasonalCP: seasonalCP.data ?? 0n,
    seasonalHighScoreTier: Number(seasonalHighScoreTier.data ?? 0),
    lifetimeCP: lifetimeCP.data ?? 0n,
    seasonRebirths: Number(seasonRebirths.data ?? 0),
    upgradeLevels: {
      growth: Number(upgradeLevel0.data ?? 0),
      efficiency: Number(upgradeLevel1.data ?? 0),
      awakening: Number(upgradeLevel2.data ?? 0),
      rebirth: Number(upgradeLevel3.data ?? 0),
    },
    recordPoints: () => execute('recordPoints'),
    rebirth: () => execute('rebirth'),
    refresh,
  };
}
