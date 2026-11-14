// Sky: real star catalogue (Hipparcos, V < 7.8, about 34,000 stars) + procedural Milky Way. The Moon has no atmosphere, so the sky is pure black.
import * as THREE from 'three';
import { haze } from '../glsl/haze.js';

// Directions of the galactic north pole and the galactic centre in ICRS (J2000)
function radec(raDeg, decDeg) {
  const ra = THREE.MathUtils.degToRad(raDeg), de = THREE.MathUtils.degToRad(decDeg);
  return new THREE.Vector3(Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de));
}
const NGP = radec(192.85948, 27.12825);
const GC = radec(266.40510, -28.93617);

const milkyFrag = /* glsl */ `
uniform mat3 uSceneToIcrs;
uniform vec3 uNGP, uGC;
uniform float uMilky;
uniform vec3 uHazeCol, uSunDir;
uniform float uR;
${haze}
in vec3 vDir;
out vec4 outColor;
float h(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * n3(p); p *= 2.03; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(uSceneToIcrs * normalize(vDir));
  float b = asin(clamp(dot(d, uNGP), -1.0, 1.0));
  vec3 ex = uGC, ey = cross(uNGP, uGC);
  float l = atan(dot(d, ey), dot(d, ex));
  float core = exp(-pow(b / 0.10, 2.0)) * (0.35 + 0.65 * exp(-pow(l / 0.9, 2.0)));
  float wide = exp(-pow(b / 0.32, 2.0)) * 0.25;
  float bulge = exp(-(b * b + l * l) / 0.06) * 0.9;
  float clouds = fbm(d * 7.0) * 0.7 + fbm(d * 23.0) * 0.3;
  float dust = smoothstep(0.42, 0.7, fbm(d * 11.0 + 3.1)) * exp(-pow(b / 0.05, 2.0));
  float v = (core * (0.4 + 0.9 * clouds) + wide * clouds + bulge) * (1.0 - 0.85 * dust);
  vec3 col = mix(vec3(0.55, 0.62, 0.75), vec3(0.85, 0.8, 0.7), clamp(bulge * 1.2, 0.0, 1.0));
  vec3 sky = col * v * uMilky;
  // The dust layer hugs the lunar surface: integrated along the view ray, so the higher the camera and the further up it looks,
  // the darker the sky
  vec3 dir = normalize(vDir);
  float tau = dustTau(cameraPosition, dir, 1200.0);
  float haze = 1.0 - exp(-tau);
  float fwd = pow(max(dot(dir, uSunDir), 0.0), 6.0);
  sky = mix(sky, uHazeCol * (1.0 + 2.5 * fwd), haze);
  outColor = vec4(sky, 1.0);
}
`;

const milkyVert = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
}
`;

const starVert = /* glsl */ `
uniform float uR;
${haze}
uniform mat3 uIcrsToScene;
uniform float uPx;
uniform float uStarGain;
in float aMag;
in float aBV;
out vec3 vCol;
out float vI;
vec3 bvColor(float bv) {
  float t = 4600.0 * (1.0 / (0.92 * bv + 1.7) + 1.0 / (0.92 * bv + 0.62));
  float x = clamp((t - 3000.0) / 9000.0, 0.0, 1.0);
  return mix(vec3(1.0, 0.72, 0.5), vec3(0.72, 0.82, 1.0), x) / max(mix(1.0, 0.82, x), 0.82);
}
void main() {
  vec3 dir = uIcrsToScene * normalize(position);
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * dir, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
  float flux = pow(10.0, -0.4 * (aMag - 1.0));
  vI = pow(flux, 0.55) * uStarGain * exp(-dustTau(cameraPosition, dir, 1200.0) * 1.5);   // stars inside the dust layer are dimmed
  gl_PointSize = clamp(1.6 + 1.3 * log(1.0 + flux * 3.0), 1.5, 7.0) * uPx;
  vCol = bvColor(aBV);
}
`;

const starFrag = /* glsl */ `
in vec3 vCol;
in float vI;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  float a = exp(-r2 * 4.5);
  outColor = vec4(vCol * vI * a, 1.0);
}
`;

export function createSky(data) {
  const group = new THREE.Group();
  const milkyU = {
    uSceneToIcrs: { value: new THREE.Matrix3() },
    uNGP: { value: NGP },
    uGC: { value: GC },
    uMilky: { value: 0.012 },
    uHazeCol: { value: new THREE.Color(0.11, 0.122, 0.135) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  };
  const milky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 32),
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: milkyVert, fragmentShader: milkyFrag, uniforms: milkyU,
      side: THREE.BackSide, depthWrite: false, depthTest: false,
    }),
  );
  milky.renderOrder = -10;
  milky.frustumCulled = false;
  group.add(milky);

  const n = data.starCount, dv = data.stars;
  const pos = new Float32Array(n * 3), mag = new Float32Array(n), bv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 8;
    pos[i * 3] = dv.getInt16(o, true) / 32767;
    pos[i * 3 + 1] = dv.getInt16(o + 2, true) / 32767;
    pos[i * 3 + 2] = dv.getInt16(o + 4, true) / 32767;
    mag[i] = (dv.getUint8(o + 6) - 40) / 20;
    bv[i] = dv.getInt8(o + 7) / 50;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  g.setAttribute('aBV', new THREE.BufferAttribute(bv, 1));
  const starU = {
    uIcrsToScene: { value: new THREE.Matrix3() },
    uPx: { value: 1 },
    uStarGain: { value: 1.6 },
  };
  const stars = new THREE.Points(g, new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: starVert, fragmentShader: starFrag, uniforms: starU,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  }));
  stars.renderOrder = -9;
  stars.frustumCulled = false;
  group.add(stars);

  // Shares one set of dust parameters with the terrain (the same uniform objects, so changing one site changes both)
  function attachHaze(t) {
    for (const u of [milkyU, starU]) {
      u.uR = t.uR;
      u.uFogDen = t.uFogDen;
      u.uHaze0 = t.uHaze0;
      u.uHazeH = t.uHazeH;
    }
    milkyU.uHazeCol = t.uFogCol;
  }

  function update(icrsToScene4, pixelRatio) {
    const m3 = new THREE.Matrix3().setFromMatrix4(icrsToScene4);
    starU.uIcrsToScene.value.copy(m3);
    milkyU.uSceneToIcrs.value.copy(m3).transpose();
    starU.uPx.value = pixelRatio;
  }

  return { group, update, attachHaze, milkyU, starU };
}
