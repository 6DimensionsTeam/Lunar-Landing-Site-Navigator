import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Three from 'three';
import { Ephemeris } from '../src/ephemeris.js';

const sourceURL = new URL('../src/scene/transit.js', import.meta.url);
const [sourceText, binary, ephemMeta, terrainMeta] = await Promise.all([
  readFile(process.env.LLN_TRANSIT_TEST_SOURCE || sourceURL, 'utf8'), readFile(new URL('../src/data/ephem.bin', import.meta.url)),
  readFile(new URL('../src/data/ephem.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/data/terrain.json', import.meta.url), 'utf8').then(JSON.parse),
]);
const samples = new Float32Array(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
const radiusKm = terrainMeta.radius_m / 1000;
let activeEnv;
class TestCamera extends Three.PerspectiveCamera { constructor(...args) { super(...args); activeEnv.camera = this; } }
class TestRenderer {
  constructor() { this.capabilities = { maxTextureSize: 4096, getMaxAnisotropy: () => 4 }; this.shadowMap = {}; this.info = { render: { calls: 0, triangles: 0 } }; this.ratio = 1; }
  setClearColor() {} setSize() {} compile() {} render() {} dispose() {}
  setPixelRatio(value) { this.ratio = value; } getPixelRatio() { return this.ratio; }
}
class TestTextureLoader { async loadAsync() { const texture = new Three.Texture(); texture.image = { width: 2048, height: 1024 }; return texture; } }
globalThis.__transitRecenterTypes = { ...Three, PerspectiveCamera: TestCamera, WebGLRenderer: TestRenderer, TextureLoader: TestTextureLoader };
// Keep the real camera, scene geometry, ephemeris and transition code. Stub only
// GPU/DOM asset construction so this lifecycle regression also runs in Node.
let source = sourceText.slice(0, sourceText.indexOf('// Original SLS-inspired'))
  .replace("import * as T from 'three';", 'const T = globalThis.__transitRecenterTypes;')
  .replace("'../ephemeris.js'", JSON.stringify(new URL('../src/ephemeris.js', import.meta.url).href))
  .replace("'./trajectory.js'", JSON.stringify(new URL('../src/scene/trajectory.js', import.meta.url).href))
  .replace("import { createAscentEnvironment } from './ascent-environment.js';", 'const createAscentEnvironment = () => ({group:new T.Group(),update(){}});')
  .replace("import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';", '')
  .replace(/const MOON_ALBEDO_URL = [^\n]+/, "const MOON_ALBEDO_URL = 'data:image/jpeg;base64,AA==';")
  .replace('const launch = createLaunchComplex(T);', 'const launch = {group:new T.Group(),cameraPosition:new T.Vector3(113,62,151),cameraTarget:new T.Vector3(-11,43,0),reset(){},animate(){}};')
  .replaceAll('import.meta.url', JSON.stringify(sourceURL.href));
const { createTransit } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
delete globalThis.__transitRecenterTypes;

async function fixture(reduced = false) {
  const env = { now: 0, frames: new Map(), nextFrame: 0, transitions: [], anchors: [], transfers: [], root: { hidden: false } };
  activeEnv = env;
  env.canvas = { clientWidth: 1280, clientHeight: 720, hidden: false, closest: () => env.root };
  env.document = Object.assign(new EventTarget(), { hidden: false });
  const replacements = { performance: { now: () => env.now }, window: new EventTarget(), document: env.document,
    devicePixelRatio: 1, matchMedia: () => ({ matches: reduced }), ResizeObserver: undefined,
    requestAnimationFrame: fn => { const id = ++env.nextFrame; env.frames.set(id, fn); return id; },
    cancelAnimationFrame: id => env.frames.delete(id) };
  const originals = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const eph = new Ephemeris(samples, ephemMeta, radiusKm);
  env.h = (Date.parse('2028-07-01T00:00:00Z') - eph.start) / 3600e3;
  env.transit = await createTransit({ canvas: env.canvas, eph, data: { ephem: samples, ephemMeta, radiusKm },
    onTransition: value => env.transitions.push(value), onAnchors: value => env.anchors.push(value), onTransfer: value => env.transfers.push(value) });
  env.advance = ms => { env.now += ms; const pending = [...env.frames.values()]; env.frames.clear(); pending.forEach(frame => frame(env.now)); };
  env.run = ms => { for (let elapsed = 0; elapsed < ms; elapsed += 25) env.advance(Math.min(25, ms - elapsed)); };
  env.open = async () => { const ready = env.transit.show('orbit', env.h); env.run(reduced ? 0 : 1000); await ready; };
  env.close = () => { env.transit.dispose(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } };
  return env;
}

test('recenter restores Earth, Moon and launch framing while preserving mission data and preview time', async () => {
  const env = await fixture();
  try {
    await env.open(); env.run(4000);
    const previous = env.transit.getGeometrySnapshot(), canonical = env.camera.position.clone(), transferCount = env.transfers.length;
    env.camera.position.add(new Three.Vector3(1000, 500, -900)); env.camera.fov = 12; env.camera.zoom = 5; env.camera.updateProjectionMatrix();
    const displaced = env.camera.position.clone(), scheduled = env.nextFrame;
    const done = env.transit.recenterOrbit();
    assert.equal(env.nextFrame, scheduled, 'recenter must use the existing render chain');
    assert.equal(env.transit.getGeometrySnapshot().transitioning, true);
    env.run(400); assert.ok(env.camera.position.distanceTo(canonical) < displaced.distanceTo(canonical));
    env.run(450); assert.deepEqual(await done, { stage: 'orbit', cancelled: false });
    assert.ok(env.camera.position.distanceTo(canonical) < 1e-9); assert.equal(env.camera.fov, 42); assert.equal(env.camera.zoom, 1);
    const after = env.transit.getGeometrySnapshot();
    for (const key of ['displayH', 'earthPos', 'sunDir', 'moonPosition', 'earthRotation', 'moonRotation', 'endpointErrorKm']) assert.deepEqual(after[key], previous[key]);
    assert.equal(env.transfers.length, transferCount, 'recenter must not solve or replace the transfer');
    assert.ok(after.previewProgress > previous.previewProgress, 'the preview clock must continue instead of restarting');
    const anchors = env.anchors.at(-1); assert.ok(anchors.earth.visible && anchors.moon.visible && anchors.launch.visible);
    assert.equal(env.transitions.at(-1).phase, 'complete'); assert.equal(env.frames.size, 1);
  } finally { env.close(); }
});

test('reduced motion recenters immediately and invalid stages remain unchanged', async () => {
  const env = await fixture(true);
  try {
    assert.deepEqual(await env.transit.recenterOrbit(), { stage: 'orbit', cancelled: true });
    await env.open(); const canonical = env.camera.position.clone(); env.camera.position.multiplyScalar(20);
    assert.deepEqual(await env.transit.recenterOrbit(), { stage: 'orbit', cancelled: false });
    assert.ok(env.camera.position.distanceTo(canonical) < 1e-9); assert.equal(env.transit.getGeometrySnapshot().transitioning, false);
    await env.transit.show('pad', env.h); const pad = env.transit.getGeometrySnapshot();
    assert.deepEqual(await env.transit.recenterOrbit(), { stage: 'pad', cancelled: true }); assert.deepEqual(env.transit.getGeometrySnapshot(), pad);
    env.transit.dispose(); assert.deepEqual(await env.transit.recenterOrbit(), { stage: 'pad', cancelled: true });
  } finally { env.close(); }
});

test('overlapping reset, screen departure and disposal settle pending recenter promises', async () => {
  const env = await fixture();
  try {
    await env.open();
    const first = env.transit.recenterOrbit(); env.run(200); const second = env.transit.recenterOrbit();
    assert.equal((await first).cancelled, true); env.run(850); assert.equal((await second).cancelled, false);
    const hidden = env.transit.recenterOrbit(); env.canvas.hidden = true; env.advance(25);
    assert.equal((await hidden).cancelled, true); assert.equal(env.transit.getGeometrySnapshot().transitioning, false);
    assert.equal((await env.transit.recenterOrbit()).cancelled, true); env.canvas.hidden = false;
    const disposed = env.transit.recenterOrbit(); env.transit.dispose(); assert.equal((await disposed).cancelled, true); assert.equal(env.frames.size, 0);
  } finally { env.close(); }
});

test('background-tab pauses resume and pad-visible transitions cannot be hijacked', async () => {
  const env = await fixture();
  try {
    await env.open(); const done = env.transit.recenterOrbit(); env.run(200);
    env.document.hidden = true; env.document.dispatchEvent(new Event('visibilitychange')); env.run(1000);
    assert.equal(env.transit.getGeometrySnapshot().transitioning, true);
    env.document.hidden = false; env.document.dispatchEvent(new Event('visibilitychange')); env.run(700);
    assert.equal((await done).cancelled, false);
    const pad = env.transit.show('pad', env.h); env.run(1600); await pad;
    const orbit = env.transit.show('orbit', env.h);
    assert.equal((await env.transit.recenterOrbit()).cancelled, true);
    env.run(1600); assert.equal((await orbit).cancelled, false); assert.ok(env.anchors.at(-1).launch.visible);
  } finally { env.close(); }
});
