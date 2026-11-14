// Whole-Moon globe for choosing a landing site: a sphere carrying the WAC mosaic, the
// landing-zone grid projected over the southern cap, and the candidate sites as markers.
// Drag to turn it, scroll to come closer.
//
// Its own scene and camera, deliberately separate from the surface view. The surface scene
// works in kilometres with the Moon's centre at (0, -R, 0) and a camera metres above the
// ground; a globe needs the whole body in frame. Sharing one scene across four orders of
// magnitude would mean fighting the depth buffer for no gain, so this is a second pass
// drawn with the same renderer.
import * as THREE from 'three';
import { globeVert, globeFrag } from '../glsl/globe.js';

const R_UNIT = 1;                      // the sphere is a unit sphere; distances are in radii
const CAM_NEAR = 0.01, CAM_FAR = 40;
const FOV = 32;
// Distances follow from the field of view rather than being picked by eye. A sphere of radius
// 1 seen from d subtends an angular radius of asin(1/d), so the whole body fits the shorter
// (vertical) screen axis when asin(1/d) <= FOV/2. Leaving an eighth of the frame as margin
// gives the opening distance; closing to DIST.min puts the eye near enough that the zone cap,
// which reaches about 5 deg from the pole, spans most of the frame.
const fitDist = (fillFrac) => 1 / Math.sin(THREE.MathUtils.degToRad((FOV / 2) * fillFrac));
const DIST = { min: 1.35, max: 9.0, start: fitDist(0.88) };
// Opening pose: the zone cap is the point of this view, so it sits in frame rather than on
// the limb, tilted back far enough that the body still reads as a sphere and not a disc.
// Facing lat -78 puts the pole about a sixth of the radius below centre.
const START = { lat: -78, lon: 20 };

export function createGlobe({ renderer, data, zones, radiusKm }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, CAM_NEAR, CAM_FAR);

  const loader = new THREE.TextureLoader();
  const mapTex = loader.load(data.moonGlobalUrl);
  mapTex.colorSpace = THREE.SRGBColorSpace;
  mapTex.minFilter = THREE.LinearMipmapLinearFilter;
  mapTex.magFilter = THREE.LinearFilter;
  mapTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  // Stands in for the WAC mosaic near the pole, where that equirectangular texture's
  // longitude lines converge into a single smeared row. See src/glsl/globe.js.
  const polarTex = loader.load(data.moonPolarUrl);
  polarTex.colorSpace = THREE.NoColorSpace;
  polarTex.minFilter = THREE.LinearMipmapLinearFilter;
  polarTex.magFilter = THREE.LinearFilter;

  const uniforms = {
    uMap: { value: mapTex },
    // Measured off src/data/moon_global.jpg: mean 78.6/255 overall, and the band the polar
    // basemap replaces has a standard deviation of 56.5 against that basemap's 30 after the
    // source-side change. Keeping 0.55 of the mosaic's contrast lands both near 31, which is
    // what stops the cap edge from showing. See the note in src/glsl/globe.js.
    uMapMean: { value: 78.6 / 255 },
    uMapFlat: { value: 0.55 },
    uPolar: { value: polarTex },
    uPolarE: { value: data.moonPolarMeta.half_extent_m / 1000 },
    uZones: { value: zones.texture() },
    uZoneA: { value: 0.85 },
    uZoneE: { value: zones.halfExtentKm },
    uR: { value: radiusKm },
    uZoneSel: { value: 0 },
    uZoneDim: { value: 0.22 },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    // This view is a map, not a photograph, and it is lit for reading rather than for the
    // date. A physically placed Sun makes the thing unusable: the mission window runs over
    // fourteen years, and for most arrival dates in it the south pole faces away from the
    // Sun, so picking a date would hand the user an unreadable black sphere. The arrival
    // date drives the figures in the panels, where it belongs, and the relief itself (baked
    // as a hillshade in the polar basemap, see tools/fetch_moon_polar.py) carries the shape
    // cue, so the live Sun term only has to avoid erasing it -- ambient near 1 means the
    // day/night term barely moves the result either way.
    uAmbient: { value: 0.88 },
    uTerm: { value: 0.9 },
  };

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(R_UNIT, 192, 96),
    new THREE.ShaderMaterial({ vertexShader: globeVert, fragmentShader: globeFrag, uniforms, glslVersion: THREE.GLSL3 }),
  );
  scene.add(sphere);

  // Candidate sites are marked in the DOM, not in the scene: the rest of the project marks a
  // place with the .site chip (white-edged red square, name alongside) rather than a 3D
  // object, and screenOf below projects each one to the same screen position that chip
  // needs. Only their directions live here, for the projection and for the front/back test.
  const siteDirs = data.sites.sites.map((s) => ({ id: s.id, site: s, dir: dirFromLatLon(s.lat, s.lon) }));

  // Orientation is held as a quaternion the drag multiplies into, rather than as two angles.
  // Euler angles gimbal-lock exactly where this view spends its time, over the pole.
  const orient = new THREE.Quaternion();
  setLatLonFacing(orient, START.lat, START.lon);
  let dist = DIST.start;
  let spin = 0.012;                  // slow idle turn, stopped on first interaction
  let dragging = false, dragged = false;
  let last = null;

  // The zone cap reaches 151.68 km from the pole against a radius of 1737.4, so it spans
  // under a tenth of the disc: the whole body and the thing being chosen cannot both be
  // legible in one frame. The view therefore moves between two distances, and a fly carries
  // it from one to the other rather than cutting, so it stays clear that it is one Moon.
  const fly = { from: null, to: null, qFrom: null, qTo: null, t: 0, dur: 0 };
  function flyTo(latDeg, lonDeg, toDist, ms = 1400) {
    fly.qFrom = orient.clone();
    fly.qTo = new THREE.Quaternion();
    setLatLonFacing(fly.qTo, latDeg, lonDeg);
    fly.from = dist;
    fly.to = THREE.MathUtils.clamp(toDist, DIST.min, DIST.max);
    fly.t = 0;
    fly.dur = ms;
    spin = 0;
  }
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function dirFromLatLon(latDeg, lonDeg) {
    const la = THREE.MathUtils.degToRad(latDeg), lo = THREE.MathUtils.degToRad(lonDeg);
    // Matches the sphere's own UV convention: u from longitude, v from latitude
    return new THREE.Vector3(
      -Math.cos(la) * Math.cos(lo),
      Math.sin(la),
      Math.cos(la) * Math.sin(lo),
    ).normalize();
  }

  // Turn the globe so the given latitude and longitude face the camera
  function setLatLonFacing(q, latDeg, lonDeg) {
    const d = dirFromLatLon(latDeg, lonDeg);
    q.setFromUnitVectors(d, new THREE.Vector3(0, 0, 1));
  }

  // Screen-space drag to rotation: a horizontal drag turns about the camera's up, a vertical
  // drag about its right, both premultiplied so they act in camera space rather than in the
  // body's own frame -- the globe spends this view over the pole, where a body-frame yaw is
  // not the axis the screen is asking for.
  //
  // The angle per pixel is derived rather than tuned, so the point under the cursor actually
  // stays under it. The near point of the sphere sits at depth (d - 1) from the eye, and a
  // perspective camera maps h pixels to 2 (d - 1) tan(fov/2) of width at that depth, so a
  // drag of n pixels is a rotation of n * 2 (d - 1) tan(fov/2) / h radians. Both axes use the
  // height, which is what the projection scales by. Exact at the centre of the frame and an
  // underestimate towards the limb, where the surface turns away from the viewer; that is
  // the right way round, since overshoot is what reads as the globe running off on its own.
  const qTmp = new THREE.Quaternion();
  const axisY = new THREE.Vector3(0, 1, 0), axisX = new THREE.Vector3(1, 0, 0);
  const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
  function drag(dx, dy) {
    // The canvas's own CSS height, which is the space the pointer deltas are in. Read live
    // rather than cached: no second copy of the viewport size to fall out of date.
    const h = renderer.domElement.clientHeight || 1;
    const k = (2 * Math.max(0, dist - R_UNIT) * TAN_HALF_FOV) / h;
    qTmp.setFromAxisAngle(axisY, dx * k);
    orient.premultiply(qTmp);
    qTmp.setFromAxisAngle(axisX, dy * k);
    orient.premultiply(qTmp);
    orient.normalize();
  }

  // Pointer input. The handlers are named and held, not anonymous, because this screen is
  // opened and closed repeatedly: attaching anonymous listeners on each open leaves the
  // previous set installed with no way to name them again, and they accumulate. Each one
  // then applies the same wheel step, so the zoom runs at n times speed after n opens.
  // attach is therefore idempotent per element and hands back a detach that genuinely
  // removes what it added.
  let attached = null;
  const onDown = (e) => {
    dragging = true; dragged = false; last = { x: e.clientX, y: e.clientY }; spin = 0;
    attached?.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragging || !last) return;
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
    drag(dx, dy);
    last = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e) => {
    dragging = false; last = null;
    // Checked first: releasing a capture that is not held raises NotFoundError, and
    // pointercancel can arrive after the browser has already dropped it.
    if (attached?.hasPointerCapture?.(e.pointerId)) attached.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e) => {
    e.preventDefault();
    dist = THREE.MathUtils.clamp(dist * Math.exp(e.deltaY * 0.0012), DIST.min, DIST.max);
    spin = 0;
  };

  function detach() {
    dragging = false;
    last = null;
    const el = attached;
    if (!el) return;
    attached = null;
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('wheel', onWheel);
  }

  function attach(el) {
    if (attached === el) return detach;      // already listening on this element
    detach();                                 // moved to a different element: drop the old one
    attached = el;
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return detach;
  }

  // Which candidate marker is under a screen point, or null. Returns the nearest within a
  // pixel radius, and ignores markers on the far side.
  function pick(px, py, w, h, radiusPx = 26) {
    let best = null, bestD = radiusPx;
    for (const s of siteDirs) {
      const v = s.dir.clone().applyQuaternion(orient);
      if (v.z < 0.08) continue;                        // on the far side, or right on the limb
      const p = v.multiplyScalar(R_UNIT * 1.002).project(camera);
      const sx = (p.x * 0.5 + 0.5) * w, sy = (0.5 - p.y * 0.5) * h;
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestD) { bestD = d; best = { ...s, sx, sy }; }
    }
    return best;
  }

  // Latitude and longitude of the surface point under a screen position, or null if the ray
  // misses the sphere. Used for the hover readout, which then asks zones.atLatLon.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function surfaceAt(px, py, w, h) {
    ndc.set((px / w) * 2 - 1, -(py / h) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(sphere, false)[0];
    if (!hit) return null;
    // Back out of the globe's rotation to get body-fixed coordinates
    const n = hit.point.clone().normalize().applyQuaternion(orient.clone().invert());
    const lat = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(n.y, -1, 1)));
    const lon = (THREE.MathUtils.radToDeg(Math.atan2(n.z, -n.x)) + 360) % 360;
    return { lat, lon, point: hit.point.clone() };
  }

  // Screen position of a site marker, for anchoring a label in the DOM
  function screenOf(site, w, h) {
    const s = siteDirs.find((x) => x.id === site.id);
    if (!s) return null;
    const v = s.dir.clone().applyQuaternion(orient);
    const front = v.z >= 0.08;
    const p = v.clone().multiplyScalar(R_UNIT * 1.002).project(camera);
    return { x: (p.x * 0.5 + 0.5) * w, y: (0.5 - p.y * 0.5) * h, front };
  }

  // Moon-fixed (ME) to this globe's body frame. ME has +z through the north pole; the sphere
  // here has +y north, to match the latitude its own UVs carry. Read off dirFromLatLon:
  // lat 0 lon 0 is ME (1,0,0) and globe (-1,0,0); lon 90 is ME (0,1,0) and globe (0,0,1);
  // the north pole is ME (0,0,1) and globe (0,1,0).
  const meToGlobe = (me, out) => out.set(-me.x, me.z, me.y);

  function step(dtMs, sunME) {
    if (fly.dur > 0) {
      fly.t = Math.min(1, fly.t + dtMs / fly.dur);
      const e = easeInOut(fly.t);
      orient.copy(fly.qFrom).slerp(fly.qTo, e);
      dist = THREE.MathUtils.lerp(fly.from, fly.to, e);
      if (fly.t >= 1) fly.dur = 0;
    } else if (spin) {
      qTmp.setFromAxisAngle(axisY, spin * dtMs * 0.001);
      orient.premultiply(qTmp).normalize();
    }
    sphere.quaternion.copy(orient);
    camera.position.set(0, 0, dist);
    camera.lookAt(0, 0, 0);
    // The shader compares against world normals, which are the body normals turned by orient,
    // so the light has to be turned the same way to stay put on the body as it spins.
    if (sunME) meToGlobe(sunME, uniforms.uSunDir.value).applyQuaternion(orient).normalize();
  }

  function resize(w, h) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function render() {
    renderer.render(scene, camera);
  }

  return {
    scene, camera, sphere, uniforms, attach, detach, pick, surfaceAt, screenOf, step, resize, render,
    siteDirs,
    get dragged() { return dragged; },
    stopSpin: () => { spin = 0; },
    highlight: (zoneId) => { uniforms.uZoneSel.value = zoneId | 0; },
    // Jump straight there, for setting up a view without an animation
    faceSite: (site) => { setLatLonFacing(orient, site.lat, site.lon); spin = 0; },
    flyTo,
    // The two poses the view actually uses: the whole body, and close enough over the pole
    // that the zone cap fills the frame
    flyToOverview: (ms) => flyTo(START.lat, START.lon, DIST.start, ms),
    flyToPole: (ms) => flyTo(-89.5, 0, DIST.min, ms),
    flyToSite: (site, ms) => flyTo(site.lat, site.lon, DIST.min, ms),
    get distance() { return dist; },
    get flying() { return fly.dur > 0; },
  };
}
