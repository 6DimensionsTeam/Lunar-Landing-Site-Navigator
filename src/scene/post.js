// Post: HDR → bloom → grade (desaturate, cool shadows, filmic curve) → vignette, grain, slight chromatic aberration → sRGB.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// Half-precision buffers occasionally produce Inf / NaN (a specular highlight on a smooth surface above 65504, then multiplied into NaN by bilinear sampling).
// Bloom turns one bad pixel into a black block hundreds of pixels across, so before bloom and grading, find them bitwise, zero them, then clamp
const SAFE = /* glsl */ `
  vec3 safeHdr(vec3 c, float hi) {
    bvec3 bad = equal(floatBitsToUint(c) & 0x7f800000u, uvec3(0x7f800000u));
    return mix(clamp(c, 0.0, hi), vec3(0.0), bad);
  }
`;

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
    uSat: { value: 0.45 },
    uContrast: { value: 1.2 },
    uTime: { value: 0 },
    // Grain, vignette and chromatic aberration are all kept low: the HUD sits on top of a clean, sharp base image
    uGrain: { value: 0.012 },
    uVignette: { value: 0.3 },
    uCA: { value: 0.0004 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uExposure, uSat, uTime, uGrain, uVignette, uCA, uContrast;
    uniform vec2 uRes;
    varying vec2 vUv;
    ${SAFE}

    // AgX approximation (Benjamin Wrensch's fit)
    vec3 agxContrast(vec3 x) {
      vec3 x2 = x * x, x4 = x2 * x2;
      return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
    }
    vec3 agx(vec3 c) {
      const mat3 inM = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                            0.0784335999999992, 0.878468636469772, 0.0784336,
                            0.0792237451477643, 0.0791661274605434, 0.879142973793104);
      const mat3 outM = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                             -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                             -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
      c = inM * c;
      c = clamp(log2(max(c, 1e-10)), -12.47393, 4.026069);
      c = (c + 12.47393) / 16.5;
      c = agxContrast(c);
      return outM * c;
    }
    float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec3 c;
      c.r = texture2D(tDiffuse, vUv - d * uCA * (1.0 + r2 * 4.0)).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv + d * uCA * (1.0 + r2 * 4.0)).b;
      c = safeHdr(c, 4096.0);
      c *= uExposure;
      c *= 1.0 - uVignette * smoothstep(0.08, 0.62, r2 * 1.6);

      c = agx(c);                                   // the output is already in display space (roughly sRGB)
      // cinematic contrast: stretched about a display-space mid-grey of 0.32, so shadows sit deeper and highlights read clearer
      vec3 lc = log2(max(c, 1e-4) / 0.32);
      c = 0.32 * exp2(lc * uContrast);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      vec3 cool = vec3(0.95, 0.99, 1.035), warm = vec3(1.015, 1.0, 0.985);
      c *= mix(cool, warm, smoothstep(0.15, 0.85, l));  // shadows toward cyan, highlights slightly warm
      c = c * 0.99 + 0.005;                         // the black level is barely lifted, so space stays pure black

      float g = h(vUv * uRes + fract(uTime) * 917.0) - 0.5;
      c += g * uGrain * (0.6 + 0.4 * (1.0 - l));
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

export function createPost(renderer, scene, camera) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  // Bloom for the sun disc only: small radius, high threshold, so lit slopes and the horizon do not haze over
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.32, 0.35, 1.4);
  // Bloom's bright-pass: zero bad pixels, cap a single pixel at 64, so one highlight does not smear into a large blob
  const hp = bloom.materialHighPassFilter;
  hp.fragmentShader = hp.fragmentShader
    .replace('varying vec2 vUv;', `varying vec2 vUv;\n${SAFE}`)
    .replace('vec4 texel = texture2D( tDiffuse, vUv );', 'vec4 texel = texture2D( tDiffuse, vUv );\n\t\t\ttexel = vec4( safeHdr( texel.rgb, 64.0 ), 1.0 );');
  if (!hp.fragmentShader.includes('safeHdr( texel')) throw new Error('bloom high-pass patch failed');
  composer.addPass(bloom);
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  function resize(w, h, pr) {
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    grade.uniforms.uRes.value.set(w * pr, h * pr);
  }

  return { composer, bloom, grade, resize };
}
