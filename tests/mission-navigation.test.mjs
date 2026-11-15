import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { candidatePool } from '../src/rank.js';
import { catalogFeedback } from '../src/mission.js';

const source = await readFile(new URL('../src/mission.js', import.meta.url), 'utf8');
const extract = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing source boundary: ${start}`);
  return source.slice(a, b);
};
const markup = extract('const markup = `', 'export function createMission');
const steps = [...markup.matchAll(/<li data-step="([^"]+)"[^>]*><b>(\d+)<\/b>/g)];
const phases = ['intro', 'orbit', 'pad', 'flight', 'handoff'];

class Element extends EventTarget {
  constructor() {
    super();
    this.dataset = {}; this.attributes = new Map(); this.children = [];
    this.hidden = false; this.disabled = false; this.textContent = '';
    this.style = { setProperty() {} };
    const classes = new Set();
    this.classList = {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name), remove: name => classes.delete(name),
    };
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  load() {}
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function uiFixture() {
  const elements = new Map();
  return name => {
    if (!elements.has(name)) elements.set(name, new Element());
    return elements.get(name);
  };
}

function progressFixture() {
  const ui = uiFixture(), records = phases.map(name => {
    const element = new Element(); element.dataset.step = name; return element;
  });
  const views = phases.slice(0, 4).map(name => {
    const element = new Element(); element.dataset.view = name; return element;
  });
  const root = new Element();
  root.querySelectorAll = selector => selector === '[data-step]' ? records : views;
  const pause = deferred(), deliveries = [];
  const code = new Function('root', 'ui', 'pausePromise', 'deliveries', `
    let stage='boot', transitioning=false, filmPreloaded=false, completed=false, disposed=false, transitionToken=0;
    const existing=true, pause=()=>pausePromise, film={cancel(){}}, onMissionReady=cfg=>deliveries.push(cfg);
    class CustomEvent extends Event { constructor(type, options) { super(type); this.detail=options.detail; } }
    ${extract('  function updateSteps(next)', '  async function setStage(next)')}
    ${extract('  async function finishMission(config)', '  function restart()')}
    return {applyStage,finishMission,get stage(){return stage;}};
  `);
  return { records, root, pause, deliveries, ...code(root, ui, pause.promise, deliveries) };
}

test('progress is an ordered five-step navigation with one current step through the handoff', () => {
  assert.match(markup, /<nav aria-label="Mission progress"><ol class="p2-steps">/);
  assert.deepEqual(steps.map(match => match[1]), phases);
  assert.deepEqual(steps.map(match => match[2]), ['01', '02', '03', '04', '05']);
  const f = progressFixture();
  for (const phase of phases) {
    f.applyStage(phase);
    assert.equal(f.records.filter(el => el.getAttribute('aria-current') === 'step').length, 1);
    assert.equal(f.records.find(el => el.getAttribute('aria-current') === 'step').dataset.step, phase);
    assert.equal(f.records.filter(el => el.classList.contains('complete')).length, phases.indexOf(phase));
  }
  f.applyStage('intro');
  assert.equal(f.records.filter(el => el.classList.contains('complete')).length, 0, 'restart clears completed steps');
});

test('real finish handler activates selection before fading and forwards the original configuration once', async () => {
  const f = progressFixture(); f.applyStage('flight');
  const config = Object.freeze({ arriveH: 24060, launchH: 23976, stayH: 168, needs: Object.freeze({ maxDarkH: 72 }) });
  const completion = f.finishMission(config);
  assert.equal(f.records.find(el => el.getAttribute('aria-current') === 'step').dataset.step, 'handoff');
  assert.deepEqual(f.deliveries, [], 'the native handoff waits for the existing fade');
  f.pause.resolve(); await completion; await f.finishMission(config);
  assert.equal(f.root.dataset.stage, 'handoff');
  assert.equal(f.deliveries.length, 1); assert.strictEqual(f.deliveries[0], config);
});

function navigationFixture() {
  const ui = uiFixture(), handlers = new Map(), stages = [], pending = deferred();
  const config = Object.freeze({ arriveH: 24060, stayH: 168, needs: Object.freeze({ iceNearby: true }) });
  let recenterCalls = 0;
  const transit = { recenterOrbit() { recenterCalls++; return pending.promise; } };
  const code = new Function('ui', 'handlers', 'stages', 'transit', 'config', `
    let stage='orbit', transitioning=false, recentering=false, disposed=false, currentConfig=config;
    const listen=(element,event,fn)=>handlers.set(element,fn), setStage=next=>stages.push(next);
    ${extract("  listen(ui('configure-mission')", "  listen(ui('back-orbit')")}
    return {get config(){return currentConfig;},setMode(value){stage=value;},dispose(){disposed=true;}};
  `);
  const api = code(ui, handlers, stages, transit, config);
  return { ui, stages, pending, config, api, get recenterCalls() { return recenterCalls; },
    click: name => handlers.get(ui(name))() };
}

test('fixed Configure mission control stays usable when the projected launch anchor is hidden', () => {
  assert.match(markup, /<button[^>]+data-ui="configure-mission"[^>]+type="button"/);
  const f = navigationFixture(); f.ui('launch-marker').hidden = true;
  f.click('configure-mission');
  assert.deepEqual(f.stages, ['pad']); assert.equal(f.recenterCalls, 0);
});

test('recenter is single-flight and preserves mission configuration and mode', async () => {
  const f = navigationFixture(), before = JSON.stringify(f.config);
  const action = f.click('recenter-orbit');
  assert.equal(f.ui('recenter-orbit').disabled, true);
  await f.click('recenter-orbit'); assert.equal(f.recenterCalls, 1);
  f.pending.resolve({ cancelled: false }); await action;
  assert.equal(f.ui('recenter-orbit').disabled, false);
  assert.ok(f.ui('flight-status').textContent.length > 0, 'successful recenter has an accessible status');
  assert.deepEqual(f.stages, []); assert.strictEqual(f.api.config, f.config);
  assert.equal(JSON.stringify(f.config), before);
});

for (const end of ['cancel', 'leave orbit', 'dispose']) {
  test(`recenter ${end} does not announce success, navigate, or change the mission`, async () => {
    const f = navigationFixture(); f.ui('flight-status').textContent = 'Previous status';
    const action = f.click('recenter-orbit');
    if (end === 'leave orbit') f.api.setMode('pad');
    if (end === 'dispose') f.api.dispose();
    f.pending.resolve({ cancelled: end === 'cancel' }); await action;
    assert.equal(f.ui('flight-status').textContent, 'Previous status');
    assert.deepEqual(f.stages, []); assert.strictEqual(f.api.config, f.config);
    if (end !== 'dispose') assert.equal(f.ui('recenter-orbit').disabled, false);
    if (end !== 'cancel') { await f.click('recenter-orbit'); assert.equal(f.recenterCalls, 1); }
  });
}

test('actual candidate total includes data-selected sites while bars and darkness remain named-region references', async () => {
  const [catalog, found] = await Promise.all([
    readFile(new URL('../src/data/sites.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../src/data/candidates.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const candidates = candidatePool({ sites: catalog, candidates: found });
  assert.equal(candidates.length, catalog.sites.length + found.candidates.length);
  // The pool size is a measured outcome of the pre-selection bar, not a constant; what must hold
  // is that every data site in it actually clears that bar.
  assert.ok(found.candidates.every(c => c.stats.longest_dark_h <= found.selection.max_dark_h),
    'every pre-selected data site clears the survivability bar');
  assert.equal(catalog.sites.length, 4, 'the named NASA reference catalogue is a separate four-region subset');
  const ui = uiFixture(), document = { createElement: () => new Element() };
  new Function('ui', 'document', 'catalog', 'candidates', `
    const eph={stepH:3,count:43832},bounds={label:'2026–2040'},countLabel=String;
    ${extract("  ui('ephem-step').textContent", "  ui('arrival-date').min")}
  `)(ui, document, catalog, candidates);
  assert.match(ui('catalog-count').textContent, new RegExp(`\\b${candidates.length}\\b`));
  assert.match(ui('candidate-intro').textContent, new RegExp(`\\b${candidates.length}\\b`));
  assert.equal(ui('catalog-bars').children.length, catalog.sites.length);
  assert.match(markup, /NASA region reference/);
  assert.match(ui('catalog-period').textContent, /NASA regions/);
  assert.match(ui('catalog-period').textContent, /data-selected/);

  const needElements = new Map(['craterFloor', 'iceNearby', 'continuousComm'].map(name => [name, new Element()]));
  const root = { querySelector: selector => needElements.get(selector.match(/data-need="([^"]+)"/)[1]) };
  const update = new Function('root', 'ui', 'document', 'catalog', 'catalogFeedback', `
    ${extract('  function updateCandidates(needs)', '  function positionAnchor(')}
    return updateCandidates;
  `)(root, ui, document, catalog, catalogFeedback);
  update({ maxDarkH: 72, craterFloor: true, iceNearby: true, continuousComm: true });
  assert.equal(ui('dark-scale').children.length, catalog.sites.length + 1, 'only reference marks and the requested-limit cursor');
  assert.match(ui('candidate-feedback').children[1].textContent, /NASA region reference/);
  assert.match(ui('candidate-feedback').children[1].textContent, /not a result for your selected stay/);
  for (const element of needElements.values()) assert.equal(element.textContent, 'PENDING ANALYSIS');
});
