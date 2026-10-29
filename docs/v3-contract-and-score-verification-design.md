# Worldseed V3 Contract and Score Verification Design

**Status:** conditionally approved architecture; implementation remains out of scope. Reward values remain provisional pending gameplay balancing.

## 1. Findings from the current implementation

- `WorldseedGame.sol` is the V1 restoration ledger. It uses a single island per wallet, bounded habitat/action rules, and a weekly contribution counter. Its `currentWeek()` is `(block.timestamp + 3 days) / 7 days`.
- `WorldseedGameV2.sol` is a separate expedition ledger. Candidate-set issuance is EIP-712 attested; expeditions have monotonically increasing IDs and explicit active/completed/abandoned states. World Tree contributions use per-expedition claims plus a per-wallet nonce and unique contribution ID. Abandonment does not erase a contribution already confirmed onchain.
- The current frontend wallet integration targets V1 and Hemi Sepolia. It submits restoration actions and reads V1 World Tree counters. It does not submit the guest incremental economy to a contract.
- `src/incremental/engine.ts` is a local guest simulation. It calculates Nature, production, rebirth rewards, PP upgrades, and simulated CP in browser state. `BigValue` supports values too large for JavaScript `number`; it is not an authoritative or cryptographic proof of play.
- `src/incremental/season.ts` defines a season as seven days from Monday 1970-01-05 00:00 UTC: `floor((timestampMs - epochMondayMs) / weekMs)`. This matches V1/V2 reset boundaries but its season number is one lower than the legacy contract's `currentWeek()` number at corresponding times. V3 should use the guest formula and publish that exact ID convention; do not reuse the legacy counter as a V3 season ID.
- Guest offline earnings are local and capped. Neither a local save, client clock, IndexedDB record, nor a client-submitted score is suitable evidence for an onchain reward.

## 2. Approved trust boundary and command ledger

Keep ordinary play local. Treat the browser's Nature, save file, action history, and timestamps as untrusted inputs. A trusted verifier must independently reconstruct an eligible score from a versioned ruleset and server-recorded evidence before signing an attestation.

The approved verifier is an event-sourced service:

1. The player starts a run onchain. The contract emits a unique `(player, runId, seasonId)` and records the rules version and upgrade snapshot committed by that start.
2. The client plays locally and may queue commands. Each command has a random stable `clientCommandId`, `runId`, expected previous server sequence, action type, and validated arguments. Client timestamps and client state hashes are hints only; neither is trusted.
3. The verifier authenticates a wallet session using a one-time challenge bound to wallet, chain ID, V3 contract, origin, challenge nonce, and short expiry. It verifies an EOA signature or EIP-1271 contract-wallet signature, consumes the challenge once, and issues a short-lived session. Session credentials are scoped to that wallet/deployment and protected from cross-origin request forgery; each run remains independently checked against authoritative chain state.
4. For each command, the verifier takes a per-run serialization lock/compare-and-swap, checks the run is active and in the current season, deduplicates `(chainId, contract, player, runId, clientCommandId)`, and requires the expected next sequence. It validates the command against canonical server state using the shared rules package. It then atomically appends the accepted command, server sequence, server timestamp, resulting canonical state/cursor, and idempotency result. A duplicate returns the prior response; a stale cursor returns the canonical cursor/state needed to recover; a sequence gap is rejected with the expected sequence.
5. The client receives the accepted sequence and canonical state hash after commit. At Record Points or Rebirth the verifier replays/settles the committed log through that cursor, computes cumulative Nature earned and the score, then signs an EIP-712 payload. The contract accepts only the active attester's signature.

Before signing `START_RUN`, the verifier reads the chain's next run ID, active run, current season, current rules version, expected attestation nonce, seasonal PP, and upgrade levels. It serializes issuance per wallet and stores an idempotent pending start intent. If a start tx fails or expires, the verifier reconciles chain state before reissuing; it does not allocate a second run ID or nonce based on a client request. For `RECORD_POINTS` and `REBIRTH`, it similarly reads the active run and next nonce and refuses to sign when chain and verifier state disagree.

A signature means “the trusted verifier authorized this result under rules version X”; it does **not** make the underlying gameplay trustless. There is no cryptographic way for a server to prove that a human, rather than a bot, performed permitted inputs. The verifier can enforce legal state transitions, elapsed-time limits, and rate limits, but automation and Sybil accounts remain residual risks.

### Offline play and persistence recovery

- A run created by the V3 contract and its onchain `runId`/`seasonId`.
- Durable append-only accepted command history with unique constraints for run sequence and command ID, plus the corresponding canonical state cursor. Client snapshots aid rendering only.
- A pinned rules version, canonical server state, server clock, and audit log sufficient to replay the score. Persist command append, state transition, idempotency response, and any signing job transactionally; use a transactional outbox for signing/chain event work.
- Server backups and restart recovery. On restart, rebuild or verify canonical state from the append-only log, then reconcile run IDs, season, attestation nonces, and terminal statuses against contract events/views. If the sequence cannot be reconstructed, fail closed: issue no score attestation. Do not regenerate progress from IndexedDB.
- Offline commands may remain locally playable and queued, but their client timestamps are ignored. On reconnect, the service processes them in order at server receipt time, subject to normal rate limits. Offline clicks/actions are not backdated. Local offline Nature remains visible as unverified until accepted; only server-calculated passive production since the last accepted state may be included, capped at eight hours, settled once, and stopped at the season boundary. If a queued command cannot be validated under those rules, preserve the local save but do not include that command in a wallet score.

If the project is unwilling to operate this verifier or accept its trust assumptions, V3 should not award onchain CP from local incremental scores. The safe fallback is local-only guest progression with no wallet reward claim.

### Shared deterministic rules and display reconciliation

The client and verifier must import the same versioned, pure rules package (no `Date`, browser APIs, random source, or floating-point arithmetic in authoritative rules). It owns command validation, costs, production, upgrade effects, seasonal boundaries, and canonical state encoding. The verifier pins the package build/hash to `rulesVersion` and publishes test vectors for every release. The verifier recomputes every score from accepted commands; a client-reported result never overrides server state.

Use integer Nature atoms at a fixed scale of `10^12` atoms per Nature. All authoritative amounts and multipliers are integers/rational ratios. Positive production/credits floor to an atom; positive costs ceil to an atom. Division rounds down for gains and up for costs. The client formats canonical atoms directly. If an existing view still computes a floating `BigValue`, it is presentation-only: show it as pending/unverified, then reconcile to the server snapshot on sync. A rules hash mismatch blocks score signing and asks the client to refresh. Never silently overwrite a newer server cursor with a local save.

## 3. V3 interface proposal

Illustrative Solidity API; selectors may change during implementation, but the approved two-transaction minimum is one `startRun` and one successful `rebirth`. Checkpoints are optional and never award points.

```solidity
enum ActionType { NONE, START_RUN, RECORD_POINTS, REBIRTH }
enum RunStatus { NONE, ACTIVE, REBORN, EXPIRED, ABANDONED }

struct ScoreAttestation {
    address player;
    uint64  runId;
    uint64  seasonId;
    uint256 chainId;
    address verifyingContract;
    uint16  scoreTier;
    uint256 natureCollectedAtoms;
    uint64  nonce;
    uint64  issuedAt;
    uint64  expiresAt;
    uint32  rulesVersion;
    uint32  signerEpoch;
    bytes32 upgradeChoicesHash;
    ActionType actionType;
}

struct UpgradeChoice { uint8 upgradeId; uint16 quantity; }
function startRun(ScoreAttestation calldata a, UpgradeChoice[] calldata choices, bytes calldata sig) external;
function recordPoints(ScoreAttestation calldata a, bytes calldata sig) external;
function rebirth(ScoreAttestation calldata a, bytes calldata sig) external;
function abandonRun(uint64 runId) external; // forfeits all unsettled run rewards

function currentSeasonId() external view returns (uint64);
function seasonEnd(uint64 seasonId) external pure returns (uint64);
function runState(address player, uint64 runId) external view returns (...);
function seasonalPP(address player, uint64 seasonId) external view returns (uint256);
function seasonalCP(address player, uint64 seasonId) external view returns (uint256);
function lifetimeCP(address player) external view returns (uint256);
function lifetimeNatureCollectedAtoms(address player) external view returns (uint256);
function totalAccumulatedRebirthScore(address player) external view returns (uint256);
function seasonalAccumulatedRebirthScore(address player, uint64 seasonId) external view returns (uint256);
function totalSeasonCP(uint64 seasonId) external view returns (uint256);
function attestationNonce(address player) external view returns (uint64);
```

### Storage model

- `nextRunId[player]`: monotonically increasing; never reused.
- `activeRunId[player]`: zero or the single active run.
- `runs[player][runId]`: `{seasonId, status, startedAt, lastRecordedScoreTier, rulesVersion, upgradeChoicesHash}`. Store only data needed for replay protection and receipts; do not store a full action log onchain.
- `attestationNonce[player]`: next expected global per-wallet attestation nonce. Increment only in the same successful transaction that consumes the signature.
- `seasonalPP[player][seasonId]`, `seasonalUpgradeLevel[player][seasonId][upgradeId]`: season-scoped balance and upgrades. PP spending is bounded by the onchain balance; reset is logical by indexing on season ID, not an unbounded reset loop.
- `seasonalCP[player][seasonId]` and `totalSeasonCP[seasonId]`: immutable historical season totals for leaderboard/accounting. The active season's value is the seasonal balance; old mappings remain queryable as history.
- `seasonalHighScoreTier[player][seasonId]`: highest score tier successfully settled by Rebirth in that season. It is shared across rules versions and updated atomically even when the CP award is zero or capped.
- `lifetimeCP[player]`: monotonic total, increased only by a successful `rebirth`.
- `lifetimeNatureCollectedAtoms[player]`: saturated `uint256` sum of each successfully reborn run's canonical cumulative `earnedNatureAtoms`, including Nature later spent. Per-run values are signed in whole atoms and saturated to `uint256.max` before settlement; unfinished, expired, abandoned, or failed runs do not contribute.
- `totalAccumulatedRebirthScore[player]` and `seasonalAccumulatedRebirthScore[player][seasonId]`: sums of the existing verifier `scoreTier` for successful Rebirths. The seasonal value is indexed by the run's season; neither statistic changes PP, CP, thresholds, nor reward formulas.
- `attester`, `pendingAttester`, `attesterActivationTime`, `signerEpoch`, `paused`: administration and emergency controls.

Use bounded integer widths and explicit caps. `scoreTier` is `uint16`, with `MAX_SCORE_TIER = 65,535`; run IDs, season IDs, timestamps, and nonces are `uint64` and must revert before overflow. Point balances use checked `uint256` arithmetic and versioned per-reward/per-season caps. Do not put guest Nature or guest CP in these mappings. V3 is a separate immutable contract, not a proxy. Rules/reward configurations are keyed by `rulesVersion`, append-only, and cannot be edited after activation; delayed governance may activate a newly reviewed version but cannot rewrite prior rules or runs.

### Entry-point semantics

- `startRun`: requires `msg.sender == a.player`, `START_RUN`, `scoreTier == 0`, the next unused `runId`, current season, expected nonce, active rules version, valid signer epoch, and an unexpired signature. It closes a stale prior-season run as `EXPIRED` before opening the new run. It rejects a second same-season active run. A successful run ID is never recycled.
- `recordPoints`: requires an active run in the current season and exact wallet/run/season/domain binding. `rulesVersion` must match the version pinned to the run. `scoreTier` must be strictly greater than the last checkpoint and no greater than `MAX_SCORE_TIER`; a no-op or duplicate tier does not need a transaction. It records a monotonic checkpoint and consumes one nonce. It awards no PP or CP.
- `rebirth`: requires an active run in the current season, matching run-pinned `rulesVersion`, score at least the last checkpoint and at/above that version's Rebirth threshold, and a valid nonce/signature. **A prior Record Points transaction is not required.** PP keeps its versioned score formula. CP is one point for each new seven-tier milestone above both the run threshold and the player's seasonal high-water; repeated or lower scores award zero CP. Valid settlement is not reverted by seasonal PP/CP caps: each award is limited to the remaining capacity. The contract updates the run, nonce, high-water, and point balances atomically. Only this entry point can add CP.
- `abandonRun`: closes the caller's active run with no PP/CP and no refund. It cannot alter lifetime CP or a prior confirmed contribution. The run ID becomes terminal and never reopens. If still in its season, status becomes `ABANDONED`; after season end it is finalized as `EXPIRED`. A following start uses a new run ID. Stale runs are automatically finalized in a subsequent `startRun`; no abandonment transaction is needed merely to cross a season boundary.
- **Upgrade settlement at start:** batch a canonically ordered list of upgrade choices into the required `startRun` transaction. The attestation binds `upgradeChoicesHash`; the contract recomputes it, validates unique IDs, quantity/level caps, versioned costs, and sufficient onchain seasonal PP, then deducts PP and applies the selected levels atomically with run creation. The verifier reads and mirrors the committed levels before accepting commands. Choices are committed at start; changing them requires abandoning and starting a new run, with no refund. A future mid-run purchase requires a separately reviewed atomic settlement design.

  **Trade-off:** a separate onchain transaction per upgrade is easy to account for but adds a wallet prompt per purchase. Verifier-only choices charged at rebirth reduce prompts but require reservations, allow overspend/race cases across abandoned runs, and make it harder to prove which upgrades affected the run. Atomic settlement at start is the simplest secure compromise and adds no required transaction beyond `startRun` and `rebirth`.

## 4. Exact attestation and replay rules

Use EIP-712 domain `{name: "Worldseed V3", version: "1", chainId, verifyingContract}` and this exact struct declaration (the Solidity enum is encoded as `uint8` in the EIP-712 type string):

```text
ScoreAttestation(address player,uint64 runId,uint64 seasonId,uint256 chainId,address verifyingContract,uint16 scoreTier,uint256 natureCollectedAtoms,uint64 nonce,uint64 issuedAt,uint64 expiresAt,uint32 rulesVersion,uint32 signerEpoch,bytes32 upgradeChoicesHash,uint8 actionType)
```

The signed struct hash includes every field above. Although chain ID and verifying contract are already in the EIP-712 domain, repeat them in the struct as requested and require both to equal `block.chainid` and `address(this)`. For every call require:

- `player == msg.sender`; no relayer path in the first version.
- `nonce == attestationNonce[player]`; increment atomically only after all checks pass. A reverted tx consumes no nonce.
- `issuedAt <= block.timestamp < expiresAt`, `expiresAt > issuedAt`, expiry no later than the run's season end, and lifetime no longer than the configured short policy window. Record Points and Rebirth attestations never receive post-season grace.
- exact action type, run ID, season, rules version, and signer epoch for the called function.
- `upgradeChoicesHash == keccak256(abi.encode(canonicallySortedChoices))` for `START_RUN`; it must be zero for `RECORD_POINTS` and `REBIRTH`.
- recovered signer equals the active attester; reject zero/high-s signatures and malformed ECDSA input.
- `runId == nextRunId[player] + 1` for start; existing active run for record/rebirth; status changes exactly once.

The global sequential nonce prevents signature replay across all actions for a wallet. Run status and `lastRecordedScoreTier` prevent replay/rollback within a run. The contract changes run status and credits rewards atomically; a successful rebirth makes every later rebirth signature for that run fail even if an attester bug signed another nonce. An abandoned or expired run is terminal and can never be reborn. An expired signature changes no state and does not consume a nonce. The verifier permits at most one unexpired payload per `(chainId, contract, player, nonce)`. After that payload has expired according to chain time, and chain state confirms the nonce/run action was not consumed, it may issue a replacement at the same nonce (including a newer score if commands resumed); there is never an overlap window in which conflicting payloads are both valid. A pending Rebirth intent freezes the accepted-score cursor at the signed score until success, expiry, or explicit resolution. Signer rotation increments `signerEpoch`, making every outstanding old-epoch signature invalid. On ambiguous transaction outcome, query run status, nonce, and balances before requesting a replacement signature.

### Signer rotation

Use two-step rotation: owner proposes a nonzero pending signer; the proposed signer accepts after a delay; activation increments `signerEpoch`. Attestations bind `signerEpoch`, invalidating every unconsumed old-signer signature immediately on activation. Keep owner and attester separate, protect owner with a multisig, emit proposal/accept/cancel events, and support canceling a pending rotation. Emergency pause should stop new starts/checkpoints/rebirth reward claims; it should not block read access or a no-reward abandon/expiry path. Unpause remains owner-only. Avoid an owner key that can arbitrarily mint points or change score formulas.

## 5. Season calculation and rollover

Canonical V3 season ID should match `src/incremental/season.ts` exactly:

```text
WEEK_SECONDS = 604800
EPOCH_MONDAY_SECONDS = 345600  // 1970-01-05 00:00:00 UTC
seasonId(t) = floor((t - EPOCH_MONDAY_SECONDS) / WEEK_SECONDS)
seasonStart(id) = EPOCH_MONDAY_SECONDS + id * WEEK_SECONDS
seasonEnd(id) = seasonStart(id) + WEEK_SECONDS
```

For contemporary EVM timestamps, Solidity can use `(block.timestamp - 345600) / 604800`. V1/V2's `(timestamp + 259200) / 604800` has the same Monday boundaries but labels each week one higher. Do not mix these IDs in V3 events, leaderboard keys, API records, or signatures.

All state is season-keyed, so rollover requires no transaction or loop. Attestations are accepted only while `a.seasonId == currentSeasonId()` and `block.timestamp < seasonEnd(a.seasonId)`. A run cannot earn rewards across a season boundary. There is no grace period: a signature issued shortly before expiry becomes unusable at the boundary, even if its `expiresAt` is later (the contract also requires `expiresAt <= seasonEnd`). A transaction submitted before expiry but mined at or after the boundary reverts and pays gas; the client must reconcile rather than display success. A reverted transaction consumes neither nonce nor run state. Pending stale submissions must never be automatically replaced with a new-season attestation. A stored run from a prior week is effectively expired for all reward calls immediately, even if its storage enum is lazily changed to `EXPIRED` on a later `startRun` or cleanup call.

The verifier stops issuing Record Points/Rebirth signatures when the remaining season time is below a configured safety window sufficient for expected wallet confirmation time. It explains that the transaction may not confirm before reset, warns while the run is active (recommended UI warnings at 15 and 5 minutes), and shows the exact season end in UTC. In wallet mode, the countdown uses chain timestamp/season state rather than the device clock; a local clock is only a display fallback. The safety window is operational configuration, not a reward parameter; it must be at least the maximum attestation lifetime policy. A start request inside the configured minimum useful run window is declined with a clear “season ending” response. If a valid tx is pending at rollover, preserve the hash and local save, query receipt and contract state, and then mark the old run expired if it did not succeed. The next start may atomically mark a stale active run `EXPIRED` and open the new season's run; alternatively the player may call explicit `abandonRun` before rollover. No old-season score or points carry forward. Local guest saves still use the existing season manager, but guest Nature/PP/CP never migrate into V3.

## 6. Cumulative Nature score and rewards

The score measures **cumulative Nature earned in the run**, not current spendable Nature. Spending Nature never lowers the score. The cumulative counter increases only for verifier-accepted generated Nature: Island Heart clicks and eligible habitat production, including server-calculated passive production within the offline cap. It excludes starting/rebirth grants, refunds, transfers, debug/admin changes, and any client-only offline accrual. Each accepted credit is added once to spendable Nature and once to cumulative earned Nature; purchases subtract only from spendable Nature. Canonical per-run spendable Nature is also bounded at `MAX_EARNED_NATURE_ATOMS`; when a stock is at that cap, additional credits beyond available capacity are not credited. The cumulative counter saturates at the same cap and never wraps.

### Canonical Nature and exact score-tier algorithm

The shared rules package represents every nonnegative Nature quantity as a `BigInt` count of atoms, with `NATURE_SCALE = 10^12` atoms per Nature. Zero is exactly `0n`. Fractional amounts below one Nature are representable down to one atom (`10^-12` Nature); smaller positive production is floored to zero. No negative Nature is permitted. Every addition is integer addition. A credit generated by a rational formula is floored to the nearest atom; a cost is ceiled to an atom. Thus rounding is always toward the game's conservative side: no fractional credit rounds up and no fractional cost rounds down. The server and client call the same functions and constants; the client is not allowed to substitute its legacy floating `BigValue` for the authoritative integer result.

Let `A` be cumulative earned Nature atoms. The score-tier algorithm is integer-only:

1. If `A < 10^12`, including `A == 0`, set `scoreTier = 0`. This explicitly makes every fractional Nature total below 1 Nature tier zero.
2. Otherwise let `d` be the number of base-10 digits in `A`, and `e = d - 13`. Since `A >= 10^12`, `e >= 0`; this is the decimal exponent of Nature (`A / 10^12`).
3. Let `mQ = floor(A / 10^e)`, the first 13 significant decimal digits represented as an integer in `[10^12, 10^13)`. No logarithm or floating-point conversion is used.
4. Let `b` be the greatest bucket index whose threshold is not greater than `mQ`, using exact integer thresholds `[1.00, 1.25, 1.50, 2.00, 3.00, 5.00, 7.50] × 10^12` with indices `0..6`.
5. Set `scoreTier = min(65,535, 7 × e + b)`. Saturate the cumulative counter at `MAX_EARNED_NATURE_ATOMS = 10^9375`, which is Nature `10^9363`; this is at or beyond the score saturation point. Before multiplying, if `e >= 9,363`, return `65,535`. Otherwise `7 × e + b` is bounded and safely fits `uint16` after saturation.

The score is monotonic because cumulative earned atoms never decrease and the integer tier function is monotonic. The maximum is exactly `MAX_SCORE_TIER = 65,535` (`uint16`); values above the saturation Nature do not increase it. Threshold comparisons use the floored integer significand, so a value just below a boundary remains in the lower tier. The verifier never accepts a client-supplied atom count or tier as evidence; it derives both by replay. The attestation carries only the bounded `uint16 scoreTier`.

### Versioned arithmetic shared by client and verifier

The verifier is authoritative, but client and verifier execute the same pure deterministic rules package and published test vectors. The package uses `BigInt` atoms for all Nature values and rational integer constants for rates, costs, and multipliers. It has explicit per-operation rounding rules as above, canonical command/state serialization, and no `Number`, floating math, device time, or random calls in reward-relevant paths. The build hash is pinned to `rulesVersion` and included in server records. The verifier replays commands independently; it does not trust a client-computed state hash.

The client may render optimistically, but it must label unsynced Nature/actions as local pending state. When the server responds, the client reconciles by `(runId, serverSequence, rulesVersion)` and replaces its authoritative gameplay state with the server canonical snapshot. If the local rules build differs, it pauses wallet-linked actions, preserves the local save for recovery, and refreshes the versioned rules package; it does not submit a score until synchronized. Formatting can abbreviate large atom values, but display formatting never feeds back into arithmetic.

### Reward formula shape (values remain provisional)

Only a successful `rebirth` awards PP and CP. Record Points stores a checkpoint only. For a given immutable `rulesVersion`, let `S` be `scoreTier`, `T` the rebirth threshold tier, and `D = max(0, S - T)`:

```text
PP_gross = min(PP_CAP[rulesVersion], PP_BASE[rulesVersion] + floor((scoreTier - threshold) / PP_STEP[rulesVersion]))
CP_gross = max(0, floor(scoreTier / 7) - floor(max(seasonalHighScoreTier, threshold) / 7))
PP_awarded = min(PP_gross, remaining seasonal PP capacity)
CP_awarded = min(CP_gross, remaining player and global seasonal CP capacity)
```

The contest candidates are threshold tier 35 for rules V1 and tier 42 for rules V2. The V1 threshold is installed at deployment; V2 uses the existing delayed proposal/activation flow. The seven-tier milestone step is fixed at 7. All reward configuration is append-only and each run remains bound to the version selected at `startRun`. The seasonal high-water is shared across versions, preventing a rules switch from paying for a previously reached tier. PP and CP caps are settlement ceilings, not Rebirth blockers. The verified Rebirth PP upgrade is disabled until it has a real effect. CP remains separate from legacy World Tree contribution accounting.

## 7. Transactions, rollover, and recovery

The normal run has exactly **two required wallet transactions**: `startRun` and `rebirth`. Record Points is optional. Upgrade choices are atomically settled in `startRun`, with no separate purchase transaction. Ordinary game commands and synchronization are verifier requests, not wallet transactions. Explicit abandonment is an additional optional transaction that forfeits the run.

| State                       | User action / result                                                                                               | Required recovery                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No run                      | Request start attestation, submit `startRun` with sorted upgrade choices                                           | On rejection, remain without a confirmed onchain run. On unknown receipt, read run ID, season, nonce, PP and upgrade levels before retry; never deduct local PP as confirmed until chain state/receipt confirms.         |
| Start pending               | Wallet prompt / tx pending                                                                                         | Preserve local queue. Do not claim the run started or choices spent until successful receipt or matching chain state.                                                                                                    |
| Active                      | Play locally; sync commands to verifier                                                                            | Server returns accepted cursor/state. Duplicate command IDs return prior result; stale cursor returns recovery state; gaps are rejected with expected sequence.                                                          |
| Record pending              | Request and submit checkpoint attestation                                                                          | Checkpoint consumes nonce only on success and awards nothing. Retry the same signed payload while valid. If expired, reconcile chain nonce/run/checkpoint, then request the same checkpoint at the expected nonce.       |
| Active, checkpointed or not | Continue local play; request Rebirth when ready                                                                    | Rebirth does not require a prior checkpoint. Verifier processes all newly accepted commands through a durable cursor, then signs the latest score. Reconcile cursor before signing.                                      |
| Rebirth pending             | Submit final score attestation                                                                                     | Rejection/revert leaves run and rewards unchanged. On unknown receipt, query receipt, run status, nonce, and all reward balances. Retry only if the run remains active and nonce is still expected.                      |
| Reborn                      | Contract closed run and credited rewards atomically                                                                | Clear current local run only after receipt/state confirmation; preserve an archive. Any duplicate/replacement signature fails on terminal status or nonce. New run uses next ID.                                         |
| Abandon pending / abandoned | Explicit `abandonRun(runId)`                                                                                       | No reward or PP refund. On ambiguous result, query status. `ABANDONED` is terminal; no attestation can revive it.                                                                                                        |
| Season closing              | Warning at 15 and 5 minutes; verifier refuses reward attestations inside the configured confirmation safety window | Finish/submit early. A pending tx mined after the boundary reverts; no grace. Preserve tx hash and local save, reconcile after the boundary, expire the old run if unconsumed, then start a fresh run in the new season. |
| Season rollover             | Old run can no longer score/rebirth                                                                                | Mark as expired on next start or explicit abandon; never carry Nature score, PP, CP, upgrades, or queued old-season actions into the next season.                                                                        |

The UI distinguishes wallet rejection, reverted receipt, pending/unknown status, season expiry, and confirmed success. Wallet replacement/cancellation is resolved by hash and chain state. A reverted tx consumes no nonce; a mined successful tx consumes it once. Expired signatures do not consume a nonce. If the chain response is ambiguous, never request a new signature until state is reconciled. Never clear queued local inputs or display rewards as confirmed before a successful receipt or matching authoritative chain read.

## 8. Isolation and contribution accounting

- **V1 island / World Tree:** retain as a separate legacy contract and UI mode. Do not migrate V1 completions, weekly contributions, island inventory, or Gold into V3. V1 contribution totals remain historical and are not V3 CP.
- **V2 expeditions:** retain as a separate testnet reference deployment. Its cross-chain candidate signatures, selected island seed, puzzle state, and expedition counters are not V3 run evidence.
- **Merchant/Gold:** keep outside V3. Gold is a separate legacy currency and must never be converted into Nature, PP, CP, or a V3 score.
- **2048:** already removed from the main game/roadmap; keep any retained legacy contract/source isolated. It contributes no V3 score or reward.
- **Restoration puzzle:** optional content only. It may produce local achievements, but no V3 score unless a future reviewed verifier specification defines explicit, replayable evidence.
- **World Tree:** do not discard confirmed contributions when an incremental run is abandoned. If V3 later accepts contributions, use unique event-level IDs (chain, contract, wallet, run ID, contribution nonce/type) and once-only consumption, following V2's replay-protection pattern. CP remains a separate rebirth award and should not be double-counted as a World Tree contribution.

## 9. Threat model

| Threat                                                | Control                                                                                                                         | Residual risk                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Modified IndexedDB / forged Nature                    | Verifier replays accepted commands; ignores client snapshot and client time                                                     | Local display can be cheated; unsubmitted progress is not wallet-eligible                        |
| Fabricated score or huge exponent                     | Server computes normalized bounded score; contract caps it and verifies signer                                                  | Compromised verifier/attester can authorize bad scores                                           |
| Manipulated device clock                              | All scoring time comes from server; season acceptance from `block.timestamp`                                                    | RPC/server clock health still matters; chain timestamp has bounded validator influence           |
| Repeated checkpoint / duplicate rebirth               | Strictly increasing checkpoint tier, one active attestation per wallet nonce, atomic nonce consumption, terminal rebirth status | User may pay gas for a duplicate transaction; it cannot award twice                              |
| Signature replay across wallets/runs/chains/contracts | EIP-712 domain + explicit wallet/run/season/chain/contract/action fields + nonce + signer epoch                                 | Signing-key compromise permits valid-looking signatures until rotation/pause                     |
| Automated farming / bots                              | Server legality, elapsed-time production, rate limits, per-wallet caps, anomaly monitoring                                      | No reliable human proof; bot/Sybil resistance is an operational policy, not a contract guarantee |
| Reorg / ambiguous tx result                           | Confirmations policy; reconcile run/nonce/balances by reads; idempotent retry                                                   | Recent confirmations can reorganize; frontend must not finalize too early                        |
| Verifier database rollback                            | Durable transactional event log, unique constraints, backups, reconciliation against chain events                               | Database operator remains trusted; chain state is final authority for issued rewards             |
| Owner/attester compromise                             | Separate keys, multisig owner, delayed two-step signer rotation, pause, bounded formulas                                        | Admin can pause; attester can still authorize capped bad rewards                                 |

## 10. Deployment and migration considerations

- Deploy a **new, separate V3 contract**; do not upgrade, overwrite, or alter V1/V2. Use a fresh-state testnet deployment first. No V1 balance migration is specified or implied.
- Choose a chain and chain ID explicitly before deployment. A Hemi Sepolia V3 deployment is a later authorized action, not part of this design task. Never reuse a V1/V2 address or attester configuration by assumption.
- Owner should be a multisig; attester should be a separate service key stored in a managed secret store/HSM where available. Never put signing material in `VITE_` variables, source, logs, `.env.example`, or browser code.
- The verifier database stores run state and accepted command history, not private keys in its application tables. Use unique constraints for command IDs, wallet/run/nonce attestation jobs, and chain event reconciliation. Back up and test restore.
- Contract verification must publish exact compiler settings, source, ABI, EIP-712 type string, rules version, reward constants, and signer/owner addresses. Keep a deployment manifest with chain ID, address, deployment transaction, bytecode hash, and initial role values.
- V3 accounts start empty. No guest save import, V1/V2 balance migration, Gold conversion, or historical CP import. A migration requires a separate snapshot format, eligibility rule, replay policy, and approval.

## 11. Implementation sequence after this specification

1. Implement the pure integer rules package and shared client/verifier test vectors. Define the canonical command schema, atom rounding, score boundaries, and rules build hash before exposing wallet actions.
2. Build a local verifier with disposable keys and transactional persistence. Test authentication challenges, ordering/idempotency, concurrent commands, restart/backup recovery, offline queue handling, and season rollover. No public service or production secrets.
3. Implement a separate immutable V3 contract with EIP-712 checks, typed run/season/nonce state, atomic upgrade settlement at start, checkpoint-only Record Points, one-time rebirth settlement, terminal abandonment/expiry, controlled attester rotation, and append-only rules versions. Add adversarial/fuzz tests for duplicate reward attempts and transaction-order races.
4. Integrate the frontend so local guest play remains usable, while wallet-linked state reconciles to the verifier and chain before presenting confirmation.
5. Complete local full-stack recovery/security QA, then request separate authorization for testnet deployment and any remote verifier infrastructure. Mainnet remains a distinct later gate.

## 12. Remaining approval and policy items

The architecture decisions listed by the user are incorporated and do not need re-approval. The only economy decision intentionally left open is the actual values in each `rulesVersion`: rebirth threshold, PP/CP base and step values, and caps. Set these after the project's own gameplay balancing; never silently change a deployed version. Before a public verifier launch, also set operational (non-economy) limits such as command rate limits, attestation TTL, season-closing safety window, and minimum useful time for a new run. These should be documented/versioned and tested, but do not require changing the approved trust or transaction model.

No V3 contract or verifier implementation is included in this milestone.
