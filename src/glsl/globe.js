// Shader for the whole-Moon globe: the WAC mosaic lit by the real Sun direction, a
// slope-shaded relief basemap standing in for it near the pole, and the landing-zone grid
// projected over the southern cap.
//
// All three polar layers share one projection, south polar stereographic, the same one the
// rest of the project works in, so a point on the sphere is placed in it by its own latitude
// and longitude: rho = 2R tan((90 - |lat|) / 2), x = rho sin(lon), y = rho cos(lon), which is
// latLonToMap from src/geo.js written in GLSL (stereoKm below). The zone grid reaches 151.68
// km from the pole, the relief basemap 457 km (75 deg south to the pole). What the closest
// view needs is set by the field of view, not by the sphere's limb: at D = 1.35 R with a
// 32 deg vertical fov the frame corners sit at about 10 deg of colatitude, roughly 300 km
// from the pole, so 457 km covers it with room to fade out before its own edge shows.

export const globeVert = /* glsl */ `
out vec3 vN;
out vec2 vUv;
void main() {
  vN = normalize(normalMatrix * normal);
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const globeFrag = /* glsl */ `
precision highp float;
uniform sampler2D uMap;        // WAC mosaic, equirectangular
uniform float uMapMean;        // the mosaic's own mean level, the point contrast pulls toward
uniform float uMapFlat;        // how much of the mosaic's contrast to keep, 1 for all of it
uniform sampler2D uPolar;      // slope-shaded relief, south polar stereographic
uniform float uPolarE;         // half extent of uPolar, km
uniform sampler2D uZones;      // zone classes, RGBA, nearest filtered
uniform float uZoneA;          // strength of the zone tint
uniform float uZoneE;          // half extent of the zone grid, km
uniform float uR;              // lunar radius, km
uniform int uZoneSel;          // class to single out, 0 for none
uniform float uZoneDim;        // how far the other classes fade back
uniform vec3 uSunDir;          // unit, in the same frame as the sphere's normals
uniform float uAmbient;        // fill so the night side is not pure black
uniform float uTerm;           // softness of the terminator, in cosine units
out vec4 outColor;

in vec3 vN;
in vec2 vUv;

// South polar stereographic, in km: rho = 2R tan((90 - |lat|) / 2), same as src/geo.js
// latLonToMap. Shared by the relief basemap and the zone cap, which differ only in extent.
vec2 stereoKm(float lat, float lon) {
  float colat = 90.0 + lat;
  float rho = 2.0 * uR * tan(radians(abs(colat)) * 0.5);
  float la = radians(lon);
  return vec2(rho * sin(la), rho * cos(la));
}

void main() {
  vec3 N = normalize(vN);

  // Two conventions meet here and they do not agree, so both are written out rather than
  // left to be rediscovered. A three.js sphere puts longitude 0 at u = 0 and the north pole
  // at v = 1. The WAC mosaic is equirectangular with longitude 0 at the centre of the image,
  // so its u = 0.5 is the sphere's u = 0: the texture lookup is offset by half a turn, or the
  // near side ends up painted on the far side.
  float lat = (vUv.y - 0.5) * 180.0;
  float lon = vUv.x * 360.0;
  float albedo = texture(uMap, vec2(fract(vUv.x + 0.5), vUv.y)).r;

  // Near the pole every longitude converges on one texel row of that same equirectangular
  // map, so a camera close enough to read the zone cap sees that row smeared across the
  // frame. uPolar has no pole singularity (it is in the same projection as the zone cap,
  // just wider) and stands in underneath it, cross-fading in before the smear would show.
  vec2 pm = stereoKm(lat, lon);
  float rho = length(pm);
  if (rho < uPolarE) {
    vec2 puv = vec2(pm.x / (2.0 * uPolarE) + 0.5, 0.5 - pm.y / (2.0 * uPolarE));
    float relief = texture(uPolar, puv).r;
    float toEquirect = smoothstep(uPolarE * 0.72, uPolarE, rho);
    // The two textures have the same mean but very different local contrast -- over this band
    // the mosaic's standard deviation is about 56/255 against the cap's 31 -- so where they
    // cross-fade the seam shows as a change of character even when the brightness matches.
    // The mosaic is pulled toward its own mean only inside the blend zone, never outside it:
    // compressing the whole body flattens the Moon everywhere for the sake of one edge.
    float near = 1.0 - smoothstep(uPolarE * 0.55, uPolarE * 1.15, rho);
    albedo = mix(albedo, mix(uMapMean, albedo, uMapFlat), near);
    albedo = mix(relief, albedo, toEquirect);
  }

  // Light the surface first. The zone overlay goes on afterwards, because it is data rather
  // than something the Sun shines on: the polar region this view is about sits in grazing
  // light and would swallow a tint applied before the terminator, which is exactly where the
  // overlay has to stay readable.
  float ndl = dot(N, uSunDir);
  float lit = smoothstep(-uTerm, uTerm, ndl);
  // Display gain on the basemap. The WAC mosaic is levelled to the regolith it depicts, whose
  // mean sits near 57/255, so shown at unit gain the body reads as near-black against a black
  // background and the limb disappears into it. This screen uses the mosaic to orient a reader,
  // not to report a reflectance, so it is lifted to a legible grey: a gain on the midtones with
  // the highlights left alone, so bright rims do not clip. No measured figure anywhere in the
  // product is derived from these pixels -- the slope, light and Earth-link numbers come from
  // the LOLA and ephemeris data, not from this texture.
  float shown = pow(albedo, 0.62) * 1.18;
  vec3 col = vec3(min(shown, 1.0)) * (uAmbient + (1.0 - uAmbient) * lit);

  // Landing zones over the southern cap. The rest of this HUD never washes data on as a soft
  // colour field: it draws flat blocks with a hairline edge (the site chip, the panel frame,
  // the status pills). A translucent blend alone reads as mud where two classes meet, so the
  // boundary itself is drawn -- a thin bright line at the pixels where the nearest other class
  // differs from this one -- the same contour a printed map would use, sampled from the data
  // itself rather than a second pass.
  if (uZoneA > 0.0 && rho < uZoneE * 1.4142) {
    vec2 m = pm;
    if (abs(m.x) < uZoneE && abs(m.y) < uZoneE) {
      vec2 zuv = vec2(m.x / (2.0 * uZoneE) + 0.5, 0.5 - m.y / (2.0 * uZoneE));
      vec4 z = texture(uZones, zuv);
      float a = z.a * uZoneA;
      if (uZoneSel > 0) {
        vec3 want = uZoneSel == 1 ? vec3(0.239, 0.545, 0.769)
                  : uZoneSel == 2 ? vec3(0.886, 0.125, 0.059)
                  : uZoneSel == 3 ? vec3(0.949, 0.957, 0.961)
                  : uZoneSel == 4 ? vec3(0.545, 0.592, 0.620)
                                  : vec3(0.290, 0.322, 0.341);
        a *= distance(z.rgb, want) < 0.02 ? 1.0 : uZoneDim;
      }
      // Fade the overlay out over the last 8 km so the cap has no cut edge
      float edgeFade = 1.0 - smoothstep(uZoneE - 8.0, uZoneE, max(abs(m.x), abs(m.y)));
      a *= edgeFade;
      // Keep the relief visible through the tint without letting it dictate the colour. The
      // basemap is levelled to the dark lunar regolith it depicts (mean about 57/255), so a
      // tint multiplied straight into it comes out nearly black -- and the classes are the
      // point of this screen. The lift dominates and the albedo only modulates, so a crater
      // floor still reads as blue while its rim shading stays visible through it.
      float groundRelief = 0.78 + 0.5 * albedo;
      col = mix(col, z.rgb * groundRelief, a);

      // No contour is drawn here. An earlier version outlined every class boundary, which
      // at 480 m cells meant outlining each individual speckle: the sunlit and flat classes
      // break up into thousands of isolated cells at this resolution, and edging all of them
      // turned the cap into noise. The classes that carry a decision -- permanent shadow and
      // prime ground -- are large and contiguous enough to read from their fill alone.
    }
  }

  outColor = vec4(col, 1.0);
}
`;
