"""Regenerate Mercury logo derivatives from the untouched original.

Run from the repository root:  python3 scripts/brand/derive-logo.py

Trims the transparent padding, re-centres the mark on a square canvas with an
even 6% margin, and scales proportionally. The original file is only read.
"""
from pathlib import Path
from PIL import Image

BRAND = Path("apps/web/public/brand")
ORIGINAL = BRAND / "mercury-logo-original.png"
SIZES = {
    "mercury-mark-512.png": 512,
    "mercury-mark-256.png": 256,
    "apple-touch-icon-180.png": 180,
    "favicon-64.png": 64,
    "favicon-32.png": 32,
}

def main() -> None:
    src = Image.open(ORIGINAL).convert("RGBA")
    bbox = src.split()[3].getbbox()
    if bbox is None:
        raise SystemExit("original logo has no visible pixels")
    mark = src.crop(bbox)
    w, h = mark.size
    side = max(w, h)
    pad = int(side * 0.06)
    canvas = Image.new("RGBA", (side + 2 * pad, side + 2 * pad), (0, 0, 0, 0))
    canvas.paste(mark, (pad + (side - w) // 2, pad + (side - h) // 2), mark)
    for name, size in SIZES.items():
        canvas.resize((size, size), Image.LANCZOS).save(BRAND / name)
        print(f"wrote {name} ({size}x{size})")

if __name__ == "__main__":
    main()
