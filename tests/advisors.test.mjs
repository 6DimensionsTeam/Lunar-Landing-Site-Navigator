import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSite } from '../src/advisors.js';
const fields=['mission','year','source','failure','field','pass','value','note'];
test('pure contract returns sourced cases without certifying absent engineering evidence',()=>{
  for(const row of reviewSite()){
    assert.deepEqual(Object.keys(row),fields);
    assert.equal(row.pass,null);
    assert.match(row.source,/^https:\/\//);
    assert.ok(row.failure && row.note);
  }
});
test('reads contextual measurements, ignores candidate IDs and preserves inputs',()=>{
  const site={id:'new-longitude-id',elev_m:1737,horizon_cdeg:[100,200,NaN]};
  const entry={stats:{earth_visible_pct:100},fails:[],verdicts:[]};
  const before=structuredClone({site,entry});
  const rows=reviewSite(site,entry);
  assert.match(rows[0].value,/1.00 to 2.00/);
  assert.equal(rows.every(r=>r.pass===null),true);
  assert.deepEqual({site,entry},before);
  assert.deepEqual(reviewSite({...site,id:'different'},entry),rows);
});
test('missing and invalid measurements do not become a pass',()=>{
  assert.equal(reviewSite({elev_m:NaN,horizon_cdeg:[]})[0].pass,null);
  assert.equal(reviewSite({elev_m:NaN})[0].value,'No applicable measurements available');
});
