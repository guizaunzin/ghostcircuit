// Three.js renderer: owns the scene graph and camera. Receives interpolated
// poses each frame; never touches React or game rules.

import * as THREE from 'three';
import { clamp, damp, lerpAngle } from '../game/math';
import { sampleGhost, type GhostPose, type Recording } from '../game/ghost';
import type { Track } from '../game/track';
import { createGhostDrone, createPlayerDrone, getGlowTexture, type DroneModel } from './droneMesh';
import { createGround, createLights, createScenery, createSky, PALETTE } from './environment';
import { createTrackVisuals, setGateState, type TrackVisuals } from './trackMesh';

export interface Quality {
  pixelRatio: number;
  antialias: boolean;
  detail: number; // 0.5..1 decoration density
  particles: number;
}

export interface DronePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export interface RenderFrame {
  mode: 'menu' | 'race';
  drone: DronePose;
  speed: number;
  boosting: boolean;
  hitFlash: number;
  ghost: Recording | null;
  /** Race time used to sample the ghost. */
  ghostTime: number;
  /** Ghost visible (false before the race starts). */
  showGhost: boolean;
  nextGate: number;
  /** Real seconds since last frame. */
  dt: number;
  /** Wall clock seconds. */
  time: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  behind: boolean;
}

const TRAIL_POINTS = 48;
const TRAIL_SECONDS = 2.4;

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private player: DroneModel;
  private ghost: DroneModel;
  private visuals: TrackVisuals;
  private shadow: THREE.Mesh;
  private ghostShadow: THREE.Mesh;
  private trail: THREE.Line;
  private trailPos: Float32Array;
  private trailCol: Float32Array;
  private camYaw = 0;
  private camPos = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private fov = 68;
  private shake = 0;
  private particles: Particles;
  private tmpPose: GhostPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  private tmpV = new THREE.Vector3();
  private aspect = 1;
  quality: Quality;

  constructor(canvas: HTMLCanvasElement, track: Track, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality.antialias,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(quality.pixelRatio);
    this.renderer.setClearColor(PALETTE.fog);
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.3, 2400);

    this.scene.fog = new THREE.Fog(PALETTE.fog, 160, 900);
    this.scene.add(createSky(), createGround(), ...createLights());
    this.scene.add(createScenery(track, quality.detail));
    this.visuals = createTrackVisuals(track);
    this.scene.add(this.visuals.group);

    this.player = createPlayerDrone();
    this.ghost = createGhostDrone();
    this.scene.add(this.player.root, this.ghost.root);

    const shadowMat = new THREE.MeshBasicMaterial({
      map: getGlowTexture(),
      color: 0x000000,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    // A dark radial blob: use the glow alpha as mask via alphaMap trick.
    shadowMat.alphaMap = getGlowTexture();
    shadowMat.map = null;
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 4;
    this.scene.add(this.shadow);
    const gShadowMat = new THREE.MeshBasicMaterial({
      color: PALETTE.cyan,
      alphaMap: getGlowTexture(),
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ghostShadow = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), gShadowMat);
    this.ghostShadow.rotation.x = -Math.PI / 2;
    this.ghostShadow.renderOrder = 4;
    this.scene.add(this.ghostShadow);

    // Ghost trail: shows the line the ghost just took.
    this.trailPos = new Float32Array(TRAIL_POINTS * 3);
    this.trailCol = new Float32Array(TRAIL_POINTS * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    tg.setAttribute('color', new THREE.BufferAttribute(this.trailCol, 3));
    this.trail = new THREE.Line(
      tg,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 6;
    this.scene.add(this.trail);

    this.particles = new Particles(quality.particles);
    this.scene.add(this.particles.points);

    this.snapCamera(track.start.x, track.start.z, track.start.yaw);
  }

  setPixelRatio(pr: number): void {
    this.quality.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.aspect = width / Math.max(1, height);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  snapCamera(x: number, z: number, yaw: number): void {
    this.camYaw = yaw;
    const dist = this.chaseDistance(0);
    this.camPos.set(x - Math.sin(yaw) * dist, 4.2, z - Math.cos(yaw) * dist);
    this.lookAt.set(x + Math.sin(yaw) * 8, 2.4, z + Math.cos(yaw) * 8);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.lookAt);
    this.shake = 0;
    this.particles.clear();
  }

  private chaseDistance(speed: number): number {
    // Portrait screens need more distance to show the track ahead.
    const portrait = this.aspect < 1 ? 1.35 : 1;
    return (6.4 + speed * 0.05) * portrait;
  }

  collision(x: number, z: number, impact: number): void {
    this.shake = Math.min(0.6, this.shake + impact * 0.025);
    this.particles.burst(x, 2.2, z, Math.min(30, 6 + impact * 1.2), 0xffb070, 9);
  }

  render(f: RenderFrame): void {
    const d = f.drone;
    const dt = Math.min(f.dt, 0.1);

    // --- Player drone ---
    this.player.root.position.set(d.x, d.y, d.z);
    this.player.root.rotation.set(0, d.yaw, 0);
    this.player.body.rotation.set(d.pitch, 0, d.roll, 'YXZ');
    const spin = (f.mode === 'race' ? 40 + f.speed * 2 : 30) * dt;
    this.player.rotors.forEach((r, i) => (r.rotation.y += i % 2 ? spin : -spin));
    this.shadow.position.set(d.x, 0.08, d.z);
    // Hit flash: tint hull.
    const hull = this.player.materials[0] as THREE.MeshLambertMaterial;
    hull.emissive.setRGB(f.hitFlash * 2.2, f.hitFlash * 0.6, f.hitFlash * 0.4);

    // --- Ghost ---
    const showGhost = !!f.ghost && f.showGhost;
    this.ghost.root.visible = showGhost;
    this.ghostShadow.visible = showGhost;
    this.trail.visible = showGhost;
    if (showGhost && f.ghost) {
      const g = sampleGhost(f.ghost, f.ghostTime, this.tmpPose);
      this.ghost.root.position.set(g.x, g.y, g.z);
      this.ghost.root.rotation.set(0, g.yaw, 0);
      this.ghost.body.rotation.set(g.pitch, 0, g.roll, 'YXZ');
      this.ghost.rotors.forEach((r, i) => (r.rotation.y += i % 2 ? spin : -spin));
      this.ghostShadow.position.set(g.x, 0.09, g.z);
      // Fade when overlapping the player so the player stays readable,
      // and fade out after the ghost has finished.
      const near = Math.hypot(g.x - d.x, g.z - d.z);
      const overlapFade = clamp((near - 1.2) / 4, 0.25, 1);
      const endFade = f.ghostTime > f.ghost.time ? clamp(1 - (f.ghostTime - f.ghost.time) / 1.5, 0, 1) : 1;
      this.ghost.setOpacity?.(overlapFade * endFade);
      this.updateTrail(f.ghost, f.ghostTime, endFade);
    }

    // --- Gates ---
    for (const gv of this.visuals.gates) {
      const i = gv.gate.index;
      let state: 'next' | 'upcoming' | 'passed' | 'idle';
      if (f.mode === 'menu') state = 'idle';
      else if (i === f.nextGate) state = 'next';
      else if (i < f.nextGate) state = 'passed';
      else state = 'upcoming';
      setGateState(gv, state, f.time);
    }

    // --- Particles (boost exhaust) ---
    if (f.boosting && f.mode === 'race') {
      const bx = d.x - Math.sin(d.yaw) * 0.7;
      const bz = d.z - Math.cos(d.yaw) * 0.7;
      this.particles.trail(bx, d.y, bz, -Math.sin(d.yaw) * 8, -Math.cos(d.yaw) * 8, dt);
    }
    this.particles.update(dt);

    // --- Camera ---
    if (f.mode === 'menu') {
      // Slow sway in front of the drone (between it and the start arch),
      // looking back at it with the arena behind.
      const a = d.yaw + 0.45 + Math.sin(f.time * 0.18) * 0.3;
      const r = this.aspect < 1 ? 7.5 : 6;
      this.camera.position.set(d.x + Math.sin(a) * r, 2.9 + Math.sin(f.time * 0.25) * 0.3, d.z + Math.cos(a) * r);
      this.camera.lookAt(d.x, d.y + (this.aspect < 1 ? 1.4 : 0.5), d.z);
      this.fov += (62 - this.fov) * damp(3, dt);
    } else {
      this.updateChaseCamera(f, dt);
    }
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    this.renderer.render(this.scene, this.camera);
  }

  private updateChaseCamera(f: RenderFrame, dt: number): void {
    const d = f.drone;
    // Follow the heading with a little lag; anticipate turns slightly.
    this.camYaw = lerpAngle(this.camYaw, d.yaw, damp(4.2, dt));
    const sp = f.speed;
    const dist = this.chaseDistance(sp);
    const height = 2.7 + sp * 0.022;
    const fx = Math.sin(this.camYaw);
    const fz = Math.cos(this.camYaw);
    this.tmpV.set(d.x - fx * dist, d.y + height, d.z - fz * dist);
    // Smooth position, but stay tight enough at high speed.
    this.camPos.lerp(this.tmpV, damp(9, dt));
    // Never let the camera drift too far behind.
    const maxLag = dist * 1.6;
    const lag = Math.hypot(this.camPos.x - d.x, this.camPos.z - d.z);
    if (lag > maxLag) {
      const k = maxLag / lag;
      this.camPos.x = d.x + (this.camPos.x - d.x) * k;
      this.camPos.z = d.z + (this.camPos.z - d.z) * k;
    }
    const ahead = 5 + sp * 0.18;
    const look = this.tmpV.set(d.x + Math.sin(d.yaw) * ahead, d.y + 0.5, d.z + Math.cos(d.yaw) * ahead);
    this.lookAt.lerp(look, damp(10, dt));
    this.camera.position.copy(this.camPos);
    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.exp(-8 * dt);
    }
    this.camera.lookAt(this.lookAt);
    this.fadeOccluders(d, dt);
    const targetFov = (this.aspect < 1 ? 74 : 66) + clamp(sp / 44, 0, 1) * 10 + (f.boosting ? 6 : 0);
    this.fov += (targetFov - this.fov) * damp(4, dt);
  }

  /** Obstacles between the camera and the drone become see-through. */
  private fadeOccluders(d: DronePose, dt: number): void {
    const cx = this.camPos.x;
    const cz = this.camPos.z;
    const dx = d.x - cx;
    const dz = d.z - cz;
    const len2 = dx * dx + dz * dz || 1;
    for (const o of this.visuals.obstacles) {
      const t = clamp(((o.x - cx) * dx + (o.z - cz) * dz) / len2, 0, 1);
      const px = cx + dx * t - o.x;
      const pz = cz + dz * t - o.z;
      const blocking = Math.hypot(px, pz) < o.r + 1.2 || Math.hypot(cx - o.x, cz - o.z) < o.r + 2.5;
      const target = blocking ? 0.18 : 1;
      o.faded += (target - o.faded) * damp(12, dt);
      for (const m of o.materials) m.opacity = o.faded;
    }
  }

  private updateTrail(rec: Recording, t: number, fade: number): void {
    const p = this.tmpPose;
    const col = PALETTE.cyan;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const k = i / (TRAIL_POINTS - 1); // 0 = oldest
      const tt = Math.max(0, t - TRAIL_SECONDS * (1 - k));
      sampleGhost(rec, Math.min(tt, rec.time), p);
      this.trailPos[i * 3] = p.x;
      this.trailPos[i * 3 + 1] = p.y - 0.1;
      this.trailPos[i * 3 + 2] = p.z;
      const a = k * k * 0.9 * fade;
      this.trailCol[i * 3] = col.r * a;
      this.trailCol[i * 3 + 1] = col.g * a;
      this.trailCol[i * 3 + 2] = col.b * a;
    }
    const g = this.trail.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Projects a world point to normalised screen coords (-1..1). */
  project(x: number, y: number, z: number, out: ScreenPoint): ScreenPoint {
    const v = this.tmpV.set(x, y, z);
    v.applyMatrix4(this.camera.matrixWorldInverse);
    out.behind = v.z > 0;
    v.applyMatrix4(this.camera.projectionMatrix);
    out.x = v.x;
    out.y = v.y;
    if (out.behind) {
      out.x = -out.x;
      out.y = -out.y;
    }
    return out;
  }

  dispose(): void {
    this.player.dispose();
    this.ghost.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.renderer.dispose();
  }
}

// ---------------------------------------------------------------------------

class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private base: Float32Array;
  private next = 0;
  private trailAcc = 0;
  private n: number;

  constructor(n: number) {
    this.n = Math.max(16, n);
    this.pos = new Float32Array(this.n * 3);
    this.col = new Float32Array(this.n * 3);
    this.vel = new Float32Array(this.n * 3);
    this.life = new Float32Array(this.n);
    this.maxLife = new Float32Array(this.n);
    this.base = new Float32Array(this.n * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: 0.5,
        map: getGlowTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
  }

  clear(): void {
    this.life.fill(0);
    this.col.fill(0);
    (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, color: THREE.Color): void {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.base.set([color.r, color.g, color.b], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  private c = new THREE.Color();

  burst(x: number, y: number, z: number, count: number, color: number, speed: number): void {
    this.c.set(color);
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random());
      this.spawn(x, y, z, Math.cos(a) * s, (Math.random() - 0.2) * s, Math.sin(a) * s, 0.35 + Math.random() * 0.35, this.c);
    }
  }

  trail(x: number, y: number, z: number, vx: number, vz: number, dt: number): void {
    this.trailAcc += dt * 70;
    this.c.set(0xff9a4a);
    while (this.trailAcc >= 1) {
      this.trailAcc -= 1;
      this.spawn(
        x + (Math.random() - 0.5) * 0.4,
        y + (Math.random() - 0.5) * 0.3,
        z + (Math.random() - 0.5) * 0.4,
        vx + (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 1.5,
        vz + (Math.random() - 0.5) * 2,
        0.3 + Math.random() * 0.2,
        this.c,
      );
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) {
        this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= 6 * dt;
      this.col[i * 3] = this.base[i * 3] * k;
      this.col[i * 3 + 1] = this.base[i * 3 + 1] * k;
      this.col[i * 3 + 2] = this.base[i * 3 + 2] * k;
    }
    const g = this.points.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}
