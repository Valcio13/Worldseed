"""Build seamless, varied ground-repeat textures from the original pixel atlas.

Requires Pillow: python -m pip install Pillow
"""

from pathlib import Path
import random

from PIL import Image, ImageChops


ROOT = Path(__file__).resolve().parents[1]
ATLAS = ROOT / "public/assets/terrain/worldseed-terrain-atlas.png"
OUTPUT = ROOT / "public/assets/terrain/worldseed-ground-textures.png"
TILE = 64
REPEAT = 4


def soften_join(image: Image.Image, vertical: bool, coordinate: int, width: int = 7) -> None:
    pixels = image.load()
    extent = image.height if vertical else image.width
    for offset in range(-width, width + 1):
        weight = (offset + width) / (width * 2)
        left = coordinate + offset
        right = coordinate + offset + 1
        if left < 0 or right >= (image.width if vertical else image.height):
            continue
        for along in range(extent):
            a = pixels[left, along] if vertical else pixels[along, left]
            b = pixels[right, along] if vertical else pixels[along, right]
            blended = tuple(round(a[channel] * (1 - weight) + b[channel] * weight) for channel in range(3))
            if vertical:
                pixels[left, along] = blended
                pixels[right, along] = blended
            else:
                pixels[along, left] = blended
                pixels[along, right] = blended


def make_repeat(atlas: Image.Image, row: int) -> Image.Image:
    rng = random.Random(7300 + row)
    repeat = Image.new("RGB", (TILE * REPEAT, TILE * REPEAT))
    for y in range(REPEAT):
        for x in range(REPEAT):
            variant = rng.randrange(4)
            tile = atlas.crop(
                (variant * TILE, row * TILE, (variant + 1) * TILE, (row + 1) * TILE)
            )
            repeat.paste(tile, (x * TILE, y * TILE))

    for boundary in range(TILE, TILE * REPEAT, TILE):
        soften_join(repeat, True, boundary - 1)
        soften_join(repeat, False, boundary - 1)

    # Shift texture seams half a logical cell so surface variation never traces map cells.
    repeat = ImageChops.offset(repeat, TILE // 2, TILE // 2)
    soften_join(repeat, True, repeat.width - 1)
    soften_join(repeat, False, repeat.height - 1)
    return repeat


def main() -> None:
    atlas = Image.open(ATLAS).convert("RGB")
    textures = [make_repeat(atlas, row) for row in range(4)]
    sheet = Image.new("RGB", (TILE * REPEAT, TILE * REPEAT * len(textures)))
    for row, texture in enumerate(textures):
        sheet.paste(texture, (0, row * texture.height))
    sheet.save(OUTPUT, optimize=True)
    print(f"Wrote {OUTPUT} ({sheet.width}x{sheet.height})")


if __name__ == "__main__":
    main()
