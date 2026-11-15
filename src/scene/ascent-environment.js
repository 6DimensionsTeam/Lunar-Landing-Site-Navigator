// Static launch-site atmosphere, informed by NASA coastal imagery.
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
  const uniforms = { altitude: { value: 0 }, sun: { value: sun } };
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
    group,
    update({ camera }) { sky.position.copy(camera.position); }
  };
}
