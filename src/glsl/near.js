// Near-field patch for the rover close-up: the same shader as the main terrain (the #ifdef NEAR branch in terrain.js),
// with vertices in metres and the origin drawn near the camera. It adds what the main terrain cannot resolve:
// centimetre- to metre-scale craters and regolith, tracks, the rover's cast shadow, contact occlusion under the
// chassis, and the headlights.
import { common } from './common.js';

// ---------- vertex: 4 m grid, the outer ring morphs into the main terrain's 195 m grid triangles, seams tight ----------
export const nearVert = /* glsl */ `
${common}
uniform float uTexHero;
uniform float uFine;         // 1 where the 40 m hero tile covers this patch, 0 outside it
uniform vec2 uPC;            // patch centre (map km), falls on a vertex of the main mesh
uniform vec2 uPCA;           // patch centre relative to point A (metres)
uniform vec3 uO;             // origin of the near scene (scene km)
uniform float uMorph0, uMorph1;   // transition band from fine to coarse (metres)
uniform float uGridE, uGridN;     // main terrain inner mesh: half side length km, cell count
out vec2 vMap;
out vec3 vWorld;
out vec2 vGrid;
out vec2 vNearM;
out vec3 vNearP;

// 40 m height at the pole: manual bilinear (texelFetch), bit-for-bit identical to heightAt in JS, so the wheels sit on the ground
float heroFine(vec2 m) {
  float n = uTexHero, E = uEHero;
  float c = (m.x / (2.0 * E) + 0.5) * n - 0.5;
  float r = (0.5 - m.y / (2.0 * E)) * n - 0.5;
  int N = int(n);
  int c0 = clamp(int(floor(c)), 0, N - 2), r0 = clamp(int(floor(r)), 0, N - 2);
  float fc = clamp(c - float(c0), 0.0, 1.0), fr = clamp(r - float(r0), 0.0, 1.0);
  float h00 = texelFetch(uHHero, ivec2(c0, r0), 0).r, h10 = texelFetch(uHHero, ivec2(c0 + 1, r0), 0).r;
  float h01 = texelFetch(uHHero, ivec2(c0, r0 + 1), 0).r, h11 = texelFetch(uHHero, ivec2(c0 + 1, r0 + 1), 0).r;
  return mix(mix(h00, h10, fc), mix(h01, h11, fc), fr) * 0.001;
}

// Height of the main terrain mesh at m: same vertices, same diagonal split (gridGeometry in terrain.js)
float coarseH(vec2 m) {
  float s = 2.0 * uGridE / uGridN;
  vec2 g = (m + uGridE) / s;
  vec2 i0 = floor(g), f = g - i0;
  vec2 p = i0 * s - uGridE;
  float h00 = heightKm(p), h10 = heightKm(p + vec2(s, 0.0)), h01 = heightKm(p + vec2(0.0, s)), h11 = heightKm(p + vec2(s));
  if (f.x + f.y <= 1.0) return h00 + (h10 - h00) * f.x + (h01 - h00) * f.y;
  return h11 + (h01 - h11) * (1.0 - f.x) + (h10 - h11) * (1.0 - f.y);
}

void main() {
  vec2 g = position.xz;                      // relative to the patch centre (metres)
  vec2 m = uPC + g * 0.001;
  float w = smoothstep(uMorph0, uMorph1, length(g));
  // Outside the hero tile heroFine() only clamps to its edge, which would lay a flat false
  // floor under the rover. uFine is 0 there and the patch follows the main mesh instead.
  float w2 = max(w, 1.0 - uFine);
  float h = w2 >= 1.0 ? coarseH(m) : heroFine(m);
  if (w2 > 0.0 && w2 < 1.0) h = mix(h, coarseH(m), w2);
  vec3 wp = mapToScene(m, h);
  vMap = m;
  vWorld = wp;
  vGrid = g;
  vNearM = uPCA + g;
  vNearP = (wp - uO) * 1000.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(vNearP, 1.0);
}
`;

// ---------- fragment: plugged into the #ifdef NEAR block of terrainFrag (depends on the noise and craters in detail.js) ----------
export const nearFragHead = /* glsl */ `
in vec2 vGrid;               // relative to the patch centre (metres)
in vec2 vNearM;              // map coordinates relative to point A (metres): the coordinate for the detail patterns, so they do not jump when the patch moves
in vec3 vNearP;              // near scene coordinates (metres)
uniform float uTrimR;        // radius the patch is trimmed to a circle with (metres)
uniform vec3 uCamK;          // camera position in scene coordinates (km)
// Rover body shadow: two depth maps (sun / key light) storing the distance along the light ray to the nearest occluder (metres), 0 = no occluder
uniform sampler2D uRvShS, uRvShK;
uniform mat4 uRvShMS, uRvShMK;    // near scene → clip space of the light camera
uniform mat4 uRvShVS, uRvShVK;    // near scene → view space of the light camera
uniform float uRvShW;             // width covered by the depth map (metres)
uniform float uRvAngS, uRvAngK;   // apparent radius of the light source (radians), sets the penumbra width
uniform mat4 uRvInv;              // near scene → rover body coordinates (URDF: x forward, y left, z up)
uniform float uRvOn;
// Tracks: r, g store the cos / sin of the grouser phase, a stores coverage
uniform sampler2D uTrk;
uniform vec2 uTrkC;               // track map centre (relative to point A, metres)
uniform float uTrkW, uTrkN;       // covered width (metres), edge length (pixels)
// Headlights
uniform vec3 uHlP[2];
uniform vec3 uHlD[2];
uniform float uHlI;
uniform vec2 uHlCos;              // cos of the inner and outer edges of the light cone

// Only added near the camera: further out the main terrain is enough by itself, and it keeps the patch edge from mismatching the main terrain
float nearFade() { return 1.0 - smoothstep(0.15, 0.3, length(vWorld - uCamK)); }

// Craters from a few centimetres to a few metres across: the lunar surface is full of them
void nearCraters(vec2 p, float px, vec2 sun2, float tanE, float tanK, inout vec3 cr, inout float crSh, inout float crKey) {
  float nf = nearFade();
  if (nf <= 0.0) return;
  float cells[5] = float[5](0.006, 0.0032, 0.0018, 0.001, 0.00056);
  for (int k = 0; k < 5; k++) {
    float c = cells[k];
    float lod = smoothstep(3.0, 10.0, c / max(px, 1e-9)) * nf;
    if (lod < 0.01) continue;
    float kl;
    vec4 l = craterLayer(p, c, 101.0 + float(k) * 7.3, sun2, tanE, tanK, kl);
    cr += lod * 0.5 * l.xyz;
    crSh *= mix(1.0, l.w, lod * 0.35);
    crKey *= mix(1.0, kl, lod * 0.35);
  }
}

// Fine relief of the regolith: three scales, 2.5 m, 60 cm, 15 cm
vec2 nearFineGrad(vec2 p, float px) {
  float nf = nearFade();
  if (nf <= 0.0) return vec2(0.0);
  vec2 g = vec2(0.0);
  float wl[3] = float[3](0.0025, 0.0006, 0.00015);
  float amp[3] = float[3](0.06, 0.06, 0.08);
  for (int k = 0; k < 3; k++) {
    float lod = smoothstep(4.0, 12.0, wl[k] / max(px, 1e-9));
    if (lod < 0.01) continue;
    g += lod * amp[k] * regolithGrad(p + vec2(float(k) * 3.7e-3, float(k) * 1.3e-3), wl[k]);
  }
  return g * nf;
}

float nearAlbedo(vec2 p, float px) {
  float a = 1.0;
  a += 0.06 * (vnoise(p / 0.004) - 0.5) * smoothstep(3.0, 10.0, 0.004 / max(px, 1e-9));
  a += 0.05 * (vnoise(p / 0.0008 + 17.0) - 0.5) * smoothstep(3.0, 10.0, 0.0008 / max(px, 1e-9));
  return mix(1.0, a, nearFade());
}

float atan2s(float y, float x) { return abs(x) + abs(y) < 1e-6 ? 0.0 : atan(y, x); }

// Track profile (metres): pressed down 1.2 cm in the middle, a little soil ridge pushed up on each side
float trkDepth(vec2 uv) {
  float c = texture(uTrk, uv).a;
  return -0.012 * smoothstep(0.2, 0.85, c) + 0.004 * smoothstep(0.0, 0.25, c) * (1.0 - smoothstep(0.25, 0.6, c));
}

// Track: returns the slope (m/m), the sun's self-shadowing inside the track, and coverage
void nearTrack(vec2 m, float px, vec2 sun2, float tanE, out vec2 g, out float sh, out float cov) {
  g = vec2(0.0);
  sh = 1.0;
  cov = 0.0;
  vec2 uv = (m - uTrkC) / uTrkW + 0.5;
  if (any(lessThan(uv, vec2(0.003))) || any(greaterThan(uv, vec2(0.997)))) return;
  float pm = px * 1000.0;                              // how many metres one pixel is
  float vis = 1.0 - smoothstep(0.03, 0.1, pm);         // fades out once one pixel is more than 3 cm
  if (vis <= 0.0) return;
  vec4 t = texture(uTrk, uv);
  if (t.a < 0.002) return;
  cov = t.a * vis;
  float d = uTrkW / uTrkN, du = 1.0 / uTrkN;
  float hx = trkDepth(uv + vec2(du, 0.0)) - trkDepth(uv - vec2(du, 0.0));
  float hy = trkDepth(uv + vec2(0.0, du)) - trkDepth(uv - vec2(0.0, du));
  g = vec2(hx, hy) / (2.0 * d);
  // Grousers: the gradient of the phase is the track direction (radians / metre), the relief is h = a·cos(phase)
  if (t.a > 0.3) {
    vec2 cs = t.rg * 2.0 - 1.0;
    vec2 c1 = texture(uTrk, uv + vec2(du, 0.0)).rg * 2.0 - 1.0;
    vec2 c2 = texture(uTrk, uv + vec2(0.0, du)).rg * 2.0 - 1.0;
    // atan(0, 0) is NaN on some GPUs: the two imprints with opposite phase at the track edge can mix to exactly (0, 0)
    float ph = atan2s(cs.y, cs.x);
    vec2 gph = vec2(atan2s(c1.y * cs.x - c1.x * cs.y, dot(c1, cs)), atan2s(c2.y * cs.x - c2.x * cs.y, dot(c2, cs))) / d;
    float gl = (1.0 - smoothstep(0.0015, 0.004, pm)) * smoothstep(0.4, 0.8, t.a);
    g += -0.0022 * sin(ph) * gph * gl;
  }
  g *= vis;
  // Shadow at the track edge under a low sun: step along the sun direction, if the ground ahead rises above the ray it occludes
  float h0 = trkDepth(uv), occ = -1.0;
  for (int i = 1; i <= 5; i++) {
    float s = float(i) * 0.025;
    occ = max(occ, (trkDepth(uv + sun2 * (s / uTrkW)) - h0) / s - tanE);
  }
  sh = 1.0 - 0.85 * smoothstep(0.0, 0.05, occ) * vis;
}

float rvShadow1(sampler2D tex, mat4 M, mat4 Vw, float ang, vec3 p) {
  vec4 q = M * vec4(p, 1.0);
  vec2 uv = q.xy / q.w * 0.5 + 0.5;
  if (uv.x <= 0.002 || uv.y <= 0.002 || uv.x >= 0.998 || uv.y >= 0.998) return 1.0;
  float zr = -(Vw * vec4(p, 1.0)).z;
  const float bias = 0.03;
  float rot = hash12(gl_FragCoord.xy) * 6.2831853;
  // First find how far the occluders are on average (PCSS), the further the shadow is from the rover the wider the penumbra: sun apparent radius 0.27°
  float sum = 0.0, n = 0.0;
  float rS = 0.15 / uRvShW;
  for (int i = 0; i < 10; i++) {
    float r = sqrt((float(i) + 0.5) / 10.0) * rS, a = float(i) * 2.39996 + rot;
    float z = texture(tex, uv + r * vec2(cos(a), sin(a))).r;
    if (z > 0.01 && z < zr - bias) { sum += z; n += 1.0; }
  }
  if (n < 0.5) return 1.0;
  float pen = max((zr - sum / n) * ang * 2.0, 0.008) / uRvShW;
  float lit = 0.0;
  for (int i = 0; i < 14; i++) {
    float r = sqrt((float(i) + 0.5) / 14.0) * pen, a = float(i) * 2.39996 + rot;
    float z = texture(tex, uv + r * vec2(cos(a), sin(a))).r;
    lit += z > 0.01 && z < zr - bias ? 0.0 : 1.0;
  }
  return lit / 14.0;
}
vec2 roverShadow(vec3 p) {
  if (uRvOn < 0.5) return vec2(1.0);
  return vec2(rvShadow1(uRvShS, uRvShMS, uRvShVS, uRvAngS, p), rvShadow1(uRvShK, uRvShMK, uRvShVK, uRvAngK, p));
}

// Contact occlusion under the chassis: sky light and key light are mostly blocked by the body
float contactAO(vec3 p) {
  if (uRvOn < 0.5) return 1.0;
  vec3 l = (uRvInv * vec4(p, 1.0)).xyz;
  float r = length(vec2(l.x - 0.04, l.y) / vec2(0.95, 0.88));
  float a = mix(0.3, 1.0, smoothstep(0.5, 1.2, r));
  return mix(1.0, a, 1.0 - smoothstep(0.3, 0.8, abs(l.z)));
}

// Two headlights: inverse-square falloff + soft cone edge, the regolith BRDF is the same as for the sun
vec3 headlights(vec3 p, vec3 N, vec3 V) {
  if (uHlI <= 0.0) return vec3(0.0);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    vec3 d = uHlP[i] - p;
    float r2 = max(dot(d, d), 0.04);
    vec3 Ld = d * inversesqrt(r2);
    float cone = smoothstep(uHlCos.y, uHlCos.x, dot(-Ld, uHlD[i]));
    float mu0 = max(dot(N, Ld), 0.0), mu = max(dot(N, V), 0.02);
    float b = mix(mu0, mu0 / (mu0 + mu + 1e-4), 0.3);
    sum += vec3(1.0, 0.96, 0.9) * (uHlI * cone * b / r2);
  }
  return sum;
}
`;
