import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { createZones } from '../src/zones.js';
import { buildAnnualPlan } from '../src/annual-planner.js';
import { candidatePool } from '../src/rank.js';

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

import { AttributeObserver, Document, flushAttributes } from './fixtures/annual-dom.js';
const mapSource = await readFile(new URL('../src/annual-map.js', import.meta.url), 'utf8');
const executableMap = mapSource.replace("import './annual-map.css';", '')
  .replace("'./geo.js'", JSON.stringify(new URL('../src/geo.js', import.meta.url).href));
const mapModuleURL = `data:text/javascript;base64,${Buffer.from(executableMap).toString('base64')}`;
const calendarSource = await readFile(new URL('../src/annual-calendar.js', import.meta.url), 'utf8');
const executableCalendar = calendarSource.replace("import './annual-calendar.css';", '')
  .replace("'./annual-planner.js'", JSON.stringify(new URL('../src/annual-planner.js', import.meta.url).href))
  .replace("'./annual-map.js'", JSON.stringify(mapModuleURL));
const { createAnnualCalendar } = await import(`data:text/javascript;base64,${Buffer.from(executableCalendar).toString('base64')}`);
const [sites, candidates, zoneMeta, zoneBytes, moonPolarMeta, terrainMeta] = await Promise.all([
  readFile(new URL('../src/data/sites.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/data/candidates.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/data/zones.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/data/zones.bin', import.meta.url)),
  readFile(new URL('../src/data/moon_spole_relief.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/data/terrain.json', import.meta.url), 'utf8').then(JSON.parse),
]);
const zones = createZones(inflateSync(zoneBytes), zoneMeta);
const catalogData = { sites, candidates, moonPolarMeta, moonPolarUrl: 'fixture-moon-relief.jpg', radiusKm: terrainMeta.radius_m / 1000 };
const pool = candidatePool(catalogData);
const yearCount = sites.stats_years[1] - sites.stats_years[0] + 1;
function calendarFixture({ unknown = false, missingOutage = false, mission = undefined, width = 1280 } = {}) {
  const doc = new Document(width), root = doc.createElement('section'), header = doc.createElement('header');
  const back = doc.createElement('button'), preInert = doc.createElement('aside'); preInert.inert = true;
  header.append(back); root.append(header, preInert); root.hidden = true; doc.body.append(root);
  const data = structuredClone(catalogData);
  if (unknown) delete data.sites.sites[0].stats_by_year['2026'];
  if (missingOutage) delete data.candidates.candidates[0].stats_by_year['2026'].longest_blind_h;
  const epoch = Date.parse('2026-01-01T00:00:00Z');
  const config = mission === undefined ? Object.freeze({
    arriveH: (Date.parse('2028-07-01T00:00:00Z') - epoch) / 3600e3, stayH: 168,
    needs: Object.freeze({ maxDarkH: 318 }),
  }) : mission;
  const previousObserver = globalThis.MutationObserver; globalThis.MutationObserver = AttributeObserver;
  const api = createAnnualCalendar({ root, data, zones,
    eph: { hoursToDate: h => new Date(epoch + h * 3600e3) }, getMission: () => config, getYear: () => 2035 });
  return { doc, root, back, header, preInert, api, config, data,
    async reveal() { root.hidden = false; root.classList.remove('out'); back.focus(); await flushAttributes(); },
    cleanup() { api.destroy(); globalThis.MutationObserver = previousObserver; },
  };
}

function planFor(f, fromYear = 2028) {
  return buildAnnualPlan({ data: f.data, zones, needs: f.config?.needs || {}, fromYear });
}
function chooseSite(f, id) {
  const select = f.root.querySelector('.ac-site-select'); select.value = id; select.dispatch('change');
}
function yearButton(f, year) { return f.root.querySelector(`[data-ac-year="${year}"]`); }
function assertSelection(f, id, year) {
  assert.equal(f.root.querySelector('.ac-site-select').value, id);
  assert.equal(f.root.querySelector('.ac-detail-year').textContent, String(year));
  const selectedYears = f.root.querySelectorAll('.ac-year-button').filter(button => button.getAttribute('aria-pressed') === 'true');
  assert.equal(selectedYears.length, 1); assert.equal(selectedYears[0].dataset.acYear, String(year));
  assert.equal(f.root.querySelectorAll('.ac-year-button').filter(button => button.tabIndex === 0).length, 1);
  const selectedMarks = f.root.querySelectorAll('.am-marker').filter(mark => mark.getAttribute('aria-pressed') === 'true');
  assert.equal(selectedMarks.length, 1); assert.equal(selectedMarks[0].dataset.siteId, id);
  for (const mark of f.root.querySelectorAll('.am-marker')) assert.match(mark.getAttribute('aria-label'), new RegExp(String(year)));
  const selectedCells = f.root.querySelectorAll('.ac-cell').filter(button => button.getAttribute('aria-pressed') === 'true');
  assert.equal(selectedCells.length, 1);
  assert.equal(selectedCells[0].dataset.acRow, String(pool.findIndex(site => site.id === id)));
  assert.equal(selectedCells[0].dataset.acCol, String(year - sites.stats_years[0]));
}

test('first reveal presents the recommended site on a real map and one timeline while dense evidence stays collapsed', async () => {
  assert.doesNotMatch(calendarSource, /\b(?:setInterval|setTimeout|requestAnimationFrame)\s*\(/);
  assert.doesNotMatch(calendarSource, /window\.__lln|mission\.(?:ready|onMission)\s*\(/);
  const f = calendarFixture();
  try {
    await f.reveal(); const expected = planFor(f).recommendation;
    assert.ok(expected);
    assert.equal(f.root.querySelector('.ac-panel').hidden, false);
    assert.equal(f.root.querySelectorAll('.am-marker').length, pool.length);
    assert.equal(f.root.querySelector('.am-image').src, f.data.moonPolarUrl);
    assert.equal(f.root.querySelector('.ac-site-select').children.length, pool.length);
    assert.equal(f.root.querySelectorAll('.ac-year-button').length, yearCount);
    assert.equal(f.root.querySelector('.ac-comparison').open, false);
    assert.equal(f.root.querySelector('.ac-evidence').open, false);
    assert.equal(f.root.querySelectorAll('.ac-cell').length, pool.length * yearCount);
    assert.match(f.root.querySelector('.ac-comparison').querySelector('summary').textContent, new RegExp(String(pool.length)));
    assert.equal(f.root.querySelector('.ac-year').children.length, yearCount);
    assert.equal(f.root.querySelector('.ac-year').value, '2028', 'arrival year takes precedence over the running clock');
    assert.equal(f.root.querySelector('.ac-recommend-year').textContent, String(expected.year));
    assertSelection(f, expected.site.id, expected.year);
    assert.equal(f.header.inert, true); assert.equal(f.preInert.inert, true);
    assert.strictEqual(f.doc.activeElement, f.root.querySelector('.ac-year'));
  } finally { f.cleanup(); }
});

test('map, site selector, timeline and full comparison inspect the same actual site-year record', async () => {
  const f = calendarFixture();
  try {
    await f.reveal(); const plan = planFor(f), before = JSON.stringify(f.config), firstYear = plan.years[0];
    const site = pool.find(item => item.id !== plan.recommendation.site.id);
    f.root.querySelector(`[data-site-id="${site.id}"]`).click();
    assertSelection(f, site.id, plan.recommendation.year);
    yearButton(f, firstYear).click(); assertSelection(f, site.id, firstYear);
    for (const cell of plan.yearSummaries[0].cells) {
      const mark = f.root.querySelector(`[data-site-id="${cell.site.id}"]`);
      assert.equal(mark.classList.contains(`am-${cell.status}`), true, `${cell.site.id} uses the displayed year's result`);
    }
    chooseSite(f, pool.at(-1).id); assertSelection(f, pool.at(-1).id, firstYear);
    const comparison = f.root.querySelector('.ac-comparison'); comparison.open = true;
    const last = f.root.querySelectorAll('.ac-cell').at(-1); last.click();
    assertSelection(f, pool.at(-1).id, plan.years.at(-1));
    assert.equal(comparison.open, false);
    assert.strictEqual(f.doc.activeElement, f.root.querySelector('.ac-site-select'));
    assert.equal(f.root.querySelector('.ac-detail').scrollCalls.at(-1).block, 'nearest');
    assert.equal(f.root.querySelector('.ac-year').value, '2028', 'inspection is separate from the recommendation starting year');
    assert.equal(JSON.stringify(f.config), before);
  } finally { f.cleanup(); }
});

test('changing planning year updates the recommendation locally, preserves inspection and creates no duplicate views', async () => {
  const f = calendarFixture();
  try {
    await f.reveal(); const before = JSON.stringify(f.config), firstYear = sites.stats_years[0];
    chooseSite(f, pool[0].id); yearButton(f, firstYear).click();
    const year = f.root.querySelector('.ac-year'); year.value = String(sites.stats_years[1]); year.dispatch('change');
    const expected = planFor(f, sites.stats_years[1]).recommendation;
    assertSelection(f, pool[0].id, firstYear);
    assert.equal(f.root.querySelector('.ac-recommend-year').textContent, String(expected.year));
    f.root.querySelector('[data-ac-action="recommendation"]').click();
    assertSelection(f, expected.site.id, expected.year);
    assert.equal(JSON.stringify(f.config), before);
    assert.equal(f.root.querySelectorAll('.am-map').length, 1);
    assert.equal(f.root.querySelectorAll('.ac-cell').length, pool.length * yearCount);
    assert.ok(f.root.children.includes(f.header)); assert.ok(f.root.children.includes(f.preInert));
  } finally { f.cleanup(); }
});

test('timeline keyboard navigation is bounded and retains focused nodes while updating the map', async () => {
  const f = calendarFixture(); let hostKeys = 0; f.doc.body.addEventListener('keydown', () => hostKeys++);
  try {
    await f.reveal(); const id = f.root.querySelector('.ac-site-select').value;
    const original = f.root.querySelectorAll('.ac-year-button'), first = original[0]; first.focus();
    const right = first.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(right.defaultPrevented, true); assert.equal(hostKeys, 0);
    assert.strictEqual(f.doc.activeElement, original[1]); assertSelection(f, id, sites.stats_years[0] + 1);
    original[1].dispatch('keydown', { key: 'End' }); assert.strictEqual(f.doc.activeElement, original.at(-1));
    original.at(-1).dispatch('keydown', { key: 'ArrowRight' }); assert.strictEqual(f.doc.activeElement, original.at(-1));
    assertSelection(f, id, sites.stats_years[1]);
    original.at(-1).dispatch('keydown', { key: 'Home' }); assert.strictEqual(f.doc.activeElement, original[0]);
    original[0].dispatch('keydown', { key: 'ArrowLeft' }); assert.strictEqual(f.doc.activeElement, original[0]);
    assertSelection(f, id, sites.stats_years[0]); assert.equal(hostKeys, 0);
    assert.equal(f.root.querySelector('.ac-detail').scrollCalls?.length ?? 0, 0);
  } finally { f.cleanup(); }
});

test('the optional comparison retains bounded two-dimensional keyboard navigation using metadata dimensions', async () => {
  const f = calendarFixture(); let hostKeys = 0; f.doc.body.addEventListener('keydown', () => hostKeys++);
  try {
    await f.reveal(); f.root.querySelector('.ac-comparison').open = true;
    const first = f.root.querySelector('.ac-cell'); first.focus();
    const right = first.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(right.defaultPrevented, true); assert.equal(hostKeys, 0);
    assert.equal(f.doc.activeElement.dataset.acRow, '0'); assert.equal(f.doc.activeElement.dataset.acCol, '1');
    f.doc.activeElement.dispatch('keydown', { key: 'End', ctrlKey: true });
    assert.equal(f.doc.activeElement.dataset.acRow, String(pool.length - 1));
    assert.equal(f.doc.activeElement.dataset.acCol, String(yearCount - 1));
    f.doc.activeElement.dispatch('keydown', { key: 'ArrowDown' });
    assertSelection(f, pool.at(-1).id, sites.stats_years[1]);
    assert.equal(f.root.querySelectorAll('.ac-cell').filter(cell => cell.tabIndex === 0).length, 1);
    assert.equal(f.root.querySelector('.ac-comparison').open, true, 'arrows inspect without leaving the expanded matrix');
    assert.equal(f.root.querySelector('.ac-detail').scrollCalls?.length ?? 0, 0);
    f.doc.activeElement.press('Enter');
    assert.equal(f.root.querySelector('.ac-comparison').open, false, 'native Enter activation returns to the selected result');
    assert.strictEqual(f.doc.activeElement, f.root.querySelector('.ac-site-select'));
    assert.equal(hostKeys, 0);
  } finally { f.cleanup(); }
});

test('Escape closes expanded evidence first, then restores the 3D survey without triggering host Escape', async () => {
  const f = calendarFixture(); let hostEscapes = 0;
  f.doc.body.addEventListener('keydown', event => { if (event.key === 'Escape') hostEscapes++; });
  try {
    await f.reveal();
    const evidence = f.root.querySelector('.ac-evidence'), comparison = f.root.querySelector('.ac-comparison');
    evidence.open = true; comparison.open = true; evidence.querySelector('summary').focus();
    const first = f.doc.activeElement.dispatch('keydown', { key: 'Escape' });
    assert.equal(first.defaultPrevented, true); assert.equal(hostEscapes, 0);
    assert.equal(evidence.open, false); assert.equal(comparison.open, false);
    assert.equal(f.root.querySelector('.ac-panel').hidden, false);
    assert.strictEqual(f.doc.activeElement, evidence.querySelector('summary'));
    f.doc.activeElement.dispatch('keydown', { key: 'Escape' });
    assert.equal(f.root.querySelector('.ac-panel').hidden, true);
    assert.equal(f.header.inert, false); assert.equal(f.preInert.inert, true);
    assert.strictEqual(f.doc.activeElement, f.back); assert.equal(hostEscapes, 0);
    assert.equal(f.root.hidden, false);
  } finally { f.cleanup(); }
});

test('automatic planner opening never restores focus to a previous screen outside the selection root', async () => {
  const f = calendarFixture();
  try {
    const previousScreenButton = f.doc.createElement('button'); f.doc.body.append(previousScreenButton); previousScreenButton.focus();
    f.root.hidden = false; await flushAttributes(); previousScreenButton.hidden = true;
    f.doc.activeElement.dispatch('keydown', { key: 'Escape' });
    assert.strictEqual(f.doc.activeElement, f.root.querySelector('[data-ac-view="calendar"]'));
    assert.notStrictEqual(f.doc.activeElement, previousScreenButton);
  } finally { f.cleanup(); }
});

test('reopening the host cannot restore survey focus into the now-hidden planner panel', async () => {
  const f = calendarFixture();
  try {
    await f.reveal(); const previous = f.root.querySelector('.ac-year');
    f.root.hidden = true; await flushAttributes(); f.root.hidden = false; await flushAttributes();
    f.root.querySelector('[data-ac-view="map"]').click();
    assert.equal(f.root.querySelector('.ac-panel').hidden, true);
    assert.strictEqual(f.doc.activeElement, f.root.querySelector('[data-ac-view="calendar"]'));
    assert.notStrictEqual(f.doc.activeElement, previous);
  } finally { f.cleanup(); }
});

test('view preference survives conceal/reveal and reopening resets disclosure, scroll and inspection state', async () => {
  const f = calendarFixture();
  try {
    await f.reveal(); f.root.querySelector('[data-ac-view="map"]').click();
    f.root.classList.add('out'); await flushAttributes(); await f.reveal();
    assert.equal(f.root.querySelector('.ac-panel').hidden, true, 'remember explicit survey preference');
    f.root.querySelector('[data-ac-view="calendar"]').click();
    f.root.querySelector('.ac-comparison').open = true;
    f.root.querySelector('.ac-panel').scrollTop = 500; f.root.querySelector('.ac-timeline').scrollLeft = 100;
    chooseSite(f, pool[0].id); yearButton(f, sites.stats_years[0]).click();
    f.root.hidden = true; await flushAttributes();
    assert.equal(f.header.inert, false); assert.equal(f.preInert.inert, true);
    await f.reveal(); const expected = planFor(f).recommendation;
    assert.equal(f.root.querySelector('.ac-panel').hidden, false);
    assert.equal(f.root.querySelector('.ac-comparison').open, false);
    assert.equal(f.root.querySelector('.ac-panel').scrollTop, 0);
    assert.equal(f.root.querySelector('.ac-timeline').scrollLeft, 0);
    assertSelection(f, expected.site.id, expected.year);
  } finally { f.cleanup(); }
});

test('missing annual evidence stays unknown on map, timeline and details; an absent optional outage is not invented', async () => {
  const f = calendarFixture({ unknown: true, missingOutage: true });
  try {
    await f.reveal(); chooseSite(f, pool[0].id); yearButton(f, 2026).click();
    assert.equal(f.root.querySelector('.ac-verdict').classList.contains('ac-unknown'), true);
    assert.equal(yearButton(f, 2026).classList.contains('ac-unknown'), true);
    assert.equal(f.root.querySelector(`[data-site-id="${pool[0].id}"]`).classList.contains('am-unknown'), true);
    assert.doesNotMatch(f.root.querySelector('.ac-detail').textContent, /PASS/);
    assert.match(f.root.querySelector('.ac-selection-note').textContent, /missing/);
    chooseSite(f, candidates.candidates[0].id);
    const outage = f.root.querySelector('.ac-stats').children.find(row => row.children[0].textContent === 'Longest link outage');
    assert.equal(outage.children[1].textContent, 'Unknown');
  } finally { f.cleanup(); }
});

test('a real no-fit scenario has no recommendation action and does not highlight a failing site as recommended', async () => {
  const f = calendarFixture({ mission: { arriveH: 0, stayH: 168, needs: { maxDarkH: 1 } } });
  try {
    await f.reveal(); assert.equal(planFor(f, 2026).recommendation, null);
    assert.equal(f.root.querySelector('[data-ac-action="recommendation"]'), null);
    assert.match(f.root.querySelector('.ac-recommend-name').textContent, /No confirmed annual fit/);
    assert.equal(f.root.querySelectorAll('.am-recommended').length, 0);
    assert.equal(f.root.querySelector('.ac-verdict').classList.contains('ac-infeasible'), true);
  } finally { f.cleanup(); }
});

for (const width of [390, 720, 1280]) {
  test(`selection at ${width}px keeps map controls focused and explicit inspection reveals the chosen result`, async () => {
    const f = calendarFixture({ width });
    try {
      await f.reveal(); const marker = f.root.querySelector('.am-marker'); marker.click();
      assert.strictEqual(f.doc.activeElement, marker);
      const year = yearButton(f, sites.stats_years[0]); year.click(); assert.strictEqual(f.doc.activeElement, year);
      const site = f.root.querySelector('.ac-site-select'); site.focus(); chooseSite(f, pool.at(-1).id);
      assert.strictEqual(f.doc.activeElement, site);
      assert.equal(f.root.querySelector('.ac-detail').scrollCalls?.length ?? 0, 0);
      const inspect = f.root.querySelector('[data-ac-action="recommendation"]'); inspect.click();
      assert.strictEqual(f.doc.activeElement, inspect);
      assert.equal(f.root.querySelector('.ac-workspace').scrollCalls.at(-1).block, 'nearest');
      assert.equal(f.root.querySelector('.ac-detail').scrollCalls?.length ?? 0, 0);
      assert.equal(f.root.querySelector('.ac-comparison').open, false);
      const comparison = f.root.querySelector('.ac-comparison'); comparison.open = true;
      f.root.querySelector('.ac-cell').click();
      assert.equal(comparison.open, false);
      assert.strictEqual(f.doc.activeElement, site);
      assert.equal(f.root.querySelector('.ac-detail').scrollCalls.at(-1).block, 'nearest');
    } finally { f.cleanup(); }
  });
}

test('destroy removes only planner-owned DOM and listeners and restores original inert values', async () => {
  const f = calendarFixture(); let escaped = 0; f.doc.body.addEventListener('keydown', () => escaped++);
  try {
    await f.reveal(); f.api.destroy();
    assert.deepEqual(f.root.children, [f.header, f.preInert]);
    assert.equal(f.header.inert, false); assert.equal(f.preInert.inert, true);
    assert.equal(f.root.classList.contains('ac-calendar-open'), false); assert.equal(f.api.show(), false);
    f.back.dispatch('keydown', { key: 'Escape' }); assert.equal(escaped, 1);
    f.root.hidden = true; await flushAttributes(); await f.reveal();
    assert.deepEqual(f.root.children, [f.header, f.preInert]);
  } finally { f.cleanup(); }
});
