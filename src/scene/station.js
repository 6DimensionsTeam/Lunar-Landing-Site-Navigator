// HALO lunar relay station: the core module uses the NASA Gateway Core model (public domain, see tools/prep_station.py),
// the aft half reuses parts already in the core module as far as possible so the detail density matches the front:
//   gravity ring = 16 airlock modules bent into 1/16 arcs and joined end to end; joints everywhere use the NDS ports from the model; the propulsion module is the ESPRIT segment;
//   what the model lacks (spine, spokes, thrust structure, nozzles) is generated procedurally with the same hull panel texture.
//
// Station frame (metres): origin at the PPE aft end, +z along the PPE→HALO→I-Hab spine, +y along the solar array span, x = y × z.
// The spine, gravity ring and engines extend from the origin towards -z.
// Rendering: the station sits over 1700 km from the Moon's centre; placed straight into the km-unit main scene it would lose precision and fight the terrain for depth, so it gets a scene of its own and
// a camera of its own at the origin, drawn over the main scene after the depth buffer is cleared (bloom and grading are still done once, afterwards).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const M = 0.001;                       // metres → km

// glb coords → station coords: first derive the axis from the PPE box face normals (the PPE main axis aligns with station z), then add a -0.1 rad turn about the glb local z axis (≈ -5.7°, aligned by eye);
// the centre of the round opening in the PPE aft face is aligned to the station origin
const CORE_Q_ORIG = new THREE.Quaternion(0.045766, -0.233976, 0.966804, -0.075886);
const CORE_Q_ADJUST = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.1);
const CORE_Q = CORE_Q_ORIG.clone().multiply(CORE_Q_ADJUST);
const CORE_AFT = new THREE.Vector3(-0.898, 2.448, -4.914);
// The core module (with the PPE solar array) is trimmed last as a whole: r* degrees (station axes, Euler XYZ), d* metres, pivoting about the station origin (PPE aft interface).
// In development add ?trim to the URL for a calibration panel to tune it live; readings from it get copied here (set by eye on 2026-10-31, provisional)
export const CORE_TRIM = { rx: -1.34, ry: 3.5, rz: 0, dx: 0, dy: 0.04, dz: -0.31 };

// Gravity ring: n airlock modules (len metres between the outer faces of their ports) bent into a full circle, the radius of the module axes r = n·len / 2π ≈ 19 m; 3.4 rpm → 0.25 g
const RING = { z: -32, n: 16, len: 7.45, rpm: 3.4, hub: 2.6 };
RING.r = (RING.n * RING.len) / (2 * Math.PI);
// The other two array pairs on the spine: clones of the PPE array scaled uniformly by scale, mounted on the two mid-section node modules (positions derived from the mid-section module lengths; at 0.7× the wing root lands exactly on the node module's outer wall)
const WINGS = { scale: 0.7 };
// Mid-section node module: length between the backs of the ports at the two ends (metres)
const NODE = { len: 3.0 };
// Propulsion module (ESPRIT, 7.25 m long) → stepped thrust structure → seven nozzles (1 in the middle, 6 in an outer ring)
const ENGINE = { tank: -37.2, tankLen: 7.25, rise: 2.45, spread: 2.75, rExit: 1.3, bell: 3.1 };
ENGINE.plate = ENGINE.tank - ENGINE.tankLen - 0.7 - ENGINE.rise;      // thrust plate (the nozzles run aft from here); 0.7 ≈ the thickness of the passive port at the front of the thrust structure
ENGINE.exit = ENGINE.plate - ENGINE.bell;
// Spine: starts at the aft end of mid-section node module 2, passes through the gravity ring hub, aft end plugs into the active port ahead of the propulsion module
const SPINE = { r: 1.0 };
export const STATION = {
  ringR: Math.round(RING.r), ringRpm: RING.rpm,
  ringG: (RING.r * (RING.rpm * Math.PI / 30) ** 2) / 9.80665,
  length: Math.round(21 - ENGINE.exit), span: 43, wings: 6, wingLen: 21.5,
  nozzle: +(2 * (ENGINE.spread + ENGINE.rExit)).toFixed(1),
};

// ---------- procedural textures ----------
const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

// Hull panels (for procedural parts, matched to the core module's finish): pale grey-white base, panel cells of uneven width, recessed seam + highlight on one side,
// a row of rivets along each seam, scattered access hatches and markings. A matching bump map is drawn at the same time (seams recessed, rivets raised). Cells meet edge to edge both ways, seamless round a cylinder
function panelTexture() {
  const S = 1024;
  const canvas = () => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
  const cc = canvas(), bc = canvas(), g = cc.getContext('2d'), b = bc.getContext('2d');
  const grey = (v) => `rgb(${v},${v},${v})`;
  g.fillStyle = '#d6d8da'; g.fillRect(0, 0, S, S);
  b.fillStyle = grey(128); b.fillRect(0, 0, S, S);
  const rows = [0, 152, 256, 448, 512, 704, 832, 1024], cells = [];
  for (let j = 0; j + 1 < rows.length; j++) {
    const cols = j % 2 ? [0, 192, 352, 512, 704, 832, 1024] : [0, 128, 320, 512, 640, 896, 1024];
    for (let i = 0; i + 1 < cols.length; i++) cells.push([cols[i], rows[j], cols[i + 1], rows[j + 1]]);
  }
  for (const [x0, y0, x1, y1] of cells) {
    const v = 204 + Math.floor(rnd() * 28);
    g.fillStyle = `rgb(${v},${v + 1},${v + 3})`;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    b.fillStyle = grey(122 + Math.floor(rnd() * 14));
    b.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  for (const [x0, y0, x1, y1] of cells) {
    // recessed seam (each cell only draws its top and left seam; neighbouring cells supply the other two)
    g.fillStyle = 'rgba(70,74,80,0.75)';
    g.fillRect(x0, y0, x1 - x0, 3); g.fillRect(x0, y0, 3, y1 - y0);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(x0, y0 + 3, x1 - x0, 1); g.fillRect(x0 + 3, y0, 1, y1 - y0);
    b.fillStyle = grey(40);
    b.fillRect(x0, y0, x1 - x0, 4); b.fillRect(x0, y0, 4, y1 - y0);
    // rivets
    for (let x = x0 + 10; x < x1 - 6; x += 16) { g.fillStyle = 'rgba(120,124,130,0.8)'; g.fillRect(x, y0 + 8, 2, 2); b.fillStyle = grey(200); b.fillRect(x, y0 + 8, 2, 2); }
    for (let y = y0 + 10; y < y1 - 6; y += 16) { g.fillStyle = 'rgba(120,124,130,0.8)'; g.fillRect(x0 + 8, y, 2, 2); b.fillStyle = grey(200); b.fillRect(x0 + 8, y, 2, 2); }
    // access hatch: thin frame, half of them with louvres
    if (rnd() < 0.3) {
      const w = 26 + rnd() * 50, h = 18 + rnd() * 32;
      const x = x0 + 18 + rnd() * Math.max(1, x1 - x0 - w - 36), y = y0 + 18 + rnd() * Math.max(1, y1 - y0 - h - 36);
      g.strokeStyle = 'rgba(60,64,70,0.8)'; g.lineWidth = 2; g.strokeRect(x, y, w, h);
      b.strokeStyle = grey(70); b.lineWidth = 3; b.strokeRect(x, y, w, h);
      if (rnd() < 0.5) { g.fillStyle = 'rgba(40,44,50,0.55)'; for (let k = 0; k < 4; k++) g.fillRect(x + 5, y + 5 + (k * (h - 10)) / 4, w - 10, 2); }
    }
    if (rnd() < 0.12) { g.fillStyle = 'rgba(150,40,30,0.55)'; g.fillRect(x0 + 14, y1 - 22, 34, 6); }
  }
  const tex = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  return { map: tex(cc, true), bump: tex(bc, false) };
}
// Gold multilayer insulation: the crumpling comes from random light and dark patches
function foilTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(150,150,150)';
  g.fillRect(0, 0, 256, 256);
  for (let n = 0; n < 900; n++) {
    const v = 90 + Math.floor(rnd() * 140);
    g.fillStyle = `rgba(${v},${v},${v},0.5)`;
    g.beginPath();
    const x = rnd() * 256, y = rnd() * 256, r = 3 + rnd() * 14;
    g.moveTo(x, y);
    for (let k = 0; k < 4; k++) g.lineTo(x + (rnd() - 0.5) * r * 2, y + (rnd() - 0.5) * r * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Solar array: deep blue cells, silver grid lines, a gold bus bar down the middle, an aluminium frame round the edge (the blue photovoltaics of the navigation station)
function cellTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#0b1530';
  g.fillRect(0, 0, 1024, 256);
  const cols = 48, rows = 10, cw = 1024 / cols, ch = 256 / rows;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const v = rnd() * 14;
      g.fillStyle = `rgb(${16 + v},${32 + v},${78 + v * 2})`;
      g.fillRect(i * cw + 1, j * ch + 1, cw - 2, ch - 2);
      g.fillStyle = 'rgba(150,170,210,0.22)';
      g.fillRect(i * cw + 1, j * ch + ch / 2, cw - 2, 1);
    }
  g.fillStyle = 'rgba(205,210,220,0.7)';
  for (let i = 0; i <= cols; i += 8) g.fillRect(i * cw - 1.5, 0, 3, 256);
  g.fillStyle = '#b8893c';
  g.fillRect(0, 124, 1024, 8);
  g.strokeStyle = '#9aa0a8';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 1018, 250);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.x = 2;
  t.anisotropy = 8;
  return t;
}

// Nozzle outer wall: a ring of closely spaced regenerative cooling tubes (alternating light and dark vertical strips) + a few bands, used as both colour and bump
function bellTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  for (let x = 0; x < 1024; x += 8) {
    const gr = g.createLinearGradient(x, 0, x + 8, 0);
    gr.addColorStop(0, '#2c2f34'); gr.addColorStop(0.5, '#9a9fa6'); gr.addColorStop(1, '#2c2f34');
    g.fillStyle = gr;
    g.fillRect(x, 0, 8, 256);
  }
  g.fillStyle = 'rgba(20,22,26,0.85)';
  for (const y of [18, 104, 192]) g.fillRect(0, y, 1024, 5);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// Main engine nozzle inner wall: brightest blue-white at the throat, darkening towards the exit, with rings of cooling loops over it
function nozzleTexture() {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 256;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#f2f8ff');
  gr.addColorStop(0.12, '#9cc4ff');
  gr.addColorStop(0.45, '#2e5fb8');
  gr.addColorStop(1, '#050a16');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 256);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 8; y < 256; y += 14) g.fillRect(0, y, 32, 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- geometry helpers ----------
// A lathe body revolved about station z: profile is a list of (r, z) points, θ measured from station +x
function lathe(profile, seg, th0 = 0, len = Math.PI * 2) {
  const g = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), seg, th0 + Math.PI / 2, len);
  g.rotateX(Math.PI / 2);
  return g;
}
// Panel texture laid on procedural parts at true scale: one tile is TILE metres square, taken in whole numbers round the circumference (so the seams meet) and by arc length along the profile
const TILE = 4;
function tileLathe(g, profile) {
  const s = [0];
  for (let i = 1; i < profile.length; i++) s.push(s[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  const rMax = Math.max(...profile.map((p) => p[0]));
  const nu = Math.max(1, Math.round((2 * Math.PI * rMax) / TILE)), n = profile.length, uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * nu, s[i % n] / TILE);
  return g;
}
function tileCylinder(g, r, len) {
  const nu = Math.max(1, Math.round((2 * Math.PI * r) / TILE)), uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * nu, uv.getY(i) * (len / TILE));
  return g;
}

// ---------- reused model parts ----------
// Bakes a mesh into station coords (no longer quantised: position, normal and UV all become Float32); M is the mesh's matrix relative to the station root
function bakeMesh(mesh, M) {
  const Nm = new THREE.Matrix3().getNormalMatrix(M);
  const g = mesh.geometry, P = g.attributes.position, Nn = g.attributes.normal, U = g.attributes.uv;
  const n = P.count, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = U ? new Float32Array(n * 2) : null;
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(P.getX(i), P.getY(i), P.getZ(i)).applyMatrix4(M).toArray(pos, i * 3);
    v.set(Nn.getX(i), Nn.getY(i), Nn.getZ(i)).applyMatrix3(Nm).normalize().toArray(nor, i * 3);
    if (uv) { uv[i * 2] = U.getX(i); uv[i * 2 + 1] = U.getY(i); }
  }
  return { pos, nor, uv, index: g.index ? Uint32Array.from(g.index.array) : null };
}
// Bends a straight module into an arc of radius R: f = { c0 module centre, a module axis, v outward after bending, w ring axis }; [a v w] must have the same handedness as [tangent radial z].
// Arc length is preserved by mapping to θ = u/R; normals go through the inverse transpose of the Jacobian (tangential component divided by the stretch ratio r/R). UVs unchanged, so the original texture still applies
function bendRing(b, f, R) {
  const n = b.pos.length / 3, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  const d = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    d.fromArray(b.pos, i * 3).sub(f.c0);
    const th = d.dot(f.a) / R, r = R + d.dot(f.v), c = Math.cos(th), s = Math.sin(th);
    pos[i * 3] = r * c; pos[i * 3 + 1] = r * s; pos[i * 3 + 2] = d.dot(f.w);
    q.fromArray(b.nor, i * 3);
    const nt = q.dot(f.a) / (r / R), nr = q.dot(f.v), nz = q.dot(f.w);
    const x = nr * c - nt * s, y = nr * s + nt * c, l = Math.hypot(x, y, nz) || 1;
    nor[i * 3] = x / l; nor[i * 3 + 1] = y / l; nor[i * 3 + 2] = nz / l;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (b.uv) g.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2));
  if (b.index) g.setIndex(new THREE.BufferAttribute(b.index, 1));
  g.computeBoundingSphere();
  return g;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.15, 'rgba(255,255,255,0.8)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// A strut between two points (a unit cube stretched along it), for InstancedMesh
const _q = new THREE.Quaternion(), _y = new THREE.Vector3(0, 1, 0), zAx = new THREE.Vector3(0, 0, 1);
function strut(a, b, thick, out) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  _q.setFromUnitVectors(_y, d.divideScalar(len));
  out.push(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), _q.clone(), new THREE.Vector3(thick, len, thick)));
}
// ---------- overlay pass: draw the station on the same buffer after clearing depth ----------
class StationPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.enabled = false;
  }
  render(renderer, writeBuffer, readBuffer) {
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = ac;
  }
}

// Environment lighting: the lower hemisphere is the lunar surface under the low Sun (horizon pushed down about 10°, the dip of the lunar horizon from 30 km up), the upper hemisphere is black sky
function environment(renderer, sunDir, up) {
  const s = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uSun: { value: sunDir.clone() }, uUp: { value: up.clone() } },
    vertexShader: 'varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uSun, uUp; varying vec3 vD;
      void main() {
        vec3 d = normalize(vD);
        float e = dot(d, uUp);
        float ground = smoothstep(-0.14, -0.19, e);
        vec3 moon = vec3(0.07, 0.072, 0.075) * (0.6 + 0.4 * max(dot(-d, normalize(uSun - uUp * dot(uSun, uUp))), 0.0));
        vec3 sky = vec3(0.002, 0.0025, 0.004);
        vec3 c = mix(sky, moon, ground) + vec3(1.0, 0.97, 0.92) * pow(max(dot(d, uSun), 0.0), 64.0) * 0.6;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  s.add(new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), mat));
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0, 0.1, 100);
  pm.dispose();
  mat.dispose();
  return rt.texture;
}
export async function createStation(renderer, glbUrl) {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);

  const panel = panelTexture(), foil = foilTexture();
  // Procedural hull (spine, node modules, hub, spokes): the same pale grey-white panels as the core module
  const mWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, map: panel.map, bumpMap: panel.bump, bumpScale: 1.2, roughness: 0.62, metalness: 0.05, envMapIntensity: 0.7 });
  // Thrust structure: the same panel set, darkened into dark grey metal
  const mHousing = new THREE.MeshStandardMaterial({ color: 0x8a8e95, map: panel.map, bumpMap: panel.bump, bumpScale: 1.2, roughness: 0.5, metalness: 0.6, envMapIntensity: 0.8 });
  const mStrut = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.45, metalness: 0.6 });
  const mFoil = new THREE.MeshStandardMaterial({ color: 0xd9a24a, bumpMap: foil, bumpScale: 1.5, roughness: 0.45, metalness: 1 });
  const mDark = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.55, metalness: 0.5 });
  const cellTex = cellTexture(), bellTex = bellTexture();
  const mBell = new THREE.MeshStandardMaterial({ color: 0x8e9299, map: bellTex, bumpMap: bellTex, bumpScale: 1.5, roughness: 0.45, metalness: 0.8 });
  const mMetal = new THREE.MeshStandardMaterial({ color: 0x8d9198, roughness: 0.42, metalness: 0.75 });
  // The cells carry a little of their own blue (so they still read as blue photovoltaics when backlit, not as a black patch)
  const mCell = new THREE.MeshStandardMaterial({ map: cellTex, emissive: 0xffffff, emissiveMap: cellTex, emissiveIntensity: 0.22, roughness: 0.3, metalness: 0.35 });
  const mCable = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 0.8 });
  const shadowed = (o) => { o.castShadow = o.receiveShadow = true; return o; };

  // ---- core module (NASA Gateway Core) ----
  await MeshoptDecoder.ready;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const buf = await (await fetch(glbUrl)).arrayBuffer();
  const gltf = await loader.parseAsync(buf, '');
  const core = new THREE.Group();
  core.add(gltf.scene);

  core.quaternion.copy(CORE_Q);
  core.position.copy(CORE_AFT).applyQuaternion(CORE_Q).negate();
  // Trim layer: the core module (with the PPE solar array) is rotated / translated as a whole about the station origin = PPE aft interface; it only takes effect after all the clones have been measured, so other parts are unaffected
  const coreTrim = new THREE.Group();
  coreTrim.add(core);
  root.add(coreTrim);

  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    shadowed(o);
    for (const m of [o.material].flat()) {
      m.envMapIntensity = 0.7;
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) if (m[k]) m[k].anisotropy = 4;
    }
  });
  // Solar array: the ROSA roll-out array the PPE module comes with, hung on a pivot that turns about the span axis (station y) to track the Sun
  root.updateMatrixWorld(true);
  const arr = gltf.scene.getObjectByName('Maxar_PPE_Array');
  const arrayPivot = new THREE.Group();
  let arrayHalf = 21.4;                                // half the span (station y), measured from the model below
  if (arr) {
    arr.geometry.computeBoundingBox();
    const b = arr.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(root.matrixWorld.clone().invert(), arr.matrixWorld));
    arrayPivot.position.copy(b.getCenter(new THREE.Vector3()));
    arrayHalf = (b.max.y - b.min.y) / 2;
  } else {
    arrayPivot.position.set(0, 0, 3);
  }
  // The pivot goes into the trim layer (still an identity transform at this point) and the array is attached to it, keeping its position
  coreTrim.add(arrayPivot);
  arrayPivot.updateMatrixWorld(true);
  if (arr) arrayPivot.attach(arr);

  const box = new THREE.BoxGeometry(1, 1, 1);
  const addStruts = (list, parent, mat = mStrut) => {
    const im = shadowed(new THREE.InstancedMesh(box, mat, list.length));
    list.forEach((m, i) => im.setMatrixAt(i, m));
    parent.add(im);
    return im;
  };
  const mesh = (geo, mat, parent = root) => { const m = shadowed(new THREE.Mesh(geo, mat)); parent.add(m); return m; };
  const torus = (R, r, z, mat, parent = root, seg = 96) => { const g = new THREE.TorusGeometry(R, r, 10, seg); g.translate(0, 0, z); return mesh(g, mat, parent); };

  const latheT = (p, seg) => tileLathe(lathe(p, seg), p);

  // ---- reused parts: a kit records a node's position and docking face in station coords, place puts a clone somewhere else (shared geometry and materials) ----
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const relM = (o) => new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
  const boxOf = (nodes) => { const b = new THREE.Box3(); for (const n of nodes) n.traverse((m) => { if (m.isMesh) { m.geometry.computeBoundingBox(); b.union(m.geometry.boundingBox.clone().applyMatrix4(relM(m))); } }); return b; };
  const byName = (...names) => names.map((n) => gltf.scene.getObjectByName(n)).filter(Boolean);
  // Centre of a docking face: the extreme of the bounding box on the face's side, the centre on the other two axes
  const faceOf = (nodes, axis, sign) => { const b = boxOf(nodes), c = b.getCenter(new THREE.Vector3()); c.setComponent(axis, sign > 0 ? b.max.getComponent(axis) : b.min.getComponent(axis)); return c; };
  const X = new THREE.Vector3(1, 0, 0);
  const kit = (nodes, face, dir, skip) => ({ nodes, face, dir, skip, depth: boxOf(nodes).getSize(new THREE.Vector3()).dot(new THREE.Vector3(Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z))) });
  // Bounding box measured from vertices (boxOf takes a local box first and then transforms it, which overestimates parts mounted at an angle); span: the range of vertex projections along ax
  const eachVert = (nodes, fn) => { const v = new THREE.Vector3(); for (const n of nodes) n.traverse((m) => { if (!m.isMesh) return; const q = relM(m), p = m.geometry.attributes.position; for (let i = 0; i < p.count; i++) fn(v.fromBufferAttribute(p, i).applyMatrix4(q)); }); };
  const vbox = (nodes) => { const b = new THREE.Box3(); eachVert(nodes, (v) => b.expandByPoint(v)); return b; };
  const span = (nodes, o, ax) => { let a = Infinity, b = -Infinity; eachVert(nodes, (v) => { const t = v.clone().sub(o).dot(ax); a = Math.min(a, t); b = Math.max(b, t); }); return [a, b]; };
  // Face centre lands at at, face points along dir; when the kit carries up (a reference direction perpendicular to dir) and up is given, the roll about the axis is fixed too (otherwise the roll is arbitrary when turning 180°)
  const frame = (z, y) => { const zz = z.clone().normalize(), yy = y.clone().addScaledVector(zz, -y.dot(zz)).normalize(); return new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(yy, zz), yy, zz); };
  const place = (k, at, dir, parent = root, up) => {
    const holder = new THREE.Group(), inner = new THREE.Group();
    holder.position.copy(at);
    if (up && k.up) holder.quaternion.setFromRotationMatrix(frame(dir, up).multiply(frame(k.dir, k.up).transpose()));
    else holder.quaternion.setFromUnitVectors(k.dir, dir.clone().normalize());
    inner.position.copy(k.face).negate();
    for (const n of k.nodes) {
      const c = n.clone(true);
      if (k.skip) for (const ch of [...c.children]) if (k.skip.test(ch.name)) c.remove(ch);
      relM(n).decompose(c.position, c.quaternion, c.scale);
      inner.add(c);
    }
    holder.add(inner);
    parent.add(holder);
    return holder;
  };
  // The pair of NDS ports at either end of the airlock module: the active port (with the dark frame) faces -x, the passive port faces +x
  const actNodes = byName('NDS_port_active006', 'NDS_port_active_hatch006'), pasNodes = byName('NDS_port_passive002', 'NDS_port_passive_hatch002');
  const ACT = kit(actNodes, faceOf(actNodes, 0, -1), X.clone().negate());
  const PAS = kit(pasNodes, faceOf(pasNodes, 0, 1), X.clone());
  const toAft = new THREE.Vector3(0, 0, -1), toFwd = new THREE.Vector3(0, 0, 1);
  // Ports mounted straight along the spine: in the model the line between the airlock's two ports is 3.4° off ±x, so ports placed along ±x come out skewed (the face edges differ by about 8 cm front to back).
  // Here the line between the two ports is the axis instead, and the face and thickness are also measured from vertices along it; the bent modules of the gravity ring are a separate system and still use ACT / PAS above
  const portAx = vbox(pasNodes).getCenter(new THREE.Vector3()).sub(vbox(actNodes).getCenter(new THREE.Vector3())).normalize();
  const straight = (k, nodes, out) => {
    const c = vbox(nodes).getCenter(new THREE.Vector3()), [a, b] = span(nodes, c, out);
    return { ...k, dir: out.clone(), face: c.clone().addScaledVector(out, b), depth: b - a };
  };
  const ACTs = straight(ACT, actNodes, portAx.clone().negate()), PASs = straight(PAS, pasNodes, portAx);

  // ---- mid section: PPE aft active port → I-Hab clone A → node module 1 (solar array) → I-Hab clone B → node module 2 (solar array) → spine → gravity ring hub ----
  // Every module joint is NDS active port to passive port; the I-Hab clones leave out the radiator (22 m when deployed, it would clash with the solar arrays)
  const zJ = -0.12 - ACTs.depth;                      // docking face of the active port on the PPE aft face (the back of the port sits on the PPE aft face at z = -0.12)
  place(ACTs, new THREE.Vector3(0, 0, zJ), toAft);
  // I-Hab axis: the line between the centres of the axial ports at the two ends; kit face = the outer face of the passive port, dir runs from the active port to the passive port, up = the radiator side (station +y)
  const ihP = byName('NDS_port_passive001', 'NDS_port_passive_hatch001'), ihA = byName('NDS_port_active003', 'NDS_port_active_hatch003');
  const ihPc = vbox(ihP).getCenter(new THREE.Vector3()), ihAc = vbox(ihA).getCenter(new THREE.Vector3());
  const ihU = ihAc.clone().sub(ihPc).normalize();
  const ihLo = span(ihP, ihPc, ihU)[0], ihLen = span(ihA, ihPc, ihU)[1] - ihLo;
  const IHAB = kit(byName('iHAB'), ihPc.clone().addScaledVector(ihU, ihLo), ihU.clone().negate(), /Radiator/);
  IHAB.up = new THREE.Vector3(0, 1, 0);
  // Clone B: turned 90° (the side ports face ±y, the antenna sits on the +x side), without the blinds on the side ports, to tell it apart from A
  const IHAB_B = { ...IHAB, skip: /Radiator|Shutter/ };
  const yUp = new THREE.Vector3(0, 1, 0), xUp = new THREE.Vector3(1, 0, 0);
  // Node module: passive port at the front (narrow collar), active port at the back (wide collar) or tapering straight into the spine; a band of gold insulation round the middle, two stiffening rings
  const nodeDrum = (zF, zA, rA) => {
    const zc = (zF + zA) / 2, h = (zF - zA) / 2;
    mesh(latheT([[rA, zA], [2.0, zA + 0.45], [2.2, zc - h + 0.75], [2.2, zc + h - 0.75], [2.0, zF - 0.45], [1.05, zF]], 48), mWhite);
    const cap = new THREE.RingGeometry(0.84, 1.06, 48, 1);
    cap.translate(0, 0, zF - 0.01);
    mesh(cap, mWhite);
    for (const s of [1, -1]) torus(2.22, 0.08, zc + s * (h - 0.75), mMetal);
    mesh(lathe([[2.21, zc - 0.32], [2.21, zc + 0.32]], 48), mFoil);
    return zc;
  };
  // Chained from front to back: every z is either a docking face or a back face
  const v0 = (z) => new THREE.Vector3(0, 0, z);
  place(IHAB, v0(zJ), toFwd, root, yUp);
  const zA1 = zJ - ihLen;                             // face of clone A's active port
  place(PASs, v0(zA1), toFwd);
  const zN1a = zA1 - PASs.depth - NODE.len;           // aft end of node module 1 (back of the active port)
  const wingZ = [nodeDrum(zA1 - PASs.depth, zN1a, 1.5)];
  const zB0 = zN1a - ACTs.depth;                      // docking face of node module 1's active port = face of clone B's passive port
  place(ACTs, v0(zB0), toAft);
  place(IHAB_B, v0(zB0), toFwd, root, xUp);
  const zA2 = zB0 - ihLen;
  place(PASs, v0(zA2), toFwd);
  const spineTop = zA2 - PASs.depth - NODE.len;       // aft end of node module 2, tapering straight into the spine
  wingZ.push(nodeDrum(zA2 - PASs.depth, spineTop, SPINE.r));
  // Spine: aft end of node module 2 → hub → the back of the active port ahead of the propulsion module (plugs in 5 cm); a few stiffening rings on each of the two exposed sections
  const spineEnd = ENGINE.tank + ACTs.depth - 0.05;
  const spineLen = spineTop - spineEnd;
  const spineGeo = tileCylinder(new THREE.CylinderGeometry(SPINE.r, SPINE.r, spineLen, 40, 1, true), SPINE.r, spineLen);
  spineGeo.rotateX(Math.PI / 2);
  spineGeo.translate(0, 0, (spineTop + spineEnd) / 2);
  mesh(spineGeo, mWhite);
  for (const [a, b] of [[spineTop, RING.z + 3.3], [RING.z - 3.3, ENGINE.tank + ACTs.depth]]) {
    const n = Math.max(1, Math.floor((a - b) / 1.4));
    for (let k = 1; k <= n; k++) torus(SPINE.r + 0.04, 0.06, a - ((a - b) * k) / (n + 1), mMetal, root, 48);
  }

  // ---- gravity ring: 16 airlock modules each bent into a 1/16 arc, active port to passive port end to end; hub drum + four spokes (NDS ports at both ends) + tension cables ----
  const zr = RING.z;
  // Stationary bearing housings: clamp the hub drum front and back, sleeved on the spine
  mesh(latheT([[SPINE.r, zr + 2.15], [RING.hub, zr + 2.15], [RING.hub, zr + 2.75], [1.55, zr + 3.15], [SPINE.r, zr + 3.3]], 56), mHousing);
  mesh(latheT([[SPINE.r, zr - 3.3], [1.55, zr - 3.15], [RING.hub, zr - 2.75], [RING.hub, zr - 2.15], [SPINE.r, zr - 2.15]], 56), mHousing);
  mesh(lathe([[RING.hub + 0.01, zr + 2.3], [RING.hub + 0.01, zr + 2.6]], 56), mFoil);
  mesh(lathe([[RING.hub + 0.01, zr - 2.6], [RING.hub + 0.01, zr - 2.3]], 56), mFoil);
  torus(RING.hub + 0.02, 0.06, zr + 2.18, mMetal, root, 64);
  torus(RING.hub + 0.02, 0.06, zr - 2.18, mMetal, root, 64);

  const ring = new THREE.Group();
  ring.position.z = zr;
  root.add(ring);
  // Airlock module (hull + ports at both ends, no radiator or blinds): axis along x, so once bent into the ring the hull's +z points outward and +y runs along the ring axis (equipment boxes face fore and aft, the inner and outer sides stay clean)
  const alNodes = byName('Airlock', 'NDS_port_active006', 'NDS_port_active_hatch006', 'NDS_port_passive002', 'NDS_port_passive_hatch002');
  // The module axis is the line between the centres of the ports at the two ends (in the model the two ports differ by 0.2 m; taking the line makes neighbouring modules' ports line up exactly)
  const aF = ACT.face, pF = PAS.face, segL = pF.distanceTo(aF), R = (RING.n * segL) / (2 * Math.PI);
  const alBox = boxOf(byName('Airlock')), hullR = (alBox.max.z - alBox.min.z) / 2;
  const fa = pF.clone().sub(aF).normalize(), fv = zAx.clone().addScaledVector(fa, -fa.z).normalize();
  const fr = { c0: aF.clone().add(pF).multiplyScalar(0.5), a: fa, v: fv, w: new THREE.Vector3().crossVectors(fv, fa) };
  const rot = new THREE.Matrix4();
  for (const n of alNodes) n.traverse((m) => {
    if (!m.isMesh) return;
    const im = shadowed(new THREE.InstancedMesh(bendRing(bakeMesh(m, relM(m)), fr, R), m.material, RING.n));
    for (let k = 0; k < RING.n; k++) im.setMatrixAt(k, rot.makeRotationZ((k / RING.n) * Math.PI * 2));
    im.computeBoundingSphere();
    ring.add(im);
  });
  // Outward-facing ports on the outside of modules 2, 6, 10 and 14
  for (const k of [2, 6, 10, 14]) {
    const a = (k / RING.n) * Math.PI * 2, rOut = R + hullR + 0.6;
    const d = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    place(ACT, d.clone().multiplyScalar(rOut), d, ring);
  }
  // Hub drum: turns with the ring, four passive ports round its waist take the spokes
  mesh(latheT([[1.1, -2.0], [1.75, -1.85], [2.35, -1.45], [RING.hub, -1.0], [RING.hub, 1.0], [2.35, 1.45], [1.75, 1.85], [1.1, 2.0]], 64), mWhite, ring);
  torus(RING.hub + 0.02, 0.05, 1.0, mMetal, ring, 64);
  torus(RING.hub + 0.02, 0.05, -1.0, mMetal, ring, 64);
  // Four spokes: passive port at the hub end, active port at the module end (the frame sits into the inside of the hull), a pressurised tube in between, a hoop at intervals, a thin conduit running alongside
  const rIn = R - (fr.c0.z - alBox.min.z);           // radius of the module's inner generatrix
  const rHub = RING.hub + 0.45, rEnd = rIn - 0.12;
  const s0 = rHub - PAS.depth * 0.6, s1 = rEnd + ACT.depth * 0.6, sLen = s1 - s0, sR = 0.55;
  const cables = [], conduits = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2, d = new THREE.Vector3(Math.cos(a), Math.sin(a), 0), t = new THREE.Vector3(-d.y, d.x, 0);
    place(PAS, d.clone().multiplyScalar(rHub), d, ring);
    place(ACT, d.clone().multiplyScalar(rEnd), d.clone().negate(), ring);
    const tube = mesh(tileCylinder(new THREE.CylinderGeometry(sR, sR, sLen, 24, 1, true), sR, sLen), mWhite, ring);
    tube.position.copy(d).multiplyScalar((s0 + s1) / 2);
    tube.quaternion.setFromUnitVectors(_y, d);
    for (let r = s0 + 1.6; r < s1 - 1.0; r += 2.2) {
      const hoop = mesh(new THREE.TorusGeometry(sR + 0.03, 0.035, 6, 32), mMetal, ring);
      hoop.position.copy(d).multiplyScalar(r);
      hoop.quaternion.setFromUnitVectors(zAx, d);
    }
    strut(d.clone().multiplyScalar(s0 + 0.4).addScaledVector(t, sR + 0.07), d.clone().multiplyScalar(s1 - 0.4).addScaledVector(t, sR + 0.07), 0.07, conduits);
  }
  addStruts(conduits, ring, mMetal);
  // Tension cables: from the two ends of the hub to the inside of the modules, crossing front to back (like bicycle spokes), kept clear of the spokes
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2 + Math.PI / 32;
    const off = Math.abs(((a + Math.PI / 4) % (Math.PI / 2)) - Math.PI / 4);
    if (off < 0.2) continue;
    const s = k % 2 ? 1 : -1, b = a + s * 0.06;
    strut(new THREE.Vector3(Math.cos(a) * 1.9, Math.sin(a) * 1.9, s * 1.75),
      new THREE.Vector3(Math.cos(b) * (R - hullR * 0.7), Math.sin(b) * (R - hullR * 0.7), -s * hullR * 0.7), 0.035, cables);
  }
  addStruts(cables, ring, mCable);

  // ---- solar arrays: the pair on the PPE + two cloned pairs on the spine's wing-root node modules, three pairs parallel, tracking the Sun at one angle ----
  // The clones share geometry and materials with the original array; the mounts turn with the core module's trim layer, so the three pairs stay parallel
  const wings = [arrayPivot], wingMounts = [];
  if (arr) {
    for (const z of wingZ) {
      const mount = new THREE.Group(), pivot = new THREE.Group();
      mount.position.z = z;
      pivot.scale.setScalar(WINGS.scale);
      pivot.add(arr.clone());
      mount.add(pivot);
      root.add(mount);
      wings.push(pivot);
      wingMounts.push(mount);
    }
  }

  // ---- propulsion section: the ESPRIT module serves as the propellant tank (passive port forward to the spine, active port aft to the thrust structure) → stepped thrust structure → seven nozzles ----
  // Again the line between the two ports is the axis, so the ports at both ends sit on the spine line
  const espP = faceOf(byName('NDS_Port_Passive'), 0, 1), espA = faceOf(byName('NDS_Port_Active'), 0, -1);
  const ESP = kit(byName('ERMXL'), espP, espP.clone().sub(espA).normalize(), /Shutter/);
  const esp = place(ESP, new THREE.Vector3(0, 0, ENGINE.tank), toFwd);
  // The module has several nearly mirror-like flat plates that, re-oriented, reflect the Sun straight into the default camera and blow up into white blobs under bloom: clone the material and put a floor on its roughness
  const matte = new Map();
  esp.traverse((o) => {
    if (!o.isMesh) return;
    if (!matte.has(o.material)) {
      const c = o.material.clone();
      c.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = max( roughnessFactor, 0.5 );'); };
      c.customProgramCacheKey = () => 'rough-floor-0.5';
      matte.set(o.material, c);
    }
    o.material = matte.get(o.material);
  });
  place(ACTs, new THREE.Vector3(0, 0, ENGINE.tank), toAft);         // active port at the aft end of the spine, mating with the propulsion module's passive port
  const zE = ENGINE.tank - espP.distanceTo(espA);                   // face of the propulsion module's active port (facing aft)
  place(PASs, new THREE.Vector3(0, 0, zE), toFwd);                  // passive port at the front of the thrust structure
  const zp = ENGINE.plate, zn = zE - PASs.depth;
  // Thrust structure: three steps widening towards the rear, thin metal rings between the steps, a band of gold insulation on the middle step, a ring of vertical ribs on the outer and upper steps
  mesh(latheT([[3.95, zp], [4.15, zp + 0.1], [4.15, zp + 0.95], [3.55, zp + 1.15], [3.55, zp + 1.75], [2.75, zp + 1.95], [2.75, zp + 2.2], [2.25, zp + 2.28], [1.0, zn - 0.06], [0.95, zn]], 72), mHousing);
  const plateG = new THREE.RingGeometry(0.9, 3.98, 72, 1);
  plateG.rotateY(Math.PI);
  plateG.translate(0, 0, zp);
  mesh(plateG, mDark);
  mesh(lathe([[3.56, zp + 1.3], [3.56, zp + 1.6]], 72), mFoil);
  for (const [r, z] of [[4.16, zp + 0.95], [4.16, zp + 0.1], [3.56, zp + 1.75], [2.76, zp + 2.2]]) torus(r, 0.05, z, mMetal, root, 96);
  const ribs = [];
  for (const [n, r, z0, z1] of [[48, 4.17, zp + 0.18, zp + 0.88], [36, 2.77, zp + 1.98, zp + 2.18]])
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      ribs.push(new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, (z0 + z1) / 2),
        new THREE.Quaternion().setFromAxisAngle(zAx, a), new THREE.Vector3(0.07, 0.06, z1 - z0)));
    }
  addStruts(ribs, root, mMetal);

  // Seven nozzles: cooling tubes round the outer wall, the liner brightest at the throat; an emissive disc caps the throat; a few thin rings at the lip and the manifold
  const nozzleTex = nozzleTexture();
  nozzleTex.flipY = false;
  // Seven nozzles lit at once blur into one mass: the liner only glows faintly around the throat and the base colour is darkened
  const mLiner = new THREE.MeshStandardMaterial({ color: 0x0b0d10, emissive: 0xffffff, emissiveMap: nozzleTex, emissiveIntensity: 0.28, roughness: 0.7, metalness: 0.2 });
  const re = ENGINE.rExit, bell = [[0.58, -0.05], [0.5, -0.45], [0.42, -0.75], [0.6, -1.15], [0.85, -1.65], [1.08, -2.3], [re, -ENGINE.bell]];
  const bellR = (dz) => { for (let i = 1; i < bell.length; i++) if (dz >= bell[i][1]) { const [r0, z0] = bell[i - 1], [r1, z1] = bell[i]; return r0 + ((dz - z0) / (z1 - z0)) * (r1 - r0); } return re; };
  const centers = [new THREE.Vector2(0, 0), ...[...Array(6)].map((_, k) => new THREE.Vector2(Math.cos((k / 6) * Math.PI * 2), Math.sin((k / 6) * Math.PI * 2)).multiplyScalar(ENGINE.spread))];
  const gOut = [], gIn = [], gRing = [], gDisc = [];
  for (const c of centers) {
    const prof = bell.map(([r, dz]) => [r, zp + dz]);
    gOut.push(lathe([...prof].reverse(), 64).translate(c.x, c.y, 0));
    gIn.push(lathe(prof.map(([r, z]) => [r * 0.96, z]), 64).translate(c.x, c.y, 0));
    for (const dz of [-0.75, -1.6, -2.35]) gRing.push(new THREE.TorusGeometry(bellR(dz) + 0.03, 0.035, 6, 48).translate(c.x, c.y, zp + dz));
    gRing.push(new THREE.TorusGeometry(re, 0.06, 8, 64).translate(c.x, c.y, ENGINE.exit));
    gDisc.push(new THREE.CircleGeometry(0.4, 32).rotateY(Math.PI).translate(c.x, c.y, zp - 0.75));
  }
  mesh(mergeGeometries(gOut), mBell);
  mesh(mergeGeometries(gIn), mLiner);
  mesh(mergeGeometries(gRing), mMetal);
  // Standby: only a hint of light at the throat, no exhaust plume drawn (from behind, seven plume cones stack into a layer of blue haze that washes the nozzle inner walls pale)
  root.add(new THREE.Mesh(mergeGeometries(gDisc), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x9cc4ff).multiplyScalar(1.1) })));
  // On the thrust plate: six turbopump boxes between the outer nozzles, one gimbal actuator per outer nozzle; four attitude thruster clusters on the outer step of the thrust structure
  const gKit = [], gPod = [];
  for (let k = 0; k < 6; k++) {
    const a = ((k + 0.5) / 6) * Math.PI * 2, d = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    gKit.push(new THREE.BoxGeometry(0.5, 0.42, 0.55).rotateZ(a).translate(d.x * 1.75, d.y * 1.75, zp - 0.3));
    const c = centers[k + 1], u = new THREE.Vector3(c.x, c.y, 0).normalize();
    const m0 = u.clone().multiplyScalar(ENGINE.spread + 0.85).setZ(zp - 0.02);
    const m1 = new THREE.Vector3(c.x, c.y, 0).addScaledVector(u, bellR(-1.25) + 0.06).setZ(zp - 1.25);
    strut(m0, m1, 0.09, ribs);
  }
  addStruts(ribs.splice(0), root, mMetal);
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k / 4) * Math.PI * 2, d = new THREE.Vector3(Math.cos(a), Math.sin(a), 0), t = new THREE.Vector3(-d.y, d.x, 0);
    gPod.push(new THREE.BoxGeometry(0.42, 0.62, 0.62).rotateZ(a).translate(d.x * 4.35, d.y * 4.35, zp + 0.5));
    for (const s of [1, -1]) {
      const cone = new THREE.CylinderGeometry(0.05, 0.1, 0.2, 10, 1, true);
      cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_y, t.clone().multiplyScalar(-s)));
      gKit.push(cone.translate(d.x * 4.35 + t.x * s * 0.4, d.y * 4.35 + t.y * s * 0.4, zp + 0.5));
    }
    gKit.push(new THREE.CylinderGeometry(0.05, 0.1, 0.2, 10, 1, true).rotateX(Math.PI / 2).translate(d.x * 4.35, d.y * 4.35, zp + 0.09));
  }
  mesh(mergeGeometries(gKit), mDark);
  mesh(mergeGeometries(gPod), mStrut);

  const engineLight = new THREE.PointLight(0x7fa8ff, 18, 14, 2);
  engineLight.position.z = ENGINE.exit - 2.5;
  root.add(engineLight);

  // ---- high-gain antenna: a crossbar runs out from clone B's +x side, aimed at Earth ----
  // Mounted on +x: the array planes always stay beyond |y| > 2.1, so the antenna clears them wherever it turns; the crossbar is long enough that the dish clears the hull when swung back too
  const dishX = 4.6, dishZ = zB0 - ihLen * 0.24, mastIn = 1.5;
  const dishPivot = new THREE.Group();
  dishPivot.position.set(dishX, 0, dishZ);
  const dishGeo = new THREE.LatheGeometry([...Array(13)].map((_, i) => new THREE.Vector2(i * 0.15, (i * 0.15) ** 2 * 0.28)), 40);
  dishGeo.rotateX(Math.PI / 2);
  const dish = shadowed(new THREE.Mesh(dishGeo, new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.55, side: THREE.DoubleSide })));
  const feed = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 8), mStrut));
  feed.rotation.x = Math.PI / 2;
  feed.position.z = 0.55;
  dish.add(feed);
  dishPivot.add(dish);
  const mast = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, dishX - mastIn, 8), mStrut));
  mast.rotation.z = Math.PI / 2;
  mast.position.set((dishX + mastIn) / 2, 0, dishZ);
  root.add(dishPivot, mast);

  // ---- navigation lights: small, brief flashes, no halo effects ----
  const glow = glowTexture();
  const navs = [];
  const nav = (parent, pos, hex, gain, period, phase) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glow, color: new THREE.Color(hex).multiplyScalar(gain),
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    sp.scale.setScalar(0.45);
    sp.position.copy(pos);
    parent.add(sp);
    navs.push({ sp, period, phase });
  };
  nav(root, new THREE.Vector3(4.3, 0, ENGINE.plate + 0.95), 0xffffff, 2, 2.2, 0.5);
  const ringTip = R + hullR + 0.15;
  for (const a of [Math.PI / 2, -Math.PI / 2]) nav(ring, new THREE.Vector3(Math.cos(a) * ringTip, Math.sin(a) * ringTip, 0), 0xff3020, 1.4, 1.6, 0.8);

  // ---- lighting: Sun (with shadows) + soft light from the lunar surface albedo ----
  const sun = new THREE.DirectionalLight(0xfff6ea, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 600 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const moonFill = new THREE.HemisphereLight(0x05070a, 0x8a8d92, 0.6);
  // The lit lunar surface underfoot adds a little light from below, so the hull's silhouette in shadow does not go completely black
  const bounce = new THREE.DirectionalLight(0xc8ccd2, 0.9);
  scene.add(moonFill, bounce, bounce.target);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 6000);
  const pass = new StationPass(scene, camera);
  let envReady = false;

  // HUD anchor points (station coords, metres)
  const CENTER = new THREE.Vector3(0, 0, -15);
  const CORE_ANCHOR = new THREE.Vector3(-1.5, 2.6, 13);
  const anchors = {
    core: CORE_ANCHOR.clone(),
    ring: new THREE.Vector3(0, R + hullR, RING.z),
    array: new THREE.Vector3(),
    engine: new THREE.Vector3(0, 2.8, ENGINE.tank - 3.5),
  };
  // Array anchor: all three pairs turn about the span axis, and a point near the tip of an array plane does not move with the tracking; pick the one furthest from the other three anchors (the station is short, so nearby labels would crowd together)
  let far = -1;
  for (const [z, s] of [[arrayPivot.position.z, 1], ...wingZ.map((z) => [z, WINGS.scale])]) {
    for (const side of [1, -1]) {
      const p = new THREE.Vector3(0, side * arrayHalf * s * 0.85, z);
      const d = Math.min(p.distanceTo(anchors.core), p.distanceTo(anchors.ring), p.distanceTo(anchors.engine));
      if (d > far) { far = d; anchors.array.copy(p); }
    }
  }

  // Calibration: station spine reference line (x = y = 0), depth test off so it shows through the hull
  const axisGuide = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 32), new THREE.Vector3(0, 0, ENGINE.exit - 4)]),
    new THREE.LineBasicMaterial({ color: 0xff3b30, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 }),
  );
  axisGuide.renderOrder = 999;
  axisGuide.visible = false;
  root.add(axisGuide);
  // Calibration: HALO module centreline (centre of the module's aft face → centre of the front axial port, measured from vertices; extended both ways to cover the PPE and I-Hab), parented to the core module so it follows the trim
  const hb = vbox(byName('NG_HALO001'));
  const haloAft = new THREE.Vector3((hb.min.x + hb.max.x) / 2, (hb.min.y + hb.max.y) / 2, hb.min.z);
  const haloFwd = vbox(byName('NDS_Port_Active_Y+')).getCenter(new THREE.Vector3());
  const haloDir = haloFwd.clone().sub(haloAft).normalize();
  core.updateMatrixWorld(true);
  const toCore = core.matrixWorld.clone().invert();
  const coreAxis = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([-9, 19].map((s) => haloAft.clone().addScaledVector(haloDir, s).applyMatrix4(toCore))),
    new THREE.LineBasicMaterial({ color: 0x4fb8ff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }),
  );
  coreAxis.renderOrder = 999;
  coreAxis.visible = false;
  core.add(coreAxis);
  // Core module trim: r* degrees (station axes, Euler XYZ), d* metres
  function adjustCore({ rx = 0, ry = 0, rz = 0, dx = 0, dy = 0, dz = 0 }) {
    const k = THREE.MathUtils.DEG2RAD;
    coreTrim.rotation.set(rx * k, ry * k, rz * k);
    coreTrim.position.set(dx, dy, dz);
    for (const m of wingMounts) m.quaternion.copy(coreTrim.quaternion);
    // the core module's anchor point follows the module
    coreTrim.updateMatrix();
    anchors.core.copy(CORE_ANCHOR).applyMatrix4(coreTrim.matrix);
  }
  const showAxis = (on) => { axisGuide.visible = coreAxis.visible = on; };
  adjustCore(CORE_TRIM);

  // ---- relay orbit: a Keplerian ellipse about the Moon's centre, drawn as a thin dashed line ----
  // The station pass renders in camera-relative kilometres (see update()), so the orbit is built the same way:
  // each sample is converted to scene km, expressed relative to the camera, then scaled into the pass.
  const ORBIT_N = 720;
  let orbitLine = null;
  function orbitPositions(o, RM, camPos, out) {
    const a = RM + (o.perilune + o.apolune) / 2;                 // semi-major axis, km
    const e = (o.apolune - o.perilune) / (o.apolune + o.perilune);
    const inc = THREE.MathUtils.degToRad(o.inc);
    // The main scene uses the same units as the lunar map: metres, with the Moon's centre at (0, -R, 0).
    // Build the ellipse directly in that frame (orbital plane tilted by the inclination about x).
    for (let i = 0; i <= ORBIT_N; i++) {
      const nu = (i / ORBIT_N) * Math.PI * 2;
      const r = (a * (1 - e * e)) / (1 + e * Math.cos(nu));      // km
      const x = r * Math.cos(nu) * 1000;
      const y = r * Math.sin(nu) * Math.cos(inc) * 1000 - RM * 1000;
      const z = r * Math.sin(nu) * Math.sin(inc) * 1000;
      out[i * 3] = x - camPos.x * 1000;
      out[i * 3 + 1] = y - camPos.y * 1000;
      out[i * 3 + 2] = z - camPos.z * 1000;
    }
  }
  // The ellipse spans tens of thousands of km, far outside the station pass's own projection, so the line is
  // drawn in the main scene instead: positions there are absolute scene km and need no camera offset.
  let orbitMain = null;
  function showOrbit(o, RM, at) {
    const N = (orbitMain && orbitMain.geometry.attributes.position.count) || ORBIT_N + 1;
    if (!orbitMain) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
      orbitMain = new THREE.Line(g, new THREE.LineDashedMaterial({
        color: 0xff5640, dashSize: 4e7, gapSize: 3e7, transparent: true, opacity: 0.5, depthWrite: false,
      }));
      orbitMain.renderOrder = 3;
      orbitMain.frustumCulled = false;
    }
    const attr = orbitMain.geometry.attributes.position;
    const zero = new THREE.Vector3();
    orbitPositions(o, RM, zero, attr.array);
    attr.needsUpdate = true;
    orbitMain.geometry.computeBoundingSphere();
    orbitMain.computeLineDistances();
    return orbitMain;
  }
  const orbitObject = () => orbitMain;


  // place: { pos (km, scene coords), quat }, supplied by rig.stationPlacement()
  function create(place) {
    const qInv = place.quat.clone().invert();
    const localToWorld = (p, out = new THREE.Vector3()) => out.copy(p).applyQuaternion(place.quat).multiplyScalar(M).add(place.pos);
    const sl = new THREE.Vector3(), el = new THREE.Vector3(), c = new THREE.Vector3(), qTrim = new THREE.Quaternion();

    function update(cam, eph, t, visible) {
      pass.enabled = visible;
      if (!visible) return;
      if (!envReady) {
        scene.environment = environment(renderer, eph.sunDir, place.up);
        envReady = true;
      }
      ring.rotation.z = (t / 1000) * RING.rpm * Math.PI / 30;
      // All three array pairs at one angle: turn about the span axis (y in the trim layer) until the normal faces the Sun
      sl.copy(eph.sunDir).applyQuaternion(qInv).applyQuaternion(qTrim.copy(coreTrim.quaternion).invert());
      const beta = Math.atan2(sl.x, sl.z);
      for (const w of wings) w.rotation.y = beta;
      el.copy(eph.earthPos).sub(place.pos).normalize().applyQuaternion(qInv);
      dish.quaternion.setFromUnitVectors(zAx, el);
      for (const n of navs) n.sp.visible = ((t / 1000 + n.phase) % n.period) < 0.12;

      // camera at the origin, metres as units
      root.position.copy(place.pos).sub(cam.position).multiplyScalar(1000);
      root.quaternion.copy(place.quat);
      c.copy(CENTER).applyQuaternion(place.quat).add(root.position);
      sun.target.position.copy(c);
      sun.position.copy(c).addScaledVector(eph.sunDir, 300);
      moonFill.position.copy(place.up);
      bounce.target.position.copy(c);
      bounce.position.copy(c).addScaledVector(place.up, -200);
      camera.quaternion.copy(cam.quaternion);
      const d = c.length();
      camera.near = THREE.MathUtils.clamp(d * 0.02, 0.5, 400);
      camera.far = d + 400;
      camera.fov = cam.fov;
      camera.aspect = cam.aspect;
      camera.updateProjectionMatrix();
    }

    return { update, localToWorld, anchors, place, adjustCore, showAxis };
  }

  return { create, pass, scene, root, showOrbit };
}
