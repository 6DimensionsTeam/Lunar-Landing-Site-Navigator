// A time-compressed launch montage, not an engineering trajectory solution.
// NASA Artemis I reference: Max Q at T+70 s; boosters separate at T+132 s.
// https://www.nasa.gov/reference/artemis-i-mission-timeline/
// The published press-kit Max Q altitude is 42,555 ft (12,970.764 m).
// The smooth path below uses that altitude as one visual anchor. Its downrange
// curve, camera positions and intermediate states are authored approximations.
// https://www.nasa.gov/wp-content/uploads/2026/01/artemis-i-press-kit.pdf

const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => { const t = clamp(x); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => a.map((x, i) => mix(x, b[i], t));
const EARTH_RADIUS_M = 6371000;
const MAX_Q_ALTITUDE_M = 42555 * .3048;
const HEIGHT_CUBIC = (MAX_Q_ALTITUDE_M - 2.15 * 70 ** 2) / 70 ** 3;

/** Metre-scale path in a local launch frame: +X downrange, +Y zenith. */
export function ascentState(elapsedS) {
  if (!Number.isFinite(elapsedS)) throw new TypeError('Ascent time must be finite.');
  const t = Math.max(0, Math.min(120, elapsedS));
  const altitudeM = 2.15 * t * t + HEIGHT_CUBIC * t ** 3;
  const verticalSpeed = 4.3 * t + 3 * HEIGHT_CUBIC * t * t;
  // Stay vertical beside the tower, then gradually bend downrange.
  const turnTime = Math.max(0, t - 8);
  const x = .0203 * turnTime ** 3, vx = .0609 * turnTime ** 2;
  const radialY = Math.sqrt((EARTH_RADIUS_M + altitudeM) ** 2 - x * x);
  const y = radialY - EARTH_RADIUS_M;
  const vy = ((EARTH_RADIUS_M + altitudeM) * verticalSpeed - x * vx) / radialY;
  const speed = Math.hypot(vx, vy);
  return {
    elapsedS: t, altitudeM, positionM: [x, y, 0],
    direction: speed ? [vx / speed, vy / speed, 0] : [0, 1, 0],
    velocityMps: [vx, vy, 0],
  };
}

/**
 * Sample the first 90% of a 9.5-second movie. Cuts at .24 and .64 allow
 * atmospheric travel to be compressed without an impossible continuous zoom.
 * The final shot ends before booster separation; the whole stack remains valid.
 */
export function sampleAscent(progress, { reducedMotion = false, aspect = 16 / 9 } = {}) {
  if (!Number.isFinite(progress)) throw new TypeError('Film progress must be finite.');
  const p = clamp(progress);
  const shot = p < .24 ? 'ground' : p < .64 ? 'clouds' : 'upper-atmosphere';
  const u = shot === 'ground' ? clamp(p / .24) : shot === 'clouds' ? clamp((p - .24) / .4) : clamp((p - .64) / .26);
  const elapsedS = shot === 'ground' ? mix(0, 12, u) : shot === 'clouds' ? mix(20, 55, u) : mix(90, 120, u);
  const state = ascentState(elapsedS);
  const focus = state.direction.map(component => component * 50);
  let offsetM, targetOffsetM = focus, fov;
  if (shot === 'ground') {
    // The camera stays on the ground while its head tracks the rising vehicle.
    // The diminishing apparent size supplies the scale cue missing in a chase.
    const groundCamera = aspect < .9 ? [144, 82, 211] : [113, 62, 151];
    const groundTarget = aspect < .9 ? [-11, 43, 0] : [-15, 41, 0];
    offsetM = groundCamera.map((component, index) => component - state.positionM[index]);
    targetOffsetM = mix3(groundTarget, focus, smooth(u / .4));
    fov = 42;
  } else if (shot === 'clouds') {
    // A gentle side pass changes parallax; clouds cross in front and behind.
    offsetM = mix3([230, -25, 320], [150, 80, 260], smooth(u));
    fov = mix(34, 38, smooth(u));
  } else {
    // At 23-43 km the horizon is only subtly curved, not a whole Earth globe.
    offsetM = mix3([320, 110, 350], [210, 120, 300], smooth(u));
    fov = 30;
  }
  if (aspect < .9 && shot !== 'ground') {
    offsetM = offsetM.map((component, index) => index === 1 ? component : component * 1.2);
  }
  // Very small camera tracking imperfections, never random vehicle wobble.
  if (!reducedMotion && shot !== 'ground') {
    targetOffsetM = [...targetOffsetM];
    targetOffsetM[0] += Math.sin(p * 83) * .22;
    targetOffsetM[1] += Math.sin(p * 119) * .12;
  }
  const blackout = Math.max(
    1 - smooth(Math.abs(p - .24) / .014),
    1 - smooth(Math.abs(p - .64) / .014),
    smooth((p - .86) / .04),
  );
  const phase = shot === 'ground' ? 'IGNITION & TOWER CLEARANCE'
    : shot === 'clouds' ? 'ASCENT THROUGH CLOUD LAYERS'
    : 'UPPER ATMOSPHERE · TIME COMPRESSED';
  return {
    ...state, shot, phase, camera: { offsetM, targetOffsetM, fov }, blackout,
    // All shown states precede T+132 s: no detached boosters or orbital claims.
    boosterSeparation: false,
    plume: { core: 1, boosters: 1, expansion: mix(1, 2.7, smooth(state.altitudeM / 45000)) },
  };
}
