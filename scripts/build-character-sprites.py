"""Downscale the generated 6-by-3 character sheet into crisp 32px frames."""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "art" / "characters" / "worldseed-character-sheet-source.png"
OUTPUT = ROOT / "public" / "assets" / "characters" / "worldseed-characters.png"


def main() -> None:
    image = Image.open(SOURCE).convert("RGBA")
    if image.width * 3 != image.height * 6:
        raise ValueError("Expected six character columns and three animation rows.")
    sheet = image.resize((192, 96), Image.Resampling.NEAREST)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(OUTPUT, optimize=True)
    print(f"Wrote {OUTPUT} ({sheet.width}x{sheet.height}, RGBA)")


if __name__ == "__main__":
    main()
