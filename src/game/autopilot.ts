// A simple pure-pursuit pilot following the centerline. Used by automated
// tests (headless laps, E2E) to prove the track is completable; not exposed
// to players.

import { cornerSpeed, DRONE, forwardSpeed, type DroneInput, type DroneState } from './drone';
import { clamp, wrapAngle, type Vec2 } from './math';
import type { Track } from './track';

export interface AutopilotOptions {
  /** 0..1 how hard to push (speed in corners). */
  aggression: number;
  useBoost: boolean;
  useShortcut: boolean;
}

export class Autopilot {
  private route: Vec2[];
  private cum: number[];
  private length: number;
  private idx = 0;

  constructor(
    track: Track,
    private opts: AutopilotOptions,
  ) {
    this.route = buildRoute(track, opts.useShortcut);
    this.cum = [0];
    for (let i = 0; i < this.route.length; i++) {
      const a = this.route[i];
      const b = this.route[(i + 1) % this.route.length];
      this.cum.push(this.cum[i] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    this.length = this.cum[this.route.length];
    this.idx = nearest(this.route, track.start.x, track.start.z, 0, this.route.length);
  }

  /** Re-locates the drone on the route from scratch (after a teleport or route change). */
  resync(x: number, z: number): void {
    this.idx = nearest(this.route, x, z, 0, this.route.length);
  }

  /**
   * Computes the input for one step.
   * @param offset lateral shift of the aimed line in meters (+ = left)
   * @param speedCap maximum speed this pilot will aim for (m/s)
   */
  drive(d: DroneState, out: DroneInput, offset = 0, speedCap = Infinity): DroneInput {
    const n = this.route.length;
    // Track progress locally (search a window ahead to avoid jumping).
    this.idx = nearest(this.route, d.x, d.z, this.idx - 5, 40);
    if ((this.route[this.idx].x - d.x) ** 2 + (this.route[this.idx].z - d.z) ** 2 > 400) this.resync(d.x, d.z);
    const speed = Math.max(0, forwardSpeed(d));
    const look = 7 + speed * 0.45;
    let target = this.pointAhead(look);
    if (offset !== 0) {
      const t2 = this.pointAhead(look + 2);
      const tx = t2.x - target.x;
      const tz = t2.z - target.z;
      const tl = Math.hypot(tx, tz) || 1;
      target = { x: target.x + (-tz / tl) * offset, z: target.z + (tx / tl) * offset };
    }
    const desiredYaw = Math.atan2(target.x - d.x, target.z - d.z);
    const err = wrapAngle(desiredYaw - d.yaw);
    // yaw decreases when steering right (positive steer).
    out.steer = clamp(-err * 2.6 - (-d.yawRate) * 0.12, -1, 1);

    // Speed planning from the upcoming curvature.
    let maxCurv = 0;
    const horizon = 12 + speed * 1.6;
    for (let s = 6; s < horizon; s += 3) {
      const k = this.curvatureAt(s);
      if (k > maxCurv) maxCurv = k;
    }
    // The drone keeps its speed while yawing: the real limit in a curve is
    // the yaw rate. Aggression sets how close to that limit the pilot goes.
    // Above 1 is still safe: the pursuit line cuts corners, so the radius
    // actually driven is larger than the route's.
    const margin = 0.4 + 0.8 * clamp(this.opts.aggression, 0, 1);
    const vTarget = Math.min(speedCap, cornerSpeed(maxCurv, margin), DRONE.boostMaxSpeed);
    out.throttle = speed < vTarget ? 1 : 0;
    out.brake = speed > vTarget + 2 ? clamp((speed - vTarget) / 6, 0.2, 1) : 0;
    // Boost whenever the line ahead allows going faster than the normal cap.
    // (Like a player holding the button: every recharge gets used.)
    out.boost = this.opts.useBoost && out.throttle > 0 && vTarget > DRONE.maxSpeed + 1;
    void n;
    return out;
  }

  private pointAhead(dist: number): Vec2 {
    const n = this.route.length;
    let i = this.idx;
    let acc = 0;
    while (acc < dist) {
      const a = this.route[i % n];
      const b = this.route[(i + 1) % n];
      acc += Math.hypot(b.x - a.x, b.z - a.z);
      i++;
    }
    return this.route[i % n];
  }

  private curvatureAt(dist: number): number {
    const a = this.pointAhead(dist);
    // Long chords: the pursuit line rounds off short wiggles of the route.
    const b = this.pointAhead(dist + 8);
    const c = this.pointAhead(dist + 16);
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const bcx = c.x - b.x;
    const bcz = c.z - b.z;
    const cross = Math.abs(abx * bcz - abz * bcx);
    const la = Math.hypot(abx, abz);
    const lb = Math.hypot(bcx, bcz);
    const lc = Math.hypot(c.x - a.x, c.z - a.z);
    if (la * lb * lc < 1e-6) return 0;
    return (2 * cross) / (la * lb * lc);
  }

  /** Current position along the route (meters). */
  get progress(): number {
    return this.cum[this.idx];
  }

  get routeLength(): number {
    return this.length;
  }
}

function nearest(route: Vec2[], x: number, z: number, from: number, count: number): number {
  const n = route.length;
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < count; k++) {
    const i = (((from + k) % n) + n) % n;
    const p = route[i];
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Closed route along the main centerline, optionally via the shortcut. */
export function buildRoute(track: Track, useShortcut: boolean): Vec2[] {
  const main = track.main.points;
  let out: Vec2[] = [];
  if (!useShortcut) {
    out = main.map((p) => ({ x: p.x, z: p.z }));
  } else {
    const [a, b] = track.shortcutRange;
    for (let i = 0; i <= a; i++) out.push({ x: main[i].x, z: main[i].z });
    // Skip the very first/last shortcut points that sit inside the main lane.
    const sc = track.shortcut.points;
    for (let i = 2; i < sc.length - 2; i++) out.push({ x: sc[i].x, z: sc[i].z });
    for (let i = b + 4; i < main.length; i++) out.push({ x: main[i].x, z: main[i].z });
  }
  // Steer around obstacles: shift the route sideways with a smooth falloff.
  const n = out.length;
  for (const o of track.obstacles) {
    const r = o.kind === 'pillar' ? o.r : Math.hypot(o.hx, o.hz);
    const clearance = r + 2.4;
    let k = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(out[i].x - o.x, out[i].z - o.z);
      if (d < bestD) {
        bestD = d;
        k = i;
      }
    }
    if (bestD >= clearance) continue;
    const a = out[(k - 1 + n) % n];
    const b = out[(k + 1) % n];
    let nx = -(b.z - a.z);
    let nz = b.x - a.x;
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    const side = (out[k].x - o.x) * nx + (out[k].z - o.z) * nz;
    const sign = side >= 0 ? 1 : -1;
    const shift = clearance - Math.abs(side);
    const m = 16;
    for (let j = -m; j <= m; j++) {
      const w = 0.5 + 0.5 * Math.cos((Math.PI * j) / (m + 1));
      const p = out[(k + j + n) % n];
      p.x += nx * sign * shift * w;
      p.z += nz * sign * shift * w;
    }
  }
  for (let iter = 0; iter < (useShortcut ? 14 : 3); iter++) {
    const copy = out.map((p) => ({ ...p }));
    for (let i = 0; i < n; i++) {
      const a = copy[(i - 1 + n) % n];
      const b = copy[(i + 1) % n];
      out[i].x = (a.x + copy[i].x * 2 + b.x) / 4;
      out[i].z = (a.z + copy[i].z * 2 + b.z) / 4;
    }
  }
  return out;
}
