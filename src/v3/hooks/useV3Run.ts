/**
 * V3 Run Hook
 *
 * React hook for managing V3 wallet-linked run state.
 * Implements the full flow: authenticate → request attestation → submit transaction → confirm.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAccount, useChainId, useReadContract, useWriteContract, usePublicClient } from 'wagmi';
import { v3ContractAbi, v3ContractAddress, isV3Configured } from '../config';
import { TARGET_CHAIN_ID } from '../../blockchain/config';
import { v3Api, V3ApiError, type V3StartAttestationResponse } from '../api';
import type { V3RunState, V3Run, V3UpgradeKind } from '../types';
import { requireSuccessfulReceipt } from '../../blockchain/transactions';
import { nextCpMilestoneTier } from '../cpMilestones';

const emptyRunState: V3RunState = {
  wallet: null,
  runId: 0n,
  run: null,
  seasonId: 0n,
  seasonalPP: 0n,
  seasonalCP: 0n,
  rewardRules: null,
  totalSeasonCP: null,
  maxSeasonPoints: null,
  seasonalHighScoreTier: 0,
  rebirthThresholdTier: 0,
  nextCpMilestoneTier: null,
  lifetimeCP: 0n,
  lifetimeNatureCollectedAtoms: 0n,
  totalAccumulatedRebirthScore: 0n,
  seasonalAccumulatedRebirthScore: 0n,
  seasonRebirths: 0,
  upgradeLevels: {
    growth: 0,
    efficiency: 0,
    awakening: 0,
    rebirth: 0,
  },
  loading: true,
  error: null,
  isConfigured: false,
  isCorrectChain: false,
  canAccessV3: false,
  isStarting: false,
};

function parseRunStatus(status: bigint | undefined): V3Run['status'] {
  if (!status) return 'NONE';
  const statusNum = Number(status);
  switch (statusNum) {
    case 0:
      return 'NONE';
    case 1:
      return 'ACTIVE';
    case 2:
      return 'REBORN';
    case 3:
      return 'EXPIRED';
    case 4:
      return 'ABANDONED';
    default:
      return 'NONE';
  }
}

export function useV3Run() {
  const account = useAccount();
  const chainId = useChainId();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID });

  const [state, setState] = useState<V3RunState>(emptyRunState);
  const [isStarting, setIsStarting] = useState(false);

  const isConfigured = isV3Configured();
  const isCorrectChain = chainId === TARGET_CHAIN_ID;
  const canAccessV3 = isConfigured && account.address && isCorrectChain;

  // Read active run ID
  const activeRunIdData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'activeRunId',
    args: account.address ? [account.address] : undefined,
    query: {
      enabled: canAccessV3,
    },
  });

  // Read current season
  const seasonIdData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'currentSeasonId',
    query: {
      enabled: canAccessV3,
    },
  });

  const activeRulesVersionData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'activeRulesVersion',
    query: { enabled: canAccessV3 },
  });

  // Read run details when we have an active run
  const runData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'runs',
    args:
      account.address && activeRunIdData.data ? [account.address, activeRunIdData.data] : undefined,
    query: {
      enabled: canAccessV3 && !!activeRunIdData.data && activeRunIdData.data > 0n,
    },
  });

  const hasActiveRun = Boolean(activeRunIdData.data && activeRunIdData.data > 0n);
  const displayRulesVersion =
    hasActiveRun && runData.data
      ? Number(runData.data[4])
      : activeRulesVersionData.data === undefined
        ? undefined
        : Number(activeRulesVersionData.data);
  const rewardRulesData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'rewardRules',
    args: displayRulesVersion === undefined ? undefined : [displayRulesVersion],
    query: { enabled: canAccessV3 && displayRulesVersion !== undefined },
  });

  // Read seasonal PP
  const seasonalPPData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalPP',
    args: account.address && seasonIdData.data ? [account.address, seasonIdData.data] : undefined,
    query: {
      enabled: canAccessV3 && !!seasonIdData.data,
    },
  });

  // Read seasonal CP
  const seasonalCPData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalCP',
    args: account.address && seasonIdData.data ? [account.address, seasonIdData.data] : undefined,
    query: {
      enabled: canAccessV3 && !!seasonIdData.data,
    },
  });

  const totalSeasonCPData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'totalSeasonCP',
    args: seasonIdData.data !== undefined ? [seasonIdData.data] : undefined,
    query: { enabled: canAccessV3 && seasonIdData.data !== undefined },
  });

  const maxSeasonPointsData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'MAX_SEASON_POINTS',
    query: { enabled: canAccessV3 },
  });

  const seasonalHighScoreData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalHighScoreTier',
    args:
      account.address && seasonIdData.data !== undefined
        ? [account.address, seasonIdData.data]
        : undefined,
    query: { enabled: canAccessV3 && seasonIdData.data !== undefined },
  });

  // Read lifetime CP
  const lifetimeCPData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'lifetimeCP',
    args: account.address ? [account.address] : undefined,
    query: {
      enabled: canAccessV3,
    },
  });

  // These contract getters return uint256 values, which viem decodes as bigint.
  const lifetimeNatureCollectedAtomsData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'lifetimeNatureCollectedAtoms',
    args: account.address ? [account.address] : undefined,
    query: { enabled: canAccessV3 },
  });
  const totalAccumulatedRebirthScoreData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'totalAccumulatedRebirthScore',
    args: account.address ? [account.address] : undefined,
    query: { enabled: canAccessV3 },
  });
  const seasonalAccumulatedRebirthScoreData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalAccumulatedRebirthScore',
    args:
      account.address && seasonIdData.data !== undefined
        ? [account.address, seasonIdData.data]
        : undefined,
    query: { enabled: canAccessV3 && seasonIdData.data !== undefined },
  });

  // Read season rebirths
  const seasonRebirthsData = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalRebirths',
    args: account.address && seasonIdData.data ? [account.address, seasonIdData.data] : undefined,
    query: {
      enabled: canAccessV3 && !!seasonIdData.data,
    },
  });

  const upgradeLevel0Data = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalUpgradeLevel',
    args:
      account.address && seasonIdData.data !== undefined
        ? [account.address, seasonIdData.data, 0]
        : undefined,
    query: { enabled: canAccessV3 && seasonIdData.data !== undefined },
  });
  const upgradeLevel1Data = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalUpgradeLevel',
    args:
      account.address && seasonIdData.data !== undefined
        ? [account.address, seasonIdData.data, 1]
        : undefined,
    query: { enabled: canAccessV3 && seasonIdData.data !== undefined },
  });
  const upgradeLevel2Data = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalUpgradeLevel',
    args:
      account.address && seasonIdData.data !== undefined
        ? [account.address, seasonIdData.data, 2]
        : undefined,
    query: { enabled: canAccessV3 && seasonIdData.data !== undefined },
  });
  const upgradeLevel3Data = useReadContract({
    address: v3ContractAddress,
    abi: v3ContractAbi,
    functionName: 'seasonalUpgradeLevel',
    args:
      account.address && seasonIdData.data !== undefined
        ? [account.address, seasonIdData.data, 3]
        : undefined,
    query: { enabled: canAccessV3 && seasonIdData.data !== undefined },
  });
  const upgradeLevel0 = upgradeLevel0Data.data;
  const upgradeLevel1 = upgradeLevel1Data.data;
  const upgradeLevel2 = upgradeLevel2Data.data;
  const upgradeLevel3 = upgradeLevel3Data.data;
  const upgradeLevelQueries = [
    upgradeLevel0Data,
    upgradeLevel1Data,
    upgradeLevel2Data,
    upgradeLevel3Data,
  ] as const;

  // Read upgrade levels - placeholder for contract reads

  // Update state when contract data changes
  // This effect synchronizes contract state with React state on mount and updates.
  // The setState call here is intentional - it's part of the synchronization mechanism
  // and occurs only when dependencies change, not on every render.
  useEffect(() => {
    const newState: Partial<V3RunState> = {};

    if (!canAccessV3) {
      // Reset to empty state when V3 is not accessible
      newState.wallet = account.address || null;
      newState.loading = false;
      newState.isConfigured = isConfigured;
      newState.isCorrectChain = isCorrectChain;
      newState.canAccessV3 = false;
      newState.seasonalHighScoreTier = 0;
      newState.rebirthThresholdTier = 0;
      newState.nextCpMilestoneTier = null;
      newState.lifetimeNatureCollectedAtoms = 0n;
      newState.totalAccumulatedRebirthScore = 0n;
      newState.seasonalAccumulatedRebirthScore = 0n;
    } else {
      const run: V3Run | null =
        hasActiveRun && runData.data
          ? {
              seasonId: runData.data[0],
              status: parseRunStatus(runData.data ? BigInt(runData.data[1]) : undefined),
              startedAt: runData.data[2],
              lastRecordedScoreTier: Number(runData.data[3]),
              rulesVersion: Number(runData.data[4]),
              upgradeChoicesHash: runData.data[5],
            }
          : null;

      const upgradeLevels: Record<V3UpgradeKind, number> = {
        growth: Number(upgradeLevel0 ?? 0n),
        efficiency: Number(upgradeLevel1 ?? 0n),
        awakening: Number(upgradeLevel2 ?? 0n),
        rebirth: Number(upgradeLevel3 ?? 0n),
      };

      newState.wallet = account.address || null;
      newState.runId = activeRunIdData.data || 0n;
      newState.run = run;
      newState.seasonId = seasonIdData.data || 0n;
      newState.seasonalPP = seasonalPPData.data || 0n;
      newState.seasonalCP = seasonalCPData.data || 0n;
      newState.rewardRules = rewardRulesData.data
        ? {
            rebirthThresholdTier: Number(rewardRulesData.data[0]),
            ppStep: Number(rewardRulesData.data[1]),
            ppPerRebirthCap: BigInt(rewardRulesData.data[2]),
            ppBase: BigInt(rewardRulesData.data[3]),
            seasonPPCap: BigInt(rewardRulesData.data[4]),
            seasonCPCap: BigInt(rewardRulesData.data[5]),
            cpMilestoneStep: Number(rewardRulesData.data[7]),
          }
        : null;
      newState.totalSeasonCP = totalSeasonCPData.data ?? null;
      newState.maxSeasonPoints = maxSeasonPointsData.data ?? null;
      const seasonalHighScoreTier = Number(seasonalHighScoreData.data ?? 0);
      const rebirthThresholdTier = Number(rewardRulesData.data?.[0] ?? 0);
      const cpMilestoneStep = Number(rewardRulesData.data?.[7] ?? 7);
      newState.seasonalHighScoreTier = seasonalHighScoreTier;
      newState.rebirthThresholdTier = rebirthThresholdTier;
      newState.nextCpMilestoneTier =
        rebirthThresholdTier > 0
          ? nextCpMilestoneTier(seasonalHighScoreTier, rebirthThresholdTier, cpMilestoneStep)
          : null;
      newState.lifetimeCP = lifetimeCPData.data || 0n;
      newState.lifetimeNatureCollectedAtoms = lifetimeNatureCollectedAtomsData.data ?? 0n;
      newState.totalAccumulatedRebirthScore = totalAccumulatedRebirthScoreData.data ?? 0n;
      newState.seasonalAccumulatedRebirthScore = seasonalAccumulatedRebirthScoreData.data ?? 0n;
      newState.seasonRebirths = Number(seasonRebirthsData.data || 0);
      newState.upgradeLevels = upgradeLevels;
      newState.loading =
        activeRunIdData.isLoading ||
        seasonIdData.isLoading ||
        activeRulesVersionData.isLoading ||
        rewardRulesData.isLoading ||
        seasonalHighScoreData.isLoading ||
        seasonalPPData.isLoading ||
        seasonalCPData.isLoading ||
        totalSeasonCPData.isLoading ||
        maxSeasonPointsData.isLoading ||
        lifetimeCPData.isLoading;
      newState.loading ||= lifetimeNatureCollectedAtomsData.isLoading ||
        totalAccumulatedRebirthScoreData.isLoading ||
        seasonalAccumulatedRebirthScoreData.isLoading;
      newState.error = activeRunIdData.error?.message || null;
      newState.isConfigured = isConfigured;
      newState.isCorrectChain = isCorrectChain;
      newState.canAccessV3 = true;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((prev) => ({
      ...prev,
      ...newState,
    }));
  }, [
    canAccessV3,
    account.address,
    activeRunIdData.data,
    hasActiveRun,
    activeRunIdData.isLoading,
    activeRunIdData.error,
    runData.data,
    runData.isLoading,
    activeRulesVersionData.data,
    activeRulesVersionData.isLoading,
    rewardRulesData.data,
    rewardRulesData.isLoading,
    seasonIdData.data,
    seasonIdData.isLoading,
    seasonalPPData.data,
    seasonalPPData.isLoading,
    seasonalCPData.data,
    seasonalCPData.isLoading,
    totalSeasonCPData.data,
    totalSeasonCPData.isLoading,
    maxSeasonPointsData.data,
    maxSeasonPointsData.isLoading,
    seasonalHighScoreData.data,
    seasonalHighScoreData.isLoading,
    lifetimeCPData.data,
    lifetimeCPData.isLoading,
    lifetimeNatureCollectedAtomsData.data,
    lifetimeNatureCollectedAtomsData.isLoading,
    totalAccumulatedRebirthScoreData.data,
    totalAccumulatedRebirthScoreData.isLoading,
    seasonalAccumulatedRebirthScoreData.data,
    seasonalAccumulatedRebirthScoreData.isLoading,
    seasonRebirthsData.data,
    upgradeLevel0,
    upgradeLevel1,
    upgradeLevel2,
    upgradeLevel3,
    isConfigured,
    isCorrectChain,
  ]);

  const startRun = useCallback(
    async (
      sessionToken: string,
      upgradeChoices: Array<{ upgradeId: number; quantity: number }>,
    ) => {
      if (!account.address || !v3ContractAddress || !publicClient || !writeContractAsync) {
        throw new Error('Wallet not connected or V3 not configured');
      }

      if (!sessionToken) {
        throw new Error('Not authenticated. Please authenticate first.');
      }
      if (upgradeChoices.some(({ upgradeId }) => upgradeId === 3)) {
        throw new Error('The Rebirth PP upgrade is disabled because it has no verified benefit.');
      }

      setIsStarting(true);
      try {
        // Step 1: Request attestation from verifier
        let attestation: V3StartAttestationResponse;
        try {
          attestation = await v3Api.getStartAttestation(
            '0', // runId not needed in the path but kept for API compatibility
            {
              upgradeChoices: upgradeChoices.map((uc) => ({
                upgradeId:
                  uc.upgradeId === 0
                    ? 'growth'
                    : uc.upgradeId === 1
                      ? 'efficiency'
                      : uc.upgradeId === 2
                        ? 'awakening'
                        : 'rebirth',
                quantity: uc.quantity,
              })),
            },
            sessionToken,
          );
        } catch (err) {
          if (err instanceof V3ApiError) {
            if (err.code === 'UNAUTHENTICATED') {
              throw new Error('Session expired. Please authenticate again.', { cause: err });
            }
            throw new Error(err.message, { cause: err });
          }
          throw err;
        }

        // Step 2: Convert attestation to contract tuple format
        // ScoreAttestation tuple includes the signed cumulative Nature atom total after scoreTier.
        // actionType: START_RUN = 1, RECORD_POINTS = 2, REBIRTH = 3
        const actionTypeMap = {
          START_RUN: 1,
          RECORD_POINTS: 2,
          REBIRTH: 3,
        };

        const attestationTuple = [
          attestation.attestation.player,
          BigInt(attestation.attestation.runId),
          BigInt(attestation.attestation.seasonId),
          BigInt(attestation.attestation.chainId),
          attestation.attestation.verifyingContract,
          attestation.attestation.scoreTier,
          BigInt(attestation.attestation.natureCollectedAtoms),
          BigInt(attestation.attestation.nonce),
          BigInt(attestation.attestation.issuedAt),
          BigInt(attestation.attestation.expiresAt),
          attestation.attestation.rulesVersion,
          attestation.attestation.signerEpoch,
          attestation.attestation.upgradeChoicesHash,
          actionTypeMap[attestation.attestation.actionType],
        ] as const;

        // Step 3: Submit transaction
        const upgradeChoicesTuple = attestation.upgradeChoices.map(
          (u: { upgradeId: number; quantity: number }) => [u.upgradeId, u.quantity] as const,
        );

        const hash = await writeContractAsync({
          address: v3ContractAddress,
          abi: v3ContractAbi,
          functionName: 'startRun',
          args: [attestationTuple, upgradeChoicesTuple, attestation.signature],
          chainId: TARGET_CHAIN_ID,
        });

        // Step 4: Wait for confirmation
        await requireSuccessfulReceipt((onReplaced) =>
          publicClient.waitForTransactionReceipt({
            hash,
            onReplaced: ({ reason }) => onReplaced(reason),
          }),
        );

        // Step 5: Refresh contract data
        // The successful receipt is authoritative. A temporary follow-up read must
        // not turn a confirmed run into a UI-reported transaction failure.
        await Promise.allSettled([activeRunIdData.refetch(), seasonIdData.refetch()]);

        return hash;
      } finally {
        setIsStarting(false);
      }
    },
    [account.address, publicClient, writeContractAsync, activeRunIdData, seasonIdData],
  );

  const abandonRun = useCallback(
    async (runId: bigint) => {
      if (!account.address || !v3ContractAddress || !publicClient || !writeContractAsync) {
        throw new Error('Wallet not connected or V3 not configured');
      }

      const hash = await writeContractAsync({
        address: v3ContractAddress,
        abi: v3ContractAbi,
        functionName: 'abandonRun',
        args: [runId],
        chainId: TARGET_CHAIN_ID,
      });

      await requireSuccessfulReceipt((onReplaced) =>
        publicClient.waitForTransactionReceipt({
          hash,
          onReplaced: ({ reason }) => onReplaced(reason),
        }),
      );

      await activeRunIdData.refetch();
      return hash;
    },
    [account.address, publicClient, writeContractAsync, activeRunIdData],
  );

  return {
    ...state,
    isConfigured,
    isCorrectChain,
    canAccessV3,
    isStarting,
    startRun,
    abandonRun,
    refetch: () =>
      Promise.all([
        activeRunIdData.refetch(),
        seasonIdData.refetch(),
        activeRulesVersionData.refetch(),
        runData.refetch(),
        rewardRulesData.refetch(),
        seasonalPPData.refetch(),
        seasonalCPData.refetch(),
        totalSeasonCPData.refetch(),
        maxSeasonPointsData.refetch(),
        seasonalHighScoreData.refetch(),
        lifetimeCPData.refetch(),
        lifetimeNatureCollectedAtomsData.refetch(),
        totalAccumulatedRebirthScoreData.refetch(),
        seasonalAccumulatedRebirthScoreData.refetch(),
        seasonRebirthsData.refetch(),
        ...upgradeLevelQueries.map((query) => query.refetch()),
      ]),
  };
}

export type { V3RunState } from '../types';
