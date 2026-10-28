import {
  createPublicClient,
  http,
  isAddress,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  ppUpgradeCost,
  seasonIdAtMilliseconds,
  type UpgradeChoice,
  type UpgradeLevels,
} from '../rulesV1';
import type { CanonicalRunInput } from '../versionedRules';
import type { AuthenticatedWalletSession } from '../verifierProtocol';
import type { RunAuthorityReader } from '../localVerifier';
import { hashUpgradeChoices, SOLIDITY_UPGRADE_IDS } from './upgradeChoices';
import type {
  ChainCheckpoint,
  ConfirmedNonceObservation,
  RunStartedEventScanKey,
  RunStartedEventStore,
} from './verifierStoreTypes';
import type { ChainCheckpointStore } from './verifierStoreTypes';
import { VerifierError } from '../verifierProtocol';

/** Proposed V3 ABI. Keep synchronized with the reviewed design and add Solidity tests before deployment. */
export const V3_READ_ABI = parseAbi([
  'function currentSeasonId() view returns (uint64)',
  'function activeRunId(address player) view returns (uint64)',
  'function runs(address player, uint64 runId) view returns (uint64 seasonId, uint8 status, uint64 startedAt, uint16 lastRecordedScoreTier, uint32 rulesVersion, bytes32 upgradeChoicesHash)',
  'function seasonalPP(address player, uint64 seasonId) view returns (uint256)',
  'function lifetimeNatureCollectedAtoms(address player) view returns (uint256)',
  'function totalAccumulatedRebirthScore(address player) view returns (uint256)',
  'function seasonalAccumulatedRebirthScore(address player, uint64 seasonId) view returns (uint256)',
  'function seasonalHighScoreTier(address player, uint64 seasonId) view returns (uint16)',
  'function seasonalRebirths(address player, uint64 seasonId) view returns (uint32)',
  'function seasonalUpgradeLevel(address player, uint64 seasonId, uint8 upgradeId) view returns (uint16)',
  'function nextRunId(address player) view returns (uint64)',
  'function activeRulesVersion() view returns (uint32)',
  'function attester() view returns (address)',
  'function rewardRules(uint32 version) view returns (uint16 rebirthThresholdTier, uint16 ppStep, uint16 ppPerRebirthCap, uint32 ppBase, uint32 seasonPPCap, uint32 seasonCPCap, uint16 maxUpgradeLevel, uint16 cpMilestoneStep)',
  'function attestationNonce(address player) view returns (uint64)',
  'function signerEpoch() view returns (uint32)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);
export const V3_RUN_STARTED_ABI = parseAbi([
  'event RunStarted(address indexed player, uint64 indexed runId, uint64 indexed seasonId, uint32 rulesVersion, bytes32 upgradeChoicesHash, uint64 startedAt, (uint8 upgradeId, uint16 quantity)[] upgradeChoices)',
]);

const UPGRADE_BY_ID = new Map<number, UpgradeChoice['upgradeId']>(
  Object.entries(SOLIDITY_UPGRADE_IDS).map(([name, id]) => [
    id,
    name as UpgradeChoice['upgradeId'],
  ]),
);
const IERC1271_MAGIC = '0x1626ba7e';

export interface V3ChainReaderConfig {
  chain: Chain;
  rpcUrl: string;
  contractAddress: Address;
  confirmations: number;
  deploymentBlock: bigint;
  activeRunStatus: number;
  nowMilliseconds: () => number;
}

export interface V3ChainStateReaderOptions {
  config: V3ChainReaderConfig;
  checkpoints: ChainCheckpointStore & RunStartedEventStore;
  client?: PublicClient;
}

const RUN_STARTED_LOOKUP_CHUNK_BLOCKS = 1_000n;
const RUN_STARTED_RECENT_LOOKUP_BLOCKS = 1_000n;

interface PersistedRunStartedEvent {
  player: string;
  runId: string;
  seasonId: string;
  rulesVersion: number;
  upgradeChoicesHash: string;
  startedAt: string;
  upgradeChoices: Array<{ upgradeId: number; quantity: number }>;
}

function validateRunStartedScan(
  scan: Awaited<ReturnType<RunStartedEventStore['getRunStartedEventScan']>>,
  deploymentBlock: number,
): asserts scan is NonNullable<typeof scan> {
  if (
    !scan ||
    !Number.isSafeInteger(scan.nextBlock) ||
    !Number.isSafeInteger(scan.scannedThrough) ||
    scan.nextBlock < deploymentBlock ||
    scan.scannedThrough < deploymentBlock - 1 ||
    scan.nextBlock !== scan.scannedThrough + 1
  )
    throw new VerifierError('RECOVERY_FAILED', 'Stored RunStarted scan cursor is invalid.');
  const hasEvent = scan.eventJson !== null;
  if (
    hasEvent !== (scan.eventBlockNumber !== null && scan.eventBlockHash !== null) ||
    (hasEvent &&
      (!Number.isSafeInteger(scan.eventBlockNumber) ||
        scan.eventBlockNumber! < deploymentBlock ||
        scan.eventBlockNumber! > scan.scannedThrough ||
        !/^0x[0-9a-fA-F]{64}$/.test(scan.eventBlockHash!))) ||
    (scan.scannedThrough >= deploymentBlock && scan.scannedBlockHash === null) ||
    (scan.scannedThrough === deploymentBlock - 1 && scan.scannedBlockHash !== null) ||
    (scan.scannedBlockHash !== null && !/^0x[0-9a-fA-F]{64}$/.test(scan.scannedBlockHash))
  )
    throw new VerifierError('RECOVERY_FAILED', 'Stored RunStarted event checkpoint is invalid.');
}

export interface V3StartRunContext {
  runId: bigint;
  seasonId: bigint;
  rulesVersion: number;
  nonce: bigint;
  signerEpoch: number;
  seasonalPP: bigint;
  seasonRebirths: number;
  upgradeLevels: UpgradeLevels;
}

export interface V3RunSettlementContext {
  lastRecordedScoreTier: number;
  rulesVersion: number;
  rebirthThresholdTier: number;
}

function assertAddress(value: string, label: string): asserts value is Address {
  if (!isAddress(value)) throw new Error(`${label} is not an address.`);
}

function asSafeNumber(value: bigint | number, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`${label} exceeds the supported range.`);
  return number;
}

function toCanonicalChoices(
  raw: readonly { upgradeId: number; quantity: number }[],
): UpgradeChoice[] {
  const choices = raw.map(({ upgradeId, quantity }) => {
    const name = UPGRADE_BY_ID.get(upgradeId);
    if (!name || !Number.isSafeInteger(quantity) || quantity <= 0)
      throw new Error('Confirmed run event contains an invalid upgrade choice.');
    return { upgradeId: name, quantity };
  });
  // hashUpgradeChoices also verifies canonical ordering and uniqueness.
  return choices;
}

/** Reads only confirmation-safe chain state. Any provider disagreement or reorg fails closed. */
export class V3ChainStateReader implements RunAuthorityReader {
  private readonly client: PublicClient;
  private readonly config: V3ChainReaderConfig;
  private readonly checkpoints: ChainCheckpointStore & RunStartedEventStore;

  constructor(options: V3ChainStateReaderOptions) {
    this.config = options.config;
    this.checkpoints = options.checkpoints;
    if (
      !/^https:\/\//i.test(this.config.rpcUrl) &&
      !/^http:\/\/127\.0\.0\.1(?::|\/)/i.test(this.config.rpcUrl)
    )
      throw new Error('RPC URL must use HTTPS except for loopback local development.');
    if (!Number.isSafeInteger(this.config.confirmations) || this.config.confirmations < 1)
      throw new Error('At least one confirmation is required.');
    if (
      !Number.isSafeInteger(this.config.activeRunStatus) ||
      this.config.activeRunStatus < 0 ||
      this.config.activeRunStatus > 255
    )
      throw new Error('Active run status must be an explicit uint8 contract enum value.');
    if (this.config.deploymentBlock < 1n) throw new Error('Deployment block must be positive.');
    this.client =
      options.client ??
      createPublicClient({ chain: this.config.chain, transport: http(this.config.rpcUrl) });
  }

  async getStartRunContext(wallet: string): Promise<V3StartRunContext> {
    assertAddress(wallet, 'Wallet');
    const blockNumber = await this.confirmedBlockNumber();
    await this.assertContractAndReconcile(blockNumber);
    const [seasonId, activeRunId, nextRunId, rulesVersion, nonce, signerEpoch, block] =
      await Promise.all([
        this.client.readContract({
          address: this.config.contractAddress,
          abi: V3_READ_ABI,
          functionName: 'currentSeasonId',
          blockNumber,
        }),
        this.client.readContract({
          address: this.config.contractAddress,
          abi: V3_READ_ABI,
          functionName: 'activeRunId',
          args: [wallet as Address],
          blockNumber,
        }),
        this.client.readContract({
          address: this.config.contractAddress,
          abi: V3_READ_ABI,
          functionName: 'nextRunId',
          args: [wallet as Address],
          blockNumber,
        }),
        this.client.readContract({
          address: this.config.contractAddress,
          abi: V3_READ_ABI,
          functionName: 'activeRulesVersion',
          blockNumber,
        }),
        this.client.readContract({
          address: this.config.contractAddress,
          abi: V3_READ_ABI,
          functionName: 'attestationNonce',
          args: [wallet as Address],
          blockNumber,
        }),
        this.client.readContract({
          address: this.config.contractAddress,
          abi: V3_READ_ABI,
          functionName: 'signerEpoch',
          blockNumber,
        }),
        this.client.getBlock({ blockNumber }),
      ]);
    const seasonNumber = asSafeNumber(seasonId, 'Current season ID');
    const rulesNumber = asSafeNumber(rulesVersion, 'Active rules version');
    if (rulesNumber !== 1 && rulesNumber !== 2 && rulesNumber !== 3)
      throw new Error('No deterministic verifier rules are installed for this rules version.');
    if (nextRunId >= (1n << 64n) - 1n) throw new Error('Contract run ID space is exhausted.');
    if (
      seasonIdAtMilliseconds(asSafeNumber(block.timestamp * 1_000n, 'Confirmed chain time')) !==
      seasonNumber
    )
      throw new Error('Current chain timestamp and season ID disagree.');
    if (activeRunId !== 0n) {
      const active = await this.client.readContract({
        address: this.config.contractAddress,
        abi: V3_READ_ABI,
        functionName: 'runs',
        args: [wallet as Address, activeRunId],
        blockNumber,
      });
      if (active[1] !== this.config.activeRunStatus || active[0] === seasonId)
        throw new Error('Wallet already has a current active run.');
    }
    const [pp, rebirths, ...levels] = await Promise.all([
      this.client.readContract({
        address: this.config.contractAddress,
        abi: V3_READ_ABI,
        functionName: 'seasonalPP',
        args: [wallet as Address, seasonId],
        blockNumber,
      }),
      this.client.readContract({
        address: this.config.contractAddress,
        abi: V3_READ_ABI,
        functionName: 'seasonalRebirths',
        args: [wallet as Address, seasonId],
        blockNumber,
      }),
      ...[0, 1, 2, 3].map((id) =>
        this.client.readContract({
          address: this.config.contractAddress,
          abi: V3_READ_ABI,
          functionName: 'seasonalUpgradeLevel',
          args: [wallet as Address, seasonId, id],
          blockNumber,
        }),
      ),
    ]);
    const finalBlock = await this.client.getBlock({ blockNumber });
    if (finalBlock.hash?.toLowerCase() !== block.hash?.toLowerCase())
      throw new Error('Confirmed chain block changed during Start Run state read.');
    return {
      runId: nextRunId + 1n,
      seasonId,
      rulesVersion: rulesNumber,
      nonce,
      signerEpoch: asSafeNumber(signerEpoch, 'Signer epoch'),
      seasonalPP: pp,
      seasonRebirths: asSafeNumber(rebirths, 'Season rebirth count'),
      upgradeLevels: {
        growth: asSafeNumber(levels[0]!, 'Growth level'),
        efficiency: asSafeNumber(levels[1]!, 'Efficiency level'),
        awakening: asSafeNumber(levels[2]!, 'Awakening level'),
        rebirth: asSafeNumber(levels[3]!, 'Rebirth level'),
      },
    };
  }

  async getRunSettlementContext(wallet: string, runId: bigint): Promise<V3RunSettlementContext> {
    assertAddress(wallet, 'Wallet');
    const blockNumber = await this.confirmedBlockNumber();
    await this.assertContractAndReconcile(blockNumber);
    const [currentSeason, activeRun, run] = await Promise.all([
      this.client.readContract({
        address: this.config.contractAddress,
        abi: V3_READ_ABI,
        functionName: 'currentSeasonId',
        blockNumber,
      }),
      this.client.readContract({
        address: this.config.contractAddress,
        abi: V3_READ_ABI,
        functionName: 'activeRunId',
        args: [wallet as Address],
        blockNumber,
      }),
      this.client.readContract({
        address: this.config.contractAddress,
        abi: V3_READ_ABI,
        functionName: 'runs',
        args: [wallet as Address, runId],
        blockNumber,
      }),
    ]);
    const [seasonId, status, , lastRecordedScoreTier, rulesVersion] = run;
    if (activeRun !== runId || status !== this.config.activeRunStatus || seasonId !== currentSeason)
      throw new Error('Run is not active in the current season on the confirmed chain.');
    const rules = await this.client.readContract({
      address: this.config.contractAddress,
      abi: V3_READ_ABI,
      functionName: 'rewardRules',
      args: [rulesVersion],
      blockNumber,
    });
    return { lastRecordedScoreTier, rulesVersion, rebirthThresholdTier: rules[0] };
  }

  async getConfirmedTimestampSeconds(): Promise<bigint> {
    const blockNumber = await this.confirmedBlockNumber();
    await this.assertContractAndReconcile(blockNumber);
    return (await this.client.getBlock({ blockNumber })).timestamp;
  }

  async getAttesterAddress(): Promise<Address> {
    const blockNumber = await this.confirmedBlockNumber();
    await this.assertContractAndReconcile(blockNumber);
    return this.client.readContract({
      address: this.config.contractAddress,
      abi: V3_READ_ABI,
      functionName: 'attester',
      blockNumber,
    });
  }

  async isValidSignature(
    chainId: bigint,
    wallet: string,
    digest: Hex,
    signature: Hex,
  ): Promise<boolean> {
    if (chainId !== BigInt(this.config.chain.id)) return false;
    assertAddress(wallet, 'Contract wallet');
    const blockNumber = await this.confirmedBlockNumber();
    const magic = await this.client.readContract({
      address: wallet,
      abi: V3_READ_ABI,
      functionName: 'isValidSignature',
      args: [digest, signature],
      blockNumber,
    });
    return String(magic).toLowerCase() === IERC1271_MAGIC;
  }

  async getConfirmedNonceObservation(wallet: string): Promise<ConfirmedNonceObservation> {
    assertAddress(wallet, 'Wallet');
    const blockNumber = await this.confirmedBlockNumber();
    await this.assertContractAndReconcile(blockNumber);
    const [nonce, signerEpoch, block] = await Promise.all([
      this.client.readContract({
        address: this.config.contractAddress,
        abi: V3_READ_ABI,
        functionName: 'attestationNonce',
        args: [wallet],
        blockNumber,
      }),
      this.client.readContract({
        address: this.config.contractAddress,
        abi: V3_READ_ABI,
        functionName: 'signerEpoch',
        blockNumber,
      }),
      this.client.getBlock({ blockNumber }),
    ]);
    const checkpoint = await this.optionsCheckpoint();
    const finalBlock = await this.client.getBlock({ blockNumber });
    if (
      !checkpoint ||
      checkpoint.blockNumber !== Number(blockNumber) ||
      checkpoint.blockHash.toLowerCase() !== block.hash?.toLowerCase() ||
      finalBlock.hash?.toLowerCase() !== block.hash?.toLowerCase()
    )
      throw new Error('Confirmed nonce observation changed during read.');
    return {
      chainId: String(this.config.chain.id),
      verifyingContract: this.config.contractAddress,
      blockNumber: asSafeNumber(blockNumber, 'Confirmed block number'),
      blockHash: block.hash!,
      confirmations: this.config.confirmations,
      timestampSeconds: block.timestamp.toString(),
      nonce: String(nonce),
      signerEpoch: asSafeNumber(signerEpoch, 'Signer epoch'),
    };
  }

  async getRunContext(session: AuthenticatedWalletSession, requestedRunId: string) {
    try {
      if (
        session.chainId !== BigInt(this.config.chain.id) ||
        session.verifyingContract.toLowerCase() !== this.config.contractAddress.toLowerCase()
      )
        return null;
      assertAddress(session.wallet, 'Session wallet');
      assertAddress(session.verifyingContract, 'Session contract');
      if (!/^[1-9][0-9]*$/.test(requestedRunId)) return null;
      const runId = BigInt(requestedRunId);
      if (runId > (1n << 64n) - 1n) return null;

      const blockNumber = await this.confirmedBlockNumber();
      await this.assertContractAndReconcile(blockNumber);
      const [currentSeasonRaw, activeRunRaw, run] = await Promise.all([
        this.client.readContract({
          address: this.config.contractAddress,
          abi: V3_READ_ABI,
          functionName: 'currentSeasonId',
          blockNumber,
        }),
        this.client.readContract({
          address: this.config.contractAddress,
          abi: V3_READ_ABI,
          functionName: 'activeRunId',
          args: [session.wallet as Address],
          blockNumber,
        }),
        this.client.readContract({
          address: this.config.contractAddress,
          abi: V3_READ_ABI,
          functionName: 'runs',
          args: [session.wallet as Address, runId],
          blockNumber,
        }),
      ]);
      const [seasonIdRaw, statusRaw, startedAtRaw, , rulesVersionRaw, upgradeHash] = run;
      const currentSeasonId = asSafeNumber(currentSeasonRaw, 'Current season ID');
      const seasonId = asSafeNumber(seasonIdRaw, 'Run season ID');
      const startedAtMs = asSafeNumber(startedAtRaw * 1_000n, 'Run start time');
      const rulesVersion = asSafeNumber(rulesVersionRaw, 'Run rules version');
      if (
        activeRunRaw !== runId ||
        statusRaw !== this.config.activeRunStatus ||
        seasonId !== currentSeasonId ||
        (rulesVersion !== 1 && rulesVersion !== 2 && rulesVersion !== 3)
      )
        return null;
      const confirmedHead = await this.client.getBlock({ blockNumber });
      if (
        seasonIdAtMilliseconds(
          asSafeNumber(confirmedHead.timestamp * 1_000n, 'Confirmed block time'),
        ) !== currentSeasonId
      )
        return null;
      const seasonRebirthsRaw = await this.client.readContract({
        address: this.config.contractAddress,
        abi: V3_READ_ABI,
        functionName: 'seasonalRebirths',
        args: [session.wallet as Address, BigInt(seasonId)],
        blockNumber,
      });
      let event: PersistedRunStartedEvent;
      try {
        event = await this.findRunStartedEvent(
          session.wallet as Address,
          runId,
          BigInt(seasonId),
          blockNumber,
          startedAtRaw,
        );
      } catch (error) {
        if (error instanceof VerifierError) throw error;
        throw new VerifierError(
          'RECOVERY_FAILED',
          'RunStarted recovery could not reach a confirmed canonical range; retry to resume.',
        );
      }
      if (
        event.player.toLowerCase() !== session.wallet.toLowerCase() ||
        event.runId !== requestedRunId ||
        BigInt(event.seasonId) !== BigInt(seasonId) ||
        BigInt(event.startedAt) !== startedAtRaw ||
        event.rulesVersion !== rulesVersionRaw ||
        event.upgradeChoicesHash.toLowerCase() !== String(upgradeHash).toLowerCase()
      )
        throw new Error('RunStarted event does not match current run state.');
      const choices = toCanonicalChoices(event.upgradeChoices);
      if (hashUpgradeChoices(choices).toLowerCase() !== String(upgradeHash).toLowerCase())
        throw new Error('Committed PP choices do not match their on-chain hash.');

      const levelsAfter = {} as UpgradeLevels;
      let ppAfter = await this.client.readContract({
        address: this.config.contractAddress,
        abi: V3_READ_ABI,
        functionName: 'seasonalPP',
        args: [session.wallet as Address, BigInt(seasonId)],
        blockNumber,
      });
      for (const [name, id] of Object.entries(SOLIDITY_UPGRADE_IDS) as Array<
        [UpgradeChoice['upgradeId'], number]
      >) {
        const level = await this.client.readContract({
          address: this.config.contractAddress,
          abi: V3_READ_ABI,
          functionName: 'seasonalUpgradeLevel',
          args: [session.wallet as Address, BigInt(seasonId), id],
          blockNumber,
        });
        const choice = choices.find((item) => item.upgradeId === name);
        const current = asSafeNumber(level, `Upgrade ${name} level`);
        if (choice && current < choice.quantity)
          throw new Error('Committed upgrade level is inconsistent with chain state.');
        levelsAfter[name] = current;
        if (choice) ppAfter += ppUpgradeCost(current - choice.quantity, choice.quantity);
      }
      const existingUpgrades = { ...levelsAfter };
      for (const choice of choices) existingUpgrades[choice.upgradeId] -= choice.quantity;
      const input: CanonicalRunInput = {
        runId: requestedRunId,
        seasonId,
        startedAtMs,
        seasonalPP: ppAfter,
        existingUpgrades,
        seasonRebirths: asSafeNumber(seasonRebirthsRaw, 'Season rebirth count'),
        upgradeChoices: choices,
      };
      // `startedAt` is the season authority for the run; all values are confirmed together at one block.
      if (seasonIdAtMilliseconds(startedAtMs) !== seasonId)
        throw new Error('Run start timestamp and season disagree.');
      const checkpointAfterRead = await this.optionsCheckpoint();
      if (
        !checkpointAfterRead ||
        checkpointAfterRead.blockNumber !== Number(blockNumber) ||
        checkpointAfterRead.blockHash.toLowerCase() !== confirmedHead.hash?.toLowerCase()
      )
        throw new Error('Confirmed chain head changed during state reads.');
      const finalHead = await this.client.getBlock({ blockNumber });
      if (finalHead.hash?.toLowerCase() !== confirmedHead.hash?.toLowerCase())
        throw new Error('Confirmed block reorganized while the run context was being read.');
      return {
        player: session.wallet,
        chainId: session.chainId,
        verifyingContract: session.verifyingContract,
        active: true,
        currentSeasonId,
        rulesVersion,
        input,
      };
    } catch (error) {
      if (error instanceof VerifierError) throw error;
      // RPC timeout, malformed state, unknown ABI, or reorg uncertainty disables command acceptance.
      return null;
    }
  }

  /** Scan one confirmed page and persist its cursor, keeping each Worker invocation bounded. */
  private async findRunStartedEvent(
    wallet: Address,
    runId: bigint,
    seasonId: bigint,
    confirmedHead: bigint,
    startedAt: bigint,
  ): Promise<PersistedRunStartedEvent> {
    const key: RunStartedEventScanKey = {
      chainId: String(this.config.chain.id),
      verifyingContract: this.config.contractAddress,
      player: wallet,
      runId: runId.toString(),
      seasonId: seasonId.toString(),
    };
    const deploymentBlock = asSafeNumber(this.config.deploymentBlock, 'Deployment block');
    let scan = await this.checkpoints.initializeRunStartedEventScan(
      key,
      deploymentBlock,
      this.config.nowMilliseconds(),
    );
    validateRunStartedScan(scan, deploymentBlock);

    if (scan.eventJson !== null) {
      if (scan.eventBlockNumber === null || !scan.eventBlockHash)
        throw new VerifierError(
          'RECOVERY_FAILED',
          'Stored RunStarted event checkpoint is incomplete.',
        );
      if (BigInt(scan.eventBlockNumber) <= confirmedHead) {
        const canonical = await this.client.getBlock({
          blockNumber: BigInt(scan.eventBlockNumber),
        });
        if (canonical.hash?.toLowerCase() === scan.eventBlockHash.toLowerCase()) {
          try {
            return JSON.parse(scan.eventJson) as PersistedRunStartedEvent;
          } catch {
            throw new VerifierError(
              'RECOVERY_FAILED',
              'Stored RunStarted event data is malformed.',
            );
          }
        }
      }
      const reset = await this.checkpoints.resetRunStartedEventScan(
        key,
        scan.nextBlock,
        deploymentBlock,
        this.config.nowMilliseconds(),
      );
      if (reset !== 'advanced')
        throw new VerifierError(
          'RECOVERY_FAILED',
          'RunStarted recovery changed concurrently; retry.',
        );
      scan = (await this.checkpoints.getRunStartedEventScan(key))!;
      validateRunStartedScan(scan, deploymentBlock);
    }

    // A just-started run is almost always in the recent confirmed window. Look there first
    // instead of paging from deploymentBlock; the run record supplies the expected timestamp.
    const recentFrom = confirmedHead - RUN_STARTED_RECENT_LOOKUP_BLOCKS + 1n > BigInt(deploymentBlock)
      ? confirmedHead - RUN_STARTED_RECENT_LOOKUP_BLOCKS + 1n
      : BigInt(deploymentBlock);
    if (scan.scannedThrough < deploymentBlock && recentFrom <= confirmedHead) {
      try {
        const before = await this.client.getBlock({ blockNumber: confirmedHead });
        const boundaryHash = before.hash?.toLowerCase();
        if (!boundaryHash) throw new Error('Confirmed recent boundary has no block hash.');
        const recentLogs = await this.client.getLogs({
          address: this.config.contractAddress,
          event: V3_RUN_STARTED_ABI[0],
          args: { player: wallet, runId, seasonId },
          fromBlock: recentFrom,
          toBlock: confirmedHead,
        });
        const after = await this.client.getBlock({ blockNumber: confirmedHead });
        if (after.hash?.toLowerCase() !== boundaryHash)
          throw new Error('Chain reorganized during recent RunStarted lookup.');
        const matches = recentLogs.filter(
          (log) =>
            log.args.player?.toLowerCase() === wallet.toLowerCase() &&
            log.args.runId === runId &&
            log.args.seasonId === seasonId &&
            log.args.startedAt === startedAt,
        );
        if (matches.length === 1) {
          const log = matches[0]!;
          if (log.blockNumber === null || !log.blockHash)
            throw new Error('Recent RunStarted log has no block identity.');
          const eventBlock = await this.client.getBlock({ blockNumber: log.blockNumber });
          if (eventBlock.hash?.toLowerCase() !== log.blockHash.toLowerCase())
            throw new Error('Recent RunStarted event block is not canonical.');
          const args = log.args;
          if (
            !args.player || args.runId === undefined || args.seasonId === undefined ||
            args.rulesVersion === undefined || !args.upgradeChoicesHash ||
            args.startedAt === undefined || !args.upgradeChoices
          ) throw new Error('Recent RunStarted event is incomplete.');
          const event: PersistedRunStartedEvent = {
            player: args.player,
            runId: args.runId.toString(),
            seasonId: args.seasonId.toString(),
            rulesVersion: args.rulesVersion,
            upgradeChoicesHash: args.upgradeChoicesHash,
            startedAt: args.startedAt.toString(),
            upgradeChoices: args.upgradeChoices.map(({ upgradeId, quantity }) => ({ upgradeId, quantity })),
          };
          const cached = await this.checkpoints.advanceRunStartedEventScan(key, scan.nextBlock, {
            nextBlock: asSafeNumber(confirmedHead + 1n, 'Recent RunStarted cursor'),
            scannedThrough: asSafeNumber(confirmedHead, 'Recent RunStarted boundary'),
            scannedBlockHash: boundaryHash,
            eventJson: JSON.stringify(event),
            eventBlockNumber: asSafeNumber(log.blockNumber, 'RunStarted event block'),
            eventBlockHash: log.blockHash,
            updatedAtMs: this.config.nowMilliseconds(),
          });
          if (cached !== 'advanced') throw new Error('RunStarted recovery changed concurrently.');
          return event;
        }
      } catch (error) {
        if (error instanceof VerifierError) throw error;
        throw new VerifierError(
          'RECOVERY_FAILED',
          'Recent RunStarted lookup could not reach a confirmed range; retry to continue.',
        );
      }
    }

    if (scan.scannedThrough >= deploymentBlock && scan.scannedBlockHash) {
      const scanOutrunsConfirmedHead = BigInt(scan.scannedThrough) > confirmedHead;
      const anchor = scanOutrunsConfirmedHead
        ? null
        : await this.client.getBlock({ blockNumber: BigInt(scan.scannedThrough) });
      if (
        scanOutrunsConfirmedHead ||
        anchor?.hash?.toLowerCase() !== scan.scannedBlockHash.toLowerCase()
      ) {
        const reset = await this.checkpoints.resetRunStartedEventScan(
          key,
          scan.nextBlock,
          deploymentBlock,
          this.config.nowMilliseconds(),
        );
        if (reset !== 'advanced')
          throw new VerifierError(
            'RECOVERY_FAILED',
            'RunStarted recovery changed concurrently; retry.',
          );
        scan = (await this.checkpoints.getRunStartedEventScan(key))!;
        validateRunStartedScan(scan, deploymentBlock);
      }
    }

    const fromBlock = BigInt(scan.nextBlock);
    if (fromBlock > confirmedHead)
      throw new VerifierError(
        'RECOVERY_FAILED',
        'RunStarted event is not present in the confirmed scan range yet; retry after RPC recovery.',
      );
    const proposedEnd = fromBlock + RUN_STARTED_LOOKUP_CHUNK_BLOCKS - 1n;
    const toBlock = proposedEnd < confirmedHead ? proposedEnd : confirmedHead;
    try {
      const before = await this.client.getBlock({ blockNumber: toBlock });
      const beforeHash = before.hash?.toLowerCase();
      if (!beforeHash) throw new Error('Confirmed scan boundary has no block hash.');
      const logs = await this.client.getLogs({
        address: this.config.contractAddress,
        event: V3_RUN_STARTED_ABI[0],
        args: { player: wallet, runId, seasonId },
        fromBlock,
        toBlock,
      });
      const after = await this.client.getBlock({ blockNumber: toBlock });
      if (after.hash?.toLowerCase() !== beforeHash)
        throw new Error('Chain reorganized while reading RunStarted logs.');
      const matching = logs.filter(
        (log) =>
          log.args.player?.toLowerCase() === wallet.toLowerCase() &&
          log.args.runId === runId &&
          log.args.seasonId === seasonId,
      );
      if (matching.length > 1)
        throw new Error('Confirmed RunStarted range contains duplicate matching events.');

      const endBlock = asSafeNumber(toBlock, 'RunStarted scan block');
      let eventJson: string | null = null;
      let eventBlockNumber: number | null = null;
      let eventBlockHash: string | null = null;
      if (matching.length === 1) {
        const log = matching[0]!;
        if (log.blockNumber === null || !log.blockHash)
          throw new Error('Confirmed RunStarted log has no block identity.');
        const eventBlock = await this.client.getBlock({ blockNumber: log.blockNumber });
        if (eventBlock.hash?.toLowerCase() !== log.blockHash.toLowerCase())
          throw new Error('RunStarted event block is not canonical.');
        const args = log.args;
        if (
          !args.player ||
          args.runId === undefined ||
          args.seasonId === undefined ||
          args.rulesVersion === undefined ||
          !args.upgradeChoicesHash ||
          args.startedAt === undefined ||
          !args.upgradeChoices
        )
          throw new Error('Confirmed RunStarted event is incomplete.');
        const persisted: PersistedRunStartedEvent = {
          player: args.player,
          runId: args.runId.toString(),
          seasonId: args.seasonId.toString(),
          rulesVersion: args.rulesVersion,
          upgradeChoicesHash: args.upgradeChoicesHash,
          startedAt: args.startedAt.toString(),
          upgradeChoices: args.upgradeChoices.map(({ upgradeId, quantity }) => ({
            upgradeId,
            quantity,
          })),
        };
        eventJson = JSON.stringify(persisted);
        eventBlockNumber = asSafeNumber(log.blockNumber, 'RunStarted event block');
        eventBlockHash = log.blockHash;
      }
      const advanced = await this.checkpoints.advanceRunStartedEventScan(key, scan.nextBlock, {
        nextBlock: endBlock + 1,
        scannedThrough: endBlock,
        scannedBlockHash: beforeHash,
        eventJson,
        eventBlockNumber,
        eventBlockHash,
        updatedAtMs: this.config.nowMilliseconds(),
      });
      if (advanced !== 'advanced') throw new Error('RunStarted scan cursor changed concurrently.');
      if (eventJson) return JSON.parse(eventJson) as PersistedRunStartedEvent;
      throw new VerifierError(
        'RECOVERY_FAILED',
        `RunStarted recovery scanned blocks ${scan.nextBlock}-${endBlock}; retry to continue the bounded scan.`,
      );
    } catch (error) {
      if (error instanceof VerifierError) throw error;
      throw new VerifierError(
        'RECOVERY_FAILED',
        'RunStarted log recovery could not complete this bounded page; retry to resume from its saved cursor.',
      );
    }
  }

  private async confirmedBlockNumber(): Promise<bigint> {
    const actualChainId = await this.client.getChainId();
    if (actualChainId !== this.config.chain.id)
      throw new Error('RPC chain ID does not match configured V3 chain.');
    const latest = await this.client.getBlockNumber();
    const confirmations = BigInt(this.config.confirmations);
    if (latest + 1n < confirmations)
      throw new Error('Chain does not yet have enough confirmation depth.');
    return latest - confirmations + 1n;
  }

  private async assertContractAndReconcile(confirmed: bigint): Promise<void> {
    const code = await this.client.getCode({
      address: this.config.contractAddress,
      blockNumber: confirmed,
    });
    if (!code || code === '0x')
      throw new Error('Configured V3 address has no confirmed contract bytecode.');
    const stored = await this.optionsCheckpoint();
    if (stored) {
      const storedNumber = BigInt(stored.blockNumber);
      if (storedNumber > confirmed)
        throw new Error('Stored chain checkpoint is ahead of the confirmed RPC head.');
      const canonical = await this.client.getBlock({ blockNumber: storedNumber });
      if (canonical.hash?.toLowerCase() !== stored.blockHash.toLowerCase()) {
        await this.checkpoints.advanceChainCheckpoint(
          {
            chainId: String(this.config.chain.id),
            verifyingContract: this.config.contractAddress,
            blockNumber: Number(canonical.number),
            blockHash: canonical.hash!,
            parentHash: canonical.parentHash!,
          },
          this.config.nowMilliseconds(),
        );
        throw new Error(
          'Stored chain checkpoint was reorganized; operator reconciliation is required.',
        );
      }
    }
    // Reorg safety comes from rechecking the stored head's canonical hash above and querying the
    // confirmed target head from the same RPC. Advancing one row per block made an idle Worker
    // require thousands of RPC/D1 subrequests after downtime, exceeding the Free plan limits.
    const head = await this.client.getBlock({ blockNumber: confirmed });
    if (!head.hash || !head.parentHash)
      throw new Error('Confirmed RPC head is missing its block hash or parent hash.');
    const outcome = await this.checkpoints.advanceChainCheckpoint(
      {
        chainId: String(this.config.chain.id),
        verifyingContract: this.config.contractAddress,
        blockNumber: asSafeNumber(confirmed, 'Confirmed block number'),
        blockHash: head.hash,
        parentHash: head.parentHash,
      },
      this.config.nowMilliseconds(),
      stored ?? undefined,
    );
    if (outcome === 'reorg')
      throw new Error('Chain checkpoint changed concurrently or the canonical chain reorganized.');
  }

  private optionsCheckpoint(): Promise<ChainCheckpoint | null> {
    return Promise.resolve(
      this.checkpoints.getChainCheckpoint(
        String(this.config.chain.id),
        this.config.contractAddress,
      ),
    );
  }
}

/** Factory helper keeps transport setup explicit and usable by local integration harnesses. */
export function createV3RpcClient(chain: Chain, rpcUrl: string): PublicClient {
  if (!/^https:\/\//i.test(rpcUrl) && !/^http:\/\/127\.0\.0\.1(?::|\/)/i.test(rpcUrl))
    throw new Error('RPC URL must use HTTPS except for loopback local development.');
  return createPublicClient({ chain, transport: http(rpcUrl) });
}
