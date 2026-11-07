// Seeded procedural track generator.
//
// Produces a TrackDef from a seed: a closed loop with a boost straight,
// mixed curves, a narrow shortcut between two checkpoints and obstacles that
// always leave room to pass. Deterministic for a given seed and JS engine.
// Generated maps are baked into generatedMaps.ts (see scripts/gen-map.ts) so
// players never depend on cross-browser floating point details.

import { mulberry32 } from './math';
import {
  buildCorridor,
  buildTrack,
  corridorSdf,
  tangentAt,
  type ControlPoint,
  type Corridor,
  type ObstacleDef,
  type ThemeId,
  type TrackDef,
} from './track';

export interface GenerateOptions {
  id: string;
  name: string;
  theme: ThemeId;
}

const SHORTCUT_HW = 3.8;
const DRONE_PASS = 3.2; // minimum gap (m) left beside a main-lane obstacle

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Returns null if no valid layout was found for this seed. */
export function generateTrackDef(seed: number, opts: GenerateOptions): TrackDef | null {
  const rand = mulberry32(seed);
  for (let attempt = 0; attempt < 60; attempt++) {
    const def = tryGenerate(rand, seed, opts);
    if (def) return def;
  }
  return null;
}

function tryGenerate(rand: () => number, seed: number, opts: GenerateOptions): TrackDef | null {
  const range = (a: number, b: number) => a + rand() * (b - a);

  // --- 1. Loop shape: radial noise with one wide gap for a straight -------
  const n = 8 + Math.floor(rand() * 4);
  const weights: number[] = [];
  for (let i = 0; i < n; i++) weights.push(i === 0 ? range(1.7, 2.1) : range(0.75, 1.25));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const a1 = range(0, 0.22);
  const a2 = range(0.05, 0.3);
  const a3 = range(0, 0.2);
  const a4 = range(0, 0.1);
  const p1 = range(0, Math.PI * 2);
  const p2 = range(0, Math.PI * 2);
  const p3 = range(0, Math.PI * 2);
  const p4 = range(0, Math.PI * 2);
  const stretch = range(0.75, 1.35);
  // "Pinches" pull points inward: hairpins, S-bends and technical sections.
  const pinches = new Set<number>();
  const pinchCount = 1 + Math.floor(rand() * 2.6);
  for (let i = 0; i < pinchCount; i++) pinches.add(2 + Math.floor(rand() * (n - 3)));

  const raw: { x: number; z: number; hw: number }[] = [];
  let theta = 0;
  for (let i = 0; i < n; i++) {
    let r =
      1 +
      a1 * Math.cos(theta + p1) +
      a2 * Math.cos(2 * theta + p2) +
      a3 * Math.cos(3 * theta + p3) +
      a4 * Math.cos(4 * theta + p4);
    r *= range(0.92, 1.08);
    if (pinches.has(i)) r *= range(0.4, 0.65);
    raw.push({
      x: Math.cos(theta) * r * stretch,
      z: Math.sin(theta) * r,
      hw: pinches.has(i) ? range(7.5, 8.5) : range(8, 10.5),
    });
    theta += (weights[i] / wsum) * Math.PI * 2;
  }
  // Straighten the wide gap (between point 0 and 1) with collinear points.
  const a = raw[0];
  const b = raw[1];
  const straight = [0.25, 0.5, 0.75].map((t) => ({
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    hw: 10.5,
  }));
  a.hw = 10.5;
  b.hw = 10;
  let pts = [a, ...straight, ...raw.slice(1)];
  if (rand() < 0.5) pts = pts.reverse();

  // Scale to the target length.
  const target = range(840, 1000);
  // Measure at a nominal size (sampling a unit-sized curve would be too coarse).
  const NOMINAL = 150;
  const unit = buildCorridor('tmp', pts.map((p) => [p.x * NOMINAL, p.z * NOMINAL, p.hw] as ControlPoint), true);
  const k = (target / unit.length) * NOMINAL;
  const main: ControlPoint[] = pts.map((p) => [round1(p.x * k), round1(p.z * k), round1(p.hw)]);
  const loop = buildCorridor('main', main, true);

  // --- 2. Geometry checks ---------------------------------------------------
  const radius = curvatureRadii(loop);
  for (let i = 0; i < loop.points.length; i++) {
    if (radius[i] < loop.points[i].hw + 3.5) return null; // inner wall would fold
  }
  if (!selfClearance(loop)) return null;
  const tight = radius.filter((r) => r < 45).length * 1.5; // meters of tight turns
  if (tight < 40) return null; // too easy / no technical section

  // --- 3. Finish line on the longest straight ---------------------------------
  const run = longestRun(radius, (r) => r > 160);
  const runLen = run.length * 1.5;
  if (runLen < 120) return null;
  const finishIdx = (run.start + Math.min(Math.round(45 / 1.5), Math.floor(run.length * 0.35))) % loop.points.length;
  const finish = loop.dist[finishIdx];

  // Work in finish-relative coordinates (same as buildTrack).
  const draft: TrackDef = {
    id: opts.id,
    name: opts.name,
    version: 1,
    seed,
    theme: opts.theme,
    main,
    shortcut: [
      [0, 0, SHORTCUT_HW],
      [1, 0, SHORTCUT_HW],
    ],
    finish,
    checkpoints: [1, 2, 3, 4],
    obstacles: [],
  };
  const rel = buildTrack(draft).main; // index 0 = finish
  const relRadius = curvatureRadii(rel);
  const L = rel.length;

  // --- 4. Shortcut chord --------------------------------------------------------
  const sc = findShortcut(rel, rand);
  if (!sc) return null;

  // --- 5. Checkpoints: the shortcut must sit between two consecutive gates ----
  const forbidden = (s: number) =>
    s < 60 || s > L - 45 || (s > sc.sEntry - 30 && s < sc.sExit + 30);
  const gates: number[] = [];
  for (let g = 1; g <= 4; g++) {
    const targetS = (L * g) / 5;
    let best = -1;
    let bestScore = Infinity;
    for (let s = targetS - L * 0.09; s <= targetS + L * 0.09; s += 3) {
      if (forbidden(s)) continue;
      if (gates.length && s - gates[gates.length - 1] < 90) continue;
      const i = Math.round(s / 1.5) % rel.points.length;
      // Prefer straight-ish spots (gates readable from afar).
      let minR = Infinity;
      for (let d = -8; d <= 8; d++) minR = Math.min(minR, relRadius[(i + d + rel.points.length) % rel.points.length]);
      const score = 1000 / minR + Math.abs(s - targetS) * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best < 0) return null;
    gates.push(Math.round(best));
  }
  if (L - gates[3] < 70) return null;

  // --- 6. Obstacles ---------------------------------------------------------------
  const obstacles: ObstacleDef[] = [];
  const count = 3 + Math.floor(rand() * 3);
  const used: number[] = [];
  for (let tries = 0; tries < 80 && obstacles.length < count; tries++) {
    const s = range(70, L - 50);
    if (gates.some((g) => Math.abs(g - s) < 35)) continue;
    if (Math.abs(s - sc.sEntry) < 35 || Math.abs(s - sc.sExit) < 35) continue;
    if (used.some((u) => Math.abs(u - s) < 55)) continue;
    const i = Math.round(s / 1.5) % rel.points.length;
    const hw = Math.min(...[-6, 0, 6].map((d) => rel.points[(i + d + rel.points.length) % rel.points.length].hw));
    const pillar = rand() < 0.65;
    const half = pillar ? range(1.3, 1.8) : range(1.5, 2.3);
    const maxOff = hw - half - DRONE_PASS;
    if (maxOff < 0) continue;
    const offset = round1((rand() * 2 - 1) * maxOff);
    used.push(s);
    obstacles.push(
      pillar
        ? { kind: 'pillar', on: 'main', s: Math.round(s), offset, r: round1(half), h: round1(range(8, 14)) }
        : { kind: 'box', on: 'main', s: Math.round(s), offset, wide: round1(half), long: round1(range(2.5, 4)), h: round1(range(3, 4.5)) },
    );
  }
  if (obstacles.length < 3) return null;
  // Shortcut slalom: two staggered pillars, each leaving one passable side.
  const scLen = buildCorridor('sc', sc.control, false).length;
  const side = rand() < 0.5 ? 1 : -1;
  obstacles.push({ kind: 'pillar', on: 'shortcut', s: Math.round(scLen * 0.42), offset: 1.3 * side, r: 1.2, h: 10 });
  obstacles.push({ kind: 'pillar', on: 'shortcut', s: Math.round(scLen * 0.68), offset: -1.3 * side, r: 1.2, h: 10 });

  return {
    ...draft,
    shortcut: sc.control,
    checkpoints: gates as [number, number, number, number],
    obstacles,
  };
}

/** Turning radius at each point (circumcircle of neighbours ±3 samples). */
export function curvatureRadii(c: Corridor): number[] {
  const n = c.points.length;
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p0 = c.points[(i - 3 + n) % n];
    const p1 = c.points[i];
    const p2 = c.points[(i + 3) % n];
    const ax = p1.x - p0.x;
    const az = p1.z - p0.z;
    const bx = p2.x - p1.x;
    const bz = p2.z - p1.z;
    const cross = Math.abs(ax * bz - az * bx);
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    const lc = Math.hypot(p2.x - p0.x, p2.z - p0.z);
    out[i] = cross < 1e-9 ? Infinity : (la * lb * lc) / (2 * cross);
  }
  return out;
}

/** Parts of the loop that are far apart along the track must not touch. */
function selfClearance(c: Corridor): boolean {
  const pts = c.points;
  const n = pts.length;
  const minArc = Math.round(70 / 1.5);
  for (let i = 0; i < n; i += 2) {
    const p = pts[i];
    for (let j = i + minArc; j < n - minArc + i && j < n; j += 2) {
      const q = pts[j];
      const need = p.hw + q.hw + 9;
      const dx = p.x - q.x;
      const dz = p.z - q.z;
      if (dx * dx + dz * dz < need * need) return false;
    }
  }
  return true;
}

function longestRun(values: number[], ok: (v: number) => boolean): { start: number; length: number } {
  const n = values.length;
  let best = { start: 0, length: 0 };
  // Start counting after a failing point so wrap-around runs are found whole.
  const first = values.findIndex((v) => !ok(v));
  if (first < 0) return { start: 0, length: n };
  let cur = 0;
  let curStart = 0;
  for (let k = 1; k <= n; k++) {
    const i = (first + k) % n;
    if (ok(values[i])) {
      if (cur === 0) curStart = i;
      cur++;
      if (cur > best.length) best = { start: curStart, length: cur };
    } else cur = 0;
  }
  return best;
}

interface ShortcutPlan {
  control: ControlPoint[];
  sEntry: number;
  sExit: number;
}

/**
 * Finds a chord between two points of the loop that is clearly shorter than
 * the track between them, leaves the main lane at a demanding angle and stays
 * away from every other part of the track.
 */
function findShortcut(main: Corridor, rand: () => number): ShortcutPlan | null {
  const n = main.points.length;
  const L = main.length;
  const sdf = { d: 0, nx: 0, nz: 0 };
  let best: ShortcutPlan | null = null;
  let bestScore = -Infinity;
  for (let sEntry = 120; sEntry < L - 330; sEntry += 9) {
    for (let arc = 110; arc <= 270; arc += 8) {
      const sExit = sEntry + arc;
      if (sExit > L - 120) continue;
      const i = Math.round(sEntry / 1.5) % n;
      const j = Math.round(sExit / 1.5) % n;
      const E = main.points[i];
      const X = main.points[j];
      const chord = Math.hypot(X.x - E.x, X.z - E.z);
      const saving = arc - chord;
      if (saving < 30 || saving > 85 || chord / arc > 0.82) continue;
      const dx = (X.x - E.x) / chord;
      const dz = (X.z - E.z) / chord;
      // Entry/exit angles relative to the main direction.
      const te = tangentAt(main, i);
      const tx = tangentAt(main, j);
      const entryAngle = Math.acos(Math.max(-1, Math.min(1, te.x * dx + te.z * dz)));
      const exitAngle = Math.acos(Math.max(-1, Math.min(1, tx.x * dx + tx.z * dz)));
      const deg = 180 / Math.PI;
      if (entryAngle * deg < 28 || entryAngle * deg > 75) continue;
      if (exitAngle * deg < 12 || exitAngle * deg > 75) continue;
      // Slight bow so the lane is not a dead-straight line.
      const bow = (rand() * 2 - 1) * Math.min(10, chord * 0.06);
      const nx = -dz;
      const nz = dx;
      const control: ControlPoint[] = [
        [round1(E.x), round1(E.z), SHORTCUT_HW],
        [round1(E.x + (X.x - E.x) * 0.33 + nx * bow), round1(E.z + (X.z - E.z) * 0.33 + nz * bow), SHORTCUT_HW],
        [round1(E.x + (X.x - E.x) * 0.67 + nx * bow * 0.7), round1(E.z + (X.z - E.z) * 0.67 + nz * bow * 0.7), SHORTCUT_HW],
        [round1(X.x), round1(X.z), SHORTCUT_HW],
      ];
      const lane = buildCorridor('sc', control, false);
      // Clearance: away from the entry/exit junctions the lane (and its
      // walls) must stay clear of the main track.
      let okLane = true;
      let maxAway = 0;
      for (const p of lane.points) {
        const dEntry = Math.hypot(p.x - E.x, p.z - E.z);
        const dExit = Math.hypot(p.x - X.x, p.z - X.z);
        corridorSdf(main, p.x, p.z, sdf);
        maxAway = Math.max(maxAway, sdf.d);
        const nearJunction = dEntry < E.hw * 2.6 + 6 || dExit < X.hw * 2.6 + 6;
        if (!nearJunction && sdf.d < SHORTCUT_HW + 5) {
          okLane = false;
          break;
        }
      }
      if (!okLane || maxAway < 14) continue;
      const score = -Math.abs(saving - 55) - Math.abs(entryAngle * deg - 48) * 0.4 + rand() * 4;
      if (score > bestScore) {
        bestScore = score;
        best = { control, sEntry, sExit };
      }
    }
  }
  return best;
}
