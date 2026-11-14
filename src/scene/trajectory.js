// Earth-only two-body estimate, solved from elapsed time and the lunar arrival position.
// This is not a launch guidance solution: the parking-orbit plane is assumed and the
// Moon/Sun gravity, powered ascent, losses, vehicle limits and lunar capture are omitted.
// Universal-variable Lambert problem: NASA TM X-65306, Estes & Lancaster (1970),
// https://ntrs.nasa.gov/citations/19700027262 . Units throughout: km and seconds.
export const EARTH_MU = 398600.4418;
export const EARTH_RADIUS_KM = 6378.137;
const TAU = Math.PI * 2;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = a => Math.hypot(...a);
const scale = (a, s) => a.map(x => x * s);
const add = (a, b) => a.map((x, i) => x + b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => scale(a, 1 / length(a));
const finiteVector = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);

function stumpff(z) {
  if (Math.abs(z) < 1e-5) {
    return [0.5 - z / 24 + z * z / 720 - z * z * z / 40320,
      1 / 6 - z / 120 + z * z / 5040 - z * z * z / 362880];
  }
  const s = Math.sqrt(Math.abs(z));
  return z > 0 ? [(1 - Math.cos(s)) / z, (s - Math.sin(s)) / (s * s * s)]
    : [(Math.cosh(s) - 1) / -z, (Math.sinh(s) - s) / (s * s * s)];
}

// Short-way, zero-revolution Lambert solution in the departure radial/tangential basis.
function lambert(r1, r2, angle, seconds) {
  const A = Math.sin(angle) * Math.sqrt(r1 * r2 / (1 - Math.cos(angle)));
  const at = z => {
    const [C, S] = stumpff(z);
    const y = r1 + r2 + A * (z * S - 1) / Math.sqrt(C);
    if (!(y > 0)) return { seconds: -Infinity, y };
    const x = Math.sqrt(y / C);
    return { seconds: (x ** 3 * S + A * Math.sqrt(y)) / Math.sqrt(EARTH_MU), y };
  };
  let lo = -TAU * TAU, hi = TAU * TAU - 1e-6;
  while (at(lo).seconds > seconds && lo > -1e4) lo *= 2;
  if (!(at(lo).seconds <= seconds && at(hi).seconds >= seconds)) {
    throw new RangeError('The two-body transfer could not be bracketed.');
  }
  for (let i = 0; i < 72; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid).seconds < seconds) lo = mid; else hi = mid;
  }
  const answer = at((lo + hi) / 2);
  if (Math.abs(answer.seconds - seconds) > 1e-3) throw new RangeError('The transfer time did not converge.');
  const f = 1 - answer.y / r1, g = A * Math.sqrt(answer.y / EARTH_MU);
  return { radial: (r2 * Math.cos(angle) - f * r1) / g, tangent: r2 * Math.sin(angle) / g };
}

/** Propagate a Cartesian state with the universal Kepler equation, with no visual easing. */
export function propagateTwoBody(positionKm, velocityKmS, seconds) {
  if (!finiteVector(positionKm) || !finiteVector(velocityKmS) || !Number.isFinite(seconds) || seconds < 0) {
    throw new TypeError('A finite Cartesian state and nonnegative elapsed seconds are required.');
  }
  const r0 = length(positionKm);
  if (!(r0 > 0)) throw new RangeError('The initial position cannot be the origin.');
  if (seconds === 0) return { positionKm: [...positionKm], velocityKmS: [...velocityKmS] };
  const sqrtMu = Math.sqrt(EARTH_MU), radial = dot(positionKm, velocityKmS) / r0;
  const alpha = 2 / r0 - dot(velocityKmS, velocityKmS) / EARTH_MU;
  const at = chi => {
    const z = alpha * chi * chi, [C, S] = stumpff(z);
    return { C, S, residual: r0 * radial / sqrtMu * chi * chi * C + (1 - alpha * r0) * chi ** 3 * S + r0 * chi - sqrtMu * seconds };
  };
  let lo = 0, hi = 1;
  while (at(hi).residual < 0 && hi < 1e7) hi *= 2;
  if (!(at(hi).residual >= 0)) throw new RangeError('The two-body propagation could not be bracketed.');
  for (let i = 0; i < 72; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid).residual < 0) lo = mid; else hi = mid;
  }
  const chi = (lo + hi) / 2, { C, S } = at(chi);
  const f = 1 - chi * chi / r0 * C, g = seconds - chi ** 3 / sqrtMu * S;
  const position = add(scale(positionKm, f), scale(velocityKmS, g));
  const r = length(position), fDot = sqrtMu / (r * r0) * (alpha * chi ** 3 * S - chi);
  const gDot = 1 - chi * chi / r * C;
  const velocity = add(scale(positionKm, fDot), scale(velocityKmS, gDot));
  if (!position.every(Number.isFinite) || !velocity.every(Number.isFinite)) throw new RangeError('The propagated state is not finite.');
  return { positionKm: position, velocityKmS: velocity };
}

/**
 * The arrival vector must be geocentric and expressed in one fixed orthonormal basis.
 * A scene frame frozen at the arrival epoch is valid; do not rotate each sample into
 * its own moving Moon-fixed frame. The input magnitude must be the real distance.
 * The assumed plane and departure angle are free: solve the angle so injection is
 * tangential at the selected parking radius, then solve/propagate the Lambert orbit.
 * This targets the lunar centre as a boundary condition, not a safe lunar arrival.
 */
export function solveLunarTransfer({ moonPositionKm, durationH, planeNormal = [0, 1, 0], samples = 160, parkingAltitudeKm = 200 }) {
  if (!finiteVector(moonPositionKm) || !finiteVector(planeNormal) || !Number.isFinite(durationH) ||
      !Number.isFinite(parkingAltitudeKm) || !Number.isInteger(samples) || samples < 8 || samples > 2048) {
    throw new TypeError('Finite transfer inputs and 8–2048 samples are required.');
  }
  const seconds = durationH * 3600, r1 = EARTH_RADIUS_KM + parkingAltitudeKm, r2 = length(moonPositionKm);
  // A zero-duration or very short transfer is not a usable lunar planning estimate.
  if (durationH < 1 || durationH > 120 || parkingAltitudeKm < 100 || r2 < 300000 || r2 > 450000) {
    throw new RangeError('The lunar transfer estimate requires 1–120 hours and valid lunar/parking radii.');
  }
  const arrivalUnit = unit(moonPositionKm);
  let normal = add(planeNormal, scale(arrivalUnit, -dot(planeNormal, arrivalUnit)));
  if (length(normal) < 1e-8) normal = cross(arrivalUnit, Math.abs(arrivalUnit[1]) < .9 ? [0, 1, 0] : [0, 0, 1]);
  normal = unit(normal);
  const arrivalTangent = unit(cross(normal, arrivalUnit));
  let lo = .001, hi = Math.PI - 1e-5;
  if (lambert(r1, r2, lo, seconds).radial < 0 || lambert(r1, r2, hi, seconds).radial > 0) {
    throw new RangeError('No outbound tangential parking-orbit transfer fits this duration.');
  }
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (lambert(r1, r2, mid, seconds).radial > 0) lo = mid; else hi = mid;
  }
  const angle = (lo + hi) / 2, solution = lambert(r1, r2, angle, seconds);
  const departureUnit = add(scale(arrivalUnit, Math.cos(angle)), scale(arrivalTangent, -Math.sin(angle)));
  const departureTangent = cross(normal, departureUnit);
  const departurePositionKm = scale(departureUnit, r1);
  const departureVelocityKmS = add(scale(departureUnit, solution.radial), scale(departureTangent, solution.tangent));
  const initialEnergy = dot(departureVelocityKmS, departureVelocityKmS) / 2 - EARTH_MU / r1;
  const energyScale = EARTH_MU / r1; // Stable normalization even for near-parabolic energy.
  const initialMomentum = length(cross(departurePositionKm, departureVelocityKmS));
  let energyRelativeError = 0, angularMomentumRelativeError = 0;
  const positionsKm = [], velocitiesKmS = [], timesSeconds = [];
  for (let i = 0; i <= samples; i++) {
    // Cluster samples near perigee, where curvature and speed are highest.
    const elapsed = seconds * (i / samples) ** 2;
    const state = propagateTwoBody(departurePositionKm, departureVelocityKmS, elapsed);
    const radius = length(state.positionKm), speedSq = dot(state.velocityKmS, state.velocityKmS);
    energyRelativeError = Math.max(energyRelativeError, Math.abs(speedSq / 2 - EARTH_MU / radius - initialEnergy) / energyScale);
    angularMomentumRelativeError = Math.max(angularMomentumRelativeError,
      Math.abs(length(cross(state.positionKm, state.velocityKmS)) / initialMomentum - 1));
    if (radius < r1 - .01) throw new RangeError('The transfer intersects the parking radius.');
    positionsKm.push(state.positionKm); velocitiesKmS.push(state.velocityKmS); timesSeconds.push(elapsed);
  }
  const endpointErrorKm = length(add(positionsKm.at(-1), scale(moonPositionKm, -1)));
  if (endpointErrorKm > .05 || energyRelativeError > 1e-8 || angularMomentumRelativeError > 1e-8) {
    throw new RangeError('The transfer failed numerical validation.');
  }
  return {
    model: 'earth-two-body', positionsKm, velocitiesKmS, timesSeconds,
    departurePositionKm, departureVelocityKmS, arrivalVelocityKmS: velocitiesKmS.at(-1),
    parkingRadiusKm: r1, parkingAltitudeKm, flightTimeSeconds: seconds, transferAngleRad: angle,
    injectionDeltaVKmS: length(departureVelocityKmS) - Math.sqrt(EARTH_MU / r1),
    endpointErrorKm, energyRelativeError, angularMomentumRelativeError,
  };
}
