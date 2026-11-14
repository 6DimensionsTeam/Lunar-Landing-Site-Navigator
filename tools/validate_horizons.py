"""Compare our Sun and Earth azimuth/elevation against the official JPL Horizons results point by point.

Horizons: observer at a lunar lat/lon (CENTER=coord@301), apparent azimuth and elevation (QUANTITIES=4).
Ours: read src/data/ephem.bin and do the same horizontal-coordinate conversion for the same sites (topocentric parallax included for Earth).
Output src/data/validation.json, used directly by the "Verification" column on the page.
"""

import csv
import io
import json
import subprocess
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data"
R_MOON_KM = 1737.4
API = "https://ssd.jpl.nasa.gov/api/horizons.api"

SITES = [  # name, latitude, east longitude, km above the reference sphere (0, comparing direction only)
    ("S1", -89.50, 200.0),
    ("S2", -88.70, 290.0),
    ("S3", -86.00, 0.0),
]
TARGETS = {"sun": "10", "earth": "399"}
STEP_DAYS = 6


def horizons(target, lat, lon):
    q = {
        "format": "text", "COMMAND": f"'{target}'", "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES", "EPHEM_TYPE": "OBSERVER", "CENTER": "'coord@301'",
        "COORD_TYPE": "GEODETIC", "SITE_COORD": f"'{lon},{lat},0'",
        "START_TIME": "'2028-01-01 00:00'", "STOP_TIME": "'2028-12-31 00:00'",
        "STEP_SIZE": f"'{STEP_DAYS} d'", "QUANTITIES": "'4'", "CSV_FORMAT": "YES",
        "APPARENT": "AIRLESS", "ANG_FORMAT": "DEG", "TIME_DIGITS": "MINUTES",
    }
    url = API + "?" + urllib.parse.urlencode(q)
    # Python's certificate chain check fails on this network while system curl works, so fetch with curl and keep verification on
    txt = subprocess.run(["curl", "-sS", "-m", "120", url], check=True,
                         capture_output=True, text=True).stdout
    body = txt.split("$$SOE")[1].split("$$EOE")[0]
    rows = []
    for rec in csv.reader(io.StringIO(body)):
        if not rec or not rec[0].strip():
            continue
        t = datetime.strptime(rec[0].strip(), "%Y-%b-%d %H:%M").replace(tzinfo=timezone.utc)
        nums = [float(x) for x in rec[1:] if x.strip() and x.strip().replace(".", "", 1).lstrip("-").isdigit()]
        rows.append((t, nums[-2], nums[-1]))  # azimuth, elevation
    return rows


def enu(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    north = np.cross(up, east)
    return east, north, up


def azel(v, lat, lon):
    e, n, u = enu(lat, lon)
    v = v / np.linalg.norm(v)
    az = np.degrees(np.arctan2(v @ e, v @ n)) % 360
    el = np.degrees(np.arcsin(np.clip(v @ u, -1, 1)))
    return az, el


def main():
    meta = json.loads((OUT / "ephem.json").read_text())
    rec = np.frombuffer((OUT / "ephem.bin").read_bytes(), dtype="<f4").reshape(-1, 14)
    t0 = datetime.fromisoformat(meta["start_utc"].replace("Z", "+00:00"))
    out = {"step_days": STEP_DAYS, "sites": []}
    worst = 0.0
    for name, lat, lon in SITES:
        site_vec = R_MOON_KM * enu(lat, lon)[2]
        entry = {"name": name, "lat": lat, "lon": lon, "targets": {}}
        for key, code in TARGETS.items():
            d_az, d_el = [], []
            for t, h_az, h_el in horizons(code, lat, lon):
                k = int(round((t - t0) / timedelta(hours=meta["step_hours"])))
                if key == "sun":
                    v = rec[k, 0:3].astype(np.float64)
                else:
                    v = rec[k, 3:6].astype(np.float64) - site_vec
                az, el = azel(v, lat, lon)
                d_el.append(el - h_el)
                d_az.append((az - h_az + 180) % 360 - 180)
            d_az, d_el = np.abs(d_az), np.abs(d_el)
            entry["targets"][key] = {
                "samples": len(d_el),
                "max_err_el_deg": float(d_el.max()), "mean_err_el_deg": float(d_el.mean()),
                "max_err_az_deg": float(d_az.max()), "mean_err_az_deg": float(d_az.mean()),
            }
            worst = max(worst, d_el.max())
            print(f"{name} {key:5s} n={len(d_el):3d}  elevation error max {d_el.max():.4f}° mean {d_el.mean():.4f}°  "
                  f"azimuth error max {d_az.max():.4f}°")
        out["sites"].append(entry)
    out["worst_el_err_deg"] = float(worst)
    (OUT / "validation.json").write_text(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
