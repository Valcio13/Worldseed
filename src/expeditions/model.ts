import { encodeAbiParameters, keccak256, stringToBytes, type Address, type Hex } from 'viem';

export const EXPEDITION_NETWORKS = {
  ethereum: {
    id: 'eip155:11155111',
    chainId: 11155111,
    name: 'Ethereum Sepolia',
    confirmations: 12,
    recentBlockWindow: 128,
  },
  hemi: {
    id: 'eip155:743111',
    chainId: 743111,
    name: 'Hemi Sepolia',
    confirmations: 12,
    recentBlockWindow: 128,
  },
  bitcoin: {
    id: 'bitcoin:testnet4',
    name: 'Bitcoin Testnet4',
    confirmations: 6,
    recentBlockWindow: 144,
  },
} as const;

// H2 candidate previews use V2 terrain generation; V1 gameplay remains separate.
export const ISLAND_GENERATOR_VERSION = 2;
export const CHARACTER_GENERATOR_VERSION = 1;
export const CANDIDATE_ATTESTATION_NAME = 'Worldseed Candidate Set';
export const CANDIDATE_ATTESTATION_VERSION = '2';
export const HEMI_TESTNET_CHAIN_ID = 743111;
export const SOURCE_SELECTION_POLICY_VERSION = 1;

export type SourceId = keyof typeof EXPEDITION_NETWORKS;

export interface SourceTransaction {
  source: SourceId;
  networkId: string;
  networkName: string;
  txHash: Hex;
  blockHash: Hex;
  blockNumber: string;
  transactionIndex: number;
  confirmations: number;
  requiredConfirmations: number;
  providerId: string;
  observedAt: number;
}

export interface IslandCandidate {
  source: SourceId;
  sourceName: string;
  seed: Hex;
  transaction: SourceTransaction;
  description: string;
}

export interface CandidateSet {
  version: 2;
  player: Address;
  expeditionNumber: number;
  candidates: [IslandCandidate, IslandCandidate, IslandCandidate];
  combinedCharacterSeed: Hex;
  sourceCommitment: Hex;
  commitment: Hex;
  issuedAt: number;
  expiresAt: number;
  islandGeneratorVersion: number;
  characterGeneratorVersion: number;
  sourceSelectionPolicyVersion: number;
  signature: Hex;
}

export interface CandidateAttestationConfig {
  hemiContractAddress: Address;
  signingPrivateKey: Hex;
  now?: () => number;
}

const SOURCE_ORDER: readonly SourceId[] = ['ethereum', 'hemi', 'bitcoin'];

export function normalizeSourceTransactions(
  transactions: Record<SourceId, SourceTransaction>,
): [SourceTransaction, SourceTransaction, SourceTransaction] {
  return SOURCE_ORDER.map((source) => transactions[source]) as [
    SourceTransaction,
    SourceTransaction,
    SourceTransaction,
  ];
}

export function deriveIslandSeed(transaction: SourceTransaction): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }],
      ['worldseed:island:v2', transaction.networkId, transaction.txHash],
    ),
  );
}

export function deriveCharacterSeed(
  transactions: [SourceTransaction, SourceTransaction, SourceTransaction],
): Hex {
  const [eth, hemi, btc] = transactions;
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'string' },
        { type: 'bytes32' },
        { type: 'string' },
        { type: 'bytes32' },
        { type: 'string' },
        { type: 'bytes32' },
      ],
      [
        'worldseed:characters:v1',
        eth.networkId,
        eth.txHash,
        hemi.networkId,
        hemi.txHash,
        btc.networkId,
        btc.txHash,
      ],
    ),
  );
}

export function deriveIslandRosterSeed(combinedCharacterSeed: Hex, selectedIslandSeed: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'bytes32' }, { type: 'bytes32' }],
      ['worldseed:roster:v1', combinedCharacterSeed, selectedIslandSeed],
    ),
  );
}

export function commitSourceTransactions(
  transactions: [SourceTransaction, SourceTransaction, SourceTransaction],
): Hex {
  const networkHashes = transactions.map(({ networkId }) =>
    keccak256(stringToBytes(networkId)),
  ) as [Hex, Hex, Hex];
  const txHashes = transactions.map(({ txHash }) => txHash) as [Hex, Hex, Hex];
  const blockHashes = transactions.map(({ blockHash }) => blockHash) as [Hex, Hex, Hex];
  const blockNumbers = transactions.map(({ blockNumber }) => BigInt(blockNumber)) as [
    bigint,
    bigint,
    bigint,
  ];
  const transactionIndices = transactions.map(({ transactionIndex }) => transactionIndex) as [
    number,
    number,
    number,
  ];
  const confirmationCounts = transactions.map(({ confirmations }) => confirmations) as [
    number,
    number,
    number,
  ];
  const requiredConfirmations = transactions.map(
    ({ requiredConfirmations: required }) => required,
  ) as [number, number, number];
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32[3]' },
        { type: 'bytes32[3]' },
        { type: 'bytes32[3]' },
        { type: 'uint64[3]' },
        { type: 'uint32[3]' },
        { type: 'uint32[3]' },
        { type: 'uint32[3]' },
      ],
      [
        networkHashes,
        txHashes,
        blockHashes,
        blockNumbers,
        transactionIndices,
        confirmationCounts,
        requiredConfirmations,
      ],
    ),
  );
}

export function describeCandidate(source: SourceId): string {
  return `${EXPEDITION_NETWORKS[source].name} transaction seed · generator ${ISLAND_GENERATOR_VERSION}`;
}

export const CANDIDATE_EIP712_TYPES = {
  CandidateSet: [
    { name: 'player', type: 'address' },
    { name: 'expeditionNumber', type: 'uint64' },
    { name: 'sourceCommitment', type: 'bytes32' },
    { name: 'candidateSeeds', type: 'bytes32[3]' },
    { name: 'combinedCharacterSeed', type: 'bytes32' },
    { name: 'islandGeneratorVersion', type: 'uint32' },
    { name: 'characterGeneratorVersion', type: 'uint32' },
    { name: 'sourceSelectionPolicyVersion', type: 'uint32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;
