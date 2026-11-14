// Procedural detail: small impact craters and regolith relief below DEM resolution. Affects only normals and albedo, never the geometry.
export const detail = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1, 0)), c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Crater profile: x = distance to the crater centre / crater radius, returns the height in units of the radius
float craterProfile(float x) {
  if (x < 1.0) return -0.26 + 0.31 * x * x;                       // bowl-shaped floor up to the rim
  float rim = 0.05 * exp(-(x - 1.0) * (x - 1.0) / 0.03);
  float ej = 0.05 * exp(-(x - 1.0) * 3.0);
  return max(rim, ej);
}

uniform float uCrDepth;      // depth multiplier for procedural craters (shared by the normal slope and the shadow inside the crater, so the shading and the shadow agree)

// One layer of impact craters. p is map coordinates (km), cell is the cell size (km).
// sun2 is the unit direction of the light in the map plane, tanE / tanK are the tangents of the sun and key light elevation (both at the same azimuth).
// Returns (slope x, slope y, albedo increase, sun shadow: 1 lit 0 dark), slope in m/m; keyLit is the key light shadow.
vec4 craterLayer(vec2 p, float cell, float seed, vec2 sun2, float tanE, float tanK, out float keyLit) {
  vec2 q = p / cell;
  vec2 ip = floor(q);
  vec4 acc = vec4(0.0, 0.0, 0.0, 1.0);
  keyLit = 1.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 c = ip + vec2(i, j);
    vec2 h = hash22(c + seed);
    float pick = hash12(c + seed + 17.0);
    if (pick > 0.3) continue;
    vec2 ctr = c + 0.15 + 0.7 * h;
    float rs = hash12(c + seed + 41.0);
    float rad = 0.1 + 0.36 * rs * rs;                                  // many small craters, few big ones
    vec2 d = q - ctr;
    float dist = length(d);
    float x = dist / rad;
    if (x > 1.9 || dist < 1e-5) continue;
    float e = 0.02;
    float dp = (craterProfile(x + e) - craterProfile(max(x - e, 0.0))) / (x + e - max(x - e, 0.0));
    float age = hash12(c + seed + 59.0);
    float depthK = uCrDepth * mix(0.2, 1.0, age * age);               // old craters are filled in by the regolith and get shallower
    acc.xy += dp * (d / dist) * depthK;                                // the profile height is in units of the radius, so the slope is dimensionless
    float fresh = pow(hash12(c + seed + 73.0), 10.0);
    acc.z += fresh * exp(-max(x - 0.95, 0.0) * 4.0) * (x < 1.0 ? 0.6 : 1.0);

    // Shadow inside the crater: the rim on the side facing the light casts a shadow onto the crater floor.
    // Along a chord in the light direction the bowl surface is a(s² - c0²), a = 0.31·depth; a ray coming down at elevation E from the light-facing rim at s = c0
    // hits the floor at s = tanE/a - c0, so the shadow length = max(2c0 - tanE/a, 0). Shallow old craters still read bright under a low sun.
    if (x < 1.0) {
      vec2 u = d / rad;                              // normalised coordinates inside the crater
      float s = dot(u, sun2);
      float w = dot(u, vec2(-sun2.y, sun2.x));
      float a = 0.31 * depthK;
      float c0 = sqrt(max(1.0 - w * w, 0.0));        // half length of this chord
      float depth = c0 - s;                          // distance from the light-facing rim
      float tS = max(2.0 * c0 - tanE / a, 0.0);
      float tK = max(2.0 * c0 - tanK / a, 0.0);
      float sS = max(min(0.07, tS), 1e-4), sK = max(min(0.07, tK), 1e-4);
      acc.w *= smoothstep(tS - sS, tS + sS, depth);
      keyLit *= smoothstep(tK - sK, tK + sK, depth);
    }
  }
  return acc;
}

// Scattered rocks: bright on the side facing the light, a long shadow trailing behind. Only present close up.
// Returns (slope x, slope y, shadow: 1 lit 0 dark)
vec3 rockLayer(vec2 p, float cell, vec2 sun2, float tanE, float tanK, out float keyLit) {
  vec2 q = p / cell;
  vec2 ip = floor(q);
  vec3 acc = vec3(0.0, 0.0, 1.0);
  keyLit = 1.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 c = ip + vec2(i, j);
    if (hash12(c + 91.0) > 0.35) continue;
    vec2 ctr = c + 0.2 + 0.6 * hash22(c + 37.0);
    float rr = 0.035 + 0.06 * pow(hash12(c + 53.0), 2.0);
    vec2 d = q - ctr;
    float r = length(d) / rr;
    if (r < 1.0) {
      vec2 nrm = d / rr;
      acc.xy += nrm / max(sqrt(1.0 - r * r), 0.25) * 0.8;
    }
    // Shadow: extends from the rock in the direction away from the light by h / tanE
    float along = -dot(d, sun2);
    float across = abs(dot(d, vec2(-sun2.y, sun2.x)));
    float wid = step(0.0, along) * (1.0 - smoothstep(rr * 0.6, rr * 0.95, across));
    float lenS = rr * 0.8 / max(tanE, 0.01), lenK = rr * 0.8 / max(tanK, 0.01);
    acc.z *= 1.0 - 0.9 * wid * (1.0 - smoothstep(lenS * 0.7, lenS, along));
    keyLit *= 1.0 - 0.9 * wid * (1.0 - smoothstep(lenK * 0.7, lenK, along));
  }
  return acc;
}

// Fine relief of the regolith (numerical gradient). wl is the wavelength, km.
vec2 regolithGrad(vec2 p, float wl) {
  float e = wl * 0.25;
  vec2 q = p / wl;
  float s = e / wl;
  float n0 = vnoise(q) + 0.5 * vnoise(q * 2.13 + 7.0);
  float nx = vnoise(q + vec2(s, 0)) + 0.5 * vnoise((q + vec2(s, 0)) * 2.13 + 7.0);
  float ny = vnoise(q + vec2(0, s)) + 0.5 * vnoise((q + vec2(0, s)) * 2.13 + 7.0);
  return vec2(nx - n0, ny - n0) / s;
}
`;
