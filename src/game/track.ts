// Track definition: corridors (playable area as a union of variable-width
// tubes around polylines), gates (checkpoints + start/finish) and obstacles.
// Pure data + queries, no rendering. Units are meters, plane XZ.

import { catmull1, clamp, closestOnSegment, type ClosestPoint, type Vec2 } from './math';

export const TRACK_ID = 'arena-crepusculo';
/** Bump whenever the layout changes: invalidates stored ghosts. */
export const TRACK_VERSION = 1;

export interface CenterPoint {
  x: number;
  z: number;
  /** Half width of the corridor at this point. */
  hw: number;
}

export interface Corridor {
  name: string;
  closed: boolean;
  points: CenterPoint[];
  /** Cumulative distance at each point. */
  dist: number[];
  length: number;
}

export interface Gate {
  /** 0..3 = checkpoints, 4 = finish line */
  index: number;
  label: string;
  /** Center of the gate */
  x: number;
  z: number;
  /** Unit direction a valid crossing must follow (track forward). */
  dirX: number;
  dirZ: number;
  /** Gate segment endpoints (spans the full corridor width plus margin). */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  halfWidth: number;
  /** Index on the main centerline */
  centerIndex: number;
}

export type Obstacle =
  | { kind: 'pillar'; x: number; z: number; r: number; h: number }
  | { kind: 'box'; x: number; z: number; hx: number; hz: number; rot: number; h: number };

export interface Track {
  id: string;
  version: number;
  main: Corridor;
  shortcut: Corridor;
  corridors: Corridor[];
  gates: Gate[];
  obstacles: Obstacle[];
  start: { x: number; z: number; yaw: number };
  /** Main-centerline index range covered by the shortcut (entry -> exit). */
  shortcutRange: [number, number];
}

// ---------------------------------------------------------------------------
// Layout. Clockwise when looking down (x right, z up on the map).
// [x, z, halfWidth]
const MAIN_CONTROL: [number, number, number][] = [
  [0, -120, 10.5], // start / finish straight (boost)
  [0, -50, 10.5],
  [0, 20, 10.5],
  [1, 90, 10.5],
  [10, 142, 10], // wide right sweeper
  [44, 182, 10],
  [100, 192, 10],
  [150, 170, 10],
  [168, 118, 9.5],
  [160, 74, 8.5], // technical chicane
  [128, 46, 7.5],
  [106, 16, 7.5],
  [114, -14, 7.5],
  [148, -36, 7.5],
  [158, -68, 8.5],
  [138, -108, 9.5], // long drop into the bottom U
  [96, -144, 10],
  [52, -163, 10.5],
  [16, -154, 10.5],
];

// Shortcut: cuts the inside of the sweeper. Narrow, sharp entry, pillars.
const SHORTCUT_CONTROL: [number, number, number][] = [
  [-3, 118, 3.8],
  [12, 124, 3.8],
  [44, 136, 3.8],
  [84, 145, 3.8],
  [120, 141, 3.8],
  [148, 128, 3.8],
  [165, 104, 3.8],
];

const OBSTACLES: Obstacle[] = [
  // Pillar splitting the boost straight: pick a side.
  { kind: 'pillar', x: 0, z: 30, r: 1.7, h: 14 },
  // Shortcut hazards (staggered).
    { kind: 'pillar', x: 70, z: 143.2, r: 1.2, h: 10 },
  { kind: 'pillar', x: 122, z: 138, r: 1.2, h: 10 },
  // Chicane block on the inside line.
  { kind: 'box', x: 104, z: 12, hx: 2, hz: 3.5, rot: 0.2, h: 4 },
  // Bottom U: apex pillars.
  { kind: 'pillar', x: 104, z: -128, r: 1.6, h: 12 },
  { kind: 'pillar', x: 60, z: -150, r: 1.6, h: 12 },
  // Sweeper outside blocks (punish running wide).
  { kind: 'box', x: 72, z: 196, hx: 3, hz: 1.6, rot: -0.1, h: 3 },
];

const CHECKPOINTS: { at: Vec2; label: string }[] = [
  { at: { x: 0, z: 62 }, label: 'CP 1' },
  { at: { x: 166, z: 92 }, label: 'CP 2' },
  { at: { x: 154, z: -84 }, label: 'CP 3' },
  { at: { x: 40, z: -162 }, label: 'CP 4' },
];
const FINISH_AT: Vec2 = { x: 0, z: -96 };
const START_BEHIND = 9; // meters behind the start/finish line

// ---------------------------------------------------------------------------

function sampleCenter(control: [number, number, number][], closed: boolean, spacing: number): CenterPoint[] {
  const n = control.length;
  const get = (i: number) => {
    if (closed) return control[((i % n) + n) % n];
    return control[clamp(i, 0, n - 1)];
  };
  const dense: CenterPoint[] = [];
  const segs = closed ? n : n - 1;
  const sub = 60;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      dense.push({
        x: catmull1(p0[0], p1[0], p2[0], p3[0], t),
        z: catmull1(p0[1], p1[1], p2[1], p3[1], t),
        hw: catmull1(p0[2], p1[2], p2[2], p3[2], t),
      });
    }
  }
  if (!closed) {
    const last = control[n - 1];
    dense.push({ x: last[0], z: last[1], hw: last[2] });
  }
  return resample(dense, closed, spacing);
}

function resample(pts: CenterPoint[], closed: boolean, spacing: number): CenterPoint[] {
  const n = pts.length;
  const segCount = closed ? n : n - 1;
  const cum: number[] = [0];
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const total = cum[segCount];
  const count = Math.max(4, Math.round(total / spacing));
  const out: CenterPoint[] = [];
  let seg = 0;
  const last = closed ? count - 1 : count;
  for (let k = 0; k <= last; k++) {
    const target = (k / count) * total;
    while (seg < segCount - 1 && cum[seg + 1] < target) seg++;
    const a = pts[seg];
    const b = pts[(seg + 1) % n];
    const len = cum[seg + 1] - cum[seg];
    const t = len > 0 ? clamp((target - cum[seg]) / len, 0, 1) : 0;
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, hw: a.hw + (b.hw - a.hw) * t });
  }
  return out;
}

function makeCorridor(name: string, points: CenterPoint[], closed: boolean): Corridor {
  const dist = [0];
  const n = points.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    dist.push(dist[i] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  return { name, closed, points, dist, length: dist[segs] };
}

/** Nearest centerline index of a corridor to a point. */
export function nearestIndex(c: Corridor, x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < c.points.length; i++) {
    const p = c.points[i];
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Unit tangent of a corridor at point i. */
export function tangentAt(c: Corridor, i: number): Vec2 {
  const n = c.points.length;
  const a = c.closed ? c.points[(i - 1 + n) % n] : c.points[Math.max(0, i - 1)];
  const b = c.closed ? c.points[(i + 1) % n] : c.points[Math.min(n - 1, i + 1)];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
}

function makeGate(main: Corridor, index: number, label: string, at: Vec2): Gate {
  const ci = nearestIndex(main, at.x, at.z);
  const p = main.points[ci];
  const t = tangentAt(main, ci);
  // Left normal (perpendicular in XZ).
  const nx = -t.z;
  const nz = t.x;
  const half = p.hw + 1.5;
  return {
    index,
    label,
    x: p.x,
    z: p.z,
    dirX: t.x,
    dirZ: t.z,
    ax: p.x + nx * half,
    az: p.z + nz * half,
    bx: p.x - nx * half,
    bz: p.z - nz * half,
    halfWidth: p.hw,
    centerIndex: ci,
  };
}

let cached: Track | null = null;

export function getTrack(): Track {
  if (!cached) cached = buildTrack();
  return cached;
}

export function buildTrack(): Track {
  const main = makeCorridor('main', sampleCenter(MAIN_CONTROL, true, 1.5), true);
  const shortcut = makeCorridor('shortcut', sampleCenter(SHORTCUT_CONTROL, false, 1.5), false);
  const gates = CHECKPOINTS.map((c, i) => makeGate(main, i, c.label, c.at));
  gates.push(makeGate(main, 4, 'Chegada', FINISH_AT));
  const fin = gates[4];
  const start = {
    x: fin.x - fin.dirX * START_BEHIND,
    z: fin.z - fin.dirZ * START_BEHIND,
    yaw: Math.atan2(fin.dirX, fin.dirZ),
  };
  const s0 = shortcut.points[0];
  const s1 = shortcut.points[shortcut.points.length - 1];
  return {
    id: TRACK_ID,
    version: TRACK_VERSION,
    main,
    shortcut,
    corridors: [main, shortcut],
    gates,
    obstacles: OBSTACLES,
    start,
    shortcutRange: [nearestIndex(main, s0.x, s0.z), nearestIndex(main, s1.x, s1.z)],
  };
}

// ---------------------------------------------------------------------------
// Signed distance to the playable area (negative inside).

export interface SdfResult {
  /** Signed distance: < 0 inside the track. */
  d: number;
  /** Unit vector from the closest centerline point toward the query (outward). */
  nx: number;
  nz: number;
}

const tmpCp: ClosestPoint = { x: 0, z: 0, t: 0, d: 0 };

export function corridorSdf(c: Corridor, x: number, z: number, out: SdfResult): SdfResult {
  const pts = c.points;
  const n = pts.length;
  const segs = c.closed ? n : n - 1;
  let best = Infinity;
  let bx = 0;
  let bz = 0;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    // Cheap reject: a lower bound of the true distance (segments are ~1.5 m).
    const mx = (a.x + b.x) * 0.5;
    const mz = (a.z + b.z) * 0.5;
    const rough = (Math.abs(x - mx) + Math.abs(z - mz)) * 0.7071 - 1 - Math.max(a.hw, b.hw);
    if (rough > best) continue;
    closestOnSegment(x, z, a.x, a.z, b.x, b.z, tmpCp);
    const hw = a.hw + (b.hw - a.hw) * tmpCp.t;
    const d = tmpCp.d - hw;
    if (d < best) {
      best = d;
      bx = tmpCp.x;
      bz = tmpCp.z;
    }
  }
  const dx = x - bx;
  const dz = z - bz;
  const l = Math.hypot(dx, dz);
  out.d = best;
  out.nx = l > 1e-9 ? dx / l : 1;
  out.nz = l > 1e-9 ? dz / l : 0;
  return out;
}

const tmpSdf: SdfResult = { d: 0, nx: 0, nz: 0 };

/** SDF of the union of all corridors. */
export function trackSdf(track: Track, x: number, z: number, out: SdfResult): SdfResult {
  out.d = Infinity;
  for (const c of track.corridors) {
    corridorSdf(c, x, z, tmpSdf);
    if (tmpSdf.d < out.d) {
      out.d = tmpSdf.d;
      out.nx = tmpSdf.nx;
      out.nz = tmpSdf.nz;
    }
  }
  return out;
}

/**
 * Pushes a circle (x,z,r) out of an obstacle. Returns penetration depth
 * (0 if none) and writes the push normal to out.
 */
export function obstaclePush(o: Obstacle, x: number, z: number, r: number, out: { nx: number; nz: number }): number {
  if (o.kind === 'pillar') {
    const dx = x - o.x;
    const dz = z - o.z;
    const d = Math.hypot(dx, dz);
    const pen = o.r + r - d;
    if (pen <= 0) return 0;
    out.nx = d > 1e-9 ? dx / d : 1;
    out.nz = d > 1e-9 ? dz / d : 0;
    return pen;
  }
  // Oriented box: transform into local frame.
  const c = Math.cos(o.rot);
  const s = Math.sin(o.rot);
  const dx = x - o.x;
  const dz = z - o.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const qx = clamp(lx, -o.hx, o.hx);
  const qz = clamp(lz, -o.hz, o.hz);
  let nlx = lx - qx;
  let nlz = lz - qz;
  let d = Math.hypot(nlx, nlz);
  let pen: number;
  if (d > 1e-9) {
    pen = r - d;
    if (pen <= 0) return 0;
    nlx /= d;
    nlz /= d;
  } else {
    // Center inside the box: push along the axis of least penetration.
    const px = o.hx - Math.abs(lx);
    const pz = o.hz - Math.abs(lz);
    if (px < pz) {
      nlx = Math.sign(lx) || 1;
      nlz = 0;
      d = px;
    } else {
      nlx = 0;
      nlz = Math.sign(lz) || 1;
      d = pz;
    }
    pen = r + d;
  }
  // Back to world (inverse rotation).
  out.nx = nlx * c + nlz * s;
  out.nz = -nlx * s + nlz * c;
  return pen;
}
