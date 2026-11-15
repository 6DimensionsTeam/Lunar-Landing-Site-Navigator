// Tracks: one 32 m × 32 m texture that follows the rover (2048², 1.6 cm per pixel); each frame the short segment each
// of the four wheels covers is drawn as a ribbon over it. a stores coverage (max), r and g store the grouser phase
// cos / sin (new overwrites old), and the ground shader uses them to compute the pressed-in groove, the soil ridges on
// either side and the repeated grouser prints. When the rover nears the edge the whole texture shifts, and track left
// behind falls outside it (beyond 20-odd metres it is not legible anyway). Coordinates: map coordinates relative to
// point A (metres).
import * as THREE from 'three';

export const TRACK = { size: 2048, width: 32, margin: 8, wheelW: 0.24, grouser: 0.059 };

const stampVert = /* glsl */ `
attribute vec2 aLat;           // x across −1→1, y grouser phase (radians)
uniform vec2 uC;
uniform float uW;
varying vec2 vLat;
void main() {
  vLat = aLat;
  gl_Position = vec4((position.xy - uC) / uW * 2.0, 0.0, 1.0);
}
`;
const stampFrag = /* glsl */ `
varying vec2 vLat;
void main() {
  float c = 1.0 - smoothstep(0.72, 1.0, abs(vLat.x));
  gl_FragColor = vec4(cos(vLat.y) * 0.5 + 0.5, sin(vLat.y) * 0.5 + 0.5, 0.0, c);
}
`;
const shiftFrag = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uOff;             // offset from the new image's uv to the old image's uv
varying vec2 vUv;
void main() {
  vec2 uv = vUv + uOff;
  gl_FragColor = any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))) ? vec4(0.5, 0.5, 0.0, 0.0) : texture2D(uSrc, uv);
}
`;

export function createTracks(renderer, size = TRACK.size) {
  const mk = () => {
    const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    return rt;
  };
  let rt = mk(), rt2 = mk();
  const center = new THREE.Vector2();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const MAXQ = 8;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAXQ * 4 * 3), lat = new Float32Array(MAXQ * 4 * 2);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aLat', new THREE.BufferAttribute(lat, 2).setUsage(THREE.DynamicDrawUsage));
  const idx = [];
  for (let q = 0; q < MAXQ; q++) idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 1, q * 4 + 3, q * 4 + 2);
  geo.setIndex(idx);
  const stampMat = new THREE.ShaderMaterial({
    vertexShader: stampVert, fragmentShader: stampFrag,
    uniforms: { uC: { value: center }, uW: { value: TRACK.width } },
    depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide,
    // Phase: overwritten weighted by coverage; coverage: max of the two
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.MaxEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
  });
  const stampMesh = new THREE.Mesh(geo, stampMat);
  stampMesh.frustumCulled = false;
  const stampScene = new THREE.Scene();
  stampScene.add(stampMesh);

  const shiftMat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: shiftFrag,
    uniforms: { uSrc: { value: null }, uOff: { value: new THREE.Vector2() } },
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shiftMat);
  quad.frustumCulled = false;
  const shiftScene = new THREE.Scene();
  shiftScene.add(quad);

  function clear(target) {
    const prev = renderer.getRenderTarget(), cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setClearColor(new THREE.Color(0.5, 0.5, 0), 0);
    renderer.clear(true, false, false);
    renderer.setClearColor(cc, ca);
    renderer.setRenderTarget(prev);
  }
  clear(rt); clear(rt2);

  // Rover too far from the centre: snap the new centre to 0.5 m and shift the old texture across
  function follow(x, y) {
    const lim = TRACK.width / 2 - TRACK.margin;
    if (Math.abs(x - center.x) < lim && Math.abs(y - center.y) < lim) return;
    const nx = Math.round(x * 2) / 2, ny = Math.round(y * 2) / 2;
    shiftMat.uniforms.uSrc.value = rt.texture;
    shiftMat.uniforms.uOff.value.set((nx - center.x) / TRACK.width, (ny - center.y) / TRACK.width);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt2);
    renderer.render(shiftScene, cam);
    renderer.setRenderTarget(prev);
    [rt, rt2] = [rt2, rt];
    center.set(nx, ny);
  }

  // segs: [{ ax, ay, bx, by, pa, pb }], one segment the wheel centre covered (metres) and the grouser phase at each end
  function stamp(segs) {
    let q = 0;
    const hw = TRACK.wheelW / 2 / 0.86;            // ribbon slightly wider than the wheel, the edge left for the soft falloff
    for (const s of segs) {
      if (q >= MAXQ) break;
      let dx = s.bx - s.ax, dy = s.by - s.ay;
      const L = Math.hypot(dx, dy);
      if (L < 1e-4) continue;
      dx /= L; dy /= L;
      const ext = 0.004, px = -dy * hw, py = dx * hw;
      const ax = s.ax - dx * ext, ay = s.ay - dy * ext, bx = s.bx + dx * ext, by = s.by + dy * ext;
      const o = q * 12, l = q * 8;
      pos.set([ax - px, ay - py, 0, ax + px, ay + py, 0, bx - px, by - py, 0, bx + px, by + py, 0], o);
      lat.set([-1, s.pa, 1, s.pa, -1, s.pb, 1, s.pb], l);
      q++;
    }
    if (!q) return;
    geo.attributes.position.needsUpdate = geo.attributes.aLat.needsUpdate = true;
    geo.setDrawRange(0, q * 6);
    const prev = renderer.getRenderTarget(), ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    renderer.render(stampScene, cam);
    renderer.setRenderTarget(prev);
    renderer.autoClear = ac;
  }

  // Wipe every stamped track. Used when the rover is set down at another site: the wheel marks
  // belong to the ground it left.
  const reset = () => { clear(rt); clear(rt2); };
  return { follow, stamp, center, reset, get texture() { return rt.texture; }, size };
}
