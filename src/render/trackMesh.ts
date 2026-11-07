// Track visuals: surfaces, glowing glass walls (with gaps where corridors
// meet), checkpoint portals, start/finish line and obstacles.

import * as THREE from 'three';
import { tangentAt, trackSdf, type Corridor, type Gate, type Track } from '../game/track';
import { PALETTE } from './environment';

const WALL_HEIGHT = 2.7;

function surfaceTexture(kind: 'main' | 'shortcut'): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = kind === 'main' ? '#2a2342' : '#33263a';
  g.fillRect(0, 0, 128, 256);
  // Subtle cross bands for speed perception.
  g.fillStyle = kind === 'main' ? 'rgba(255,255,255,0.045)' : 'rgba(255,179,71,0.07)';
  g.fillRect(0, 0, 128, 64);
  g.fillRect(0, 128, 128, 64);
  // Edge lines.
  g.fillStyle = kind === 'main' ? 'rgba(56,232,255,0.55)' : 'rgba(255,179,71,0.7)';
  g.fillRect(3, 0, 3, 256);
  g.fillRect(122, 0, 3, 256);
  if (kind === 'main') {
    // Center dashes.
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(62, 0, 4, 90);
  } else {
    // Hazard chevrons.
    g.strokeStyle = 'rgba(255,179,71,0.35)';
    g.lineWidth = 6;
    for (let y = 0; y < 256; y += 64) {
      g.beginPath();
      g.moveTo(30, y + 50);
      g.lineTo(64, y + 20);
      g.lineTo(98, y + 50);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function corridorSurface(c: Corridor, y: number, kind: 'main' | 'shortcut'): THREE.Mesh {
  const pts = c.points;
  const n = pts.length;
  const count = c.closed ? n + 1 : n;
  const pos = new Float32Array(count * 2 * 3);
  const uv = new Float32Array(count * 2 * 2);
  const idx: number[] = [];
  for (let k = 0; k < count; k++) {
    const i = k % n;
    const p = pts[i];
    const t = tangentAt(c, i);
    const nx = -t.z;
    const nz = t.x;
    const w = p.hw + 0.3;
    pos.set([p.x + nx * w, y, p.z + nz * w, p.x - nx * w, y, p.z - nz * w], k * 6);
    const v = (k === n ? c.length : c.dist[i]) / 16;
    uv.set([0, v, 1, v], k * 4);
    if (k < count - 1) {
      const a = k * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Make sure normals face up regardless of winding.
  const normals = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, 1, 0);
  const mat = new THREE.MeshLambertMaterial({ map: surfaceTexture(kind), side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = kind === 'main' ? 1 : 2;
  return mesh;
}

interface WallPiece {
  x: number;
  z: number;
  len: number;
  yaw: number;
  color: THREE.Color;
}

function collectWalls(track: Track): WallPiece[] {
  const out: WallPiece[] = [];
  const sdf = { d: 0, nx: 0, nz: 0 };
  for (const c of track.corridors) {
    const pts = c.points;
    const n = pts.length;
    const segs = c.closed ? n : n - 1;
    const color = c.name === 'main' ? PALETTE.cyan : PALETTE.amber;
    for (const side of [1, -1]) {
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        const ta = tangentAt(c, i);
        const tb = tangentAt(c, j);
        const a = pts[i];
        const b = pts[j];
        const ax = a.x + -ta.z * side * a.hw;
        const az = a.z + ta.x * side * a.hw;
        const bx = b.x + -tb.z * side * b.hw;
        const bz = b.z + tb.x * side * b.hw;
        const mx = (ax + bx) / 2;
        const mz = (az + bz) / 2;
        // Gap where this boundary lies inside another part of the track.
        trackSdf(track, mx, mz, sdf);
        if (sdf.d < -0.35) continue;
        // Offset outward by half the wall thickness.
        const tx = (ta.x + tb.x) / 2;
        const tz = (ta.z + tb.z) / 2;
        const tl = Math.hypot(tx, tz) || 1;
        const ox = (-tz / tl) * side * 0.2;
        const oz = (tx / tl) * side * 0.2;
        out.push({
          x: mx + ox,
          z: mz + oz,
          len: Math.hypot(bx - ax, bz - az) + 0.08,
          yaw: Math.atan2(bx - ax, bz - az),
          color,
        });
      }
    }
  }
  return out;
}

function createWalls(track: Track): THREE.Group {
  const pieces = collectWalls(track);
  const group = new THREE.Group();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const glass = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.13,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const rail = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const panels = new THREE.InstancedMesh(box, glass, pieces.length);
  const tops = new THREE.InstancedMesh(box, rail, pieces.length);
  const bottoms = new THREE.InstancedMesh(box, rail, pieces.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const dim = new THREE.Color();
  pieces.forEach((w, i) => {
    q.setFromAxisAngle(up, w.yaw);
    p.set(w.x, WALL_HEIGHT / 2, w.z);
    s.set(0.12, WALL_HEIGHT, w.len);
    m.compose(p, q, s);
    panels.setMatrixAt(i, m);
    panels.setColorAt(i, w.color);
    p.set(w.x, WALL_HEIGHT, w.z);
    s.set(0.28, 0.22, w.len);
    m.compose(p, q, s);
    tops.setMatrixAt(i, m);
    tops.setColorAt(i, w.color);
    p.set(w.x, 0.12, w.z);
    s.set(0.3, 0.24, w.len);
    m.compose(p, q, s);
    bottoms.setMatrixAt(i, m);
    bottoms.setColorAt(i, dim.copy(w.color).multiplyScalar(0.55));
  });
  panels.renderOrder = 3;
  group.add(panels, tops, bottoms);
  return group;
}

// ---------------------------------------------------------------------------
// Gates

export type GateVisualState = 'next' | 'upcoming' | 'passed' | 'idle';

export interface GateVisual {
  gate: Gate;
  group: THREE.Group;
  frameMat: THREE.MeshBasicMaterial;
  portalMat: THREE.ShaderMaterial;
  labelMat: THREE.SpriteMaterial;
  state: GateVisualState;
}

function labelTexture(text: string, accent: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(10,6,24,0.75)';
  g.beginPath();
  g.roundRect(8, 16, 240, 96, 22);
  g.fill();
  g.strokeStyle = accent;
  g.lineWidth = 6;
  g.stroke();
  g.fillStyle = '#ffffff';
  g.font = 'bold 60px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function checkerTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const g = c.getContext('2d')!;
  for (let x = 0; x < 16; x++)
    for (let y = 0; y < 4; y++) {
      g.fillStyle = (x + y) % 2 ? '#f5f0ff' : '#14101f';
      g.fillRect(x * 8, y * 8, 8, 8);
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

const portalVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const portalFragment = /* glsl */ `
  uniform float time; uniform float opacity; uniform vec3 color;
  varying vec2 vUv;
  void main() {
    float edge = max(smoothstep(0.82, 1.0, abs(vUv.x * 2.0 - 1.0)), smoothstep(0.85, 1.0, vUv.y));
    float scan = 0.5 + 0.5 * sin((vUv.y * 22.0 - time * 4.0));
    float a = (0.1 + scan * 0.12 + edge * 0.6) * opacity;
    gl_FragColor = vec4(color, a);
  }`;

function createGate(g: Gate, isFinish: boolean, checker: THREE.Texture): GateVisual {
  const group = new THREE.Group();
  group.position.set(g.x, 0, g.z);
  group.rotation.y = Math.atan2(g.dirX, g.dirZ);
  const half = g.halfWidth + 0.9;
  const height = 8.5;
  const frameMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x1d1730, flatShading: true });
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(1.1, height, 1.1), darkMat);
    post.position.set(side * half, height / 2, 0);
    group.add(post);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.3, height, 1.16), frameMat);
    strip.position.set(side * (half - 0.45), height / 2, 0);
    group.add(strip);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 1.1, 1.1, 1.1), darkMat);
  beam.position.set(0, height, 0);
  group.add(beam);
  const beamStrip = new THREE.Mesh(new THREE.BoxGeometry(half * 2 - 0.6, 0.3, 1.16), frameMat);
  beamStrip.position.set(0, height - 0.45, 0);
  group.add(beamStrip);

  const portalMat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, opacity: { value: 0 }, color: { value: new THREE.Color(PALETTE.magenta) } },
    vertexShader: portalVertex,
    fragmentShader: portalFragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const portal = new THREE.Mesh(new THREE.PlaneGeometry(half * 2 - 0.6, height - 0.6), portalMat);
  portal.position.set(0, (height - 0.6) / 2, 0);
  portal.renderOrder = 4;
  group.add(portal);

  const labelMat = new THREE.SpriteMaterial({
    map: labelTexture(isFinish ? 'CHEGADA' : String(g.index + 1), isFinish ? '#ffffff' : '#ff3ea5'),
    transparent: true,
    depthWrite: false,
  });
  const label = new THREE.Sprite(labelMat);
  label.scale.set(isFinish ? 7 : 5, isFinish ? 3.5 : 2.5, 1);
  label.position.set(0, height + 2.4, 0);
  group.add(label);

  if (isFinish) {
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(g.halfWidth * 2 + 0.6, 2.4),
      new THREE.MeshBasicMaterial({ map: checker, transparent: true, opacity: 0.9 }),
    );
    line.rotation.x = -Math.PI / 2;
    line.position.y = 0.07;
    line.renderOrder = 3;
    group.add(line);
  } else {
    // Ground marker line.
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(g.halfWidth * 2, 0.6),
      new THREE.MeshBasicMaterial({ color: PALETTE.magenta, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    line.rotation.x = -Math.PI / 2;
    line.position.y = 0.07;
    line.renderOrder = 3;
    group.add(line);
  }
  return { gate: g, group, frameMat, portalMat, labelMat, state: 'idle' };
}

const NEXT_COLOR = new THREE.Color('#ff3ea5');
const UPCOMING_COLOR = new THREE.Color('#7f8cff');
const PASSED_COLOR = new THREE.Color('#3a3450');
const FINISH_COLOR = new THREE.Color('#ffffff');

export function setGateState(v: GateVisual, state: GateVisualState, time: number): void {
  const isFinish = v.gate.index === 4;
  const pulse = 0.75 + 0.25 * Math.sin(time * 6);
  v.portalMat.uniforms.time.value = time;
  switch (state) {
    case 'next':
      v.frameMat.color.copy(isFinish ? FINISH_COLOR : NEXT_COLOR).multiplyScalar(pulse + 0.25);
      v.portalMat.uniforms.opacity.value = 0.9;
      (v.portalMat.uniforms.color.value as THREE.Color).copy(isFinish ? FINISH_COLOR : NEXT_COLOR);
      v.labelMat.opacity = 1;
      break;
    case 'upcoming':
      v.frameMat.color.copy(isFinish ? FINISH_COLOR : UPCOMING_COLOR).multiplyScalar(0.6);
      v.portalMat.uniforms.opacity.value = 0.12;
      (v.portalMat.uniforms.color.value as THREE.Color).copy(UPCOMING_COLOR);
      v.labelMat.opacity = 0.6;
      break;
    case 'passed':
      v.frameMat.color.copy(PASSED_COLOR);
      v.portalMat.uniforms.opacity.value = 0;
      v.labelMat.opacity = 0.25;
      break;
    case 'idle':
      v.frameMat.color.copy(isFinish ? FINISH_COLOR : UPCOMING_COLOR).multiplyScalar(0.8);
      v.portalMat.uniforms.opacity.value = isFinish ? 0.25 : 0.12;
      (v.portalMat.uniforms.color.value as THREE.Color).copy(isFinish ? FINISH_COLOR : UPCOMING_COLOR);
      v.labelMat.opacity = 0.8;
      break;
  }
  v.state = state;
}

// ---------------------------------------------------------------------------
// Obstacles

export interface ObstacleVisual {
  x: number;
  z: number;
  r: number;
  materials: THREE.Material[];
  faded: number;
}

function createObstacles(track: Track, out: ObstacleVisual[]): THREE.Group {
  const group = new THREE.Group();
  for (const o of track.obstacles) {
    // Own materials so each obstacle can fade when it blocks the camera.
    const body = new THREE.MeshLambertMaterial({ color: 0x2a2140, flatShading: true, transparent: true });
    const glow = new THREE.MeshBasicMaterial({ color: 0xff5a36, transparent: true });
    out.push({ x: o.x, z: o.z, r: o.kind === 'pillar' ? o.r : Math.hypot(o.hx, o.hz), materials: [body, glow], faded: 1 });
    if (o.kind === 'pillar') {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r * 1.1, o.h, 8), body);
      m.position.set(o.x, o.h / 2, o.z);
      group.add(m);
      for (const y of [0.9, 2.4, o.h - 0.4]) {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(o.r * 1.12, o.r * 1.12, 0.25, 8), glow);
        ring.position.set(o.x, y, o.z);
        group.add(ring);
      }
    } else {
      const m = new THREE.Mesh(new THREE.BoxGeometry(o.hx * 2, o.h, o.hz * 2), body);
      m.position.set(o.x, o.h / 2, o.z);
      m.rotation.y = o.rot;
      group.add(m);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(o.hx * 2 + 0.1, 0.25, o.hz * 2 + 0.1), glow);
      cap.position.set(o.x, o.h, o.z);
      cap.rotation.y = o.rot;
      group.add(cap);
      const base = new THREE.Mesh(new THREE.BoxGeometry(o.hx * 2 + 0.1, 0.25, o.hz * 2 + 0.1), glow);
      base.position.set(o.x, 1.2, o.z);
      base.rotation.y = o.rot;
      group.add(base);
    }
  }
  return group;
}

export interface TrackVisuals {
  group: THREE.Group;
  gates: GateVisual[];
  obstacles: ObstacleVisual[];
}

export function createTrackVisuals(track: Track): TrackVisuals {
  const group = new THREE.Group();
  group.add(corridorSurface(track.main, 0.02, 'main'));
  group.add(corridorSurface(track.shortcut, 0.04, 'shortcut'));
  group.add(createWalls(track));
  const obstacles: ObstacleVisual[] = [];
  group.add(createObstacles(track, obstacles));
  const checker = checkerTexture();
  const gates = track.gates.map((g) => createGate(g, g.index === 4, checker));
  gates.forEach((g) => group.add(g.group));
  return { group, gates, obstacles };
}
