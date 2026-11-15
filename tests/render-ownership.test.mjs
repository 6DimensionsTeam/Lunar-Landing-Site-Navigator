import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
function section(start, end, from = 0) {
  const a = main.indexOf(start, from), b = main.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Source boundary missing: ${start}`);
  return main.slice(a, b);
}

// Exercise the real callbacks and ownership bookkeeping; replace only the
// expensive surface render with a recorder. This runs without a browser/GPU.
const nativeFrame = section('  function frame(t) {', '  // Low-frequency tasks:');
const resume = section('  const resumeFrame =', '  await B.finish();');
const p2Start = main.indexOf('  // P2, mission framing.');
const p2End = main.indexOf('  // P1, moon-surface site selection.', p2Start);
const gate = section('      const surfaceFrame = frame;', '      missionFlow.ready.catch', p2Start);
const descentStart = main.indexOf('    function descendTo(site, entry) {');
const p1Loop = section('      ownSurface = true;', '      flight = {', descentStart);
assert.ok(main.indexOf(gate) > p2Start && main.indexOf(gate) < p2End);

const createFixture = new Function('EventTarget', `
  const queue = new Map(), renders = [];
  let serial = 0, now = 0, mode = 'home', flight = null;
  let ownSurface = false, globeShown = false, surfaceStopped = false;
  const requestAnimationFrame = fn => { const id = ++serial; queue.set(id, fn); return id; };
  const performance = { now: () => now }, location = { search: '' };
  const document = Object.assign(new EventTarget(), {hidden:false}), window = new EventTarget();
  const root = Object.assign(new EventTarget(), {hidden:false, dataset:{}, classList:{contains:()=>false}});
  const hud = {screen:()=>root}, missionFlow = {stage:'boot'};
  const surfaceStep = t => {
    renders.push(t);
    if (flight && t >= flight.endsAt) { flight = null; mode = 'explore'; }
  };
  ${nativeFrame}
  ${resume}
  ${gate}
  return {
    renders, root, document, missionFlow,
    get pending() { return queue.size; },
    get stopped() { return surfaceStopped; },
    get ownSurface() { return ownSurface; },
    get mode() { return mode; },
    tick() { now += 16; const batch=[...queue.values()]; queue.clear(); for(const fn of batch) fn(now); },
    concealMission() { root.hidden=true; },
    showMap() { globeShown=true; ownSurface=false; },
    hideMap() { globeShown=false; resumeFrame(); },
    beginP1Descent() {
      globeShown=false; resumeFrame(); mode='fly'; flight={endsAt:now+2600};
      ${p1Loop}
    },
    beginHostFlight() {
      if(ownSurface) { ownSurface=false; surfaceStopped=true; resumeFrame(); }
      mode='fly'; flight={endsAt:now+7000};
    },
    resumeFrame,
  };
`);

function setup() {
  const f = createFixture(EventTarget);
  f.tick(); // Drain the frame scheduled before P2 installed its wrapper.
  f.renders.length = 0;
  return f;
}
function tickOnce(f, expectedRenders) {
  const before = f.renders.length;
  f.tick();
  assert.equal(f.renders.length - before, expectedRenders);
}

test('opaque P2 stages keep one callback and submit no surface renders', () => {
  const f = setup();
  for (const stage of ['boot', 'orbit', 'pad', 'flight']) {
    f.missionFlow.stage = stage;
    for (let n = 0; n < 8; n++) { tickOnce(f, 0); assert.equal(f.pending, 1); }
  }
});

test('map ownership stops the wrapper and native resume re-arms it exactly once', () => {
  const f = setup(); f.concealMission(); f.showMap();
  tickOnce(f, 0);
  assert.equal(f.stopped, true); assert.equal(f.pending, 0);
  f.hideMap(); f.resumeFrame();
  assert.equal(f.pending, 1);
  for (let n = 0; n < 12; n++) { tickOnce(f, 1); assert.equal(f.pending, 1); }
});

test('immediate map show/hide does not duplicate the still-running surface chain', () => {
  const f = setup(); f.concealMission(); f.showMap(); f.hideMap();
  for (let n = 0; n < 12; n++) { tickOnce(f, 1); assert.equal(f.pending, 1); }
});

test('P1 descent and free exploration own exactly one surface loop', () => {
  const f = setup(); f.concealMission(); f.showMap(); tickOnce(f, 0);
  f.beginP1Descent();
  for (let n = 0; n < 180; n++) { tickOnce(f, 1); assert.equal(f.pending, 1); }
  assert.equal(f.mode, 'explore'); assert.equal(f.ownSurface, true);
  assert.equal(f.stopped, true, 'the dormant wrapper must be eligible for native resume');
});

test('return to map followed by a second P1 descent neither freezes nor doubles rendering', () => {
  const f = setup(); f.concealMission(); f.beginP1Descent();
  for (let n = 0; n < 180; n++) tickOnce(f, 1);
  f.showMap(); tickOnce(f, 0); assert.equal(f.pending, 0);
  f.beginP1Descent();
  for (let n = 0; n < 180; n++) { tickOnce(f, 1); assert.equal(f.pending, 1); }
  assert.equal(f.mode, 'explore');
});

test('native host flight can take ownership back after P1 exploration', () => {
  const f = setup(); f.concealMission(); f.beginP1Descent();
  for (let n = 0; n < 180; n++) tickOnce(f, 1);
  f.beginHostFlight();
  for (let n = 0; n < 440; n++) { tickOnce(f, 1); assert.equal(f.pending, 1); }
  assert.equal(f.mode, 'explore'); assert.equal(f.ownSurface, false);
});
