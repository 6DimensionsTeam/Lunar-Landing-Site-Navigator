import test from 'node:test';
import assert from 'node:assert/strict';
import { rankSites, explain } from '../src/rank.js';

const zones = { atLatLon: () => ({ zone: 'prime', flat: true, iceLikely: false, slopeDeg: 2, iceDistKm: 2 }) };
const site = {
  id: 'X', en: 'X', lat: -89, lon: 0,
  stats: { sun_visible_pct: 82, earth_visible_pct: 52, both_pct: 45, longest_dark_h: 204 },
  stats_by_year: {},
};
const evaluate = (maxDarkH) => rankSites([site], zones, null, { maxDarkH })[0];

// A darkness limit of 0 says the mission tolerates no darkness at all, which is the tightest
// demand the field can express. It was read as "no requirement" because the same `> 0` guard
// covers both an absent value and zero, so the strictest input scored exactly like leaving the
// field blank and was 300 times looser than typing 1.
test('a zero darkness limit is the strictest demand, not an absent one', () => {
  const none = evaluate(undefined);
  const zero = evaluate(0);
  const one = evaluate(1);

  assert.equal(none.verdicts.length, 0, 'an absent limit asks for nothing and reports no verdict');
  assert.equal(none.meetsAll, true);

  assert.equal(zero.verdicts.length, 1, 'a zero limit is a real requirement and must report its verdict');
  assert.equal(zero.verdicts[0].key, 'dark');
  assert.equal(zero.verdicts[0].pass, false, 'no site survives 204 h of night under a zero-hour limit');
  assert.equal(zero.meetsAll, false);
  assert.ok(zero.score < none.score, 'the strictest limit must not score the same as no limit');

  // Monotonic: a zero-hour limit must be at least as strict as a one-hour limit, not looser.
  assert.ok(zero.score <= one.score + 1e-9, 'a zero limit must not be looser than a one-hour limit');
  assert.equal(zero.verdicts[0].pass, one.verdicts[0].pass);
});

test('a zero darkness limit is named as a requirement, not as "no requirements set"', () => {
  const zero = evaluate(0);
  assert.doesNotMatch(explain(zero, { maxDarkH: 0 }), /No requirements were set/);
  assert.match(explain(zero, { maxDarkH: 0 }), /Longest night/);
  assert.match(explain(evaluate(undefined), { maxDarkH: undefined }), /No requirements were set/);
});

test('a limit the site can meet still passes, at zero or otherwise', () => {
  // The pool's own worst night is 204 h here, so a limit of exactly that passes; the guard
  // change must not turn every finite limit into a failure.
  const atLimit = evaluate(204);
  assert.equal(atLimit.meetsAll, true);
  assert.equal(atLimit.verdicts[0].pass, true);
});
