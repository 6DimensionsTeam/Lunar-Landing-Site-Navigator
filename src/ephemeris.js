// Ephemeris interpolation: given a time (hours since the start of the ephemeris range), returns the Sun, Earth and celestial orientation in scene coordinates.
// The range and sample interval come from ephem.json, so nothing here assumes a particular year or step.
import * as THREE from 'three';

// Moon-fixed (ME) → scene rotation: scene = (ME.y, -ME.z, -ME.x), with the origin shifted onto the south polar surface.
export const ME_TO_SCENE = new THREE.Matrix3().set(
  0, 1, 0,
  0, 0, -1,
  -1, 0, 0,
);
const M4 = new THREE.Matrix4().setFromMatrix3(ME_TO_SCENE);

// Earth-texture sphere (three's SphereGeometry) local coordinates → ITRS: x→x, -z→y, y→z
const SPHERE_TO_ITRS = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, -1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

const F = 14;
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
const ea = new THREE.Quaternion(), eb = new THREE.Quaternion();

export class Ephemeris {
  constructor(buf, meta, radiusKm) {
    this.buf = buf;
    this.count = meta.count;
    this.stepH = meta.step_hours;
    this.start = Date.parse(meta.start_utc);
    // Last time that is still covered by two samples, in hours. Callers clamp to this
    // rather than to count, which is a sample index and only equals hours when stepH is 1.
    this.maxH = (meta.count - 1.0001) * meta.step_hours;
    this.startYear = meta.start_year ?? new Date(Date.parse(meta.start_utc)).getUTCFullYear();
    this.endYear = meta.end_year ?? this.startYear;
    this.R = radiusKm;
    this.sunDir = new THREE.Vector3();      // scene coordinates, unit vector
    this.earthPos = new THREE.Vector3();    // scene coordinates, km (relative to the scene origin)
    this.icrsToScene = new THREE.Matrix4(); // celestial → scene (rotation only)
    this.earthRot = new THREE.Quaternion(); // orientation of the Earth-texture sphere
  }

  hoursToDate(h) { return new Date(this.start + h * 3600e3); }

  vec(i, o, out) {
    const b = this.buf, k = i * F + o;
    return out.set(b[k], b[k + 1], b[k + 2]);
  }

  quat(i, o, out) {
    const b = this.buf, k = i * F + o;
    return out.set(b[k], b[k + 1], b[k + 2], b[k + 3]);
  }

  // Raw values in the Moon-fixed frame (for site horizontal coordinates)
  rawAt(h, sunME, earthME) {
    const f = THREE.MathUtils.clamp(h / this.stepH, 0, this.count - 1.0001);
    const i = Math.floor(f), w = f - i;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    sunME.copy(this.vec(i, 0, a)).lerp(this.vec(i + 1, 0, b), w).normalize();
    earthME.copy(this.vec(i, 3, a)).lerp(this.vec(i + 1, 3, b), w);
    return { i, w };
  }

  update(h) {
    const sunME = new THREE.Vector3(), earthME = new THREE.Vector3();
    const { i, w } = this.rawAt(h, sunME, earthME);
    this.sunDir.copy(sunME).applyMatrix3(ME_TO_SCENE).normalize();
    this.earthPos.copy(earthME).applyMatrix3(ME_TO_SCENE);
    this.earthPos.y -= this.R;                       // moon centre at (0, -R, 0)

    this.quat(i, 6, qa); this.quat(i + 1, 6, qb);
    qa.slerp(qb, w);
    this.icrsToScene.makeRotationFromQuaternion(qa).premultiply(M4);

    this.quat(i, 10, ea); this.quat(i + 1, 10, eb);
    ea.slerp(eb, w);
    const m = new THREE.Matrix4().makeRotationFromQuaternion(ea).premultiply(M4).multiply(SPHERE_TO_ITRS);
    this.earthRot.setFromRotationMatrix(m);
    return this;
  }
}
