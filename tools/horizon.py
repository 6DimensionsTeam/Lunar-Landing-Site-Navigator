"""Candidate sites: site selection, 360° horizon profiles, annual lighting and Earth-visibility statistics.

Terrain: inner 40 m native-resolution DEM, outer 240 m DEM beyond the inner ring, rays out to 440 km (including lunar surface curvature).
Site selection: take several local high points in each region, compute annual lighting coarsely, keep the best-lit one, then refine.
Lighting: area fraction of the solar disk above the horizon (not just the disk centre).
Output src/data/sites.json.
"""

import json
from pathlib import Path

import numpy as np
from scipy.ndimage import map_coordinates, maximum_filter

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "src" / "data"
R = 1737400.0
OBS_H = 2.0          # observer height m (a standing person or a sensor on a lander)
SUN_RADIUS_DEG = 0.2666

INNER = dict(file="ldem_85s_40m.img", n=7584, s=40.0)
OUTER = dict(file="ldem_75s_240m.img", n=3812, s=240.0)

# Regions: name, English, centre latitude, centre longitude, search mode
REGIONS = [
    dict(id="A", en="SHACKLETON RIM", crater=(-89.63, 118.5), ring=(9e3, 13e3)),
    dict(id="B", en="CONNECTING RIDGE", center=(-89.45, 225.0), radius=12e3, avoid=((-89.63, 118.5), 13e3)),
    dict(id="C", en="DE GERLACHE RIM", crater=(-88.5, 272.9), ring=(14e3, 21e3)),
    dict(id="D", en="MALAPERT MASSIF", center=(-86.0, 0.0), radius=25e3),
]


def load(t):
    a = np.fromfile(RAW / t["file"], dtype="<i2").reshape(t["n"], t["n"]).astype(np.float32) * 0.5
    return a


DEM_IN = load(INNER)
DEM_OUT = load(OUTER)
HALF_IN = INNER["n"] * INNER["s"] / 2


def ll_to_xy(lat, lon):
    r = 2 * R * np.tan(np.radians(90 - np.abs(lat)) / 2)
    return r * np.sin(np.radians(lon)), r * np.cos(np.radians(lon))


def xy_to_ll(x, y):
    lat = -90 + np.degrees(2 * np.arctan(0.5 * np.hypot(x, y) / R))
    return lat, np.degrees(np.arctan2(x, y)) % 360


def sample(x, y):
    """Bilinear elevation sample (m). Inner ring first, outer beyond it."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    out = np.empty(x.shape, np.float32)
    inside = (np.abs(x) < HALF_IN - INNER["s"]) & (np.abs(y) < HALF_IN - INNER["s"])
    for dem, t, m in ((DEM_IN, INNER, inside), (DEM_OUT, OUTER, ~inside)):
        if not m.any():
            continue
        n, s = t["n"], t["s"]
        col = x[m] / s + n / 2 - 0.5       # 0-based column (I-1)
        row = -y[m] / s + n / 2 - 0.5      # 0-based row (J-1)
        out[m] = map_coordinates(dem, [row, col], order=1, mode="nearest")
    return out


def unit(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1)


def enu(lat, lon):
    up = unit(lat, lon)
    lo = np.radians(lon)
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    north = np.cross(up, east)
    return east, north, up


def horizon_profile(lat, lon, n_az=720, fine=True):
    """Return horizon elevation (deg) on n_az azimuths (0 = north, clockwise)."""
    near = np.arange(40.0, 4000.0, 40.0) if fine else np.arange(120.0, 4000.0, 120.0)
    far = np.geomspace(4000.0, 440e3, 520 if fine else 200)
    d = np.concatenate([near, far])
    az = np.radians(np.arange(n_az) * 360.0 / n_az)
    phi1, lam1 = np.radians(lat), np.radians(lon)
    delta = d[None, :] / R
    th = az[:, None]
    phi2 = np.arcsin(np.sin(phi1) * np.cos(delta) + np.cos(phi1) * np.sin(delta) * np.cos(th))
    lam2 = lam1 + np.arctan2(np.sin(th) * np.sin(delta) * np.cos(phi1),
                             np.cos(delta) - np.sin(phi1) * np.sin(phi2))
    lat2, lon2 = np.degrees(phi2), np.degrees(lam2) % 360
    x2, y2 = ll_to_xy(lat2, lon2)
    h2 = sample(x2, y2)
    x0, y0 = ll_to_xy(lat, lon)
    h0 = float(sample(np.array([x0]), np.array([y0]))[0])
    up = unit(lat, lon)
    O = (R + h0 + OBS_H) * up
    P = (R + h2)[..., None] * unit(lat2, lon2)
    v = P - O
    el = np.degrees(np.arcsin(np.clip((v @ up) / np.linalg.norm(v, axis=-1), -1, 1)))
    return el.max(axis=1), h0


def disk_fraction(el, hor, rho):
    h = np.clip((el - hor) / rho, -1, 1)
    return 1 - (np.arccos(h) - h * np.sqrt(1 - h * h)) / np.pi


def stats(lat, lon, hor, h0, ephem, step_h=1):
    e, n, u = enu(lat, lon)
    n_az = hor.size
    def azel(v):
        v = v / np.linalg.norm(v, axis=1, keepdims=True)
        return (np.degrees(np.arctan2(v @ e, v @ n)) % 360, np.degrees(np.arcsin(np.clip(v @ u, -1, 1))))
    def hor_at(az):
        f = az / 360 * n_az
        i0 = np.floor(f).astype(int) % n_az
        w = f - np.floor(f)
        return hor[i0] * (1 - w) + hor[(i0 + 1) % n_az] * w
    s_az, s_el = azel(ephem[:, 0:3].astype(np.float64))
    site = (R + h0 + OBS_H) / 1000 * u
    e_az, e_el = azel(ephem[:, 3:6].astype(np.float64) - site)
    sun = disk_fraction(s_el, hor_at(s_az), SUN_RADIUS_DEG)
    earth = e_el > hor_at(e_az)
    lit = sun > 0.5
    # Longest continuous unlit spell: a solar disk visible fraction under 50% counts as unlit.
    # Counted in samples, then scaled by step_h, so it stays in hours whatever the ephemeris step is.
    #
    # This does NOT wrap the series head to tail. An earlier version concatenated `dark` with
    # itself so that a spell straddling the end of the range would still be counted whole, but
    # when this function is handed one year at a time (see prep_candidates.py's stats_by_year)
    # that joins December's night to January's across a whole year of intervening daylight and
    # reports the sum as one continuous spell. It inflated thirteen of the fifteen data sites by
    # 222-270 h and produced per-year figures larger than the same site's whole-period figure,
    # which cannot happen. The end of the range is a real boundary, as it is in site_stats.py's
    # longest_run(), and a spell cut short by it is reported only as far as the data goes.
    dark = ~lit
    longest, run = 0, 0
    for x in dark:
        run = run + 1 if x else 0
        longest = max(longest, run)
    blind = ~earth
    longest_blind, run_blind = 0, 0
    for x in blind:
        run_blind = run_blind + 1 if x else 0
        longest_blind = max(longest_blind, run_blind)
    return dict(
        sun_mean_pct=float(sun.mean() * 100),
        sun_visible_pct=float(lit.mean() * 100),
        earth_visible_pct=float(earth.mean() * 100),
        both_pct=float((lit & earth).mean() * 100),
        longest_dark_h=int(round(longest * step_h)),
        # sites.json carries this for the four NASA regions; the data sites were missing it, so
        # any check reading longest_blind_h saw undefined for fifteen of nineteen sites.
        longest_blind_h=int(round(longest_blind * step_h)),
    )


def candidates(reg, k=12):
    """Local high points in the region (top k by elevation), returned as lat/lon pairs."""
    s = INNER["s"]
    if "crater" in reg:
        cx, cy = ll_to_xy(*reg["crater"])
        rmax = reg["ring"][1]
    else:
        cx, cy = ll_to_xy(*reg["center"])
        rmax = reg["radius"]
    n = INNER["n"]
    c0 = int(cx / s + n / 2 - 0.5)
    r0 = int(-cy / s + n / 2 - 0.5)
    w = int(rmax / s) + 2
    sub = DEM_IN[r0 - w:r0 + w, c0 - w:c0 + w]
    rows, cols = np.mgrid[r0 - w:r0 + w, c0 - w:c0 + w]
    x = (cols - n / 2 + 0.5) * s
    y = -(rows - n / 2 + 0.5) * s
    dist = np.hypot(x - cx, y - cy)
    mask = (dist >= reg["ring"][0]) & (dist <= reg["ring"][1]) if "crater" in reg else dist <= rmax
    if "avoid" in reg:
        ax, ay = ll_to_xy(*reg["avoid"][0])
        mask &= np.hypot(x - ax, y - ay) > reg["avoid"][1]
    peaks = (sub == maximum_filter(sub, size=25)) & mask
    idx = np.argsort(sub[peaks])[::-1][:k]
    px, py = x[peaks][idx], y[peaks][idx]
    return [xy_to_ll(a, b) for a, b in zip(px, py)]


def main():
    ephem = np.frombuffer((OUT / "ephem.bin").read_bytes(), dtype="<f4").reshape(-1, 14)
    emeta = json.loads((OUT / "ephem.json").read_text())
    step_h = emeta["step_hours"]
    # Site selection only needs a rough score, so thin to about 6 h whatever the ephemeris step is
    skip = max(1, round(6 / step_h))
    coarse = ephem[::skip]
    sites = []
    for reg in REGIONS:
        best = None
        for lat, lon in candidates(reg):
            hor, h0 = horizon_profile(lat, lon, n_az=180, fine=False)
            st = stats(lat, lon, hor, h0, coarse, step_h * skip)
            score = st["sun_mean_pct"] + 0.25 * st["earth_visible_pct"]
            if best is None or score > best[0]:
                best = (score, lat, lon)
        _, lat, lon = best
        hor, h0 = horizon_profile(lat, lon)
        st = stats(lat, lon, hor, h0, ephem, step_h)
        x, y = ll_to_xy(lat, lon)
        sites.append(dict(
            id=reg["id"], en=reg["en"],
            lat=round(float(lat), 4), lon=round(float(lon), 3), elev_m=round(h0, 1),
            x_m=round(float(x), 1), y_m=round(float(y), 1),
            horizon_cdeg=[int(round(v * 100)) for v in hor],
            stats={k: (round(v, 2) if isinstance(v, float) else v) for k, v in st.items()},
        ))
        print(f"{reg['id']} {reg['en']}: {lat:.3f}, {lon:.2f}E  elev {h0:.0f} m | "
              f"sun mean {st['sun_mean_pct']:.1f}% visible {st['sun_visible_pct']:.1f}% "
              f"earth {st['earth_visible_pct']:.1f}% both {st['both_pct']:.1f}% "
              f"longest night {st['longest_dark_h']} h | horizon {hor.min():.2f}..{hor.max():.2f} deg")
    meta = dict(observer_height_m=OBS_H, azimuth_step_deg=0.5,
                ephem_range=[emeta["start_year"], emeta["end_year"]], ephem_step_h=step_h,
                sun_lit_threshold="solar disk visible fraction > 50%", sites=sites)
    (OUT / "sites.json").write_text(json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    main()
