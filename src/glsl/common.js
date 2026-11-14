// Functions shared by the terrain shaders: south polar stereographic projection ↔ scene coordinates, height sampling.
//
// Scene coordinates (km): origin on the south polar reference sphere, +y up (away from the Moon's centre), Moon centre at (0, -R, 0).
//   Relation to the Moon-fixed frame (ME): scene = (ME.y, -ME.z - R, -ME.x), right-handed.
// Map coordinates (km): LOLA south polar stereographic projection, +X toward 90°E, +Y toward longitude 0° (toward Earth).
//   Scene x ≈ map X, scene z ≈ -map Y (exactly equal at the pole).
//   Looking down (-y), longitude 0° is up the screen and 90°E to the right, matching the original PDS image.
export const common = /* glsl */ `
uniform float uR;            // lunar reference radius, km
uniform sampler2D uHHero;    // raw 40 m height near the pole (metres), R32F
uniform sampler2D uHIn;      // inner ring 120 m
uniform sampler2D uHOut;     // outer ring 480 m
uniform float uEHero;        // half side length of each layer, km
uniform float uEIn;
uniform float uEOut;
uniform float uBlend0;       // start of the inner/outer blend zone, km
uniform float uBlend1;       // end of the inner/outer blend zone, km

vec2 mapUV(vec2 m, float E) { return vec2(0.5 + m.x / (2.0 * E), 0.5 - m.y / (2.0 * E)); }

float innerW(vec2 m) { return 1.0 - smoothstep(uBlend0, uBlend1, length(m)); }
float heroW(vec2 m) {
  vec2 a = abs(m) / uEHero;
  return 1.0 - smoothstep(0.86, 0.97, max(a.x, a.y));
}

// Height, km. Callable from both vertex and fragment shaders (fixed lod 0).
float heightKm(vec2 m) {
  float w = innerW(m);
  float ho = textureLod(uHOut, mapUV(m, uEOut), 0.0).r;
  float hi = w > 0.0 ? textureLod(uHIn, mapUV(m, uEIn), 0.0).r : ho;
  float h = mix(ho, hi, w);
  float wh = heroW(m);
  if (wh > 0.0) h = mix(h, textureLod(uHHero, mapUV(m, uEHero), 0.0).r, wh);
  return h * 0.001;
}

// Map coordinates + height → scene coordinates (km). The half-angle formula avoids subtracting large numbers.
vec3 mapToScene(vec2 m, float h) {
  float t2 = dot(m, m) / (4.0 * uR * uR);
  float k = 1.0 / (1.0 + t2);
  float f = (uR + h) * k / uR;
  return vec3(m.x * f, h - 2.0 * (uR + h) * t2 * k, -m.y * f);
}

// Scene coordinates → (map X, map Y, height above the reference sphere), in km.
vec3 sceneToMap(vec3 p) {
  vec3 v = vec3(p.x, p.y + uR, p.z);
  float L = length(v);
  float k = 2.0 * uR / (L + v.y);
  return vec3(v.x * k, -v.z * k, L - uR);
}

// "Up" direction at a point in the scene (away from the Moon's centre)
vec3 upAt(vec3 p) { return normalize(vec3(p.x, p.y + uR, p.z)); }
`;
