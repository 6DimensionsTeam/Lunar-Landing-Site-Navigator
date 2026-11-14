// Landing-zone map: decodes src/data/zones.bin and answers what kind of ground is at a
// point, for colouring the surface and for the readout shown on hover.
//
// The grid is south polar stereographic on the same projection and the same half extent
// as the inner terrain tile, so a map coordinate indexes it directly with no reprojection.
// A cell is 480 m across, which is the honest limit of what a value here means: it is an
// area characteristic, not a point measurement. Figures quoted for a named candidate site
// come from the full-resolution horizon profiles in sites.json instead, which is why the
// two can differ by a few percent at a site sitting on a sharp ridge.
//
// Built by tools/prep_zones.py from NASA LOLA and Diviner products; see zones.json for the
// per-plane sources and the citation.
import * as THREE from 'three';

// Zone colours. Ice reads cold blue, prime ground is the interface red so the eye lands on
// it first, the two partial classes are greys of different weight, rough is nearly invisible.
// Alpha carries how strongly a class tints the terrain underneath.
export const ZONE_STYLE = {
  ice:    { name: 'COLD TRAP',     rgba: [0x3d, 0x8b, 0xc4, 0.52], note: 'Maximum temperature stays below 110 K, so water ice can be stable. Too cold and too dark to land in.' },
  prime:  { name: 'PRIME GROUND',  rgba: [0xe2, 0x20, 0x0f, 0.58], note: 'Flat, well lit and in direct view of Earth. The combination is rare.' },
  sunlit: { name: 'SUNLIT',        rgba: [0xf2, 0xf4, 0xf5, 0.30], note: 'Well lit, but either too steep to land on or without a direct Earth link.' },
  flat:   { name: 'FLAT GROUND',   rgba: [0x8b, 0x97, 0x9e, 0.18], note: 'Landable slope, but poorly lit, so surface power is limited.' },
  rough:  { name: 'ROUGH',         rgba: [0x4a, 0x52, 0x57, 0.10], note: 'Too steep to land on and poorly lit.' },
};

export function createZones(bytes, meta) {
  const N = meta.size;
  const HALF_KM = meta.half_extent_m / 1000;
  const CELL_KM = meta.cell_m / 1000;
  const planeNames = meta.planes;
  const n2 = N * N;

  if (bytes.length !== planeNames.length * n2) {
    throw new Error(`zones.bin: expected ${planeNames.length * n2} bytes, got ${bytes.length}`);
  }

  // Undo the row predictor the packer applied: each stored byte is the signed difference
  // from the cell to its left, wrapped to int8, with the first column stored outright.
  const planes = {};
  for (let p = 0; p < planeNames.length; p++) {
    const src = bytes.subarray(p * n2, (p + 1) * n2);
    const out = new Uint8Array(n2);
    for (let r = 0; r < N; r++) {
      const row = r * N;
      let acc = 0;
      for (let c = 0; c < N; c++) {
        acc = (acc + (src[row + c] << 24 >> 24)) & 255;   // << 24 >> 24 reads the byte as int8
        out[row + c] = acc;
      }
    }
    planes[planeNames[p]] = out;
  }

  const ID_TO_NAME = Object.fromEntries(Object.entries(meta.zones).map(([k, v]) => [v, k]));
  const scale = meta.scales;
  const decode = (key, raw) => {
    const s = scale[key];
    return s.lo + (raw / (s.levels - 1)) * (s.hi - s.lo);
  };

  // Map coordinates (km, the same frame as geo.js) to a cell index, or -1 outside the grid
  function indexAtMap(x, y) {
    const c = Math.floor((x / (2 * HALF_KM) + 0.5) * N);
    const r = Math.floor((0.5 - y / (2 * HALF_KM)) * N);
    if (c < 0 || c >= N || r < 0 || r >= N) return -1;
    return r * N + c;
  }

  function at(x, y) {
    const i = indexAtMap(x, y);
    if (i < 0) return null;
    const id = planes.class[i];
    const key = ID_TO_NAME[id];
    if (!key || key === 'unmapped') return null;
    const style = ZONE_STYLE[key];
    return {
      zone: key,
      name: style.name,
      note: style.note,
      slopeDeg: decode('slope_deg', planes.slope_deg[i]),
      sun: decode('sun', planes.sun[i]),
      earth: decode('earth', planes.earth[i]),
      tmaxK: decode('tmax_k', planes.tmax_k[i]),
      iceDistKm: decode('ice_dist_m', planes.ice_dist_m[i]) / 1000,
      // What the three terrain questions reduce to, so a caller does not re-derive them
      flat: key === 'flat' || key === 'prime',
      iceStable: key === 'ice',
      wellLit: key === 'sunlit' || key === 'prime',
    };
  }

  // Latitude/longitude, matching latLonToMap in geo.js
  function atLatLon(latDeg, lonDeg) {
    const R = meta.radius_m / 1000;
    const r = 2 * R * Math.tan(THREE.MathUtils.degToRad(90 - Math.abs(latDeg)) / 2);
    const lon = THREE.MathUtils.degToRad(lonDeg);
    return at(r * Math.sin(lon), r * Math.cos(lon));
  }

  // RGBA texture of the class plane, for tinting the surface. Nearest filtering on purpose:
  // the classes are categories, and blending two of them would invent a third.
  function texture() {
    const data = new Uint8Array(n2 * 4);
    for (let i = 0; i < n2; i++) {
      const key = ID_TO_NAME[planes.class[i]];
      const s = key && key !== 'unmapped' ? ZONE_STYLE[key] : null;
      if (!s) continue;
      const [r, g, b, a] = s.rgba;
      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = Math.round(a * 255);
    }
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }

  return { at, atLatLon, texture, planes, meta, size: N, halfExtentKm: HALF_KM, cellKm: CELL_KM, style: ZONE_STYLE };
}
