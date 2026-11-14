// Earth and Sun. Both sit at a "proxy distance" within 2000 km, scaled to their true angular size, so they stay inside the camera's far plane.
import * as THREE from 'three';

const PROXY = 2000;   // km

const earthVert = /* glsl */ `
out vec3 vN;
out vec2 vUv;
out vec3 vW;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const earthFrag = /* glsl */ `
uniform sampler2D uDay, uNight;
uniform vec3 uSunDir;
uniform float uGain;
in vec3 vN;
in vec2 vUv;
in vec3 vW;
out vec4 outColor;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float ndl = dot(N, uSunDir);
  float day = smoothstep(-0.06, 0.12, ndl);
  vec3 c = texture(uDay, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 0.55) * vec3(0.92, 0.98, 1.05);        // desaturated, cool
  vec3 col = c * max(ndl, 0.0) * uGain;
  float lights = texture(uNight, vUv).r;
  col += vec3(1.0, 0.78, 0.5) * lights * lights * (1.0 - day) * 0.02 * uGain;
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += vec3(0.35, 0.6, 1.0) * rim * smoothstep(-0.25, 0.35, ndl) * 0.9 * uGain;
  outColor = vec4(col, 1.0);
}
`;

const sunFrag = /* glsl */ `
uniform float uCoreR;        // solar disc radius (as a fraction of the quad width)
uniform float uI;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float core = smoothstep(uCoreR * 1.04, uCoreR * 0.96, r);
  float limb = sqrt(max(1.0 - (r / uCoreR) * (r / uCoreR), 0.0));
  float glare = exp(-r / (uCoreR * 1.3)) * 0.35 + exp(-r / (uCoreR * 5.0)) * 0.06;
  float streak = exp(-abs(p.y) / (uCoreR * 0.08)) * exp(-abs(p.x) * 2.2) * 0.25;
  float edge = smoothstep(1.0, 0.85, r) * smoothstep(1.0, 0.9, abs(p.x)) ;
  vec3 col = vec3(1.0, 0.97, 0.92) * (core * (0.55 + 0.45 * limb) * 60.0 + glare * 3.0 + streak * 2.0);
  outColor = vec4(col * uI * edge, 1.0);
}
`;

const sunVert = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export function createBodies(data) {
  const loader = new THREE.TextureLoader();
  const day = loader.load(data.earthDayUrl);
  day.colorSpace = THREE.SRGBColorSpace;
  day.anisotropy = 4;
  const night = loader.load(data.earthNightUrl);

  const earthU = {
    uDay: { value: day }, uNight: { value: night },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uGain: { value: 3.6 },
  };
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 128, 64),
    new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: earthVert, fragmentShader: earthFrag, uniforms: earthU }),
  );
  earth.frustumCulled = false;

  const sunU = { uCoreR: { value: 0.035 }, uI: { value: 1.0 } };
  const sun = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: sunVert, fragmentShader: sunFrag, uniforms: sunU,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }),
  );
  sun.frustumCulled = false;
  sun.renderOrder = 5;

  const tmp = new THREE.Vector3();
  function update(camera, eph) {
    // Earth: the true direction and angular radius as seen from the camera (including topocentric parallax)
    tmp.copy(eph.earthPos).sub(camera.position);
    const dist = tmp.length();
    const dir = tmp.divideScalar(dist);
    const ang = Math.asin(6371.0 / dist);
    earth.position.copy(camera.position).addScaledVector(dir, PROXY);
    earth.scale.setScalar(PROXY * Math.tan(ang));
    earth.quaternion.copy(eph.earthRot);
    earthU.uSunDir.value.copy(eph.sunDir);

    // Sun: solar disc angular radius 0.2666°; the quad is drawn 1/uCoreR times larger than the disc to hold the glare
    const sunAng = THREE.MathUtils.degToRad(0.2666);
    const size = (PROXY * Math.tan(sunAng)) / sunU.uCoreR.value;
    sun.position.copy(camera.position).addScaledVector(eph.sunDir, PROXY);
    sun.quaternion.copy(camera.quaternion);
    sun.scale.setScalar(size);
  }

  return { earth, sun, update, earthU, sunU };
}
