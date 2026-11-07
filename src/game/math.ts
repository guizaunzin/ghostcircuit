// Small 2D math helpers used by the simulation (plane XZ, y is up).

export interface Vec2 {
  x: number;
  z: number;
}

export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wraps an angle to [-PI, PI). */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Interpolates angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/** Frame-rate independent exponential approach factor. */
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(bx - ax, bz - az);
}

export interface ClosestPoint {
  x: number;
  z: number;
  /** Parameter along the segment, 0..1 */
  t: number;
  /** Distance from the query point */
  d: number;
}

export function closestOnSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  out: ClosestPoint,
): ClosestPoint {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = clamp(t, 0, 1);
  out.x = ax + abx * t;
  out.z = az + abz * t;
  out.t = t;
  out.d = Math.hypot(px - out.x, pz - out.z);
  return out;
}

/**
 * Segment/segment intersection. Returns the parameter along P (p0->p1) where it
 * crosses Q (q0->q1), or -1 if they do not intersect.
 */
export function segmentIntersection(
  p0x: number,
  p0z: number,
  p1x: number,
  p1z: number,
  q0x: number,
  q0z: number,
  q1x: number,
  q1z: number,
): number {
  const rx = p1x - p0x;
  const rz = p1z - p0z;
  const sx = q1x - q0x;
  const sz = q1z - q0z;
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-12) return -1;
  const qpx = q0x - p0x;
  const qpz = q0z - p0z;
  const t = (qpx * sz - qpz * sx) / denom;
  const u = (qpx * rz - qpz * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return -1;
  return t;
}

/** Closed (looping) centripetal-ish Catmull-Rom sampled into points. */
export function sampleClosedCatmullRom(points: Vec2[], spacing: number): Vec2[] {
  const n = points.length;
  const dense: Vec2[] = [];
  const sub = 40;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      dense.push(catmull(p0, p1, p2, p3, t));
    }
  }
  return resampleClosed(dense, spacing);
}

export function catmull(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    z: 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
  };
}

export function catmull1(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Resamples a closed polyline into evenly spaced points. */
export function resampleClosed(pts: Vec2[], spacing: number): Vec2[] {
  const n = pts.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  const count = Math.max(8, Math.round(total / spacing));
  const step = total / count;
  const out: Vec2[] = [];
  let seg = 0;
  let segStart = 0;
  let segLen = Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z);
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (segStart + segLen < target && seg < n - 1) {
      segStart += segLen;
      seg++;
      const a = pts[seg];
      const b = pts[(seg + 1) % n];
      segLen = Math.hypot(b.x - a.x, b.z - a.z);
    }
    const a = pts[seg];
    const b = pts[(seg + 1) % n];
    const t = segLen > 0 ? (target - segStart) / segLen : 0;
    out.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });
  }
  return out;
}

/** Resamples an open polyline into evenly spaced points (keeps both ends). */
export function resampleOpen(pts: Vec2[], spacing: number): Vec2[] {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
  const count = Math.max(1, Math.round(total / spacing));
  const out: Vec2[] = [];
  let seg = 0;
  let segStart = 0;
  let segLen = Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z);
  for (let k = 0; k <= count; k++) {
    const target = (k / count) * total;
    while (segStart + segLen < target - 1e-9 && seg < pts.length - 2) {
      segStart += segLen;
      seg++;
      segLen = Math.hypot(pts[seg + 1].x - pts[seg].x, pts[seg + 1].z - pts[seg].z);
    }
    const t = segLen > 0 ? clamp((target - segStart) / segLen, 0, 1) : 0;
    out.push({ x: lerp(pts[seg].x, pts[seg + 1].x, t), z: lerp(pts[seg].z, pts[seg + 1].z, t) });
  }
  return out;
}

/** Deterministic PRNG (mulberry32) for procedural decoration. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
