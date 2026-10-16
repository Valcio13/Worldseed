import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, type Address, type Hex } from 'viem';
import {
  CANDIDATE_ATTESTATION_NAME,
  CANDIDATE_ATTESTATION_VERSION,
  CANDIDATE_EIP712_TYPES,
  CHARACTER_GENERATOR_VERSION,
  EXPEDITION_NETWORKS,
  ISLAND_GENERATOR_VERSION,
  SOURCE_SELECTION_POLICY_VERSION,
  commitSourceTransactions,
  deriveCharacterSeed,
  deriveIslandSeed,
  describeCandidate,
  normalizeSourceTransactions,
  type CandidateSet,
  type SourceId,
  type SourceTransaction,
} from './model';

export interface IssueCandidateInput {
  player: Address;
  expeditionNumber: number;
  sourceTransactions: Record<SourceId, SourceTransaction>;
  hemiContractAddress: Address;
  signingPrivateKey: Hex;
  now?: () => number;
  expiresInSeconds?: number;
}

export function candidateTypedData(set: Omit<CandidateSet, 'signature'>, contractAddress: Address) {
  return {
    domain: {
      name: CANDIDATE_ATTESTATION_NAME,
      version: CANDIDATE_ATTESTATION_VERSION,
      chainId: 743111,
      verifyingContract: contractAddress,
    },
    types: CANDIDATE_EIP712_TYPES,
    primaryType: 'CandidateSet' as const,
    message: {
      player: set.player,
      expeditionNumber: BigInt(set.expeditionNumber),
      sourceCommitment: set.sourceCommitment,
      candidateSeeds: set.candidates.map(({ seed }) => seed) as [Hex, Hex, Hex],
      combinedCharacterSeed: set.combinedCharacterSeed,
      islandGeneratorVersion: set.islandGeneratorVersion,
      characterGeneratorVersion: set.characterGeneratorVersion,
      sourceSelectionPolicyVersion: set.sourceSelectionPolicyVersion,
      issuedAt: BigInt(set.issuedAt),
      expiresAt: BigInt(set.expiresAt),
    },
  };
}

export async function issueCandidateSet(input: IssueCandidateInput): Promise<CandidateSet> {
  if (!Number.isSafeInteger(input.expeditionNumber) || input.expeditionNumber < 1)
    throw new Error('Expedition number must be a positive uint64.');
  const expiresInSeconds = input.expiresInSeconds ?? 7 * 24 * 60 * 60;
  if (
    !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds < 1 ||
    expiresInSeconds > 7 * 24 * 60 * 60
  )
    throw new Error('Candidate expiry must be between one second and seven days.');
  const now = Math.floor((input.now ?? Date.now)() / 1000);
  const transactions = normalizeSourceTransactions(input.sourceTransactions);
  for (const transaction of transactions) {
    const network = EXPEDITION_NETWORKS[transaction.source];
    if (
      transaction.networkId !== network.id ||
      transaction.requiredConfirmations !== network.confirmations ||
      transaction.confirmations < network.confirmations ||
      !/^0x[0-9a-fA-F]{64}$/.test(transaction.txHash) ||
      !/^0x[0-9a-fA-F]{64}$/.test(transaction.blockHash)
    ) {
      throw new Error(
        `Invalid or insufficiently confirmed ${network.name} transaction provenance.`,
      );
    }
  }
  const unsigned = {
    version: 2 as const,
    player: input.player,
    expeditionNumber: input.expeditionNumber,
    candidates: transactions.map((transaction) => ({
      source: transaction.source,
      sourceName: transaction.networkName,
      seed: deriveIslandSeed(transaction),
      transaction,
      description: describeCandidate(transaction.source),
    })) as CandidateSet['candidates'],
    combinedCharacterSeed: deriveCharacterSeed(transactions),
    sourceCommitment: commitSourceTransactions(transactions),
    commitment: `0x${'00'.repeat(32)}` as Hex,
    issuedAt: now,
    // The V2 contract rejects stale attestations after seven days.
    expiresAt: now + expiresInSeconds,
    islandGeneratorVersion: ISLAND_GENERATOR_VERSION,
    characterGeneratorVersion: CHARACTER_GENERATOR_VERSION,
    sourceSelectionPolicyVersion: SOURCE_SELECTION_POLICY_VERSION,
  };
  const commitment = hashTypedData(candidateTypedData(unsigned, input.hemiContractAddress));
  const signature = await privateKeyToAccount(input.signingPrivateKey).signTypedData(
    candidateTypedData({ ...unsigned, commitment }, input.hemiContractAddress),
  );
  return { ...unsigned, commitment, signature };
}
