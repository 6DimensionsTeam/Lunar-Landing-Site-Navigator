# Lunar Landing Site Navigator

**Live:** [6dimensions.org](https://6dimensions.org)

A browser tool for comparing candidate landing sites at the lunar south pole, built by **6Dimensions** for the 2026 NASA International Space Apps Challenge.

It shows where the Sun and Earth sit above the local horizon at any hour of 2028–2040, how much of each year a site is sunlit, when direct-to-Earth communication is blocked, and which sites survive a user-defined mission profile.

## What it does

- **Site survey.** Six candidate sites near the south pole — Shackleton Rim, Connecting Ridge, de Gerlache Rim, Malapert Massif, and two additional surveyed sites — each with 360° horizon profiles computed from LOLA 40 m elevation data.
- **Where and when.** For any hour in 2028–2040 it computes Sun elevation (treating the solar disk as an extended source), Earth visibility including topocentric parallax, and the time to the next sunset or blackout.
- **Mission configuration.** The user sets mission year, minimum sunlight fraction, maximum continuous night, Earth-link requirement and darkness tolerance; sites are ranked live against those constraints.
- **Advisory Board.** Before committing to a site, an advisory board session presents expert opinions, historical mission evidence and a knowledge check; it generates a downloadable mission certificate.
- **Rover.** A polar rover (Space ROS URDF mesh) drivable with keyboard or touch, with a mast camera, panel-level solar-power readouts and terrain telemetry. Stands on LOLA 40 m terrain in a rendered near-field scene.
- **Relay station.** A lunar relay station on a Keplerian ellipse (≈ 300 km perilune, ≈ 16 000 km apolune, 55° inclination, ≈ 24 h period), built from NASA's public Gateway Core mesh.
- **Robustness trial.** Tests the ranked order of sites against random mission profiles to show which candidates are consistently strong across a wide range of requirements.

## Running it

**Prerequisites:** [Node.js](https://nodejs.org/) 18 or later.

```bash
# 1. Clone the repo
git clone https://github.com/6DimensionsTeam/Lunar-Landing-Site-Navigator.git
cd Lunar-Landing-Site-Navigator

# 2. Install dependencies
npm install

# 3. Start the dev server (hot-reloads on save)
npm run dev          # opens at http://localhost:5173

# 4. Build a self-contained file for distribution
npm run build        # writes dist/index.html — no server needed, opens offline

# 5. Run the tests
npm test             # data integrity and advisor unit tests
```

The production build is a single HTML file with all scripts, styles, fonts and terrain data inlined — share or open `dist/index.html` directly with no server.

URL flags (development only):

- `?trim` — core-alignment calibration panel, opens straight into the relay view.
- `?orbit` — draw the full relay orbit ellipse in the relay view.

## Data sources

| Source | What is used | Notes |
|---|---|---|
| [LOLA](https://imbrium.mit.edu/) polar DEMs (`ldem_85s_40m`, `ldem_75s_240m`) | terrain and horizon profiles | pre-processed into `src/data/terrain_*.bin` |
| [JPL DE421](https://ssd.jpl.nasa.gov/planets/eph_export.html) | Sun and Earth ephemeris, 2026–2040 | `src/data/ephem.bin`, 3 h steps |
| [NASA 3D Resources — Gateway Core](https://github.com/nasa/NASA-3D-Resources) | relay station core modules | `src/data/station.glb` |
| [Space ROS `lunar_pole_exploration_rover`](https://github.com/space-ros) | rover mesh and joints | Apache-2.0, credited in the UI |
| [LOLA slope](https://trek.nasa.gov/moon/) `Slope_ldem_85s_20m_Spole_float_SP` | landing-zone slope map | 20 m resolution |
| [LOLA average visibility](https://trek.nasa.gov/moon/) `AVGVISIB_85S_060M_201608_SP` and `_EARTH_SP` | zone sunlight and Earth-link | 60 m, 18.6-year mean |
| [Diviner](https://trek.nasa.gov/moon/) `diviner_tbol_max_SP` | cold-trap classification | ice stable below ≈ 110 K |

Horizon profiles are validated against JPL Horizons (`tools/validate_horizons.py`). Site statistics are cross-checked in rank order against NASA's PGDA polar illumination maps and the LOLA average Earth visibility product.

Using LOLA and Diviner data requires citing Mazarico, E., et al. (2011), *Illumination conditions of the lunar polar regions using LOLA topography*, Icarus 211, 1066–1081, doi:10.1016/j.icarus.2010.10.030.

## Repository layout

```
index.html            markup and HUD
src/main.js           app wiring, modes, render loop
src/board.js          advisory board session and certificate
src/router.js         URL-per-screen routing
src/advisors.js       historical mission evidence
src/annual-calendar.js  full-year sun/earth statistics
src/scene/            terrain, sky, bodies, station, rover, shadow, post
src/glsl/             terrain, haze and near-field shaders
src/data/             generated data (ephemeris, terrain, meshes, candidates)
src/assets/           UI images and team assets
tools/                offline processing: DEM prep, ephemeris, horizon profiles, zones, validation
tests/                unit tests (node:test)
```

`tools/` requires Python with numpy, scipy and skyfield; the raw DEMs and the DE421 SPK go in `data/raw/`, which is not tracked.

## Team

**6Dimensions** — 2026 NASA International Space Apps Challenge

## Licence

Apache-2.0, see `LICENSE`. Model and data sources keep their own terms as listed above and credited in the UI.
