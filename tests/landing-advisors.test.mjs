import test from 'node:test';
import assert from 'node:assert/strict';
import { advisors, reviewLanding } from '../src/landing-advisors.js';
test('every historical advisor has an official source and no fabricated veto', () => {
  assert.equal(advisors.length, 3);
  for (const result of reviewLanding({})) {
    assert.match(result.source, /^https:\/\//);
    assert.ok(result.evidence && result.question && result.limit);
    assert.equal(result.status, 'NOT VERIFIED');
    assert.equal('score' in result, false);
    assert.equal('fails' in result, false);
  }
});
test('terrain evidence is contextual and missing or invalid data never proves safety', () => {
  const site={elev_m:1737,horizon_cdeg:[100,200,NaN]};
  const result=reviewLanding(site);
  assert.equal(result[0].observations.length,2);
  assert.match(result[0].observations[1],/1.00 to 2.00/);
  assert.equal(result[1].observations.length,0);
  assert.equal(reviewLanding({elev_m:NaN})[0].observations.length,0);
  assert.ok(Number.isNaN(site.horizon_cdeg[2]));
});
