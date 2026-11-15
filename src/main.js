import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadAll } from './data.js';
import { Ephemeris } from './ephemeris.js';
import { latLonToMap, mapToScene, sceneToMap, upAt, makeHeightSampler } from './geo.js';
import { createTerrain, bakeGradients } from './scene/terrain.js';
import { createShadows } from './scene/shadow.js';
import { createSky } from './scene/sky.js';
import { createBodies } from './scene/bodies.js';
import { createPost } from './scene/post.js';
import { createSites } from './sites.js';
import { createRig } from './rig.js';
import { createHud, reducedMotion } from './hud.js';
import { createStation, STATION, CORE_TRIM } from './scene/station.js';
import { createRover, SPEED_LIMITS } from './scene/rover.js';
import { createZones } from './zones.js';
import { createGlobe } from './scene/globe.js';
import { rankSites, statsFor, explain, candidatePool } from './rank.js';
import { buildWorlds, runWorlds, summarise as worldsSummarise } from './worlds.js';
import { reviewSite } from './advisors.js';

// Home-screen epoch: 2028-09-29 12:00 UTC. Seen from Shackleton, Earth (a 15%-lit crescent) and the Sun both stand only 1.7–3° above the horizon,
// about 45° apart in azimuth, straddling the south polar ridge. The clock then runs forward at real speed.
// Held as a date, not an offset, so it still points at that composition when the ephemeris range changes.
const HOME_EPOCH_UTC = '2028-09-29T12:00:00Z';
// Large screens lower the render resolution automatically to hold frame rate; the HUD is DOM and unaffected
const PIXEL_BUDGET = 2.6e6;
const pixelRatio = () => {
  const pr = Math.min(window.devicePixelRatio, 1.5);
  const px = window.innerWidth * window.innerHeight * pr * pr;
  return px > PIXEL_BUDGET ? Math.max(0.6, pr * Math.sqrt(PIXEL_BUDGET / px)) : pr;
};

const hud = createHud({ bootSteps: 12 });
const GM_MOON = 4902.800066;   // km³/s²
const pad2 = (n) => String(n).padStart(2, '0');

// Measure the crater from the DEM: lowest point of the floor, highest rim point in each azimuth
function measureCrater(heightAt, approx) {
  let floor = Infinity, c = approx.clone();
  for (let dx = -2; dx <= 2; dx += 0.1) {
    for (let dy = -2; dy <= 2; dy += 0.1) {
      const m = new THREE.Vector2(approx.x + dx, approx.y + dy), h = heightAt(m);
      if (h < floor) { floor = h; c = m; }
    }
  }
  let rimSum = 0, rSum = 0;
  const n = 72;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    let best = -Infinity, br = 0;
    for (let r = 6; r <= 14; r += 0.05) {
      const h = heightAt(new THREE.Vector2(c.x + r * Math.cos(a), c.y + r * Math.sin(a)));
      if (h > best) { best = h; br = r; }
    }
    rimSum += best;
    rSum += br;
  }
  const rimH = rimSum / n;
  return { center: c, floorH: floor, rimH, radius: rSum / n, depth: rimH - floor };
}

let worldsOpen = null, worldsClose = null, worldsIsOpen = null;

async function boot() {
  const B = hud.boot;
  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // the grading pass writes display space itself
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;               // only the relay scene has a casting light; terrain uses its own shadow map
  renderer.shadowMap.type = THREE.PCFShadowMap;
  let PR = pixelRatio();
  renderer.setPixelRatio(PR);
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0, 0, 0);
  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 4000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 2;
  controls.maxDistance = 220;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
  controls.rotateSpeed = 0.45;
  controls.zoomSpeed = 0.7;
  controls.enabled = false;

  // ---- Data ----
  const steps = {
    hero: ['Decode polar terrain, LOLA 40 m', (m) => `${m.size}² grid`],
    inner: ['Decode inner terrain, LOLA 120 m', (m) => `${m.size}² grid`],
    outer: ['Decode outer terrain, LOLA 480 m', (m) => `${m.size}² grid`],
    zones: ['Decode landing zones, LOLA + Diviner', (m) => `${m.size}² at ${m.cell_m} m`],
    ephem: ['Load ephemeris, JPL DE421', (m) => `${m.count} samples · ${m.step_hours} h`],
  };
  const order = Object.keys(steps);
  let open = B.line(steps[order[0]][0]);
  const data = await loadAll((key, meta) => {
    B.done(open, steps[key][1](meta));
    const i = order.indexOf(key) + 1;
    if (i < order.length) open = B.line(steps[order[i]][0]);
  });
  const R = data.radiusKm;
  const eph = new Ephemeris(data.ephem, data.ephemMeta, R);
  const heightAt = makeHeightSampler(data.tiles);
  const groundAt = (m, above = 0) => mapToScene(R, m, heightAt(m) + above);

  // Year labels come from the ephemeris metadata, so the UI follows whatever range was built
  hud.bind('eph-range', eph.startYear === eph.endYear ? `${eph.startYear}` : `${eph.startYear}–${eph.endYear}`);
  hud.bind('eph-step', eph.stepH === 1 ? 'hourly' : `${eph.stepH} h`);
  // The table shows the whole-range average; per-year figures live in site.stats_by_year
  // and belong on the selection panel once the user has picked an arrival date.
  {
    const sy = data.sites.stats_years;
    hud.bind('stats-year', sy ? (sy[0] === sy[1] ? `${sy[0]}` : `${sy[0]}–${sy[1]}`) : `${eph.startYear}`);
  }

  // Clock: mission time (hours since the start of the ephemeris range) advances at rate× speed
  const HOME_EPOCH_H = (Date.parse(HOME_EPOCH_UTC) - eph.start) / 3600e3;
  const clock = { epochH: HOME_EPOCH_H, t0: performance.now(), rate: 1 };
  const nowH = (t = performance.now()) => Math.min(clock.epochH + ((t - clock.t0) / 3.6e6) * clock.rate, eph.maxH);

  let terrain, shadows, sky, bodies, post, sites, crater, rig, station, rover, relayOrbit;
  await B.run('Build terrain mesh and bake normals', () => {
    terrain = createTerrain(data);
    bakeGradients(renderer, terrain);
    scene.add(terrain.group);
    return '3 nested levels';
  });
  // The landing point, marked on the ground. Standing on the surface there was nothing saying
  // which patch of it the mission had chosen: the panels named the site and the camera was
  // pointed at it, but the terrain itself carried no mark, so "where exactly am I" had no answer
  // in the view. A flat ring with a short mast, in the HUD's accent red so it cannot be mistaken
  // for terrain. Placed in scene units (km) from the site's own map coordinates.
  const siteMark = (() => {
    const group = new THREE.Group();
    const red = 0xe2200f;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.035, 0.05, 48, 1),
      new THREE.MeshBasicMaterial({ color: red, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    const inner = new THREE.Mesh(
      new THREE.CircleGeometry(0.012, 24),
      new THREE.MeshBasicMaterial({ color: red, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
    );
    inner.rotation.x = -Math.PI / 2;
    // A mast, so the point is findable when the camera is low and the ring is edge-on.
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0022, 0.0022, 0.09, 6),
      new THREE.MeshBasicMaterial({ color: red, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    mast.position.y = 0.045;
    group.add(ring, inner, mast);
    group.visible = false;
    group.renderOrder = 3;
    scene.add(group);
    return {
      group,
      // Stand it on the ground at a site and orient it to the local up, which at these latitudes
      // is far from the scene's own +y.
      placeAt(site) {
        if (!site) { group.visible = false; return; }
        const m = latLonToMap(R, site.lat, site.lon);
        group.position.copy(groundAt(m, 0.004));
        // upAt takes a point in scene space, not the map coordinate: it offsets by the body
        // radius to find the direction away from the centre. Passing the map point gave a
        // meaningless direction and would have planted the mast at a tilt.
        const up = upAt(R, group.position);
        group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
        group.visible = true;
      },
    };
  })();
  await B.run('Allocate soft shadow maps', () => {
    shadows = createShadows(terrain.shared, data.tiles.hero.half_extent_m / 1000, data.tiles.outer.half_extent_m / 1000);
    const u = terrain.uniforms;
    u.uShHero.value = shadows.texHero;
    u.uShIn.value = shadows.texIn;
    u.uShOut.value = shadows.texOut;
    u.uKShHero.value = shadows.keyHero;
    u.uKShIn.value = shadows.keyIn;
    return 'Sun ×3 · key light ×2';
  });
  await B.run('Load star catalogue and bodies', () => {
    sky = createSky(data);
    sky.attachHaze(terrain.uniforms);
    scene.add(sky.group);
    bodies = createBodies(data);
    scene.add(bodies.earth, bodies.sun);
    post = createPost(renderer, scene, camera);
    post.resize(window.innerWidth, window.innerHeight, PR);
    return `Hipparcos ${data.starCount} stars`;
  });
  await B.run('Candidate sites: horizon profiles and lighting', () => {
    sites = createSites(data, eph);
    crater = measureCrater(heightAt, latLonToMap(R, -89.625, 118.5));
    hud.buildSites(sites.sites);
    hud.bind('crater-data', `${(crater.radius * 2).toFixed(1)} km across · ${crater.depth.toFixed(1)} km deep · floor in permanent shadow`);
    return `${sites.sites.length} sites · ${data.sites.azimuth_step_deg}° azimuth step`;
  });

  // ---- Per-frame scene sync ----
  const KEY_EL = THREE.MathUtils.degToRad(16);          // cinematic key light: the Sun's azimuth, lifted to about 16°
  const keyDir = new THREE.Vector3();
  function syncScene(h) {
    eph.update(h);
    keyDir.set(eph.sunDir.x, 0, eph.sunDir.z).normalize().multiplyScalar(Math.cos(KEY_EL));
    keyDir.y = Math.sin(KEY_EL);
    terrain.uniforms.uSunDir.value.copy(eph.sunDir);
    terrain.uniforms.uKeyDir.value.copy(keyDir);
    sky.update(eph.icrsToScene, PR);
    sky.milkyU.uSunDir.value.copy(eph.sunDir);
  }
  function syncCamera() {
    terrain.uniforms.uEarthDir.value.copy(eph.earthPos).sub(camera.position).normalize();
    bodies.update(camera, eph);
  }

  // ---- Camera ----
  let mode = 'home', flight = null;
  // The globe (P1's #select screen) is a second pass on the same canvas with its own scene,
  // camera and render loop. Set by that block below; frame() checks it to actually stop
  // drawing the surface scene while the globe is up, rather than leaving both loops running
  // and hoping one callback always lands after the other -- rAF ordering across two
  // independently-reinstalled callbacks is not a guarantee, and does flip under load.
  let globeShown = false;
  // Whether the surface loop has actually reached the guard in frame() and stopped queueing
  // itself. resumeFrame() needs this: P2 wraps frame() with its own rAF chain that keeps
  // re-queueing while the mission form is up without ever calling through, so "the globe is
  // hidden" is not the same as "no chain is running", and resuming on that assumption starts
  // a second one that then renders the scene twice per frame.
  let surfaceStopped = false;
  // True while the descent from the zone map is driving the surface scene itself, rather than
  // through the shared `frame` binding. See descendTo.
  let ownSurface = false;
  // Set by the P1 block below. Declared up here because the key handler, which runs earlier
  // in this file, has to be able to dismiss that screen.
  let leaveGlobe = () => {};
  // Set by the P1 block when a descent lands on the surface. While set, Back and Escape return
  // to the site map rather than to the home screen, which the mission flow skips.
  let cameFromMap = false;
  let returnToMap = () => {};
  // Set by the analysis block. The key handler runs earlier in this file, so it asks rather
  // than reaching into that block.
  let analysisOpen = () => false;
  let closeAnalysis = () => {};
  const orbitFlag = new URLSearchParams(location.search).has('orbit');   // draw the full relay ellipse
  const mouse = new THREE.Vector2(), look = { yaw: 0, pitch: 0 };
  let driftT0 = performance.now();
  const aspect = () => window.innerWidth / window.innerHeight;
  function homePose(t, asp = aspect()) {
    if (reducedMotion.matches) return rig.home(asp);
    const s = (t - driftT0) / 1000;
    const amp = THREE.MathUtils.smoothstep(s, 0, 4);                 // ease the drift back in on the home screen
    look.yaw += (-mouse.x * 0.6 - look.yaw) * 0.04;
    look.pitch += (mouse.y * 0.35 - look.pitch) * 0.04;
    return rig.home(asp, {
      fwd: amp * 1.6 * Math.sin(s * 0.11),
      side: amp * 2.2 * Math.sin(s * 0.07),
    }, { yaw: amp * look.yaw, pitch: amp * look.pitch });
  }

  await B.run('Compile shaders, compute first-frame lighting', () => {
    rig = createRig({ R, camera, eph, groundAt, heightAt, crater });
    syncScene(nowH());
    camera.aspect = aspect();
    rig.apply(rig.home(camera.aspect));
    syncCamera();
    shadows.render(renderer, eph.sunDir, keyDir, true);
    post.composer.render();
    return '';
  });

  // Relay station: drawn on top after the main scene, before bloom
  await B.run('Relay station: Gateway core + gravity ring', async () => {
    const kit = await createStation(renderer, data.stationUrl);
    station = kit.create(rig.stationPlacement());
    post.composer.insertPass(kit.pass, 1);
    // the relay orbit must be drawn in the main scene: it spans tens of thousands of km, far outside the
    // station pass's camera-relative projection
    relayOrbit = kit.showOrbit(station.place.orbit, R);
    relayOrbit.visible = false;
    scene.add(relayOrbit);
    renderer.compile(kit.scene, camera);
    return `${STATION.length} m · ${STATION.span} m span`;
  });

  // Rover: rim of site A, drawn on top of the main scene in close-up (likewise after clearing depth)
  await B.run('Polar rover: URDF joint tree + near terrain', async () => {
    rover = await createRover(renderer, data.roverUrl, {
      R, terrain, tiles: data.tiles, shadows, eph, anchor: sites.byId('A').map.clone(), crater,
      heightAt, mapToScene, sceneToMap, upAt, latLonToMap,
    });
    post.composer.insertPass(rover.pass, 2);
    rover.sync(camera);
    renderer.compile(rover.scene, rover.camera);
    return `${rover.wheels.length}-wheel independent steering · ${Math.round(rover.mass)} kg`;
  });

  // Relay orbit parameters: the drawn station sits at apolune of a Keplerian ellipse about the Moon
  {
    const st = station.place;
    const o = st.orbit;
    const RM = 1737.4;                                   // moon radius, km
    const a = RM + o.a;                                  // semi-major axis, km
    const T = 2 * Math.PI * Math.sqrt(a ** 3 / GM_MOON);
    const v = Math.sqrt(GM_MOON * (2 / (RM + o.apolune) - 1 / a));
    hud.bind('o-apolune', `${Math.round(o.apolune).toLocaleString()} km`);
    hud.bind('o-perilune', `${Math.round(o.perilune)} km`);
    hud.bind('o-period', `${(T / 3600).toFixed(1)} h`);
    hud.bind('o-inc', `${o.inc.toFixed(1)}°`);
    hud.bind('o-v', `${v.toFixed(3)} km/s`);
    hud.bind('o-ring', `R ${STATION.ringR} m · ${STATION.ringRpm.toFixed(1)} rpm · ${STATION.ringG.toFixed(2)} g`);
    hud.bind('o-dist', `${st.pos.distanceTo(groundAt(crater.center.clone(), 0)).toFixed(0)} km to site`);
  }

  // ---- HUD data ----
  const toScreen = new THREE.Vector3();
  function project(p) {
    toScreen.copy(p).project(camera);
    const w = window.innerWidth, hgt = window.innerHeight;
    const vis = toScreen.z < 1 && Math.abs(toScreen.x) < 1.1 && Math.abs(toScreen.y) < 1.1;
    return { x: (toScreen.x + 1) * 0.5 * w, y: (1 - toScreen.y) * 0.5 * hgt, vis };
  }
  const craterAnchor = groundAt(crater.center.clone(), crater.rimH - heightAt(crater.center));
  const blocked = {};
  // Whether terrain blocks the camera-to-site sightline
  function occluded(eye, target) {
    const p = new THREE.Vector3(), m = new THREE.Vector2();
    for (let i = 1; i < 60; i++) {
      p.lerpVectors(eye, target, i / 60);
      const { h } = sceneToMap(R, p, m);
      if (heightAt(m) > h + 0.03) return true;
    }
    return false;
  }
  function hudFrame() {
    const e = eph.earthPos.clone().sub(camera.position);
    const eDist = e.length();
    const fovR = THREE.MathUtils.degToRad(camera.fov);
    hud.frame({
      earth: project(camera.position.clone().addScaledVector(e.divideScalar(eDist), 1000)),
      earthR: (Math.asin(6371 / eDist) / fovR) * window.innerHeight,
      sun: project(camera.position.clone().addScaledVector(eph.sunDir, 1000)),
      crater: project(craterAnchor),
      sites: sites.sites.map((s) => ({ id: s.id, p: blocked[s.id] ? null : project(s.scene) })),
    });
  }

  // Orbit-view labels: three points on the station + the crater below
  const LINES = { home: 0.4, explore: 0.5, orbit: 1.0, rover: 0 };
  const KEYF = { home: 1, explore: 1, orbit: 1, rover: 0.25 };   // rover close-up: dim the key light so the headlights matter
  // The rover close-up fills the frame with near, lit regolith, so exposure comes down and the white body lifts off the ground
  const EXP = { home: 1, explore: 1, orbit: 1, rover: 0.62 };
  // Bloom goes only to the Sun: in the close-up the white thermal panels facing the Sun exceed the threshold, so the threshold rises with them
  const BLOOM = { home: 1.4, explore: 1.4, orbit: 1.4, rover: 6 };
  const wTmp = new THREE.Vector3();
  // The array label picks whichever of the four wing tips is farthest from the ring and core labels (skipping ones too near the screen edge); it stays put unless clearly better, to avoid flicker
  function hudOrbit() {
    const at = (k) => project(station.localToWorld(station.anchors[k], wTmp));
    const ring = at('ring'), core = at('core');
    const e = eph.earthPos.clone().sub(camera.position), eDist = e.length();
    const pxPerRad = window.innerHeight / THREE.MathUtils.degToRad(camera.fov);
    const avoid = [
      { p: project(camera.position.clone().addScaledVector(e.divideScalar(eDist), 1000)), r: Math.asin(6371 / eDist) * pxPerRad + 14 },
      { p: project(camera.position.clone().addScaledVector(eph.sunDir, 1000)), r: 60 },
    ];
    hud.frameOrbit({ core, ring, array: at('array'), engine: at('engine'), crater: project(craterAnchor), avoid });
  }

  // Ground track: in the south polar stereographic projection a polar orbit is a straight line through the pole along the subsatellite meridian
  const TRACK = { home: 0, explore: 0, orbit: 1, rover: 0 };
  // Zone tint on the drawn terrain. The shader has carried this since the zone map was built
  // (see uZoneA in glsl/terrain.js) but nothing ever supplied the texture, so the surface was
  // always bare grey while the globe screen was coloured from the same data.
  const ZONEA = { home: 0.28, explore: 0.42, orbit: 0.34, rover: 0 };
  // ...and faded by how much of the classification the view can actually resolve. A zone cell is
  // 480 m. Standing close, three cells span the frame and a tint is a flat wash over ground the
  // screen exists to show, while the legend beside it still promises four classes -- accurate
  // data, useless picture. So the tint earns its strength only once enough cells are in frame to
  // read as a classification: nothing below CELLS_OFF across, full value above CELLS_FULL. This
  // is why the rover close-up needed no special case; it is simply always below the floor.
  const CELLS_OFF = 8, CELLS_FULL = 26;
  const zoneFade = () => {
    const d = camera.position.distanceTo(controls.target);
    const across = (2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / (data.zonesMeta.cell_m / 1000);
    return THREE.MathUtils.smoothstep(across, CELLS_OFF, CELLS_FULL);
  };
  {
    const nad = sceneToMap(R, station.place.pos).m.clone();
    terrain.uniforms.uNadir.value.copy(nad);
    terrain.uniforms.uTrackDir.value.copy(nad).normalize();
  }
  // Sun and Earth from the station: elevation minus the horizon dip at 30 km altitude; above 0 means not occulted by the Moon
  function refreshOrbit() {
    const st = station.place;
    const dip = Math.acos(R / (R + sceneToMap(R, st.pos).h));
    const sunEl = Math.asin(THREE.MathUtils.clamp(eph.sunDir.dot(st.up), -1, 1));
    const e = eph.earthPos.clone().sub(st.pos).normalize();
    const earthEl = Math.asin(THREE.MathUtils.clamp(e.dot(st.up), -1, 1));
    const deg = THREE.MathUtils.radToDeg;
    hud.setOrbit({ sunEl: deg(sunEl), sunLit: sunEl > -dip, earthEl: deg(earthEl), earthVis: earthEl > -dip });
  }

  const siteA = sites.byId('A');
  let lastLit = null, next = { h: null, span: null };
  function refreshLive(h) {
    const v = sites.look(siteA, h);
    if (v.sun.lit !== lastLit || (next.h != null && h > next.h)) {
      lastLit = v.sun.lit;
      const a = sites.nextChange(siteA, h, 'sun');
      const b = a == null ? null : sites.nextChange(siteA, a + 1e-3, 'sun');
      next = { h: a, span: a != null && b != null ? b - a : null };
    }
    hud.set({ sun: v.sun, earth: v.earth, next });
  }

  // Set by the P1 block when a site is committed on the map; read here so the default-entry
  // path can tell whether a real choice has already been made.
  let chosenSiteRef = () => null;
  // Where the surface view stands. The committed site if there is one, otherwise Site A, which is
  // where rig.landing() puts the camera when it is given no position. The camera, the readout,
  // the rover and the button label all read this one answer; they used to decide separately, so
  // after committing to one site the Descend button flew to A while the panels described B.
  const surfaceTarget = () => chosenSiteRef()?.site || sites.byId('A');
  let roverAtId = 'A';
  const placeRover = (site, force) => {
    // The ground mark follows the same call as the rover so the two can never disagree about
    // where the landing point is; it is cheap, so it is set every time rather than only on a move.
    siteMark.placeAt(sites.byId(site.id) || site);
    if (!force && roverAtId === site.id) return;   // already parked there: keep its odometer and tracks
    rover.moveTo(sites.byId(site.id) || site);
    roverAtId = site.id;
  };
  const syncDescend = () => hud.bind('desc-label', `Descend to Site ${surfaceTarget()?.id ?? 'A'}`);
  // The same evaluation the map's list rows carry, so a default entry shows a verdict computed
  // the same way rather than a second opinion.
  const defaultEntryFor = (site) => rankSites([site], zones, null, {})[0];

  // Historical landing failures, asked as questions rather than answered as verdicts. The rules
  // and their sources live in src/advisors.js; this only renders them. Every case there reports
  // pass: null, because the published cause (an altitude estimator rejecting readings, a
  // touchdown sensor tripping on leg deployment, a helium valve losing its seal) cannot be
  // tested against ground measurements -- and saying so is the honest result, not a gap. A row
  // claiming PASS from site data would be the invented-threshold problem in a new costume.
  function renderAdvisors(site, entry) {
    const panel = document.getElementById('ex-advisors');
    const list = document.getElementById('ex-adv-list');
    if (!panel || !list) return;
    let rows = [];
    try {
      rows = reviewSite(site, entry || {}) || [];
    } catch (err) {
      // A failure here must not take the surface readout down with it.
      console.warn('advisor review failed', err);
      rows = [];
    }
    panel.hidden = rows.length === 0;
    if (!rows.length) return;
    list.replaceChildren();
    for (const r of rows) {
      const row = document.createElement('div');
      // No pass/fail colour where there is no verdict: the marker states what it is.
      row.className = 'adv' + (r.pass === false ? ' no' : r.pass === true ? '' : ' open');
      const mark = document.createElement('i');
      mark.textContent = r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : 'ASKS';
      const head = document.createElement('b');
      head.textContent = `${r.mission} (${r.year})`;
      // The question is what the advisor is for, so it gets the line. The scope and the
      // disclaimers that follow it in `note` are real and have to stay, but as a second,
      // quieter line: joined into one paragraph they buried the question they exist to qualify.
      const parts = String(r.note || r.failure || '').split(/(?<=[.?])\s+/).filter(Boolean);
      const ask = document.createElement('span');
      ask.className = 'adv-ask';
      ask.textContent = parts[0] || '';
      row.append(mark, head, ask);
      if (parts.length > 1) {
        const fine = document.createElement('span');
        fine.className = 'adv-fine';
        fine.textContent = parts.slice(1).join(' ');
        row.append(fine);
      }
      if (r.source) {
        const a = document.createElement('a');
        a.href = r.source;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'investigation report';
        a.className = 'adv-src';
        row.append(a);
      }
      list.append(row);
    }
  }

  // ---- Surface site readout: whatever site the camera is standing at ----
  // Set when a site is committed on the zone map (descendTo), refreshed on the 400 ms timer while
  // the free camera is up. Every figure is a measurement: the live sun/Earth state is the same
  // horizon-profile test the home screen runs for Shackleton, the percentages and the longest
  // night/blackout are the site's own full-resolution figures, and the fault distance is the
  // nearest mapped scarp. Nothing is shown for a field the data does not carry.
  const surfaceHud = (() => {
    let cur = null, next = { h: null }, lastLit = null;
    const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : '—');
    const hrs = (v) => (Number.isFinite(v) ? `${v} h · ${(v / 24).toFixed(1)} d` : 'no data');
    const span = (h) => (h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} h`);
    // Nearest mapped scarp, by the same planar south-polar projection the scarp file is in. Data
    // sites carry a precomputed fault_km; the published regions do not, so it is measured here.
    function faultKm(site) {
      if (Number.isFinite(site.fault_km)) return { km: site.fault_km, id: null };
      const sc = data.quakes?.scarps || [];
      const p = latLonToMap(R, site.lat, site.lon);
      let best = null;
      for (const f of sc) {
        const a = latLonToMap(R, f.start[0], f.start[1]), b = latLonToMap(R, f.end[0], f.end[1]);
        const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
        const t = L ? THREE.MathUtils.clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / L, 0, 1) : 0;
        const d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
        if (!best || d < best.km) best = { km: d, id: f.id };
      }
      return best;
    }
    function set(sel) {
      const s = sites.byId(sel.site.id) || sel.site;
      cur = s; lastLit = null; next = { h: null };
      const st = sel.entry?.stats || s.stats || {}, g = sel.entry?.ground;
      const src = s.source === 'nasa' ? 'NASA ARTEMIS CANDIDATE REGION' : s.source === 'surveyed' ? 'SURVEYED · BELOW THE BAR' : 'DATA-SELECTED · OUR GRID SCAN';
      hud.bind('ex-name', s.en.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()));
      hud.bind('ex-sub', `LANDING SITE ${s.id}`);
      hud.bind('ex-id', `${s.id} · ${s.source === 'nasa' ? 'NASA' : 'DATA'}`);
      hud.bind('ex-ll', `${Math.abs(s.lat).toFixed(3)}° S · ${(((s.lon % 360) + 360) % 360).toFixed(2)}° E`);
      hud.bind('ex-elev', Number.isFinite(s.elev_m) ? `${Math.round(s.elev_m).toLocaleString('en-US')} m` : '—');
      hud.bind('ex-ground', g ? g.zone.toUpperCase() : 'unmapped');
      hud.bind('ex-slope', g && Number.isFinite(g.slopeDeg) ? `${g.slopeDeg.toFixed(1)}°` : (Number.isFinite(s.slope_deg) ? `${s.slope_deg.toFixed(1)}°` : '—'));
      // Two different aggregations, named separately. The visibility percentages are means over
      // the period; the longest night and longest blackout are the worst continuous run in it.
      // They were both labelled "annual means", which made the endurance figures read as typical
      // when they are the worst case the mission has to survive -- and for a site whose dark
      // spell crosses a year boundary the whole-period run is longer than any single year's,
      // so the two cannot share a label even in principle.
      hud.bind('ex-src', `${src}. Percentages are means over ${sel.year ? sel.year : `${eph.startYear}–${eph.endYear}`}; `
        + `longest night and blackout are the worst continuous run in ${eph.startYear}–${eph.endYear}. LOLA horizon × DE421.`);
      hud.pill('ex-verdict', !!sel.entry?.meetsAll, sel.entry ? (sel.entry.meetsAll ? 'MEETS' : 'FAILS') : '—');
      hud.bind('ex-sunpct', pct(st.sun_visible_pct));
      hud.bind('ex-earthpct', pct(st.earth_visible_pct));
      hud.bind('ex-both', pct(st.both_pct));
      // Endurance figures are the whole-period worst case, the same figure the pool is screened on
      const whole = s.stats || st;
      hud.bind('ex-dark', `${hrs(whole.longest_dark_h)} worst`);
      hud.bind('ex-blind', `${hrs(whole.longest_blind_h)} worst`);
      hud.bind('ex-ice', g && Number.isFinite(g.iceDistKm) ? (g.iceLikely ? 'on site' : `${g.iceDistKm.toFixed(1)} km`) : '—');
      const f = faultKm(s);
      hud.bind('ex-fault', f ? `${f.km.toFixed(1)} km${f.id ? ` · scarp ${f.id}` : ''}` : 'no catalogue data');
      // How high anything has to stand to clear this site's own terrain, and how much of the
      // compass is already clear at the local horizontal. Read straight off the measured horizon
      // profile, so no orbit, no spacecraft and no time axis enter it -- which is exactly why it
      // can be shown at all. A relay coverage percentage would depend on the orbital plane's
      // orientation, and this project never defines that (see README on the assumed orbit), so
      // any such figure would be a choice of unstated parameters dressed as a measurement.
      const prof = s.horizon_cdeg ? s.horizon_cdeg.map((v) => v / 100) : null;
      if (prof && prof.length) {
        const worst = Math.max(...prof);
        const openAt = (mask) => (prof.filter((v) => v < mask).length / prof.length) * 100;
        hud.bind('ex-clear', worst >= 0
          ? `${worst >= 0 ? '+' : ''}${worst.toFixed(2)}° at worst azimuth`
          : 'below horizontal all round');
        hud.bind('ex-open', `${openAt(0).toFixed(1)}% at 0° · ${openAt(2).toFixed(0)}% at 2°`);
        hud.bind('ex-clear-src',
          'Terrain only, from the LOLA horizon profile at 0.5° steps, 2 m antenna height. '
          + 'No relay orbit is modelled, so this is not a coverage or availability figure: it is '
          + 'how much sky this ground leaves open, not how often anything is in it.');
      } else {
        hud.bind('ex-clear', 'no profile');
        hud.bind('ex-open', '—');
        hud.bind('ex-clear-src', 'No horizon profile for this point.');
      }
      renderAdvisors(s, sel.entry);
      refresh(nowH());
    }
    function refresh(h) {
      if (!cur || !cur.hor) return;
      const v = sites.look(cur, h);
      const sign = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}°`;
      hud.bind('ex-sun', sign(v.sun.el));
      hud.pill('exsun', v.sun.lit, v.sun.lit ? 'SUNLIT' : 'DARK');
      hud.bind('ex-earth', sign(v.earth.el));
      hud.pill('exearth', v.earth.visible, v.earth.visible ? 'LINK' : 'BLOCKED');
      if (v.sun.lit !== lastLit || (next.h != null && h > next.h)) {
        lastLit = v.sun.lit;
        next = { h: sites.nextChange(cur, h, 'sun') };
      }
      hud.bind('ex-next', next.h == null ? 'none within 250 days'
        : `${v.sun.lit ? 'sunset' : 'sunrise'} in ${span(next.h - h)}`);
    }
    return { set, refresh, get site() { return cur; } };
  })();

  // ---- Mode switching: home ⇄ explore, home ⇄ orbit, orbit → explore (landing) ----
  // The two free-look views use different OrbitControls limits: crater rim in kilometres, relay station in hundreds of metres
  const CTRL = {
    explore: { minDistance: 2, maxDistance: 220, minPolarAngle: 0, maxPolarAngle: THREE.MathUtils.degToRad(88), autoRotate: false },
    orbit: { minDistance: 0.06, maxDistance: 1.2, minPolarAngle: THREE.MathUtils.degToRad(15), maxPolarAngle: THREE.MathUtils.degToRad(150), autoRotate: true, autoRotateSpeed: 0.25 },
  };
  let from = 'home', to = 'home';
  const landingPose = () => {
    const t = surfaceTarget();
    if (!t || t.id === 'A') return rig.landing(aspect());   // Site A keeps its crater-rim framing
    return rig.landing(aspect(), latLonToMap(R, t.lat, t.lon));
  };
  const poseOf = (m) => (m === 'explore' ? landingPose() : m === 'orbit' ? rig.orbit(aspect(), station.place) : rig.home(aspect()));
  function go(target) {
    if (mode === 'fly' || mode === target || mode === 'rover') return;
    // Whoever called this is taking the screen, so the descent's own loop steps aside and the
    // shared binding drives again from here.
    if (ownSurface) { ownSurface = false; surfaceStopped = true; resumeFrame(); }
    if (mode === 'explore' && target === 'orbit') return;
    const a = { pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov };
    const b = poseOf(target);
    from = mode;
    to = target;
    const done = () => {
      flight = null;
      mode = target;
      if (target === 'home') {
        driftT0 = performance.now();
        look.yaw = look.pitch = 0;
        hud.showHome();
        hud.focusEnter();
        return;
      }
      Object.assign(controls, CTRL[target]);
      controls.target.copy(b.target);
      controls.enabled = true;
      controls.update();
      if (target === 'explore') hud.showExplore(); else hud.showOrbit();
    };
    controls.enabled = false;
    controls.autoRotate = false;
    ({ home: hud.hideHome, explore: hud.hideExplore, orbit: hud.hideOrbit })[from]();
    mode = 'fly';
    if (reducedMotion.matches) {
      // no flight: cut through black
      hud.veil(true);
      setTimeout(() => { rig.apply(b); done(); hud.veil(false); }, 260);
      return;
    }
    // Orbit down to the rim: altitude follows horizontal progress (slow, then fast), rather than dropping to the floor and skimming the ground
    const hEase = from === 'orbit' && target === 'explore' ? (s) => s * s : undefined;
    const dur = { explore: from === 'orbit' ? 7000 : 4200, orbit: 6000, home: from === 'orbit' ? 5200 : 3600 }[target];
    flight = { path: rig.flight(a, b, hEase), t0: performance.now(), dur, done };
  }

  // ---- Rover: keyboard / joystick input, HUD ----
  const keys = new Set(), joy = { x: 0, y: 0 };
  let pipRect = null, hover = null, sel = null;
  const ptr = { x: 0, y: 0 };
  function roverInput() {
    const k = (...c) => c.some((x) => keys.has(x));
    let thr = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0);
    let str = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
    const crab = (k('KeyQ') ? 1 : 0) - (k('KeyE') ? 1 : 0);
    if (Math.abs(joy.x) + Math.abs(joy.y) > 0.08) { thr = -joy.y; str = -joy.x; }
    return { thr, str, crab, brake: k('Space') };
  }
  const deg = THREE.MathUtils.radToDeg;
  function hudRover() {
    const st = rover.state;
    if (nFr++ % 6 === 0) {
      const b = (90 - deg(st.hdg)) % 360;
      hud.setRover({
        v: st.v, bearing: (b + 360) % 360, slope: st.slope, pitch: st.pitch, mode: rover.MODE_EN[st.mode],
        odo: st.odo, dist: Math.hypot(st.x, st.y), sunEl: deg(Math.asin(THREE.MathUtils.clamp(st.sunUp, -1, 1))),
        lit: st.lit, power: st.power, warn: st.warn, rockBlocked: st.rockBlocked, hlOn: st.hlOn, jumped,
        pan: deg(rover.mast.pan), tilt: deg(rover.mast.tilt), range: st.range,
      });
    }
    hud.roverCard(sel && rover.info(sel), sel && rover.screen(sel, window.innerWidth, window.innerHeight));
    hud.roverChip(hover && hover !== sel ? rover.label(hover) : null, ptr.x, ptr.y);
  }
  let nFr = 0;

  // ---- Rover close-up: explore ⇄ rover. Distance interpolates logarithmically (a few km pushed in to a few m, so speed feels even), the view settling on the rover at the end ----
  const RV = { az: 150, dist: 7.5, el: 13 };
  CTRL.rover = { minDistance: 0.0025, maxDistance: 0.03, minPolarAngle: THREE.MathUtils.degToRad(20), maxPolarAngle: THREE.MathUtils.degToRad(86), autoRotate: false, enablePan: false };
  CTRL.explore.enablePan = true;
  CTRL.orbit.enablePan = true;
  const chase = { rel: null, idle: 0, free: false };
  let jumped = false;
  // a, b: { pos, quat?, fov }, T: rover (km). inward: push in from a distance, turning toward the rover early in the view; otherwise pull back from the rover, turning to b.quat at the end
  function approach(a, b, T, inward) {
    const da = a.pos.distanceTo(T), db = b.pos.distanceTo(T);
    const ua = a.pos.clone().sub(T).normalize(), ub = b.pos.clone().sub(T).normalize();
    const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
    const lookAt = (p) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(p, T, new THREE.Vector3(0, 1, 0)));
    return (t) => {
      const u = ease(THREE.MathUtils.clamp(t, 0, 1));
      const d = Math.exp(THREE.MathUtils.lerp(Math.log(da), Math.log(db), u));
      const dir = ua.clone().lerp(ub, THREE.MathUtils.smoothstep(u, inward ? 0.2 : 0, inward ? 1 : 0.8)).normalize();
      const pos = T.clone().addScaledVector(dir, d);
      const quat = inward
        ? a.quat.clone().slerp(lookAt(pos), THREE.MathUtils.smoothstep(u, 0, 0.55))
        : a.quat.clone().slerp(lookAt(pos), THREE.MathUtils.smoothstep(u, 0, 0.3)).slerp(b.quat, THREE.MathUtils.smoothstep(u, 0.45, 1));
      return { pos, quat, fov: THREE.MathUtils.lerp(a.fov, b.fov, u) };
    };
  }
  function roverPose() {
    const v = rover.view(RV.az, RV.dist, RV.el);
    return { pos: v.pos, target: v.target, fov: rig.homeFov(aspect()) };
  }
  function enterRover() {
    if (mode !== 'explore') return;
    const a = { pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov };
    rover.setActive(true);
    rover.sync(camera);
    const b = roverPose();
    from = 'explore'; to = 'rover';
    controls.enabled = false;
    hud.hideExplore();
    mode = 'fly';
    const done = () => {
      flight = null;
      mode = 'rover';
      Object.assign(controls, CTRL.rover);
      controls.target.copy(b.target);
      controls.enabled = true;
      controls.update();
      chase.rel = null;
      hud.showRover();
    };
    if (reducedMotion.matches) { hud.veil(true); setTimeout(() => { rig.apply({ ...b, quat: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(b.pos, b.target, new THREE.Vector3(0, 1, 0))) }); done(); hud.veil(false); }, 260); return; }
    flight = { path: approach(a, b, b.target, true), t0: performance.now(), dur: 5200, done };
  }
  function leaveRover() {
    if (mode !== 'rover') return;
    const a = { pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov };
    const b = rig.landing(aspect());
    from = 'rover'; to = 'explore';
    controls.enabled = false;
    rover.setInput({ thr: 0, str: 0, crab: 0, brake: true });
    keys.clear();
    hud.hideRover();
    hud.navcam(false);
    mode = 'fly';
    const done = () => {
      flight = null;
      mode = 'explore';
      rover.setActive(false);
      Object.assign(controls, CTRL.explore);
      controls.target.copy(b.target);
      controls.enabled = true;
      controls.update();
      hud.showExplore();
    };
    if (reducedMotion.matches) { hud.veil(true); setTimeout(() => { rig.apply(b); done(); hud.veil(false); }, 260); return; }
    // and back: pull away first, then turn to the explore pose
    flight = { path: approach(a, b, rover.target(), false), t0: performance.now(), dur: 4600, done };
  }
  // Camera follows the rover: camera and target pan together with the rover; while the user is not dragging, the camera keeps its bearing relative to the rover nose
  const rvT = new THREE.Vector3(), rvPrev = new THREE.Vector3();
  controls.addEventListener('start', () => { chase.idle = -1; });
  controls.addEventListener('end', () => { chase.idle = 0; chase.rel = null; });
  function followRover(dt) {
    rover.target(rvT);
    camera.position.add(rvPrev.copy(rvT).sub(controls.target));
    controls.target.copy(rvT);
    if (chase.free || chase.idle < 0) return;
    chase.idle += dt;
    const up = rover.up(), f = rover.headingDir();
    const off = camera.position.clone().sub(rvT), hOff = off.clone().addScaledVector(up, -off.dot(up));
    const ang = Math.atan2(new THREE.Vector3().crossVectors(f, hOff).dot(up), f.dot(hOff));
    if (chase.rel == null) { if (chase.idle > 0.6) chase.rel = ang; return; }
    let d = chase.rel - ang;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    off.applyAxisAngle(up, d * Math.min(1, dt * 2.5));
    camera.position.copy(rvT).add(off);
  }

  // One frame of the surface scene, without queueing the next one. Split out from frame() so a
  // camera flight can drive the scene itself. P2 replaces the `frame` binding with a wrapper
  // that only calls through when it considers the surface dirty, and pauses outright while its
  // own stages are up, so a flight that relied on that binding would render its first frame and
  // then sit still -- which is what the descent from the zone map did.
  function surfaceStep(t) {
    const h = nowH(t);
    syncScene(h);
    // Hold the landing mark at a roughly constant size on screen. At its true size (a ring 50 m
    // across) it is about two pixels from the 17 km the camera sits at on arrival, which is why
    // it was in the scene and in frame and still could not be seen. The scale follows distance,
    // and never drops below 1 so up close it is its real size and sits under the rover.
    if (siteMark.group.visible) {
      const d = camera.position.distanceTo(siteMark.group.position);
      const k = Math.max(1, d * 0.5);
      siteMark.group.scale.setScalar(k);
    }
    const asp = aspect();
    if (Math.abs(camera.aspect - asp) > 1e-6) { camera.aspect = asp; camera.updateProjectionMatrix(); }
    let u = 1;
    const dt = Math.min((t - (surfaceStep.last || t)) / 1000, 0.1);
    surfaceStep.last = t;
    if (mode === 'home') {
      rig.apply(homePose(t));
    } else if (mode === 'fly' && flight) {
      u = Math.min(1, (t - flight.t0) / flight.dur);
      rig.apply(flight.path(u));
    } else if (mode === 'explore' || mode === 'orbit') {
      controls.update();
    } else if (mode === 'rover') {
      rover.setInput(roverInput());
      rover.step(dt);
      followRover(dt);
      controls.update();
      rover.clampCam(camera);
      camera.updateMatrixWorld();
    }
    syncCamera();
    // Contours / graticule: strongest in orbit, dimmed on the surface home view; blended between the two ends during a flight
    const s = mode === 'fly' ? THREE.MathUtils.smoothstep(u, 0, 1) : 1;
    terrain.uniforms.uLines.value = THREE.MathUtils.lerp(LINES[mode === 'fly' ? from : mode], LINES[mode === 'fly' ? to : mode], s);
    const stVis = mode === 'orbit' || (mode === 'fly' && (from === 'orbit' || to === 'orbit'));
    station.update(camera, eph, t, stVis);
    // the relay orbit is a few tens of thousands of km across; from the station view only a fragment falls in
    // frame, so it is off by default and can be switched on with the ?orbit URL flag
    if (relayOrbit) relayOrbit.visible = stVis && orbitFlag;
    terrain.uniforms.uTrack.value = THREE.MathUtils.lerp(TRACK[mode === 'fly' ? from : mode], TRACK[mode === 'fly' ? to : mode], s);
    terrain.uniforms.uZoneA.value = THREE.MathUtils.lerp(ZONEA[mode === 'fly' ? from : mode], ZONEA[mode === 'fly' ? to : mode], s) * zoneFade();
    terrain.uniforms.uKeyFloor.value = THREE.MathUtils.lerp(KEYF[mode === 'fly' ? from : mode], KEYF[mode === 'fly' ? to : mode], s);
    post.grade.uniforms.uExposure.value = THREE.MathUtils.lerp(EXP[mode === 'fly' ? from : mode], EXP[mode === 'fly' ? to : mode], s);
    post.bloom.threshold = THREE.MathUtils.lerp(BLOOM[mode === 'fly' ? from : mode], BLOOM[mode === 'fly' ? to : mode], s);
    if (mode !== 'fly') shadows.render(renderer, eph.sunDir, keyDir);   // skip during flights to avoid stutter
    const rvOn = mode === 'rover' || (mode === 'fly' && (from === 'rover' || to === 'rover'));
    if (rvOn) rover.sync(camera, t);
    post.grade.uniforms.uTime.value = t * 0.001;
    post.composer.render();
    if (mode === 'rover' && hud.navcam()) rover.renderPip(camera, scene, pipRect || (pipRect = hud.navcamRect()), t);

    hud.tick(h, eph.hoursToDate(h));
    if (mode === 'home' || (mode === 'fly' && (from === 'home' || to === 'home'))) hudFrame();
    else if (mode === 'orbit') hudOrbit();
    else if (mode === 'rover') hudRover(t);
    if (mode === 'fly' && flight && u >= 1) flight.done();
  }

  // Frame budget. A surface frame draws three shadow maps, the terrain and a bloom chain, and on
  // a 120 Hz display the loop was running all of it twice as often as a 60 Hz one for no visual
  // gain -- the Sun moves half a degree an hour, so nothing on screen changes between two
  // consecutive frames at that rate. Capping the work keeps the GPU out of its fan curve, which
  // is what made the view feel worse the longer it was open.
  function frame(t) {
    if (globeShown) { surfaceStopped = true; return; }   // stopped, not skipped: no further rAF is queued until resumeFrame()
    surfaceStopped = false;
    // Always re-arm first: skipping a draw must never drop the chain.
    requestAnimationFrame(frame);
    // The budget state lives on the function, like surfaceStep.last, so this stays self-contained.
    const budget = 1000 / 60 - 1;
    // A flight is the one case worth every frame the display offers: the camera is moving fast
    // enough for the difference to show. Otherwise 60 Hz is the cap -- the Sun moves half a
    // degree an hour, so two consecutive frames on a 120 Hz display are the same picture drawn
    // twice, with three shadow maps and a bloom chain behind each one.
    if (mode !== 'fly' && t - (frame.lastDrawn || 0) < budget) return;
    frame.lastDrawn = t;
    surfaceStep(t);
  }

  // Low-frequency tasks: site state, site occlusion
  setInterval(() => {
    refreshLive(nowH());
    if (mode === 'orbit') refreshOrbit();
    if (mode === 'explore') {
      surfaceHud.refresh(nowH());
      // Say which of the two states the picture is in, rather than leaving a legend of four
      // classes beside ground that is showing none of them.
      const lit = zoneFade() > 0.05;
      hud.bind('ex-zone-note', lit
        ? `LOLA slope with Diviner temperature, ${data.zonesMeta.cell_m} m cells: area characteristics, not a per-metre map.`
        : `Tint off at this range: one ${data.zonesMeta.cell_m} m cell is wider than the view, so a colour here would cover the terrain rather than classify it. Zoom out to bring the classes back.`);
    }
    if (mode === 'home') for (const s of sites.sites) blocked[s.id] = occluded(camera.position, s.scene);
  }, 400);

  // ---- Interaction ----
  // Back out of the surface the way the user came in. Arriving by descending from the site map
  // makes going "home" a dead end -- the mission flow skips that screen entirely, so it would
  // leave them on a screen with nothing to click that continues the mission.
  const backFromSurface = () => { if (cameFromMap) returnToMap(); else go('home'); };
  // Entering the surface outside the map flow (Enter Navigation, Descend to Site A) still lands
  // at Shackleton Rim, because that is where rig.landing() puts the camera with no site given.
  // Without this the readout sat on placeholder dashes and the header named a site the view was
  // not at: the panels describe wherever the camera actually stands, so they are filled for the
  // default landing site too, not only for a site committed on the map.
  const enterSurface = () => {
    const t = surfaceTarget();
    if (t) {
      // A committed site already filled the panels in descendTo; the default needs filling here.
      if (!chosenSiteRef()) surfaceHud.set({ site: t, entry: defaultEntryFor(t), year: null, needs: {} });
      placeRover(t);
    }
    go('explore');
  };
  hud.onEnter(enterSurface);
  hud.onBack(backFromSurface);
  hud.onOrbit(() => { refreshOrbit(); go('orbit'); });
  hud.onOrbitBack(() => go('home'));
  hud.onDescend(enterSurface);
  syncDescend();
  hud.onRover(() => enterRover());
  hud.onRoverBack(() => leaveRover());
  hud.onLights(() => rover.toggleLights());
  hud.onDriveThrough(() => rover.driveThrough());
  const toggleNav = () => { hud.navcam(!hud.navcam()); pipRect = null; };
  hud.onNavcam(toggleNav);
  hud.onCardClose(() => { sel = null; hud.closeCard(); });
  // Jump to the lowest Sun of the rover's next night (to see the headlights); press again to go back to the previous time
  hud.onTime(() => {
    if (jumped) { setTime(HOME_EPOCH_H, 1); jumped = false; return; }
    const A = sites.byId('A'), h0 = nowH();
    const set = sites.look(A, h0).sun.lit ? sites.nextChange(A, h0, 'sun') : h0;
    if (set == null) return;
    const rise = sites.nextChange(A, set + 1e-3, 'sun') ?? set + 12;
    let best = set, low = Infinity;
    for (let i = 1; i < 24; i++) {
      const h = set + ((rise - set) * i) / 24, s = sites.look(A, h).sun;
      if (s.el - s.hor < low) { low = s.el - s.hor; best = h; }
    }
    setTime(best, 1);
    jumped = true;
  });
  const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
  window.addEventListener('keydown', (e) => {
    const onBtn = e.target instanceof HTMLButtonElement;
    if (mode === 'rover') {
      if (e.key === 'Escape') { if (sel) { sel = null; hud.closeCard(); } else leaveRover(); return; }
      if (DRIVE_KEYS.has(e.code) && !(onBtn && e.code === 'Space')) { keys.add(e.code); e.preventDefault(); return; }
      if (e.repeat) return;
      if (e.code === 'KeyL') rover.toggleLights();
      else if (e.code === 'KeyN') toggleNav();
      else if (e.code === 'KeyC') chase.free = !chase.free;
      return;
    }
    // The globe owns the frame while it is up, so it takes Escape before the surface modes
    // get a look at it -- otherwise Escape there would fly a camera nobody can see.
    // The trial sits on top of the zone map, so it takes Escape before the map does -- otherwise
    // Escape would leave the map with the trial still drawn over it.
    if (e.key === 'Escape' && worldsIsOpen && worldsIsOpen()) { worldsClose(); hud.showScreen('select'); return; }
    if (e.key === 'Escape' && globeShown) { leaveGlobe(); return; }
    // #analysis sits on top of the surface view, so without its own branch Escape falls into
    // the explore one, which hides the explore screen and returns to the map -- leaving the
    // analysis panel and the map both revealed. It closes the same way its Back button does.
    if (e.key === 'Escape' && analysisOpen()) { closeAnalysis(); return; }
    if (e.key === 'Escape' && mode === 'explore') backFromSurface();
    else if (e.key === 'Escape' && mode === 'orbit') go('home');
    else if (e.key === 'Enter' && mode === 'home' && !onBtn) go('explore');
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  // Part picking: counts as a click only if press and release are close (a drag rotates the camera)
  const ndc = new THREE.Vector2(), down = { x: 0, y: 0 };
  const pickAt = (x, y) => rover.pick(ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1));
  canvas.addEventListener('pointerdown', (e) => { down.x = e.clientX; down.y = e.clientY; });
  canvas.addEventListener('pointerup', (e) => {
    if (mode !== 'rover' || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    const p = pickAt(e.clientX, e.clientY);
    if (!p || (sel && sel.link === p.link)) { sel = null; hud.closeCard(); return; }
    sel = p;
    hud.closeCard();
    rover.react(p);
    if (p.group === 'mast' && !hud.navcam()) toggleNav();
  });
  canvas.addEventListener('pointermove', (e) => {
    ptr.x = e.clientX; ptr.y = e.clientY;
    if (mode !== 'rover' || e.buttons) { if (hover) { hover = null; canvas.style.cursor = ''; } return; }
    hover = pickAt(e.clientX, e.clientY);
    canvas.style.cursor = hover ? 'pointer' : '';
  });
  canvas.addEventListener('pointerleave', () => { hover = null; });
  // Drag the navcam image: turn the mast by hand
  {
    const el = hud.navcamEl;
    let last = null;
    el.addEventListener('pointerdown', (e) => { last = [e.clientX, e.clientY]; el.setPointerCapture(e.pointerId); e.stopPropagation(); });
    el.addEventListener('pointermove', (e) => {
      if (!last) return;
      const k = THREE.MathUtils.degToRad(42) / el.clientHeight;
      rover.dragMast((e.clientX - last[0]) * k, -(e.clientY - last[1]) * k);
      last = [e.clientX, e.clientY];
    });
    el.addEventListener('pointerup', () => { last = null; });
  }
  // Touch joystick
  {
    const el = hud.joy, knob = el.firstElementChild;
    let id = null;
    const move = (e) => {
      const r = el.getBoundingClientRect(), R0 = r.width / 2;
      let x = (e.clientX - r.left - R0) / R0, y = (e.clientY - r.top - R0) / R0;
      const l = Math.hypot(x, y);
      if (l > 1) { x /= l; y /= l; }
      joy.x = x; joy.y = y;
      knob.style.transform = `translate(${x * R0 * 0.6}px, ${y * R0 * 0.6}px)`;
    };
    el.addEventListener('pointerdown', (e) => { id = e.pointerId; el.setPointerCapture(id); move(e); });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
    const end = () => { id = null; joy.x = joy.y = 0; knob.style.transform = ''; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  window.addEventListener('pointermove', (e) => {
    mouse.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  });
  window.addEventListener('resize', () => {
    PR = pixelRatio();
    renderer.setPixelRatio(PR);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    post.resize(window.innerWidth, window.innerHeight, PR);
    camera.aspect = aspect();
    camera.fov = rig.homeFov(camera.aspect);
    camera.updateProjectionMatrix();
    pipRect = null;
  });

  // ---- Boot complete ----
  for (const s of sites.sites) blocked[s.id] = occluded(camera.position, s.scene);
  clock.t0 = performance.now();
  refreshLive(nowH());
  // P0, landing zones. Built before the first frame because the terrain shader tints the ground
  // from this texture: starting the loop first would sample an unset sampler for a few frames.
  // P1 and P3 both read it -- P1 colours the surface and shows zones.at() on hover, P3 scores a
  // site with the same values. A cell is 480 m, so these are area characteristics; precise
  // per-site figures stay in sites.json.
  const zones = createZones(data.zones, data.zonesMeta);
  terrain.uniforms.uZones.value = zones.texture();
  terrain.uniforms.uZoneE.value = zones.halfExtentKm;

  // Re-arms the surface loop, and only if it genuinely stopped. Called on the way back from
  // the globe, which may be entered and left repeatedly.
  const resumeFrame = () => {
    if (!surfaceStopped) return;
    surfaceStopped = false;
    frame.last = performance.now();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await B.finish();
  hud.showHome();

  // ---- Mount points for work in progress ----
  // One block per work package. Each package imports its own module and wires it up
  // inside its own block, so three people can add code here without landing on the
  // same lines. Everything a package is likely to need is already in scope: eph, data,
  // sites, rig, camera, scene, renderer, hud, go, nowH, setTime, groundAt, heightAt.
  //
  // Keep each block to wiring. Put the work itself in the package's own file, which
  // nobody else touches:
  //   P0  src/zones.js      zone data and zoneAt(lat, lon)
  //   P1  src/scene/globe.js   rotatable globe, zone colouring, candidate points
  //   P2  src/mission.js    arrival date, launch configuration, launch animation
  //   P3  src/analyze.js    site scoring;  src/ai.js  analysis text
  //
  // The mission configuration object that P2 produces and P3 consumes is fixed:
  //   { arriveH, launchH, stayH, needs: { craterFloor, iceNearby, continuousComm, maxDarkH } }
  // arriveH and launchH are hours from the start of the ephemeris range, so bound any
  // date control with eph.startYear / eph.endYear and clamp against eph.maxH, never
  // eph.count (a sample index, which only equals hours when the step is 1 h).

  // Set the mission clock. Declared here rather than further down because the blocks below
  // call it, and a const is not readable before its own declaration runs.
  const setTime = (h, rate = 0) => { clock.epochH = h; clock.t0 = performance.now(); clock.rate = rate; lastLit = null; };

  // Handover between the packages. P2 calls ready(cfg) when its launch animation ends;
  // P1 calls onMission(fn) to receive it. Held in one place for two reasons: the clock
  // has to be set in exactly one spot, and cfg is kept so the order of mounting does not
  // matter. A package that registers after the hand-over still gets the configuration,
  // which a DOM event would have dropped.
  const mission = {
    cfg: null,
    handler: null,
    ready(cfg) {
      this.cfg = cfg;
      setTime(cfg.arriveH, 1);            // start the clock at the arrival time, running in real time
      if (this.handler) this.handler(cfg);
      else go('home');                    // nothing listening yet: fall back to the overview
    },
    onMission(fn) {
      this.handler = fn;
      if (this.cfg) fn(this.cfg);         // already handed over, so deliver it now
    },
    // The second hand-over: the site the user committed to. Same shape of contract as the
    // first -- the value is held, so a package that mounts late still receives it rather than
    // missing an event it was not yet listening for. More than one screen cares (the analysis
    // panel, and the controls that unlock once a site exists), so subscribers are kept in a
    // list rather than a single slot.
    site: null,
    siteHandlers: [],
    onSite(fn) {
      this.siteHandlers.push(fn);
      if (this.site) fn(this.site);
    },
    publishSite(sel) {
      this.site = sel;
      for (const fn of this.siteHandlers) fn(sel);
    },
    // The third hand-over, in the other direction: a package that only has a site and an
    // entry (the calendar's recommendation) asks the zone map's own descendTo to do the
    // committing and flying, rather than re-implementing that flight. descendTo is a
    // block-scoped declaration elsewhere in this file, invisible here by design (see the
    // header note on packages not sharing lines), so it registers itself through this
    // contract instead of being named directly.
    visitHandler: null,
    onVisit(fn) {
      this.visitHandler = fn;
    },
    visit(site, entry) {
      if (this.visitHandler) this.visitHandler(site, entry);
    },
  };

  // P2, mission framing. Shows #mission, calls mission.ready(cfg) when the launch ends.
  {
    // P2 wires up here
    if (!(import.meta.env.DEV && new URLSearchParams(location.search).has('trim'))) {
      const { createMission } = await import('./mission.js');
      const { installExploreNavigation } = await import('./explore-navigation.js');
      installExploreNavigation({ root: hud.screen('explore'), onReturn: backFromSurface });
      const { installCameraBounds } = await import('./camera-bounds.js');
      installCameraBounds({
        camera, controls, tiles: data.tiles, radiusKm: R, heightAt,
        // P1 keeps ownSurface after landing; its interactive view still needs bounds.
        isActive: () => mode === 'explore' && controls.enabled && !flight && !globeShown,
      });
      const { createAnnualCalendar } = await import('./annual-calendar.js');
      createAnnualCalendar({
        root: hud.screen('select'), data, zones, eph,
        getMission: () => mission.cfg,
        getYear: () => eph.hoursToDate(nowH()).getUTCFullYear(),
        // "Show result" on the calendar's recommendation flies to that site the same way
        // picking it on the zone map does. descendTo is declared in a sibling block and is not
        // in scope here, so the call goes through the mission hand-off instead (mission.visit).
        onVisit: (cell) => mission.visit(cell.site, cell.entry),
      });
      const missionFlow = createMission({
        eph,
        data,
        onMissionReady(config) {
          const hasSelection = typeof mission.handler === 'function';
          hud.hideScreen('mission');
          syncScene(config.arriveH);
          // P1 stops the surface loop that normally refreshes the shared UTC display.
          hud.tick(config.arriveH, eph.hoursToDate(config.arriveH));
          mission.ready(config);
          // The host remains in home mode behind P2, so go('home') can be a no-op.
          if (!hasSelection && mode === 'home') {
            refreshLive(config.arriveH);
            hud.showHome();
            hud.focusEnter();
          }
          if (import.meta.env.DEV) console.info('P2 mission ready', JSON.stringify(config));
        },
      });
      hud.hideHome();
      hud.showScreen('mission');
      // Cache terrain only while P2's visible arrival form uses the home view as
      // a poster. P2's stage can stay stale after another screen conceals it;
      // it must never stop the host's camera flights or interactive views.
      // The original callback schedules the next frame through this shared binding.
      const surfaceFrame = frame;
      const missionRoot = hud.screen('mission');
      const profile = new URLSearchParams(location.search).has('perf');
      let surfaceDirty = true, surfaceFrames = 0, sampleStart = performance.now(), lastSurfaceTick = -1;
      const invalidateSurface = () => { surfaceDirty = true; };
      missionRoot.addEventListener('missionstagechange', invalidateSurface);
      window.addEventListener('resize', invalidateSurface);
      document.addEventListener('visibilitychange', invalidateSurface);
      frame = t => {
        // A rapid P1 show/hide can queue resumeFrame before the old callback drains.
        // Only one callback per display frame may continue the surface chain.
        if (t === lastSurfaceTick) return;
        lastSurfaceTick = t;
        // P1 owns its own loop during and after descent. Stop this chain and
        // let the existing resumeFrame() re-arm it when P1 releases the screen.
        if (globeShown || ownSurface) { surfaceStopped = true; return; }
        const stage = missionFlow.stage;
        const missionVisible = !missionRoot.hidden && !missionRoot.classList.contains('out');
        const covered = missionVisible && (stage === 'boot' || stage === 'orbit' || stage === 'pad' || stage === 'flight');
        const poster = missionVisible && stage === 'intro' && mode === 'home' && !flight;
        const paused = document.hidden || covered;
        if (profile && t - sampleStart >= 1000) {
          missionRoot.dataset.surfaceFps = (surfaceFrames * 1000 / (t - sampleStart)).toFixed(1);
          surfaceFrames = 0;
          sampleStart = t;
        }
        if (paused || (poster && !surfaceDirty)) {
          requestAnimationFrame(frame);
          return;
        }
        surfaceDirty = false;
        surfaceFrames += 1;
        surfaceFrame(t);
      };
      frame.last = surfaceFrame.last;
      missionFlow.ready.catch(error => console.error('Mission setup failed', error));
    }
  }

  // P1, moon-surface site selection. Shows #select, receives cfg through mission.onMission.
  {
    const globe = createGlobe({ renderer, data, zones, radiusKm: R });
    const sel = hud.screen('select');
    const backBtn = document.getElementById('sel-back');
    const toSelectBtn = document.getElementById('toselect');
    let active = false;
    let lastT = performance.now();
    // Handle of the pending globe frame, 0 when none is queued. show() and hide() can both be
    // called more than once -- the mission hand-over and the home button can land in either
    // order, and Back and Escape both route to the same place -- so the loop is owned by this
    // one handle rather than by whoever last called show().
    let frameReq = 0;
    // Orbit-controls state to put back on the way out, so the globe does not decide it
    let ctrlWasEnabled = false;
    let labelH = 0;        // measured height of one site label, for the collision pass

    globe.resize(window.innerWidth, window.innerHeight);
    // Graduations for the left-edge tape. Fixed at even spacing down from the frame centre and
    // labelled with the ground distance each position actually corresponds to, rather than
    // placed at fixed distances: on a globe the frame covers a few hundred km up close and a
    // few thousand km from far out, so marks at fixed distances would bunch against the centre
    // at one zoom and run off the edge at the other. This way the scale is honest at any zoom
    // and evenly readable, which is what a graduated rule is for.
    const tape = document.getElementById('sel-tape');
    const tapeEls = [...tape.children];
    // The tape is a radial scale down the left edge, with the pole at the frame centre, so the
    // same distance reads the same above and below it. Marks sit at fixed screen offsets and
    // each is labelled with the ground distance that offset corresponds to -- placing marks at
    // fixed distances instead would bunch them against the centre at close zoom and push them
    // off the edge at far zoom, since the frame covers a few hundred km up close and a few
    // thousand km from far out.
    const tapeKm = () => {
      const fov = (globe.camera.fov * Math.PI) / 360;
      const d = globe.distance;
      const halfKm = Math.max(1e-3, (d - 1) * Math.tan(fov)) * data.radiusKm;
      tapeEls.forEach((el, i) => {
        const off = i + 1;                       // 1..n, marks either side of the centre
        const side = el.dataset.side === 'down' ? 1 : -1;
        const frac = off * 0.11;                 // fraction of the half-frame this mark sits at
        el.hidden = frac > 0.95;
        el.style.top = `${50 + side * frac * 50}%`;
        const km = frac * halfKm;
        el.dataset.km = km >= 100 ? `${Math.round(km / 10) * 10}` : `${Math.round(km)}`;
      });
    };
    window.addEventListener('resize', () => {
      globe.resize(window.innerWidth, window.innerHeight);
      tipKey = '';       // force one re-measure of the hover box against the new root font size
      labelH = 0;
      tapeKm();
    });

    // Site markers: the same .site chip the home screen uses (white-edged red square, name
    // beside it), not a 3D object, so the two views read as one product rather than two. Each
    // is projected every frame from globe.screenOf and hidden when its site is on the far side.
    // Each marker also carries a leader line, used only when the label has had to be moved
    // off its own anchor to clear another label (see layoutMarks). The square stays on the
    // site; the leader is what keeps a moved name attached to it.
    // Both sources into one pool: the four published Artemis regions and the places the grid
    // scan found. Tagged inside candidatePool() so the list can tell a reader which is which.
    const pool = candidatePool(data);
    // How many rows the panel can carry before it stops being scannable. The rest are counted,
    // not hidden silently -- a list that just stops reads as the whole answer.
    const LIST_MAX = 8;
    const MAP_MARKS = 4;   // markers are far more crowded than list rows
    const mkHost = document.getElementById('sel-sites');
    const marks = {};
    // One marker per pool entry, built up front and shown or hidden per frame: the ranked set
    // changes whenever a requirement changes, and rebuilding DOM per change would lose the
    // label measurements layoutMarks caches.
    for (const s of pool) {
      const mk = document.createElement('div');
      mk.className = 'site off';
      mk.innerHTML = '<i></i><svg class="lead" aria-hidden="true"><polyline points="0,0 0,0" /></svg><span><b></b></span>';
      mk.querySelector('b').textContent = s.id;
      mk.querySelector('span').append(s.en);
      // A marker for a place our scan found is drawn hollow, matching how its row is marked in
      // the list: the two kinds of claim must not look identical on the map either.
      if (s.source === 'data') mk.classList.add('found');
      mkHost.appendChild(mk);
      marks[s.id] = { el: mk, lead: mk.querySelector('.lead polyline'), label: mk.querySelector('span') };
    }
    // Ground the scan measured and the darkness bar rejected (see tools/prep_candidates.py).
    // Drawn as bare grey points with no label: they show how much was looked at before the
    // pool was settled, and thirteen more names would bury the six that can actually be chosen.
    // Never ranked, never clickable -- they are not candidates.
    const surveyed = (data.candidates?.surveyed || []).map((c) => ({ ...c, source: 'data' }));
    const surveyMarks = surveyed.map((s) => {
      const mk = document.createElement('div');
      mk.className = 'site surveyed off';
      mk.innerHTML = '<i></i>';
      mkHost.prepend(mk);   // under the candidate markers in paint order
      return { s, el: mk };
    });

    // Legend: one row per zone class, in the fixed order the classification itself uses
    // (shadow first, down to the catch-all), reusing zones.js's own names and colours rather
    // than restating them.
    const legendHost = document.getElementById('sel-legend');
    for (const [key, s] of Object.entries(zones.style)) {
      if (key === 'rough') continue;      // the catch-all: showing it just restates "none of the above"
      const row = document.createElement('div');
      const [r, g, b] = s.rgba;
      const pct = data.zonesMeta.share_pct[key];
      row.innerHTML = `<dt><i class="swatch" style="background:rgb(${r},${g},${b})"></i>${s.name}</dt><dd>${pct.toFixed(1)}%</dd>`;
      legendHost.appendChild(row);
    }

    // The same legend on the surface screen, where the tint is now drawn on the ground itself.
    // Built from zones.style like the one above, so the two screens cannot drift apart.
    const exLegend = document.getElementById('ex-legend');
    if (exLegend && !exLegend.children.length) {
      for (const [key, st] of Object.entries(zones.style)) {
        if (key === 'rough') continue;
        const row = document.createElement('div');
        const [r, g, b] = st.rgba;
        row.innerHTML = `<dt><i class="swatch" style="background:rgb(${r},${g},${b})"></i>${st.name}</dt><dd>${data.zonesMeta.share_pct[key].toFixed(1)}%</dd>`;
        exLegend.appendChild(row);
      }
    }

    // Candidate-site list, mirroring the home screen's table: id chip, name, the figures a
    // selector actually needs (sun, Earth link, longest dark spell), from the full-resolution
    // horizon profile in sites.json rather than the 480 m zone grid (see zones.js's own note
    // on why the two can disagree at a site on a sharp ridge).
    //
    // Which year's figures: sun and Earth visibility genuinely move year to year (the 18.6 yr
    // lunar nodal cycle), so a site picked before the mission's arrival year is known shows
    // the whole-window average (stats); once it is known, this rebuilds against that year's
    // stats_by_year entry instead. The zone classification itself (shadow, prime, slope) is
    // not part of this: it describes the shape of the ground, not a moment in time, and the
    // source data behind it is a fixed observation period, not something to date-pick against.
    const siteListHost = document.getElementById('sel-site-list');
    let framedSite = null;    // which site the map is currently framed on, for click-to-commit
    let chosenSite = null;    // the site the user committed to, kept for hand-off to the analysis
    let missionNeeds = {};    // P2's requirements, applied when they arrive
    let lastYear = null;      // the arrival year the figures are being read for
    const siteListYear = document.getElementById('sel-site-year');
    function buildSiteList(year) {
      siteListHost.textContent = '';
      // Say which figures these are. Without the label the reader cannot tell an average from
      // a specific year's, and the two differ by several points at these sites. Both labels
      // name a whole-calendar-year mean, because that is what sites.json holds: a year entry
      // averages that entire year, not the arrival window inside it. Nothing here is computed
      // over a transfer or surface window, so neither label may imply one.
      siteListYear.textContent = year != null
        ? ` ${year} MEANS · WORST NIGHT ${eph.startYear}–${eph.endYear}`
        : ` ${eph.startYear}–${eph.endYear} MEANS · WORST NIGHT`;
      // The requirements P2 collected are what make this a ranking rather than a table: the
      // list is ordered by how well each site meets the mission as configured, and a site that
      // fails one is moved below every site that does.
      const ranked = rankSites(pool, zones, year, missionNeeds);
      // The pool is nineteen places now; listing all of them under a three-line-row budget
      // would either overflow the panel or squeeze every row to unreadable. The list shows the
      // ones worth acting on and says how many were left behind, rather than silently cutting.
      const shown = ranked.slice(0, LIST_MAX);
      const hidden = ranked.length - shown.length;
      shown.forEach((entry) => {
        const s = entry.site, st = entry.stats;
        const row = document.createElement('div');
        row.className = entry.meetsAll ? 'ok' : 'no';
        row.innerHTML = '<dt><i></i><span class="nm"></span><em></em></dt><dd><span class="fig"></span><span class="why"></span></dd>';
        row.querySelector('i').textContent = s.id;
        row.querySelector('.nm').textContent = s.en;
        // A published region and a place our own scan found are different claims; the chip
        // says which without needing a legend.
        if (s.source === 'data') row.classList.add('found');
        row.querySelector('em').textContent = entry.meetsAll ? 'MEETS' : 'FAILS';
        row.querySelector('.fig').textContent =
          `${st.sun_visible_pct.toFixed(1)}% sun · ${st.earth_visible_pct.toFixed(1)}% link · ${st.longest_dark_h} h dark`;
        // The reason a site was ruled out is the useful part of a failing row, so it is shown
        // rather than hidden behind a tooltip.
        row.querySelector('.why').textContent = explain(entry, missionNeeds);
        row.title = entry.fails.join('\n');
        // One click frames the site on the map, a second commits to it and goes down to the
        // surface. Going straight down on the first click would take the map away before the
        // user had seen the site in its surroundings, which is what the map is for.
        // Choosing a site is the one real decision in this product, and it was reachable only
        // with a mouse: these rows were plain divs with a click listener, so a keyboard could
        // reach the screen, fly the camera and leave again without ever being able to choose.
        // They are buttons now in everything but tag name -- focusable, announced, and driven by
        // Enter or Space, with the same two-step behaviour the pointer gets.
        const choose = () => {
          if (framedSite === s.id && !globe.flying) descendTo(s, entry);
          else { framedSite = s.id; globe.flyToSite(s); }
          for (const r of siteListHost.children) {
            const on = r === row;
            r.classList.toggle('sel', on);
            if (r.hasAttribute('aria-pressed')) r.setAttribute('aria-pressed', String(on));
          }
        };
        row.addEventListener('click', choose);
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-pressed', 'false');
        // Said out loud, because the two-step gesture is not discoverable: the first press
        // frames the site, the second commits to it.
        row.setAttribute('aria-label', `${s.en}, site ${s.id}. ${entry.meetsAll ? 'Meets the mission' : 'Does not meet the mission'}. `
          + `Press once to look at it, twice to land.`);
        row.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
          ev.preventDefault();      // Space would otherwise scroll the panel
          ev.stopPropagation();     // and the surface keymap must not see it as a drive command
          choose();
        });
        row.style.cursor = 'pointer';
        siteListHost.appendChild(row);
      });
      // Say what was left out, and where the markers are. The map marks only what the list
      // actually shows: the top few sit within about 150 km of each other near the pole, and
      // a marker per row turns that cluster into unreadable overlapping labels. The list is
      // the full answer; the map is a locator for it.
      globe.setSites(shown.slice(0, MAP_MARKS).map((e) => e.site));
      if (hidden > 0) {
        const more = document.createElement('div');
        more.className = 'more';
        more.textContent = `+${hidden} more in the pool, none meeting the mission better`;
        siteListHost.appendChild(more);
      }
      if (surveyed.length) {
        const sv = document.createElement('div');
        sv.className = 'more surveyed-note';
        const bar = data.candidates?.selection?.max_dark_h;
        sv.textContent = `${surveyed.length} more sites surveyed and measured (grey on the map); `
          + `none survives the ${bar} h night of Malapert Massif, the darkest NASA-published region.`;
        siteListHost.appendChild(sv);
      }
      // A requirement set stricter than every measured site reads the same on screen as a
      // broken ranking: an all-red list either way. Say which requirement is the actual
      // blocker and the loosest value that would let the best site through, so the fix is a
      // number to change rather than a guess.
      if (ranked.length && ranked.every((e) => !e.meetsAll)) {
        const warn = document.createElement('div');
        warn.className = 'allfail';
        if (Number.isFinite(missionNeeds.maxDarkH) && ranked.every((e) => e.stats.longest_dark_h > missionNeeds.maxDarkH)) {
          const best = Math.min(...ranked.map((e) => e.stats.longest_dark_h));
          warn.textContent = `No site in the pool stays under ${missionNeeds.maxDarkH} h of darkness; `
            + `the least-dark site measures ${best} h. Raise the darkness limit to at least that to admit it.`;
        } else {
          warn.textContent = 'No site in the pool meets every requirement as set.';
        }
        siteListHost.appendChild(warn);
      }
    }
    buildSiteList(null);

    const tip = document.getElementById('sel-tip');
    const tipZone = document.getElementById('sel-tip-zone');
    const tipSlope = document.getElementById('sel-tip-slope');
    const tipSun = document.getElementById('sel-tip-sun');
    const tipEarth = document.getElementById('sel-tip-earth');
    const tipLL = document.getElementById('sel-tip-ll');
    // Degrees with a hemisphere letter, not a signed number and not 0-360 east: this screen
    // is read against published site coordinates, which are written this way.
    const fmtLatLon = (lat, lon) => {
      const lo = ((((lon % 360) + 360) % 360) + 180) % 360 - 180;
      return `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'} · ${Math.abs(lo).toFixed(2)}° ${lo < 0 ? 'W' : 'E'}`;
    };
    // Box size, for keeping it inside the viewport. Measured when the widest field changes
    // rather than every frame, which would be a layout read per frame for a box whose size
    // only moves when the zone name does.
    let tipW = 0, tipH = 0, tipKey = '';
    let hoverPt = null;
    renderer.domElement.addEventListener('pointermove', (e) => {
      if (!active) return;
      hoverPt = { x: e.clientX, y: e.clientY };
    });
    // Without these the readout keeps its last position and values after the pointer has
    // gone, which parks it over the title block in the top-left corner.
    renderer.domElement.addEventListener('pointerleave', () => { hoverPt = null; tip.hidden = true; });
    window.addEventListener('blur', () => { hoverPt = null; tip.hidden = true; });

    document.getElementById('sel-pole').addEventListener('click', () => globe.flyToPole());
    document.getElementById('sel-overview').addEventListener('click', () => globe.flyToOverview());
    // The trial reads the same pool this screen ranks, so it is reachable from here rather than
    // being a separate entry point with its own idea of what the candidates are.
    document.getElementById('sel-trial').addEventListener('click', () => { if (worldsOpen) worldsOpen(); });

    // The globe is a second pass with the same renderer, so it owns the frame while it is up:
    // the surface scene's own loop is left running but its output is overwritten here.
    // The globe lights itself from the Moon-fixed Sun direction, not the scene one: the scene
    // frame has its origin on the south polar surface, where "up" is the pole's outward normal,
    // so feeding it scene coordinates would light the wrong hemisphere.
    const sunME = new THREE.Vector3(), earthME = new THREE.Vector3();
    // Marker layout. The four candidates lie within about 150 km of each other, so at the
    // overview distance their names land on top of one another and the stack is unreadable.
    // Only the name block moves: the square stays on the projected site, because that is the
    // measurement, and a leader line is drawn from the square to the name whenever the name
    // has been pushed off it. One pass down the screen opens a gap between neighbours, and a
    // pass back up pulls the stack in if the first one ran off the bottom edge.
    const slots = [];
    function layoutMarks(w, h) {
      slots.length = 0;
      for (const sm of surveyMarks) {
        const p = globe.screenOfLatLon(sm.s.lat, sm.s.lon, w, h);
        const onFront = p && p.front && p.x > 8 && p.x < w - 8 && p.y > 8 && p.y < h - 8;
        sm.el.classList.toggle('off', !onFront);
        if (onFront) sm.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
      }
      // Only the markers currently on the map get laid out; the marker set follows the ranked
      // list (see buildSiteList), not the whole pool.
      for (const s of globe.siteDirs.map((d) => d.site)) {
        const m = marks[s.id];
        if (!m) continue;
        const p = globe.screenOf(s, w, h);
        const onFront = p && p.front && p.x > 8 && p.x < w - 8 && p.y > 8 && p.y < h - 8;
        m.el.classList.toggle('off', !onFront);
        if (onFront) {
          m.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
          slots.push({ m, y: p.y, ly: p.y });
        }
      }
      if (!slots.length) return;
      // The chip's own height, read from the live element rather than assumed, so the spacing
      // follows the stylesheet. Falls back if the screen is not laid out yet.
      if (!labelH) labelH = Math.round(slots[0].m.label.getBoundingClientRect().height) || 22;
      const gap = labelH + 4;
      slots.sort((a, b) => a.y - b.y);
      let prev = -Infinity;
      for (const s of slots) { s.ly = Math.max(s.y, prev + gap); prev = s.ly; }
      const bottom = h - 12;
      if (slots[slots.length - 1].ly > bottom) {
        let next = bottom;
        for (let i = slots.length - 1; i >= 0; i--) {
          const s = slots[i];
          s.ly = Math.min(s.ly, next);
          next = s.ly - gap;
        }
      }
      for (const s of slots) {
        const dy = s.ly - s.y;
        const moved = Math.abs(dy) > 1;
        s.m.label.style.transform = `translateY(calc(-50% + ${dy.toFixed(1)}px))`;
        s.m.el.classList.toggle('lead-on', moved);
        // From just clear of the square to the left edge of the name at its new height
        if (moved) s.m.lead.setAttribute('points', `6,0 11,${dy.toFixed(1)}`);
      }
    }

    function frameGlobe(t) {
      frameReq = 0;
      if (!active) return;
      const dt = Math.min(64, t - lastT);
      lastT = t;
      const missionH = nowH(t);
      eph.rawAt(missionH, sunME, earthME);
      hud.tick(missionH, eph.hoursToDate(missionH));   // the surface loop that normally drives the clock is paused here
      globe.step(dt, sunME);
      globe.render();

      const w = window.innerWidth, h = window.innerHeight;
      layoutMarks(w, h);
      tapeKm();               // the scale changes with the camera, so it is read per frame

      if (hoverPt) {
        const hit = globe.surfaceAt(hoverPt.x, hoverPt.y, w, h);
        if (hit) {
          // The zone grid is a cap over the south pole, and zones.atLatLon projects by
          // |lat|, so asking it about a northern point answers with the mirror-image
          // southern cell. Ask only where the grid has ground, and say so where it has none
          // rather than quoting a figure for somewhere else.
          const z = hit.lat < 0 ? zones.atLatLon(hit.lat, hit.lon) : null;
          tip.hidden = false;
          tipZone.textContent = z ? z.name : 'OUTSIDE SURVEY GRID';
          tipSlope.textContent = z ? `${z.slopeDeg.toFixed(1)}°` : '—';
          tipSun.textContent = z ? `${z.sun.toFixed(0)}%` : '—';
          tipEarth.textContent = z ? `${z.earth.toFixed(0)}%` : '—';
          tipLL.textContent = fmtLatLon(hit.lat, hit.lon);
          if (tipKey !== tipZone.textContent) {
            tipKey = tipZone.textContent;
            tipW = tip.offsetWidth;
            tipH = tip.offsetHeight;
          }
          // Keep the whole box on screen: near the right or bottom edge it stops against the
          // edge instead of hanging off it with the figures cut away.
          const x = Math.min(hoverPt.x + 18, Math.max(8, w - tipW - 8));
          const y = Math.min(hoverPt.y + 18, Math.max(8, h - tipH - 8));
          tip.style.transform = `translate3d(${Math.max(8, x).toFixed(1)}px, ${Math.max(8, y).toFixed(1)}px, 0)`;
        } else {
          tip.hidden = true;      // pointer is off the body, on the sky
        }
      }

      frameReq = requestAnimationFrame(frameGlobe);
    }

    function show() {
      if (active) return;     // both ways in can fire; the second must not start a second loop
      active = true;
      globeShown = true;      // stops frame()'s own render call rather than racing it
      ownSurface = false;     // the map takes the screen back from a descent's own loop
      lastT = performance.now();
      // The surface camera's orbit controls are bound to this same canvas. Left enabled they
      // read the same drags and wheels the globe is reading and fly a camera nobody can see.
      ctrlWasEnabled = controls.enabled;
      controls.enabled = false;
      // Every other screen goes down, not just the two the mission hand-over leaves. A
      // surface HUD left over a globe is not merely untidy: explore and orbit each carry
      // their own top bar and clock, so the header reads as two places at once and the
      // bottom hint describes controls this screen does not have.
      hud.hideHome();
      hud.hideExplore();
      hud.hideOrbit();
      hud.hideScreen('mission');
      hud.showScreen('select');
      // The window may have been resized while this screen was down, and nothing resized the
      // globe's own camera then, so its aspect would be a frame stale on the way in.
      globe.resize(window.innerWidth, window.innerHeight);
      globe.attach(renderer.domElement);
      if (!frameReq) frameReq = requestAnimationFrame(frameGlobe);
      backBtn.focus({ preventScroll: true });
    }
    function hide() {
      if (!active) return;
      active = false;
      globeShown = false;
      if (frameReq) { cancelAnimationFrame(frameReq); frameReq = 0; }
      globe.detach();
      hoverPt = null;
      tip.hidden = true;
      controls.enabled = ctrlWasEnabled;
      resumeFrame();
      hud.hideScreen('select');
    }

    // Commit to a site: leave the map and put the surface camera on the ground beside it, the
    // same standing-off-the-rim pose the opening view uses, reached by the same flight. The
    // map answers "which one"; this answers "what does it actually look like".
    //
    // Terrain detail is not uniform across the four. The hero tile is +/-30.7 km of the pole,
    // so A and B stand on 40 m data while C (40 km out) and D (123 km) fall back to the inner
    // tile's 480 m cells, which is visibly coarser underfoot. The flight still works; the
    // ground is simply blockier at the two outer sites, and no interpolation would put detail
    // there that the DEM does not have.
    function descendTo(site, entry) {
      // The commitment is recorded before the camera moves, because it is what the rest of the
      // flow is about: the analysis screen scores the site the user chose, not the best site in
      // the abstract. Also announced on the mission object so a later package can pick it up
      // without P1 having to know who is listening.
      chosenSite = { site, entry, year: lastYear, needs: missionNeeds };
      mission.publishSite(chosenSite);
      surfaceHud.set(chosenSite);
      chosenSiteRef = () => chosenSite;
      // The rover belongs at the site the user committed to, not permanently at point A.
      placeRover(site, true);
      syncDescend();
      const m = latLonToMap(R, site.lat, site.lon);
      hide();
      hud.hideScreen('select');
      const a = { pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov };
      const b = rig.landing(aspect(), m);
      from = 'home';
      to = 'explore';
      mode = 'fly';
      // Drive the surface directly rather than leaving it to whoever owns the `frame` binding
      // (see the note on surfaceStep), and keep driving it after the camera lands. Handing back
      // would hand into P2's wrapper, which pauses while its own flow is anywhere short of
      // finished -- and arriving on the surface this way leaves that flow unfinished by
      // definition, since the zone map was reached without launching. ownSurface is released
      // when something else takes the screen: go() for the surface modes, or the map on return.
      ownSurface = true;
      requestAnimationFrame(function step(t) {
        if (!ownSurface) return;
        surfaceStep(t);
        requestAnimationFrame(step);
      });
      flight = {
        t0: performance.now(),
        dur: 2600,
        path: rig.flight(a, b),
        done: () => {
          flight = null;
          mode = 'explore';
          Object.assign(controls, CTRL.explore);
          controls.target.copy(b.target);
          controls.enabled = true;
          controls.update();
          hud.showExplore();
          cameFromMap = true;   // Back and Escape now return to the map, not to a skipped screen
        },
      };
    }
    // Let the calendar's "Show result" (or any other package with only a site and an entry)
    // reach descendTo through the mission hand-off, since the declaration itself is scoped to
    // this block. Site selection always mounts before the calendar wires up, so no deferred
    // delivery is needed here the way onMission/onSite provide it.
    mission.onVisit(descendTo);

    // The arrival time is what makes the site figures specific rather than an average, so it
    // is read here rather than ignored. Clamped into the ephemeris range: a date control that
    // let the user off the end of it would otherwise index a year that has no entry.
    mission.onMission((cfg) => {
      // The requirements are the other half of the configuration, and the half that decides
      // what this screen is actually for: without them the list is a table of measurements,
      // with them it ranks against the mission the user described. Both were being collected
      // by P2 and only arriveH was being read.
      missionNeeds = (cfg && cfg.needs) || {};
      lastYear = null;
      if (cfg && Number.isFinite(cfg.arriveH)) {
        const y = eph.hoursToDate(THREE.MathUtils.clamp(cfg.arriveH, 0, eph.maxH)).getUTCFullYear();
        lastYear = THREE.MathUtils.clamp(y, eph.startYear, eph.endYear);
      }
      buildSiteList(lastYear);
      show();
    });
    // A way in that does not depend on P2. The mission flow is the intended route here --
    // it is what supplies the arrival date the figures key off -- but the zone map stands on
    // its own, and without this the screen is unreachable unless the launch sequence has run.
    // Only from the home screen, which is the only place the button is. The other dock
    // buttons get this guard from go(), which refuses to start a second move while one is
    // running; this one does not go through go(), and taking the frame mid-flight would
    // leave the flight suspended with its completion callback pending.
    hud.onSelect(() => { if (mode === 'home') show(); });

    // Back and Escape. Both ways into this screen come from home and neither moves the surface
    // camera, so the usual case is not a flight: the home HUD goes back up directly, because
    // go('home') from home is a no-op and would leave no screen up at all. The drift phase is
    // restarted the way go('home') restarts it, so the home view eases back in from its base
    // pose rather than jumping to wherever the unrendered phase ran on to while the globe held
    // the frame. Focus lands on the control that leads back here.
    //
    // If the camera is somewhere else, it is flown back instead. Nothing in the interface can
    // reach this screen from another mode -- the button is guarded above -- but the dev hook
    // can, and restoring the home HUD over a camera parked at the landing site would leave
    // the panels describing one view and the render showing another.
    leaveGlobe = () => {
      if (!active) return;
      hide();
      // Camera parked at another viewpoint: fly it back, and let go() put its screen up.
      if (mode === 'explore' || mode === 'orbit') { go('home'); return; }
      // Mid-flight. The flight owns the screen and raises it on arrival, so adding one here
      // would leave two up at once; hide() has already restarted the loop that finishes it.
      if (mode === 'fly') return;
      controls.enabled = false;
      driftT0 = performance.now();
      look.yaw = look.pitch = 0;
      hud.showHome();
      toSelectBtn.focus({ preventScroll: true });
    };
    backBtn.addEventListener('click', leaveGlobe);

    // Up from the surface, back to the map, with the site still framed. The surface camera is
    // left where it is: the map owns its own scene, so nothing has to be un-flown, and coming
    // back down re-flies from the current position anyway.
    returnToMap = () => {
      if (mode === 'rover') leaveRover();
      cameFromMap = false;
      mode = 'home';
      flight = null;
      hud.hideScreen('explore');
      hud.hideScreen('rover');
      show();
    };
    document.getElementById('tositemap').addEventListener('click', returnToMap);
    // Forward, to the analysis of the site just visited. Disabled until a site has actually
    // been committed to, since there is nothing to analyse before that.
    const analyseBtn = document.getElementById('toanalysis');
    analyseBtn.disabled = true;
    analyseBtn.addEventListener('click', () => { if (mission.site) window.__lln_analysis?.(mission.site); });
    mission.onSite(() => { analyseBtn.disabled = false; });

    // Reachable before P2 exists, for development
    window.__lln_showGlobe = show;
    window.__lln_setYear = buildSiteList;
    window.__lln_hideGlobe = hide;
    window.__lln_globe = globe;
  }

  // P3, criteria and AI analysis. Shows #analysis. Reads mission.cfg and scores against it.
  //
  // This renders the ranking the map already computed, rather than scoring again: the map and
  // this screen have to agree on why a site wins, and two independent scorers would drift. What
  // it adds is the per-requirement breakdown, which the list has no room for, and an assessment
  // paragraph. Both are assembled from measured values only -- no model call, so the analysis
  // renders with the network off, which is the requirement the submission has to meet.
  {
    const an = id => document.getElementById(id);
    let current = null;

    function render(sel) {
      current = sel;
      const { site, entry, year, needs } = sel;
      an('an-site').textContent = site.en;
      // "Suitable as configured" was written unconditionally, which claimed a verdict against a
      // mission even when no requirement had been set -- and it overrode explain(), four lines
      // below, which already words that case correctly. The headline now follows whether
      // anything was actually asked of the site.
      const asked = entry.verdicts.length > 0;
      an('an-verdict').textContent = !asked ? 'Ranked on measured conditions'
        : entry.meetsAll ? 'Suitable as configured' : 'Does not meet the mission';
      an('an-year').textContent = year != null
        ? `${year} MEANS, WORST-CASE NIGHT · ${site.lat.toFixed(2)}° S · ${site.lon.toFixed(2)}° E`
        : `${site.lat.toFixed(2)}° S · ${site.lon.toFixed(2)}° E`;

      const reqs = an('an-reqs');
      reqs.textContent = '';
      // Reachable again now that verdicts are only produced for requirements that were set.
      const rows = entry.verdicts.length ? entry.verdicts
        : [{ label: 'No requirements set', pass: true, value: 'measured conditions only' }];
      for (const v of rows) {
        const row = document.createElement('div');
        row.innerHTML = '<dt></dt><dd><span class="val"></span><em></em></dd>';
        row.querySelector('dt').textContent = v.label;
        row.querySelector('.val').textContent = v.value;
        const em = row.querySelector('em');
        em.dataset.state = v.pass ? 'on' : 'off';
        em.textContent = v.pass ? 'PASS' : 'FAIL';
        reqs.appendChild(row);
      }

      an('an-ai').textContent = explain(entry, needs);
      const st = entry.stats;
      an('an-credit').textContent =
        `${st.sun_visible_pct.toFixed(1)}% sunlight · ${st.earth_visible_pct.toFixed(1)}% Earth link · `
        + `${st.both_pct.toFixed(1)}% both · longest dark ${st.longest_dark_h} h. `
        + 'Percentages are whole-calendar-year means from LOLA horizon profiles and DE421. The '
        + 'longest night is not a mean: it is the worst continuous dark run measured across the '
        + 'whole record, which is the figure a lander has to survive, and it can exceed any one '
        + 'year when a spell crosses a year boundary. Neither is a surface-window calculation.';
    }

    const isOpen = () => !an('analysis').hidden;
    function open(sel) {
      render(sel);
      hud.hideScreen('explore');
      hud.showScreen('analysis');
      an('an-back').focus({ preventScroll: true });
    }
    // Closing returns to the surface, which is where this screen is reached from. It is the
    // one thing that must not drift: leaving the panel up over a screen it replaced is how the
    // two end up stacked.
    function close() {
      if (!isOpen()) return;
      hud.hideScreen('analysis');
      hud.showExplore();
      an('an-back').blur();
    }
    analysisOpen = isOpen;
    closeAnalysis = close;

    // Subscribes only so a committed site is available; it deliberately does not open the
    // screen. Publishing happens as the descent begins, so opening here would take the user to
    // the analysis before they had seen the site they picked, with the flight running unseen
    // behind it -- and the button that is meant to lead here would then be opening a screen
    // that had already opened itself.
    mission.onSite((sel) => { current = sel; });
    an('an-back').addEventListener('click', close);
    an('an-map').addEventListener('click', () => {
      hud.hideScreen('analysis');
      returnToMap();
    });
    window.__lln_analysis = open;
  }

  // Leo, F-03 rover top speed: type a value, or reset to the real rover's speed
  {
    const box = document.getElementById('rspeed');
    const apply = (v) => { if (Number.isFinite(v)) rover.setSpeed(v); box.value = +rover.speed().toFixed(1); };
    box.addEventListener('change', () => apply(parseFloat(box.value)));
    // select the old value on focus so typing replaces it (deferred: the click's mouseup would clear it)
    box.addEventListener('focus', () => setTimeout(() => box.select(), 0));
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();   // typing here must not drive the rover or leave the view
      if (e.key === 'Enter') { apply(parseFloat(box.value)); box.blur(); }
      else if (e.key === 'Escape') { apply(NaN); box.blur(); }
    });
    document.getElementById('rspeed-reset').addEventListener('click', () => apply(SPEED_LIMITS.real));
    apply(rover.speed());
    // the rover runs on mission time: a sped-up clock makes it drive that much faster too
    setInterval(() => rover.setTimeScale(clock.rate), 200);
  }

  // Leo, F-06 time controls: every top-bar clock opens one shared popover
  {
    const MAX_RATE = 100000;
    const clampH = (h) => THREE.MathUtils.clamp(h, 0, eph.maxH);
    const toInput = (d) => d.toISOString().slice(0, 16);
    const fromInput = (v) => (Date.parse(`${v}:00Z`) - eph.start) / 3600e3;

    const pop = document.createElement('div');
    pop.id = 'timepop';
    pop.className = 'panel';
    pop.hidden = true;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Mission time');
    pop.innerHTML = `
      <h2>Mission Time <span class="tp-utc">UTC</span></h2>
      <label class="tp-l" for="tp-date">Date and time</label>
      <div class="tp-row"><input id="tp-date" type="datetime-local" step="60"><button class="mini" type="button" data-act="go">Go</button></div>
      <p class="tp-note">Any date from ${eph.startYear} to ${eph.endYear}.</p>
      <label class="tp-l" for="tp-rate">Speed</label>
      <div class="tp-row numset"><input id="tp-rate" class="num" type="number" inputmode="decimal" min="0" max="${MAX_RATE}" step="any"><span class="num-u">× real time</span></div>
      <p class="tp-note" id="tp-rate-note"></p>
      <div class="tp-center"><button class="mini" type="button" data-act="normal">Normal speed</button></div>`;
    document.getElementById('hud').appendChild(pop);
    const date = pop.querySelector('#tp-date');
    date.min = toInput(eph.hoursToDate(0));
    date.max = toInput(eph.hoursToDate(eph.maxH));

    const rateBox = pop.querySelector('#tp-rate'), rateNote = pop.querySelector('#tp-rate-note');
    const badges = [];
    const span = (s) => {
      const u = [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']].find(([k]) => s >= k) || [1, 'second'];
      const n = +(s / u[0]).toFixed(1);
      return `${n} ${u[1]}${n === 1 ? '' : 's'}`;
    };
    const sync = () => {
      if (document.activeElement !== rateBox) rateBox.value = clock.rate;
      rateNote.textContent = clock.rate === 0 ? 'Paused. Type 0 to pause, 1 for real time.'
        : clock.rate === 1 ? 'Real time. Try 3600 to watch one hour pass every second.'
        : `Each real second shows ${span(clock.rate)} of mission time.`;
      const txt = clock.rate === 0 ? 'PAUSED' : clock.rate === 1 ? '' : `×${clock.rate}`;
      for (const s of badges) s.textContent = txt;
    };
    const set = (h, rate = clock.rate) => { setTime(clampH(h), rate); jumped = false; sync(); };

    let anchor = null;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      pop.style.top = `${Math.round(r.bottom + 8)}px`;
      pop.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    };
    const open = (btn) => {
      anchor = btn;
      date.value = toInput(eph.hoursToDate(nowH()));
      pop.hidden = false;
      place();
      sync();
      btn.setAttribute('aria-expanded', 'true');
      date.focus({ preventScroll: true });
    };
    const close = () => {
      if (pop.hidden) return;
      pop.hidden = true;
      anchor?.setAttribute('aria-expanded', 'false');
      anchor?.focus({ preventScroll: true });
    };

    // Wrap each clock's contents in a button; hud.bind keeps writing into the same <time> element
    for (const p of document.querySelectorAll('.clock')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'clockbtn';
      btn.title = 'Change mission time';
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.setAttribute('aria-expanded', 'false');
      btn.append(...p.childNodes);
      const badge = document.createElement('span');
      badge.className = 'clock-rate';
      badges.push(badge);
      const edit = document.createElement('span');
      edit.className = 'clock-edit';
      edit.textContent = 'Change time';
      btn.append(badge, edit);
      p.append(btn);
      btn.addEventListener('click', (e) => { e.stopPropagation(); if (pop.hidden || anchor !== btn) open(btn); else close(); });
    }

    pop.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'go' && date.value) set(fromInput(date.value));
      else if (b.dataset.act === 'normal') set(nowH(), 1);
      date.value = toInput(eph.hoursToDate(nowH()));
    });
    date.addEventListener('keydown', (e) => { if (e.key === 'Enter' && date.value) set(fromInput(date.value)); });
    const applyRate = () => {
      const v = parseFloat(rateBox.value);
      if (Number.isFinite(v)) set(nowH(), THREE.MathUtils.clamp(v, 0, MAX_RATE));
      rateBox.value = clock.rate;
    };
    rateBox.addEventListener('change', applyRate);
    rateBox.addEventListener('focus', () => setTimeout(() => rateBox.select(), 0));
    rateBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRate(); });
    // Keys typed in the popover must not drive the rover or trigger Esc-to-home
    pop.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
    document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.clockbtn')) close(); });
    window.addEventListener('resize', () => { if (!pop.hidden) place(); });
    // Close when its clock's screen goes away
    setInterval(() => { if (!pop.hidden && !anchor.offsetParent) close(); }, 300);
    sync();
  }

  // ---- Robustness trial: the same ground against a hundred requirement sets ----
  // Why this screen exists: a single ranking names the best site for one stated mission, which
  // is not the question a planner has. Requirements move -- a launch slips a year, a relay is
  // not approved, an endurance budget is cut -- and a site that wins narrowly under one set and
  // fails under the next is the worse choice. So every set is run and survival is counted. See
  // src/worlds.js for exactly what a "requirement set" is and what this deliberately does not
  // claim (no probabilities, no engineering models).
  {
    // The same pool the selector ranks. Rebuilt here rather than reaching into the select
    // screen's scope: candidatePool is pure, so both reads cannot disagree.
    const trialPool = candidatePool(data);
    const lanesEl = document.getElementById('w-lanes');
    const prog = document.getElementById('w-prog');
    const label = document.getElementById('w-label');
    const verdict = document.getElementById('w-verdict');
    let run = null, token = 0, lanes = new Map();

    function build(result) {
      // One lane per site, each holding one segment per requirement set. The previous shape put
      // the sets on the outside (a hundred cells) and the sites on the inside (six 3px dots per
      // cell), which made the comparison the screen exists for the hardest thing on it to read.
      lanesEl.textContent = '';
      lanes = new Map();
      const total = result.timeline.length;
      // Ordered by mean score, highest first -- NOT by survival. This is the whole argument of the
      // screen: if a site's score predicted how much mission change it could absorb, the lanes
      // would get shorter down the list. They do not. On the shipped pool Malapert Massif scores
      // 0.750 and survives 36 sets while Shackleton Rim scores 0.638 and survives 50, so the
      // longest lane sits at the bottom. Sorting by survival instead would hide that: the lanes
      // would decrease neatly and the reversal would be invisible.
      const byScore = [...result.sites].sort((a, b) => b.meanScore - a.meanScore);
      for (const [rank, s] of byScore.entries()) {
        const lane = document.createElement('div');
        lane.className = 'w-lane' + (s.site.source === 'data' ? ' found' : '');
        lane.innerHTML = '<i class="w-lane-id"></i><b class="w-lane-name"></b>'
          + '<span class="w-lane-track"></span><em class="w-lane-count">0</em>'
          + '<p class="w-lane-why"></p>';
        lane.querySelector('.w-lane-id').textContent = s.site.id;
        lane.dataset.rank = String(rank + 1);
        // Score rank, name, and the measured night length on one line: the rank is the claim being
        // tested, and the night is the reason the lane breaks where it does. Putting the cause
        // beside the effect is what lets the chart be read without the paragraph above it.
        const nm = lane.querySelector('.w-lane-name');
        nm.textContent = `${rank + 1}. ${s.site.en}`;
        const night = s.site.stats?.longest_dark_h;
        if (Number.isFinite(night)) {
          const sub = document.createElement('span');
          sub.className = 'w-lane-night';
          sub.textContent = `${night} h night`;
          nm.appendChild(sub);
        }
        const track = lane.querySelector('.w-lane-track');
        const segs = [];
        for (let i = 0; i < total; i++) {
          const seg = document.createElement('i');
          seg.className = 'w-seg';
          track.appendChild(seg);
          segs.push(seg);
        }
        lanesEl.appendChild(lane);
        lanes.set(s.site.id, {
          lane, segs, n: 0,
          count: lane.querySelector('.w-lane-count'),
          why: lane.querySelector('.w-lane-why'),
        });
      }
    }

    // Replay the trial one set at a time. The pacing is the point: fast enough to watch a
    // hundred sets without waiting, slow enough that an elimination is legible.
    async function play(result, instant) {
      const me = ++token;
      const total = result.timeline.length;
      for (const l of lanes.values()) {
        l.n = 0; l.count.textContent = '0'; l.why.textContent = '';
        l.lane.classList.remove('lead', 'alive');
        for (const s of l.segs) s.className = 'w-seg';
      }
      const order = result.sites.map((s) => s.site.id);
      for (let i = 0; i < total; i++) {
        if (me !== token) return;                 // a replay or a skip superseded this run
        const step = result.timeline[i];
        const deadIds = new Set(step.dead.map((d) => d.id));
        // Fill column i of every lane at once: the same requirement set judged against all six
        // sites, which is the comparison a reader is here to make.
        for (const id of order) {
          const l = lanes.get(id);
          if (!l) continue;
          const dead = deadIds.has(id);
          const seg = l.segs[i];
          seg.className = `w-seg now ${dead ? 'dead' : 'alive'}`;
          if (i > 0) l.segs[i - 1].classList.remove('now');
          l.lane.classList.toggle('alive', !dead);
          if (!dead) {
            l.n += 1;
            l.count.textContent = String(l.n);
          }
        }
        prog.textContent = `${i + 1} / ${total}`;
        label.textContent = step.world.label;
        // Pacing, in three stages. 26 ms a set ran the whole trial in 2.6 s, which was over
        // before a viewer had found the chart. Holding longer only on sets that eliminate
        // something does not help either: 90 of the 100 sets eliminate at least one site, so
        // that rule is nearly uniform.
        //
        // So the rhythm follows the viewer instead of the data: the first sets are slow enough
        // to read a lane and understand what a break means, the middle runs fast so a hundred
        // sets feel like a hundred, and the last few slow down again so the result lands rather
        // than simply stopping. Skip to result is always there for anyone who would rather not
        // watch it.
        if (!instant) {
          const hold = reducedMotion.matches ? 0
            : i < 6 ? 420 - i * 45          // 420 down to 195: the rules, legibly
            : i > total - 8 ? 150 + (i - (total - 8)) * 55   // 150 up to 530: the close
            : 60;                            // the body of the run
          await new Promise((r) => setTimeout(r, hold));
        }
        if (me !== token) return;
      }
      // Clear the head marker from the final column.
      for (const l of lanes.values()) l.segs[total - 1]?.classList.remove('now');
      if (me !== token) return;
      const ranked = [...result.sites];
      // The lane order is NOT touched here. It stays in score order from build(), because that
      // order is the argument: re-sorting by survival at the end would make the lanes decrease
      // neatly down the list and erase the mismatch the screen exists to show. Only the
      // per-lane explanation and the winner's highlight are filled in.
      for (const s of ranked) {
        const l = lanes.get(s.site.id);
        if (!l) continue;
        l.why.textContent = s.survived === result.worlds.length
          ? 'met every requirement in every set'
          : s.weakness ? `most often ruled out on: ${s.weakness.toLowerCase()}` : '';
      }
      // The most durable site, wherever it sits in the score order -- that is the point.
      lanes.get(ranked[0].site.id)?.lane.classList.add('lead');
      verdict.textContent = worldsSummarise(result);
      label.textContent = '';
    }

    function open() {
      // Built against the mission's own arrival year span and the live pool, so the trial always
      // reflects the data on screen rather than a cached run.
      const worlds = buildWorlds({ startYear: eph.startYear, endYear: eph.endYear, count: 100 });
      run = runWorlds(trialPool, zones, worlds);
      build(run);
      verdict.textContent = 'Running…';
      // The zone map and the trial are both full-screen siblings, so the map has to go or the
      // two draw over each other.
      hud.hideScreen('select');
      hud.showScreen('worlds');
      play(run, false);
    }
    function close() { token++; hud.hideScreen('worlds'); }

    document.getElementById('w-back').addEventListener('click', () => { close(); hud.showScreen('select'); });
    document.getElementById('w-replay').addEventListener('click', () => { if (run) { build(run); play(run, false); } });
    document.getElementById('w-skip').addEventListener('click', () => { if (run) { build(run); play(run, true); } });

    worldsOpen = open;
    worldsClose = close;
    worldsIsOpen = () => !document.getElementById('worlds').hidden;
  }

  // Debug entry point
  window.__lln = { THREE, scene, siteMark, camera, controls, terrain, shadows, sky, bodies, post, eph, data, renderer, rig, sites, zones, mission, crater, station, rover, clock, setTime, groundAt, heightAt, go, enterRover, leaveRover, keys, get mode() { return mode; } };
  // Core alignment trim panel: hidden entry, appears only in dev mode when the URL carries ?trim, and flies straight to the relay station on load (code kept for later calls).
  // Readings are absolute trims relative to CORE_Q, starting from CORE_TRIM in station.js; copy tuned values back into CORE_TRIM
  const trimQuery = new URLSearchParams(location.search).has('trim');
  if (import.meta.env.DEV && trimQuery) {
    const F = [
      ['rx', 'Rotate X · pitch (deg)', 5, 0.01], ['ry', 'Rotate Y · yaw (deg)', 5, 0.01], ['rz', 'Rotate Z · roll along spine (deg)', 10, 0.01],
      ['dx', 'Move X (m)', 1.5, 0.005], ['dy', 'Move Y (m)', 1.5, 0.005], ['dz', 'Move Z · along spine (m)', 1.5, 0.005],
    ];
    const KEY = 'lln.coreTrim';
    const base = () => Object.fromEntries(F.map(([k]) => [k, CORE_TRIM[k] || 0]));
    const val = base();
    try { Object.assign(val, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* bad data falls back to the baked values */ }
    const css = document.createElement('style');
    css.textContent = `
      #trim { position: fixed; right: 18px; top: 84px; z-index: 9999; width: 340px;
        display: none; flex-direction: column; gap: 6px; padding: 12px 16px; box-sizing: border-box;
        background: rgba(8, 10, 12, 0.88); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 4px;
        color: #e8eaed; font: 12px/1.4 system-ui, -apple-system, sans-serif; pointer-events: auto; }
      #trim h4 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; }
      #trim p { margin: 0; color: #9aa0a6; font-size: 11px; }
      #trim label { display: grid; grid-template-columns: 1fr 74px; gap: 2px 8px; align-items: center; }
      #trim label span { grid-column: 1 / -1; color: #c4c7cc; }
      #trim input[type=range] { width: 100%; margin: 0; accent-color: #ff3b30; }
      #trim input[type=number], #trim .out { box-sizing: border-box; width: 100%; padding: 3px 5px; border-radius: 2px;
        background: #15181c; color: #fff; border: 1px solid rgba(255, 255, 255, 0.22); font: 12px ui-monospace, Menlo, monospace; }
      #trim .out { resize: none; line-height: 1.5; }
      #trim .row { display: flex; gap: 8px; align-items: center; }
      #trim button { flex: 1; padding: 6px 0; border-radius: 2px; cursor: pointer; font: inherit;
        background: #ff3b30; color: #fff; border: 0; }
      #trim button.ghost { background: transparent; border: 1px solid rgba(255, 255, 255, 0.3); }
      #trim .chk { display: flex; gap: 14px; color: #c4c7cc; }
      #trim .chk label { display: flex; gap: 5px; }
    `;
    const pane = document.createElement('div');
    pane.id = 'trim';
    pane.innerHTML = `
      <h4>Core alignment trim</h4>
      <p>Rotates and shifts the whole core section about the PPE aft port (the PPE solar wings follow). Red line: station spine. Blue line: HALO module centreline, measured from the model.</p>
      ${F.map(([k, name, max, step]) => `<label><span>${name}</span>
        <input type="range" data-k="${k}" min="${-max}" max="${max}" step="${step}">
        <input type="number" data-k="${k}" step="${step}"></label>`).join('')}
      <textarea class="out" rows="2" readonly></textarea>
      <div class="row"><button class="copy">Copy values</button><button class="ghost reset">Restore baked</button></div>
      <div class="chk"><label><input type="checkbox" class="axis" checked>Reference lines</label><label><input type="checkbox" class="spin" checked>Auto-orbit camera</label></div>
    `;
    document.head.appendChild(css);
    document.body.appendChild(pane);
    // Drags, wheel and key presses inside the panel are not passed to the camera controls or global shortcuts
    for (const ev of ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'keydown', 'keyup']) pane.addEventListener(ev, (e) => e.stopPropagation());
    const out = pane.querySelector('.out');
    const fmt = (k) => val[k].toFixed(k[0] === 'r' ? 2 : 3);
    const apply = () => {
      station.adjustCore(val);
      for (const el of pane.querySelectorAll('[data-k]')) if (document.activeElement !== el || el.type === 'range') el.value = val[el.dataset.k];
      out.value = ['rx', 'ry', 'rz'].map((k) => `${k}=${fmt(k)}`).join(' ') + '\n' + ['dx', 'dy', 'dz'].map((k) => `${k}=${fmt(k)}`).join(' ');
      localStorage.setItem(KEY, JSON.stringify(val));
    };
    pane.addEventListener('input', (e) => {
      const k = e.target.dataset && e.target.dataset.k;
      if (!k) return;
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) { val[k] = v; apply(); }
    });
    const copyBtn = pane.querySelector('.copy');
    copyBtn.addEventListener('click', async () => {
      out.select();
      let ok = false;
      try { await navigator.clipboard.writeText(out.value); ok = true; } catch { ok = document.execCommand('copy'); }
      copyBtn.textContent = ok ? 'Copied' : 'Selected, press ⌘C';
      setTimeout(() => { copyBtn.textContent = 'Copy values'; }, 1400);
    });
    pane.querySelector('.reset').addEventListener('click', () => { Object.assign(val, base()); apply(); });
    const axisChk = pane.querySelector('.axis'), spinChk = pane.querySelector('.spin');
    axisChk.addEventListener('change', () => station.showAxis(axisChk.checked && mode === 'orbit'));
    spinChk.addEventListener('change', () => { if (mode === 'orbit') controls.autoRotate = spinChk.checked; });
    apply();
    let shown = false;
    setInterval(() => {
      const on = mode === 'orbit';
      if (on === shown) return;
      shown = on;
      pane.style.display = on ? 'flex' : 'none';
      station.showAxis(on && axisChk.checked);
      if (on) controls.autoRotate = spinChk.checked;
    }, 150);
    // Fly to the relay station once the home entrance animation has played (skip if the user clicked elsewhere meanwhile)
    setTimeout(() => { if (mode === 'home') go('orbit'); }, 1500);
  }
  if (import.meta.env.DEV) {
    // Render one frame at a fixed size (in home mode using the standard composition without drift) and save it to shots/<name>.jpg
    window.__shot = async (name, w = 1600, h = 900) => {
      renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
      post.resize(w, h, 1);
      camera.aspect = w / h;
      if (mode === 'home') rig.apply(rig.home(w / h));
      camera.updateProjectionMatrix();
      syncScene(nowH());
      syncCamera();
      station.update(camera, eph, performance.now(), mode === 'orbit');
      shadows.render(renderer, eph.sunDir, keyDir);
      for (let i = 0; i < 3; i++) post.composer.render();
      const url = renderer.domElement.toDataURL('image/jpeg', 0.9);
      renderer.setPixelRatio(PR);
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      post.resize(window.innerWidth, window.innerHeight, PR);
      camera.aspect = aspect();
      camera.updateProjectionMatrix();
      await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name: name + '.jpg', data: url }) });
      return name;
    };
  }
}

boot().catch((e) => {
  console.error(e);
  hud.boot.fail(e);
});
