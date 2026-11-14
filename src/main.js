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
import { createRover } from './scene/rover.js';
import { createZones } from './zones.js';

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
      R, terrain, tiles: data.tiles, shadows, eph, anchor: sites.byId('A').map, crater,
      heightAt, mapToScene, sceneToMap, upAt,
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

  // ---- Mode switching: home ⇄ explore, home ⇄ orbit, orbit → explore (landing) ----
  // The two free-look views use different OrbitControls limits: crater rim in kilometres, relay station in hundreds of metres
  const CTRL = {
    explore: { minDistance: 2, maxDistance: 220, minPolarAngle: 0, maxPolarAngle: THREE.MathUtils.degToRad(88), autoRotate: false },
    orbit: { minDistance: 0.06, maxDistance: 1.2, minPolarAngle: THREE.MathUtils.degToRad(15), maxPolarAngle: THREE.MathUtils.degToRad(150), autoRotate: true, autoRotateSpeed: 0.25 },
  };
  let from = 'home', to = 'home';
  const poseOf = (m) => (m === 'explore' ? rig.landing(aspect()) : m === 'orbit' ? rig.orbit(aspect(), station.place) : rig.home(aspect()));
  function go(target) {
    if (mode === 'fly' || mode === target || mode === 'rover') return;
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
        lit: st.lit, power: st.power, warn: st.warn, hlOn: st.hlOn, jumped,
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

  function frame(t) {
    const h = nowH(t);
    syncScene(h);
    const asp = aspect();
    if (Math.abs(camera.aspect - asp) > 1e-6) { camera.aspect = asp; camera.updateProjectionMatrix(); }
    let u = 1;
    const dt = Math.min((t - (frame.last || t)) / 1000, 0.1);
    frame.last = t;
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
    requestAnimationFrame(frame);
  }

  // Low-frequency tasks: site state, site occlusion
  setInterval(() => {
    refreshLive(nowH());
    if (mode === 'orbit') refreshOrbit();
    if (mode === 'home') for (const s of sites.sites) blocked[s.id] = occluded(camera.position, s.scene);
  }, 400);

  // ---- Interaction ----
  hud.onEnter(() => go('explore'));
  hud.onBack(() => go('home'));
  hud.onOrbit(() => { refreshOrbit(); go('orbit'); });
  hud.onOrbitBack(() => go('home'));
  hud.onDescend(() => go('explore'));
  hud.onRover(() => enterRover());
  hud.onRoverBack(() => leaveRover());
  hud.onLights(() => rover.toggleLights());
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
    if (e.key === 'Escape' && (mode === 'explore' || mode === 'orbit')) go('home');
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
  requestAnimationFrame(frame);
  await B.finish();
  hud.showHome();

  // P0, landing zones. Built here because P1 and P3 both read it: P1 colours the
  // surface with zones.texture() and shows zones.at() on hover, P3 scores a site with
  // the same values. A cell is 480 m, so these are area characteristics; precise
  // per-site figures stay in sites.json.
  const zones = createZones(data.zones, data.zonesMeta);

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
      setTime(cfg.arriveH, 0);            // stop the clock at the arrival time
      if (this.handler) this.handler(cfg);
      else go('home');                    // nothing listening yet: fall back to the overview
    },
    onMission(fn) {
      this.handler = fn;
      if (this.cfg) fn(this.cfg);         // already handed over, so deliver it now
    },
  };

  // P2, mission framing. Shows #mission, calls mission.ready(cfg) when the launch ends.
  {
    // P2 wires up here
  }

  // P1, moon-surface site selection. Shows #select, receives cfg through mission.onMission.
  {
    // P1 wires up here
  }

  // P3, criteria and AI analysis. Shows #analysis. Reads mission.cfg and scores against it.
  {
    // P3 wires up here
  }

  // Debug entry point
  window.__lln = { THREE, camera, controls, terrain, shadows, sky, bodies, post, eph, data, renderer, rig, sites, zones, mission, crater, station, rover, clock, setTime, groundAt, heightAt, go, enterRover, leaveRover, keys, get mode() { return mode; } };
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
