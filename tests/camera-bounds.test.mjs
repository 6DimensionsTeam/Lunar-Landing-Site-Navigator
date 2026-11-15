import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector2, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { installCameraBounds } from '../src/camera-bounds.js';
import { mapToScene, sceneToMap } from '../src/geo.js';

const R = 1737.4;
function metadata(half = [30.72, 151.68, 457.44], min = 0, max = 0) {
  return Object.fromEntries(['hero', 'inner', 'outer'].map((name, i) => [name,
    { half_extent_m: half[i] * 1000, res_m: [40, 120, 480][i], size: 100, min_m: min * 1000, max_m: max * 1000 }]));
}
function element() {
  const doc = { addEventListener() {}, removeEventListener() {} };
  return { style: {}, clientWidth: 1280, clientHeight: 720, ownerDocument: doc, getRootNode: () => doc,
    addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }) };
}
function fixture({ tiles = metadata(), heightAt = () => 0, active = true, attach = true } = {}) {
  const state = { active }, camera = new PerspectiveCamera(42, 16 / 9, .05, 6000);
  camera.position.copy(mapToScene(R, new Vector2(0, -12), 3)); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const controls = new OrbitControls(camera, element()); controls.minDistance = 2; controls.maxDistance = 220;
  controls.enableDamping = true; controls.dampingFactor = .1; controls.maxPolarAngle = Math.PI * 88 / 180;
  const bounds = attach ? installCameraBounds({ camera, controls, tiles, radiusKm: R, heightAt, isActive: () => state.active }) : null;
  return { camera, controls, bounds, state, heightAt, cleanup() { bounds?.dispose(); controls.dispose(); } };
}
function safe(f, label = '') {
  const s = f.bounds.getSnapshot(), c = sceneToMap(R, f.camera.position), t = sceneToMap(R, f.controls.target);
  assert.ok(c.h >= f.heightAt(c.m) + .0005 - 1e-8, `${label}: floor ${s.clearanceKm}`);
  assert.ok(Math.max(Math.abs(c.m.x), Math.abs(c.m.y)) <= s.innerHalfKm + 1e-6, `${label}: camera domain`);
  assert.ok(Math.max(Math.abs(t.m.x), Math.abs(t.m.y)) <= s.innerHalfKm + 1e-6, `${label}: target domain`);
  assert.ok(f.camera.position.distanceTo(f.controls.target) <= f.controls.maxDistance + 1e-5, `${label}: distance ${s.distanceKm}/${s.maxDistanceKm}`);
  assert.ok(c.h <= s.horizonLimitKm + 1e-5, `${label}: horizon ${c.h}/${s.horizonLimitKm}`);
}

test('metadata and field of view determine bounds; no literal terrain extent', () => {
  const f = fixture({ tiles: metadata([12, 70, 220]) });
  f.bounds.enforce(); safe(f);
  assert.equal(f.bounds.getSnapshot().innerHalfKm, 69.76);
  const previous = f.controls.maxDistance;
  f.camera.aspect = 4; f.camera.updateProjectionMatrix(); f.bounds.enforce(); safe(f);
  assert.ok(f.controls.maxDistance < previous);
  f.cleanup();
});

test('all eight repeated pan directions and damping stay on covered terrain', () => {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const f = fixture(); f.bounds.enforce();
    for (let i = 0; i < 10; i++) { f.controls.pan(dx * 1e5, dy * 1e5); safe(f, `pan ${dx},${dy} ${i}`); }
    for (let i = 0; i < 80; i++) { f.controls.update(); safe(f, `damping ${dx},${dy} ${i}`); }
    f.cleanup();
  }
});

test('repeated extreme dolly in/out remains bounded at narrow and wide aspects', () => {
  for (const aspect of [.4, 16 / 9, 4]) {
    const f = fixture(); f.camera.aspect = aspect; f.camera.updateProjectionMatrix(); f.bounds.enforce();
    for (let i = 0; i < 35; i++) {
      f.controls.dollyIn(.05); safe(f, `dollyIn ${aspect}/${i}`);
      f.controls.dollyOut(.05); safe(f, `dollyOut ${aspect}/${i}`);
    }
    f.cleanup();
  }
});

test('below-ground positions and adjacent near-plane ridges are corrected', () => {
  const tiles = metadata(undefined, 0, 1); tiles.hero.res_m = 4;
  const heightAt = m => .8 * Math.exp(-((m.x - .025) ** 2 + (m.y - .05) ** 2) / .0004);
  const f = fixture({ tiles, heightAt });
  f.controls.target.copy(mapToScene(R, new Vector2(0, 2), 0));
  f.camera.position.copy(mapToScene(R, new Vector2(0, 0), -2)); f.camera.lookAt(f.controls.target);
  f.bounds.enforce(); safe(f);
  const tanY = Math.tan(f.camera.fov * Math.PI / 360), tanX = tanY * f.camera.aspect;
  for (let y = 0; y <= 16; y++) for (let x = 0; x <= 16; x++) {
    const p = new Vector3((x / 8 - 1) * f.camera.near * tanX, (y / 8 - 1) * f.camera.near * tanY, -f.camera.near)
      .applyQuaternion(f.camera.quaternion).add(f.camera.position);
    const q = sceneToMap(R, p);
    assert.ok(q.h >= heightAt(q.m) + .0005 - 1e-6, 'near-plane point must clear adjacent terrain');
  }
  f.cleanup();
});

test('hero to inner panning crosses the tile boundary without sticking', () => {
  const f = fixture(); f.bounds.enforce();
  let reached = 0;
  for (let x = 0; x <= 60; x += .5) {
    const h = sceneToMap(R, f.controls.target).h, old = f.controls.target.clone();
    f.controls.target.copy(mapToScene(R, new Vector2(x, 0), h));
    f.camera.position.add(f.controls.target.clone().sub(old)); f.controls.update(); safe(f, `cross ${x}`);
    reached = sceneToMap(R, f.controls.target).m.x;
  }
  assert.ok(reached > 59, `stuck at ${reached}`); assert.equal(f.bounds.getSnapshot().tile, 'inner'); f.cleanup();
});

test('inactive enforcement is an exact no-op and original control behavior is preserved', () => {
  const f = fixture({ active: false }), reference = fixture({ attach: false });
  for (let i = 0; i < 10; i++) {
    const before = JSON.stringify({ p: f.camera.position.toArray(), q: f.camera.quaternion.toArray(), t: f.controls.target.toArray(), min: f.controls.minDistance, max: f.controls.maxDistance });
    assert.equal(f.bounds.enforce(), false);
    assert.equal(JSON.stringify({ p: f.camera.position.toArray(), q: f.camera.quaternion.toArray(), t: f.controls.target.toArray(), min: f.controls.minDistance, max: f.controls.maxDistance }), before);
    f.controls.pan(500, 200); reference.controls.pan(500, 200);
    assert.deepEqual(f.camera.position.toArray(), reference.camera.position.toArray());
    assert.deepEqual(f.controls.target.toArray(), reference.controls.target.toArray());
    assert.equal(f.controls.update(), reference.controls.update());
  }
  assert.equal(f.bounds.getSnapshot().stats.heightSamples, 0); f.cleanup(); reference.cleanup();
});

test('disposal restores only owned methods and leaves later mode limits alone', () => {
  const f = fixture(), wrapped = f.controls.update; f.bounds.enforce();
  f.controls.minDistance = .06; f.controls.maxDistance = 1.2; f.state.active = false; f.bounds.dispose();
  assert.notEqual(f.controls.update, wrapped); assert.equal(f.controls.minDistance, .06); assert.equal(f.controls.maxDistance, 1.2); f.controls.dispose();
});

test('disabled controls add no clamp even if the supplied mode predicate is true', () => {
  const f = fixture(); f.controls.enabled = false;
  f.camera.position.set(900, -200, 600);
  const before = f.camera.position.toArray(), target = f.controls.target.toArray();
  assert.equal(f.bounds.enforce(), false);
  assert.deepEqual(f.camera.position.toArray(), before); assert.deepEqual(f.controls.target.toArray(), target);
  assert.equal(f.bounds.getSnapshot().stats.heightSamples, 0); f.cleanup();
});
