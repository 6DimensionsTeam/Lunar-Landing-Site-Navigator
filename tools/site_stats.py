"""Recompute per-year illumination and comms statistics for the candidate sites.

Reads the horizon profiles already stored in src/data/sites.json and the current
src/data/ephem.bin, and writes the statistics back into sites.json: one set per year
covered by the ephemeris, plus one set over the whole range.

Split out from tools/horizon.py on purpose. The horizon profiles depend only on the
terrain, so they never need recomputing when the ephemeris range changes, and
regenerating them needs the raw LOLA DEMs in data/raw. This tool needs neither.

Why per-year: the Moon's orbit plane precesses on an 18.6-year cycle, so a polar site's
sunlit fraction is not the same every year. Reporting a single year hides that; reporting
per-year lets the arrival year the user picks change the numbers they are shown.

Usage:
    python tools/site_stats.py
"""

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data"

R_M = 1737400.0          # lunar radius, m (same sphere as the LOLA DEM)
OBS_H = 2.0              # observer height, m
SUN_RADIUS_DEG = 0.2666  # apparent solar radius at 1 au


def enu(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    return east, np.cross(up, east), up


def disk_fraction(el, hor, rho):
    h = np.clip((el - hor) / rho, -1, 1)
    return 1 - (np.arccos(h) - h * np.sqrt(1 - h * h)) / np.pi


def longest_run(mask, step_h):
    """Longest run of True in hours. Does not wrap: a year boundary is a real boundary here."""
    longest = run = 0
    for x in mask:
        run = run + 1 if x else 0
        longest = max(longest, run)
    return int(round(longest * step_h))


def site_series(site, ephem):
    """Per-sample sunlit fraction, lit flag and Earth-visible flag for one site."""
    e, n, u = enu(site["lat"], site["lon"])
    hor = np.asarray(site["horizon_cdeg"], dtype=np.float64) / 100.0
    n_az = hor.size

    def azel(v):
        v = v / np.linalg.norm(v, axis=1, keepdims=True)
        return (np.degrees(np.arctan2(v @ e, v @ n)) % 360,
                np.degrees(np.arcsin(np.clip(v @ u, -1, 1))))

    def hor_at(az):
        f = az / 360 * n_az
        i0 = np.floor(f).astype(int) % n_az
        w = f - np.floor(f)
        return hor[i0] * (1 - w) + hor[(i0 + 1) % n_az] * w

    s_az, s_el = azel(ephem[:, 0:3].astype(np.float64))
    obs = (R_M + site["elev_m"] + OBS_H) / 1000.0 * u            # km, matching ephem units
    e_az, e_el = azel(ephem[:, 3:6].astype(np.float64) - obs)
    sun = disk_fraction(s_el, hor_at(s_az), SUN_RADIUS_DEG)
    return sun, sun > 0.5, e_el > hor_at(e_az)


def pack(sun, lit, earth, step_h):
    return dict(
        sun_mean_pct=round(float(sun.mean() * 100), 2),
        sun_visible_pct=round(float(lit.mean() * 100), 2),
        earth_visible_pct=round(float(earth.mean() * 100), 2),
        both_pct=round(float((lit & earth).mean() * 100), 2),
        longest_dark_h=longest_run(~lit, step_h),
        longest_blind_h=longest_run(~earth, step_h),
    )


def main():
    meta = json.loads((OUT / "sites.json").read_text())
    emeta = json.loads((OUT / "ephem.json").read_text())
    ephem = np.frombuffer((OUT / "ephem.bin").read_bytes(), dtype="<f4").reshape(-1, 14)
    step_h = emeta["step_hours"]
    y0, y1 = emeta["start_year"], emeta["end_year"]

    leap = lambda y: y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)
    bounds, at = {}, 0
    for y in range(y0, y1 + 1):
        n = (366 if leap(y) else 365) * 24 // step_h
        bounds[y] = (at, at + n)
        at += n
    assert at == len(ephem), f"year bounds cover {at} samples, ephem has {len(ephem)}"

    for site in meta["sites"]:
        sun, lit, earth = site_series(site, ephem)
        site["stats"] = pack(sun, lit, earth, step_h)          # whole range, keeps the old key working
        site["stats_by_year"] = {
            str(y): pack(sun[a:b], lit[a:b], earth[a:b], step_h) for y, (a, b) in bounds.items()
        }
        yr = site["stats_by_year"]
        sv = [yr[str(y)]["sun_visible_pct"] for y in range(y0, y1 + 1)]
        ev = [yr[str(y)]["earth_visible_pct"] for y in range(y0, y1 + 1)]
        print(f"{site['id']} {site['en']:18} "
              f"sun {min(sv):5.2f}..{max(sv):5.2f}% (range {max(sv)-min(sv):4.2f}) "
              f"earth {min(ev):5.2f}..{max(ev):5.2f}% "
              f"longest night {site['stats']['longest_dark_h']} h")

    meta["stats_years"] = [y0, y1]
    (OUT / "sites.json").write_text(json.dumps(meta, ensure_ascii=False))
    print(f"\nwrote per-year stats for {y0}..{y1} into sites.json")


if __name__ == "__main__":
    main()
