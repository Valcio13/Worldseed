# Third-party artwork

## CraftPix: Free Island Adventure Pixel Top-Down Minigame Kit

- Pack: <https://craftpix.net/freebies/free-island-adventure-pixel-top-down-minigame-kit/>
- License: <https://craftpix.net/file-licenses/>
- Download reviewed: `craftpix-net-351300-free-island-adventure-pixel-top-down-minigame-kit.zip`
- Source image: `Tileset/Tiled.png` (624×500 px, 16 px Tiled grid, transparent PNG)
- Integration: selected unscaled sprite crops only; no full atlas or sample map is included.

| Worldseed file         | Source crop in `Tileset/Tiled.png` (x, y, w, h) | Use                      |
| ---------------------- | ----------------------------------------------: | ------------------------ |
| `pine-tree-small.png`  |                                240, 384, 32, 48 | Small pine decoration    |
| `pine-tree-thin.png`   |                                320, 384, 16, 48 | Narrow pine variation    |
| `leafy-tree-grove.png` |                               272, 432, 120, 64 | Multi-tree grove cluster |
| `bush-small.png`       |                                400, 464, 16, 32 | Small bush               |
| `bush-round.png`       |                                416, 464, 32, 32 | Round bush               |
| `bush-wide.png`        |                                448, 464, 32, 32 | Wide bush                |
| `flower-yellow.png`    |                                  16, 64, 16, 16 | Yellow flower            |
| `mushroom-redcap.png`  |                                  32, 64, 16, 16 | Red-cap mushroom         |
| `flower-white.png`     |                                  48, 64, 16, 16 | White flower             |
| `rock-pebble.png`      |                                 112, 48, 16, 16 | Small loose stone        |
| `rock-boulder.png`     |                                 144, 48, 16, 32 | Tall loose stone         |
| `terrain/grass-field-tile.png` |                         208, 440, 16, 16 | Default Living Island grass surface; composed palette-adjusted field tile |

The 256×256 grass tile uses the CraftPix 16×16 field crop as its source; the base and highlight colors are remapped to Worldseed green shades, then mirrored/rotated highlight patches are arranged on a matching solid base to soften repetition. The tile is the default grass surface at all four Living Island growth stages. Rounded clipping, the Worldseed soil edge and underside, and Worldseed water are retained.

The pack's `Licens.txt` points to CraftPix's license page. Its freebie terms permit use and modification in personal and commercial projects and distribution as part of a game; attribution is not required. The terms prohibit reselling or redistributing the source art, or making it separately usable through an app. These selected crops are used only as in-game decorations and Worldseed has no asset-export feature.

**Publishing concern:** selected PNGs in a public source repository and browser-delivered files are independently fetchable. The game-use permission appears to cover normal in-game use, but the terms do not clearly resolve public source-repository redistribution or whether individual browser asset URLs count as making source art separately usable. Confirm this point with CraftPix before public release. Do not label these files MIT-licensed.

## Pixabay background music

- Track: **Cozy Day** by **FASSounds**
- Source page: <https://pixabay.com/music/lofi-cozy-day-617663/>
- License: [Pixabay Content License](https://pixabay.com/service/license-summary/)
- Content ID: Registered (as shown on the track page)
- Local browser asset: `public/audio/cozy-day-617663.mp3`
- Use: Optional Living Island background music. The player opts in with **Play music**; the existing music-volume and mute preferences apply. Playback uses two audio elements with a short crossfade at the loop boundary when the browser reports track duration.
- Attribution: Pixabay's license does not require attribution, but Worldseed records the artist, title, source, and license here. This third-party track is not Worldseed-owned or MIT-licensed.

The MP3 is included only as game background audio. Do not offer it as a standalone download or redistribute it separately from Worldseed. The track page identifies it as free for use under the Pixabay Content License and marks it Content ID registered; retain this source and license record with the asset.
