// Live horizontal coordinates for the candidate sites: Sun and Earth azimuth/elevation, whether terrain blocks them, when the next sunset/sunrise is.
// Same conventions as tools/horizon.py: Moon-fixed ENU, azimuth clockwise from north, sunlit when more than 50% of the solar disk is visible.
import * as THREE from 'three';
import { latLonToMap, mapToScene } from './geo.js';

const SUN_R = 0.2666;          // solar apparent radius (deg)
const OBS_H = 0.002;           // observer 2 m above the ground, matching the horizon profile
const deg = THREE.MathUtils.radToDeg;

function diskFraction(el, hor) {
  const h = THREE.MathUtils.clamp((el - hor) / SUN_R, -1, 1);
  return 1 - (Math.acos(h) - h * Math.sqrt(1 - h * h)) / Math.PI;
}

export function createSites(data, eph) {
  const R = data.radiusKm;
  const step = data.sites.azimuth_step_deg;
  // Every measured place, not just the four published regions: the pre-selected pool, and the
  // ground the scan measured and rejected. All of them carry the same horizon profile, so all of
  // them can answer "is the Sun up here right now", which is what the surface HUD asks once the
  // camera is standing at a site the user chose rather than always at Shackleton.
  const source = [
    ...data.sites.sites.map((s) => ({ ...s, source: 'nasa' })),
    ...(data.candidates?.candidates || []).map((s) => ({ ...s, source: 'data' })),
    ...(data.candidates?.surveyed || []).map((s) => ({ ...s, source: 'surveyed' })),
  ];
  const sites = source.map((s) => {
    const la = THREE.MathUtils.degToRad(s.lat), lo = THREE.MathUtils.degToRad(s.lon);
    const up = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
    const east = new THREE.Vector3(-Math.sin(lo), Math.cos(lo), 0);
    const north = up.clone().cross(east);
    const hKm = s.elev_m / 1000;
    const map = latLonToMap(R, s.lat, s.lon);
    return {
      ...s, up, east, north, map,
      posME: up.clone().multiplyScalar(R + hKm + OBS_H),
      scene: mapToScene(R, map, hKm + 0.02),             // scene coordinates for the HUD marker
      hor: Float32Array.from(s.horizon_cdeg, (v) => v / 100),
    };
  });

  const sunME = new THREE.Vector3(), earthME = new THREE.Vector3(), v = new THREE.Vector3();

  function horAt(site, az) {
    const n = site.hor.length, f = az / step;
    const i0 = Math.floor(f), w = f - i0;
    return site.hor[((i0 % n) + n) % n] * (1 - w) + site.hor[(((i0 + 1) % n) + n) % n] * w;
  }

  function azel(site, dir) {
    return {
      az: (deg(Math.atan2(dir.dot(site.east), dir.dot(site.north))) + 360) % 360,
      el: deg(Math.asin(THREE.MathUtils.clamp(dir.dot(site.up), -1, 1))),
    };
  }

  // Sun and Earth as seen from a site at a given time
  function look(site, h) {
    eph.rawAt(h, sunME, earthME);
    const sun = azel(site, sunME);
    sun.hor = horAt(site, sun.az);
    sun.frac = diskFraction(sun.el, sun.hor);
    sun.lit = sun.frac > 0.5;
    v.copy(earthME).sub(site.posME);
    const distKm = v.length();
    const earth = azel(site, v.divideScalar(distKm));
    earth.hor = horAt(site, earth.az);
    earth.visible = earth.el > earth.hor;
    earth.distKm = distKm;
    // Fraction of Earth lit: the Sun-Moon-Earth angle sets the phase (as seen from the lunar surface)
    const cosPhase = -sunME.dot(v);
    earth.illum = (1 + cosPhase) / 2;
    return { sun, earth };
  }

  // From h onward, the time the state of key ('sun' or 'earth') first flips (hours, to the second),
  // or null if it does not flip within SEARCH_H or before the ephemeris ends
  const state = (site, h, key) => (key === 'sun' ? look(site, h).sun.lit : look(site, h).earth.visible);
  // How far ahead to look for a state change. Bounded on purpose: the ephemeris spans years and
  // scanning all of it would stall the frame this runs on. A lunar day is only about 708 h, but a
  // high polar site can stay lit far longer than that when the 18.6-year cycle is favourable —
  // measured over 2026–2040 the longest continuous sunlit run is 4910 h at Connecting Ridge
  // (205 days), and the longest run with Earth in view is 578 h. 6000 h clears both.
  const SEARCH_H = 6000;
  function nextChange(site, h0, key) {
    const end = Math.min(h0 + SEARCH_H, eph.maxH);
    const s0 = state(site, h0, key);
    let a = h0;
    // Scan hour by hour regardless of the ephemeris step: the interpolated state is what the
    // rest of the app reads, and a sunrise can fall between two samples.
    for (let b = Math.floor(h0) + 1; b <= end; b++) {
      if (state(site, b, key) !== s0) {
        let lo = a, hi = b;
        for (let i = 0; i < 14; i++) {
          const mid = (lo + hi) / 2;
          if (state(site, mid, key) === s0) lo = mid; else hi = mid;
        }
        return hi;
      }
      a = b;
    }
    return null;
  }

  return { sites, byId: (id) => sites.find((s) => s.id === id), look, nextChange };
}
