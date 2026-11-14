// Polar lunar rover (Space ROS's lunar_pole_exploration_rover, modelled on NASA VIPER; see tools/prep_rover.py).
// In the glb each URDF link is one node, with joint type, axis and limits in extras.urdf; joints are driven straight from the URDF:
// each of the four wheels steers (Ackermann / point turn / crab), wheels roll, the mast gimbal pans and tilts.
//
// Rendering: the main scene's near plane is at 50 m and the rover is only 1.5 m across, so, like the orbital station, it gets its own scene in metres and, once the main scene
// has been drawn, is overlaid after the depth buffer is cleared. The overlay carries not just the rover but a near patch of ground (the NEAR branch of the same terrain shader): the main terrain is
// cut out inside this disc, and the outer edge of the patch fades into the main terrain's triangles so the seam lines up.
// Coordinates: local = map coords relative to point A (metres), used by the rover state, the tracks and the rocks; near = near-scene coords (metres), where
// the origin uO is at the patch centre; when the rover drives far enough the whole patch moves to the rover (snapped to the main terrain grid) and local is unchanged.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { nearVert } from '../glsl/near.js';
import { terrainFrag } from '../glsl/terrain.js';
import { GRID } from './terrain.js';
import { createTracks, TRACK } from './tracks.js';
import { createRocks } from './rocks.js';

const PATCH = { half: 480, step: 4, trim: 470, morph0: 380, morph1: 440, recenter: 100 };
// Speeds are faster than the real vehicle for the demo: the real one is very slow, which is no fun to drive here
const DRIVE = { vMax: 1.2, vRev: 0.6, acc: 0.8, brake: 2.2, steerRate: 1.6, yawMax: 0.55, kMax: 0.65, crab: 0.75, slopeWarn: 15, slopeMax: 25, range: 1600 };
const SH = { half: 2.8, size: 1024, back: 8, far: 34 };
const LIFT = THREE.MathUtils.degToRad(5);          // matches uLift in the terrain shader: the Sun is raised 5° for shading

class NearPass extends Pass {
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

// Environment lighting for the body materials: the lower hemisphere is regolith under the low Sun (a little brighter on the side away from the Sun, from regolith backscatter), the upper hemisphere is black
function envScene(up, sunH, ground) {
  const s = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uUp: { value: up.clone() }, uSun: { value: sunH.clone() }, uG: { value: ground } },
    vertexShader: 'varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uUp, uSun; uniform float uG; varying vec3 vD;
      void main() {
        vec3 d = normalize(vD);
        float g = smoothstep(0.02, -0.04, dot(d, uUp));
        float back = 0.75 + 0.5 * max(dot(-d, uSun), 0.0);
        gl_FragColor = vec4(vec3(0.97, 0.98, 1.0) * uG * back * g, 1.0);
      }`,
  });
  s.add(new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), mat));
  return s;
}
// ctx: { R, terrain, tiles, shadows, eph, anchor (point A in map km), heightAt, mapToScene, sceneToMap, upAt, crater }
export async function createRover(renderer, glbUrl, ctx) {
  const { R, terrain, tiles, eph } = ctx;
  const A = ctx.anchor.clone();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
  const pass = new NearPass(scene, camera);
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), m2 = new THREE.Vector2();

  // ---------- near patch: centre aligned to a main terrain grid vertex ----------
  const gStep = (2 * GRID.half) / GRID.n;
  const PC = new THREE.Vector2();                    // patch centre (map km)
  const PCA = new THREE.Vector2();                   // patch centre relative to point A (metres)
  const O = new THREE.Vector3();                     // near-scene origin (scene km)
  function recenter(lx, ly) {
    const mx = A.x + lx / 1000, my = A.y + ly / 1000;
    PC.set(Math.round((mx + GRID.half) / gStep) * gStep - GRID.half, Math.round((my + GRID.half) / gStep) * gStep - GRID.half);
    PCA.set((PC.x - A.x) * 1000, (PC.y - A.y) * 1000);
    ctx.mapToScene(R, PC, 0, O);
  }

  // Bilinear sampling of the 40 m elevation at the pole (km), matching heroFine in the vertex shader
  const hero = tiles.hero, hn = hero.size, hE = hero.half_extent_m / 1000, hh = hero.heights;
  function heroFine(mx, my) {
    const c = (mx / (2 * hE) + 0.5) * hn - 0.5, r = (0.5 - my / (2 * hE)) * hn - 0.5;
    const c0 = Math.max(0, Math.min(hn - 2, Math.floor(c))), r0 = Math.max(0, Math.min(hn - 2, Math.floor(r)));
    const fc = Math.min(1, Math.max(0, c - c0)), fr = Math.min(1, Math.max(0, r - r0)), i = r0 * hn + c0;
    return ((hh[i] * (1 - fc) + hh[i + 1] * fc) * (1 - fr) + (hh[i + hn] * (1 - fc) + hh[i + hn + 1] * fc) * fr) / 1000;
  }
  // Patch surface height (km): interpolated over the triangles of the 4 m grid, exactly like the drawn ground, so the wheels neither float nor sink
  function heightLocal(lx, ly) {
    const gx = (lx - PCA.x) / PATCH.step, gy = (ly - PCA.y) / PATCH.step;
    const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
    const vx = (ii) => PC.x + (ii * PATCH.step) / 1000, vy = (jj) => PC.y + (jj * PATCH.step) / 1000;
    const h00 = heroFine(vx(i), vy(j)), h10 = heroFine(vx(i + 1), vy(j)), h01 = heroFine(vx(i), vy(j + 1)), h11 = heroFine(vx(i + 1), vy(j + 1));
    if (fx + fy <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fy;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fy);
  }
  // local (metres) + height above the ground (km) → near (metres)
  function toNear(lx, ly, dh, out = new THREE.Vector3()) {
    m2.set(A.x + lx / 1000, A.y + ly / 1000);
    ctx.mapToScene(R, m2, heightLocal(lx, ly) + dh, out);
    return out.sub(O).multiplyScalar(1000);
  }
  // near (metres) → local (metres); h is the height above the reference sphere (km)
  function fromNear(p) {
    tmp2.copy(p).multiplyScalar(0.001).add(O);
    const r = ctx.sceneToMap(R, tmp2, new THREE.Vector2());
    return { x: (r.m.x - A.x) * 1000, y: (r.m.y - A.y) * 1000, h: r.h };
  }
  // Tangent frame at a local position: up plus the map +X (east) and +Y (north) directions, the same as ex / ey in the terrain shader
  function basis(lx, ly) {
    m2.set(A.x + lx / 1000, A.y + ly / 1000);
    ctx.mapToScene(R, m2, heightLocal(lx, ly), tmp2);
    const up = ctx.upAt(R, tmp2, new THREE.Vector3());
    const ex = new THREE.Vector3(1, 0, 0).addScaledVector(up, -up.x).normalize();
    const ey = new THREE.Vector3(0, 0, -1).addScaledVector(up, up.z).normalize();
    return { up, ex, ey };
  }
  function slopeDeg(lx, ly) {
    const e = 0.8;
    const gx = (heightLocal(lx + e, ly) - heightLocal(lx - e, ly)) * 1000 / (2 * e);
    const gy = (heightLocal(lx, ly + e) - heightLocal(lx, ly - e)) * 1000 / (2 * e);
    return THREE.MathUtils.radToDeg(Math.atan(Math.hypot(gx, gy)));
  }

  const n = (2 * PATCH.half) / PATCH.step;
  const gpos = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0, k = 0; j <= n; j++)
    for (let i = 0; i <= n; i++, k += 3) { gpos[k] = -PATCH.half + i * PATCH.step; gpos[k + 2] = -PATCH.half + j * PATCH.step; }
  const gidx = new Uint32Array(n * n * 6);
  for (let j = 0, k = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      gidx.set([a, b, c, b, d, c], k); k += 6;
    }
  const patchGeo = new THREE.BufferGeometry();
  patchGeo.setAttribute('position', new THREE.BufferAttribute(gpos, 3));
  patchGeo.setIndex(new THREE.BufferAttribute(gidx, 1));
  const tracks = createTracks(renderer);
  const mkShRT = () => new THREE.WebGLRenderTarget(SH.size, SH.size, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  const shRT = { S: mkShRT(), K: mkShRT() };
  const nu = {
    uLayer: { value: 0 },
    uPC: { value: PC }, uPCA: { value: PCA }, uO: { value: O },
    uMorph0: { value: PATCH.morph0 }, uMorph1: { value: PATCH.morph1 }, uGridE: { value: GRID.half }, uGridN: { value: GRID.n },
    uTrimR: { value: PATCH.trim }, uCamK: { value: new THREE.Vector3() },
    uRvShS: { value: shRT.S.texture }, uRvShK: { value: shRT.K.texture },
    uRvShMS: { value: new THREE.Matrix4() }, uRvShMK: { value: new THREE.Matrix4() },
    uRvShVS: { value: new THREE.Matrix4() }, uRvShVK: { value: new THREE.Matrix4() },
    uRvShW: { value: SH.half * 2 }, uRvAngS: { value: 0.0047 }, uRvAngK: { value: 0.012 },
    uRvInv: { value: new THREE.Matrix4() }, uRvOn: { value: 0 },
    uTrk: { value: tracks.texture }, uTrkC: { value: tracks.center }, uTrkW: { value: TRACK.width }, uTrkN: { value: tracks.size },
    uHlP: { value: [new THREE.Vector3(), new THREE.Vector3()] }, uHlD: { value: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)] },
    uHlI: { value: 0 }, uHlCos: { value: new THREE.Vector2(Math.cos(0.38), Math.cos(0.6)) },
  };
  const groundMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: nearVert, fragmentShader: terrainFrag,
    defines: { NEAR: 1 }, uniforms: { ...terrain.uniforms, ...nu },
  });
  const ground = new THREE.Mesh(patchGeo, groundMat);
  ground.frustumCulled = false;
  ground.renderOrder = -1;
  scene.add(ground);

  // Body shadow cast on the ground: linear depth along the light direction (metres), rover only (layer 1)
  const depthMat = new THREE.ShaderMaterial({
    vertexShader: 'varying float vZ; void main() { vec4 v = modelViewMatrix * vec4(position, 1.0); vZ = -v.z; gl_Position = projectionMatrix * v; }',
    fragmentShader: 'varying float vZ; void main() { gl_FragColor = vec4(vZ, 0.0, 0.0, 1.0); }',
    side: THREE.DoubleSide,
  });
  const shCam = { S: new THREE.OrthographicCamera(-SH.half, SH.half, SH.half, -SH.half, 0.5, SH.far), K: new THREE.OrthographicCamera(-SH.half, SH.half, SH.half, -SH.half, 0.5, SH.far) };
  for (const c of Object.values(shCam)) c.layers.set(1);

  // ---------- rover ----------
  await MeshoptDecoder.ready;
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(await (await fetch(glbUrl)).arrayBuffer(), '');
  const root = gltf.scene.getObjectByName('rover');
  root.quaternion.identity();                       // the URDF → scene rotation is written directly every frame
  scene.add(root);
  const J = {}, links = {};
  let mass = 0, nMov = 0;
  root.traverse((o) => {
    const u = o.userData.urdf;
    if (u && u.link) {
      links[u.link] = o;
      if (u.mass) mass += u.mass;
      if (u.joint && u.type !== 'fixed') {
        J[u.link] = { o, u, q0: o.quaternion.clone(), p0: o.position.clone(), axis: new THREE.Vector3(...u.axis) };
        if (u.type === 'continuous' || u.upper > u.lower) nMov++;
      }
    }
    if (o.isMesh) {
      o.castShadow = o.receiveShadow = true;
      o.layers.enable(1);
      for (const m of [o.material].flat()) {
        if (m.map) m.map.anisotropy = 8;
        m.envMapIntensity = m.metalness > 0.5 ? 1.2 : 1.0;
        // Camera glass and solar panels are too smooth: with the Sun low to the ground the specular highlight can exceed the half-float range and turn into a solid white patch that then flashes black
        m.roughness = Math.max(m.roughness, 0.32);
      }
    }
  });
  const nJoints = Object.keys(links).length - 1;
  const _qa = new THREE.Quaternion();
  const setJ = (link, a) => { const j = J[link]; j.o.quaternion.copy(j.q0).multiply(_qa.setFromAxisAngle(j.axis, a)); };
  root.updateMatrixWorld(true);
  const visualOf = (link) => links[link].children.filter((c) => !c.userData.urdf);
  // Bounding box of a node's subtree in that node's own frame
  function boxIn(node, objs) {
    const inv = new THREE.Matrix4().copy(node.matrixWorld).invert(), b = new THREE.Box3(), bb = new THREE.Box3();
    for (const o of objs) o.traverse((m) => {
      if (!m.isMesh) return;
      m.geometry.computeBoundingBox();
      bb.copy(m.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
      b.union(bb);
    });
    return b;
  }
  const WHEELS = ['front_left', 'rear_left', 'front_right', 'rear_right'].map((k) => {
    const sus = J[`${k}_suspension`], ax = J[`${k}_wheel_axle`], wh = J[`${k}_wheel`];
    return {
      key: k, front: k.startsWith('front'), left: k.endsWith('left'),
      px: sus.p0.x + ax.p0.x, py: sus.p0.y + ax.p0.y, ox: wh.p0.x, oy: wh.p0.y,
      steer: 0, target: 0, roll: 0, phase: 0, lx: 0, ly: 0, init: false,
    };
  });
  const wb = boxIn(links.front_left_wheel, visualOf('front_left_wheel'));
  const wheelR = (wb.max.z - wb.min.z) / 2;
  const footH = -(J.front_left_suspension.p0.z + J.front_left_wheel_axle.p0.z) + wheelR;   // how high base_footprint sits above the bottom of the wheels
  const bodyBox = boxIn(root, [root]);
  const DIM = bodyBox.getSize(new THREE.Vector3());
  // Three solar panels: the panel normal is the link's z axis; take the side facing outwards
  const bodyC = bodyBox.getCenter(new THREE.Vector3());
  const PANELS = [['left_solar_panel', 'LEFT'], ['right_solar_panel', 'RIGHT'], ['rear_solar_panel', 'AFT']].map(([link, en]) => {
    const o = links[link], c = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    const nl = new THREE.Vector3(0, 0, 1).transformDirection(o.matrixWorld);
    return { link, en, o, sign: nl.dot(c.clone().sub(bodyC)) < 0 ? -1 : 1, inc: 0, cos: 0 };
  });
  // Navigation camera: midpoint of the two camera links, looking along the link's +x (URDF x forward, y left, z up → three camera −z forward, +y up)
  const nav = new THREE.Object3D();
  nav.position.copy(links.nav_camera_link_left.position).add(links.nav_camera_link_right.position).multiplyScalar(0.5);
  nav.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));
  links.mast_camera.add(nav);
  // Two headlights: beside the two hazard cameras at the front, aimed 14° below forward
  const lamps = ['haz_camera_link_left_front', 'haz_camera_link_right_front'].map((k) => {
    const sp = new THREE.SpotLight(0xfff4e6, 0, 40, 0.6, 0.37, 2);
    sp.position.copy(links[k].position).add(new THREE.Vector3(0.09, 0, 0.08));
    sp.target.position.copy(sp.position).add(new THREE.Vector3(Math.cos(0.245), 0, -Math.sin(0.245)));
    links.body.add(sp, sp.target);
    return sp;
  });

  // Invisible bounding boxes for picking (layer 3, raycasts only)
  const PICK = [
    ['panel', 'left_solar_panel'], ['panel', 'right_solar_panel'], ['panel', 'rear_solar_panel'],
    ['mast', 'mast_head_pivot'],
    ...WHEELS.map((w) => ['wheel', `${w.key}_suspension`]),
    ['body', 'body'],
  ];
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
  const proxies = PICK.map(([group, link]) => {
    const node = links[link];
    const objs = group === 'body' ? [...visualOf('body'), ...visualOf('chassis')] : group === 'mast' || group === 'wheel' ? [node] : visualOf(link);
    const b = boxIn(node, objs).expandByScalar(0.03);
    const m = new THREE.Mesh(new THREE.BoxGeometry(...b.getSize(new THREE.Vector3()).toArray()), proxyMat);
    m.position.copy(b.getCenter(new THREE.Vector3()));
    m.layers.set(3);
    m.userData.pick = { group, link, center: m.position.clone(), top: new THREE.Vector3(m.position.x, m.position.y, b.max.z) };
    node.add(m);
    return m;
  });
  const ray = new THREE.Raycaster();
  ray.layers.set(3);

  // ---------- lighting: the same set as the terrain shader (Sun raised 5°, cinematic key light, sky fill), intensities converted by π ----------
  const sun = new THREE.DirectionalLight(0xfffaf0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -SH.half, right: SH.half, top: SH.half, bottom: -SH.half, near: 0.5, far: SH.far });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2;
  const key = new THREE.DirectionalLight(0xf4f7ff, 0);
  scene.add(sun, sun.target, key, key.target);
  let envRT = null;
  const envSun = new THREE.Vector3(9, 9, 9);

  // ---------- terrain occlusion near the rover: read back a 6×6 block of pixels from the terrain shadow map, used for body and rock lighting ----------
  const sh = ctx.shadows, shN = sh.rtHero.width, shE = hE;
  const VG = 6, vgS = new Uint8Array(VG * VG * 4), vgK = new Uint8Array(VG * VG * 4);
  const vg = { c0: 0, r0: 0, ok: false, at: new THREE.Vector2(1e9, 1e9), sun: new THREE.Vector3() };
  const NEAR_SH = terrain.uniforms.uNearSh.value;
  function readVis(lx, ly) {
    const u = (A.x + lx / 1000) / (2 * shE) + 0.5, v = (A.y + ly / 1000) / (2 * shE) + 0.5;
    vg.c0 = Math.max(0, Math.min(shN - VG, Math.floor(u * shN - 0.5) - VG / 2 + 1));
    vg.r0 = Math.max(0, Math.min(shN - VG, Math.floor(v * shN - 0.5) - VG / 2 + 1));
    renderer.readRenderTargetPixels(sh.rtHero, vg.c0, vg.r0, VG, VG, vgS);
    renderer.readRenderTargetPixels(sh.rtKeyHero, vg.c0, vg.r0, VG, VG, vgK);
    vg.ok = true;
    vg.at.set(lx, ly);
    vg.sun.copy(sh.lastSun);
  }
  const visPx = (buf, i) => (buf[i + 2] / 255) * (1 + NEAR_SH * (buf[i + 1] / 255 - 1));
  function vis(lx, ly) {
    if (!vg.ok) return [1, 1];
    const u = (A.x + lx / 1000) / (2 * shE) + 0.5, v = (A.y + ly / 1000) / (2 * shE) + 0.5;
    const x = THREE.MathUtils.clamp(u * shN - 0.5 - vg.c0, 0, VG - 1.001), y = THREE.MathUtils.clamp(v * shN - 0.5 - vg.r0, 0, VG - 1.001);
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const at = (buf) => {
      const p = (jj, ii) => visPx(buf, (jj * VG + ii) * 4);
      return (p(j, i) * (1 - fx) + p(j, i + 1) * fx) * (1 - fy) + (p(j + 1, i) * (1 - fx) + p(j + 1, i + 1) * fx) * fy;
    };
    return [at(vgS), at(vgK)];
  }
  // Brightness at a location (Sun and key light visibility) relative to the rover's position: used to darken the rocks. keyFloor stays in sync with uKeyFloor in the terrain shader
  let keyFloor = 1, refLight = 1;
  const lightAt = (vs, vk) => 5.0 * 0.83 * vs + 1.25 * 0.7 * vk * THREE.MathUtils.lerp(keyFloor, 1, vs) + 0.13;
  const rocks = createRocks({ anchor: A, toNear, heightLocal, vis, rockLight: (vs, vk) => THREE.MathUtils.clamp(lightAt(vs, vk) / refLight, 0.15, 1.3) });
  scene.add(rocks.group);

  // ---------- navigation camera inset ----------
  const pipRT = new THREE.WebGLRenderTarget(512, 320, { type: THREE.HalfFloatType });
  const pipCam = new THREE.PerspectiveCamera(42, 1.6, 0.05, 1500);
  const pipMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: pipRT.texture }, uExp: { value: 2.0 }, uT: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D tSrc; uniform float uExp, uT; varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        float l = dot(texture2D(tSrc, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
        l = 1.0 - exp(-l * uExp);                       // monochrome camera exposure: highlights roll off smoothly to white
        l = pow(l, 1.0 / 2.2);
        l = clamp((l - 0.03) * 1.08, 0.0, 1.0);
        l += (h(vUv * 517.0 + fract(uT) * 91.0) - 0.5) * 0.045;
        vec2 d = vUv - 0.5;
        l *= 1.0 - 0.35 * smoothstep(0.1, 0.5, dot(d, d) * 1.6);
        gl_FragColor = vec4(vec3(l * 0.97, l, l * 1.02), 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const pipQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), pipMat);
  pipQuad.frustumCulled = false;
  const pipScene = new THREE.Scene();
  pipScene.add(pipQuad);
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ---------- state ----------
  const st = {
    x: 0, y: 0, hdg: 0, v: 0, w: 0, kappa: 0, mode: 'drive', odo: 0,
    slope: 0, pitch: 0, roll: 0, warn: '', warnT: 0,
    vis: [1, 1], sunUp: 1, power: 0, range: null, lit: 'sun',
    hl: 0, hlOn: false, hlAuto: true,
  };
  const mast = { pan: 0, tilt: -0.1, tp: 0, tt: -0.1, manual: 0, sweep: 0, t: 0 };
  let demo = 0;
  const input = { thr: 0, str: 0, crab: 0, brake: false };
  const pending = [];

  // Start: point A, nose towards the crater centre; back off if there is a big rock underfoot
  recenter(0, 0);
  st.hdg = Math.atan2(ctx.crater.center.y - A.y, ctx.crater.center.x - A.x);
  const sunH = new THREE.Vector3(), keyD = new THREE.Vector3(), sun2 = new THREE.Vector2();
  function sunFrame() {
    const b = basis(st.x, st.y);
    const s = eph.sunDir, up = b.up, su = s.dot(up);
    sunH.copy(s).addScaledVector(up, -su).normalize();
    const e = Math.max(Math.asin(THREE.MathUtils.clamp(su, -1, 1)), 0) + LIFT;
    const lifted = new THREE.Vector3().copy(sunH).multiplyScalar(Math.cos(e)).addScaledVector(up, Math.sin(e));
    sun2.set(sunH.dot(b.ex), sunH.dot(b.ey)).normalize();
    keyD.copy(terrain.uniforms.uKeyDir.value);
    return { b, lifted, tanE: Math.tan(e), su };
  }
  {
    const f = sunFrame();
    rocks.update(st.x, st.y, sun2, f.tanE, true);
    for (let k = 0; k < 8 && rocks.blocked(wheelXY(), st.x, st.y); k++) { st.x -= Math.cos(st.hdg) * 2.5; st.y -= Math.sin(st.hdg) * 2.5; }
  }
  // local coordinates of the four wheel centres (metres)
  function wheelXY() {
    const c = Math.cos(st.hdg), s = Math.sin(st.hdg);
    return WHEELS.map((w) => {
      const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
      const bx = w.px + w.ox * cs - w.oy * sn, by = w.py + w.ox * sn + w.oy * cs;
      return [st.x + bx * c - by * s, st.y + bx * s + by * c];
    });
  }
  // ---------- driving ----------
  // Ackermann: the turn centre sits 1/κ to the left of the body (κ > 0 turns left) and each wheel's steering axis points at it
  const steerFor = (w, k) => (Math.abs(k) < 1e-5 ? 0 : -Math.atan(w.px / (1 / k - w.py)));
  // Point turn: the wheels lie tangent to a circle centred on the rover's centre
  const pointFor = (w) => { let a = Math.atan2(w.px, -w.py); if (a > Math.PI / 2) a -= Math.PI; if (a < -Math.PI / 2) a += Math.PI; return a; };
  const MODE_EN = { drive: 'ACKERMANN', point: 'POINT TURN', crab: 'CRAB' };
  function warn(msg) { st.warn = msg; st.warnT = 2.2; }

  function step(dt) {
    dt = Math.min(dt, 0.05);
    const thr = input.thr, str = input.str, crab = input.crab;
    let want = crab ? 'crab' : Math.abs(thr) < 0.05 && Math.abs(str) > 0.05 ? 'point' : 'drive';
    if (st.mode === 'point' && want === 'drive' && Math.abs(thr) < 0.05) want = 'point';
    const still = Math.abs(st.v) < 0.03 && Math.abs(st.w) < 0.03;
    if (want !== st.mode && still) st.mode = want;
    // Wheel clicked: while stopped, run through the three steering modes once
    let dm = null;
    if (demo > 0) {
      demo -= dt;
      if (still && !thr && !str && !crab) dm = demo > 3.4 ? 'drive' : demo > 2.2 ? 'crab' : demo > 1.0 ? 'point' : 'zero';
    }
    st.kappa = DRIVE.kMax * str;
    for (const w of WHEELS) {
      const m = dm || st.mode;
      w.target = m === 'zero' ? 0 : dm === 'drive' ? steerFor(w, DRIVE.kMax) : m === 'drive' ? steerFor(w, st.kappa) : m === 'point' ? pointFor(w) : DRIVE.crab * crab || (dm ? DRIVE.crab : 0);
      w.target = THREE.MathUtils.clamp(w.target, -0.9, 0.9);
    }
    let err = 0;
    for (const w of WHEELS) {
      const d = THREE.MathUtils.clamp(w.target - w.steer, -DRIVE.steerRate * dt, DRIVE.steerRate * dt);
      w.steer += d;
      err = Math.max(err, Math.abs(w.target - w.steer));
    }
    const ready = st.mode === 'drive' ? err < 0.35 : err < 0.05;
    const sf = 1 - 0.6 * THREE.MathUtils.smoothstep(st.slope, DRIVE.slopeWarn, DRIVE.slopeMax);
    const ramp = (cur, tgt, a) => cur + THREE.MathUtils.clamp(tgt - cur, -a * dt, a * dt);
    if (st.mode === 'point') {
      const tw = ready ? DRIVE.yawMax * str : 0;
      st.w = ramp(st.w, tw, input.brake ? 2.5 : 1.2);
      st.v = ramp(st.v, 0, DRIVE.brake);
    } else {
      const tv = ready ? (thr >= 0 ? DRIVE.vMax : DRIVE.vRev) * thr * sf : 0;
      st.v = ramp(st.v, tv, input.brake || Math.sign(tv) !== Math.sign(st.v) && Math.abs(st.v) > 0.02 ? DRIVE.brake : DRIVE.acc);
      st.w = st.mode === 'drive' ? st.v * st.kappa : 0;
    }
    // Integrate, then check slope, rocks and working range; back out if blocked
    const ox = st.x, oy = st.y, oh = st.hdg;
    if (st.mode === 'crab') {
      const a = st.hdg + DRIVE.crab * crab;
      st.x += st.v * Math.cos(a) * dt; st.y += st.v * Math.sin(a) * dt;
    } else {
      const h = st.hdg + st.w * dt * 0.5;
      st.x += st.v * Math.cos(h) * dt; st.y += st.v * Math.sin(h) * dt;
    }
    st.hdg += st.w * dt;
    const moved = Math.hypot(st.x - ox, st.y - oy);
    if (moved > 1e-6) {
      const s1 = slopeDeg(st.x, st.y);
      let why = null;
      if (Math.hypot(st.x, st.y) > DRIVE.range) why = `Outside working range (${(DRIVE.range / 1000).toFixed(1)} km from A)`;
      else if (s1 > DRIVE.slopeMax && s1 > st.slope) why = `Slope ${s1.toFixed(0)}° exceeds the ${DRIVE.slopeMax}° climb limit`;
      else if (rocks.blocked(wheelXY(), st.x, st.y)) why = 'Rock too high ahead, go around';
      if (why) { st.x = ox; st.y = oy; st.hdg = oh; st.v = 0; st.w = 0; warn(why); }
      else st.odo += moved;
    }
    if (st.warnT > 0 && (st.warnT -= dt) <= 0) st.warn = '';
    // How far each wheel rolled: the wheel centre's displacement projected onto the wheel's heading. Tracks are stamped along this segment
    const wxy = wheelXY();
    WHEELS.forEach((w, i) => {
      const [x, y] = wxy[i];
      if (!w.init) { w.lx = x; w.ly = y; w.init = true; return; }
      const dx = x - w.lx, dy = y - w.ly;
      const a = st.hdg + w.steer, d = dx * Math.cos(a) + dy * Math.sin(a);
      if (Math.hypot(dx, dy) > 0.002) {
        const p0 = w.phase;
        w.phase += (d / TRACK.grouser) * Math.PI * 2;
        pending.push({ ax: w.lx, ay: w.ly, bx: x, by: y, pa: p0, pb: w.phase });
        w.phase %= Math.PI * 2;
        w.lx = x; w.ly = y;
      }
      w.roll += d;
    });
    // Mast: sweeps slowly when automatic, pauses for 8 s after manual input, then resumes
    mast.t += dt;
    if (mast.manual > 0) mast.manual -= dt;
    else if (mast.sweep > 0) { mast.sweep -= dt; mast.tp = Math.sin((1 - mast.sweep / 6) * Math.PI * 2) * 2.6; mast.tt = -0.15; }
    else { mast.tp = 0.75 * Math.sin(mast.t * 0.13) + 0.25 * Math.sin(mast.t * 0.31); mast.tt = -0.12 + 0.08 * Math.sin(mast.t * 0.21); }
  }
  // ---------- attitude: a plane fitted through the ground height under the four wheels ----------
  const rootN = new THREE.Vector3();
  let poseDt = 1 / 60;
  function applyPose() {
    const wxy = wheelXY(), hgt = wxy.map(([x, y]) => heightLocal(x, y) * 1000);
    const [fl, rl, fr, rr] = hgt;
    const L = WHEELS[0].px - WHEELS[1].px, W = WHEELS[0].py - WHEELS[2].py;
    const gF = ((fl + fr) - (rl + rr)) / (2 * L), gL = ((fl + rl) - (fr + rr)) / (2 * W);   // slope along the nose, and towards the left
    const c = Math.cos(st.hdg), s = Math.sin(st.hdg);
    // body frame (map east, north, up)
    const F = new THREE.Vector3(c, s, gF).normalize(), Lv = new THREE.Vector3(-s, c, gL).normalize();
    const U = new THREE.Vector3().crossVectors(F, Lv).normalize();
    Lv.crossVectors(U, F).normalize();
    const hm = (fl + rl + fr + rr) / 4;
    const b = basis(st.x, st.y);
    const toW = (v) => new THREE.Vector3().addScaledVector(b.ex, v.x).addScaledVector(b.ey, v.y).addScaledVector(b.up, v.z);
    const Fw = toW(F), Lw = toW(Lv), Uw = toW(U);
    // base_footprint sits footH above the plane through the bottoms of the wheels (along the body's up axis)
    m2.set(A.x + st.x / 1000, A.y + st.y / 1000);
    ctx.mapToScene(R, m2, hm / 1000, tmp);
    root.position.copy(tmp.sub(O).multiplyScalar(1000)).addScaledVector(Uw, footH);
    root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(Fw, Lw, Uw));
    rootN.copy(Uw);
    st.pitch = THREE.MathUtils.radToDeg(Math.atan(gF));
    st.roll = THREE.MathUtils.radToDeg(Math.atan(gL));
    st.slope = slopeDeg(st.x, st.y);
    // joints
    for (const w of WHEELS) {
      setJ(`${w.key}_wheel_axle`, w.steer);
      setJ(`${w.key}_wheel`, w.roll / wheelR);
    }
    mast.pan += THREE.MathUtils.clamp(mast.tp - mast.pan, -1.2 * poseDt, 1.2 * poseDt);
    mast.tilt += THREE.MathUtils.clamp(mast.tt - mast.tilt, -0.8 * poseDt, 0.8 * poseDt);
    mast.pan = THREE.MathUtils.clamp(mast.pan, J.mast_head_pivot.u.lower, J.mast_head_pivot.u.upper);
    mast.tilt = THREE.MathUtils.clamp(mast.tilt, -1.25, 1.25);
    setJ('mast_head_pivot', mast.pan);
    setJ('mast_camera', -mast.tilt);
    root.updateMatrixWorld(true);
  }

  // ---------- ranging: intersection of the navigation camera's line of sight with the ground ----------
  const rayO = new THREE.Vector3(), rayD = new THREE.Vector3();
  function rangefind() {
    nav.updateMatrixWorld();
    rayO.setFromMatrixPosition(nav.matrixWorld);
    rayD.set(0, 0, -1).transformDirection(nav.matrixWorld);
    const above = (t) => { const p = fromNear(tmp.copy(rayO).addScaledVector(rayD, t)); return p.h - heightLocal(p.x, p.y); };
    let t0 = 0.3, t = 0.3;
    if (above(t) <= 0) return 0.3;
    for (let i = 0; i < 260 && t < 1500; i++) {
      t0 = t; t *= 1.035;
      if (above(t) <= 0) {
        for (let k = 0; k < 10; k++) { const m = (t0 + t) / 2; if (above(m) > 0) t0 = m; else t = m; }
        return t;
      }
    }
    return null;
  }

  // ---------- solar panel illumination ----------
  const _n = new THREE.Vector3();
  function panelPower() {
    const sunUpF = THREE.MathUtils.smoothstep(st.sunUp, -0.02, 0.03);
    let sum = 0;
    for (const p of PANELS) {
      _n.set(0, 0, p.sign).transformDirection(p.o.matrixWorld);
      p.cos = Math.max(_n.dot(eph.sunDir), 0);
      p.inc = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(_n.dot(eph.sunDir), -1, 1)));
      p.out = p.cos * st.vis[0] * sunUpF;
      sum += p.out;
    }
    st.power = sum / Math.SQRT2;                    // 1 = best orientation (Sun 45° behind the rover, two panels lit at once)
  }
  // ---------- per-frame sync: after the main camera is settled, before compositing ----------
  let lastT = performance.now(), nSync = 0, rocksDirty = false, rockSun = new THREE.Vector3();
  const camK = new THREE.Vector3();
  function syncCamera(cam, c = camera) {
    c.position.copy(cam.position).sub(O).multiplyScalar(1000);
    c.quaternion.copy(cam.quaternion);
    c.fov = cam.fov;
    c.aspect = cam.aspect;
    const d = c.position.distanceTo(root.position);
    c.near = THREE.MathUtils.clamp(d * 0.02, 0.03, 30);
    c.far = d + PATCH.half * 2;
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    nu.uCamK.value.copy(cam.position);
  }
  function placeShadowCam(c, dir) {
    c.position.copy(root.position).addScaledVector(dir, SH.back);
    c.up.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.95) c.up.set(1, 0, 0);
    c.lookAt(root.position);
    c.updateMatrixWorld();
    c.matrixWorldInverse.copy(c.matrixWorld).invert();
  }
  function sync(cam, t = performance.now()) {
    const dt = Math.min((t - lastT) / 1000, 0.1);
    lastT = t;
    poseDt = dt;
    nSync++;
    if (Math.hypot(st.x - PCA.x, st.y - PCA.y) > PATCH.recenter) {
      recenter(st.x, st.y);
      terrain.uniforms.uDiscC.value.copy(PC);
      rocksDirty = true;                                // origin moved, so the rocks' near coordinates need recomputing
    }
    keyFloor = terrain.uniforms.uKeyFloor.value;
    const f = sunFrame();
    st.sunUp = f.su;
    applyPose();
    // Terrain occlusion: re-read after the rover moves 60 m or the Sun direction changes
    if (!vg.ok || vg.at.distanceTo(m2.set(st.x, st.y)) > 60 || vg.sun.distanceToSquared(sh.lastSun) > 1e-9) {
      readVis(st.x, st.y);
      refLight = 0;
    }
    st.vis = vis(st.x, st.y);
    const lr = lightAt(st.vis[0], st.vis[1]);
    if (Math.abs(lr - refLight) > 1e-3 * lr) { refLight = Math.max(lr, 0.15); rocks.shade(); }
    const up = f.su > -0.02 ? THREE.MathUtils.smoothstep(f.su, -0.02, 0.03) : 0;
    // Lighting: intensities matched to the terrain shader's Sun, key and fill (terrain is albedo·E, three is albedo/π·E)
    sun.position.copy(root.position).addScaledVector(f.lifted, SH.back);
    sun.target.position.copy(root.position);
    sun.intensity = Math.PI * terrain.uniforms.uSunI.value * 0.83 * st.vis[0] * up;
    key.position.copy(root.position).addScaledVector(keyD, SH.back);
    key.target.position.copy(root.position);
    key.intensity = Math.PI * terrain.uniforms.uKey.value * 0.7 * st.vis[1] * THREE.MathUtils.lerp(keyFloor, 1, st.vis[0] * up);
    scene.environmentIntensity = 1.5 * THREE.MathUtils.clamp(lr / lightAt(1, 1), 0.08, 1);
    if (!envRT || envSun.distanceToSquared(eph.sunDir) > 1e-6) {
      envSun.copy(eph.sunDir);
      const pm = new THREE.PMREMGenerator(renderer);
      if (envRT) envRT.dispose();
      envRT = pm.fromScene(envScene(f.b.up, sunH, 0.18), 0, 0.1, 100);
      pm.dispose();
      scene.environment = envRT.texture;
    }
    // Headlights: switch on automatically the first time it gets dark
    const dark = st.vis[0] * up < 0.2;
    if (dark && st.hlAuto) { st.hlOn = true; st.hlAuto = false; }
    st.hl += THREE.MathUtils.clamp((st.hlOn ? 1 : 0) - st.hl, -dt * 4, dt * 4);
    lamps.forEach((sp, i) => {
      sp.intensity = Math.PI * 4.5 * st.hl;
      sp.getWorldPosition(nu.uHlP.value[i]);
      sp.target.getWorldPosition(tmp);
      nu.uHlD.value[i].copy(tmp).sub(nu.uHlP.value[i]).normalize();
    });
    nu.uHlI.value = 4.5 * st.hl;
    // Body shadow cast on the ground (one depth map each for the Sun and the key light)
    const asu = renderer.shadowMap.autoUpdate, ov = scene.overrideMaterial, prev = renderer.getRenderTarget();
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.shadowMap.autoUpdate = false;
    scene.overrideMaterial = depthMat;
    renderer.setClearColor(0x000000, 0);
    for (const [k, dir] of [['S', f.lifted], ['K', keyD]]) {
      const c = shCam[k];
      placeShadowCam(c, dir);
      renderer.setRenderTarget(shRT[k]);
      renderer.clear(true, true, false);
      renderer.render(scene, c);
      nu[`uRvShM${k}`].value.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
      nu[`uRvShV${k}`].value.copy(c.matrixWorldInverse);
    }
    scene.overrideMaterial = ov;
    renderer.setRenderTarget(prev);
    renderer.setClearColor(cc, ca);
    renderer.shadowMap.autoUpdate = asu;
    nu.uRvInv.value.copy(root.matrixWorld).invert();
    nu.uRvOn.value = 1;
    // tracks
    tracks.follow(st.x, st.y);
    nu.uTrk.value = tracks.texture;
    if (pending.length) { tracks.stamp(pending); pending.length = 0; }
    // Rocks: re-scattered after the rover moves 4 m or the Sun direction changes (the shadow direction follows the Sun)
    const sunMoved = rockSun.distanceToSquared(eph.sunDir) > 1e-6;
    if (rocks.update(st.x, st.y, sun2, f.tanE, rocksDirty || sunMoved)) { rocksDirty = false; rockSun.copy(eph.sunDir); }
    syncCamera(cam);
    if (nSync % 6 === 0) { panelPower(); st.range = rangefind(); }
    const sunLit = st.vis[0] * up;
    st.lit = f.su < -0.01 ? 'night' : sunLit > 0.5 ? 'sun' : 'shade';
  }

  // ---------- navigation camera inset: render the main scene and the near scene once each, then grade as a monochrome camera and paste onto the frame ----------
  const sv = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  function renderPip(cam, mainScene, rect, t) {
    const w = Math.max(2, Math.round(rect.width * renderer.getPixelRatio())), h = Math.max(2, Math.round(rect.height * renderer.getPixelRatio()));
    if (pipRT.width !== w || pipRT.height !== h) pipRT.setSize(w, h);
    nav.updateMatrixWorld();
    sv.p.copy(cam.position); sv.q.copy(cam.quaternion);
    const fov = cam.fov, asp = cam.aspect;
    // main camera moved temporarily onto the navigation camera (km)
    nav.getWorldPosition(tmp);
    cam.position.copy(tmp).multiplyScalar(0.001).add(O);
    nav.getWorldQuaternion(cam.quaternion);
    cam.fov = 42; cam.aspect = rect.width / rect.height;
    cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    syncCamera(cam, pipCam);
    pipCam.near = 0.05;
    pipCam.updateProjectionMatrix();
    const ac = renderer.autoClear, asu = renderer.shadowMap.autoUpdate, prev = renderer.getRenderTarget();
    renderer.setRenderTarget(pipRT);
    renderer.autoClear = true;
    renderer.render(mainScene, cam);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.shadowMap.autoUpdate = false;
    renderer.render(scene, pipCam);
    renderer.shadowMap.autoUpdate = asu;
    renderer.setRenderTarget(prev);
    // restore the main camera
    cam.position.copy(sv.p); cam.quaternion.copy(sv.q); cam.fov = fov; cam.aspect = asp;
    cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    syncCamera(cam);
    // paste onto the canvas (viewport in CSS pixels, three multiplies by the pixel ratio itself)
    pipMat.uniforms.uExp.value = THREE.MathUtils.clamp(1.1 * lightAt(1, 1) / Math.max(refLight + 1.4 * st.hl, 0.3), 0.9, 4.5);
    pipMat.uniforms.uT.value = t * 0.001;
    const H = renderer.domElement.clientHeight;
    renderer.setScissorTest(true);
    renderer.setViewport(rect.left, H - rect.bottom, rect.width, rect.height);
    renderer.setScissor(rect.left, H - rect.bottom, rect.width, rect.height);
    renderer.render(pipScene, orthoCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, renderer.domElement.clientWidth, H);
    renderer.autoClear = ac;
  }
  // ---------- picking ----------
  const WHEEL_EN = { front_left: 'FRONT LEFT', rear_left: 'REAR LEFT', front_right: 'FRONT RIGHT', rear_right: 'REAR RIGHT' };
  function pick(ndc) {
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(proxies, false);
    if (!hits.length) return null;
    // The panels hug the outside of the body: if the body box is hit first and another part lies within 20 cm behind it, count that part instead
    const first = hits[0], alt = hits.find((h) => h.object.userData.pick.group !== 'body' && h.distance < first.distance + 0.2);
    return (alt || first).object.userData.pick;
  }
  function label(p) {
    if (!p) return null;
    if (p.group === 'panel') { const q = PANELS.find((x) => x.link === p.link); return { en: `SOLAR PANEL ${q.en}` }; }
    if (p.group === 'wheel') { const k = p.link.replace('_suspension', ''); return { en: `WHEEL ${WHEEL_EN[k]}` }; }
    return { en: p.group === 'mast' ? 'MAST CAMERA' : 'ROVER BODY' };
  }
  const deg = (r, d = 1) => `${r >= 0 ? '+' : '−'}${Math.abs(THREE.MathUtils.radToDeg(r)).toFixed(d)}°`;
  // Contents of the part card (refreshed every frame)
  function info(p) {
    const L = label(p), rows = [];
    let note = '';
    if (p.group === 'panel') {
      const q = PANELS.find((x) => x.link === p.link);
      rows.push(['INCIDENCE', `${q.inc.toFixed(1)}°`], ['OUTPUT', `${Math.round(q.out * 100)}%`], ['TOTAL', `${Math.round(st.power * 100)}% of best`]);
      note = 'Near the pole the Sun sits only a degree or two above the horizon, so the panels are mounted vertically on three sides. Output peaks when the rover tail is angled towards the Sun and two panels are lit at once.';
    } else if (p.group === 'mast') {
      rows.push(['PAN', deg(mast.pan)], ['TILT', deg(mast.tilt)], ['RANGE', st.range == null ? '> 1.5 km' : `${st.range.toFixed(st.range < 10 ? 2 : 1)} m`],
        ['LIMITS', `±${THREE.MathUtils.radToDeg(J.mast_head_pivot.u.upper).toFixed(0)}° / ±${THREE.MathUtils.radToDeg(J.mast_camera.u.upper).toFixed(0)}°`]);
      note = 'The mast sweeps a full circle. Drag inside the inset to aim the camera by hand.';
    } else if (p.group === 'wheel') {
      const w = WHEELS.find((x) => p.link.startsWith(x.key));
      rows.push(['STEER', deg(w.steer)], ['LIMIT', `±${THREE.MathUtils.radToDeg(J[`${w.key}_wheel_axle`].u.upper).toFixed(1)}°`],
        ['DIAMETER', `${(wheelR * 200).toFixed(0)} cm`], ['MODE', MODE_EN[st.mode]]);
      note = 'All four wheels steer: A / D for Ackermann turns, spin in place when stopped, Q / E to crab sideways.';
    } else {
      rows.push(['MASS', `${Math.round(mass)} kg`], ['SIZE', `${DIM.x.toFixed(2)} × ${DIM.y.toFixed(2)} × ${DIM.z.toFixed(2)} m`],
        ['JOINTS', `${nJoints} total, ${nMov} movable`], ['LIGHTS', st.hlOn ? 'On' : 'Off']);
      note = 'Mass, size and joints all come from the URDF.';
    }
    return { ...L, rows, note };
  }
  // screen coordinates of a part's anchor
  const _a = new THREE.Vector3();
  function screen(p, w, h) {
    if (!p) return null;
    const node = links[p.link];
    _a.copy(p.group === 'body' ? p.top : p.center).applyMatrix4(node.matrixWorld).project(camera);
    return { x: (_a.x + 1) * 0.5 * w, y: (1 - _a.y) * 0.5 * h, vis: _a.z < 1 && Math.abs(_a.x) < 1.05 && Math.abs(_a.y) < 1.05 };
  }

  // ---------- quantities for the main camera (scene km) ----------
  const up0 = () => basis(st.x, st.y).up;
  function target(out = new THREE.Vector3()) {
    return out.copy(root.position).addScaledVector(rootN, 0.75).multiplyScalar(0.001).add(O);
  }
  function headingDir(out = new THREE.Vector3()) {
    const b = basis(st.x, st.y);
    return out.copy(b.ex).multiplyScalar(Math.cos(st.hdg)).addScaledVector(b.ey, Math.sin(st.hdg)).normalize();
  }
  // Default camera position for the rover: az° from the nose, dist m away, elevation el°
  function view(az, dist, el) {
    const b = basis(st.x, st.y), f = headingDir();
    const d = f.applyAxisAngle(b.up, THREE.MathUtils.degToRad(az));
    const tgt = target();
    const pos = tgt.clone().addScaledVector(d, Math.cos(THREE.MathUtils.degToRad(el)) * dist / 1000).addScaledVector(b.up, Math.sin(THREE.MathUtils.degToRad(el)) * dist / 1000);
    return { pos, target: tgt, up: b.up };
  }
  // Camera stays out of the ground: at least 0.6 m clearance
  function clampCam(cam) {
    tmp.copy(cam.position).sub(O).multiplyScalar(1000);
    const p = fromNear(tmp), g = heightLocal(p.x, p.y);
    const dh = g + 0.0006 - p.h;
    if (dh > 0) cam.position.addScaledVector(ctx.upAt(R, cam.position, tmp2), dh);
  }
  function setActive(on) {
    pass.enabled = on;
    terrain.uniforms.uDiscR.value = on ? PATCH.morph1 / 1000 : 0;
    terrain.uniforms.uDiscC.value.copy(PC);
    nu.uRvOn.value = on ? 1 : 0;
  }

  applyPose();
  return {
    pass, scene, camera, state: st, mast, wheels: WHEELS, mass, DIM, MODE_EN,
    step, sync, renderPip, pick, label, info, screen, target, headingDir, view, clampCam, setActive, up: up0,
    setInput: (o) => Object.assign(input, o),
    toggleLights: () => { st.hlOn = !st.hlOn; st.hlAuto = false; return st.hlOn; },
    dragMast: (dx, dy) => { mast.manual = 8; mast.sweep = 0; mast.tp = THREE.MathUtils.clamp(mast.tp - dx, -3.4, 3.4); mast.tt = THREE.MathUtils.clamp(mast.tt + dy, -1.2, 1.2); },
    react: (p) => { if (p.group === 'mast') { mast.sweep = 6; mast.manual = 0; } else if (p.group === 'wheel') demo = 4.6; },
  };
}
