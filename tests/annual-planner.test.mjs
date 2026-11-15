import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { buildAnnualPlan } from '../src/annual-planner.js';
import { candidatePool, rankSites } from '../src/rank.js';
import { createZones } from '../src/zones.js';

const readJSON = file => JSON.parse(readFileSync(new URL(`../src/data/${file}`, import.meta.url), 'utf8'));
const realData = { sites: readJSON('sites.json'), candidates: readJSON('candidates.json') };
const realZones = createZones(inflateSync(readFileSync(new URL('../src/data/zones.bin', import.meta.url))), readJSON('zones.json'));
const ground = { zone: 'prime', flat: true, iceLikely: false, slopeDeg: 2, iceDistKm: 2 };
const zones = { atLatLon: () => ({ ...ground }) };
const stats = (value = 80, dark = 12) => ({ sun_visible_pct: value, earth_visible_pct: value, both_pct: value, longest_dark_h: dark });
const site = (id, annual, aggregate = stats(99)) => ({ id, en: id, lat: -89, lon: 0, stats: aggregate, stats_by_year: annual });
const fixture = (years, sites, found = []) => ({ sites: { stats_years: years, sites }, candidates: { candidates: found } });
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); Object.values(value).forEach(deepFreeze);
  }
  return value;
}

for (const needs of [{}, { craterFloor: true, iceNearby: true, continuousComm: true, maxDarkH: 300 }]) {
  test(`every real annual cell preserves the complete original rank entry: ${JSON.stringify(needs)}`, () => {
    const plan = buildAnnualPlan({ data: realData, zones: realZones, needs });
    const pool = candidatePool(realData);
    assert.equal(plan.rows.length, 19);
    assert.equal(plan.years.length, 15);
    assert.equal(plan.rows.reduce((count, row) => count + row.cells.length, 0), 285);
    assert.deepEqual(plan.years, Array.from({ length: realData.sites.stats_years[1] - realData.sites.stats_years[0] + 1 }, (_, i) => realData.sites.stats_years[0] + i));
    for (const summary of plan.yearSummaries) {
      const expected = rankSites(pool, realZones, summary.year, needs);
      assert.equal(summary.cells.length, expected.length);
      assert.equal(summary.unknownCount, 0);
      for (let i = 0; i < expected.length; i++) {
        const cell = summary.cells[i];
        assert.deepEqual(cell.entry, expected[i]);
        // Comparing every key automatically protects future ranking and verdict fields.
        for (const key of Object.keys(expected[i])) assert.deepEqual(cell[key], expected[i][key]);
        assert.equal(cell.rank, i + 1);
        assert.equal(cell.status, expected[i].meetsAll ? 'feasible' : 'infeasible');
        assert.equal(cell.stats, cell.site.stats_by_year[String(summary.year)]);
      }
      assert.equal(summary.feasibleCount, expected.filter(entry => entry.meetsAll).length);
      assert.equal(summary.infeasibleCount, expected.filter(entry => !entry.meetsAll).length);
    }
  });
}

test('real requirements with no feasible annual entries never produce a failing recommendation', () => {
  const plan = buildAnnualPlan({ data: realData, zones: realZones,
    needs: { craterFloor: true, iceNearby: true, continuousComm: true, maxDarkH: 1 } });
  assert.equal(plan.recommendation, null);
  assert.equal(plan.earliestFeasible, null);
  assert.deepEqual(plan.noFitYears, plan.years);
  assert.equal(plan.robustSites.length, 0);
  assert.ok(plan.yearSummaries.every(summary => summary.noFit && summary.feasibleCount === 0 && summary.unknownCount === 0));
});

test('planning start excludes past winners and retains an earlier feasible alternative', () => {
  const data = fixture([2031, 2033], [
    site('A', { 2031: stats(100), 2032: stats(60), 2033: stats(60) }),
    site('B', { 2031: stats(90), 2032: stats(70), 2033: stats(95) })
  ]);
  const plan = buildAnnualPlan({ data, zones, fromYear: 2032 });
  assert.equal(plan.recommendation.site.id, 'B');
  assert.equal(plan.recommendation.year, 2033);
  assert.equal(plan.earliestFeasible.year, 2032);
  assert.equal(plan.earliestFeasible.site.id, 'B');
  assert.ok(plan.recommendation.year >= plan.fromYear);
  assert.equal(plan.rows[0].bestYear, 2031); // Row best years cover the explicitly full catalog.
  assert.equal(buildAnnualPlan({ data, zones, fromYear: 2034 }).recommendation, null);
  assert.equal(buildAnnualPlan({ data, zones, fromYear: 2034 }).earliestFeasible, null);
});

test('ties choose the earliest year and the original rank order deterministically', () => {
  const annual = { 2031: stats(), 2032: stats(), 2033: stats() };
  const data = fixture([2031, 2033], [site('B', annual), site('A', annual)], [site('0', annual)]);
  const plan = buildAnnualPlan({ data, zones });
  assert.equal(plan.recommendation.year, 2031);
  assert.equal(plan.recommendation.site.id, 'A');
  assert.equal(plan.earliestFeasible.site.id, 'A');
  assert.deepEqual(plan.rows[0].bestYears, [2031, 2032, 2033]);
  assert.equal(plan.rows[0].bestYear, 2031);
  assert.equal(plan.robustSites.length, 3);
  assert.ok(plan.rows.every(row => row.allYearsMeet));
});

test('current-year failure yields only a later feasible option', () => {
  const data = fixture([2031, 2033], [site('A', { 2031: stats(80, 48), 2032: stats(70, 12), 2033: stats(90, 12) })]);
  const plan = buildAnnualPlan({ data, zones, needs: { maxDarkH: 24 }, fromYear: 2031 });
  assert.deepEqual(plan.noFitYears, [2031]);
  assert.equal(plan.earliestFeasible.year, 2032);
  assert.equal(plan.recommendation.year, 2033);
  assert.deepEqual(plan.rows[0].feasibleYears, [2032, 2033]);
  assert.equal(plan.rows[0].allYearsMeet, false);
});

test('missing annual data stays unknown instead of using a favorable aggregate fallback', () => {
  const data = fixture([2031, 2032], [
    site('A', { 2032: stats(99, 48) }, stats(100, 0)),
    site('B', { 2031: stats(99, 48), 2032: stats(99, 48) })
  ]);
  const plan = buildAnnualPlan({ data, zones, needs: { maxDarkH: 1 } });
  const missing = plan.rows[0].cells[0];
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.entry, null);
  assert.equal(missing.stats, null);
  assert.equal(missing.score, null);
  assert.equal(missing.meetsAll, null);
  assert.deepEqual(missing.fails, []);
  assert.deepEqual(missing.verdicts, []);
  assert.match(missing.unknownReason, /missing/);
  assert.deepEqual(plan.unknownYears, [2031]);
  assert.deepEqual(plan.noFitYears, [2032]);
  assert.equal(plan.yearSummaries[0].status, 'unknown');
  assert.equal(plan.yearSummaries[0].complete, false);
  assert.equal(plan.yearSummaries[0].noFit, false);
  assert.equal(plan.recommendation, null);
  assert.equal(plan.robustSites.length, 0);
});

test('an absent annual map and incomplete required metrics are unknown; optional fields are optional', () => {
  const absent = site('A', undefined);
  const incomplete = site('B', { 2031: { ...stats(), both_pct: undefined } });
  const valid = site('C', { 2031: stats() });
  const plan = buildAnnualPlan({ data: fixture([2031, 2031], [absent, incomplete, valid]), zones });
  assert.equal(plan.rows[0].cells[0].status, 'unknown');
  assert.equal(plan.rows[1].cells[0].status, 'unknown');
  assert.match(plan.rows[1].cells[0].unknownReason, /both_pct/);
  assert.equal(plan.rows[2].cells[0].status, 'feasible');
  assert.equal(plan.recommendation.site.id, 'C');
  assert.equal(plan.yearSummaries[0].unknownCount, 2);
  assert.equal(plan.yearSummaries[0].feasibleCount, 1);
  assert.equal(plan.yearSummaries[0].complete, false);
  assert.deepEqual(plan.robustSites.map(row => row.site.id), ['C']);
});

test('all-unknown and empty catalogs do not claim all requirements failed', () => {
  const unknown = buildAnnualPlan({ data: fixture([2031, 2032], [site('A', {})]), zones });
  assert.deepEqual(unknown.noFitYears, []);
  assert.deepEqual(unknown.unknownYears, [2031, 2032]);
  assert.equal(unknown.recommendation, null);
  const empty = buildAnnualPlan({ data: fixture([2031, 2032], []), zones });
  assert.deepEqual(empty.noFitYears, []);
  assert.deepEqual(empty.robustSites, []);
  assert.equal(empty.recommendation, null);
});

test('metadata validates its inclusive range and never inserts hardcoded years', () => {
  const valid = buildAnnualPlan({ data: fixture([2051, 2052], [site('A', { 2051: stats(), 2052: stats() })]), zones });
  assert.deepEqual(valid.years, [2051, 2052]);
  assert.equal(valid.fromYear, 2051);
  for (const range of [undefined, [], [2031], [2031, 2032, 2033], [2033, 2031], ['2031', 2033], [2031.5, 2033], [2031, Infinity]]) {
    assert.throws(() => buildAnnualPlan({ data: fixture(range, []), zones }), TypeError);
  }
  for (const fromYear of [2031.5, '2031', NaN, Infinity]) {
    assert.throws(() => buildAnnualPlan({ data: fixture([2031, 2033], []), zones, fromYear }), TypeError);
  }
});

test('frozen data and needs are accepted without mutation, including extra statistics', () => {
  const customStats = { ...stats(), future_metric: { classification: 'retained' } };
  const data = deepFreeze(fixture([2031, 2032], [site('A', { 2031: customStats, 2032: stats() })]));
  const needs = deepFreeze({ craterFloor: true, iceNearby: true, continuousComm: true, maxDarkH: 24, futureRequirement: 'preserved input' });
  const before = JSON.stringify({ data, needs });
  const plan = buildAnnualPlan({ data, zones, needs });
  assert.equal(JSON.stringify({ data, needs }), before);
  assert.equal(plan.rows[0].cells[0].stats.future_metric, customStats.future_metric);
  assert.deepEqual(plan.rows[0].cells[0].verdicts, rankSites(candidatePool(data), zones, 2031, needs)[0].verdicts);
  assert.ok(plan.rows[0].allYearsMeet);
});
