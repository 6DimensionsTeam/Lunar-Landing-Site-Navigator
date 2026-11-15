import assert from 'node:assert/strict';
import test from 'node:test';
import { MathUtils, PerspectiveCamera, Vector2, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { installCameraBounds } from '../src/camera-bounds.js';
import { latLonToMap, mapToScene, sceneToMap } from '../src/geo.js';
import { loadTerrainFixture } from './fixtures/terrain.js';

const terrain = await loadTerrainFixture();
function createView({ aspect = 16 / 9, site = null, bounded = true } = {}) {
  const camera = new PerspectiveCamera(40, aspect, .05, 4000);
  const document = new EventTarget();
  const element = Object.assign(new EventTarget(), {
    style: {}, clientWidth: 1280, clientHeight: 720, ownerDocument: document, getRootNode: () => document,
  });
  const controls = new OrbitControls(camera, element);
  Object.assign(controls, {
    minDistance: 2, maxDistance: 220, maxPolarAngle: MathUtils.degToRad(88),
    enableDamping: true, dampingFactor: .06,
  });
  const rig = terrain.createRig(camera);
  const pose = site ? rig.landing(aspect, latLonToMap(terrain.R, site.lat, site.lon)) : rig.landing(aspect);
  rig.apply(pose); controls.target.copy(pose.target);
  let active = true;
  const bounds = bounded ? installCameraBounds({
    camera, controls, tiles: terrain.tiles, radiusKm: terrain.R,
    heightAt: terrain.heightAt, isActive: () => active,
  }) : null;
  return { camera, controls, pose, bounds,
    set active(value) { active = value; },
    dispose() { bounds?.dispose(); controls.dispose(); },
  };
}

function assertSafe(view, label) {
  const { camera, controls, bounds } = view, snapshot = bounds.getSnapshot();
  const cameraMap = sceneToMap(terrain.R, camera.position);
  assert.ok(camera.position.toArray().every(Number.isFinite), `${label}: finite camera`);
  assert.ok(controls.target.toArray().every(Number.isFinite), `${label}: finite target`);
  assert.ok(camera.position.distanceTo(controls.target) <= controls.maxDistance + 1e-7, `${label}: zoom maximum`);
  assert.ok(camera.position.distanceTo(controls.target) >= controls.minDistance - 1e-7, `${label}: zoom minimum`);
  assert.ok(Math.abs(cameraMap.m.x) <= snapshot.innerHalfKm && Math.abs(cameraMap.m.y) <= snapshot.innerHalfKm, `${label}: camera remains over inner coverage`);
  assert.ok(snapshot.targetMapKm.every(n => Math.abs(n) <= snapshot.innerHalfKm), `${label}: target remains in coverage`);
  assert.ok(cameraMap.h <= snapshot.horizonLimitKm + 1e-6, `${label}: horizon stays inside measured outer coverage`);
  const tanY = Math.tan(MathUtils.degToRad(camera.getEffectiveFOV()) / 2), tanX = tanY * camera.aspect;
  // Independently check a denser 9x9 near-plane grid than the production guard
  // needs at this 50 m near distance; use the actual decoded height sampler.
  for (let row = 0; row <= 8; row++) for (let column = 0; column <= 8; column++) {
    const point = new Vector3((column / 4 - 1) * camera.near * tanX,
      (row / 4 - 1) * camera.near * tanY, -camera.near).applyQuaternion(camera.quaternion).add(camera.position);
    const sample = sceneToMap(terrain.R, point);
    assert.ok(sample.h >= terrain.heightAt(sample.m) + .0005 - 1e-6, `${label}: near-plane terrain clearance`);
  }
}

test('initial landing and all four real candidate sites preserve the existing controls handover', () => {
  for (const aspect of [16 / 9, 9 / 19.5, 4]) for (const site of [null, ...terrain.sites]) {
    const reference = createView({ aspect, site, bounded: false });
    const view = createView({ aspect, site });
    try {
      reference.controls.update(); view.controls.update();
      const label = `${site?.id ?? 'initial'} aspect ${aspect}`;
      assert.ok(view.camera.position.distanceTo(reference.camera.position) < 1e-6, `${label}: guard adds no landing jump`);
      assert.ok(view.controls.target.distanceTo(reference.controls.target) < 1e-6, `${label}: landing target stays fixed`);
      assertSafe(view, label);
    } finally { reference.dispose(); view.dispose(); }
  }
});

test('site D remains accessible at 123 km from the pole instead of being clipped to the hero tile', () => {
  const site = terrain.sites.find(site => site.id === 'D');
  assert.ok(site);
  const view = createView({ site });
  try {
    view.controls.update(); const snapshot = view.bounds.getSnapshot();
    assert.equal(snapshot.tile, 'inner');
    assert.ok(Math.hypot(...snapshot.targetMapKm) > 120);
    assert.ok(snapshot.maxDistanceKm > 17);
    assertSafe(view, 'site D');
  } finally { view.dispose(); }
});

test('real terrain pan and zoom stress obeys clearance, distance and horizon bounds after every update', () => {
  for (const site of [null, terrain.sites.find(site => site.id === 'D')]) {
    const view = createView({ site, aspect: 3 });
    try {
      view.controls.update();
      for (let step = 0; step < 120; step++) {
        const targetMap = new Vector2(Math.sin(step * .71) * 195, Math.cos(step * .47) * 195);
        const nextTarget = mapToScene(terrain.R, targetMap, terrain.heightAt(targetMap) + .4);
        const offset = view.camera.position.clone().sub(view.controls.target).normalize();
        const requestedDistance = [0.001, 2, 17, 80, 220, 500][step % 6];
        view.controls.target.copy(nextTarget);
        view.camera.position.copy(nextTarget).addScaledVector(offset, requestedDistance);
        view.controls.update();
        assertSafe(view, `${site?.id ?? 'initial'} stress ${step}`);
      }
    } finally { view.dispose(); }
  }
});

test('1,000 idle updates reuse cached terrain checks; 200 active pans have a bounded sampling budget', t => {
  const view = createView();
  try {
    for (let i = 0; i < 20; i++) view.controls.update();
    const beforeIdle = view.bounds.getSnapshot().stats;
    const idleStart = performance.now();
    for (let i = 0; i < 1000; i++) view.controls.update();
    const idleMs = performance.now() - idleStart, afterIdle = view.bounds.getSnapshot().stats;
    assert.equal(afterIdle.evaluations, beforeIdle.evaluations, 'idle OrbitControls roundoff must not resample terrain');
    assert.equal(afterIdle.heightSamples, beforeIdle.heightSamples);
    const activeStart = performance.now();
    for (let i = 0; i < 200; i++) {
      const delta = new Vector3(.07, 0, -.05);
      view.controls.target.add(delta); view.camera.position.add(delta); view.controls.update();
    }
    const activeMs = performance.now() - activeStart, afterActive = view.bounds.getSnapshot().stats;
    assert.ok(afterActive.evaluations - afterIdle.evaluations >= 200, 'real pans must be checked');
    assert.ok(afterActive.evaluations - afterIdle.evaluations <= 600, 'event and update hooks must stay bounded');
    assert.ok(afterActive.heightSamples - afterIdle.heightSamples <= 40000, 'ordinary pans must not trigger unbounded scans');
    assertSafe(view, 'after200 pans');
    t.diagnostic(JSON.stringify({ idleUpdates: 1000, idleMs, activePans: 200, activeMs,
      activeEvaluations: afterActive.evaluations - afterIdle.evaluations,
      activeHeightSamples: afterActive.heightSamples - afterIdle.heightSamples }));
  } finally { view.dispose(); }
});

test('inactive flight, home or globe ownership delegates controls without terrain correction', () => {
  const view = createView(), reference = createView({ bounded: false });
  try {
    view.active = false;
    for (const v of [view, reference]) {
      v.controls.target.set(220, 0, 200); v.camera.position.set(220, -10, 200);
      v.controls.update();
    }
    assert.equal(view.bounds.getSnapshot().stats.evaluations, 0);
    assert.ok(view.camera.position.distanceTo(reference.camera.position) < 1e-10);
    assert.ok(view.controls.target.distanceTo(reference.controls.target) < 1e-10);
  } finally { view.dispose(); reference.dispose(); }
});

test('browser regression: extreme public pan, dolly, rotate and damping converge within 0.1 mm', t => {
  const view = createView({ site: terrain.sites.find(site => site.id === 'A') });
  const { controls, camera } = view;
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  let samples = 0, maximumOvershootKm = 0;
  const check = label => {
    const overshoot = camera.position.distanceTo(controls.target) - controls.maxDistance;
    samples++; maximumOvershootKm = Math.max(maximumOvershootKm, overshoot);
    assert.ok(overshoot <= 1e-7, `${label}: distance overshoot ${overshoot} km`);
    assertSafe(view, label);
  };
  const settle = label => { for (let frame = 0; frame < 3; frame++) { controls.update(); check(`${label}, damping ${frame + 1}`); } };
  try {
    for (let i = 0; i < 5; i++) controls.update();
    controls.saveState();
    for (let azimuth = 0; azimuth < 4; azimuth++) {
      controls.reset(); controls.rotateLeft(azimuth * Math.PI / 2); check(`azimuth ${azimuth}`);
      for (const [x, y] of directions) {
        const label = `azimuth ${azimuth}, pan ${x},${y}`;
        for (let repeat = 0; repeat < 3; repeat++) { controls.pan(x * 100000, y * 100000); check(`${label}, step ${repeat + 1}`); }
        settle(label);
      }
      controls.dollyIn(.00001); check('extreme zoom in'); settle('zoom in');
      controls.dollyOut(.00001); check('extreme zoom out'); settle('zoom out');
      controls.rotateUp(Math.PI * 4); check('rotate above'); settle('rotate above');
      controls.rotateUp(-Math.PI * 8); check('rotate below'); settle('rotate below');
    }
    controls.dollyOut(.00001); settle('final boundary');
    t.diagnostic(JSON.stringify({ samples, maximumOvershootKm, toleranceKm: 1e-7 }));
  } finally { view.dispose(); }
});

test('immediate external landing and station handoffs discard old pan momentum without clamping flight', () => {
  const siteA = terrain.sites.find(site => site.id === 'A'), siteD = terrain.sites.find(site => site.id === 'D');
  for (const pixels of [20, 100000]) for (const destination of ['site D', 'site A', 'station']) {
    const view = createView({ site: siteA });
    const reference = createView({ site: destination === 'site D' ? siteD : siteA, bounded: false });
    try {
      view.controls.update(); view.controls.pan(pixels, pixels);
      view.controls.enabled = false; view.active = false;
      const rig = terrain.createRig(view.camera);
      const pose = destination === 'station' ? rig.orbit(view.camera.aspect, rig.stationPlacement())
        : rig.landing(view.camera.aspect, latLonToMap(terrain.R, (destination === 'site D' ? siteD : siteA).lat, (destination === 'site D' ? siteD : siteA).lon));
      rig.apply(pose);
      const flightPose = view.camera.position.toArray();
      assert.equal(view.bounds.enforce(), false, 'disabled external flight is never terrain-clamped');
      assert.deepEqual(view.camera.position.toArray(), flightPose);
      for (const candidate of [view, reference]) {
        candidate.camera.position.copy(pose.pos); candidate.camera.quaternion.copy(pose.quat); candidate.camera.fov = pose.fov; candidate.camera.updateProjectionMatrix();
        candidate.controls.target.copy(pose.target); candidate.controls.enabled = true;
        Object.assign(candidate.controls, destination === 'station'
          ? { minDistance: .06, maxDistance: 1.2, maxPolarAngle: MathUtils.degToRad(150), autoRotate: true, autoRotateSpeed: .25 }
          : { minDistance: 2, maxDistance: 220, maxPolarAngle: MathUtils.degToRad(88), autoRotate: false });
      }
      view.active = destination !== 'station';
      reference.controls.update(); view.controls.update();
      const label = `${pixels}px pan followed immediately by ${destination}`;
      assert.ok(view.controls.target.distanceTo(reference.controls.target) < 1e-6, `${label}: no stale target drift`);
      assert.ok(view.camera.position.distanceTo(reference.camera.position) < 1e-6, `${label}: no stale camera drift`);
    } finally { view.dispose(); reference.dispose(); }
  }
});

test('ordinary in-bounds damping is preserved and boundary flushing keeps public state and events intact', () => {
  const site = terrain.sites.find(site => site.id === 'A');
  const view = createView({ site }), reference = createView({ site, bounded: false });
  try {
    for (const candidate of [view, reference]) { candidate.controls.update(); candidate.controls.pan(2, 1); }
    for (let frame = 0; frame < 30; frame++) {
      view.controls.update(); reference.controls.update();
      assert.ok(view.camera.position.distanceTo(reference.camera.position) < 1e-6, `ordinary damping camera frame ${frame}`);
      assert.ok(view.controls.target.distanceTo(reference.controls.target) < 1e-6, `ordinary damping target frame ${frame}`);
    }
    const controls = view.controls; controls.saveState();
    const state = controls.state, dispatch = controls.dispatchEvent;
    const savedPosition = controls.position0.clone(), savedTarget = controls.target0.clone(), savedZoom = controls.zoom0;
    let changes = 0;
    controls.addEventListener('change', () => { changes++; assertSafe(view, 'published change event'); });
    controls.pan(100000, 100000);
    assert.equal(changes, 1, 'temporary flush poses must never emit additional change events');
    assert.equal(controls.state, state); assert.equal(controls.dispatchEvent, dispatch);
    assert.deepEqual(controls.position0.toArray(), savedPosition.toArray());
    assert.deepEqual(controls.target0.toArray(), savedTarget.toArray()); assert.equal(controls.zoom0, savedZoom);
    const targetAtBoundary = controls.target.clone(), cameraAtBoundary = view.camera.position.clone();
    controls.update();
    assert.ok(controls.target.distanceTo(targetAtBoundary) < 1e-6, 'clamped pan has no lingering target velocity');
    assert.ok(view.camera.position.distanceTo(cameraAtBoundary) < 1e-6, 'clamped pan has no lingering camera velocity');
  } finally { view.dispose(); reference.dispose(); }
});
