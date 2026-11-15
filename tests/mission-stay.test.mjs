import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Ephemeris } from '../src/ephemeris.js';
import { buildMissionConfig, dateToHours, getMissionBounds, MIN_STAY_H } from '../src/mission.js';

// Read the bundled ephemeris without modifying or regenerating any data assets.
const dataURL = new URL('../src/data/', import.meta.url);
const [binary, metadata, terrain] = await Promise.all([
  readFile(new URL('ephem.bin', dataURL)),
  readFile(new URL('ephem.json', dataURL), 'utf8').then(JSON.parse),
  readFile(new URL('terrain.json', dataURL), 'utf8').then(JSON.parse),
]);
const samples = new Float32Array(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
const eph = new Ephemeris(samples, metadata, terrain.radius_m / 1000);
const config = (arriveH, stayH, needs) => buildMissionConfig(eph, { arriveH, stayH, needs });

function syntheticEphemeris(year, maxH) {
  const start = Date.UTC(year, 0, 1);
  return {
    startYear: year, endYear: year, start, stepH: 3,
    count: Math.ceil(maxH / 3) + 1, maxH,
    hoursToDate: h => new Date(start + h * 3600e3),
  };
}

test('the one-day product minimum accepts24h and longer fractional stays', () => {
  assert.equal(MIN_STAY_H, 24);
  for (const stayH of [24, 24.25, 36.25, 168]) {
    assert.equal(config(84, stayH).stayH, stayH);
  }
});

test('sub-day, nonnumeric and nonfinite stays are rejected without coercion', () => {
  for (const stayH of [-1, 0, .01, 1, 23.999999, NaN, Infinity, -Infinity, '24', null, undefined]) {
    assert.throws(() => config(84, stayH), RangeError, `stayH=${String(stayH)}`);
  }
});

test('arrival bounds reserve24h from actual metadata and keep the ephemeris endpoint unchanged', () => {
  const bounds = getMissionBounds(eph);
  assert.equal(eph.count, metadata.count);
  assert.equal(samples.length, metadata.count * 14);
  assert.equal(bounds.maxH, eph.maxH);
  assert.equal(bounds.maxArrivalH, eph.maxH - 24);
  assert.equal(bounds.maxDate, eph.hoursToDate(bounds.maxArrivalH).toISOString().slice(0, 10));
  assert.equal(bounds.minDate, `${eph.startYear}-01-01`);
  assert.ok(bounds.maxArrivalH > eph.count, 'the bound is measured in hours, not sample indices');
});

test('the real fractional endpoint permits exactly24h and rejects any overshoot', () => {
  const latestArrival = eph.maxH - 24;
  const tail = config(latestArrival, 24);
  assert.equal(tail.arriveH + tail.stayH, eph.maxH);
  assert.throws(() => config(latestArrival + 1 / 60, 24), RangeError);
  assert.throws(() => config(latestArrival, 24 + 1 / 60), RangeError);
});

test('minute-based arrival entry floors the real cap and rejects the following minute', () => {
  const { maxArrivalH } = getMissionBounds(eph);
  const minuteMs = Math.floor(eph.hoursToDate(maxArrivalH).getTime() / 60000) * 60000;
  const allowedH = dateToHours(new Date(minuteMs), eph);
  assert.ok(allowedH <= maxArrivalH);
  assert.ok(allowedH + 24 <= eph.maxH);
  assert.equal(config(allowedH, 24).stayH, 24);
  assert.throws(() => config(dateToHours(new Date(minuteMs + 60000), eph), 24), RangeError);
});

test('a changed epoch with an exact-minute endpoint includes equality without subtracting an extra minute', () => {
  const future = syntheticEphemeris(eph.endYear + 7, 69);
  const bounds = getMissionBounds(future);
  assert.equal(bounds.maxArrivalH, 45);
  assert.equal(bounds.maxDate, `${future.startYear}-01-02`);
  const allowed = new Date(Date.UTC(future.startYear, 0, 2, 21));
  const arriveH = dateToHours(allowed, future);
  assert.equal(arriveH, 45);
  const tail = buildMissionConfig(future, { arriveH, stayH: 24 });
  assert.equal(tail.arriveH + tail.stayH, future.maxH);
  assert.throws(() => buildMissionConfig(future, { arriveH: arriveH + 1 / 60, stayH: 24 }), RangeError);
  assert.throws(() => getMissionBounds(syntheticEphemeris(future.startYear, 23.999)), RangeError);
  assert.equal(buildMissionConfig(syntheticEphemeris(future.startYear, 24), { arriveH: 0, stayH: 24 }).stayH, 24);
});

test('invalid arrival times and darkness limits remain rejected independently of the new minimum', () => {
  for (const arriveH of [-1, NaN, Infinity, -Infinity, '84', null, undefined, eph.maxH]) {
    assert.throws(() => config(arriveH, 24), RangeError, `arriveH=${String(arriveH)}`);
  }
  for (const maxDarkH of [-1, NaN, Infinity, '72']) {
    assert.throws(() => config(84, 24, { maxDarkH }), RangeError);
  }
  assert.equal(config(84, 24, { maxDarkH: 0 }).needs.maxDarkH, 0);
});

test('the fixed mission contract and early-departure clamp are unchanged', () => {
  assert.deepEqual(config(100, 36.25, { craterFloor: true, iceNearby: false, continuousComm: true, maxDarkH: 0 }), {
    arriveH: 100, launchH: 16, stayH: 36.25,
    needs: { craterFloor: true, iceNearby: false, continuousComm: true, maxDarkH: 0 },
  });
  assert.deepEqual(config(0, 24), {
    arriveH: 0, launchH: 0, stayH: 24,
    needs: { craterFloor: false, iceNearby: false, continuousComm: false, maxDarkH: 72 },
  });
});
