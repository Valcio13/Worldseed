# Worldseed Contract V2 — H3 Local Implementation

This document records the local H3 implementation for review. It is not a deployment authorization. V1 remains a separate testnet reference; V2 is fresh state and has no V1 progress, Gold, or balance migration.

## H2/H3 encoding reconciliation

H2 signs `CandidateSet` with EIP-712 domain name `Worldseed Candidate Set`, version `2`, chain ID `743111`, and `verifyingContract` equal to the V2 address. The Solidity type string and all fields match `src/expeditions/model.ts`: player, sequential expedition number, source commitment, fixed three-seed array, combined character seed, three generator/policy versions, issue time, and expiry. EIP-712 array members are hashed before the containing struct hash; `candidateSetDigest` does this and has a digest-parity test against viem. The three source transaction records themselves are represented by the signed `sourceCommitment`; the contract trusts the authorized attester's source/finality checks.

The H2 `commitment` value is the EIP-712 digest, not a member of the signed struct. Selection persistence is a separate wallet-signed EIP-191 D1 record. The contract does not rely on that record: its caller selects index 0–2 in `startExpedition`, and the transaction sender is the player. The attestation signs all three ordered candidate seeds, so the selected index cannot be changed to an unattested seed.

H2 previously emitted `expiresAt = 0` and only issued expedition 1. H3 changes the same schema's expiry policy to seven days; signatures with zero expiry are rejected. Candidate issuance and selection requests now carry sequential expedition numbers. An expired persisted set can be re-attested only with its exact stored source transactions and exact same three seeds; it cannot be rerolled. The currently deployed/previous Pages Function has not been deployed with these changes.

## Contract API

Implemented in `contracts/WorldseedGameV2.sol`:

- `startExpedition(CandidateSet,uint8,bytes)` verifies player, expected sequence, chain/domain, authorized signer, version, expiry, selected index, and unused EIP-712 digest. It returns a monotonically increasing player-scoped expedition ID and grants a run-scoped starter Water and Grass.
- `saveProgress(expeditionId,cursor,actions)` reuses V1 action encoding, legal-cell mask, adjacency/health rules, unlock thresholds, region rewards, and 20-action batch bound.
- `finishExpedition(expeditionId,cursor,actions,snapshotHash)` applies the final action tail and independently checks the V1 completion predicate. Completion is terminal and adds the same two community points as V1.
- `abandonExpedition(expeditionId)` is terminal, forfeits run inventory and unspent actions, and clears an unfinished rewarded puzzle round without settling it. It does not alter settled Gold or confirmed World Tree events.
- `expeditionState` and `expeditionBoard` expose authoritative recovery state.
- `buyHabitat(expeditionId,habitat,quantity)` spends persistent Gold and credits only that active expedition's inventory. On abandonment the spend is not refunded and the habitat is forfeited.
- `startPuzzleRound(expeditionId,mode)` and `savePuzzleMoves` preserve V1 stamina, board, score, batching, cash-out and Gold formulas. Settled Gold is account-level; an unfinished round is forfeited if its expedition closes.
- `contributeWorldTree(expeditionId,1)` allows one explicit one-point contribution per run. It uses a contract-generated per-player nonce and event ID. Region unlocks and completion retain their V1 automatic point awards. Contributions remain in weekly totals after abandonment.
- Owner transfer and attester rotation are two-step. The owner can pause/unpause state-changing entry points. Abandonment remains available during a pause because it only closes and forfeits a run; it cannot grant resources, Gold, or World Tree rewards. Starting or progressing another run remains blocked until unpause.

`nextExpeditionNumber[player]` stores the last accepted number (zero before the first run); the next required number is value + 1. `nextExpeditionId[player]` is monotonic and independent. A new set is accepted only when there is no active run and the number matches. There is no time cooldown; unique signed sets and sequential consumption prevent a free reroll within an expedition. Abandonment can begin the next expedition immediately after terminal confirmation.

All run resources are isolated by `(player, expeditionId)`. Starter grants recur only when a new attested run is accepted; abandoned inventory is permanently unreachable. Region claims are one-time per expedition. Persistent account Gold cannot be minted by abandonment. V2 puzzle settlement is the only Gold source in this implementation and follows the V1 reward formula exactly.

## Generator and recovery

The chosen bytes32 candidate seed is retained onchain and fed to `generateIslandV2`. Preview and active UI use this same generator; it preserves the shared 7×7 placement mask, witness cells, adjacency rules, and completion route. State reads reconstruct habitats, inventory, region unlocks, claims, and cursor after refresh. Local queued actions remain advisory and are replayed against contract state only when the matching wallet/cursor is recovered.

## Deployment configuration (not executed)

The guarded V2 command is `npm run contract:deploy:v2:testnet`. It refuses any chain ID other than `743111`. Configure `HEMI_SEPOLIA_RPC_URL` and `HEMI_SEPOLIA_PRIVATE_KEY` for the deploying test wallet, plus `HEMI_V2_OWNER_ADDRESS` and `WORLDSEED_ATTESTER_ADDRESS`. The Pages candidate service additionally needs its D1 binding, `ETHEREUM_SEPOLIA_RPC_URL`, `HEMI_SEPOLIA_RPC_URL`, `BITCOIN_TESTNET4_API_URL`, `WORLDSEED_V2_CONTRACT_ADDRESS`, and `WORLDSEED_ATTESTATION_PRIVATE_KEY` in server-side settings. The attestation key must be stored as a hosting secret and correspond to the initial onchain attester. The browser needs only public `VITE_WORLDSEED_V2_CONTRACT_ADDRESS`.

No contract has been deployed. A local Hardhat test chain may use the Hemi EIP-712 domain for test signatures; public calls are accepted only on Hemi Sepolia. V1 deployment scripts and addresses remain separate.

## Review limitations before Sepolia deployment

- The source service is a trusted testnet oracle: Solidity cannot prove Ethereum Sepolia/Hemi Sepolia/Bitcoin Testnet4 finality. Independent signer custody and monitoring remain operational requirements.
- H2 D1 Pages Functions have not been deployed or end-to-end tested against a V2 deployment; idempotent issuance and signature renewal need a deployed D1 test.
- The new UI state flow is wired behind `VITE_WORLDSEED_V2_CONTRACT_ADDRESS`, but a live wallet/browser transaction journey cannot be verified until the V2 contract and Pages Functions are deployed. No user wallet was connected during this milestone.
- Attester rotation and owner pause are controlled by single addresses with two-step acceptance, not a multisig or timelock. Select those keys deliberately before deployment.
- `contributeWorldTree` is intentionally limited to one explicit point per expedition; changing contribution economics requires a new reviewed version.
- No V1 balances, puzzle state, or island progress are migrated.

Review Solidity, accounting, attestation format, and this test report before authorizing a Hemi Sepolia deployment. No Mainnet deployment is covered by this implementation.
