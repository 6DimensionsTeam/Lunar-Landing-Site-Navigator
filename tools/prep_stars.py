"""Pack the Hipparcos main catalogue (V < 7.8) into binary for the page.

8 bytes per star: ICRS unit vector x y z (int16, /32767), magnitude (uint8, mag*20+40), B-V (int8, *50).
"""

from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
rows = []
for line in (ROOT / "data/raw/stars/hip.tsv").read_text().splitlines():
    p = line.split("\t")
    if len(p) < 4 or not p[0].strip()[:1].isdigit():
        continue
    try:
        ra, de, v = float(p[0]), float(p[1]), float(p[2])
    except ValueError:
        continue
    bv = float(p[3]) if p[3].strip() else 0.6
    rows.append((ra, de, v, bv))
a = np.array(rows)
ra, de = np.radians(a[:, 0]), np.radians(a[:, 1])
xyz = np.stack([np.cos(de) * np.cos(ra), np.cos(de) * np.sin(ra), np.sin(de)], 1)
rec = np.zeros(len(a), dtype=[("x", "<i2"), ("y", "<i2"), ("z", "<i2"), ("m", "u1"), ("bv", "i1")])
rec["x"], rec["y"], rec["z"] = (np.rint(xyz * 32767).astype(np.int16).T)
rec["m"] = np.clip(np.rint(a[:, 2] * 20 + 40), 0, 255)
rec["bv"] = np.clip(np.rint(a[:, 3] * 50), -127, 127)
(ROOT / "src/data/stars.bin").write_bytes(rec.tobytes())
print(len(a), "stars", rec.nbytes / 1e3, "KB, brightest", a[:, 2].min())
