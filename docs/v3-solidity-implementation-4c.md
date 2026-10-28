# V3 Solidity Implementation (Milestone 4C)

This is a local implementation record for `contracts/WorldseedGameV3.sol`. It is a separate, undeployed contract. V1/V2, the frontend, and the public site were not changed. The controlling protocol remains [the approved V3 design](./v3-contract-and-score-verification-design.md), with verifier-side arithmetic and persistence documented in [the 4A foundation](./v3-local-verifier-foundation.md) and [4B infrastructure](./v3-verifier-infrastructure-4b.md).

## Contract interface and verifier compatibility

The contract implements `startRun(ScoreAttestation, UpgradeChoice[], bytes)`, `recordPoints(ScoreAttestation, bytes)`, `rebirth(ScoreAttestation, bytes)`, and `abandonRun(uint64)`. `ScoreAttestation` follows the exact EIP-712 field order and widths in `src/incremental/server/attestations.ts`; the EIP-712 domain is `Worldseed V3`, version `1`, current chain ID, and this contract. Action values are `START_RUN=1`, `RECORD_POINTS=2`, `REBIRTH=3`. The contract checks the duplicated chain/contract fields as well as the domain.

The public `runs(player, runId)` getter returns `(uint64 seasonId, uint8 status, uint64 startedAt, uint16 lastRecordedScoreTier, uint32 rulesVersion, bytes32 upgradeChoicesHash)`, with `ACTIVE=1`, matching `V3_READ_ABI`. The public getter `seasonalHighScoreTier(player, seasonId)` exposes the Model C CP high-water alongside the existing season balance and run reads. `RunStarted` emits the committed canonical choices as `(uint8 upgradeId,uint16 quantity)[]` in the event shape consumed by `v3ChainReader.ts`.

Upgrade IDs remain growth `0`, efficiency `1`, awakening `2`, rebirth `3` for compatibility. Verified V3 Start Run accepts only IDs 0–2; ID 3 is rejected because it has no gameplay benefit. Choices must be strictly increasing by ID, unique, nonzero, within the per-version level cap, and affordable. Their commitment is exactly `keccak256(abi.encode(choices))`; the empty list therefore has its canonical nonzero ABI hash. Upgrade cost is the shared triangular formula `quantity * (2 * currentLevel + quantity + 1) / 2`. PP is charged and levels applied atomically with run creation.

The contract does not calculate Nature or normalize cumulative Nature into a score. The verifier replays the shared integer rules and submits only a bounded `uint16 scoreTier`. The V3 boundary is exactly `0..65,535`; the published TypeScript vectors continue to verify normalization, including saturation, while Solidity tests verify the maximum tier and the contract's encoded field bound.

## Season and transaction behavior

Season IDs use `floor((timestamp - 345600) / 604800)`, the Monday 00:00 UTC convention used by the guest season code. `seasonIdAt` and the contract tests compare the published boundary vectors; `seasonEnd` returns the exclusive end. Attestations must be issued no later than the current block time, remain unexpired, have a lifetime no longer than 300 seconds, and expire no later than that season's end. The 300-second maximum matches the local verifier test policy and must be configured identically by a future service.

Only successful starts consume a run ID and nonce. A failed or expired call reverts all writes. Record Points strictly advances the checkpoint and awards no points. Rebirth may settle a score at or above the latest checkpoint without a prior Record Points transaction. PP uses the existing formula; CP awards one point per newly crossed seven-tier seasonal milestone above the run threshold and shared seasonal high-water. Repeated milestones award zero. High-water and point updates are atomic. Seasonal caps partially limit awards and do not block a valid Rebirth. A same-season active run blocks another start. A stale active run is marked `EXPIRED` when the player starts a new-season run. Abandonment grants nothing and remains callable while paused; a post-season abandon finalizes as `EXPIRED`.

## Administration and provisional rules

Constructor owner and attester must be distinct. Ownership transfer is two-step. Attester rotation is two-step with a two-day delay; acceptance increments `signerEpoch`, invalidating outstanding signatures. Only the owner may pause/unpause. Pause blocks starts, checkpoints, and rebirth, while no-reward abandonment remains available. Append-only reward versions require a two-day proposal delay and cannot rewrite an existing version.

Rules version 1 values are deliberately **provisional**:

| Parameter                             |                   Provisional value |
| ------------------------------------- | ----------------------------------: |
| V1 Rebirth threshold tier             |                                  35 |
| V2 Rebirth threshold tier             |                                  42 |
| PP base / tier step / per-rebirth cap |                      1 / 10 / 1,000 |
| CP award                              | 1 per new 7-tier seasonal milestone |
| Seasonal PP / CP caps per player      |                   100,000 / 100,000 |
| Aggregate season CP cap               |                           1,000,000 |
| Maximum upgrade level                 |                                 100 |

PP remains `min(cap, base + floor(max(0, S - T) / step))`. CP counts new multiples of seven in `(max(T, seasonalHighScoreTier), S]`, limited by remaining player and season capacity. A valid Rebirth settles even when only part or none of the calculated PP/CP fits under a cap. The V2 threshold is configured through the existing delayed proposal and activation flow. CP is separate from World Tree contributions.

## Local verification

`contract-test/WorldseedGameV3.test.js` exercises the published season and upgrade commitment vectors, EIP-712 digest parity, start/checkpoint/rebirth, no-checkpoint rebirth, signature binding and expiry, replay/nonce behavior, failed-call retry, upgrade validation/overspend, season rollover, abandonment, pause, and delayed attester rotation. Tests use Hardhat disposable accounts only.

No deployment, frontend wallet integration, remote infrastructure, browser test, or gameplay/economy simulation was performed. This implementation has not received an independent audit. Before any testnet use, review the proposed ABI and provisional reward configuration, ensure the future verifier's 300-second policy and event parsing match, run a deployment-specific review, and test against a disposable chain deployment.
