import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import * as THREE from 'three';
import { makeHeightSampler, latLonToMap, mapToScene } from '../../src/geo.js';
import { Ephemeris } from '../../src/ephemeris.js';
import { createRig } from '../../src/rig.js';
import { candidatePool } from '../../src/rank.js';

const sourceURL = new URL('../../src/', import.meta.url);
let loaded;
export function loadTerrainFixture() {
  return loaded ??= (async () => {
    const [terrain, metadata, sites, candidates, binary, dataSource, mainSource] = await Promise.all([
      readFile(new URL('data/terrain.json', sourceURL), 'utf8').then(JSON.parse),
      readFile(new URL('data/ephem.json', sourceURL), 'utf8').then(JSON.parse),
      readFile(new URL('data/sites.json', sourceURL), 'utf8').then(JSON.parse),
      readFile(new URL('data/candidates.json', sourceURL), 'utf8').then(JSON.parse),
      readFile(new URL('data/ephem.bin', sourceURL)),
      readFile(new URL('data.js', sourceURL), 'utf8'),
      readFile(new URL('main.js', sourceURL), 'utf8'),
    ]);
    // Execute the application's pure decoder and crater measurement, avoiding Vite's
    // asset imports and avoiding a second, test-only implementation of either.
    const decodeStart = dataSource.indexOf('function decodeHeights(');
    const decodeEnd = dataSource.indexOf('export async function loadAll', decodeStart);
    assert.ok(decodeStart >= 0 && decodeEnd > decodeStart);
    const decode = new Function(`${dataSource.slice(decodeStart, decodeEnd)}; return decodeHeights;`)();
    const craterStart = mainSource.indexOf('function measureCrater(');
    const craterEnd = mainSource.indexOf('async function boot()', craterStart);
    assert.ok(craterStart >= 0 && craterEnd > craterStart);
    const measureCrater = new Function('THREE', `${mainSource.slice(craterStart, craterEnd)}; return measureCrater;`)(THREE);
    const tiles = {};
    for (const [name, meta] of Object.entries(terrain.tiles)) {
      const raw = inflateSync(await readFile(new URL(`data/${meta.file}`, sourceURL)));
      tiles[name] = { ...meta, heights: decode(raw, meta.size, terrain.dn_scale_m) };
      assert.equal(tiles[name].heights.length, meta.size ** 2);
    }
    const R = terrain.radius_m / 1000, heightAt = makeHeightSampler(tiles);
    const groundAt = (m, above = 0) => mapToScene(R, m, heightAt(m) + above);
    const crater = measureCrater(heightAt, latLonToMap(R, -89.625, 118.5));
    const homeUTC = mainSource.match(/const HOME_EPOCH_UTC = '([^']+)'/)?.[1];
    assert.ok(homeUTC);
    const buffer = new Float32Array(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
    return { tiles, R, heightAt, groundAt, crater, sites: sites.sites, candidatePool: candidatePool({ sites, candidates }),
      createRig(camera) {
        const eph = new Ephemeris(buffer, metadata, R);
        eph.update((Date.parse(homeUTC) - eph.start) / 3600e3);
        return createRig({ R, camera, eph, groundAt, heightAt, crater });
      },
    };
  })();
}
