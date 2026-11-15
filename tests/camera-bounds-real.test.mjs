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
    style: {}, ownerDocument: document, getRootNode: () => document,
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
  assert.ok(camera.position.distanceTo(controls.target) <= controls.maxDistance + 1e-6, `${label}: zoom maximum`);
  assert.ok(camera.position.distanceTo(controls.target) >= controls.minDistance - 1e-6, `${label}: zoom minimum`);
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
