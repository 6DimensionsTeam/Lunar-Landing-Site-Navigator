"""Fetch a south-polar relief basemap for the globe's close-up view, and derive a small
greyscale texture from it.

The globe's equirectangular WAC mosaic (fetch_moon_texture.py) is unusable near the pole:
every longitude line in that projection meets at a single row of texels, so a camera close
enough to read the landing-zone cap sees that row smeared across most of the frame. The
fix is the same one the terrain and zone data already use: south polar stereographic,
which has no pole singularity, fetched from the same ImageServer host with the same WKT
as fetch_zones.py so this raster lands on the identical pixel grid convention.

Source: LRO_LOLA_DEM_SPole45_100mp_v04_SP on trek.nasa.gov, extent +/-1,440,000 m (reaches
45 deg from the pole, i.e. to -45 deg latitude -- comfortably past the ~47 deg of arc the
globe's closest view shows). Fetched well below native resolution: a basemap that fills a
few hundred screen pixels at most gains nothing from LOLA's 100 m/px.

Output is shaded by slope magnitude rather than a hillshade from one sun direction, because
the globe shader lights this texture again with the real, moving Sun on top (the same
treatment the WAC photo gets): baking in one low sun's shadows would show a fixed shadow
direction that fights the live terminator. Slope magnitude has no direction to fight --
rims and walls read as dark regardless of where the real Sun is, the way a relief map
shades "steepness" rather than faking a light.

Usage:
    python tools/fetch_moon_polar.py
"""

import json
import subprocess
import time
import urllib.parse
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "nasa_zones"
OUT = ROOT / "src" / "data"

# SPole75 rather than SPole45: its extent (+/-457 km, 75 deg south to the pole) is what the
# globe's closest view actually shows (colat under 10 deg, about 300 km), and its native
# resolution is 30 m against SPole45's 100 m. Fetching the wider product meant asking for
# ground that never appears on screen at the cost of detail on the ground that always does.
HALF_M = 457_440.0
N = 3000               # 305 m/px, still well above the 30 m source, so the detail is real

# Same WKT as fetch_zones.py: requesting it explicitly, rather than reprojecting afterwards,
# is what keeps this raster on the same (x east, y toward lon 0) pixel grid the zone overlay
# and its stereographic shader math already assume.
WKT = (
    'PROJCS["Moon2000",GEOGCS["GCS_Moon",DATUM["D_Moon_2000",'
    'SPHEROID["Moon_2000_IAU_IAG",1737400.0,0.0]],PRIMEM["Reference_Meridian",0.0],'
    'UNIT["Degree",0.0174532925199433]],PROJECTION["Stereographic_South_Pole"],'
    'PARAMETER["false_easting",0.0],PARAMETER["false_northing",0.0],'
    'PARAMETER["central_meridian",0.0],PARAMETER["scale_factor",1.0],'
    'PARAMETER["latitude_of_origin",-90.0],UNIT["Meter",1.0]]'
)
BASE = "https://trek.nasa.gov/moon/trekarcgis2/rest/services"
SERVICE = "LRO_LOLA_DEM_SPole75_30mp_v04_SP"


def fetch():
    RAW.mkdir(parents=True, exist_ok=True)
    dest = RAW / "spole_relief_dem.tif"
    q = urllib.parse.urlencode({
        "bbox": f"{-HALF_M},{-HALF_M},{HALF_M},{HALF_M}",
        "bboxSR": json.dumps({"wkt": WKT}), "imageSR": json.dumps({"wkt": WKT}),
        "size": f"{N},{N}",
        "format": "tiff", "pixelType": "F32", "f": "image",
        "interpolation": "RSP_BilinearInterpolation",  # heavily downsampling 100m -> 3km/px
    })
    url = f"{BASE}/{SERVICE}/ImageServer/exportImage?{q}"
    t0 = time.time()
    r = subprocess.run(
        ["curl", "-s", "-m", "180", "-o", str(dest), "-w", "%{http_code} %{size_download}", url],
        capture_output=True, text=True,
    )
    code, size = (r.stdout.split() + ["?", "?"])[:2]
    ok = code == "200" and int(size) > 1_000_000
    print(f"fetch {SERVICE}: {code} {int(size)/1e6:.2f} MB {time.time()-t0:.1f}s"
          f"{'' if ok else '  <-- FAILED'}")
    if not ok:
        raise SystemExit("fetch failed")
    return dest


def hillshade(h, scale, az_deg=315.0, alt_deg=35.0):
    """Standard directional hillshade: the shading every published relief map uses, and the
    reason is legibility -- a crater rim lit from one side gets a bright arc and a dark arc,
    which the eye reads instantly as a raised rim. Shading by slope magnitude instead (an
    earlier attempt here) gives a rim the same tone all the way round, so craters come out as
    soft blobs with no sense of up or down, and a field of them looks like water stains.

    No pre-blur: at 305 m/px over a 30 m source the fetch has already averaged away the
    pixel noise a blur would be for, and blurring again is what flattened the rims before.
    """
    gy, gx = np.gradient(h, scale)
    az, alt = np.radians(az_deg), np.radians(alt_deg)
    # surface normal (rows run north to south, hence the sign on gy)
    nx, ny, nz = -gx, gy, np.ones_like(h)
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    lx, ly, lz = np.cos(alt) * np.sin(az), np.cos(alt) * np.cos(az), np.sin(alt)
    return np.clip((nx * lx + ny * ly + nz * lz) * inv, 0.0, 1.0)


def main():
    tif = fetch() if not (RAW / "spole_relief_dem.tif").exists() else RAW / "spole_relief_dem.tif"
    h = np.asarray(Image.open(tif), dtype=np.float32)
    bad = ~np.isfinite(h) | (h < -1e10)
    if bad.any():
        h = h.copy()
        h[bad] = np.nanmedian(h[~bad])

    scale_m = 2 * HALF_M / h.shape[0]
    shade = hillshade(h, scale_m)
    # Match the level of the WAC mosaic band this replaces, or the cap reads as a white disc
    # pasted onto a darker sphere and the cross-fade edge shows however wide it is made. That
    # band (lat -90 to -75 of src/data/moon_global.jpg) averages about 57/255, so the output
    # is centred there. Contrast is kept well below what the hillshade alone would give: this
    # sits under the live lighting pass and the zone tint, and both need headroom.
    TARGET_MEAN, CONTRAST = 57.0 / 255.0, 0.30
    s = shade ** 0.85
    s = (s - s.mean()) / max(s.std(), 1e-6)          # normalise, then place deliberately
    img = np.clip(TARGET_MEAN + s * CONTRAST * TARGET_MEAN, 0.0, 1.0) * 255

    OUT.mkdir(parents=True, exist_ok=True)
    f = OUT / "moon_spole_relief.jpg"
    Image.fromarray(img.astype(np.uint8), "L").save(f, quality=88, optimize=True)
    (OUT / "moon_spole_relief.json").write_text(json.dumps({
        "half_extent_m": HALF_M, "size": h.shape[0],
    }, indent=1))
    print(f"{f.name}: {h.shape[0]}x{h.shape[0]}, {f.stat().st_size/1024:.0f} KB, "
          f"half extent {HALF_M/1000:.0f} km ({scale_m:.0f} m/px)")


if __name__ == "__main__":
    main()
