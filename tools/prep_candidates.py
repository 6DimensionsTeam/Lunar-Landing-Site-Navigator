"""Build a pool of data-selected candidate landing sites from the zone grid.

The four sites in sites.json are the published Artemis III candidate regions: real, studied
places, and useful precisely because a reader recognises them. But they are a fixed list, so
"rank them against the mission's requirements" can only ever reorder the same four -- the worst
of them still comes fourth, and ticking a box can never surface somewhere new.

This tool reads the same zone grid the map already draws (480 m cells: slope, solar and Earth
visibility, temperature, distance to permanent shadow) and finds the ground that actually
meets a given set of requirements, so the pool can grow and change with the mission instead of
being four names.

Two things it deliberately does not do.

It does not score anything. A cell's visibility figures are 18.6-year means, and the figure a
site selector most needs -- the longest continuous dark spell, which decides battery and
thermal design -- cannot come from a mean at all. So the grid is used only to *find* places
worth looking at, and every candidate that survives is then run through the full-resolution
horizon profile against the real ephemeris, which is what sites.json is built from. The grid
narrows; the ephemeris decides.

It does not invent a hazard number. Fault proximity comes from the published scarp catalogue
and is a distance, nothing more; see tools/prep_quakes.py for why a magnitude would be fiction.

Usage:
    python tools/prep_candidates.py [--per-bucket N]
"""

import argparse
import json
import math
import zlib
from pathlib import Path

import importlib.util

import numpy as np
from scipy import ndimage

# horizon.py is imported rather than reimplemented so candidates and the four named sites are
# measured by exactly the same code path. It loads the DEMs at import, which takes a few
# seconds and is why this happens once here rather than per candidate.
_spec = importlib.util.spec_from_file_location("horizon", Path(__file__).resolve().parent / "horizon.py")
hz = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hz)

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "src" / "data"

R_M = 1737400.0
OBS_H = 2.0
SUN_RADIUS_DEG = 0.2666

# A candidate has to be somewhere a lander could plausibly put down: gentle slope, and not so
# dark that it could never run on solar power. These are not mission requirements -- they are
# the floor below which a point is not a candidate at all, whatever the mission asked for.
MAX_SLOPE_DEG = 10.0
# Grid visibility is the mean over a 480 m cell, and a cell on a ridge averages the lit crest
# with its shaded flanks. The best cell in the whole grid reads 81 per cent solar, below the
# 82.2 per cent the full-resolution profile gives Shackleton Rim -- so a threshold on this
# figure would reject exactly the ridge sites worth having. The grid therefore screens on slope
# and on class, which are properties of the ground rather than an average over it, and the
# full-resolution pass decides everything else.
MIN_PATCH_CELLS = 400      # about 92 km2 of contiguous landable ground: a real place to land
MIN_SEPARATION_KM = 26.0   # about two hero tiles: distinct enough to be different places
# How far below the highest ground in a patch a seed may sit. Ridges crest and fall away fast;
# a seed far below the local high is on a slope, not a crest.
SEED_BELOW_HIGH_M = 60.0


def decode_planes():
    """The grid as zones.js reads it: zlib, then a row predictor over int8 differences."""
    meta = json.loads((OUT / "zones.json").read_text())
    n = meta["size"]
    names = meta["planes"]
    n2 = n * n
    raw = zlib.decompress((OUT / "zones.bin").read_bytes())
    assert len(raw) == len(names) * n2, (len(raw), len(names) * n2)
    planes = {}
    for p, name in enumerate(names):
        src = np.frombuffer(raw[p * n2:(p + 1) * n2], dtype=np.uint8).reshape(n, n)
        # accumulate the signed byte differences along each row, wrapping at 256
        acc = np.cumsum((src.astype(np.int32) << 24 >> 24), axis=1) & 255
        planes[name] = acc.astype(np.uint8)

    scales = meta["scales"]

    def decode(key):
        s = scales[key]
        return s["lo"] + (planes[key].astype(np.float32) / (s["levels"] - 1)) * (s["hi"] - s["lo"])

    return meta, n, {k: decode(k) for k in ("slope_deg", "sun", "earth", "tmax_k", "ice_dist_m")}, planes["class"]


def cell_centres(meta, n):
    """Map coordinates of each cell centre, in km, in the same frame as geo.js."""
    half = meta["half_extent_m"] / 1000.0
    cell = meta["cell_m"] / 1000.0
    idx = np.arange(n)
    # row 0 is the +y (north) edge: y decreases with the row index
    xs = (idx + 0.5) * cell - half
    ys = half - (idx + 0.5) * cell
    return np.meshgrid(xs, ys)


def xy_to_latlon(x_km, y_km):
    rho = np.hypot(x_km, y_km) * 1000.0
    lat = -(90.0 - 2.0 * np.degrees(np.arctan(rho / (2.0 * R_M))))
    lon = np.degrees(np.arctan2(x_km, y_km)) % 360.0
    return lat, lon


def pick(mask, dist_km, score, k, taken):
    """Take up to k well-separated cells from a mask, best score first."""
    if not mask.any():
        return []
    ys, xs = np.nonzero(mask)
    order = np.argsort(-score[mask])
    ys, xs = ys[order], xs[order]
    picked = []
    for r, c in zip(ys, xs):
        x, y = dist_km["x"][r, c], dist_km["y"][r, c]
        if any(math.hypot(x - tx, y - ty) < MIN_SEPARATION_KM for tx, ty in taken):
            continue
        taken.append((x, y))
        picked.append((r, c))
        if len(picked) >= k:
            break
    return picked


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--per-bucket", type=int, default=8,
                    help="candidates to keep from each requirement bucket")
    ap.add_argument("--skip-horizon", action="store_true",
                    help="grid selection only, for a quick look before the slow pass")
    a = ap.parse_args()

    meta, n, planes, cls = decode_planes()
    X, Y = cell_centres(meta, n)
    slope, sun, earth, tmax, ice = (planes[k] for k in ("slope_deg", "sun", "earth", "tmax_k", "ice_dist_m"))
    ids = meta["zones"]
    # Landable ground: surveyed, gentle enough to put down on. Deliberately not filtered on
    # grid visibility -- see the note above on why that average cannot see a ridge.
    landable = (cls != 0) & (slope <= MAX_SLOPE_DEG) & np.isin(cls, [ids["prime"], ids["sunlit"], ids["flat"]])

    # Seed candidates at the high ground of substantial contiguous patches. A ridge crest is a
    # local maximum of elevation, and that is where the long sight lines to the Sun and Earth
    # are; picking patch centroids instead would land in the middle of the flattest, darkest
    # floor, which is the opposite of what a polar site wants.
    # The grid's own height field, at cell centres: horizon.py's 40 m DEM sampled down to the
    # zone grid, so "high ground" is decided on the same terrain the profiles are measured from.
    hs = hz.INNER["s"]
    hn = hz.INNER["n"]
    half_m = meta["half_extent_m"]
    cell_m = meta["cell_m"]
    # grid cell centre -> DEM pixel: x toward 90E, row runs from +y down
    gi = ((X * 1000.0) / hs + hn / 2.0 - 0.5)
    gj = ((-Y * 1000.0) / hs + hn / 2.0 - 0.5)
    dem = ndimage.map_coordinates(hz.DEM_IN, [gj, gi], order=1, mode="nearest")
    lbl, nlab = ndimage.label(landable)
    sizes = ndimage.sum(landable, lbl, range(1, nlab + 1))
    big = [i + 1 for i, sz in enumerate(sizes) if sz >= MIN_PATCH_CELLS]
    print(f"{nlab} landable patches, {len(big)} of them at least {MIN_PATCH_CELLS} cells")

    peak = ndimage.maximum_filter(dem, size=25)
    coords = {"x": X, "y": Y}
    taken, buckets = [], {}
    # Bucket a seed by what the cell it actually landed on offers, not by what the surrounding
    # patch contains: almost every patch within 100 km of the pole has some shadow nearby, so
    # bucketing on the patch's minimum collapsed everything into one bucket.
    for lab in big:
        m = (lbl == lab) & (dem >= peak - SEED_BELOW_HIGH_M)
        if not m.any():
            continue
        # within a patch, prefer the higher ground, then the better balanced visibility
        score = dem + 200.0 * (0.5 * sun + 0.5 * earth)
        picked = pick(m, coords, score, 2, taken)
        # Bucket by the cell's own grid figures. Almost every patch within 100 km of the pole
        # has some permanent shadow nearby, so bucketing on proximity to shadow put 14 of 15
        # seeds in one bucket and made the split useless; Earth visibility is what actually
        # separates the places in this region, so that leads.
        for r, c in picked:
            if earth[r, c] >= 0.70:
                buckets.setdefault("earth", []).append((r, c))
            elif sun[r, c] >= 0.45:
                buckets.setdefault("sun", []).append((r, c))
            elif ice[r, c] <= 8000.0:
                buckets.setdefault("ice", []).append((r, c))
            else:
                buckets.setdefault("placed", []).append((r, c))
    for name, v in buckets.items():
        print(f"  bucket {name:8} {len(v)}")

    print(f"\n{len(taken)} distinct candidates before horizon analysis")

    if a.skip_horizon:
        lat, lon = xy_to_latlon(np.array([t[0] for t in taken]), np.array([t[1] for t in taken]))
        half = meta["half_extent_m"] / 1000.0
        for (x, y), la, lo in zip(taken, lat, lon):
            r = min(max(int((0.5 - y / (2 * half)) * n), 0), n - 1)
            c = min(max(int((x / (2 * half) + 0.5) * n), 0), n - 1)
            print(f"  {la:8.3f} {lo:8.2f}  {math.hypot(x, y):6.1f} km  "
                  f"elev {dem[r, c]:6.0f} m  sun {sun[r, c]*100:4.0f}%  earth {earth[r, c]*100:4.0f}%")
        return

    # Full-resolution pass, through hz imported at module level.

    ephem = np.frombuffer((OUT / "ephem.bin").read_bytes(), dtype="<f4").reshape(-1, 14)
    emeta = json.loads((OUT / "ephem.json").read_text())
    step_h = emeta["step_hours"]
    years = range(emeta["start_year"], emeta["end_year"] + 1)

    def stats_by_year(lat, lon, hor, h0):
        """Per-year figures, the same way tools/site_stats.py splits the named sites."""
        out = {}
        for yr in years:
            i0 = int((yr - emeta["start_year"]) * 8766 / step_h)
            i1 = int((yr + 1 - emeta["start_year"]) * 8766 / step_h)
            seg = ephem[i0:i1]
            if len(seg) < 8:
                continue
            out[str(yr)] = {k: round(v, 2) if isinstance(v, float) else v
                            for k, v in hz.stats(lat, lon, hor, h0, seg, step_h).items()}
        return out

    # fault proximity, from the catalogue prep_quakes.py ships
    qmeta, scarps = None, []
    qf = OUT / "quakes.json"
    if qf.exists():
        q = json.loads(qf.read_text())
        qmeta, scarps = q["meta"], q["scarps"]

    def nearest_fault_km(lat, lon):
        if not scarps:
            return None
        # great-circle distance is the honest measure at these latitudes; the grid's own
        # planar distance would compress longitude badly near the pole
        best = None
        for s in scarps:
            p1, l1, p2, l2 = (math.radians(lat), math.radians(lon),
                              math.radians(s["lat"]), math.radians(s["lon"]))
            d = 2 * R_M / 1000 * math.asin(math.sqrt(
                math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin((l2 - l1) / 2) ** 2))
            if best is None or d < best:
                best = d
        return round(best, 1)

    cands = []
    for x, y in taken:
        x, y = float(x), float(y)
        half = meta["half_extent_m"] / 1000.0
        r = min(max(int((0.5 - y / (2 * half)) * n), 0), n - 1)
        c = min(max(int((x / (2 * half) + 0.5) * n), 0), n - 1)
        lat, lon = (float(v) for v in xy_to_latlon(np.array([x]), np.array([y])))
        hor, h0 = hz.horizon_profile(lat, lon)
        st = hz.stats(lat, lon, hor, h0, ephem, step_h)
        # keep the grid cell's own classification too, for the map's zone tint
        bucket = next((k for k, v in buckets.items() if (r, c) in v), "placed")
        cands.append(dict(
            id=f"D{len(cands) + 1:02d}",
            en=f"DATA-SELECTED {len(cands) + 1:02d}",
            source="data",
            bucket=bucket,
            lat=round(lat, 4), lon=round(lon, 3), elev_m=round(float(h0), 1),
            x_m=round(x * 1000, 1), y_m=round(y * 1000, 1),
            dist_pole_km=round(math.hypot(x, y), 1),
            slope_deg=round(float(slope[r, c]), 2),
            grid_sun_pct=round(float(sun[r, c]) * 100, 1),
            grid_earth_pct=round(float(earth[r, c]) * 100, 1),
            fault_km=nearest_fault_km(lat, lon),
            horizon_cdeg=[int(round(v * 100)) for v in hor],
            stats={k: (round(v, 2) if isinstance(v, float) else v) for k, v in st.items()},
            stats_by_year=stats_by_year(lat, lon, hor, h0),
        ))
        print(f"{cands[-1]['id']} {bucket:8} {lat:8.3f} {lon:7.2f}  {cands[-1]['dist_pole_km']:6.1f} km  "
              f"sun {st['sun_visible_pct']:5.1f}% earth {st['earth_visible_pct']:5.1f}% "
              f"dark {st['longest_dark_h']:4d} h  fault {cands[-1]['fault_km']} km")

    payload = dict(
        observer_height_m=OBS_H, azimuth_step_deg=0.5,
        ephem_range=[emeta["start_year"], emeta["end_year"]], ephem_step_h=step_h,
        selection=dict(
            grid="zones.json, 480 m cells",
            bucket_sizes={k: len(v) for k, v in buckets.items()},
            min_separation_km=MIN_SEPARATION_KM, max_slope_deg=MAX_SLOPE_DEG,
            min_grid_sun_pct="none: the grid mean cannot see a ridge crest; see the note in this file",
            note="The grid screens candidates; every figure reported here comes from the "
                 "full-resolution horizon profile against the ephemeris, the same pass that "
                 "builds sites.json. Grid visibility values are 18.6 yr means and are kept only "
                 "for reference.",
        ),
        faults=qmeta,
        candidates=cands,
    )
    (OUT / "candidates.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    size = (OUT / "candidates.json").stat().st_size
    print(f"\nwrote {OUT / 'candidates.json'} — {len(cands)} candidates, {size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
