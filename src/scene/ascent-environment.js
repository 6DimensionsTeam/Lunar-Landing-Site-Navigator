// Procedural atmospheric presentation, informed by NASA ascent photography.
// Cloud placement is an illustrative weather layer, not a forecast for the selected date.
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const noiseGLSL = `
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){return .55*noise(p)+.27*noise(p*2.07)+.12*noise(p*4.19)+.06*noise(p*8.31);}`;

// Four optically shaded cloud impostors: rounded lobes, detailed boundaries and dark bases.
// The expensive density work happens once, not in each rendered frame.
function makeCloudAtlas(T, resources) {
  const tile = 256, height = 192, canvas = document.createElement('canvas');
  canvas.width = tile * 2; canvas.height = height * 2;
  const context = canvas.getContext('2d'), image = context.createImageData(canvas.width, canvas.height);
  let seed = 729141;
  const random = () => ((seed = seed * 16807 % 2147483647) - 1) / 2147483646;
  const hash = (x, y) => { const a = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return a - Math.floor(a); };
  const noise = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y); let a = x - ix, b = y - iy;
    a = a * a * (3 - 2 * a); b = b * b * (3 - 2 * b);
    return (hash(ix, iy) * (1 - a) + hash(ix + 1, iy) * a) * (1 - b) + (hash(ix, iy + 1) * (1 - a) + hash(ix + 1, iy + 1) * a) * b;
  };
  for (let variant = 0; variant < 4; variant++) {
    const lobes = [];
    // Broad connected base, with smaller cauliflower towers above it.
    for (let i = 0; i < 28; i++) {
      const x = .13 + random() * .74, radius = .07 + random() * .12;
      lobes.push({ x, y: .55 - Math.sin((x - .1) / .8 * Math.PI) * (.08 + random() * .15), rx: radius, ry: radius * (1.05 + random() * .6), z: random() * .16 });
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < tile; x++) {
      const u = x / tile, v = y / height;
      const n = noise(u * 47 + variant * 19, v * 39) * .55 + noise(u * 103, v * 91 + variant * 17) * .3 + noise(u * 217, v * 199) * .15;
      let front = -1, normalX = 0, normalY = 0, normalWeight = 0, depth = 0;
      for (const l of lobes) {
        const dx = (u - l.x) / l.rx, dy = (v - l.y) / l.ry;
        const q = 1 - dx * dx - dy * dy - (n - .5) * .23;
        if (q <= 0) continue;
        const z = Math.sqrt(q), d = z * l.rx;
        depth += d;
        const weight = Math.exp((d + l.z) * 18) * z;
        normalX += dx * weight; normalY -= dy * weight; normalWeight += weight;
        front = Math.max(front, d + l.z);
      }
      if (front < 0) continue;
      const edge = smooth(0, .028, depth), bottom = 1 - smooth(.62, .72, v);
      const tileEdge = smooth(0, .045, u) * smooth(0, .045, 1-u) * smooth(0, .035, v) * smooth(0, .035, 1-v);
      const alpha = edge * bottom * tileEdge * (1 - Math.exp(-depth * 13));
      const lit = clamp(.81 + normalY / normalWeight * .12 - normalX / normalWeight * .06 + (n - .5) * .18 - smooth(.36, .66, v) * .19, .48, .99);
      const i = (((variant >> 1) * height + y) * canvas.width + (variant % 2) * tile + x) * 4;
      image.data[i] = Math.round(255 * lit); image.data[i + 1] = Math.round(255 * Math.min(1, lit * 1.025)); image.data[i + 2] = Math.round(255 * Math.min(1, lit * 1.055)); image.data[i + 3] = Math.round(255 * alpha);
    }
  }
  context.putImageData(image, 0, 0);
  const map = new T.CanvasTexture(canvas); map.colorSpace = T.SRGBColorSpace;
  resources?.add(map); return map;
}

export function createAscentEnvironment({ T, sunDirection, resources, terrainMap = null }) {
  const group = new T.Group(); group.name = 'Atmosphere and cloud decks';
  const cloudMap = makeCloudAtlas(T, resources), sun = sunDirection || new T.Vector3(-.4, .7, .4);
  const smokeMap = cloudMap.clone(); smokeMap.repeat.set(.5, .5); smokeMap.offset.set(0, 0); resources?.add(smokeMap);
  const uniforms = { altitude: { value: 0 }, time: { value: 0 }, sun: { value: sun }, inside: { value: 0 } };
  const sky = new T.Mesh(new T.SphereGeometry(2000, 24, 16), new T.ShaderMaterial({
    uniforms, side: T.BackSide, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec3 ray;void main(){ray=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform float altitude;uniform vec3 sun;varying vec3 ray;void main(){
      vec3 r=normalize(ray);float air=exp(-max(altitude,0.)/19000.);float horizon=pow(1.-max(r.y,0.),5.);
      float day=smoothstep(-.12,.2,sun.y);float sunGlow=pow(max(0.,dot(r,normalize(sun))),16.);
      vec3 zenith=mix(vec3(.001,.003,.008),vec3(.035,.19,.42),air);
      vec3 pale=mix(vec3(.58,.71,.82),vec3(.09,.29,.62),smoothstep(11000.,32000.,altitude))*sqrt(air);vec3 color=mix(zenith,pale,horizon*.88)+vec3(.2,.15,.075)*sunGlow*air;
      gl_FragColor=vec4(color*mix(.17,1.,day),1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`
  })); sky.renderOrder = -100; group.add(sky);

  const count = 192, geometry = new T.PlaneGeometry(1, 1), tileIds = new Float32Array(count), shades = new Float32Array(count);
  geometry.setAttribute('cloudTile', new T.InstancedBufferAttribute(tileIds, 1));
  geometry.setAttribute('cloudShade', new T.InstancedBufferAttribute(shades, 1));
  const clouds = new T.InstancedMesh(geometry, new T.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { atlas: { value: cloudMap }, sun: { value: sun } },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float cloudTile;attribute float cloudShade;varying vec2 atlasUv;varying float distanceToCloud;varying float shade;
      void main(){vec4 p=modelViewMatrix*instanceMatrix*vec4(0.,0.,0.,1.);distanceToCloud=length(p.xyz);
      p.xy+=position.xy*vec2(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz));
      atlasUv=(uv+vec2(mod(cloudTile,2.),floor(cloudTile/2.)))*.5;shade=cloudShade;gl_Position=projectionMatrix*p;
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
      uniform sampler2D atlas;uniform vec3 sun;varying vec2 atlasUv;varying float distanceToCloud;varying float shade;
      void main(){
      #include <logdepthbuf_fragment>
      vec4 c=texture2D(atlas,atlasUv);if(c.a<.015)discard;float day=smoothstep(-.12,.2,sun.y);
      float haze=1.-exp(-distanceToCloud/24000.);vec3 color=mix(c.rgb*shade,vec3(.49,.65,.79),haze*.68)*mix(.13,1.05,day);
      gl_FragColor=vec4(color,c.a*smoothstep(90.,650.,distanceToCloud));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`
  }), count);
  let seed = 188713; const random = () => ((seed = seed * 16807 % 2147483647) - 1) / 2147483646;
  const transform = new T.Object3D();
  for (let i = 0; i < count; i++) {
    const upper = i >= 136, j = upper ? i - 136 : i;
    const x = (j % 14 - 6.5) * 1550 + (random() - .5) * 650 + (upper ? 2200 : 400);
    let z = (Math.floor(j / 14) - (upper ? 2 : 4.5)) * 1550 + (random() - .5) * 650;
    if (upper && x > 500 && x < 3800 && Math.abs(z) < 900) z -= 1700;
    transform.position.set(x, (upper ? 6200 : 2200) + (random() - .5) * (upper ? 300 : 650), z);
    transform.scale.set(1600 + random() * 1400, upper ? 450 + random() * 450 : 900 + random() * 900, 1); transform.updateMatrix(); clouds.setMatrixAt(i, transform.matrix);
    tileIds[i] = i % 4; shades[i] = .88 + random() * .13;
  }
  clouds.frustumCulled = false; clouds.renderOrder = 10; group.add(clouds);

  // A thin camera-space mist models the loss of contrast while physically crossing a deck.
  const mist = new T.Mesh(new T.PlaneGeometry(2, 2), new T.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, depthTest: false,
    vertexShader: 'varying vec2 p;void main(){p=uv;gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader: `${noiseGLSL}
      uniform float inside;uniform float time;uniform vec3 sun;varying vec2 p;
      void main(){float n=fbm(p*5.+vec2(time*.08,-time*.14));float day=smoothstep(-.12,.2,sun.y);
      gl_FragColor=vec4(vec3(.74,.8,.84)*mix(.2,1.,day),inside*(.65+n*.35));}`
  })); mist.frustumCulled = false; mist.renderOrder = 9000; group.add(mist);

  // Local coastal context is deliberately illustrative unless a supplied satellite image is used.
  const groundGeometry = new T.PlaneGeometry(160000, 160000, 80, 80);
  groundGeometry.rotateX(-Math.PI / 2);
  const points = groundGeometry.attributes.position;
  for (let i = 0; i < points.count; i++) { const x = points.getX(i), z = points.getZ(i); points.setY(i, 6 - (x*x+z*z)/(2*6371000)); }
  groundGeometry.computeVertexNormals();
  const ground = new T.Mesh(groundGeometry, new T.ShaderMaterial({
    uniforms: { sun: { value: sun }, altitude: uniforms.altitude, terrainMap: { value: terrainMap }, hasMap: { value: !!terrainMap } }, transparent: true,
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 p;varying vec2 terrainUv;varying float d;
      void main(){p=position.xz;terrainUv=uv;vec4 q=modelViewMatrix*vec4(position,1.);d=length(q.xyz);gl_Position=projectionMatrix*q;
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
      ${noiseGLSL}
      uniform vec3 sun;uniform float altitude;uniform sampler2D terrainMap;uniform bool hasMap;varying vec2 p;varying vec2 terrainUv;varying float d;
      void main(){
      #include <logdepthbuf_fragment>
      float coast=750.-p.y*.58+sin(p.y*.00009)*230.;float land=1.-smoothstep(coast-80.,coast+80.,p.x);
      float terrain=fbm(p*.0007);float marsh=fbm(p*.00015+vec2(17.,8.));float channels=1.-smoothstep(.02,.06,abs(marsh-.5));
      vec3 ocean=mix(vec3(.025,.12,.2),vec3(.055,.22,.27),exp(-abs(p.x-coast)/7000.));
      vec3 soil=mix(vec3(.065,.105,.055),vec3(.18,.22,.12),terrain);soil=mix(soil,vec3(.035,.1,.11),channels*.7);
      vec3 c=mix(ocean,soil,land);float surf=exp(-abs(p.x-coast)/55.);c+=vec3(.15,.17,.15)*surf;
      if(hasMap){vec2 localUv=vec2(p.x,-p.y)/14000.+vec2(.46,.80);float border=smoothstep(0.,.06,min(min(localUv.x,localUv.y),min(1.-localUv.x,1.-localUv.y)));c=mix(c,texture2D(terrainMap,clamp(localUv,0.,1.)).rgb,border);}
      float day=smoothstep(-.12,.2,sun.y);c*=mix(.08,.92,day);float haze=1.-exp(-d/32000.);c=mix(c,vec3(.36,.51,.65)*mix(.12,1.,day),haze*.72*exp(-altitude/9000.));
      float edge=1.-smoothstep(60000.,79000.,max(abs(p.x),abs(p.y)));
      float padHole=mix(smoothstep(850.,1200.,length(p)),1.,smoothstep(250.,650.,altitude));
      gl_FragColor=vec4(c,edge*padHole*(1.-smoothstep(50000.,110000.,altitude)));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`
  })); group.add(ground);
  return {
    group, cloudMap, smokeMap,
    update({ altitude, position, camera, time = 0 }) {
      uniforms.altitude.value = altitude; uniforms.time.value = time;
      sky.position.copy(camera.position); clouds.visible = altitude < 35000;
      const h = camera.position.y;
      const low = Math.exp(-Math.pow((h - 2200) / 210, 2)), high = Math.exp(-Math.pow((h - 6200) / 160, 2));
      uniforms.inside.value = Math.max(low, high * .55) * .62;
      mist.visible = uniforms.inside.value > .003; ground.visible = altitude < 110000;
    }
  };
}

// Instanced expanding exhaust: bright inner flow, turbulent edges, two draw calls for six engines.
export function createExhaust({ T, engines }) {
  const group = new T.Group(); group.name = 'Expanding rocket exhaust';
  const geometry = new T.PlaneGeometry(1, 1, 1, 24);
  const boosters = new Float32Array(engines.length), radii = new Float32Array(engines.length);
  geometry.setAttribute('booster', new T.InstancedBufferAttribute(boosters, 1));
  geometry.setAttribute('nozzleRadius', new T.InstancedBufferAttribute(radii, 1));
  const uniforms = { time: { value: 0 }, expansion: { value: 1 }, corePower: { value: 1 }, boosterPower: { value: 1 }, halo: { value: 0 } };
  const material = new T.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, side: T.DoubleSide, forceSinglePass: true,
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float booster;attribute float nozzleRadius;uniform float time;uniform float expansion;uniform float halo;
      varying vec2 p;varying float solid;
      void main(){p=uv;solid=booster;float t=1.-uv.y;float spread=1.+t*(1.6+expansion*.75);
      vec4 q=modelViewMatrix*instanceMatrix*vec4(0.,0.,0.,1.);
      vec3 axis=normalize(mat3(modelViewMatrix)*vec3(0.,-1.,0.));vec3 across=cross(axis,vec3(0.,0.,1.));across=length(across)>.0001?normalize(across):vec3(1.,0.,0.);
      q.xyz+=axis*t*mix(70.,125.,booster)*(1.+expansion*.08);
      q.xyz+=across*position.x*nozzleRadius*2.*spread*(1.+halo*.55);
      gl_Position=projectionMatrix*q;
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
      ${noiseGLSL}
      uniform float time;uniform float corePower;uniform float boosterPower;uniform float halo;varying vec2 p;varying float solid;
      void main(){
      #include <logdepthbuf_fragment>
      float t=1.-p.y;float turbulence=fbm(vec2(p.x*8.,t*27.-time*9.));
      float waviness=(noise(vec2(t*16.-time*7.,time*.4))-.5)*t*.65;
      float r=abs(p.x*2.-1.+waviness);float edge=1.-smoothstep(.15,1.,r);
      float breakup=mix(1.,smoothstep(.28,.65,turbulence),smoothstep(.08,.95,t));
      float fade=pow(max(0.,1.-t),1.35)*smoothstep(0.,.035,p.y);
      float hot=exp(-r*r*13.)*(1.-smoothstep(.05,.8,t));
      vec3 tail=mix(vec3(.21,.43,.88),vec3(1.,.29,.045),solid);
      vec3 color=mix(tail,vec3(1.,.97,.85),clamp(hot+.38*(1.-t),0.,1.));
      float alpha=edge*fade*breakup*(.7+.3*turbulence)*mix(corePower,boosterPower,solid)*mix(.94,.18,halo);
      if(alpha<.003)discard;gl_FragColor=vec4(color,alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`
  });
  const flow = new T.InstancedMesh(geometry, material, engines.length), haloMaterial = material.clone();
  haloMaterial.uniforms = { ...uniforms, halo: { value: 1 } };
  haloMaterial.blending = T.AdditiveBlending;
  const glow = new T.InstancedMesh(geometry, haloMaterial, engines.length), transform = new T.Object3D();
  for (let i = 0; i < engines.length; i++) {
    transform.position.copy(engines[i]); transform.updateMatrix(); flow.setMatrixAt(i, transform.matrix); glow.setMatrixAt(i, transform.matrix);
    boosters[i] = engines[i].userData.booster ? 1 : 0; radii[i] = engines[i].userData.radius;
  }
  flow.frustumCulled = glow.frustumCulled = false; group.add(glow, flow);
  return { group, update({ time = 0, altitude = 0, core = 1, boosters: power = 1, expansion = 1 }) {
    uniforms.time.value = time; uniforms.expansion.value = Math.min(2.7, expansion); uniforms.corePower.value = core; uniforms.boosterPower.value = power;
  } };
}
