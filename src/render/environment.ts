// Sunset arena surroundings: gradient sky with sun, fog, glowing grid floor,
// low-poly mountains and towers. All procedural.

import * as THREE from 'three';
import { mulberry32 } from '../game/math';
import { trackSdf, type Track } from '../game/track';

export const PALETTE = {
  skyTop: new THREE.Color('#120a2a'),
  skyMid: new THREE.Color('#4b1d5c'),
  horizon: new THREE.Color('#ff7a59'),
  sun: new THREE.Color('#ffc36b'),
  fog: new THREE.Color('#3b1b45'),
  ground: new THREE.Color('#130d22'),
  grid: new THREE.Color('#ff4fa3'),
  cyan: new THREE.Color('#38e8ff'),
  amber: new THREE.Color('#ffb347'),
  magenta: new THREE.Color('#ff3ea5'),
};

export const SUN_DIR = new THREE.Vector3(0.3, 0.1, 0.95).normalize();

export function createSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1400, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: PALETTE.skyTop },
      mid: { value: PALETTE.skyMid },
      horizon: { value: PALETTE.horizon },
      sunColor: { value: PALETTE.sun },
      sunDir: { value: SUN_DIR },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 sunColor; uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 col = mix(horizon, mid, smoothstep(-0.02, 0.22, h));
        col = mix(col, top, smoothstep(0.2, 0.75, h));
        col = mix(col, horizon * 0.35, smoothstep(0.0, -0.2, h));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        col += sunColor * pow(s, 18.0) * 0.55;
        // Sun disk with retro stripes.
        float disk = smoothstep(0.9965, 0.9975, s);
        float stripes = step(0.5, fract((vDir.y - sunDir.y) * 120.0)) + step(0.0, vDir.y - sunDir.y + 0.006);
        col = mix(col, sunColor * 1.15, disk * clamp(stripes, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

export function createGround(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(3000, 3000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      base: { value: PALETTE.ground },
      grid: { value: PALETTE.grid },
      fogColor: { value: PALETTE.fog },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vDepth;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vec4 mv = viewMatrix * w;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 base; uniform vec3 grid; uniform vec3 fogColor;
      varying vec3 vWorld; varying float vDepth;
      float line(float coord, float width) {
        float d = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
        return 1.0 - min(d / width, 1.0);
      }
      void main() {
        vec2 c = vWorld.xz / 12.0;
        float g = max(line(c.x, 1.0), line(c.y, 1.0));
        vec2 c2 = vWorld.xz / 60.0;
        float g2 = max(line(c2.x, 1.4), line(c2.y, 1.4));
        float fade = 1.0 - smoothstep(80.0, 520.0, vDepth);
        vec3 col = base + grid * (g * 0.22 + g2 * 0.35) * fade;
        float f = smoothstep(120.0, 900.0, vDepth);
        col = mix(col, fogColor, f);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  // fwidth needs derivatives (WebGL2 has them by default).
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.02;
  return mesh;
}

/** Mountains ring, towers and infield structures. */
export function createScenery(track: Track, detail: number): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(1337);
  const cx = 80;
  const cz = 15;

  // Mountains: low-poly cones on a distant ring.
  const mountainMat = new THREE.MeshLambertMaterial({ color: 0x2a1538, flatShading: true });
  const coneGeo = new THREE.ConeGeometry(1, 1, 5, 1);
  const mCount = Math.round(48 * detail);
  const mountains = new THREE.InstancedMesh(coneGeo, mountainMat, mCount);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < mCount; i++) {
    const a = (i / mCount) * Math.PI * 2 + rand() * 0.1;
    const r = 620 + rand() * 260;
    const h = 60 + rand() * 170;
    const w = 90 + rand() * 120;
    p.set(cx + Math.cos(a) * r, h / 2 - 2, cz + Math.sin(a) * r);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI);
    s.set(w, h, w * (0.7 + rand() * 0.6));
    m.compose(p, q, s);
    mountains.setMatrixAt(i, m);
  }
  group.add(mountains);

  // Towers: tall boxes with glowing caps around the arena and in the infield.
  const sdf = { d: 0, nx: 0, nz: 0 };
  const towerGeo = new THREE.BoxGeometry(1, 1, 1);
  const towerMat = new THREE.MeshLambertMaterial({ color: 0x241c3a, flatShading: true });
  const capMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const tCount = Math.round(70 * detail);
  const towers = new THREE.InstancedMesh(towerGeo, towerMat, tCount);
  const caps = new THREE.InstancedMesh(towerGeo, capMat, tCount);
  const capColors = [PALETTE.cyan, PALETTE.magenta, PALETTE.amber];
  let placed = 0;
  let guard = 0;
  while (placed < tCount && guard++ < 4000) {
    const infield = rand() < 0.3;
    let x: number;
    let z: number;
    if (infield) {
      x = 30 + rand() * 110;
      z = -130 + rand() * 250;
    } else {
      const a = rand() * Math.PI * 2;
      const r = 250 + rand() * 230;
      x = cx + Math.cos(a) * r;
      z = cz + Math.sin(a) * r;
    }
    trackSdf(track, x, z, sdf);
    const w = 6 + rand() * 12;
    if (sdf.d < w + 10) continue;
    const h = infield ? 8 + rand() * 26 : 20 + rand() * 90;
    p.set(x, h / 2, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI);
    s.set(w, h, w * (0.6 + rand() * 0.8));
    m.compose(p, q, s);
    towers.setMatrixAt(placed, m);
    p.set(x, h + 0.4, z);
    s.set(w * 1.02, 0.8, s.z * 1.02);
    m.compose(p, q, s);
    caps.setMatrixAt(placed, m);
    caps.setColorAt(placed, capColors[placed % 3]);
    placed++;
  }
  towers.count = placed;
  caps.count = placed;
  group.add(towers, caps);

  // Grandstand along the start straight (outside the left wall).
  const standMat = new THREE.MeshLambertMaterial({ color: 0x30264a, flatShading: true });
  for (let i = 0; i < 4; i++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(6, 2 + i * 2.2, 120), standMat);
    step.position.set(-20 - i * 6, (2 + i * 2.2) / 2, -60);
    group.add(step);
  }
  const banner = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.2, 120), new THREE.MeshBasicMaterial({ color: PALETTE.magenta }));
  banner.position.set(-16.5, 2.4, -60);
  group.add(banner);

  return group;
}

export function createLights(): THREE.Object3D[] {
  const hemi = new THREE.HemisphereLight(0x8a6bd1, 0xff7a4a, 1.35);
  const sun = new THREE.DirectionalLight(0xffb27a, 2.2);
  sun.position.copy(SUN_DIR).multiplyScalar(100);
  const ambient = new THREE.AmbientLight(0x2a1f4a, 0.6);
  return [hemi, sun, ambient];
}
