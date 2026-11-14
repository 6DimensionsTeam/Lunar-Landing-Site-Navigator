// Terrain self-occlusion: each shadow-map pixel marches along the sun direction over the real terrain and records the
// minimum elevation margin above it. Comparing that margin against the solar angular radius gives the fraction of the
// solar disc that is blocked (the penumbra of the soft shadow comes from the Sun's own size).
import * as THREE from 'three';
import { common } from '../glsl/common.js';

const frag = /* glsl */ `
${common}
uniform vec3 uDir;           // light direction (scene coordinates)
uniform float uHalf;         // half-extent covered by this shadow map, km
uniform float uAng;          // light-source angular radius (radians)
uniform float uD0, uGrow;
uniform int uSteps;
uniform float uHMax;
uniform float uNear;         // distance limit for near occlusion, km
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 m = (vUv * 2.0 - 1.0) * uHalf;
  float h0 = heightKm(m);
  vec3 p0 = mapToScene(m, h0 + 0.004);
  // near occlusion (within uNear: small craters, small undulations) and far occlusion (large crater rims, hills) are recorded
  // separately, so shading can set their darkness independently
  float mNear = 1.0, mFar = 1.0;
  float d = uD0;
  for (int i = 0; i < 400; i++) {
    if (i >= uSteps) break;
    vec3 q = p0 + uDir * d;
    vec3 mh = sceneToMap(q);
    if (abs(mh.x) > uEOut || abs(mh.y) > uEOut) break;
    float ht = heightKm(mh.xy);
    float mg = (mh.z - ht) / d;
    if (d < uNear) mNear = min(mNear, mg); else mFar = min(mFar, mg);
    if (mFar < -2.0 * uAng) break;
    if (mh.z > uHMax + 0.2) break;             // the ray is already above all terrain
    d *= uGrow;
  }
  float vN = smoothstep(-uAng, uAng, mNear);
  float vF = smoothstep(-uAng, uAng, mFar);
  outColor = vec4(min(vN, vF), vN, vF, 1.0);   // r combined, g near, b far
}
`;

const vert = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function target(size) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}

// One shadow map: half is the covered half-extent in km, steps and d0 control the march
function makePass(shared, half, size, steps, d0) {
  const grow = Math.pow(600 / d0, 1 / steps);
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      ...shared,
      uDir: { value: new THREE.Vector3(0, 1, 0) },
      uHalf: { value: half },
      uAng: { value: THREE.MathUtils.degToRad(0.2666) },
      uD0: { value: d0 },
      uGrow: { value: grow },
      uSteps: { value: steps },
      uHMax: { value: 7.1 },
      uNear: { value: 1.2 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  scene.add(quad);
  return { mat, scene, rt: target(size) };
}

// A set of shadow maps (polar 40 m / inner / outer), one per light direction
function makeSet(shared, heroHalf, outerHalf, angDeg, withOuter) {
  const passes = [
    makePass(shared, heroHalf, 1536, 240, 0.03),
    makePass(shared, 150, 2048, 200, 0.1),
  ];
  if (withOuter) passes.push(makePass(shared, outerHalf, 1024, 150, 0.5));
  for (const p of passes) p.mat.uniforms.uAng.value = THREE.MathUtils.degToRad(angDeg);
  return { passes, last: new THREE.Vector3(9, 9, 9) };
}

export function createShadows(shared, heroHalf, outerHalf) {
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const sun = makeSet(shared, heroHalf, outerHalf, 0.2666, true);   // real sun: angular radius 0.27°
  const key = makeSet(shared, heroHalf, outerHalf, 0.5, false);     // cinematic key light: crater shadow edges should stay crisp

  // Recompute only when the light direction changes by more than about 0.06° (a full set takes about 40 ms). At real
  // speed that is roughly every 7 minutes
  function renderSet(renderer, set, dir, force) {
    if (!force && set.last.distanceToSquared(dir) < 1e-6) return false;
    set.last.copy(dir);
    const prev = renderer.getRenderTarget();
    for (const p of set.passes) {
      p.mat.uniforms.uDir.value.copy(dir);
      renderer.setRenderTarget(p.rt);
      renderer.render(p.scene, cam);
    }
    renderer.setRenderTarget(prev);
    return true;
  }

  const tex = (set, i) => set.passes[i].rt.texture;
  return {
    render: (renderer, sunDir, keyDir, force = false) => {
      const a = renderSet(renderer, sun, sunDir, force);
      const b = renderSet(renderer, key, keyDir, force);
      return a || b;
    },
    texHero: tex(sun, 0), texIn: tex(sun, 1), texOut: tex(sun, 2),
    keyHero: tex(key, 0), keyIn: tex(key, 1),
    // The rover reads a few pixels around its position back on the CPU, for the lighting of the chassis and rocks (the same occlusion as the terrain shader)
    rtHero: sun.passes[0].rt, rtKeyHero: key.passes[0].rt, lastSun: sun.last,
  };
}
