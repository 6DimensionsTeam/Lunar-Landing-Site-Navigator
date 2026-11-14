"""Stitch the LRO WAC global mosaic into one equirectangular texture for the globe view.

Output src/data/moon_global.jpg, greyscale, 2048 x 1024, longitude 0 at the centre and
north at the top, which is what a three.js SphereGeometry expects for its default UVs.

Source: LRO_WAC_Mosaic_Global_303ppd_v02 on Moon Trek, served as WMTS tiles. There is no
ImageServer for it, so the tiles are fetched and pasted rather than exported in one piece.
The native mosaic is 303 pixels per degree; zoom 2 is 2048 x 1024, about 0.18 deg per
pixel, which is far below native but is all a sphere a few hundred pixels across on screen
can show. Zoom 3 doubles that for 3.8 times the bytes, which is not worth it in a file that
has to stay openable offline.

The polar regions of an equirectangular map stretch badly, and the south pole is the part
this project is about, so the globe does not rely on this texture there: the landing-zone
grid is projected over the southern cap from src/data/zones.bin instead.

Usage:
    python tools/fetch_moon_texture.py [--zoom 2]
"""

import argparse
import io
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data"

BASE = ("https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02"
        "/1.0.0/default/default028mm")
TILE = 256


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--zoom", type=int, default=2, help="WMTS zoom; 2 gives 2048 x 1024")
    ap.add_argument("--quality", type=int, default=86)
    a = ap.parse_args()

    cols, rows = 2 * 2 ** a.zoom, 1 * 2 ** a.zoom
    im = Image.new("L", (cols * TILE, rows * TILE))
    missing = []
    for r in range(rows):
        for c in range(cols):
            p = subprocess.run(["curl", "-s", "-m", "45", f"{BASE}/{a.zoom}/{r}/{c}.jpg"],
                               capture_output=True)
            if p.returncode == 0 and p.stdout[:2] == b"\xff\xd8":
                im.paste(Image.open(io.BytesIO(p.stdout)).convert("L"), (c * TILE, r * TILE))
            else:
                missing.append((r, c))
    if missing:
        raise SystemExit(f"{len(missing)} tiles failed, first few {missing[:5]}")

    OUT.mkdir(parents=True, exist_ok=True)
    f = OUT / "moon_global.jpg"
    im.save(f, quality=a.quality, optimize=True)
    print(f"zoom {a.zoom}: {cols}x{rows} tiles -> {im.size[0]}x{im.size[1]}, "
          f"{f.stat().st_size / 1024:.0f} KB at quality {a.quality}")
    print(f"{360 / im.size[0]:.3f} deg per pixel")


if __name__ == "__main__":
    main()
