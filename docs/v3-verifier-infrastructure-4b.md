# V3 Verifier Infrastructure Foundation (Milestone 4B)

This document records the local infrastructure foundation. It does not deploy a verifier, implement the V3 Solidity contract, connect a player UI, or authorize wallet rewards. The approved protocol and reward semantics remain in [the V3 design](./v3-contract-and-score-verification-design.md).

## Durable store

`src/incremental/server/sqliteVerifierStore.ts` uses the SQLite implementation built into Node 22 (`node:sqlite`). The server code is isolated under `src/incremental/server/`; the browser app neither imports nor bundles Node modules. The store enables foreign keys, WAL, `synchronous=FULL`, and a 5-second busy timeout. Command acceptance uses `BEGIN IMMEDIATE`, a compare-and-swap on the run head, and unique `(run, sequence)` and `(run, command_id)` constraints. The command envelope, accepted state, credited/spent atom strings, server timestamp, run head, and idempotency key commit atomically.

Challenges, hashed session tokens, attestation nonce reservations and winning signatures, and chain recovery checkpoints are stored in the same database. SQLite serializes competing writers; the uniqueness/CAS conditions make a duplicate or competing command fail without advancing state. Reserving requires the observed contract nonce and signer epoch to match the requested payload at the exact current healthy checkpoint hash. A reservation cannot be marked consumed until the confirmed nonce is exactly incremented under the same epoch, or cancelled until that nonce remains unused and the payload expires (or a confirmed signer rotation invalidates it). A higher confirmed signer epoch replaces an unconsumed old-epoch reservation and clears its stored signature. The winning signature is persisted once per digest and reused after concurrency or restart. This is a local adapter contract; a future service must ensure observations come only from the configured chain reader.

SQLite is a practical, low-operations choice for one small Node-hosted verifier with a persistent disk and a tested backup/restore process. It is **not compatible with Cloudflare Workers' filesystem/runtime model** and this implementation does not configure a host or public service. If Worldseed chooses Workers, the adapter needs to be replaced by a transactional remote database (for example, D1 with appropriate transaction/serialization design) and tested for its actual concurrency semantics before deployment. Do not copy this SQLite file into a static build.

## Wallet authentication and sessions

`SqliteWalletSessions` issues a cryptographically random challenge bound to the claimed EVM address, configured chain ID, V3 contract, run ID, allowlisted origin, issued time, expiry, challenge ID, and a 256-bit nonce. The claimant signs the complete message. EOA recovery must match the claimed address; contract-wallet validation is delegated to the chain-specific EIP-1271 reader. Challenge consumption and session insertion are one SQLite transaction, so a concurrent replay can create at most one session.

Sessions are random 256-bit bearer tokens with a 15-minute default TTL. Only SHA-256 token hashes are stored. Authentication returns the address/chain/contract/run/origin from the stored session, never from a command request. Default challenge lifetime is five minutes. Deployments and origins are allowlisted configuration. The browser must keep the bearer token out of URLs, logs, analytics, and persistent guest saves; transport-level HTTPS, rate limiting, origin/CORS enforcement, CSRF policy, and abuse monitoring remain responsibilities of a future HTTP service.

## Authoritative chain reads and reorganization handling

`V3ChainStateReader` accepts an explicit viem `Chain`, RPC URL, contract address, deployment block, confirmation count, and checkpoint store. It verifies RPC chain ID, requires confirmed bytecode at the configured contract, reads all required state at a single confirmation-safe block, and checks:

- the wallet's active run ID and run status;
- run owner through the player-keyed contract mapping;
- current and run season IDs and the confirmed block timestamp;
- run start time and rules version;
- seasonal rebirth count, PP, and upgrade levels;
- the exact upgrade-choice array in the confirmed `RunStarted` log and its recomputed commitment.

The reader stores a confirmation-safe canonical head hash. On each request it checks the stored block hash against the configured RPC, obtains the new confirmed head, and advances with a D1/SQLite compare-and-swap. This avoids one RPC and D1 write per block after downtime. A provider failure, checkpoint mismatch, chain-ID mismatch, missing/ambiguous event, concurrent checkpoint race, or changed confirmed head returns no run context/nonce. Reorganizations fail closed; recovery must re-establish a canonical checkpoint before accepting attestations.

The reader intentionally targets the **proposed** V3 ABI, not an existing deployed contract. The current proposal does not yet fully standardize event fields or status enum values. The adapter's compatibility assumptions are:

- the deployment supplies the confirmed active run status enum value explicitly (the test harness uses `1`);
- `RunStarted` emits the committed sorted choices as `(uint8 upgradeId,uint16 quantity)[]` as well as player, run/season IDs, rules version, commitment, and start time;
- `attestationNonce`, `signerEpoch`, `seasonalRebirths`, `currentSeasonId`, `activeRunId`, `runs`, `seasonalPP`, and `seasonalUpgradeLevel` have the signatures in `V3_READ_ABI`.

These must be approved and matched byte-for-byte in the future contract and Solidity tests. The event scan currently starts at deployment and may hit provider log-range limits; production should index or persist a verified event cursor, with chain reconciliation retained.

## Upgrade commitment and attestations

`upgradeChoices.ts` fixes the commitment encoding as `keccak256(abi.encode(UpgradeChoice[]))`, where each struct is exactly `uint8 upgradeId, uint16 quantity`. IDs are growth `0`, efficiency `1`, awakening `2`, rebirth `3`; entries must be strictly ascending and unique. The published known vector is in `src/incremental/v3TestVectors.json` and is also exercised by the unit test. `rulesV1.ts` exports the same triangular PP cost used to reverse-check the confirmed post-start PP balance and levels against the committed choices.

`attestations.ts` builds and verifies EIP-712 `ScoreAttestation` data using domain name `Worldseed V3`, version `1`, and the exact fields in the approved specification. It validates Solidity widths, deployment chain/contract, action-specific score/hash rules, maximum lifetime, and season expiry. Signing keys are not accepted or stored by this module. Tests use only a deterministic disposable fixture key. A later signer must reserve the exact `(chain, contract, wallet, nonce, digest)` in durable storage before signing and reconcile unknown transaction outcomes against chain state.

## Cross-language vectors

`src/incremental/v3TestVectors.json` publishes decimal-string vectors for score boundaries and saturation, habitat and PP costs, weekly season boundaries, and ABI encoding/hash. Solidity tests should consume the same JSON or copy these exact constants and prove equality against `abi.encode`, `keccak256`, and the V3 score library. `v3TestVectors.test.ts` checks the TypeScript implementation against the published cases. Integer Nature values are strings; the saturation vector represents `10^9375` atoms as an exponent so implementations can construct it with arbitrary-precision integer arithmetic.

## Remaining blockers before Solidity implementation

1. Review/approve the proposed ABI and `RunStarted` event payload, status enum, and exact seasonal upgrade getters.
2. Decide the initial verifier host/database. SQLite is local/self-hosted Node only; Cloudflare Workers needs a different durable adapter.
3. Specify transport-level origin/session protections, request rate limits, backup/restore, and operational recovery procedures.
4. Add a Solidity-compatible interface harness and cross-language contract tests after the ABI is approved.
5. Define the deployment/attester rotation operational process; this milestone creates no signer or service.
