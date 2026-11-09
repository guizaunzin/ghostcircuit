// Track definition: corridors (playable area as a union of variable-width
// tubes around polylines), gates (checkpoints + start/finish) and obstacles.
// Pure data + queries, no rendering. Units are meters, plane XZ.
//
// Tracks are described by a TrackDef (pure data, see maps.ts). Checkpoints
// and obstacles are placed by distance along the track and lateral offset,
// so they always stay where intended when the layout changes.

import { catmull1, clamp, closestOnSegment, type ClosestPoint, type Vec2 } from './math';

export type ThemeId = 'crepusculo' | 'noturno' | 'aurora' | 'duna' | 'tempestade';

/** [x, z, halfWidth] */
export type ControlPoint = [number, number, number];

export type ObstacleDef =
  | {
      kind: 'pillar';
      on: 'main' | 'shortcut';
      /** Distance along the corridor (main: measured from the finish line). */
      s: number;
      /** Lateral offset from the centerline in meters (+ = left). */
      offset: number;
      r: number;
      h: number;
    }
  | {
      kind: 'box';
      on: 'main' | 'shortcut';
      s: number;
      offset: number;
      /** Half size across the track. */
      wide: number;
      /** Half size along the track. */
      long: number;
      /** Extra rotation relative to the track direction. */
      rot?: number;
      h: number;
    };

export interface TrackDef {
  id: string;
  name: string;
  /** Bump whenever the layout changes: invalidates stored ghosts. */
  version: number;
  /** Seed used by the generator (null = hand-made). */
  seed: number | null;
  theme: ThemeId;
  main: ControlPoint[];
  shortcut: ControlPoint[];
  /** Position of the finish line: distance along the main control loop. */
  finish: number;
  /** Checkpoint distances measured from the finish line, increasing. */
  checkpoints: [number, number, number, number];
  obstacles: ObstacleDef[];
}

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
  name: string;
  version: number;
  seed: number | null;
  theme: ThemeId;
  /** `${id}@${version}`: identifies comparable recordings. */
  key: string;
  /** Main loop; index 0 is the finish line. */
  main: Corridor;
  shortcut: Corridor;
  corridors: Corridor[];
  gates: Gate[];
  obstacles: Obstacle[];
  start: { x: number; z: number; yaw: number };
  /** Main-centerline index range covered by the shortcut (entry -> exit). */
  shortcutRange: [number, number];
}

export const SAMPLE_SPACING = 1.5;
const START_BEHIND = 9; // meters behind the start/finish line

// ---------------------------------------------------------------------------
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

/** Samples a control polyline into an evenly spaced corridor. */
export function buildCorridor(name: string, control: ControlPoint[], closed: boolean): Corridor {
  return makeCorridor(name, sampleCenter(control, closed, SAMPLE_SPACING), closed);
}

/** Rotates a closed corridor so that the point nearest to distance s becomes index 0. */
function rotateClosed(c: Corridor, s: number): Corridor {
  const i0 = indexAtDistance(c, s);
  const pts = c.points.slice(i0).concat(c.points.slice(0, i0));
  return makeCorridor(c.name, pts, true);
}

/** Index of the centerline point closest to a distance along the corridor. */
export function indexAtDistance(c: Corridor, s: number): number {
  const L = c.length;
  const n = c.points.length;
  const t = c.closed ? ((s % L) + L) % L : clamp(s, 0, L);
  if (c.closed && t > c.dist[n - 1]) {
    // Between the last point and the wrap-around to 0.
    return t - c.dist[n - 1] < L - t ? n - 1 : 0;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c.dist[mid] <= t) lo = mid;
    else hi = mid;
  }
  return t - c.dist[lo] < c.dist[hi] - t ? lo : hi;
}

function makeGate(main: Corridor, index: number, label: string, ci: number): Gate {
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

function placeObstacle(o: ObstacleDef, main: Corridor, shortcut: Corridor): Obstacle {
  const c = o.on === 'main' ? main : shortcut;
  const i = indexAtDistance(c, o.s);
  const p = c.points[i];
  const t = tangentAt(c, i);
  const x = p.x + -t.z * o.offset;
  const z = p.z + t.x * o.offset;
  if (o.kind === 'pillar') return { kind: 'pillar', x, z, r: o.r, h: o.h };
  // Box local x = across, local z = along the track.
  return { kind: 'box', x, z, hx: o.wide, hz: o.long, rot: Math.atan2(t.x, t.z) + (o.rot ?? 0), h: o.h };
}

export function buildTrack(def: TrackDef): Track {
  const main = rotateClosed(buildCorridor('main', def.main, true), def.finish);
  const shortcut = buildCorridor('shortcut', def.shortcut, false);
  const labels = ['CP 1', 'CP 2', 'CP 3', 'CP 4'];
  const gates = def.checkpoints.map((s, i) => makeGate(main, i, labels[i], indexAtDistance(main, s)));
  gates.push(makeGate(main, 4, 'Chegada', 0));
  const fin = gates[4];
  const start = {
    x: fin.x - fin.dirX * START_BEHIND,
    z: fin.z - fin.dirZ * START_BEHIND,
    yaw: Math.atan2(fin.dirX, fin.dirZ),
  };
  const s0 = shortcut.points[0];
  const s1 = shortcut.points[shortcut.points.length - 1];
  return {
    id: def.id,
    name: def.name,
    version: def.version,
    seed: def.seed,
    theme: def.theme,
    key: `${def.id}@${def.version}`,
    main,
    shortcut,
    corridors: [main, shortcut],
    gates,
    obstacles: def.obstacles.map((o) => placeObstacle(o, main, shortcut)),
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

// Uniform grid over each corridor: every cell lists the segments that can be
// the closest one for points in the cell whose SDF is <= GRID_MARGIN. Queries
// inside/near the track only test a handful of segments; anything farther
// falls back to the exhaustive scan, so results are always exact.
const GRID_CELL = 10;
const GRID_MARGIN = 12;

interface CorridorGrid {
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  cells: (Int32Array | null)[];
}

const grids = new WeakMap<Corridor, CorridorGrid>();

function getGrid(c: Corridor): CorridorGrid {
  let g = grids.get(c);
  if (g) return g;
  const pts = c.points;
  const n = pts.length;
  const segs = c.closed ? n : n - 1;
  let maxHw = 0;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    maxHw = Math.max(maxHw, p.hw);
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  const pad = maxHw + GRID_MARGIN + GRID_CELL;
  minX -= pad;
  minZ -= pad;
  const cols = Math.ceil((maxX + pad - minX) / GRID_CELL);
  const rows = Math.ceil((maxZ + pad - minZ) / GRID_CELL);
  const lists: number[][] = Array.from({ length: cols * rows }, () => []);
  const reach = maxHw + GRID_MARGIN;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const c0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - minX) / GRID_CELL));
    const c1 = Math.min(cols - 1, Math.floor((Math.max(a.x, b.x) + reach - minX) / GRID_CELL));
    const r0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - minZ) / GRID_CELL));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(a.z, b.z) + reach - minZ) / GRID_CELL));
    for (let r = r0; r <= r1; r++) for (let q = c0; q <= c1; q++) lists[r * cols + q].push(i);
  }
  g = { minX, minZ, cols, rows, cells: lists.map((l) => (l.length ? Int32Array.from(l) : null)) };
  grids.set(c, g);
  return g;
}

export function corridorSdf(c: Corridor, x: number, z: number, out: SdfResult): SdfResult {
  const g = getGrid(c);
  const q = Math.floor((x - g.minX) / GRID_CELL);
  const r = Math.floor((z - g.minZ) / GRID_CELL);
  const cell = q >= 0 && r >= 0 && q < g.cols && r < g.rows ? g.cells[r * g.cols + q] : null;
  if (cell) {
    sdfOverSegments(c, x, z, out, cell);
    if (out.d <= GRID_MARGIN) return out;
  }
  return sdfOverSegments(c, x, z, out, null);
}

function sdfOverSegments(c: Corridor, x: number, z: number, out: SdfResult, list: Int32Array | null): SdfResult {
  const pts = c.points;
  const n = pts.length;
  const segs = list ? list.length : c.closed ? n : n - 1;
  let best = Infinity;
  let bx = 0;
  let bz = 0;
  for (let k = 0; k < segs; k++) {
    const i = list ? list[k] : k;
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
