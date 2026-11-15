// The robustness trial: what it counts, and what it must never claim.
//
// These run against the shipped data, not a fixture, because the claim the screen makes is about
// this pool. If a data regeneration changes which site is most durable, that is a real finding
// and this test should be read, not silenced.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildWorlds, runWorlds, summarise, DARK_STEPS } from '../src/worlds.js';
import { candidatePool } from '../src/rank.js';

const sites = JSON.parse(await readFile(new URL('../src/data/sites.json', import.meta.url), 'utf8'));
const candidates = JSON.parse(await readFile(new URL('../src/data/candidates.json', import.meta.url), 'utf8'));
const pool = candidatePool({ sites, candidates });

// The trial only reads stats and the ground classification. A stub keeps the test independent of
// the 632x632 zone binary while still exercising both branches of every ground requirement.
const zones = {
  atLatLon: (lat) => ({
    zone: 'prime',
    slopeDeg: 4,
    // Latitude stands in for ice distance so the iceNearby axis actually separates sites here.
    iceDistKm: Math.abs(lat) > 87 ? 3 : 40,
    iceLikely: false,
    flat: true,
  }),
};

test('a world set is deterministic, unique, and spread over every axis', () => {
  const a = buildWorlds({ startYear: 2026, endYear: 2040, count: 100 });
  const b = buildWorlds({ startYear: 2026, endYear: 2040, count: 100 });
  assert.equal(a.length, 100);
  assert.deepEqual(a.map((w) => w.label), b.map((w) => w.label), 'same inputs must give the same worlds in the same order');

  const keys = new Set(a.map((w) => `${w.year}|${w.needs.maxDarkH}|${w.needs.continuousComm}|${w.needs.craterFloor}|${w.needs.iceNearby}`));
  assert.equal(keys.size, 100, 'no requirement set may be tested twice');

  // Every year in the measured record appears, and no year dominates.
  const years = new Map();
  for (const w of a) years.set(w.year, (years.get(w.year) || 0) + 1);
  assert.equal(years.size, 15, 'all fifteen measured years are represented');
  for (const [y, n] of years) assert.ok(n >= 5 && n <= 8, `year ${y} appears ${n} times, which is lopsided`);

  // Each boolean axis is close to an even split, so none of them is effectively always-on.
  for (const key of ['continuousComm', 'craterFloor', 'iceNearby']) {
    const on = a.filter((w) => w.needs[key]).length;
    assert.ok(on >= 40 && on <= 60, `${key} is on in ${on} of 100 sets, not a balanced sweep`);
  }
  // Darkness steps are measured figures from the pool, never round invented numbers.
  const darkUsed = new Set(a.map((w) => w.needs.maxDarkH));
  for (const d of darkUsed) assert.ok(DARK_STEPS.includes(d), `${d} h is not one of the measured steps`);
});

test('every darkness step is a figure some site in the pool actually achieves', () => {
  // The hardest world must be exactly as hard as the best ground allows. A step below every
  // site's measured night would make all sites fail in that world and the trial would say
  // nothing; a step above every site's night would be a free pass.
  const nights = pool.map((s) => s.stats.longest_dark_h).sort((x, y) => x - y);
  for (const step of DARK_STEPS) {
    assert.ok(step >= nights[0], `step ${step} h is below the shortest measured night (${nights[0]} h)`);
    assert.ok(nights.some((n) => n <= step), `step ${step} h admits no site`);
  }
  assert.equal(DARK_STEPS[0], nights[0], 'the hardest step should be the best site, not harder');
});

test('survival is counted per world and the ranking is by survival, not score', () => {
  const worlds = buildWorlds({ startYear: 2026, endYear: 2040, count: 100 });
  const res = runWorlds(pool, zones, worlds);

  assert.equal(res.timeline.length, 100);
  assert.equal(res.sites.length, pool.length);

  for (const s of res.sites) {
    assert.ok(s.survived >= 0 && s.survived <= 100, `${s.site.id}: survival out of range`);
    assert.equal(s.worlds, 100);
    // The count must equal the timeline: a site is alive in exactly the worlds it is not dead in.
    const alive = res.timeline.filter((t) => t.alive.includes(s.site.id)).length;
    assert.equal(s.survived, alive, `${s.site.id}: tally disagrees with the timeline`);
    assert.equal(s.deaths.length, 100 - s.survived, `${s.site.id}: deaths plus survivals must be every world`);
  }

  // Sorted by survival first. Score may only break a tie.
  for (let i = 1; i < res.sites.length; i++) {
    const prev = res.sites[i - 1], cur = res.sites[i];
    assert.ok(prev.survived >= cur.survived, 'sites must be ordered by survival count');
    if (prev.survived === cur.survived) {
      assert.ok(prev.meanScore >= cur.meanScore - 1e-12, 'ties break on mean score');
    }
  }
});

test('the most durable site is not always the highest-scoring one', () => {
  // This is the whole premise of the screen, and on the shipped pool it genuinely holds:
  // Malapert Massif scores highest (best Earth link) but carries the pool's worst polar night,
  // so it is eliminated whenever the darkness limit tightens. If a data change ever makes the
  // top scorer also the most durable, this assertion should be revisited rather than deleted --
  // the screen would still be correct, but its headline example would need rewording.
  const res = runWorlds(pool, zones, buildWorlds({ startYear: 2026, endYear: 2040, count: 100 }));
  const mostDurable = res.sites[0];
  const bestScore = [...res.sites].sort((a, b) => b.meanScore - a.meanScore)[0];
  assert.notEqual(mostDurable.site.id, bestScore.site.id,
    'the premise of the trial is that durability and score can disagree');
  assert.ok(mostDurable.survived > bestScore.survived,
    'the most durable site must survive more worlds than the best scorer');
});

test('the summary is a count over a chosen set, never a probability', () => {
  const res = runWorlds(pool, zones, buildWorlds({ startYear: 2026, endYear: 2040, count: 100 }));
  const text = summarise(res);
  assert.match(text, /\d+ of 100 requirement sets/, 'the wording must name the set it counted over');
  // Words that would turn a count into a forecast nothing here supports.
  for (const banned of [/\blikel/i, /\bprobabilit/i, /\bchance\b/i, /\bodds\b/i, /\bexpected\b/i, /\brisk of\b/i]) {
    assert.doesNotMatch(text, banned, `the summary must not imply a probability (${banned})`);
  }
});

test('a weakness is only reported when the site actually failed on it', () => {
  const res = runWorlds(pool, zones, buildWorlds({ startYear: 2026, endYear: 2040, count: 100 }));
  for (const s of res.sites) {
    if (s.survived === 100) {
      assert.equal(s.weakness, null, `${s.site.id} survived everything but was given a weakness`);
      continue;
    }
    assert.ok(s.weakness, `${s.site.id} failed ${100 - s.survived} worlds but reports no weakness`);
    // The named weakness must appear in its own failure messages, not be inferred.
    const reasons = s.deaths.flatMap((d) => d.why).join(' ');
    const map = { 'Earth link': /Earth link/, 'Night length': /Longest night/, 'Crater floor': /crater floor|too steep/, 'Ice distance': /shadow|ice/ };
    if (map[s.weakness]) assert.match(reasons, map[s.weakness], `${s.site.id}: weakness not supported by its failures`);
  }
});

test('an empty pool and a zero-world set degrade without throwing', () => {
  const empty = runWorlds([], zones, buildWorlds({ startYear: 2026, endYear: 2040, count: 4 }));
  assert.equal(empty.sites.length, 0);
  assert.match(summarise(empty), /No sites/);
  const none = runWorlds(pool, zones, []);
  assert.equal(none.timeline.length, 0);
  assert.ok(none.sites.every((s) => s.survived === 0));
});
