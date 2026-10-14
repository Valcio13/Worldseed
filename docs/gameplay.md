# Gameplay rules

## Island

- Grid: 7×7, five sequential regions: Clearing, Dry Basin, Forgotten Grove, Broken Highlands and Island Heart.
- One-time starter grant: 1 Water and 1 Grass. The contract eligibility mask is fixed: all 25 interior cells in columns 1–5, plus four witness shoreline cells.
- Water is healthy. Grass is healthy when orthogonally adjacent to Water. Forest is healthy when adjacent to Water and at least one healthy Grass.
- Unlock thresholds by currently healthy habitats in accessible regions: 2, 4, 7 and 10. Rewards are once per region/cycle and initially target +1W/+2G, +2F/+1G, +1W/+2G and +1W/+1F.
- Heart landmark and Heart-region cells are non-placeable. Finish requires all regions unlocked, 12 healthy habitats, 3 healthy Forest and a healthy Forest adjacent to Heart. A healthy Forest already touches Water and healthy Grass by definition, so this endpoint condition also implies a local Water-to-Forest path.
- Removing a habitat returns one unit. Region claims are permanent; rewards cannot be claimed twice. Wallet actions remain local until synchronized in batches of at most 20. The interface stores the unsaved action queue in this browser and recovers confirmed state from the contract.

## Guest demo

The guest island uses unlimited demo-only resources and IndexedDB persistence. It does not submit transactions, grant wallet inventory, or contribute to the World Tree.

## Island controls and scene

Choose Water, Grass, or Forest from the pouch, then hover a logical cell for a valid/invalid placement preview and health hint. Select Remove to gather or Inspect to read tile details. Left-click performs the selected action; right-click or Escape returns to Place. When not placing, drag the scene to pan; the wheel and on-scene buttons zoom within camera bounds. Touch users can tap tools/cells and use the visible zoom controls. The terrain art and residents are presentation-only: the island remains the same deterministic 7×7 logical board.

Residents wander one safe adjacent step at a time, pause occasionally, avoid water/shore/rocks and locked regions, and sometimes visit healthy habitats. Additional animals, villagers, and a forest spirit appear as restoration progresses. They pause when the browser tab is hidden. Placement and unlock effects are short and skippable; generated soft chimes can be muted from the HUD.

## 2048 and Gold foundation

The separate 4×4 puzzle is available from the island screen. Practice rounds are free, persist locally, and never submit wallet transactions. Rewarded rounds require a deployed Hemi Sepolia contract and connected wallet. The contract derives the initial board and RNG state from its round seed, then replays direction inputs; the browser's score and board are not trusted.

The three modes use exact 2/4 spawn weights of 95/5, 90/10 and 75/25. A rewarded round consumes one stamina (maximum five; one regenerates every 30 minutes, capped at five). Confirmed moves are checkpointed in batches up to 20. The player can cash out from 20 confirmed valid moves; game-over and the 200-valid-move ceiling settle automatically. Rewards use integer Gold: `floor(score × mode factor)`, with factors 3/8, 1/2 and 5/8 for Relaxed, Standard and Challenging. Gold is non-transferable in this foundation. The Grove Keeper shop can spend committed Gold on Water (2,000), Grass (1,000), or Forest (3,000) and credits the existing onchain island inventory atomically. These provisional prices and reward parameters require playtesting before release.

The puzzle seed uses the previous block hash and per-wallet round nonce. This is sufficient for verifiable replay in this MVP, but is not a commit-reveal or bias-resistant randomness design. Do not represent it as such.

## World Tree

One global week starts Monday 00:00 UTC. Four region claims award one point each; Finish awards two. The shared contract counter is authoritative and the display target is fixed at 100 points per week. Historical archive and adaptive targets are deferred.
