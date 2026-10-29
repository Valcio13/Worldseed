import type { Address, Hex } from 'viem';
import type { D1DatabaseLike } from '../server/d1VerifierStore';
import type { V3RebirthSettlementLog } from '../server/v3ChainReader';

const SCAN_BLOCKS = 1_000n;
const MAX_EVENTS_PER_WRITE = 90;

export interface LeaderboardChain {
  getLeaderboardHead(): Promise<{
    seasonId: bigint;
    confirmedBlock: bigint;
    confirmedBlockHash: Hex;
    communityCP: bigint;
    communityCPCap: bigint;
  }>;
  getLeaderboardBlockHash(blockNumber: bigint): Promise<Hex>;
  getRebirthSettlementLogs(fromBlock: bigint, toBlock: bigint): Promise<V3RebirthSettlementLog[]>;
}

export interface SeasonalLeaderboardEntry {
  rank: number;
  wallet: Address;
  settledNatureAtoms: string;
  cpEarned: string;
}

interface ScanRow {
  next_block: number;
  scanned_through: number;
  scanned_block_hash: string | null;
}

function assertD1(result: { success: boolean }): void {
  if (!result.success) throw new Error('Leaderboard persistence is unavailable.');
}

function safeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error('Leaderboard scan cursor exceeds the supported range.');
  return number;
}

/** Bounded, resumable index of confirmed settlement events for the active season. */
export class SeasonalLeaderboard {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly chain: LeaderboardChain,
    private readonly chainId: string,
    private readonly contract: Address,
    private readonly deploymentBlock: bigint,
    private readonly now: () => number = Date.now,
  ) {}

  async getCurrentSeason() {
    const head = await this.chain.getLeaderboardHead();
    const key = [this.chainId, this.contract.toLowerCase()];
    assertD1(
      await this.db
        .prepare(
          `INSERT INTO leaderboard_scans(chain_id, verifying_contract, next_block, scanned_through, scanned_block_hash, updated_at_ms)
           VALUES (?, ?, ?, ?, NULL, ?) ON CONFLICT(chain_id, verifying_contract) DO NOTHING`,
        )
        .bind(
          ...key,
          safeNumber(this.deploymentBlock),
          safeNumber(this.deploymentBlock - 1n),
          this.now(),
        )
        .run(),
    );
    let scan = await this.db
      .prepare(
        'SELECT next_block, scanned_through, scanned_block_hash FROM leaderboard_scans WHERE chain_id = ? AND verifying_contract = ?',
      )
      .bind(...key)
      .first<ScanRow>();
    if (!scan) throw new Error('Leaderboard scan cursor is unavailable.');

    if (scan.scanned_block_hash && scan.scanned_through >= Number(this.deploymentBlock)) {
      const canonicalHash = await this.chain.getLeaderboardBlockHash(BigInt(scan.scanned_through));
      if (canonicalHash.toLowerCase() !== scan.scanned_block_hash.toLowerCase()) {
        const reset = await this.db.batch([
          this.db
            .prepare(
              'DELETE FROM leaderboard_rebirth_events WHERE chain_id = ? AND verifying_contract = ?',
            )
            .bind(...key),
          this.db
            .prepare(
              `UPDATE leaderboard_scans SET next_block = ?, scanned_through = ?, scanned_block_hash = NULL, updated_at_ms = ?
               WHERE chain_id = ? AND verifying_contract = ? AND scanned_through = ?`,
            )
            .bind(
              safeNumber(this.deploymentBlock),
              safeNumber(this.deploymentBlock - 1n),
              this.now(),
              ...key,
              scan.scanned_through,
            ),
        ]);
        reset.forEach(assertD1);
        scan = await this.db
          .prepare(
            'SELECT next_block, scanned_through, scanned_block_hash FROM leaderboard_scans WHERE chain_id = ? AND verifying_contract = ?',
          )
          .bind(...key)
          .first<ScanRow>();
        if (!scan) throw new Error('Leaderboard scan cursor could not recover.');
      }
    }

    const from = BigInt(scan.next_block);
    let scannedThisRequest = 0n;
    if (from <= head.confirmedBlock) {
      const to =
        from + SCAN_BLOCKS - 1n < head.confirmedBlock
          ? from + SCAN_BLOCKS - 1n
          : head.confirmedBlock;
      const logs = await this.chain.getRebirthSettlementLogs(from, to);
      const boundaryHash = await this.chain.getLeaderboardBlockHash(to);
      const statements = logs.map((log) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO leaderboard_rebirth_events(
              chain_id, verifying_contract, transaction_hash, log_index, block_number, block_hash,
              season_id, player, nature_atoms, cp_awarded
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            ...key,
            log.transactionHash.toLowerCase(),
            log.logIndex,
            safeNumber(log.blockNumber),
            log.blockHash.toLowerCase(),
            log.seasonId.toString(),
            log.player.toLowerCase(),
            log.natureCollectedAtoms.toString(),
            log.cpAwarded.toString(),
          ),
      );
      for (let offset = 0; offset < statements.length; offset += MAX_EVENTS_PER_WRITE) {
        const batch = await this.db.batch(statements.slice(offset, offset + MAX_EVENTS_PER_WRITE));
        batch.forEach(assertD1);
      }
      const advance = await this.db
        .prepare(
          `UPDATE leaderboard_scans SET next_block = ?, scanned_through = ?, scanned_block_hash = ?, updated_at_ms = ?
           WHERE chain_id = ? AND verifying_contract = ? AND next_block = ?`,
        )
        .bind(
          safeNumber(to + 1n),
          safeNumber(to),
          boundaryHash.toLowerCase(),
          this.now(),
          ...key,
          scan.next_block,
        )
        .run();
      assertD1(advance);
      scannedThisRequest = to - from + 1n;
      scan = {
        next_block: safeNumber(to + 1n),
        scanned_through: safeNumber(to),
        scanned_block_hash: boundaryHash,
      };
    }

    const rows = await this.db
      .prepare(
        `SELECT player, nature_atoms, cp_awarded FROM leaderboard_rebirth_events
         WHERE chain_id = ? AND verifying_contract = ? AND season_id = ?`,
      )
      .bind(...key, head.seasonId.toString())
      .all<{ player: string; nature_atoms: string; cp_awarded: string }>();
    assertD1(rows);
    const totals = new Map<string, { nature: bigint; cp: bigint }>();
    for (const row of rows.results ?? []) {
      const current = totals.get(row.player) ?? { nature: 0n, cp: 0n };
      current.nature += BigInt(row.nature_atoms);
      current.cp += BigInt(row.cp_awarded);
      totals.set(row.player, current);
    }
    const sorted = [...totals.entries()]
      .sort((a, b) =>
        a[1].cp === b[1].cp
          ? a[1].nature === b[1].nature
            ? a[0].localeCompare(b[0])
            : a[1].nature > b[1].nature
              ? -1
              : 1
          : a[1].cp > b[1].cp
            ? -1
            : 1,
      )
      .slice(0, 50)
      .map(([wallet, total], index) => ({
        rank: index + 1,
        wallet: wallet as Address,
        settledNatureAtoms: total.nature.toString(),
        cpEarned: total.cp.toString(),
      }));
    return {
      seasonId: head.seasonId.toString(),
      communityCP: head.communityCP.toString(),
      communityCPCap: head.communityCPCap.toString(),
      entries: sorted,
      indexing: BigInt(scan.next_block) <= head.confirmedBlock,
      scannedThrough: scan.scanned_through,
      confirmedHead: head.confirmedBlock.toString(),
      scannedBlocks: scannedThisRequest.toString(),
      natureScale: '1000000000000',
    };
  }
}
