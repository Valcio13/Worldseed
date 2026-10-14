# Hemi game contract

## Implemented MVP interface

`contracts/WorldseedGame.sol` is the single game ledger. It pins one `uint32` seed per wallet and generator version 1, grants 1 Water and 1 Grass once, and replays bounded ordered actions. The browser submits at most 20 actions per `saveProgress` transaction. `finishIsland` replays an optional tail of at most 20 actions, independently checks region unlocks, 12 healthy habitats, 3 healthy Forest tiles and a Forest adjacent to the Heart, then awards 2 completion points.

Each action is one byte: `cellIndex * 4 + habitatCode`, where 0 gathers/removes, 1 places Water, 2 places Grass and 3 places Forest. Cell indexes are row-major. The static contract eligibility mask matches the v1 generator's placeable cells: the 5×5 interior in columns 1–5 plus the four witness shoreline cells. Cosmetic rocks are confined to the non-placeable Heart coast.

Four one-time region unlocks add one point each to the current World Tree week. A finished island adds two points, for a maximum of six. Weeks start Monday at 00:00 UTC. The fixed display target is 100 points. `weeklyContributions` and `weeklyCompletions` are authoritative contract state; the browser reads current-week contribution totals.

## Security and trust boundary

- The contract checks resources, placement bounds, orthogonal health, progressive unlocks, once-only rewards, cursor order, batch size and completion. A revert is atomic.
- A wallet can start once. There is no admin role, mint authority, upgrade path or backend signer in this prototype.
- The seed selects deterministic cosmetic terrain only; the gameplay-safe cell mask is fixed. This deliberately keeps Solidity and TypeScript eligibility aligned, while the verifier tests their common completion witness.
- No external transaction provenance is attested in this MVP. The direct seed is user-selected and is not a trustless proof of another chain's transaction.
- The snapshot hash is emitted with completion for later indexing; contract predicates, rather than that hash, determine completion.

## Puzzle and economy foundation

`startPuzzleRound(mode)` accepts modes 0–2, allows one active round per wallet, spends one of five stamina (one regenerates each 30 minutes), and initializes the board from a chain-derived seed plus the wallet round nonce. `savePuzzleMoves(expectedMoves, directions, cashOut)` accepts at most 20 direction codes per transaction and replays each move and spawn in Solidity. Invalid no-op directions do not advance the move cursor. A requested cashout requires at least 20 valid moves; natural game-over or the 200-valid-move ceiling settles automatically. Contract-computed integer Gold is credited once. `buyHabitat` atomically debits the non-transferable Gold balance and credits Water, Grass, or Forest inventory. These mechanics have passed local contract tests and direct Hemi Sepolia transactions; a clean connected-browser wallet journey is still outstanding.

The shared TypeScript engine and Solidity replay use identical board orientation, merge rules, xorshift32 RNG, and mode spawn weights. Gold factors, mode labels, stamina cadence, and shop prices are initial balancing values, not testnet-validated economy parameters.

## Remaining verification

Local Hardhat tests cover one-time starter claims, stale cursors, locked cells, resource conflicts, the shared v1 completion witness, the six-point contribution, and puzzle checkpoint replay, stamina, and settlement. Contract `WorldseedGame` is deployed at `0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4` on Hemi Sepolia (chain ID `743111`) and has an exact creation/runtime match on Sourcify. Direct test transactions have measured actual network gas, but these do not replace testing with a separate connected browser wallet. See [`deployment.md`](deployment.md) for the QA checklist and measured 2048 round total.
