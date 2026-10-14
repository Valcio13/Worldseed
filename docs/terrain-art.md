# Terrain Art Pipeline

The island is a square 7×7 garden rendered into a canvas beneath the existing 49 logical cell buttons. The buttons remain the interaction and accessibility layer; terrain art never changes game state or coordinates. The canvas uses a 224×224 source resolution: each logical cell is exactly 32×32 source pixels. Art is authored on a 16×16 unit grid and doubled with nearest-neighbor scaling, preserving crisp single-pixel seams and details at normal board sizes. This gives one consistent pixel density for grass, water, forest, damaged ground, and the Island Heart.

## Art direction and palette

The renderer draws crisp pixel clusters directly with the Canvas 2D API. Flat, harmonious colors use a restrained palette: grass `#89c273`–`#94cc7b`, water `#5eb2bc`–`#68bec4`, forest `#70a86d`–`#79b274` with deep green canopies, and damaged soil `#b39467`–`#bda071`. Cream flowers, blue-green ripples, small tree shadows, and a compact golden heart tree provide accents. A quiet one-source-pixel seam helps players read tile targets while keeping neighboring terrain visually continuous. Locked cells use a light mist overlay.

Cosmetic color and detail variations are deterministic from the island seed and cell coordinates. Water ripples animate on a short timer without affecting game state. The island footprint is always square; no coast art covers or crops playable cells. The selected and hovered cells use the existing interaction outline.

## Assets

No external image files are required by the terrain renderer. Older generated atlas and texture files remain in `public/assets/terrain/` and `public/assets/landmarks/` for historical reference, but are not loaded by the current renderer. New art belongs in the renderer as small integer-aligned pixel clusters or in a consistent 32×32-per-cell sprite atlas. Keep the palette, top-down perspective, single-pixel detail scale, and nearest-neighbor display rule consistent.

## Validation

`terrainArt.test.ts` covers terrain-to-art mapping and seed-stable cosmetic variants. `islandPresentation.test.ts` verifies square-grid coordinate mapping and camera pan bounds. The UI retains one button per generated cell, so mouse, touch, keyboard, inspection, placement, and removal stay on the existing logical grid.
