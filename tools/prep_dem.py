"""Downsample and compress the LOLA south polar DEM into binary the page can decode directly.

Input: data/raw/ldem_85s_40m.img (inner, 85°S to the pole, 40 m/px)
      data/raw/ldem_75s_240m.img (outer, 75°S to the pole, 240 m/px)
Output: src/data/terrain_inner.bin / terrain_outer.bin / terrain.json
      data/preview_*.png (hillshade previews, to check orientation)

Projection and coordinates: south polar stereographic, per PDS DSMAP_POLAR.CAT.
  X = (I - N/2 - 0.5) * S        toward 90°E
  Y = -(J - N/2 - 0.5) * S       toward longitude 0° (toward Earth)
Encoding: DN (half-metre steps) is block-mean downsampled, then a gradient predictor
  pred = left + up - upleft gives the residual, zigzagged to uint16 and zlib-compressed.
  The page reverses it in the same order.
"""

import json
import sys
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "src" / "data"

TILES = {
    # name: (file, native side length, native resolution m, downsample factor)
    "inner": ("ldem_85s_40m.img", 7584, 40.0, 3),
    "outer": ("ldem_75s_240m.img", 3812, 240.0, 2),
}


def load_dn(name, n):
    raw = np.fromfile(RAW / name, dtype="<i2")
    if raw.size != n * n:
        sys.exit(f"{name}: expected {n*n} samples, got {raw.size}")
    return raw.reshape(n, n)


def block_mean(dn, f):
    n = dn.shape[0] // f * f
    a = dn[:n, :n].astype(np.float64)
    return a.reshape(n // f, f, n // f, f).mean(axis=(1, 3))


def encode(dn16):
    """Gradient prediction + zigzag + zlib. dn16 is an int16 2-D array."""
    a = dn16.astype(np.int32)
    pred = np.zeros_like(a)
    pred[0, 1:] = a[0, :-1]
    pred[1:, 0] = a[:-1, 0]
    pred[1:, 1:] = a[1:, :-1] + a[:-1, 1:] - a[:-1, :-1]
    res = a - pred
    res = ((res + 32768) % 65536) - 32768  # wrap to int16, the decoder wraps the same way
    zz = ((res << 1) ^ (res >> 31)).astype(np.uint16)
    return zlib.compress(zz.astype("<u2").tobytes(), 9)


def hillshade(h, scale, az=135.0, alt=8.0):
    gy, gx = np.gradient(h, scale)
    az, alt = np.radians(az), np.radians(alt)
    nx, ny, nz = -gx, gy, np.ones_like(h)  # rows going down mean Y decreasing, so gy takes the positive sign
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    lx, ly, lz = np.cos(alt) * np.sin(az), np.cos(alt) * np.cos(az), np.sin(alt)
    s = np.clip((nx * lx + ny * ly + nz * lz) * inv, 0, 1)
    return (s ** 0.8 * 255).astype(np.uint8)


HERO_N = 1536  # crop side near the pole at native 40 m, undecimated (±30.7 km, covers Shackleton and the connecting ridge)


def save_tile(meta, key, dn16, out_res):
    size = dn16.shape[0]
    blob = encode(dn16)
    (OUT / f"terrain_{key}.bin").write_bytes(blob)
    h = dn16.astype(np.float64) * 0.5
    meta["tiles"][key] = {
        "file": f"terrain_{key}.bin",
        "size": size,
        "res_m": out_res,
        "half_extent_m": size * out_res / 2,
        "min_m": float(h.min()),
        "max_m": float(h.max()),
    }
    print(f"{key}: {size}² @ {out_res:.0f} m, elevation {h.min():.0f}..{h.max():.0f} m, "
          f"compressed {len(blob)/1e6:.2f} MB (raw {size*size*2/1e6:.1f} MB)")
    return h


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {"radius_m": 1737400.0, "dn_scale_m": 0.5, "tiles": {}}
    dn = load_dn(*TILES["inner"][:2])
    c0 = dn.shape[0] // 2 - HERO_N // 2      # the pole sits at 3791.5 counting from 0, so the crop is symmetric
    save_tile(meta, "hero", dn[c0:c0 + HERO_N, c0:c0 + HERO_N].copy(), 40.0)
    for key, (fname, n, res_m, f) in TILES.items():
        dn = load_dn(fname, n)
        if (dn == -32768).any():
            sys.exit(f"{fname}: contains missing values, handle them first")
        m = block_mean(dn, f)
        dn16 = np.clip(np.rint(m), -32767, 32767).astype(np.int16)
        h = save_tile(meta, key, dn16, res_m * f)
        Image.fromarray(hillshade(h, res_m * f)).save(ROOT / "data" / f"preview_{key}.png")
    (OUT / "terrain.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
