// JS counterpart of src/glsl/common.js, one to one: conversions between latitude/longitude, map coordinates and scene coordinates.
import * as THREE from 'three';

export function latLonToMap(R, latDeg, lonDeg) {
  const r = 2 * R * Math.tan(THREE.MathUtils.degToRad(90 - Math.abs(latDeg)) / 2);
  const lon = THREE.MathUtils.degToRad(lonDeg);
  return new THREE.Vector2(r * Math.sin(lon), r * Math.cos(lon));
}

export function mapToScene(R, m, h, out = new THREE.Vector3()) {
  const t2 = m.lengthSq() / (4 * R * R);
  const k = 1 / (1 + t2);
  const f = ((R + h) * k) / R;
  return out.set(m.x * f, h - 2 * (R + h) * t2 * k, -m.y * f);
}

export function upAt(R, p, out = new THREE.Vector3()) {
  return out.set(p.x, p.y + R, p.z).normalize();
}

// Inverse of mapToScene: scene coordinates → map coordinates (km), also returning height above the reference sphere (km)
export function sceneToMap(R, p, out = new THREE.Vector2()) {
  const vy = p.y + R;
  const L = Math.hypot(p.x, vy, p.z);
  const k = (2 * R) / (L + vy);
  out.set(p.x * k, -p.z * k);
  return { m: out, h: L - R };
}

// Bilinear height lookup (km) from the decoded height arrays; the inner ring takes precedence.
export function makeHeightSampler(tiles) {
  const sample = (t, X, Y) => {
    const n = t.size, E = t.half_extent_m / 1000;
    const c = (X / (2 * E) + 0.5) * n - 0.5;
    const r = (0.5 - Y / (2 * E)) * n - 0.5;
    const c0 = Math.max(0, Math.min(n - 2, Math.floor(c))), r0 = Math.max(0, Math.min(n - 2, Math.floor(r)));
    const fc = Math.min(1, Math.max(0, c - c0)), fr = Math.min(1, Math.max(0, r - r0));
    const h = t.heights, i = r0 * n + c0;
    const top = h[i] * (1 - fc) + h[i + 1] * fc;
    const bot = h[i + n] * (1 - fc) + h[i + n + 1] * fc;
    return (top * (1 - fr) + bot * fr) / 1000;
  };
  return (m) => {
    const hE = tiles.hero.half_extent_m / 1000 - 0.1;
    if (Math.abs(m.x) < hE && Math.abs(m.y) < hE) return sample(tiles.hero, m.x, m.y);
    const inE = tiles.inner.half_extent_m / 1000 - 1;
    if (Math.abs(m.x) < inE && Math.abs(m.y) < inE) return sample(tiles.inner, m.x, m.y);
    return sample(tiles.outer, m.x, m.y);
  };
}
