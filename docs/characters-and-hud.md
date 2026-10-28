# Living Characters and Game HUD

The island's 7×7 board, restoration rules, and contract interfaces remain unchanged. The HUD now keeps habitat selection, health, local/onchain save status, and region details available without a permanent sidebar. `Regions & details` opens the former inventory, milestone, Heart, and World Tree dashboard in a keyboard-dismissable side panel. Settings and the tutorial open game-style dialogs. The Merchant and World Tree stay in the landmark strip outside the placement grid. The old Seed Shrine entry point has been removed with the puzzle from the active game interface.

## Character sprites

`public/assets/characters/worldseed-characters.png` is a transparent 192×96 RGBA sprite sheet with six columns and three 32×32 animation rows: idle, walk A, and walk B. Columns are caretaker, merchant, wandering villager, slime, woodland creature, and forest spirit. The sheet is original AI-generated pixel art; its 1774×887 source is preserved at `art/characters/worldseed-character-sheet-source.png`. Run `python scripts/build-character-sprites.py` (Pillow required) to rebuild the crisp 192×96 nearest-neighbor sheet.

The merchant sprite appears in the clickable Traveling Merchant landmark and its shop dialog. Island residents use the caretaker, wandering villager, slime, woodland creature, and forest spirit sprites. CSS uses nearest-neighbor scaling and sprite rows for walking; residents idle with small character-specific motion. Horizontal movement updates facing. The existing client-only mover still filters destinations to unlocked, walkable cells and pauses periodically. Residents appear progressively based on healthy habitat and forest counts, and only residents next to a changed cell react.

The canvas/button grid remains the gameplay hit target. Resident sprites use `pointer-events: none`; the landmark buttons and HUD controls stay semantic buttons with accessible names and pressed state. Motion remains covered by the global reduced-motion preference.
