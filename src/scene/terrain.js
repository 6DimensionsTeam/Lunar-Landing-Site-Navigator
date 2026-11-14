// Lunar surface mesh: inner square grid (≈195 m vertex spacing) + outer ring + distant skirt, sharing one shader.
import * as THREE from 'three';
import { terrainVert, terrainFrag } from '../glsl/terrain.js';

const MESH_SPLIT = 146;     // km, boundary between the inner grid and the outer ring
export const GRID = { half: 150, n: 1536 };   // inner square grid; the near patch's outer ring must match its triangles
const OUTER_EDGE = 455;
const SKIRT_EDGE = 900;

function heightTexture(tile) {
  const t = new THREE.DataTexture(tile.heights, tile.size, tile.size, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// Square grid, vertices store map coordinates (X, 0, Y), unit km
function gridGeometry(half, n) {
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  let k = 0;
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      pos[k++] = -half + (2 * half * i) / n;
      pos[k++] = 0;
      pos[k++] = -half + (2 * half * j) / n;
    }
  const idx = new Uint32Array(n * n * 6);
  k = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = c;
      idx[k++] = b; idx[k++] = d; idx[k++] = c;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

// Ring mesh, radii distributed geometrically (dense near, sparse far)
function ringGeometry(r0, r1, nr, na) {
  const pos = new Float32Array((nr + 1) * (na + 1) * 3);
  let k = 0;
  for (let j = 0; j <= nr; j++) {
    const r = r0 * Math.pow(r1 / r0, j / nr);
    for (let i = 0; i <= na; i++) {
      const th = (2 * Math.PI * i) / na;
      pos[k++] = r * Math.cos(th);
      pos[k++] = 0;
      pos[k++] = r * Math.sin(th);
    }
  }
  const idx = new Uint32Array(nr * na * 6);
  k = 0;
  for (let j = 0; j < nr; j++)
    for (let i = 0; i < na; i++) {
      const a = j * (na + 1) + i, b = a + 1, c = a + na + 1, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = c; idx[k++] = d; idx[k++] = b;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

export function createTerrain(data) {
  const { hero, inner, outer } = data.tiles;
  const shared = {
    uR: { value: data.radiusKm },
    uHHero: { value: heightTexture(hero) },
    uHIn: { value: heightTexture(inner) },
    uHOut: { value: heightTexture(outer) },
    uEHero: { value: hero.half_extent_m / 1000 },
    uEIn: { value: inner.half_extent_m / 1000 },
    uEOut: { value: outer.half_extent_m / 1000 },
    uBlend0: { value: 140 },
    uBlend1: { value: 148 },
  };
  const uniforms = {
    ...shared,
    uMeshSplit: { value: MESH_SPLIT },
    uSkirt0: { value: OUTER_EDGE * 0.92 },
    uSkirt1: { value: SKIRT_EDGE },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uEarthDir: { value: new THREE.Vector3(0, 1, 0) },
    uShHero: { value: null },
    uShIn: { value: null },
    uShOut: { value: null },
    uShEHero: { value: hero.half_extent_m / 1000 },
    uShEIn: { value: 150 },
    uShEOut: { value: outer.half_extent_m / 1000 },
    uSunI: { value: 5.0 },
    uFill: { value: 0.13 },
    uKey: { value: 1.25 },
    uCrDepth: { value: 1.0 },
    uNearSh: { value: 0.25 },
    uDemFine: { value: 0.6 },
    uBigK: { value: 1.2 },
    uFineK: { value: 0.5 },
    uSplitPx: { value: 20 },
    uGHero: { value: null },     // gradient map (with mipmaps), filled in by bakeGradients
    uGIn: { value: null },
    uGOut: { value: null },
    uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
    uKShHero: { value: null },
    uKShIn: { value: null },
    uLift: { value: THREE.MathUtils.degToRad(5) },
    // Dust keeps only a little depth separation: at the old 1/45, anything past 50 km was covered in six tenths of grey and the image went flat
    uFogDen: { value: 1 / 140 },
    uFogCol: { value: new THREE.Color(0.085, 0.092, 0.1) },
    uHaze0: { value: 0.5 },
    uHazeH: { value: 1.2 },
    uTexHero: { value: hero.size },
    uTexIn: { value: inner.size },
    uTexOut: { value: outer.size },
    uLines: { value: 0.4 },      // contour lines and graticule; main.js sets it per camera mode (more prominent from orbit)
    uTrack: { value: 0 },        // orbital station ground track (shown only in the orbit view)
    uTrackDir: { value: new THREE.Vector2(0, 1) },
    uNadir: { value: new THREE.Vector2() },
    uDiscC: { value: new THREE.Vector2() },   // rover close-up: the circle covered by the near patch (km), cut out of the main terrain here
    uDiscR: { value: 0 },
    uKeyFloor: { value: 1 },                  // 1 = the key light is not dimmed by real shadow
  };
  const group = new THREE.Group();
  const layers = [
    [gridGeometry(GRID.half, GRID.n), 0],
    [ringGeometry(MESH_SPLIT - 0.5, OUTER_EDGE, 420, 1536), 1],
    [ringGeometry(OUTER_EDGE - 0.5, SKIRT_EDGE, 60, 768), 2],
  ];
  for (const [geo, layer] of layers) {
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: terrainVert,
      fragmentShader: terrainFrag,
      uniforms: { ...uniforms, uLayer: { value: layer } },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return { group, uniforms, shared };
}

// Gradient map: each height map bakes a half-resolution gradient (rg = map X and Y direction, m/m) with mipmaps.
// Shading picks the mip level by on-screen pixel size, giving a smooth gradient of "only the relief large enough on screen", with none of the ringing of a two-tap difference.
const gradFrag = /* glsl */ `
precision highp float;
uniform sampler2D uH;
uniform float uN;            // height map side length (pixels)
uniform float uStepM;        // distance between the two samples, m
in vec2 vUv;
out vec4 outColor;
void main() {
  float du = 1.0 / uN;
  float hx1 = texture(uH, vUv + vec2(du, 0)).r, hx0 = texture(uH, vUv - vec2(du, 0)).r;
  float hy1 = texture(uH, vUv - vec2(0, du)).r, hy0 = texture(uH, vUv + vec2(0, du)).r;
  outColor = vec4((hx1 - hx0) / uStepM, (hy1 - hy0) / uStepM, 0.0, 1.0);
}
`;
const gradVert = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export function bakeGradients(renderer, terrain) {
  const u = terrain.uniforms;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: gradVert,
    fragmentShader: gradFrag,
    uniforms: { uH: { value: null }, uN: { value: 1 }, uStepM: { value: 1 } },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const prev = renderer.getRenderTarget();
  for (const [hKey, nKey, eKey, gKey] of [
    ['uHHero', 'uTexHero', 'uEHero', 'uGHero'],
    ['uHIn', 'uTexIn', 'uEIn', 'uGIn'],
    ['uHOut', 'uTexOut', 'uEOut', 'uGOut'],
  ]) {
    const n = u[nKey].value, E = u[eKey].value;
    const m = Math.max(2, Math.round(n / 2));
    const rt = new THREE.WebGLRenderTarget(m, m, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
    });
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    mat.uniforms.uH.value = u[hKey].value;
    mat.uniforms.uN.value = n;
    mat.uniforms.uStepM.value = 2 * ((2 * E) / n) * 1000;   // ±1 source pixel
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    u[gKey].value = rt.texture;
  }
  renderer.setRenderTarget(prev);
  mat.dispose();
  quad.geometry.dispose();
}
