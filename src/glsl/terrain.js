// Lunar terrain shader. The geometry only carries the outline; normals, shadowing and albedo are all computed per pixel.
import { common } from './common.js';
import { detail } from './detail.js';
import { haze } from './haze.js';
import { nearFragHead } from './near.js';

export const terrainVert = /* glsl */ `
${common}
uniform int uLayer;          // 0 inner mesh, 1 outer ring, 2 distant skirt
uniform float uSkirt0, uSkirt1;
out vec2 vMap;
out vec3 vWorld;
void main() {
  vec2 m = position.xz;
  float h = heightKm(m);
  if (uLayer == 2) h *= 1.0 - smoothstep(uSkirt0, uSkirt1, length(m));
  vMap = m;
  vWorld = mapToScene(m, h);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

export const terrainFrag = /* glsl */ `
${common}
${detail}
uniform int uLayer;
uniform float uMeshSplit;    // boundary radius between the inner mesh and the outer ring, km
uniform float uSkirt0, uSkirt1;
uniform vec3 uSunDir;        // sun direction in scene coordinates
uniform vec3 uEarthDir;
uniform sampler2D uShHero, uShIn, uShOut;
uniform float uShEHero, uShEIn, uShEOut;
uniform float uSunI;         // solar irradiance (HDR)
uniform float uFill;         // artistic fill strength (earthshine + scattering)
uniform float uKey;          // cinematic key light strength (same azimuth as the sun, higher angle)
uniform vec3 uKeyDir;
uniform sampler2D uKShHero, uKShIn;
uniform float uNearSh;       // strength of the shadowing from small near-field relief (0 no shadowing, 1 fully black)
uniform float uDemFine;      // contrast of the relief below a few hundred metres in the DEM (1 unchanged)
uniform float uBigK;         // slope amplification for large-scale relief (big craters, mountains)
uniform float uFineK;        // fraction of small-scale relief that takes part in shading (1 all of it)
uniform float uSplitPx;      // split between large and small relief: roughly how many pixels on screen
uniform sampler2D uGHero, uGIn, uGOut;   // slope maps (mipmapped)
uniform float uLift;         // angle the sun is raised by for the shading (radians)
uniform float uTexHero;
${haze}
uniform vec3 uFogCol;
uniform float uTexIn, uTexOut;  // edge length of the two height maps (pixels)
uniform float uLines;        // strength of the contour lines and the lat/lon grid (0 off)
uniform float uTrack;        // strength of the orbital station ground track (0 off)
uniform vec2 uTrackDir;      // track direction (unit vector in map coordinates, through the pole)
uniform vec2 uNadir;         // nadir point (map coordinates, km)
// rover close-up: the main terrain cuts out the circle covered by the near patch (uDiscR = 0 cuts nothing out);
// the key light is dimmed to uKeyFloor where the real sun does not reach (1 = no dimming; home / explore / orbit are all 1)
uniform vec2 uDiscC;
uniform float uDiscR;
uniform float uKeyFloor;
in vec2 vMap;
in vec3 vWorld;
out vec4 outColor;
#ifdef NEAR
${nearFragHead}
#define CAMK uCamK
#else
#define CAMK cameraPosition
#endif

// Central-difference slope. k is the sampling interval (pixels): k = 1 keeps all detail, a large k leaves only the large-scale relief
vec2 gradTile(sampler2D tex, vec2 m, float E, float n, float k) {
  vec2 uv = mapUV(m, E);
  float du = k / n;
  float hx1 = textureLod(tex, uv + vec2(du, 0), 0.0).r, hx0 = textureLod(tex, uv - vec2(du, 0), 0.0).r;
  float hy1 = textureLod(tex, uv - vec2(0, du), 0.0).r, hy0 = textureLod(tex, uv + vec2(0, du), 0.0).r;
  float step = 2.0 * E / n * 1000.0 * 2.0 * k;   // distance between the two sample points, metres
  return vec2(hx1 - hx0, hy1 - hy0) / step;       // m/m
}

// Isolines: one line every step in v, dv is how much v changes within one pixel, w is the line width (pixels).
// Returns coverage; the line fades out once it is packed tighter than about 7 px on screen, so grazing slopes do not smear into a solid band
float isoline(float v, float step, float dv, float w) {
  float f = abs(fract(v / step + 0.5) - 0.5) * step;
  return (1.0 - smoothstep(0.0, dv * w, f)) * (1.0 - smoothstep(0.07, 0.16, dv / step));
}

// Smoothed slope: sampled from the mipmapped slope map at scale s (km), relief smaller than s is averaged out
vec2 gradLow(sampler2D gt, vec2 m, float E, float n, float s) {
  float texel = 4.0 * E / n;                       // the slope map is half resolution, this is one pixel in km
  return textureLod(gt, mapUV(m, E), max(log2(s / texel), 0.0)).rg;
}

void main() {
#ifdef NEAR
  // Near patch: pixel size is measured in local coordinates in metres, the km-scale vMap does not have the precision for centimetre scales
  if (length(vGrid) > uTrimR) discard;
  float px = length(fwidth(vNearM)) * 0.001;
  float pxS = min(length(dFdx(vNearM)), length(dFdy(vNearM))) * 0.001;
  float rho = length(vMap);
#else
  float px = length(fwidth(vMap));                      // how many km one pixel covers (computed before the discard)
  // "Pixel size" on screen is the smaller of the two directions: at grazing angles the image is stretched vertically, and that must not make distant mountains count as small relief
  float pxS = min(length(dFdx(vMap)), length(dFdy(vMap)));
  float rho = length(vMap);
  if (uDiscR > 0.0 && length(vMap - uDiscC) < uDiscR) discard;
  if (uLayer == 0 && rho > uMeshSplit) discard;
  if (uLayer == 1 && rho <= uMeshSplit) discard;
#endif

  // Large-scale slope: from the real DEM (raw 40 m near the pole)
  float w = innerW(vMap);
  float wh = heroW(vMap);
  // Split by screen frequency: gC only contains relief larger than about uSplitPx pixels on screen (big craters, mountains), g contains all detail.
  // The small-crater part = g - gC, its contrast is lowered separately
  float split = uSplitPx * pxS;                          // split scale km
  vec2 g = gradTile(uHOut, vMap, uEOut, uTexOut, 1.0);
  vec2 gC = gradLow(uGOut, vMap, uEOut, uTexOut, split);
  vec2 gA = gradLow(uGOut, vMap, uEOut, uTexOut, 0.3);  // fixed 300 m scale: used for albedo, does not follow the camera
  if (w > 0.0) {
    g = mix(g, gradTile(uHIn, vMap, uEIn, uTexIn, 1.0), w);
    gC = mix(gC, gradLow(uGIn, vMap, uEIn, uTexIn, split), w);
    gA = mix(gA, gradLow(uGIn, vMap, uEIn, uTexIn, 0.3), w);
  }
  if (wh > 0.0) {
    g = mix(g, gradTile(uHHero, vMap, uEHero, uTexHero, 1.0), wh);
    gC = mix(gC, gradLow(uGHero, vMap, uEHero, uTexHero, split), wh);
    gA = mix(gA, gradLow(uGHero, vMap, uEHero, uTexHero, 0.3), wh);
  }
  g = mix(gC, g, uDemFine);                              // only uDemFine of the small relief's slope is kept
  if (uLayer == 2) { float sk = 1.0 - smoothstep(uSkirt0, uSkirt1, rho); g *= sk; gC *= sk; gA *= sk; }

  // Local tangent plane: up and the two map directions
  vec3 up = upAt(vWorld);
  vec3 ex = normalize(vec3(1, 0, 0) - up * up.x);     // map +X direction
  vec3 ey = normalize(vec3(0, 0, -1) + up * up.z);    // map +Y direction (scene -z)
  float sunUp = dot(uSunDir, up);
  // Cinematic: the shading uses a "sun" raised by uLift, the shadow direction and length still use the real sun
  vec3 sunH = normalize(uSunDir - up * sunUp + 1e-5);
  float eLit = max(asin(clamp(sunUp, -1.0, 1.0)), 0.0) + uLift;
  vec3 L = normalize(sunH * cos(eLit) + up * sin(eLit));
  vec2 sun2 = normalize(vec2(dot(sunH, ex), dot(sunH, ey)) + 1e-6);
  float tanE = tan(eLit);
  float kUp = dot(uKeyDir, up);
  float tanK = max(kUp, 0.01) / max(sqrt(max(1.0 - kUp * kUp, 0.0)), 1e-3);

  // Small-scale detail: procedural impact craters (including the shadow inside the crater), faded in and out by screen pixel size
  float demRes = mix(mix(0.48, 0.12, w), 0.04, wh);      // resolution of the DEM at this position, km
  vec3 cr = vec3(0.0);
  vec2 crB = vec2(0.0);                                   // the slope of its kilometre-scale craters
  float crSh = 1.0, crKey = 1.0;
  float cells[9] = float[9](3.2, 1.8, 1.0, 0.56, 0.32, 0.18, 0.1, 0.056, 0.032);
  for (int k = 0; k < 9; k++) {
    float c = cells[k];
    float lod = smoothstep(3.0, 10.0, c / max(px, 1e-6));
    // Crater diameter is about 0.5 of a cell; craters wider than 6 DEM pixels are already in the DEM, so they are not added again
    float below = smoothstep(demRes * 6.0, demRes * 16.0, c * 0.5);
    float amp = lod * (1.0 - 0.9 * below) * (k == 0 ? 0.6 : 1.0);
    if (amp < 0.01) continue;
    float kl;
    vec4 l = craterLayer(vMap, c, float(k) * 13.7, sun2, tanE, tanK, kl);
    // Contrast by scale: the relief and shadows of craters under 1 km across are lowered, kilometre-scale craters keep full strength
    float big = smoothstep(0.8, 3.0, c);
    float wSl = mix(0.35, 1.0, big), wSh = mix(0.12, 1.0, big);
    cr += amp * wSl * l.xyz;
    crB += amp * wSl * big * l.xy;
    crSh *= mix(1.0, l.w, amp * wSh);
    crKey *= mix(1.0, kl, amp * wSh);
  }
#ifdef NEAR
  nearCraters(vNearM * 0.001, px, sun2, tanE, tanK, cr, crSh, crKey);
  float rock3d = smoothstep(0.042, 0.055, length(vWorld - CAMK));     // within 50 m the 3D rocks take over the bumps
#else
  float rock3d = 1.0;
#endif
  // Rocks: two layers, only present close up
  float rockSh = 1.0;
  for (int k = 0; k < 2; k++) {
    float c = k == 0 ? 0.05 : 0.018;
    float lod = smoothstep(6.0, 16.0, c / max(px, 1e-6));
    if (lod < 0.01) continue;
    float kl;
    vec3 r = rockLayer(vMap, c, sun2, tanE, tanK, kl);
    cr.xy += lod * r.xy * 0.16 * rock3d;
    rockSh *= mix(1.0, r.z, lod * 0.6);
    crKey *= mix(1.0, kl, lod * 0.6);
  }
  float rl = smoothstep(4.0, 12.0, 0.08 / max(px, 1e-6));
  vec2 rg = rl * regolithGrad(vMap, 0.08) * 0.06;
#ifdef NEAR
  vec2 trkG;
  float trkSh, trkK, trkCov;
  rg += nearFineGrad(vNearM * 0.001, px);
  nearTrack(vNearM, px, sun2, tanE, trkG, trkSh, trkCov);
  rg += trkG;
#endif
  // The slope of the large scales (coarse DEM relief + big craters) is multiplied by uBigK, the small scales stay as they are
  vec2 gBig = gC + crB;
  vec2 gd = uBigK * gBig + (g - gC) + (cr.xy - crB) + rg;
  vec3 N = normalize(up - gd.x * ex - gd.y * ey);
  vec3 Nc = normalize(up - uBigK * (gBig.x * ex + gBig.y * ey));   // normal with the large-scale relief only

  // Terrain ambient occlusion: compared with the heights of the two rings around it, low ground (crater floors, valleys) receives less sky light
  // The "hollowness" is taken from symmetric pairs of points (a slope's gradient cancels, leaving only the curvature), three ring radii:
  // the small ring has a low weight (small craters are not darkened), the 5 km ring has a high weight (big crater floors go clearly darker)
  float h0 = heightKm(vMap);
  float occ = 0.0, cvx = 0.0;
  for (int i = 0; i < 3; i++) {
    float a = float(i) * 1.0471976 + 0.3;
    vec2 dv = vec2(cos(a), sin(a));
    float c1 = (heightKm(vMap + dv * 0.45) + heightKm(vMap - dv * 0.45)) * 0.5 - h0;
    float c2 = (heightKm(vMap + dv * 1.8) + heightKm(vMap - dv * 1.8)) * 0.5 - h0;
    float c3 = (heightKm(vMap + dv * 5.0) + heightKm(vMap - dv * 5.0)) * 0.5 - h0;
    occ += max(atan(c1 / 0.45), 0.0) * 0.4 + max(atan(c2 / 1.8), 0.0) * 0.8 + max(atan(c3 / 5.0), 0.0);
    cvx += max(-atan(c2 / 1.8), 0.0) + max(-atan(c3 / 5.0), 0.0) * 0.6;
  }
  float ao = clamp(1.0 - occ / (3.0 * 2.2) * 7.0, 0.15, 1.0);
  float rim = 1.0 + 0.6 * clamp(cvx / 3.0, 0.0, 0.5);    // raised crater rims and ridges are brightened slightly, big crater rims most of all
  ao = mix(1.0, ao, 1.0 - smoothstep(60.0, 140.0, length(CAMK - vWorld)));

  // Shadows: three occlusion maps (40 m at the pole, inner ring, outer ring), all computed with the real sun direction.
  // The g channel is the occlusion from small near relief, b is the occlusion from distant big crater rims and mountains: the shadow of small craters is lightened, the shadow of big craters stays fully black
  vec3 s3O = texture(uShOut, vec2(0.5) + vMap / (2.0 * uShEOut)).rgb;
  vec3 s3I = texture(uShIn, vec2(0.5) + vMap / (2.0 * uShEIn)).rgb;
  vec3 s3 = mix(s3O, s3I, 1.0 - smoothstep(uBlend0 - 4.0, uBlend0 + 2.0, rho));
  if (wh > 0.0) s3 = mix(s3, texture(uShHero, vec2(0.5) + vMap / (2.0 * uShEHero)).rgb, wh);
  float sh = s3.b * mix(1.0, s3.g, uNearSh);

  // Lunar regolith BRDF: Lommel-Seeliger blended with Lambert (using the raised light direction L)
  vec3 V = normalize(CAMK - vWorld);
  // Small relief takes only part of the shading (uFineK): under a low sun small craters are no longer dead-black dots, the shading of big craters is unaffected
  float mu0 = mix(max(dot(Nc, L), 0.0), max(dot(N, L), 0.0), uFineK);
  float mu = max(dot(N, V), 0.02);
  float ls = 2.0 * mu0 / (mu0 + mu + 1e-4);
  float brdf = mix(mu0, ls * 0.5, 0.3);
  brdf *= smoothstep(-0.02, 0.03, sunUp + 0.03);   // dies out completely once the sun drops below the horizon

  float alb = 0.135 + 0.022 * cr.z + 0.03 * (vnoise(vMap * 0.12) - 0.5) + 0.022 * (vnoise(vMap * 0.7) - 0.5)
            + 0.016 * (vnoise(vMap * 9.0) - 0.5) + 0.01 * (vnoise(vMap * 60.0) - 0.5);
  alb += 0.05 * smoothstep(0.2, 0.65, length(gA));               // the steep walls of big craters are fresher and brighter
#ifdef NEAR
  alb *= nearAlbedo(vNearM * 0.001, px) * (1.0 - 0.13 * trkCov);
#endif
  vec3 albedo = alb * vec3(0.975, 0.985, 1.0);

  vec3 sun = vec3(1.0, 0.985, 0.96) * uSunI;
  float shAll = sh * crSh * rockSh;
#ifdef NEAR
  vec2 rvSh = roverShadow(vNearP);                      // shadow cast by the rover body: x sun, y key light
  float cAO = contactAO(vNearP);
  shAll *= rvSh.x * trkSh;
#endif
  vec3 col = albedo * sun * brdf * shAll;

  // Cinematic fill, high-key grey: broad soft light, upward faces and faces toward Earth are brighter, form is kept in the shadows
  // Cinematic key light: same azimuth as the sun, about 16° high, with its own shadow. Where the real sun does not reach it brings out the relief
  vec3 k3 = texture(uKShIn, vec2(0.5) + vMap / (2.0 * uShEIn)).rgb;
  if (wh > 0.0) k3 = mix(k3, texture(uKShHero, vec2(0.5) + vMap / (2.0 * uShEHero)).rgb, wh);
  k3 = mix(vec3(1.0), k3, 1.0 - smoothstep(uBlend0 - 4.0, uBlend0 + 2.0, rho));
  float kSh = k3.b * mix(1.0, k3.g, uNearSh);
  float key = mix(max(dot(Nc, uKeyDir) * 0.95 + 0.05, 0.0), max(dot(N, uKeyDir) * 0.95 + 0.05, 0.0), uFineK);
  // Where the real sun does not reach (terrain shadow, shadow inside craters, after sunset) the key light is dimmed to uKeyFloor
  float keyDim = mix(uKeyFloor, 1.0, sh * crSh);
#ifdef NEAR
  keyDim *= rvSh.y * mix(1.0, trkSh, 0.5) * cAO;
#endif
  col += albedo * uKey * vec3(0.96, 0.975, 1.0) * key * mix(0.04, 1.0, kSh * crKey) * ao * keyDim;

  float eWrap = 0.5 + 0.5 * dot(N, uEarthDir);
  float sky = 0.55 + 0.45 * dot(N, up);
  float back = 0.5 + 0.5 * dot(N, -sunH);                     // reflection from the "sky" on the side facing away from the light
  // Plus one more soft light from above (from the Earth side, high up), so craters and relief on the shadowed side have shading
  vec3 eH = normalize(uEarthDir - up * dot(uEarthDir, up) + 1e-5);
  vec3 softDir = normalize(up * 0.75 + eH * 0.66);
  float soft = max(dot(N, softDir) * 0.8 + 0.2, 0.0);
  float fillShape = sky * mix(0.55, 1.0, eWrap) * mix(0.8, 1.1, back) * mix(0.35, 1.25, soft);
#ifdef NEAR
  fillShape *= cAO;
#endif
  col += albedo * uFill * vec3(0.88, 0.92, 0.97) * fillShape * ao * ao * mix(0.55, 1.0, crKey);
#ifdef NEAR
  col += albedo * headlights(vNearP, N, V);
#endif

  // Height fog: a dust layer hugging the ground + a very faint distant haze, in a cold grey
  float d = length(cameraPosition - vWorld);
  float hc = sceneToMap(cameraPosition).z, hp = sceneToMap(vWorld).z;
  float e0 = exp(-clamp((hc - uHaze0) / uHazeH, -0.6, 40.0));
  float e1 = exp(-clamp((hp - uHaze0) / uHazeH, -0.6, 40.0));
  float avg = abs(hp - hc) > 1e-3 ? uHazeH * (e0 - e1) / (hp - hc) : e0;
  // Same dust layer as the sky (density varies only with height), a high camera looking down sees almost no fog
  float fog = 1.0 - exp(-d * uFogDen * min(avg, 3.0));
  float fwd = pow(max(dot(-V, uSunDir), 0.0), 6.0);
  vec3 fogCol = uFogCol * (1.0 + 2.5 * fwd);
  // The air deep in big craters that the sun does not reach is not bright either: the fog colour darkens with the occlusion at the crater floor, the floor does not go white
  fogCol *= mix(1.0, mix(0.35, 1.0, sh), smoothstep(0.85, 0.35, ao));
  col *= rim;
  col = mix(col, fogCol, fog);

  // Navigation overlay: LOLA contours at 100 m / 500 m,
  // polar lat/lon grid — latitude circles every 0.25° (1° heavier), meridians every 5° (15° heavier). Line widths are computed in screen pixels and are unaffected by lighting,
  // so the terrain is still visible on the floors of permanently shadowed craters
  if (uLines > 0.0 && uLayer < 2) {
    float hm = h0 * 1000.0;
    float dh = max(fwidth(hm), 1e-4);
    float iso = 0.45 * isoline(hm, 100.0, dh, 0.9) + isoline(hm, 500.0, dh, 1.3);
    float colat = 2.0 * atan(rho / (2.0 * uR)) * 57.29578;          // angular distance from the south pole, degrees
    float dc = max(fwidth(colat), 1e-7);
    float lon = atan(vMap.x, vMap.y) * 57.29578;
    float dl = max(min(fwidth(lon), fwidth(fract(lon / 360.0 + 0.5) * 360.0)), 1e-5);
    float pole = smoothstep(1.5, 4.0, rho);                         // meridians converge near the pole, fade them out early
    float grid = 0.35 * isoline(colat, 0.25, dc, 0.9) + isoline(colat, 1.0, dc, 1.2)
               + pole * (0.35 * isoline(lon, 5.0, dl, 0.9) + isoline(lon, 15.0, dl, 1.2));
    float a = clamp(0.6 * iso + 0.45 * grid, 0.0, 1.0) * uLines;
    col = mix(col, vec3(0.62, 0.66, 0.7), a);
  }
  // Orbital station ground track: a polar orbit is a straight line through the pole in the stereographic projection (red dashed line), the nadir point gets a circle
  if (uTrack > 0.0 && uLayer < 2) {
    // Line width uses the screen derivative of the "offset distance" itself: the direction that is stretched vertically at grazing angles is left out, so it does not blur into a wide band far away
    float s = dot(vMap, uTrackDir);
    float o = dot(vMap, vec2(-uTrackDir.y, uTrackDir.x));
    float ln = 1.0 - smoothstep(0.8, 1.8, abs(o) / max(fwidth(o), 1e-6));
    // dashed in 2.5 km segments; a segment fades out once it is under about 6 px on screen
    float ds = max(fwidth(s), 1e-6);
    float dash = step(0.4, fract(s / 2.5)) * (1.0 - smoothstep(0.25, 0.4, ds / 2.5));
    float rd = length(vMap - uNadir) - 2.2;
    float nad = 1.0 - smoothstep(0.8, 1.8, abs(rd) / max(fwidth(rd), 1e-6));
    col = mix(col, vec3(0.9, 0.1, 0.04), clamp(max(ln * dash, nad), 0.0, 1.0) * uTrack);
  }

  if (uLayer == 2) col *= 1.0 - smoothstep(uSkirt0, uSkirt1 * 0.9, rho) * 0.7;
  outColor = vec4(col, 1.0);
}
`;
