"""Grading aid: compare the brightness distribution and colour cast of a screenshot against a reference still.

Usage: tools/.venv/bin/python -I tools/shotstats.py image1 [image2 …] [--rows 0.5 1.0] [--cols 0.3 0.6]
--rows / --cols restrict the statistics to part of the frame (as fractions of height and width), e.g. only the ground or one crater.
Prints display-space luminance percentiles, mean saturation, and blue-minus-red in the dark and bright areas (positive is cooler).
"""

import sys

import numpy as np
from PIL import Image


def box(L, r):
    """Box blur of side 2r+1 (integral-image implementation, edges extended with the nearest pixel)."""
    p = np.pad(L, r + 1, mode="edge")
    c = p.cumsum(0).cumsum(1)
    k = 2 * r + 1
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return s[: L.shape[0], : L.shape[1]] / (k * k)


def stats(path, r0, r1, c0=0.03, c1=0.88):
    a = np.asarray(Image.open(path).convert("RGB")).astype(float) / 255
    h, w, _ = a.shape
    a = a[int(h * r0):int(h * r1), int(w * c0):int(w * c1)]
    L = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    p = np.percentile(L, [2, 10, 25, 50, 75, 90, 98])
    sat = (a.max(-1) - a.min(-1)).mean()
    dark, bright = L < np.percentile(L, 25), L > np.percentile(L, 75)
    td = (a[dark][:, 2] - a[dark][:, 0]).mean()
    tb = (a[bright][:, 2] - a[bright][:, 0]).mean()
    # Contrast at two scales: fine = 5~21 px luminance swings (small craters), coarse = 21~121 px (large craters, hills)
    b2, b10, b60 = box(L, 2), box(L, 10), box(L, 60)
    fine, coarse = (b2 - b10).std(), (b10 - b60).std()
    return p, sat, td, tb, fine, coarse


def main():
    args = sys.argv[1:]
    r0, r1, c0, c1 = 0.04, 0.96, 0.03, 0.88
    if "--rows" in args:
        i = args.index("--rows")
        r0, r1 = float(args[i + 1]), float(args[i + 2])
        args = args[:i] + args[i + 3:]
    if "--cols" in args:
        i = args.index("--cols")
        c0, c1 = float(args[i + 1]), float(args[i + 2])
        args = args[:i] + args[i + 3:]
    print(f"{'file':28s}  p2   p10  p25  p50  p75  p90  p98 | sat   cold-dark   cold-bright | fine-contrast coarse-contrast")
    for f in args:
        p, s, td, tb, fine, coarse = stats(f, r0, r1, c0, c1)
        name = f.rsplit("/", 1)[-1][:28]
        print(f"{name:28s} " + " ".join(f"{x:.2f}" for x in p)
              + f" | {s:.3f} {td:+.3f} {tb:+.3f} | {fine:.4f} {coarse:.4f}")


if __name__ == "__main__":
    main()
