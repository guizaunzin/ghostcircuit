// Arena surroundings: gradient sky with sun/moon, fog, glowing grid floor,
// low-poly mountains, towers and a grandstand. All procedural and themed.

import * as THREE from 'three';
import { mulberry32 } from '../game/math';
import { trackSdf, type Track } from '../game/track';
import type { Theme } from './themes';

/** Colors shared by every theme (player/ghost identity). */
export const PALETTE = {
  ghost: new THREE.Color('#4ff3ff'),
};

/** Sun direction for a track: placed relative to the start heading. */
export function sunDirection(track: Track, theme: Theme): THREE.Vector3 {
  const yaw = track.start.yaw + theme.sunAzimuth;
  const y = theme.sunElevation;
  const h = Math.sqrt(1 - y * y);
  return new THREE.Vector3(Math.sin(yaw) * h, y, Math.cos(yaw) * h).normalize();
}

/** Center and radius of the area covered by the track. */
export function trackBounds(track: Track): { cx: number; cz: number; radius: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const c of track.corridors)
    for (const p of c.points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  return { cx, cz, radius: Math.hypot(maxX - minX, maxZ - minZ) / 2 };
}

export function createSky(theme: Theme, sunDir: THREE.Vector3): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1400, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(theme.skyTop) },
      mid: { value: new THREE.Color(theme.skyMid) },
      horizon: { value: new THREE.Color(theme.horizon) },
      sunColor: { value: new THREE.Color(theme.sun) },
      sunDir: { value: sunDir },
      glow: { value: theme.sunGlow },
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
      uniform float glow;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 col = mix(horizon, mid, smoothstep(-0.02, 0.22, h));
        col = mix(col, top, smoothstep(0.2, 0.75, h));
        col = mix(col, horizon * 0.35, smoothstep(0.0, -0.2, h));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        col += sunColor * pow(s, 18.0) * glow;
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

export function createGround(theme: Theme, cx: number, cz: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(3000, 3000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      base: { value: new THREE.Color(theme.ground) },
      grid: { value: new THREE.Color(theme.grid) },
      fogColor: { value: new THREE.Color(theme.fog) },
      fogFar: { value: theme.fogFar },
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
      uniform vec3 base; uniform vec3 grid; uniform vec3 fogColor; uniform float fogFar;
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
        float fade = 1.0 - smoothstep(80.0, fogFar * 0.6, vDepth);
        vec3 col = base + grid * (g * 0.22 + g2 * 0.35) * fade;
        float f = smoothstep(fogFar * 0.13, fogFar, vDepth);
        col = mix(col, fogColor, f);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, -0.02, cz);
  return mesh;
}

/** Mountains ring, towers and a grandstand by the start straight. */
export function createScenery(track: Track, detail: number, theme: Theme): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(1337 + (track.seed ?? 0));
  const { cx, cz, radius } = trackBounds(track);

  // Mountains: low-poly cones on a distant ring.
  const mountainMat = new THREE.MeshLambertMaterial({ color: theme.mountain, flatShading: true });
  const coneGeo = new THREE.ConeGeometry(1, 1, 5, 1);
  const mCount = Math.round(48 * detail);
  const mountains = new THREE.InstancedMesh(coneGeo, mountainMat, mCount);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < mCount; i++) {
    const a = (i / mCount) * Math.PI * 2 + rand() * 0.1;
    const r = radius + 480 + rand() * 260;
    const h = 60 + rand() * 170;
    const w = 90 + rand() * 120;
    p.set(cx + Math.cos(a) * r, h / 2 - 2, cz + Math.sin(a) * r);
    q.setFromAxisAngle(up, rand() * Math.PI);
    s.set(w, h, w * (0.7 + rand() * 0.6));
    m.compose(p, q, s);
    mountains.setMatrixAt(i, m);
  }
  group.add(mountains);

  // Towers: tall boxes with glowing caps around the arena and in the infield.
  const sdf = { d: 0, nx: 0, nz: 0 };
  const towerGeo = new THREE.BoxGeometry(1, 1, 1);
  const towerMat = new THREE.MeshLambertMaterial({ color: theme.tower, flatShading: true });
  const capMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const tCount = Math.round(70 * detail);
  const towers = new THREE.InstancedMesh(towerGeo, towerMat, tCount);
  const caps = new THREE.InstancedMesh(towerGeo, capMat, tCount);
  const capColors = theme.towerCaps.map((c) => new THREE.Color(c));
  let placed = 0;
  let guard = 0;
  while (placed < tCount && guard++ < 5000) {
    const infield = rand() < 0.3;
    let x: number;
    let z: number;
    if (infield) {
      x = cx + (rand() * 2 - 1) * radius * 0.7;
      z = cz + (rand() * 2 - 1) * radius * 0.7;
    } else {
      const a = rand() * Math.PI * 2;
      const r = radius + 70 + rand() * 230;
      x = cx + Math.cos(a) * r;
      z = cz + Math.sin(a) * r;
    }
    trackSdf(track, x, z, sdf);
    const w = 6 + rand() * 12;
    if (sdf.d < w + 10) continue;
    const h = infield ? 8 + rand() * 26 : 20 + rand() * 90;
    p.set(x, h / 2, z);
    q.setFromAxisAngle(up, rand() * Math.PI);
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

  const stand = createGrandstand(track, theme);
  if (stand) group.add(stand);
  return group;
}

/** Stepped grandstand beside the finish straight, on whichever side is free. */
function createGrandstand(track: Track, theme: Theme): THREE.Group | null {
  const fin = track.gates[4];
  const length = 110;
  const sdf = { d: 0, nx: 0, nz: 0 };
  const nx = -fin.dirZ;
  const nz = fin.dirX;
  for (const side of [1, -1]) {
    const off = fin.halfWidth + 9;
    // Centered a bit before the line, so it lines the start straight.
    const cxs = fin.x + nx * off * side - fin.dirX * 30;
    const czs = fin.z + nz * off * side - fin.dirZ * 30;
    let clear = true;
    for (let t = -length / 2; t <= length / 2 && clear; t += 5) {
      for (let k = 0; k < 4; k++) {
        const x = cxs + fin.dirX * t + nx * side * k * 6;
        const z = czs + fin.dirZ * t + nz * side * k * 6;
        if (trackSdf(track, x, z, sdf).d < 4) clear = false;
      }
    }
    if (!clear) continue;
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: theme.tower, flatShading: true });
    for (let i = 0; i < 4; i++) {
      const h = 2 + i * 2.2;
      const step = new THREE.Mesh(new THREE.BoxGeometry(6, h, length), mat);
      step.position.set(-side * i * 6, h / 2, 0);
      g.add(step);
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.2, length), new THREE.MeshBasicMaterial({ color: theme.gateNext }));
    banner.position.set(side * 3.5, 2.4, 0);
    g.add(banner);
    g.position.set(cxs, 0, czs);
    // Local z runs along the straight; local -x is the track's left normal,
    // so steps go outward at x = -side * i.
    g.rotation.y = Math.atan2(fin.dirX, fin.dirZ);
    return g;
  }
  return null;
}

export function createLights(theme: Theme, sunDir: THREE.Vector3): THREE.Object3D[] {
  const hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, theme.hemiIntensity);
  const sun = new THREE.DirectionalLight(theme.sunLight, theme.sunIntensity);
  sun.position.copy(sunDir).multiplyScalar(100);
  const ambient = new THREE.AmbientLight(theme.ambient, theme.ambientIntensity);
  return [hemi, sun, ambient];
}
