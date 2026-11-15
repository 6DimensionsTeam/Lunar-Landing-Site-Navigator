import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { candidatePool, rankSites, compareSites } from '../src/rank.js';
import { createZones } from '../src/zones.js';

const readJSON = file => JSON.parse(readFileSync(new URL(`../src/data/${file}`, import.meta.url), 'utf8'));
const realData = { sites: readJSON('sites.json'), candidates: readJSON('candidates.json') };
const realZones = createZones(inflateSync(readFileSync(new URL('../src/data/zones.bin', import.meta.url))), readJSON('zones.json'));
const ground = { zone: 'prime', flat: true, iceLikely: false, slopeDeg: 2, iceDistKm: 2 };
const zones = { atLatLon: () => ({ ...ground }) };
const stats = (sun, comms, dark, blind) => ({ sun_visible_pct: sun, earth_visible_pct: comms, both_pct: Math.min(sun, comms), longest_dark_h: dark, longest_blind_h: blind });
const site = (id, aggregate) => ({ id, en: id, lat: -89, lon: 0, stats: aggregate, stats_by_year: {} });
// The outage figures are the real ones for these three sites, because the point of carrying
// them is that they do not rank the sites the way the share does.
const pool = [
  site('A', stats(82.2, 51.9, 204, 336)),
  site('B', stats(88.9, 53.5, 222, 327)),
  site('D', stats(75.3, 84.8, 318, 123)),
];

test('compareSites keeps one row per ranked entry, in the same order rankSites produced', () => {
  const ranked = rankSites(pool, zones, null, {});
  const { rows } = compareSites(ranked);
  assert.equal(rows.length, ranked.length);
  assert.deepEqual(rows.map(r => r.site.id), ranked.map(e => e.site.id));
  for (let i = 0; i < rows.length; i++) assert.equal(rows[i].entry, ranked[i]);
});

test('every row carries the same four measured figures and an overall verdict, regardless of needs', () => {
  for (const needs of [{}, { continuousComm: 80, maxDarkH: 250, craterFloor: true, iceNearby: true }]) {
    const ranked = rankSites(pool, zones, null, needs);
    const { rows, columns } = compareSites(ranked);
    assert.deepEqual(columns.map(c => c.key), ['sun', 'comms', 'blind', 'dark', 'ground', 'ice', 'overall']);
    for (const row of rows) {
      assert.equal(row.cells.sun.value, `${row.entry.stats.sun_visible_pct.toFixed(1)}%`);
      assert.equal(row.cells.dark.value, `${row.entry.stats.longest_dark_h} h`);
      assert.equal(row.cells.overall.value, row.entry.meetsAll ? 'MEETS' : 'FAILS');
      assert.equal(row.cells.overall.verdict.pass, row.entry.meetsAll);
    }
  }
});

test('a column is graded only when at least one row actually has a verdict for it', () => {
  const noAsk = compareSites(rankSites(pool, zones, null, {}));
  for (const col of noAsk.columns) {
    // sun and blind have no verdict ever -- they are measured figures, not something any
    // requirement grades. blind in particular is reported precisely because nothing filters on
    // it: a share cannot express how long a single outage runs.
    if (col.key === 'overall' || col.key === 'sun' || col.key === 'blind') continue;
    assert.equal(col.graded, false, `${col.key} should not be graded with no requirements set`);
    for (const row of noAsk.rows) assert.equal(row.cells[col.key].verdict, null);
  }

  const askComms = compareSites(rankSites(pool, zones, null, { continuousComm: 80 }));
  const commsCol = askComms.columns.find(c => c.key === 'comms');
  assert.equal(commsCol.graded, true);
  assert.equal(askComms.columns.find(c => c.key === 'dark').graded, false);
  for (const row of askComms.rows) {
    assert.ok(row.cells.comms.verdict, `${row.site.id} should carry a comms verdict once continuousComm is asked for`);
    assert.equal(row.cells.comms.verdict.pass, row.entry.stats.earth_visible_pct >= 80);
  }
});

test('ground and ice cells read the zone classification, not just the requirement flags', () => {
  const noGround = { atLatLon: () => null };
  const ranked = rankSites(pool, noGround, null, { craterFloor: true, iceNearby: true });
  const { rows } = compareSites(ranked);
  for (const row of rows) {
    assert.equal(row.cells.ground.value, 'unmapped');
    assert.equal(row.cells.ice.value, '—');
    assert.equal(row.cells.ground.verdict.pass, false);
    assert.equal(row.cells.ice.verdict.pass, false);
  }
});

test('best marks the single most favourable raw value per graded column, high for sun/comms, low for dark/ice', () => {
  const { rows } = compareSites(rankSites(pool, zones, null, {}));
  const byId = id => rows.find(r => r.site.id === id);
  // B has the most sunlight (88.9), D the strongest Earth link (84.8) and the longest dark
  // spell (318, the worst), A the shortest dark spell (204, the best) and the weakest link.
  assert.equal(byId('B').cells.sun.best, true);
  assert.equal(byId('A').cells.sun.best, false);
  assert.equal(byId('D').cells.sun.best, false);
  assert.equal(byId('D').cells.comms.best, true);
  assert.equal(byId('A').cells.comms.best, false);
  assert.equal(byId('A').cells.dark.best, true);
  assert.equal(byId('D').cells.dark.best, false);
  // Exactly one winner per column here, since no two sites tie on sun, comms or dark.
  for (const key of ['sun', 'comms', 'dark']) {
    assert.equal(rows.filter(r => r.cells[key].best).length, 1, `${key} should have exactly one best row`);
  }
  // ground and overall have no numeric winner; neither cell carries a best flag at all.
  for (const row of rows) {
    assert.equal(row.cells.ground.best, undefined);
    assert.equal(row.cells.overall.best, undefined);
  }
});

test('a tie for the best raw value marks every tied row, and a missing figure never wins', () => {
  const tied = [site('X', stats(80, 60, 200)), site('Y', stats(80, 70, 200))];
  const { rows } = compareSites(rankSites(tied, zones, null, {}));
  assert.ok(rows.every(r => r.cells.sun.best), 'both rows share the top sunlight figure');
  assert.ok(rows.every(r => r.cells.dark.best), 'both rows share the shortest dark spell');

  // No row has an ice distance at all here, so the whole column has nothing to compare and
  // best is left unset rather than false for any of them -- the two read differently: "no
  // figure to judge" is not the same claim as "present, but not the best".
  const noGround = { atLatLon: () => null };
  const unmapped = compareSites(rankSites(pool, noGround, null, {}));
  for (const row of unmapped.rows) assert.equal(row.cells.ice.best, undefined, 'an unmapped site has no ice distance to win with');
});

// The reason the outage is reported at all: a share cannot express how long a single gap runs,
// and on this pool the two measures disagree about which site is worst. Reading the share alone
// invites "84.8%, so contact is fine" about the site that sits through a five-day outage.
test('the Earth link share and the longest outage do not rank the sites the same way', () => {
  const { rows, columns } = compareSites(rankSites(pool, zones, null, {}));
  const byId = id => rows.find(r => r.site.id === id);

  // D holds the best share and also the shortest outage; A holds the worst share and the
  // longest outage. What differs is the scale: the share spans 33 points, the outage a factor
  // of 2.7, so a reader who sees only the share cannot tell a 123 h gap from a 336 h one.
  assert.equal(byId('D').cells.comms.best, true);
  assert.equal(byId('D').cells.blind.best, true);
  assert.equal(byId('A').cells.blind.best, false);
  assert.equal(byId('D').cells.blind.value, '123 h');
  assert.equal(byId('A').cells.blind.value, '336 h');

  // Lower is better for an outage, and the column is never graded: no requirement filters on it.
  const blindCol = columns.find(c => c.key === 'blind');
  assert.equal(blindCol.better, 'low');
  assert.equal(blindCol.graded, undefined);
  for (const row of rows) assert.equal(row.cells.blind.verdict, undefined);

  // It sits next to the share it qualifies, not somewhere else in the table.
  const keys = columns.map(c => c.key);
  assert.equal(keys[keys.indexOf('comms') + 1], 'blind');
});

test('a site with no measured outage renders a dash rather than a figure', () => {
  const noBlind = [site('Z', stats(80, 60, 200, undefined))];
  const { rows } = compareSites(rankSites(noBlind, zones, null, {}));
  assert.equal(rows[0].cells.blind.value, '—');
  assert.equal(rows[0].cells.blind.raw, null);
});

test('compareSites runs over the real candidate pool and every candidate pool year without throwing', () => {
  const realPool = candidatePool(realData);
  assert.ok(realPool.length >= 6, 'the real pool should have at least the published NASA regions plus data-selected candidates');
  for (const needs of [{}, { continuousComm: true, maxDarkH: 300, craterFloor: true, iceNearby: true }]) {
    const { rows, columns } = compareSites(rankSites(realPool, realZones, null, needs));
    assert.equal(rows.length, realPool.length);
    assert.equal(columns.length, 7);
    for (const row of rows) {
      for (const col of columns) assert.ok(row.cells[col.key].value.length > 0, `${row.site.id}.${col.key} should render a value`);
    }
  }
});
