# Current gameplay

## Weekly incremental loop

- Start each Monday 00:00 UTC season with a fresh Nature run. The season lasts exactly seven days.
- Click the Island Heart to generate Nature, then purchase Water, Grass, and Forest habitat levels to produce Nature automatically.
- Habitat adjacency and production milestones strengthen output. Temporary upgrades expire normally and are cleared at the weekly reset.
- Rebirth is the main progression loop. It resets run Nature, habitats, temporary upgrades, seasonal PP/CP, PP upgrades, and seasonal rebirth count. A rebirth grants simulated guest PP and CP; CP is not granted by habitat purchases.
- Spend seasonal PP on upgrades to accelerate later runs in the same season. PP and its upgrades reset next Monday.
- Lifetime CP, lifetime rebirths, achievements, Nature history, and archived season summaries remain local to the browser. They are not verified or transferable.
- Optional Record Points transactions and verified seasonal CP are not implemented yet. They belong to the reviewed V3 milestone, not guest progression.

Offline Nature is local and unverified. It uses the saved production state, is capped at eight hours, and is not applied when the save crosses a season boundary.

## Island

- Grid: 7×7, five sequential regions: Clearing, Dry Basin, Forgotten Grove, Broken Highlands and Island Heart.
- One-time starter grant: 1 Water and 1 Grass. The contract eligibility mask is fixed: all 25 interior cells in columns 1–5, plus four witness shoreline cells.
- Water is healthy. Grass is healthy when orthogonally adjacent to Water. Forest is healthy when adjacent to Water and at least one healthy Grass.
- Unlock thresholds by currently healthy habitats in accessible regions: 2, 4, 7 and 10. Rewards are once per region/cycle and initially target +1W/+2G, +2F/+1G, +1W/+2G and +1W/+1F.
- Heart landmark and Heart-region cells are non-placeable. Finish requires all regions unlocked, 12 healthy habitats, 3 healthy Forest and a healthy Forest adjacent to Heart. A healthy Forest already touches Water and healthy Grass by definition, so this endpoint condition also implies a local Water-to-Forest path.
- Removing a habitat returns one unit. Region claims are permanent; rewards cannot be claimed twice. Wallet actions remain local until synchronized in batches of at most 20. The interface stores the unsaved action queue in this browser and recovers confirmed state from the contract.

## Optional restoration scene

The 7×7 restoration scene and its placement puzzle remain optional content. Guest play is saved locally and does not submit transactions, grant wallet inventory, or contribute to the World Tree.

## Island controls and scene

Choose Water, Grass, or Forest from the pouch, then hover a logical cell for a valid/invalid placement preview and health hint. Select Remove to gather or Inspect to read tile details. Left-click performs the selected action; right-click or Escape returns to Place. When not placing, drag the scene to pan; the wheel and on-scene buttons zoom within camera bounds. Touch users can tap tools/cells and use the visible zoom controls. The terrain art and residents are presentation-only: the island remains the same deterministic 7×7 logical board.

Residents wander one safe adjacent step at a time, pause occasionally, avoid water/shore/rocks and locked regions, and sometimes visit healthy habitats. Additional animals, villagers, and a forest spirit appear as restoration progresses. They pause when the browser tab is hidden. Placement and unlock effects are short and skippable; generated soft chimes can be muted from the HUD.

## World Tree

One global week starts Monday 00:00 UTC. Four region claims award one point each; Finish awards two. The shared contract counter is authoritative and the display target is fixed at 100 points per week. Historical archive and adaptive targets are deferred.
