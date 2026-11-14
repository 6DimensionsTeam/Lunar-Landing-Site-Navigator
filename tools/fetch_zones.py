"""Download the NASA rasters tools/prep_zones.py classifies, into data/raw/nasa_zones.

Each layer is pulled through the ArcGIS ImageServer exportImage operation as a float32
GeoTIFF, at the grid prep_zones.py expects: south polar stereographic, half extent
151680 m, 632 x 632. Requesting the projection explicitly means the result lines up with
the inner terrain tile cell for cell, with no reprojection step on our side.

All four services live on trek.nasa.gov/moon/trekarcgis2. The sibling host trekarcgis
holds the ice-depth and water-equivalent-hydrogen services, which would suit the ice
class even better, but every request to those two returns 502 after exactly 61 seconds
while the host's own service list answers in a second, so they are unreachable rather
than misaddressed.

Usage:
    python tools/fetch_zones.py
"""

import json
import subprocess
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "nasa_zones"

HALF_M = 151680.0
N = 632

WKT = (
    'PROJCS["Moon2000",GEOGCS["GCS_Moon",DATUM["D_Moon_2000",'
    'SPHEROID["Moon_2000_IAU_IAG",1737400.0,0.0]],PRIMEM["Reference_Meridian",0.0],'
    'UNIT["Degree",0.0174532925199433]],PROJECTION["Stereographic_South_Pole"],'
    'PARAMETER["false_easting",0.0],PARAMETER["false_northing",0.0],'
    'PARAMETER["central_meridian",0.0],PARAMETER["scale_factor",1.0],'
    'PARAMETER["latitude_of_origin",-90.0],UNIT["Meter",1.0]]'
)

BASE = "https://trek.nasa.gov/moon/trekarcgis2/rest/services"
LAYERS = {
    "slope20": "Slope_ldem_85s_20m_Spole_float_SP",
    "sunvis": "AVGVISIB_85S_060M_201608_SP",
    "earthvis": "AVGVISIB_85S_060M_201608_EARTH_SP",
    "tmax": "diviner_tbol_max_SP",
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sr = json.dumps({"wkt": WKT})
    for name, service in LAYERS.items():
        q = urllib.parse.urlencode({
            "bbox": f"{-HALF_M},{-HALF_M},{HALF_M},{HALF_M}",
            "bboxSR": sr, "imageSR": sr,
            "size": f"{N},{N}",
            "format": "tiff", "pixelType": "F32", "f": "image",
            "interpolation": "RSP_BilinearInterpolation",
        })
        url = f"{BASE}/{service}/ImageServer/exportImage?{q}"
        dest = OUT / f"{name}.tif"
        t0 = time.time()
        r = subprocess.run(
            ["curl", "-s", "-m", "180", "-o", str(dest), "-w", "%{http_code} %{size_download}", url],
            capture_output=True, text=True,
        )
        code, size = (r.stdout.split() + ["?", "?"])[:2]
        ok = code == "200" and int(size) > 1_000_000
        print(f"{name:10} {service:42} {code} {int(size)/1e6:5.2f} MB "
              f"{time.time()-t0:5.1f}s {'' if ok else '  <-- FAILED'}")


if __name__ == "__main__":
    main()
