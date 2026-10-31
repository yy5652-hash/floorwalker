// The film's motif, in WebGL on white: money moves are thin streams of coloured light flying through a gate. Legitimate ones pass; attacks (red) shatter on it.
// Everything is a pure function of the scene clock, so any frame can be rendered on its own.
import * as THREE from './vendor/three.module.min.js';

const RED = new THREE.Color('#e8123f');
// Output is premultiplied, so the lines blend the same over white and over a photograph.
const BLEND = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor };
const PRISM = `
  vec3 prism(float t) {
    vec3 a = vec3(0.0, 0.72, 0.85), b = vec3(0.43, 0.24, 0.96), c = vec3(0.94, 0.15, 0.56), d = vec3(0.96, 0.58, 0.0);
    t = fract(t) * 4.0;
    if (t < 1.0) return mix(a, b, t);
    if (t < 2.0) return mix(b, c, t - 1.0);
    if (t < 3.0) return mix(c, d, t - 2.0);
    return mix(d, a, t - 3.0);
  }`;
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

export function stage(canvas, { alpha = false, fov = 38 } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); renderer.setSize(1920, 1080, false);
  renderer.setClearColor(0xffffff, alpha ? 0 : 1);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 600);
  return { renderer, scene, camera, draw: () => renderer.render(scene, camera) };
}

const STREAM_VS = `${PRISM}
  attribute vec4 aSeed; attribute vec2 aKind;
  uniform float uT, uR, uLeak, uNear, uFar, uOn, uGate;
  varying float vA; varying vec3 vC;
  uniform vec3 uRed;
  void main() {
    float s = fract(aSeed.w + aSeed.z * uT);
    float head = aKind.y, attack = aKind.x;
    float len = 1.2 + 3.5 * aSeed.z * 30.0;
    float z = mix(-uFar, uNear, s) - (1.0 - head) * len;
    float blocked = attack * (1.0 - step(aSeed.x * 3.0 - floor(aSeed.x * 3.0), uLeak));
    float r = aSeed.y * uR * 0.86 * (1.0 + max(0.0, -z) / 70.0);
    float a = aSeed.x * 6.2831853;
    vec3 p = vec3(cos(a) * r, sin(a) * r, z);
    float alpha = smoothstep(0.0, 0.12, s) * (1.0 - smoothstep(0.82, 1.0, s));
    if (blocked > 0.5 && uGate > 0.5 && z > 0.0) {
      // Shatter on the gate: thrown outwards along the ring, gone within a short distance.
      float k = z / uNear;
      float spread = k * (6.0 + 22.0 * fract(aSeed.x * 37.0));
      p = vec3(cos(a) * (r + spread), sin(a) * (r + spread), -k * 5.0 * (1.0 - head * 0.5));
      alpha *= max(0.0, 1.0 - k * 3.6);
    }
    vA = alpha * uOn * (0.12 + 0.88 * head);
    vC = mix(prism(aSeed.x + aSeed.y * 0.2), uRed, attack);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;
const STREAM_FS = `varying float vA; varying vec3 vC; void main() { gl_FragColor = vec4(vC * vA, vA); }`;

export function streams({ count = 2600, attackShare = 0.2, R = 9, leak = 0, near = 46, far = 150, gate = true, speed = 1 }) {
  const seeds = new Float32Array(count * 8), kinds = new Float32Array(count * 4), pos = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const s = [rnd(), Math.sqrt(rnd()), (0.018 + rnd() * 0.05) * speed, rnd()], attack = rnd() < attackShare ? 1 : 0;
    seeds.set(s, i * 8); seeds.set(s, i * 8 + 4);
    kinds.set([attack, 0, attack, 1], i * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  g.setAttribute('aKind', new THREE.BufferAttribute(kinds, 2));
  const m = new THREE.ShaderMaterial({
    vertexShader: STREAM_VS, fragmentShader: STREAM_FS, ...BLEND,
    uniforms: { uT: { value: 0 }, uR: { value: R }, uLeak: { value: leak }, uNear: { value: near }, uFar: { value: far }, uOn: { value: 1 }, uGate: { value: gate ? 1 : 0 }, uRed: { value: RED } },
  });
  const lines = new THREE.LineSegments(g, m);
  lines.frustumCulled = false;
  return { object: lines, set(t, on = 1) { m.uniforms.uT.value = t; m.uniforms.uOn.value = on; } };
}

const RING_FS = `${PRISM}
  uniform float uT, uOn, uHit; uniform vec3 uRed; varying vec2 vUv;
  float arcs(float a, float n, float duty) { return step(fract(a * n), duty); }
  void main() {
    vec2 p = (vUv - 0.5) * 2.0; float d = length(p), a = atan(p.y, p.x) / 6.2831853 + 0.5;
    float main = exp(-abs(d - 0.72) * 210.0);
    float halo = exp(-abs(d - 0.72) * 26.0) * 0.16;
    float outer = exp(-abs(d - 0.8) * 420.0) * arcs(a + uT * 0.021, 3.0, 0.72) * 0.8;
    float ticks = exp(-abs(d - 0.86) * 190.0) * arcs(a - uT * 0.012, 72.0, 0.28) * 0.55;
    float inner = exp(-abs(d - 0.655) * 400.0) * arcs(a - uT * 0.034, 5.0, 0.6) * 0.7;
    float al = clamp(main + halo + outer + ticks + inner, 0.0, 1.0) * uOn * smoothstep(1.0, 0.92, d);
    vec3 c = mix(prism(a + uT * 0.03), uRed, clamp(uHit, 0.0, 1.0));
    gl_FragColor = vec4(c * al, al);
  }`;

export function ring({ R = 9 }) {
  const size = (R / 0.72) * 2;
  const m = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: RING_FS,
    ...BLEND, side: THREE.DoubleSide,
    uniforms: { uT: { value: 0 }, uOn: { value: 1 }, uHit: { value: 0 }, uRed: { value: RED } },
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), m);
  return { object: mesh, set(t, on = 1, hit = 0) { m.uniforms.uT.value = t; m.uniforms.uOn.value = on; m.uniforms.uHit.value = hit; } };
}

export function floor({ y = -14, size = 320, step = 8 }) {
  const pts = [];
  for (let v = -size; v <= size; v += step) pts.push(v, y, -size, v, y, size, -size, y, v, size, y, v);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  const m = new THREE.ShaderMaterial({
    vertexShader: 'varying float vD; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = length(mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform float uOn; varying float vD; void main() { float a = uOn * 0.3 * smoothstep(170.0, 20.0, vD); gl_FragColor = vec4(vec3(0.55, 0.65, 0.78) * a, a); }',
    ...BLEND, uniforms: { uOn: { value: 1 } },
  });
  const lines = new THREE.LineSegments(g, m);
  lines.frustumCulled = false;
  return { object: lines, set(on = 1) { m.uniforms.uOn.value = on; } };
}

export function dust({ count = 900, spread = 220 }) {
  const pos = new Float32Array(count * 3), size = new Float32Array(count);
  for (let i = 0; i < count; i++) { pos.set([(rnd() - 0.5) * spread, (rnd() - 0.5) * spread * 0.6, -rnd() * spread], i * 3); size[i] = 1 + rnd() * 3; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aS', new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({
    vertexShader: `${PRISM} attribute float aS; uniform float uT; varying vec3 vC; void main() { vec3 p = position; p.y += sin(uT * 0.2 + position.x) * 1.5; p.z = mod(p.z + uT * 2.0, 220.0) - 220.0 + 30.0; vC = prism(position.x * 0.013); vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_PointSize = aS * 42.0 / -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: 'varying vec3 vC; void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.2, d) * 0.45; gl_FragColor = vec4(vC * a, a); }',
    ...BLEND, uniforms: { uT: { value: 0 } },
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return { object: pts, set(t) { m.uniforms.uT.value = t; } };
}
