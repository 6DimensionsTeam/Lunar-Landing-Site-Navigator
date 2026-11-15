"""Convert the published south-polar lobate-scarp catalogue into the project's grid.

Source: Datasets_GRL_2022GL098505, the dataset behind
  Spatial and temporal distribution of lobate scarps in the lunar south polar region,
  Geophysical Research Letters (2022), doi:10.1029/2022GL098505
  Zenodo record 6624114, CC-BY 4.0.

What this is, and what it is not. A lobate scarp is a thrust fault: a young surface break
created as the Moon contracts, and the best available surface evidence of where the ground
is still moving. That makes it a seismic-hazard proxy, not a seismicity measurement. No
event catalogue exists for the south polar region -- the Apollo seismometers sit at
low latitude and nothing has since landed there -- so this file cannot say how often a site
shakes or how hard. It can say how close the site is to a known active fault, which is what
a landing-site selector can honestly act on. Anything phrased as an expected magnitude or a
recurrence interval would be invented.

The catalogue gives each scarp as three points (start, mid, end) in south polar
stereographic metres, which is the same convention the rest of this project uses, so the
conversion to latitude and longitude is the inverse of src/geo.js latLonToMap.

Usage:
    python tools/prep_quakes.py            # needs the extracted dataset under data/raw/
"""

import json
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "scarp_GRL_2022GL098505"
OUT = ROOT / "src" / "data"

R_M = 1737400.0
# Only scarps inside the zone grid are of any use to the selector; the grid reaches
# 151.68 km from the pole. The rest of the catalogue is kept out of the shipped file.
GRID_HALF_M = 151680.0


def read_dbf(path):
    """Minimal dBase III reader: this dataset's tables are plain text fields."""
    data = path.read_bytes()
    nrec = struct.unpack("<I", data[4:8])[0]
    hlen = struct.unpack("<H", data[8:10])[0]
    rlen = struct.unpack("<H", data[10:12])[0]
    fields, off = [], 32
    while off < hlen - 1:
        name = data[off:off + 11].split(b"\x00")[0].decode("latin-1")
        fields.append((name, data[off + 16]))
        off += 32
    rows = []
    for i in range(nrec):
        rec = data[hlen + i * rlen: hlen + (i + 1) * rlen]
        if not rec or rec[0:1] == b"*":
            continue
        p, row = 1, {}
        for name, flen in fields:
            row[name] = rec[p:p + flen].decode("latin-1", "replace").strip()
            p += flen
        rows.append(row)
    return rows


def stereo_to_latlon(x_m, y_m):
    """Inverse of latLonToMap: rho = 2R tan((90-|lat|)/2), x = rho sin(lon), y = rho cos(lon)."""
    rho = math.hypot(x_m, y_m)
    lat = -(90.0 - 2.0 * math.degrees(math.atan(rho / (2.0 * R_M))))
    lon = math.degrees(math.atan2(x_m, y_m)) % 360.0
    return lat, lon


def main():
    dbf = RAW / "All new scarps merged.dbf"
    rows = read_dbf(dbf)
    kept, dropped = [], 0
    for r in rows:
        try:
            xs, ys = float(r["X_start"]), float(r["Y_start"])
            xm, ym = float(r["X_mid"]), float(r["Y_mid"])
            xe, ye = float(r["X_end"]), float(r["Y_end"])
            length_m = float(r["SHAPE_Leng"])
        except (KeyError, ValueError):
            continue
        # Keep a scarp if any of its three points lies inside the grid; clipping a scarp that
        # merely crosses the edge would misreport where the ground actually breaks.
        if not any(abs(x) <= GRID_HALF_M and abs(y) <= GRID_HALF_M for x, y in ((xs, ys), (xm, ym), (xe, ye))):
            dropped += 1
            continue
        lat, lon = stereo_to_latlon(xm, ym)
        la, lo = stereo_to_latlon(xs, ys)
        lb, lb2 = stereo_to_latlon(xe, ye)
        kept.append({
            "id": r["Scarp_ID"],
            "lat": round(lat, 4), "lon": round(lon, 4),
            "start": [round(la, 4), round(lo, 4)],
            "end": [round(lb, 4), round(lb2, 4)],
            # The catalogue's own length field, in metres: this is a scarp's mapped trace
            # length, not a rupture length, so it must not be fed to a magnitude relation.
            "trace_km": round(length_m / 1000.0, 2),
            "dist_pole_km": round(math.hypot(xm, ym) / 1000.0, 1),
        })

    kept.sort(key=lambda s: s["dist_pole_km"])
    meta = {
        "count": len(kept),
        "grid_half_extent_km": GRID_HALF_M / 1000,
        "kept": "scarps with at least one mapped point inside the zone grid",
        "dropped_outside_grid": dropped,
        "meaning": "Mapped young thrust faults (lobate scarps). A hazard proxy: proximity to "
                   "active faults, not a prediction of shaking. No south-polar event catalogue exists.",
        "source": "Spatial and temporal distribution of lobate scarps in the lunar south polar "
                  "region, GRL 2022, doi:10.1029/2022GL098505, Zenodo 6624114, CC-BY 4.0",
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "quakes.json").write_text(json.dumps({"meta": meta, "scarps": kept}, indent=1))
    print(f"{len(kept)} scarps inside the grid, {dropped} outside")
    print(f"nearest {kept[0]['dist_pole_km']} km from the pole ({kept[0]['id']})")
    print(f"wrote {OUT / 'quakes.json'}, {(OUT / 'quakes.json').stat().st_size} bytes")


if __name__ == "__main__":
    main()
