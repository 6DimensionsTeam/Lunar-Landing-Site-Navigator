import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { candidatePool } from '../src/rank.js';
import { Document } from './fixtures/annual-dom.js';

const source = await readFile(new URL('../src/annual-map.js', import.meta.url), 'utf8');
const executable = source.replace("import './annual-map.css';", '')
  .replace("'./geo.js'", JSON.stringify(new URL('../src/geo.js', import.meta.url).href));
const { annualMapLayout, createAnnualMap } = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);
const json = async name => JSON.parse(await readFile(new URL(`../src/data/${name}.json`, import.meta.url), 'utf8'));
const [sites, candidates, moonPolarMeta, terrain] = await Promise.all([
  json('sites'), json('candidates'), json('moon_spole_relief'), json('terrain'),
]);
const data = { sites, candidates, moonPolarMeta, radiusKm: terrain.radius_m / 1000, moonPolarUrl: 'actual-relief-fixture.jpg' };
const pool = candidatePool(data), extent = moonPolarMeta.half_extent_m / 1000;
const close = (actual, expected, message, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) < epsilon, `${message}: ${actual} vs ${expected}`);
const fraction = value => Number.parseFloat(value) / 100;

test('every current candidate aligns with the actual south-polar raster projection and remains inside the fitted view', () => {
  const geo = annualMapLayout({ sites: pool, radiusKm: data.radiusKm, halfExtentKm: extent });
  assert.equal(geo.points.length, pool.length);
  assert.ok(geo.pole.x >= 0 && geo.pole.x <= 1 && geo.pole.y >= 0 && geo.pole.y <= 1);
  for (const site of pool) {
    const point = geo.points.find(item => item.id === site.id);
    // Independently derive the raster UV from the documented stereographic convention.
    const rho = 2 * data.radiusKm * Math.tan((90 + site.lat) * Math.PI / 360);
    const x = rho * Math.sin(site.lon * Math.PI / 180), y = rho * Math.cos(site.lon * Math.PI / 180);
    assert.equal(point.mapped, true, site.id);
    assert.ok(point.x > 0 && point.x < 1 && point.y > 0 && point.y < 1, `${site.id} is clipped`);
    close(point.xKm, x, `${site.id} map x`); close(point.yKm, y, `${site.id} map y`);
    close((point.x - geo.image.x) / geo.image.width, .5 + x / (2 * extent), `${site.id} raster u`);
    close((point.y - geo.image.y) / geo.image.height, .5 - y / (2 * extent), `${site.id} raster v`);
  }
  assert.ok(geo.widthKm < 2 * extent, 'the view fits the candidates rather than showing the entire source raster');
});

test('pole and cardinal longitudes retain their image orientation across metadata extents and responsive aspects', () => {
  const synthetic = [
    { id: 'pole', lat: -90, lon: 123 }, { id: 'zero', lat: -88, lon: 0 },
    { id: 'east', lat: -88, lon: 90 }, { id: 'opposite', lat: -88, lon: 180 },
    { id: 'west', lat: -88, lon: 270 },
  ];
  for (const aspect of [.65, 1.2, 2.4]) {
    const geo = annualMapLayout({ sites: synthetic, radiusKm: 1000, halfExtentKm: 200, aspect });
    const byId = Object.fromEntries(geo.points.map(point => [point.id, point]));
    close(geo.widthKm / geo.heightKm, aspect, 'fitted aspect');
    close(byId.pole.x, geo.pole.x, 'pole x'); close(byId.pole.y, geo.pole.y, 'pole y');
    assert.ok(byId.zero.y < geo.pole.y); assert.ok(byId.east.x > geo.pole.x);
    assert.ok(byId.opposite.y > geo.pole.y); assert.ok(byId.west.x < geo.pole.x);
    for (const point of geo.points) assert.ok(point.x > 0 && point.x < 1 && point.y > 0 && point.y < 1);
  }
});

function fixture() {
  const doc = new Document(), root = doc.createElement('section'), original = doc.createElement('p');
  root.append(original); doc.body.append(root); const selected = [];
  const api = createAnnualMap({ root, data, onSelect: id => selected.push(id) });
  const cells = pool.map((site, index) => ({ site, year: sites.stats_years[0], status: ['feasible', 'infeasible', 'unknown'][index % 3] }));
  return { doc, root, original, api, cells, selected };
}

test('map markers retain site identity, real image alignment, distinct statuses and year labels through reordered updates', () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.cells), selectedId = pool[0].id, recommendedId = pool[1].id;
    f.api.update({ cells: f.cells, selectedId, recommendedId });
    assert.equal(f.root.querySelector('.am-image').src, data.moonPolarUrl);
    const originalMarkers = new Map(f.root.querySelectorAll('.am-marker').map(mark => [mark.dataset.siteId, mark]));
    const geo = annualMapLayout({ sites: pool, radiusKm: data.radiusKm, halfExtentKm: extent });
    assert.equal(originalMarkers.size, pool.length);
    for (const [index, cell] of f.cells.entries()) {
      const mark = originalMarkers.get(cell.site.id), point = geo.points.find(item => item.id === cell.site.id);
      assert.equal(mark.tagName, 'BUTTON'); assert.equal(mark.type, 'button'); assert.equal(mark.hidden, false);
      assert.equal(mark.classList.contains(`am-${cell.status}`), true);
      assert.equal(mark.getAttribute('aria-pressed'), String(cell.site.id === selectedId));
      assert.equal(mark.classList.contains('am-recommended'), cell.site.id === recommendedId);
      assert.match(mark.getAttribute('aria-label'), new RegExp(`${cell.site.id}.*${cell.year}`));
      close(fraction(mark.style.left), point.x, `${index} left`, 1e-8);
      close(fraction(mark.style.top), point.y, `${index} top`, 1e-8);
      mark.click(); assert.equal(f.selected.at(-1), cell.site.id);
    }
    const next = [...f.cells].reverse().map(cell => ({ ...cell, year: cell.year + 1, status: 'unknown' }));
    f.api.update({ cells: next, selectedId: recommendedId, recommendedId: null });
    assert.equal(f.root.querySelectorAll('.am-marker').length, pool.length);
    for (const mark of f.root.querySelectorAll('.am-marker')) {
      assert.strictEqual(mark, originalMarkers.get(mark.dataset.siteId), 'updates preserve marker focus identity');
      assert.equal(mark.classList.contains('am-unknown'), true);
      assert.equal(mark.classList.contains('am-feasible'), false);
      assert.equal(mark.classList.contains('am-recommended'), false);
    }
    assert.match(f.root.querySelector('.am-year').textContent, new RegExp(String(next[0].year)));
    assert.equal(JSON.stringify(f.cells), before, 'map updates do not alter annual evidence');
  } finally { f.api.destroy(); }
});

test('marker arrows move focus without selecting or leaking to the host globe', () => {
  const f = fixture(); let hostKeys = 0; f.doc.body.addEventListener('keydown', () => hostKeys++);
  try {
    f.api.update({ cells: f.cells, selectedId: pool[0].id });
    const marks = f.root.querySelectorAll('.am-marker'); marks[0].focus();
    const event = marks[0].dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(event.defaultPrevented, true); assert.equal(hostKeys, 0);
    assert.strictEqual(f.doc.activeElement, marks[1]); assert.deepEqual(f.selected, []);
    marks[1].click(); assert.deepEqual(f.selected, [marks[1].dataset.siteId]);
    marks[0].dispatch('keydown', { key: 'ArrowLeft' }); assert.strictEqual(f.doc.activeElement, marks.at(-1));
  } finally { f.api.destroy(); }
});

function setMarkerRect(marker, centerX, centerY, size = 40) {
  marker.getBoundingClientRect = () => ({
    x: centerX - size / 2, y: centerY - size / 2,
    left: centerX - size / 2, top: centerY - size / 2,
    right: centerX + size / 2, bottom: centerY + size / 2,
    width: size, height: size,
  });
}

test('a pointer click in overlapping A/B hit areas selects the nearest physical anchor rather than the topmost DOM target', () => {
  const f = fixture();
  try {
    f.api.update({ cells: f.cells, selectedId: 'A' });
    for (const [index, marker] of f.root.querySelectorAll('.am-marker').entries()) setMarkerRect(marker, 400 + index * 80, 300);
    const a = f.root.querySelector('[data-site-id="A"]'), b = f.root.querySelector('[data-site-id="B"]');
    // The 40px buttons overlap although their visible point centres differ.
    setMarkerRect(a, 100, 100); setMarkerRect(b, 118, 100);
    a.querySelector('.am-dot').dispatch('click', { detail: 1, clientX: 118, clientY: 100 });
    assert.deepEqual(f.selected, ['B'], 'selected A may be painted on top, but the pointer is at B');
    b.dispatch('click', { detail: 1, clientX: 100, clientY: 100 });
    assert.deepEqual(f.selected, ['B', 'A']);
    a.dispatch('click', { detail: 1, clientX: 114, clientY: 102 });
    assert.equal(f.selected.at(-1), 'B', 'nearest anchor wins between centres too');
  } finally { f.api.destroy(); }
});

test('overlap resolution preserves keyboard/programmatic activation and excludes hidden or zero-size points', () => {
  const f = fixture();
  try {
    f.api.update({ cells: [...f.cells, { site: { id: 'hidden', lat: NaN, lon: 0 }, year: 2026, status: 'unknown' }], selectedId: 'A' });
    for (const [index, marker] of f.root.querySelectorAll('.am-marker').entries()) setMarkerRect(marker, 400 + index * 80, 300);
    const a = f.root.querySelector('[data-site-id="A"]'), b = f.root.querySelector('[data-site-id="B"]');
    setMarkerRect(a, 100, 100); setMarkerRect(b, 118, 100);
    setMarkerRect(f.root.querySelector('[data-site-id="hidden"]'), 116, 100);
    setMarkerRect(f.root.querySelector('[data-site-id="C"]'), 116, 100, 0);
    a.dispatch('click', { detail: 1, clientX: 116, clientY: 100 });
    assert.equal(f.selected.at(-1), 'B', 'hidden and collapsed rectangles cannot intercept a physical click');
    a.dispatch('click', { detail: 0, clientX: 118, clientY: 100 });
    assert.equal(f.selected.at(-1), 'A', 'programmatic clicks retain the addressed button');
    a.focus(); a.press('Enter');
    assert.equal(f.selected.at(-1), 'A', 'native keyboard activation retains the focused button');
    a.dispatch('click', { detail: 1, clientX: NaN, clientY: 100 });
    assert.equal(f.selected.at(-1), 'A');
    a.dispatch('click', { detail: 1, clientX: 118, clientY: Infinity });
    assert.equal(f.selected.at(-1), 'A', 'unusable pointer coordinates safely fall back to the event target');
  } finally { f.api.destroy(); }
});

test('unprojectable sites are never shown at invented coordinates and removed IDs leave no stale marker', () => {
  const f = fixture();
  try {
    const invalid = [{ id: 'missing', lat: NaN, lon: 0 }, { id: 'north', lat: 89, lon: 0 }, { id: 'outside', lat: 0, lon: 0 }];
    const cells = [...f.cells, ...invalid.map(site => ({ site, status: 'unknown', year: 2026 }))];
    f.api.update({ cells, selectedId: 'outside' });
    for (const site of invalid) assert.equal(f.root.querySelector(`[data-site-id="${site.id}"]`).hidden, true);
    assert.equal(f.root.querySelector('.am-callout').hidden, true);
    f.api.update({ cells: f.cells.slice(0, 1), selectedId: pool[0].id });
    assert.equal(f.root.querySelectorAll('.am-marker').length, 1);
  } finally { f.api.destroy(); }
});

test('destroy restores only owned content and prevents detached marker events or later updates', () => {
  const f = fixture(); f.api.update({ cells: f.cells, selectedId: pool[0].id });
  const marker = f.root.querySelector('.am-marker'); f.api.destroy(); f.api.destroy();
  assert.deepEqual(f.root.children, [f.original]);
  marker.click(); f.api.update({ cells: f.cells });
  assert.deepEqual(f.selected, []); assert.deepEqual(f.root.children, [f.original]);
});
