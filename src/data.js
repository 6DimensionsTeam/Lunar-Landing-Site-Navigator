// Reads and decodes the data files produced by tools/. All binaries are inlined into the final single-file HTML as data URIs.
import terrainMeta from './data/terrain.json';
import ephemMeta from './data/ephem.json';
import sitesMeta from './data/sites.json';
import zonesMeta from './data/zones.json';
import validation from './data/validation.json';
import heroUrl from './data/terrain_hero.bin?inline';
import innerUrl from './data/terrain_inner.bin?inline';
import outerUrl from './data/terrain_outer.bin?inline';
import ephemUrl from './data/ephem.bin?inline';
import zonesUrl from './data/zones.bin?inline';
import starsUrl from './data/stars.bin?inline';
import earthDayUrl from './data/earth_day.jpg?inline';
import earthNightUrl from './data/earth_night.jpg?inline';
import stationUrl from './data/station.glb?inline';
import roverUrl from './data/rover.glb?inline';

async function bytes(url) {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

async function inflate(u8) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Reverse of the encoding in tools/prep_dem.py: zlib → zigzag → gradient predictor, giving heights (m).
function decodeHeights(raw, n, scale) {
  const zz = new Uint16Array(raw.buffer, raw.byteOffset, n * n);
  const dn = new Int16Array(n * n);
  const out = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    const row = r * n;
    for (let c = 0; c < n; c++) {
      const i = row + c;
      const z = zz[i];
      const res = (z >>> 1) ^ -(z & 1);
      let pred = 0;
      if (r === 0) pred = c > 0 ? dn[i - 1] : 0;
      else if (c === 0) pred = dn[i - n];
      else pred = dn[i - 1] + dn[i - n] - dn[i - n - 1];
      const v = (((res + pred + 32768) % 65536) + 65536) % 65536 - 32768;
      dn[i] = v;
      out[i] = v * scale;
    }
  }
  return out;
}

export async function loadAll(onProgress = () => {}) {
  const tiles = {};
  for (const [key, url] of [['hero', heroUrl], ['inner', innerUrl], ['outer', outerUrl]]) {
    const meta = terrainMeta.tiles[key];
    const raw = await inflate(await bytes(url));
    tiles[key] = { ...meta, heights: decodeHeights(raw, meta.size, terrainMeta.dn_scale_m) };
    onProgress(key, meta);
  }
  const zones = await inflate(await bytes(zonesUrl));
  onProgress('zones', { size: zonesMeta.size, cell_m: zonesMeta.cell_m });
  const eph = await bytes(ephemUrl);
  const ephem = new Float32Array(eph.buffer, eph.byteOffset, eph.byteLength / 4);
  const st = await bytes(starsUrl);
  const stars = new DataView(st.buffer, st.byteOffset, st.byteLength);
  onProgress('ephem', { count: ephemMeta.count, step_hours: ephemMeta.step_hours, stars: st.byteLength / 8 });
  return {
    radiusKm: terrainMeta.radius_m / 1000,
    tiles,
    ephem,
    ephemMeta,
    stars,
    starCount: st.byteLength / 8,
    sites: sitesMeta,
    zones,
    zonesMeta,
    validation,
    earthDayUrl,
    earthNightUrl,
    stationUrl,
    roverUrl,
  };
}
