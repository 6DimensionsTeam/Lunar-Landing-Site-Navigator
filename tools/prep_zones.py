"""Build the landing-zone map the page colours the surface with.

Classifies the south polar region into zone types and packs the per-cell values the
interface shows on hover. Output src/data/zones.bin and the zone block in
src/data/zones.json.

Grid: south polar stereographic, the same projection and the same half extent as the
inner terrain tile (151680 m), so a cell maps onto the terrain with no reprojection.
632 x 632 cells at 480 m. That is coarse next to the 20 m slope it is built from, which
is the point: zones are regions a person hovers over, not per-pixel truth. Anything that
needs precision, such as the figures quoted for a candidate site, comes from the
full-resolution horizon profiles in sites.json instead.

Sources, all NASA, fetched by tools/fetch_zones.py into data/raw/nasa_zones:
  slope20   Slope_ldem_85s_20m_Spole_float_SP     slope in degrees, from the same
                                                  ldem_85s DEM this project renders
  sunvis    AVGVISIB_85S_060M_201608_SP           average visible fraction of the solar
                                                  disc over 18.6 years, 60 m
  earthvis  AVGVISIB_85S_060M_201608_EARTH_SP     same for the Earth, 60 m
  tmax      diviner_tbol_max_SP                   Diviner bolometric maximum temperature
Why these four. Water ice is stable where the maximum temperature stays below about
110 K, which is the Diviner cold-trap criterion, so tmax defines the ice class directly
rather than standing in for it. Slope decides whether a lander can sit. The two average
visibility products decide power and direct-to-Earth communication.

The ice-depth and water-equivalent-hydrogen services would have been better still for
the ice class, but both sit on trek.nasa.gov/moon/trekarcgis, which returns 502 for
every request to them; the working services are all on trekarcgis2.
"""

import json
import zlib
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "nasa_zones"
OUT = ROOT / "src" / "data"

R_M = 1737400.0
HALF_M = 151680.0            # same as terrain.json tiles.inner.half_extent_m
N = 632                      # 480 m cells
CELL_M = 2 * HALF_M / N

# Thresholds. Slope and temperature are physical; the solar cut is a quantile because the
# 18.6-year average disc fraction has no natural threshold and its range depends on the
# extent requested.
SLOPE_FLAT_DEG = 10.0
TMAX_COLD_K = 110.0          # ice is stable below about this, the Diviner cold-trap criterion
SUN_QUANTILE = 0.90
EARTH_LINK = 0.50

# Mutually exclusive, so a cell has exactly one colour and the legend is unambiguous
ZONE = {
    "unmapped": 0,
    "shadow": 1,    # never sees the Sun; ice may be stable in the colder parts
    "prime": 2,     # flat, sunlit and in view of Earth
    "sunlit": 3,    # sunlit but too steep or without a direct Earth link
    "flat": 4,      # landable but poorly lit
    "rough": 5,     # neither
}


def load(name):
    a = np.asarray(Image.open(RAW / f"{name}.tif"), dtype=np.float32)
    if a.shape != (N, N):
        raise SystemExit(f"{name}: expected {N}x{N}, got {a.shape}")
    return a


# Readout fields, with the step each one is stored at. The steps are chosen for what a
# hover readout can honestly claim, not for the precision of the source: a cell is 480 m
# across, so its value is an area characteristic either way, and storing slope to 0.01°
# would only make the file bigger while implying precision the cell does not have.
#   name: (low, high, levels, step as shown to a reader)
FIELDS = {
    "slope_deg":  (0.0, 64.0, 128, "0.5°"),
    "sun":        (0.0, 1.0, 101, "1%"),
    "earth":      (0.0, 1.0, 101, "1%"),
    "tmax_k":     (40.0, 320.0, 141, "2 K"),
    "ice_dist_m": (0.0, 128000.0, 129, "1 km"),
}


def quantise(a, lo, hi, levels):
    """Map a float field onto 0..levels-1, clamped."""
    return (np.clip((a - lo) / (hi - lo), 0, 1) * (levels - 1) + 0.5).astype(np.uint8)


def pack_plane(a):
    """Row-wise left predictor, then zlib. Cuts each plane by roughly a fifth, because a
    neighbouring cell is usually close in value; the decoder adds the running value back."""
    x = a.astype(np.int32)
    p = np.zeros_like(x)
    p[:, 1:] = x[:, :-1]
    res = ((x - p + 128) % 256) - 128
    return res.astype(np.int8).astype(np.uint8).tobytes()


def main():
    layers = {k: load(k) for k in ("slope20", "sunvis", "earthvis", "tmax")}

    yy, xx = np.mgrid[0:N, 0:N]
    X = (xx + 0.5) / N * 2 * HALF_M - HALF_M
    Y = HALF_M - (yy + 0.5) / N * 2 * HALF_M
    inside = np.hypot(X, Y) <= HALF_M

    slope, sun, earth, tmax = layers["slope20"], layers["sunvis"], layers["earthvis"], layers["tmax"]
    sun_cut = float(np.quantile(sun[inside], SUN_QUANTILE))

    flat = slope < SLOPE_FLAT_DEG
    sunny = sun > sun_cut
    link = earth > EARTH_LINK

    # Permanent shadow comes from the 60 m solar visibility product, not from Diviner.
    # Diviner maximum temperature is the physically correct test for whether ice is stable,
    # but its source is gridded in latitude and longitude at about 0.54 deg, which is some
    # 16 km on the ground: every one of its common values covers exactly 175 cells of this
    # grid spanning exactly that latitude band. The ImageServer advertises 2413 m, which is
    # only the pixel size of NASA's own resampling of it. At 16 km a cold-trap outline cannot
    # follow a crater floor at all, so drawing one would be a picture of the gridding rather
    # than of the Moon. Solar visibility resolves the same regions properly: it yields 1885
    # shadow regions against Diviner's 15, its edges sit on steeper ground than its interiors
    # as a crater wall around a floor should, and it still contains Shoemaker, Faustini and
    # Haworth. Temperature is carried per cell as a readout, with its own resolution recorded.
    shadow = (sun <= 0.0) & inside

    cls = np.full((N, N), ZONE["unmapped"], dtype=np.uint8)
    cls[inside & ~flat & ~sunny] = ZONE["rough"]
    cls[inside & flat] = ZONE["flat"]
    cls[inside & sunny] = ZONE["sunlit"]
    cls[inside & flat & sunny & link] = ZONE["prime"]
    cls[shadow] = ZONE["shadow"]              # last, so shadow is never relabelled

    # Distance to the nearest permanently shadowed ground, which is what "near ice" has to
    # mean for a site that cannot itself sit in the dark
    dist_m = ndimage.distance_transform_edt(~shadow) * CELL_M

    source = {"slope_deg": slope, "sun": sun, "earth": earth, "tmax_k": tmax, "ice_dist_m": dist_m}
    quantised = {k: quantise(source[k], lo, hi, lv) for k, (lo, hi, lv, _) in FIELDS.items()}

    # One plane after another, each predicted along its own rows, so a plane compresses
    # against its own spatial coherence instead of being interleaved with the others
    planes = [cls] + [quantised[k] for k in FIELDS]
    raw = b"".join(pack_plane(p) for p in planes)
    packed = zlib.compress(raw, 9)
    (OUT / "zones.bin").write_bytes(packed)

    counts = {k: int((cls == v).sum()) for k, v in ZONE.items()}
    n_in = int(inside.sum())
    meta = {
        "size": N,
        "half_extent_m": HALF_M,
        "cell_m": CELL_M,
        "radius_m": R_M,
        "planes": ["class"] + list(FIELDS),
        "encoding": "zlib over planes, each row-predicted (value minus the cell to its left, wrapped to int8)",
        "scales": {k: {"lo": lo, "hi": hi, "levels": lv, "step": step}
                   for k, (lo, hi, lv, step) in FIELDS.items()},
        "zones": ZONE,
        "thresholds": {
            "slope_flat_deg": SLOPE_FLAT_DEG,
            "shadow_rule": "solar average visible fraction = 0",
            "tmax_cold_k": TMAX_COLD_K,
            "sun_quantile": SUN_QUANTILE,
            "sun_cut": round(sun_cut, 4),
            "earth_link": EARTH_LINK,
        },
        # Share of the permanently shadowed area that is also cold enough for ice to be
        # stable, by the coarse temperature field. Shadow alone is not enough: a small dark
        # patch beside a sunlit wall is warmed by what that wall radiates.
        "shadow_also_cold_pct": round(float((tmax[shadow] < TMAX_COLD_K).mean() * 100), 1),
        "share_pct": {k: round(counts[k] / n_in * 100, 2) for k in ZONE if k != "unmapped"},
        # Native resolution per source, because it is not uniform and the ice class is the
        # one place it matters: Diviner is coarser than a cell, so a cold-trap outline is
        # only good to about 2.4 km and the interface should not draw it as a crisp edge.
        "native_m": {"slope_deg": 20, "sun": 60, "earth": 60, "tmax_k": 2413},
        "sources": {
            "slope": "Slope_ldem_85s_20m_Spole_float_SP (LRO LOLA, 20 m)",
            "sun": "AVGVISIB_85S_060M_201608_SP (LRO LOLA, 60 m, 18.6 yr mean)",
            "earth": "AVGVISIB_85S_060M_201608_EARTH_SP (LRO LOLA, 60 m, 18.6 yr mean)",
            "tmax": "diviner_tbol_max_SP (LRO Diviner, 2413 m, nearest-neighbour onto this grid)",
            "citation": ("Mazarico, E., et al. (2011), Illumination conditions of the lunar polar "
                         "regions using LOLA topography, Icarus 211, 1066-1081, "
                         "doi:10.1016/j.icarus.2010.10.030"),
        },
    }
    (OUT / "zones.json").write_text(json.dumps(meta, indent=1))

    print(f"{N}x{N} at {CELL_M:.0f} m, {n_in} cells inside the mapped disc")
    print(f"solar cut at the {SUN_QUANTILE:.0%} quantile: {sun_cut:.4f}")
    for k in ZONE:
        if k == "unmapped":
            continue
        print(f"  {k:8} {counts[k]:7d} cells  {counts[k]/n_in*100:5.2f}%  "
              f"{counts[k]*CELL_M**2/1e6:8.0f} km^2")
    print(f"raw {len(raw)/1e6:.2f} MB -> zlib {len(packed)/1e6:.2f} MB "
          f"({len(packed)/len(raw)*100:.1f}%)")


if __name__ == "__main__":
    main()
