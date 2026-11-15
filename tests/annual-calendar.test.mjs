import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { createZones } from '../src/zones.js';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const p2Start = main.indexOf('  // P2, mission framing.');
const p1Start = main.indexOf('  // P1, moon-surface site selection.', p2Start);
assert.ok(p2Start >= 0 && p1Start > p2Start);
const mount = main.slice(p2Start, p1Start);

test('calendar wiring reads current mission/year lazily and never replaces the P1 mission handler', () => {
  const start = mount.indexOf('createAnnualCalendar({');
  const end = mount.indexOf('});', start);
  assert.ok(start >= 0 && end > start, 'annual calendar is mounted in P2');
  assert.doesNotMatch(mount, /mission\.onMission\s*\(/);
  const root = {}, data = {}, zones = {};
  const mission = { cfg: { arriveH: 100 } };
  let h = 1, options;
  const eph = { hoursToDate(value) { return new Date(Date.UTC(2026 + value, 0, 1)); } };
  const hud = { screen(name) { assert.equal(name, 'select'); return root; } };
  new Function('createAnnualCalendar', 'hud', 'data', 'zones', 'eph', 'mission', 'nowH',
    mount.slice(start, end + 3))(
    value => { options = value; }, hud, data, zones, eph, mission, () => h);
  assert.strictEqual(options.root, root); assert.strictEqual(options.data, data);
  assert.strictEqual(options.zones, zones); assert.strictEqual(options.eph, eph);
  assert.strictEqual(options.getMission(), mission.cfg); assert.equal(options.getYear(), 2027);
  const next = { arriveH: 300, needs: { maxDarkH: 216 } };
  mission.cfg = next; h = 14;
  assert.strictEqual(options.getMission(), next); assert.equal(options.getYear(), 2040);
});

test('native mission.ready retains the exact payload and current upstream running-clock contract', () => {
  const start = main.indexOf('  const mission = {');
  assert.ok(start >= 0 && start < p2Start);
  const clock = [], deliveries = [], fallback = [];
  const mission = new Function('setTime', 'go', `${main.slice(start, p2Start)}; return mission;`)(
    (...args) => clock.push(args), name => fallback.push(name));
  const config = Object.freeze({
    arriveH: 24060, launchH: 23976, stayH: 168,
    needs: Object.freeze({ craterFloor: false, iceNearby: true, continuousComm: false, maxDarkH: 216 }),
  });
  mission.onMission(value => deliveries.push(value)); mission.ready(config);
  assert.strictEqual(mission.cfg, config); assert.strictEqual(deliveries[0], config);
  assert.deepEqual(clock, [[config.arriveH, 1]]); assert.deepEqual(fallback, []);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(Object.keys(config), ['arriveH', 'launchH', 'stayH', 'needs']);
  assert.deepEqual(Object.keys(config.needs), ['craterFloor', 'iceNearby', 'continuousComm', 'maxDarkH']);
});

// A small DOM fixture for this module's standard element/event operations. It
// models capture/bubble ordering and asynchronous attribute observations, the
// boundaries that matter when the calendar shares P1's existing selection root.
const observations = new Set();
class AttributeObserver {
  constructor(callback) { this.callback = callback; this.pending = false; }
  observe(target, options) { this.target = target; this.options = options; observations.add(this); }
  disconnect() { observations.delete(this); }
}
function changed(target, name) {
  for (const observer of observations) {
    if (observer.target !== target || !observer.options.attributeFilter.includes(name) || observer.pending) continue;
    observer.pending = true;
    queueMicrotask(() => {
      observer.pending = false;
      if (observations.has(observer)) observer.callback([{ target, attributeName: name }]);
    });
  }
}
const dataKey = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase(); this.ownerDocument = ownerDocument;
    this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = new Map();
    this.handlers = new Map(); this.classes = new Set(); this.inert = false; this.disabled = false;
    this._hidden = false; this._text = ''; this.tabIndex = -1;
    this.classList = {
      contains: name => this.classes.has(name),
      add: (...names) => { const before = this.className; names.forEach(name => this.classes.add(name)); if (before !== this.className) changed(this, 'class'); },
      remove: (...names) => { const before = this.className; names.forEach(name => this.classes.delete(name)); if (before !== this.className) changed(this, 'class'); },
      toggle: (name, on) => { const value = on ?? !this.classes.has(name); this.classList[value ? 'add' : 'remove'](name); return value; },
    };
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); changed(this, 'class'); }
  get hidden() { return this._hidden; }
  set hidden(value) { const next = Boolean(value); if (next !== this._hidden) { this._hidden = next; changed(this, 'hidden'); } }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this._text = String(value); }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
  append(...children) {
    for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); }
  }
  replaceChildren(...children) { this.textContent = ''; this.append(...children); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    const tag = selector.match(/^[a-z]+/i)?.[0];
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classes.has(name)) return false;
    for (const [, name, expected] of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
      const value = name.startsWith('data-') ? this.dataset[dataKey(name.slice(5))] : this.getAttribute(name);
      if (value == null || (expected !== undefined && value !== expected)) return false;
    }
    return true;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() {
    for (let node = this; node; node = node.parentElement) if (node.hidden || node.inert) return;
    this.ownerDocument.activeElement = this;
  }
  scrollIntoView(options) { this.scrolled = true; (this.scrollCalls ??= []).push(options); }
  addEventListener(type, handler, options = {}) {
    const entries = this.handlers.get(type) ?? [];
    entries.push({ handler, capture: options === true || options.capture === true }); this.handlers.set(type, entries);
  }
  removeEventListener(type, handler) { this.handlers.set(type, (this.handlers.get(type) ?? []).filter(entry => entry.handler !== handler)); }
  dispatch(type, props = {}) {
    const event = { type, target: this, defaultPrevented: false, stopped: false, immediate: false, ...props,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; this.immediate = true; } };
    const path = []; for (let node = this; node; node = node.parentElement) path.push(node);
    const invoke = (node, capture) => {
      event.currentTarget = node;
      for (const entry of node.handlers.get(type) ?? []) {
        if (entry.capture === capture) entry.handler(event);
        if (event.immediate) break;
      }
    };
    for (const node of [...path].reverse()) { invoke(node, true); if (event.stopped) return event; }
    for (const node of path) { invoke(node, false); if (event.stopped) break; }
    return event;
  }
  click() { this.focus(); return this.dispatch('click'); }
}
class Document {
  constructor(width = 1280) {
    this.body = new Element('body', this); this.activeElement = this.body;
    this.defaultView = { innerWidth: width, matchMedia: query => ({
      matches: this.defaultView.innerWidth <= Number(query.match(/max-width:\s*(\d+)px/)?.[1]),
    }) };
  }
  createElement(name) { return new Element(name, this); }
}
const flushAttributes = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
const calendarSource = await readFile(new URL('../src/annual-calendar.js', import.meta.url), 'utf8');
const executableCalendar = calendarSource.replace("import './annual-calendar.css';", '')
  .replace("'./annual-planner.js'", JSON.stringify(new URL('../src/annual-planner.js', import.meta.url).href));
const { createAnnualCalendar } = await import(`data:text/javascript;base64,${Buffer.from(executableCalendar).toString('base64')}`);
const [sites, candidates, zoneMeta, zoneBytes] = await Promise.all([
  readFile(new URL('../src/data/sites.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/data/candidates.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/data/zones.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/data/zones.bin', import.meta.url)),
]);
const zones = createZones(inflateSync(zoneBytes), zoneMeta);
function calendarFixture({ unknown = false, mission = undefined, width = 1280 } = {}) {
  const doc = new Document(width), root = doc.createElement('section'), header = doc.createElement('header');
  const back = doc.createElement('button'), preInert = doc.createElement('aside'); preInert.inert = true;
  header.append(back); root.append(header, preInert); root.hidden = true; doc.body.append(root);
  const data = structuredClone({ sites, candidates });
  if (unknown) delete data.sites.sites[0].stats_by_year['2026'];
  const epoch = Date.parse('2026-01-01T00:00:00Z');
  const config = mission === undefined ? Object.freeze({
    arriveH: (Date.parse('2028-07-01T00:00:00Z') - epoch) / 3600e3, stayH: 168,
    needs: Object.freeze({ maxDarkH: 216 }),
  }) : mission;
  const previousObserver = globalThis.MutationObserver; globalThis.MutationObserver = AttributeObserver;
  const api = createAnnualCalendar({ root, data, zones,
    eph: { hoursToDate: h => new Date(epoch + h * 3600e3) }, getMission: () => config, getYear: () => 2035 });
  return { doc, root, back, header, preInert, api, config,
    async reveal() { root.hidden = false; root.classList.remove('out'); back.focus(); await flushAttributes(); },
    cleanup() { api.destroy(); globalThis.MutationObserver = previousObserver; },
  };
}

test('first selection-screen reveal defaults to all 285 annual cells without timers or a second render loop', async () => {
  assert.doesNotMatch(calendarSource, /\b(?:setInterval|setTimeout|requestAnimationFrame)\s*\(/);
  const f = calendarFixture();
  try {
    await f.reveal();
    assert.equal(f.root.querySelector('.ac-panel').hidden, false);
    assert.equal(f.root.querySelectorAll('.ac-cell').length, 285);
    assert.equal(f.root.querySelector('.ac-year').children.length, 15);
    assert.equal(f.root.querySelector('.ac-year').value, '2028', 'saved arrival year takes precedence over current clock year');
    assert.equal(f.root.querySelectorAll('.ac-cell').filter(cell => cell.tabIndex === 0).length, 1);
    assert.equal(f.header.inert, true); assert.equal(f.preInert.inert, true);
    assert.equal(f.doc.activeElement, f.root.querySelector('.ac-year'));
    assert.match(f.root.querySelector('.ac-method').textContent, /approximate 8,766-hour/);
  } finally { f.cleanup(); }
});

test('planning year and inspection stay local and do not alter the mission or map selection', async () => {
  const f = calendarFixture();
  try {
    await f.reveal(); const before = JSON.stringify(f.config), originalHostNodes = [f.header, f.preInert];
    const year = f.root.querySelector('.ac-year'); year.value = '2040'; year.dispatch('change');
    assert.equal(year.value, '2040'); assert.equal(JSON.stringify(f.config), before);
    assert.match(f.root.querySelector('.ac-recommendation').textContent, /2040/);
    assert.ok(originalHostNodes.every(node => f.root.children.includes(node)));
    assert.equal(f.root.querySelectorAll('.ac-cell').length, 285, 'refresh replaces rather than duplicates the matrix');
    f.root.querySelector('.ac-cell').click();
    assert.equal(JSON.stringify(f.config), before);
  } finally { f.cleanup(); }
});

test('roving cell keyboard navigation is bounded, focuses the inspected cell, and stays inside the calendar', async () => {
  const f = calendarFixture(); let hostKeys = 0;
  f.doc.body.addEventListener('keydown', () => hostKeys++);
  try {
    await f.reveal(); const first = f.root.querySelector('.ac-cell'); first.click();
    const right = first.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(right.defaultPrevented, true); assert.equal(hostKeys, 0);
    assert.equal(f.doc.activeElement.dataset.acRow, '0'); assert.equal(f.doc.activeElement.dataset.acCol, '1');
    assert.equal(f.doc.activeElement.scrolled, true);
    f.doc.activeElement.dispatch('keydown', { key: 'End', ctrlKey: true });
    assert.equal(f.doc.activeElement.dataset.acRow, '18'); assert.equal(f.doc.activeElement.dataset.acCol, '14');
    f.doc.activeElement.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(f.doc.activeElement.dataset.acRow, '18');
    assert.equal(f.root.querySelectorAll('.ac-cell').filter(cell => cell.tabIndex === 0).length, 1);
    assert.equal(hostKeys, 0);
  } finally { f.cleanup(); }
});

test('Escape restores map focus and inert state without triggering the host Escape handler', async () => {
  const f = calendarFixture(); let hostEscapes = 0;
  f.doc.body.addEventListener('keydown', event => { if (event.key === 'Escape') hostEscapes++; });
  try {
    await f.reveal();
    const event = f.doc.activeElement.dispatch('keydown', { key: 'Escape' });
    assert.equal(event.defaultPrevented, true); assert.equal(hostEscapes, 0);
    assert.equal(f.root.querySelector('.ac-panel').hidden, true);
    assert.equal(f.header.inert, false); assert.equal(f.preInert.inert, true);
    assert.strictEqual(f.doc.activeElement, f.back);
    assert.equal(f.root.hidden, false, 'Escape must not leave the native selection screen');
  } finally { f.cleanup(); }
});

test('Map/Calendar preference survives conceal/reveal and host hiding releases inert state', async () => {
  const f = calendarFixture();
  try {
    await f.reveal(); f.root.querySelector('[data-ac-view="map"]').click();
    f.root.classList.add('out'); await flushAttributes();
    await f.reveal(); assert.equal(f.root.querySelector('.ac-panel').hidden, true, 'remember explicit Map preference');
    f.root.querySelector('[data-ac-view="calendar"]').click();
    assert.equal(f.root.querySelector('.ac-panel').hidden, false);
    f.root.hidden = true; await flushAttributes();
    assert.equal(f.header.inert, false); assert.equal(f.preInert.inert, true);
    await f.reveal(); assert.equal(f.root.querySelector('.ac-panel').hidden, false, 'restore Calendar preference');
    assert.equal(f.root.querySelectorAll('.ac-cell').length, 285);
  } finally { f.cleanup(); }
});

test('missing annual evidence is unknown rather than passing and absent outage figures stay unknown', async () => {
  const f = calendarFixture({ unknown: true });
  try {
    await f.reveal(); const first = f.root.querySelector('.ac-cell');
    assert.equal(first.classList.contains('ac-unknown'), true);
    assert.match(first.getAttribute('aria-label'), /Unknown/); first.click();
    assert.doesNotMatch(f.root.querySelector('.ac-detail').textContent, /PASS/);
    assert.match(f.root.querySelector('.ac-detail').textContent, /missing/);
    const generated = f.root.querySelectorAll('.ac-cell').find(cell => cell.dataset.acRow === '4' && cell.dataset.acCol === '0');
    generated.click();
    const outage = f.root.querySelector('.ac-stats').children.find(row => row.children[0].textContent === 'Longest link outage');
    assert.equal(outage.children[1].textContent, 'Unknown');
  } finally { f.cleanup(); }
});

test('destroy removes only calendar-owned DOM/listeners and restores original host inert values', async () => {
  const f = calendarFixture(); let escaped = 0;
  f.doc.body.addEventListener('keydown', () => escaped++);
  try {
    await f.reveal(); f.api.destroy();
    assert.deepEqual(f.root.children, [f.header, f.preInert]);
    assert.equal(f.header.inert, false); assert.equal(f.preInert.inert, true);
    assert.equal(f.root.classList.contains('ac-calendar-open'), false);
    assert.equal(f.api.show(), false);
    f.back.dispatch('keydown', { key: 'Escape' }); assert.equal(escaped, 1);
    f.root.hidden = true; await flushAttributes(); await f.reveal();
    assert.deepEqual(f.root.children, [f.header, f.preInert]);
  } finally { f.cleanup(); }
});

for (const { width, unknown } of [{ width: 390, unknown: false }, { width: 720, unknown: true }]) {
  test(`mobile cell inspection at ${width}px reveals details and returns to the same cell${unknown ? ' with unknown data' : ''}`, async () => {
    const f = calendarFixture({ width, unknown });
    try {
      await f.reveal();
      const before = JSON.stringify(f.config), cell = f.root.querySelector('.ac-cell');
      const detail = f.root.querySelector('.ac-detail');
      assert.equal(detail.tabIndex, -1, 'detail is programmatically focusable without adding a tab stop');
      cell.click();
      assert.strictEqual(f.doc.activeElement, detail);
      assert.deepEqual(detail.scrollCalls.at(-1), { block: 'start', inline: 'nearest', behavior: 'instant' });
      assert.equal(cell.getAttribute('aria-pressed'), 'true');
      assert.equal(cell.tabIndex, 0);
      const detailScrolls = detail.scrollCalls.length;
      const back = detail.querySelector('.ac-back-to-calendar');
      assert.ok(back, 'known and unknown details both provide the mobile return control');
      back.click();
      assert.strictEqual(f.doc.activeElement, cell);
      assert.deepEqual(cell.scrollCalls.at(-1), { block: 'nearest', inline: 'nearest', behavior: 'instant' });
      assert.equal(detail.scrollCalls.length, detailScrolls, 'returning to the matrix must not reopen detail focus');
      assert.equal(JSON.stringify(f.config), before);
    } finally { f.cleanup(); }
  });
}

test('mobile recommendation inspection reveals its detail while arrow-key navigation stays in the matrix', async () => {
  const f = calendarFixture({ width: 390 });
  try {
    await f.reveal(); const detail = f.root.querySelector('.ac-detail');
    const first = f.root.querySelector('.ac-cell'); first.focus();
    first.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(f.doc.activeElement.classList.contains('ac-cell'), true);
    assert.equal(f.doc.activeElement.dataset.acCol, '1');
    assert.equal(detail.scrollCalls?.length ?? 0, 0, 'keyboard movement must not jump to the lower detail section');
    f.root.querySelector('.ac-recommendation').querySelector('.ac-inspect').click();
    assert.strictEqual(f.doc.activeElement, detail);
    assert.equal(detail.scrollCalls.at(-1).block, 'start');
    const selected = f.root.querySelectorAll('.ac-cell').find(cell => cell.getAttribute('aria-pressed') === 'true');
    detail.querySelector('.ac-back-to-calendar').click();
    assert.strictEqual(f.doc.activeElement, selected);
    const count = detail.scrollCalls.length;
    selected.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(f.doc.activeElement.classList.contains('ac-cell'), true);
    assert.equal(detail.scrollCalls.length, count);
  } finally { f.cleanup(); }
});

for (const width of [721, 1280]) {
  test(`desktop inspection at ${width}px keeps matrix focus without scrolling to details`, async () => {
    const f = calendarFixture({ width });
    try {
      await f.reveal(); const detail = f.root.querySelector('.ac-detail'), first = f.root.querySelector('.ac-cell');
      first.click(); assert.strictEqual(f.doc.activeElement, first);
      assert.equal(detail.scrollCalls?.length ?? 0, 0);
      f.root.querySelector('.ac-recommendation').querySelector('.ac-inspect').click();
      assert.equal(f.doc.activeElement.classList.contains('ac-cell'), true);
      assert.equal(f.doc.activeElement.getAttribute('aria-pressed'), 'true');
      assert.equal(detail.scrollCalls?.length ?? 0, 0);
    } finally { f.cleanup(); }
  });
}
