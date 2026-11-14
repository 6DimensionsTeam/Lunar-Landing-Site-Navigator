// Camera: the distant home composition, the crater-rim pose after landing, and the flight between them.
// Poses are { pos, quat, fov }; during a flight the position is interpolated in map coordinates and the altitude separately, so it does not cut into the terrain.
import * as THREE from 'three';
import { sceneToMap } from './geo.js';

const D = THREE.MathUtils.degToRad;
const hfovToVfov = (hfov, aspect) => THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(D(hfov) / 2) / aspect));

// Home composition (tuned at 16:9): back away along the bisector of the Sun-Earth azimuths, crater low centre-frame, Earth and Sun upper left and right
const HOME = { back: 46, side: 4, alt: 15, pitch: 12, hfov: 68, vfovMax: 62 };
const A169 = 16 / 9, A_NARROW = 1.2;
// Landing pose: 6–7 km outside the rim on Shackleton's far side from Sun and Earth, 3 km off the ground, looking into the crater over the near rim, Sun and Earth hanging above the far rim
const LAND = { back: 17, side: 1.2, alt: 3.0 };
// Relay station and orbit view (km / deg). View azimuth: Earth at earthL° left of the view (negative puts it right). The Sun-Earth azimuths differ by only about 45° here,
// so Earth sits 12° right of centre and the Sun is about 57° to the right, off-frame; the Sun behind and to one side edges the station's right silhouette;
// the station spine is turned spineAz° from the view: main engine forward-left, gravity ring three-quarter face centred, core module back-right
const ORBIT = { back: 58, side: 6, alt: 30, earthL: -12, spineAz: -50, camBack: 0.165, camUp: 0.026, aimUp: 0.006 };

// HALO relay station: a high, elliptical lunar orbit that spends most of its period over the south pole.
// Perilune ~300 km, apolune ~16000 km, inclination 55 deg to the lunar equator, period ~24 h, so the far
// point sits above the pole side of the Moon for roughly 18 h a day and relays for the landing sites below.
// Only the apolune position and these numbers are modelled; the drawn orbit is a Keplerian ellipse.
const RELAY = { perilune: 300, apolune: 16000, inc: 55, periodH: 24 };

export function createRig({ R, camera, eph, groundAt, heightAt, crater }) {
  const hz = (v, up) => v.clone().addScaledVector(up, -v.dot(up)).normalize();
  const upOf = (p) => new THREE.Vector3(p.x, p.y + R, p.z).normalize();
  const m4 = new THREE.Matrix4();

  // Bisector of the Sun-Earth azimuths (unit vector in the map plane) and its right-hand direction
  function axes() {
    const ref = groundAt(crater.center.clone(), 0);
    const up = upOf(ref);
    const e = eph.earthPos.clone().sub(ref).normalize();
    const b = hz(hz(eph.sunDir, up).add(hz(e, up)), up);
    const fwd = new THREE.Vector2(b.x, -b.z).normalize();
    return { fwd, right: new THREE.Vector2(fwd.y, -fwd.x) };
  }

  function lookQuat(pos, dir, up) {
    m4.lookAt(pos, pos.clone().add(dir), up);
    return new THREE.Quaternion().setFromRotationMatrix(m4);
  }

  // 16:9 and wider: vertical FOV fixed (wider screens see more); narrower: horizontal FOV eases from 68° down to 56° and the vertical FOV grows with it,
  // keeping Earth and Sun in frame without leaving the sky too empty
  function homeFov(aspect) {
    const v169 = hfovToVfov(HOME.hfov, A169);
    if (aspect >= A169) return v169;
    const t = THREE.MathUtils.clamp(Math.log(A169 / aspect) / Math.log(A169 / A_NARROW), 0, 1);
    return Math.min(hfovToVfov(HOME.hfov - 12 * t, aspect), HOME.vfovMax);
  }

  // Home pose: drift is a slow dolly + lateral move (km), look is a parallax deflection (deg)
  function home(aspect, drift = { fwd: 0, side: 0 }, look = { yaw: 0, pitch: 0 }) {
    const { fwd, right } = axes();
    const base = crater.center.clone().addScaledVector(fwd, -HOME.back).addScaledVector(right, HOME.side);
    const baseH = sceneToMap(R, groundAt(base, HOME.alt)).h;          // absolute altitude fixed, so it does not follow the terrain while panning
    const m = base.clone().addScaledVector(fwd, drift.fwd).addScaledVector(right, drift.side);
    const pos = groundAt(m, baseH - heightAt(m));
    const up = upOf(pos);
    const e = eph.earthPos.clone().sub(pos).normalize();
    const f = hz(hz(eph.sunDir, up).add(hz(e, up)), up).applyAxisAngle(up, D(look.yaw));
    const rt = f.clone().cross(up).normalize();
    const dir = f.applyAxisAngle(rt, -D(HOME.pitch + look.pitch));
    return { pos, quat: lookQuat(pos, dir, up), fov: homeFov(aspect) };
  }

  // Landing pose and the OrbitControls target (crater centre at rim height, same lateral offset as the pose, view parallel to the bisector).
  // The final orientation uses world +y as up, matching OrbitControls, so the handover does not jump
  function landing(aspect) {
    const { fwd, right } = axes();
    const m = crater.center.clone().addScaledVector(fwd, -LAND.back).addScaledVector(right, LAND.side);
    const pos = groundAt(m, LAND.alt);
    const tm = crater.center.clone().addScaledVector(right, LAND.side);
    const target = groundAt(tm, crater.rimH - heightAt(tm));
    const quat = lookQuat(pos, target.clone().sub(pos).normalize(), new THREE.Vector3(0, 1, 0));
    return { pos, quat, fov: homeFov(aspect), target };
  }

  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // Fly from a to b (t ∈ [0,1]). By default the altitude change is concentrated in the first half: dive then flatten out when descending, climb then fall back when returning.
  // hEase replaces the altitude easing (going from orbit down to the rim, altitude tracks horizontal progress instead of dropping to the floor and skimming the ground)
  function flight(a, b, hEase = (s) => 1 - Math.pow(1 - s, 1.6)) {
    const ma = sceneToMap(R, a.pos), mb = sceneToMap(R, b.pos);
    const m0 = ma.m.clone(), m1 = mb.m.clone(), h0 = ma.h, h1 = mb.h;
    return (t) => {
      const s = easeInOut(THREE.MathUtils.clamp(t, 0, 1));
      const m = m0.clone().lerp(m1, s);
      const ground = heightAt(m);
      const h = Math.max(THREE.MathUtils.lerp(h0, h1, hEase(s)), ground + 0.35);   // keep at least 350 m above the ground
      return {
        pos: groundAt(m, h - ground),
        quat: a.quat.clone().slerp(b.quat, s),
        fov: THREE.MathUtils.lerp(a.fov, b.fov, s),
      };
    };
  }

  function apply(p) {
    camera.position.copy(p.pos);
    camera.quaternion.copy(p.quat);
    if (Math.abs(camera.fov - p.fov) > 1e-4) { camera.fov = p.fov; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld();
  }

  // Station: parked at apolune of the relay orbit, high above the far side of the pole so the whole
  // Moon-to-site geometry reads below it. Computed once at boot (the Earth/Sun direction barely moves in minutes).
  function stationPlacement() {
    const { fwd, right } = axes();
    const m = crater.center.clone().addScaledVector(fwd, -ORBIT.back).addScaledVector(right, ORBIT.side);
    const pos = groundAt(m, ORBIT.alt - heightAt(m));
    const up = upOf(pos);
    const view = hz(eph.earthPos.clone().sub(pos), up).applyAxisAngle(up, -D(ORBIT.earthL));
    const spine = view.clone().applyAxisAngle(up, D(ORBIT.spineAz));
    const x = new THREE.Vector3().crossVectors(up, spine).normalize();
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, spine));
    // The scene works in map units where 1 unit is ~1 km near the surface; only the ratio matters here.
    const a = (RELAY.perilune + RELAY.apolune) / 2, e = (RELAY.apolune - RELAY.perilune) / (RELAY.apolune + RELAY.perilune);
    return { pos, quat, up, view, orbit: { a, e, inc: RELAY.inc, periodH: RELAY.periodH, apolune: RELAY.apolune, perilune: RELAY.perilune } };
  }

  // Orbit view: camera behind the station's view direction and slightly above, angled down a little (the station sits on the surface, the sky above is left for the limb and Earth)
  function orbit(aspect, st) {
    // Narrow screens have a smaller horizontal FOV, so pull the camera back and keep the whole station in frame
    const k = THREE.MathUtils.clamp(1.25 / aspect, 1, 2.4);
    const pos = st.pos.clone().addScaledVector(st.view, -ORBIT.camBack * k).addScaledVector(st.up, ORBIT.camUp * k);
    const target = st.pos.clone().addScaledVector(st.up, ORBIT.aimUp);
    const quat = lookQuat(pos, target.clone().sub(pos).normalize(), new THREE.Vector3(0, 1, 0));
    return { pos, quat, fov: homeFov(aspect), target };
  }

  return { home, landing, orbit, stationPlacement, flight, apply, homeFov, axes, HOME, LAND, ORBIT };
}
