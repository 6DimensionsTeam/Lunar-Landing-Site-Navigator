// Ground-hugging dust layer: density decays exponentially with height above the reference sphere. Optical depth is
// integrated numerically along the view ray (including lunar surface curvature), so from the ground the horizon is a
// band of grey-white light, and once the camera climbs, the zenith and outer space both go black.
// This is a cinematic treatment; the Moon has no atmosphere in reality, and the data computations are unaffected by it.
// Depends on: uR (Moon radius, km).
export const haze = /* glsl */ `
uniform float uFogDen;       // extinction coefficient at the bottom of the dust layer (1/km)
uniform float uHaze0;        // reference height of the dust layer, km
uniform float uHazeH;        // scale height, km

float dustDensity(vec3 p) {
  float h = length(vec3(p.x, p.y + uR, p.z)) - uR;
  return uFogDen * exp(-clamp((h - uHaze0) / uHazeH, -0.6, 40.0));
}

// Optical depth integrated from o along the unit direction dir up to maxD (km)
float dustTau(vec3 o, vec3 dir, float maxD) {
  float tau = 0.0;
  float t = 0.0;
  float ds = 0.25;
  float hPrev = 1e9;
  for (int i = 0; i < 28; i++) {
    float tm = t + ds * 0.5;
    if (tm > maxD) { ds = maxD - t; tm = t + ds * 0.5; }
    vec3 p = o + dir * tm;
    float h = length(vec3(p.x, p.y + uR, p.z)) - uR;
    tau += dustDensity(p) * ds;
    t += ds;
    if (t >= maxD) break;
    if (h > uHaze0 + 10.0 * uHazeH && h > hPrev) break;   // already out of the dust layer and still rising
    hPrev = h;
    ds *= 1.45;
  }
  return tau;
}
`;
