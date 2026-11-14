# Lunar Landing Site Navigator

A browser tool for comparing candidate landing sites at the lunar south pole: it shows where the Sun and
the Earth sit above the local horizon, how much of 2028 a site is sunlit, and when direct-to-Earth
communication is blocked by terrain.

Built for the 2026 NASA International Space Apps Challenge, "Lunar Landing Site Navigator".

## What it does

- **Candidate sites.** Four sites near the south pole (Shackleton Rim, Connecting Ridge, de Gerlache Rim,
  Malapert Massif), each with a 360° horizon profile computed from LOLA elevation data.
- **Sun and Earth from the ground.** For any hour of 2028 it computes the Sun's elevation with the solar
  disk treated as an extended source (not a point), Earth visibility including topocentric parallax, and
  the time to the next sunset.
- **Full-year statistics.** Sunlit fraction, Earth-visible fraction, both at once, and the longest
  continuous night, per site.
- **Relay station.** A scene of the HALO lunar relay station: an elliptical lunar orbit (≈300 km
  perilune, ≈16000 km apolune, 55° inclination) that spends most of its period over the south pole.
  The station model is built from NASA's public Gateway Core mesh plus procedurally generated structure.
- **Rover.** A polar rover from the Space ROS URDF, drivable with keyboard or touch, with a mast camera
  and panel-level power readouts.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # writes a single self-contained dist/index.html
```

The build is one file: scripts, styles, fonts and terrain data are all inlined, so `dist/index.html`
opens offline with no server.

URL flags (development only):

- `?trim` — core-alignment calibration panel, opens straight into the relay view.
- `?orbit` — draw the full relay orbit ellipse in the relay view.

## Data

| Source | What is used | Notes |
|---|---|---|
| [LOLA](https://imbrium.mit.edu/) polar DEMs (`ldem_85s_40m`, `ldem_75s_240m`) | terrain and horizon profiles | pre-processed into `src/data/terrain_*.bin` |
| [JPL DE421](https://ssd.jpl.nasa.gov/planets/eph_export.html) | Sun and Earth ephemeris, 2026–2040 | `src/data/ephem.bin`, 3 h steps |
| [NASA 3D Resources — Gateway Core](https://github.com/nasa/NASA-3D-Resources) | relay station core modules | `src/data/station.glb` |
| [Space ROS `lunar_pole_exploration_rover`](https://github.com/space-ros) | rover mesh and joints | Apache-2.0, see the rover credit line in the UI |

Horizon profiles are validated against JPL Horizons (`tools/validate_horizons.py`); site statistics are
cross-checked in rank order against NASA's PGDA polar illumination maps.

## Repository layout

```
index.html            markup and HUD
src/main.js           app wiring, modes, render loop
src/scene/            terrain, sky, bodies, station, rover, shadow, post
src/glsl/             terrain, haze and near-field shaders
src/data/             generated data (ephemeris, terrain, meshes)
tools/                offline processing: DEM prep, ephemeris, horizon profiles, validation
```

`tools/` requires Python with numpy, scipy and skyfield; the raw DEMs and the DE421 SPK go in
`data/raw/`, which is not tracked.

## Licence

Apache-2.0, see `LICENSE`. Model and data sources keep their own terms, listed above and credited in
the UI.
