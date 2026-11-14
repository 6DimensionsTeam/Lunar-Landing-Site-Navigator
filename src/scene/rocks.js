// Rocks around the rover:
//   · The large rocks are the same set as the two rockLayer passes in the terrain shader (50 m and 18 m cells) — same
//     cells, same hashes: up close they become real 3D rocks, farther out they stay shader-drawn bumps and long
//     shadows, and the two agree at the crossover;
//   · rubble, gravel and fine pebbles exist only near the rover, scattered in metre-scale local coordinates, each with
//     a shadow decal stretched out along the sun.
// Coordinate convention as in rover.js: local = map coordinates relative to point A (metres).
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------- float32 replica of the GLSL hashes (hash12 / hash22 from detail.js) ----------
const f = Math.fround;
const fract = (x) => f(x - Math.floor(x));
function hash12(px, py) {
  let x = fract(f(px * f(0.1031))), y = fract(f(py * f(0.1031))), z = x;
  const d = f(f(f(x * f(y + f(33.33))) + f(y * f(z + f(33.33)))) + f(z * f(x + f(33.33))));
  x = f(x + d); y = f(y + d); z = f(z + d);
  return fract(f(f(x + y) * z));
}
function hash22(px, py) {
  let x = fract(f(px * f(0.1031))), y = fract(f(py * f(0.103))), z = fract(f(px * f(0.0973)));
  const d = f(f(f(x * f(y + f(33.33))) + f(y * f(z + f(33.33)))) + f(z * f(x + f(33.33))));
  x = f(x + d); y = f(y + d); z = f(z + d);
  return [fract(f(f(x + y) * z)), fract(f(f(x + z) * y))];
}
// Integer hash used only in JS (rubble)
function ihash(i, j, s) {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(s, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Rock shape: subdivided icosahedron, then a few layers of sine displacement plus a handful of cut planes for the
// edges; the bottom is flattened
function rockGeometry(detail, seed) {
  // Merge vertices first: everything outside the cut planes is smooth (an icosahedron shares no vertices, so computing normals directly gives a gem of flat facets)
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, detail).deleteAttribute('normal').deleteAttribute('uv'));
  const p = g.attributes.position, v = new THREE.Vector3();
  const cuts = [...Array(4)].map((_, k) => {
    const a = ihash(seed, k, 1) * Math.PI * 2, b = (ihash(seed, k, 2) - 0.3) * 1.6;
    return [new THREE.Vector3(Math.cos(a) * Math.cos(b), Math.sin(b), Math.sin(a) * Math.cos(b)), 0.62 + 0.25 * ihash(seed, k, 3)];
  });
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = Math.sin(v.x * 3.1 + seed) * Math.sin(v.y * 2.7 + seed * 1.7) * Math.sin(v.z * 3.3 + seed * 0.6);
    let r = 1 + 0.16 * n + 0.07 * Math.sin(v.x * 7.3 + v.z * 5.1 + seed * 3.0);
    for (const [d, k] of cuts) { const t = v.dot(d) * r; if (t > k) r *= k / t; }
    v.multiplyScalar(r);
    if (v.y < -0.35) v.y = -0.35 + (v.y + 0.35) * 0.3;
    p.setXYZ(i, v.x, v.y, v.z);
    const m = 0.86 + 0.14 * (Math.sin(v.x * 9 + seed) * Math.cos(v.z * 7 - seed) * 0.5 + 0.5);
    col[i * 3] = m; col[i * 3 + 1] = m; col[i * 3 + 2] = m * 1.01;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// Shadow decal: dragged from the rock's base along the anti-solar direction, the penumbra widening with distance (solar angular radius 0.27°)
const decalVert = /* glsl */ `
attribute vec3 aUvs;           // x along the shadow 0→1, y across −1→1 (in units of shadow width), z intensity
varying vec3 vUvs;
void main() { vUvs = aUvs; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const decalFrag = /* glsl */ `
varying vec3 vUvs;
void main() {
  float s = vUvs.x, w = abs(vUvs.y);
  float pen = 0.25 + 0.6 * s;                        // the farther out, the softer the edge
  float a = (1.0 - smoothstep(1.0 - pen, 1.0 + pen * 0.4, w)) * smoothstep(0.0, 0.04, s) * (1.0 - smoothstep(0.7, 1.0, s));
  gl_FragColor = vec4(vec3(1.0 - 0.62 * a * vUvs.z), 1.0);
}
`;

export function createRocks(ctx) {
  // ctx: anchor (point A in map km), toNear(lx, ly, dh, out), heightLocal(lx, ly) (km), vis(lx, ly) → [sun, key]
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: 1 });
  const variants = {
    big: [rockGeometry(3, 11), rockGeometry(3, 23), rockGeometry(3, 37)],
    small: [rockGeometry(1, 5), rockGeometry(1, 17), rockGeometry(1, 29)],
  };
  const CAP = { big: 64, small: 1400 };
  const meshes = {};
  for (const [kind, geos] of Object.entries(variants)) {
    meshes[kind] = geos.map((g) => {
      const m = new THREE.InstancedMesh(g, mat, CAP[kind]);
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color(1, 1, 1));
      m.castShadow = false;
      m.receiveShadow = kind === 'big';
      group.add(m);
      return m;
    });
  }

  const SEG = 8, DMAX = 1200;
  const dGeo = new THREE.BufferGeometry();
  const dPos = new Float32Array(DMAX * (SEG + 1) * 2 * 3), dUv = new Float32Array(DMAX * (SEG + 1) * 2 * 3);
  dGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3).setUsage(THREE.DynamicDrawUsage));
  dGeo.setAttribute('aUvs', new THREE.BufferAttribute(dUv, 3).setUsage(THREE.DynamicDrawUsage));
  const dIdx = new Uint32Array(DMAX * SEG * 6);
  for (let d = 0, k = 0; d < DMAX; d++) {
    const b = d * (SEG + 1) * 2;
    for (let s = 0; s < SEG; s++) {
      const a = b + s * 2;
      dIdx[k++] = a; dIdx[k++] = a + 2; dIdx[k++] = a + 1;
      dIdx[k++] = a + 1; dIdx[k++] = a + 2; dIdx[k++] = a + 3;
    }
  }
  dGeo.setIndex(new THREE.BufferAttribute(dIdx, 1));
  dGeo.setDrawRange(0, 0);
  const decals = new THREE.Mesh(dGeo, new THREE.ShaderMaterial({
    vertexShader: decalVert, fragmentShader: decalFrag,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  decals.frustumCulled = false;
  decals.renderOrder = 1;
  group.add(decals);

  let list = [], gen = null;
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(), tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpC = new THREE.Color();

  // The shader's rock layer (cell in km): returns the rocks within radius R
  function shaderRocks(cx, cy, cellKm, R, out) {
    const mx = ctx.anchor.x + cx / 1000, my = ctx.anchor.y + cy / 1000;
    const i0 = Math.floor(mx / cellKm), j0 = Math.floor(my / cellKm), n = Math.ceil(R / (cellKm * 1000)) + 1;
    for (let j = j0 - n; j <= j0 + n; j++)
      for (let i = i0 - n; i <= i0 + n; i++) {
        if (hash12(i + 91, j + 91) > 0.35) continue;
        const [hx, hy] = hash22(i + 37, j + 37);
        const rr = 0.035 + 0.06 * Math.pow(hash12(i + 53, j + 53), 2);
        const lx = ((i + 0.2 + 0.6 * hx) * cellKm - ctx.anchor.x) * 1000, ly = ((j + 0.2 + 0.6 * hy) * cellKm - ctx.anchor.y) * 1000;
        if (Math.hypot(lx - cx, ly - cy) > R) continue;
        out.push({ kind: 'big', x: lx, y: ly, r: rr * cellKm * 1000, h: 0.8, v: ihash(i, j, 7), seed: ihash(i, j, 9) });
      }
  }
  // Local rubble layer: cell (m), spawn probability, radius range (m), edge fade
  function localRocks(cx, cy, cell, R, p, rMin, rMax, seed, shadow, out) {
    const i0 = Math.floor(cx / cell), j0 = Math.floor(cy / cell), n = Math.ceil(R / cell);
    for (let j = j0 - n; j <= j0 + n; j++)
      for (let i = i0 - n; i <= i0 + n; i++) {
        if (ihash(i, j, seed) > p) continue;
        const x = (i + ihash(i, j, seed + 1)) * cell, y = (j + ihash(i, j, seed + 2)) * cell;
        const d = Math.hypot(x - cx, y - cy);
        if (d > R) continue;
        const fade = 1 - THREE.MathUtils.smoothstep(d, R * 0.7, R);
        const r = (rMin + (rMax - rMin) * Math.pow(ihash(i, j, seed + 3), 3.2)) * fade;
        if (r < rMin * 0.3) continue;
        out.push({ kind: 'small', x, y, r, h: 0.55, v: ihash(i, j, seed + 4), seed: ihash(i, j, seed + 5), shadow });
      }
  }

  function regenerate(cx, cy, sun2, tanE) {
    list = [];
    shaderRocks(cx, cy, 0.05, 60, list);
    shaderRocks(cx, cy, 0.018, 60, list);
    localRocks(cx, cy, 2.5, 24, 0.55, 0.03, 0.26, 101, true, list);
    localRocks(cx, cy, 0.7, 11, 0.7, 0.012, 0.05, 211, true, list);
    localRocks(cx, cy, 0.33, 4.5, 0.55, 0.006, 0.018, 307, false, list);
    const cnt = {}, buckets = { big: variants.big.length, small: variants.small.length };
    for (const k of Object.keys(meshes)) for (const m of meshes[k]) m.count = 0;
    let nd = 0;
    for (const r of list) {
      const vi = Math.floor(r.v * buckets[r.kind]) % buckets[r.kind];
      const m = meshes[r.kind][vi];
      if (m.count >= CAP[r.kind]) continue;
      // Sink the rock centre below ground: about 0.7·h·r sticks out, matching the height the shader uses for the shadow length
      const above = r.h * r.r;
      ctx.toNear(r.x, r.y, (above - 0.8 * r.r) / 1000, tmpV);
      tmpE.set((r.seed - 0.5) * 0.5, r.seed * 6.28, (r.v - 0.5) * 0.4);
      tmpQ.setFromEuler(tmpE);
      tmpS.set(r.r * (0.9 + 0.25 * r.seed), r.r * 0.8, r.r * (0.9 + 0.25 * r.v));
      tmpM.compose(tmpV, tmpQ, tmpS);
      r.mesh = m; r.idx = m.count;
      m.setMatrixAt(m.count, tmpM);
      m.count++;
      cnt[r.kind] = (cnt[r.kind] || 0) + 1;
      if (r.shadow && nd < DMAX) writeDecal(nd++, r, sun2, tanE);
    }
    dGeo.setDrawRange(0, nd * SEG * 6);
    dGeo.attributes.position.needsUpdate = dGeo.attributes.aUvs.needsUpdate = true;
    for (const k of Object.keys(meshes)) for (const m of meshes[k]) m.instanceMatrix.needsUpdate = true;
    shade();
    return cnt;
  }

  function writeDecal(d, r, sun2, tanE) {
    const hgt = r.h * r.r;
    const L = Math.min(hgt / Math.max(tanE, 0.02), 12);
    const ax = -sun2.x, ay = -sun2.y, px = -ay, py = ax;
    const w = r.r * 0.85;
    const vis = ctx.vis(r.x, r.y)[0];
    let k = d * (SEG + 1) * 2 * 3;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG, along = -r.r * 0.3 + t * (L + r.r * 0.3), wid = w + Math.max(along, 0) * 0.006;
      for (const side of [-1, 1]) {
        const x = r.x + ax * along + px * wid * side, y = r.y + ay * along + py * wid * side;
        ctx.toNear(x, y, 0.004 / 1000, tmpV);
        dPos[k] = tmpV.x; dPos[k + 1] = tmpV.y; dPos[k + 2] = tmpV.z;
        dUv[k] = t; dUv[k + 1] = side; dUv[k + 2] = vis;
        k += 3;
      }
    }
  }

  // Per-rock shading: rocks inside a large terrain shadow are darkened (3D rocks cannot read the terrain shader's shadow map)
  function shade() {
    for (const r of list) {
      if (!r.mesh) continue;
      const [vs, vk] = ctx.vis(r.x, r.y);
      const k = ctx.rockLight(vs, vk);
      const base = r.kind === 'big' ? 0.2 : 0.17;
      const a = base * (0.85 + 0.3 * r.v) * k;
      r.mesh.setColorAt(r.idx, tmpC.setRGB(a, a * 1.005, a * 1.02));
    }
    for (const k of Object.keys(meshes)) for (const m of meshes[k]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  // Whether the wheels and chassis hit a rock: only those taller than 25 cm count
  function blocked(wheels, cx, cy) {
    for (const r of list) {
      if (r.kind !== 'big') continue;
      const hgt = r.h * r.r;
      if (Math.hypot(r.x - cx, r.y - cy) < 0.75 + r.r * 0.85 && hgt > 0.45) return r;
      for (const w of wheels) if (hgt > 0.25 && Math.hypot(r.x - w[0], r.y - w[1]) < 0.15 + r.r * 0.85) return r;
    }
    return null;
  }

  return {
    group,
    update(cx, cy, sun2, tanE, force = false) {
      if (!force && gen && Math.hypot(cx - gen[0], cy - gen[1]) < 4) return null;
      gen = [cx, cy];
      return regenerate(cx, cy, sun2, tanE);
    },
    shade,
    blocked,
    get list() { return list; },
  };
}
