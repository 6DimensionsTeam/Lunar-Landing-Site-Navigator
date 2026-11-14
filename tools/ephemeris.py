"""Compute Sun and Earth directions over a range of years from the JPL DE421 ephemeris and the lunar orientation kernel.

Frame: MOON_ME_DE421 (mean Earth/polar axis), the same frame as the LOLA DEM.
Output src/data/ephem.bin (float32 little-endian), 14 numbers per sample:
  Sun unit direction (3), Earth position km (3), ICRS→Moon-fixed rotation quaternion (4, x y z w),
  Earth ITRS→Moon-fixed rotation quaternion (4)
  The first two are apparent positions from the Moon centre, corrected for light time and aberration.
Also writes ephem.json: start time, step, sample count.

Usage:
    python tools/ephemeris.py                      # default range, see START_YEAR/END_YEAR
    python tools/ephemeris.py 2028 2028 --step 1   # one year, hourly (the original build)
    python tools/ephemeris.py 2026 2040 --step 3

Step size: 3 h keeps the headline statistics identical to hourly sampling and holds
sunrise/sunset times to within about 2 minutes, at a third of the size. Measured against
1-minute truth over 60 days at all four candidate sites. Do not go beyond 6 h: the Earth
crossing times start to drift (5 min at 6 h) because the Moon's libration is the driver
there, not the solar motion.

Kernel coverage limits the range: de421.bsp spans 1899-07-28 to 2053-10-08 and
moon_pa_de421_1900-2050.bpc spans 1900 to 2050.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from skyfield.api import load
from skyfield.framelib import itrs
from skyfield.planetarylib import PlanetaryConstants

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "src" / "data"

START_YEAR = 2026
END_YEAR = 2040
STEP_H = 3
KERNEL_MIN_YEAR, KERNEL_MAX_YEAR = 1900, 2050


def rot_to_quat(m):
    """Rotation matrices (3, 3, N) to quaternions (N, 4) as (x, y, z, w).

    Vectorised over N. Matches the scalar branch-per-sample form exactly (verified
    bit-identical), which matters because the runtime slerps between consecutive samples
    and a sign flip would show up as the sky snapping round.
    """
    m = np.moveaxis(m, 2, 0)                        # N, 3, 3
    tr = np.trace(m, axis1=1, axis2=2)
    q = np.zeros((m.shape[0], 4))

    big = tr > 0
    if big.any():
        s = np.sqrt(tr[big] + 1.0) * 2
        q[big, 3] = 0.25 * s
        q[big, 0] = (m[big, 2, 1] - m[big, 1, 2]) / s
        q[big, 1] = (m[big, 0, 2] - m[big, 2, 0]) / s
        q[big, 2] = (m[big, 1, 0] - m[big, 0, 1]) / s

    rest = ~big
    if rest.any():
        mr = m[rest]
        i = np.argmax(np.diagonal(mr, axis1=1, axis2=2), axis=1)
        out = np.zeros((mr.shape[0], 4))
        for ii in (0, 1, 2):
            sel = i == ii
            if not sel.any():
                continue
            j, k = (ii + 1) % 3, (ii + 2) % 3
            ms = mr[sel]
            s = np.sqrt(1.0 + ms[:, ii, ii] - ms[:, j, j] - ms[:, k, k]) * 2
            out[sel, ii] = 0.25 * s
            out[sel, j] = (ms[:, j, ii] + ms[:, ii, j]) / s
            out[sel, k] = (ms[:, k, ii] + ms[:, ii, k]) / s
            out[sel, 3] = (ms[:, k, j] - ms[:, j, k]) / s
        q[rest] = out
    return q


def hours_in(y0, y1):
    """Total hours from y0-01-01 00:00 to (y1+1)-01-01 00:00, counting leap years."""
    leap = lambda y: y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)
    return sum(366 if leap(y) else 365 for y in range(y0, y1 + 1)) * 24


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("start_year", nargs="?", type=int, default=START_YEAR)
    ap.add_argument("end_year", nargs="?", type=int, default=END_YEAR)
    ap.add_argument("--step", type=int, default=STEP_H, help="sample interval in hours")
    a = ap.parse_args()

    if a.end_year < a.start_year:
        ap.error("end_year must not be before start_year")
    if a.start_year < KERNEL_MIN_YEAR or a.end_year > KERNEL_MAX_YEAR:
        ap.error(f"the orientation kernel only covers {KERNEL_MIN_YEAR}..{KERNEL_MAX_YEAR}")
    if 24 % a.step:
        ap.error("step must divide 24 so that every sample lands on a whole hour")

    ts = load.timescale(builtin=True)
    eph = load(str(RAW / "de421.bsp"))
    pc = PlanetaryConstants()
    pc.read_text(load(str(RAW / "moon_080317.tf")))
    pc.read_text(load(str(RAW / "pck00008.tpc")))
    pc.read_binary(load(str(RAW / "moon_pa_de421_1900-2050.bpc")))
    frame = pc.build_frame_named("MOON_ME_DE421")

    n = hours_in(a.start_year, a.end_year) // a.step
    t = ts.utc(a.start_year, 1, 1, range(0, n * a.step, a.step))
    moon, sun, earth = eph["moon"], eph["sun"], eph["earth"]

    obs = moon.at(t)
    s_icrs = obs.observe(sun).apparent().position.km      # (3, n)
    e_icrs = obs.observe(earth).apparent().position.km
    R = frame.rotation_at(t)                              # (3, 3, n), ICRS → Moon-fixed

    s_me = np.einsum("ijn,jn->in", R, s_icrs)
    e_me = np.einsum("ijn,jn->in", R, e_icrs)
    s_unit = s_me / np.linalg.norm(s_me, axis=0)

    # Earth rotation: ITRS → Moon-fixed, so the Earth texture faces the right way
    E = np.einsum("ijn,kjn->ikn", R, itrs.rotation_at(t))  # R · ITRSᵀ

    rec = np.zeros((n, 14), dtype="<f4")
    rec[:, 0:3] = s_unit.T
    rec[:, 3:6] = e_me.T
    rec[:, 6:10] = rot_to_quat(R)
    rec[:, 10:14] = rot_to_quat(E)

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "ephem.bin").write_bytes(rec.tobytes())
    meta = {
        "start_utc": "%04d-01-01T00:00:00Z" % a.start_year,
        "end_utc": "%04d-01-01T00:00:00Z" % (a.end_year + 1),
        "start_year": a.start_year,
        "end_year": a.end_year,
        "step_hours": a.step,
        "count": n,
        "fields": ["sun_dir_x", "sun_dir_y", "sun_dir_z",
                   "earth_km_x", "earth_km_y", "earth_km_z",
                   "q_x", "q_y", "q_z", "q_w",
                   "earth_q_x", "earth_q_y", "earth_q_z", "earth_q_w"],
        "frame": "MOON_ME_DE421",
        "source": "JPL DE421 + moon_pa_de421_1900-2050.bpc + moon_080317.tf (Skyfield)",
    }
    (OUT / "ephem.json").write_text(json.dumps(meta, indent=2))

    print(f"{a.start_year}..{a.end_year} at {a.step} h: {n} samples, "
          f"{len(rec.tobytes())/1e6:.2f} MB")
    # Self-check: solar elevation at the south pole should stay within about ±1.6°
    up = np.array([0, 0, -1.0])
    el = np.degrees(np.arcsin(s_unit.T @ up))
    print(f"sun elevation at the south pole {el.min():.2f}..{el.max():.2f}°")
    ed = np.linalg.norm(e_me, axis=0)
    print(f"Earth-Moon distance {ed.min():.0f}..{ed.max():.0f} km")
    qn = np.abs(np.linalg.norm(rec[:, 6:10], axis=1) - 1).max()
    qe = np.abs(np.linalg.norm(rec[:, 10:14], axis=1) - 1).max()
    print(f"quaternion norm error: orientation {qn:.2e}, earth {qe:.2e}")


if __name__ == "__main__":
    main()
