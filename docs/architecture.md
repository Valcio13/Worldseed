# Architecture

## MVP boundaries

- **Frontend:** React, TypeScript and Vite. A CSS-rendered island diorama keeps the fixed 7×7 logical board as accessible buttons while layering cosmetic terrain, inhabitants, effects, and landmarks around it. CSS camera transforms provide zoom/pan without changing pointer-to-cell rules or generator state. The lightweight scene avoids a canvas loop and keeps gameplay in the existing DOM renderer.
- **Game logic:** pure TypeScript functions generate the v1 board, validate actions, calculate orthogonal health, award one-time unlock rewards, and evaluate Heart completion.
- **Wallet and chain:** wagmi/viem target Hemi Sepolia. A connected wallet may start one permanent island, queue actions locally, send bounded Save Progress batches, and finish with a bounded tail. Contract state is the recovery source for confirmed progress.
- **Persistence:** guest state is stored in IndexedDB. Unsaved wallet action tails are stored in browser localStorage and replayed over the last confirmed contract snapshot.
- **Contracts:** one Solidity ledger checks action resources, safe cells, health rules, milestone unlocks, sync cursor and completion. World Tree points accrue in the same successful transactions as milestones and Finish.
- **Legacy puzzle code:** the existing puzzle engine, wallet UI source, contract methods, and tests are temporarily retained for compatibility/reference. They are not mounted from the current app navigation and do not participate in the weekly incremental progression. No new puzzle rewards are planned for the five-milestone roadmap.
- **Island atmosphere:** client-only residents use occasional safe adjacent steps, reveal as ecology recovers, and pause while the tab is hidden. Their positions never affect action hashes, habitat health, or contract state. Optional placement and unlock chimes use short synthesized tones after a user gesture; the sound toggle is stored locally.

## Generation agreement

Generator version 1 pins a uint32 seed. The same seed deterministically chooses decorative rocks in the non-placeable Heart region. Gameplay-safe cells are fixed and mirrored in Solidity. The executable witness is tested over six representative seeds and keeps witness cells placeable over 100,000 generated seeds. The witness's encoded action sequence is also replayed by the Solidity contract test.

The contract does not attest external transaction provenance, and the seed is not derived from another chain in this MVP. It does not claim trustless cross-chain proof.

## Transaction lifecycle

1. Start Island permanently stores the seed and grants the one-time starter resources.
2. Local wallet edits append compact actions to the local tail. Guest edits remain isolated and never reach the contract.
3. Save Progress submits up to 20 ordered actions. The contract replays them, processes one-time region rewards and increments the cursor atomically.
4. Finish Island replays a tail of at most 20, checks the complete current layout and adds the two-point completion contribution.
5. The current incremental loop is guest-local: Nature and habitat levels advance in the browser, and only rebirth grants simulated guest PP/CP. No guest point is treated as a wallet reward. The legacy V1 puzzle functions remain separate and are not reachable through the active game UI.

Trading, backend candidate issuance, reorg-aware archive indexing, decorations, historical World Tree archive and adaptive weekly targets are deferred. Economy values remain provisional pending player review and testnet measurements.
