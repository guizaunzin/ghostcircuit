// Ghost recording (position + orientation with race-relative timestamps) and
// smooth, time-synchronised playback.

import { catmull1, clamp, lerp, lerpAngle } from './math';
import type { DroneState } from './drone';

export const GHOST_FORMAT = 1;
export const SAMPLE_HZ = 20;
/** t, x, y, z, yaw, pitch, roll */
export const STRIDE = 7;
/** 5 minutes at 20 Hz. Longer runs are still timed but not saved as ghosts. */
export const MAX_SAMPLES = 6000;

export interface Recording {
  format: number;
  /** `${trackId}@${trackVersion}` */
  track: string;
  /** Total race time in seconds. */
  time: number;
  /** Checkpoint split times (4 entries). */
  splits: number[];
  /** Flat array of samples, STRIDE numbers each. */
  samples: number[];
  createdAt: number;
}

export interface GhostPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export class GhostRecorder {
  private buf: number[] = [];
  private nextT = 0;
  overflow = false;

  reset(): void {
    this.buf = [];
    this.nextT = 0;
    this.overflow = false;
  }

  get sampleCount(): number {
    return this.buf.length / STRIDE;
  }

  /** Called every simulation step with the current race time. */
  record(t: number, d: DroneState): void {
    if (t + 1e-9 < this.nextT) return;
    this.push(t, d.x, d.y, d.z, d.yaw, d.pitch, d.roll);
    this.nextT += 1 / SAMPLE_HZ;
  }

  private push(t: number, x: number, y: number, z: number, yaw: number, pitch: number, roll: number): void {
    if (this.sampleCount >= MAX_SAMPLES) {
      this.overflow = true;
      return;
    }
    this.buf.push(r3(t), r2(x), r2(y), r2(z), r3(yaw), r3(pitch), r3(roll));
  }

  /**
   * Closes the recording with an exact final sample at the finish time.
   * Returns null if the recording overflowed.
   */
  finish(trackKey: string, time: number, splits: number[], final: GhostPose): Recording | null {
    // Drop samples that are not strictly before the finish time.
    while (this.buf.length >= STRIDE && this.buf[this.buf.length - STRIDE] >= r3(time)) {
      this.buf.length -= STRIDE;
    }
    this.push(time, final.x, final.y, final.z, final.yaw, final.pitch, final.roll);
    if (this.overflow) return null;
    return {
      format: GHOST_FORMAT,
      track: trackKey,
      time: r3(time),
      splits: splits.map(r3),
      samples: this.buf.slice(),
      createdAt: Date.now(),
    };
  }
}

/** Finds i such that t_i <= t < t_{i+1} (clamped). */
function findSegment(s: number[], n: number, t: number): number {
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid * STRIDE] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Samples a recording at race time t. Positions use Catmull-Rom for smooth
 * curves, angles use shortest-arc interpolation. Clamps to the ends.
 */
export function sampleGhost(rec: Recording, t: number, out: GhostPose): GhostPose {
  const s = rec.samples;
  const n = s.length / STRIDE;
  if (n === 0) return out;
  if (n === 1 || t <= s[0]) return readSample(s, 0, out);
  const lastT = s[(n - 1) * STRIDE];
  if (t >= lastT) return readSample(s, n - 1, out);
  const i = findSegment(s, n, t);
  const j = Math.min(n - 1, i + 1);
  const t0 = s[i * STRIDE];
  const t1 = s[j * STRIDE];
  const u = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
  const h = Math.max(0, i - 1) * STRIDE;
  const a = i * STRIDE;
  const b = j * STRIDE;
  const c = Math.min(n - 1, j + 1) * STRIDE;
  out.x = catmull1(s[h + 1], s[a + 1], s[b + 1], s[c + 1], u);
  out.y = lerp(s[a + 2], s[b + 2], u);
  out.z = catmull1(s[h + 3], s[a + 3], s[b + 3], s[c + 3], u);
  out.yaw = lerpAngle(s[a + 4], s[b + 4], u);
  out.pitch = lerp(s[a + 5], s[b + 5], u);
  out.roll = lerp(s[a + 6], s[b + 6], u);
  return out;
}

function readSample(s: number[], i: number, out: GhostPose): GhostPose {
  const o = i * STRIDE;
  out.x = s[o + 1];
  out.y = s[o + 2];
  out.z = s[o + 3];
  out.yaw = s[o + 4];
  out.pitch = s[o + 5];
  out.roll = s[o + 6];
  return out;
}

/** Validates an untrusted object (e.g. from localStorage). */
export function isValidRecording(r: unknown, trackKey: string): r is Recording {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  if (o.format !== GHOST_FORMAT || o.track !== trackKey) return false;
  if (typeof o.time !== 'number' || !Number.isFinite(o.time) || o.time <= 0 || o.time > 3600) return false;
  if (!Array.isArray(o.splits) || o.splits.length !== 4) return false;
  let prev = 0;
  for (const v of o.splits) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= prev || v > o.time) return false;
    prev = v;
  }
  if (!Array.isArray(o.samples)) return false;
  const s = o.samples as unknown[];
  if (s.length < STRIDE * 2 || s.length % STRIDE !== 0 || s.length > STRIDE * MAX_SAMPLES) return false;
  let lastT = -Infinity;
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e5) return false;
    if (i % STRIDE === 0) {
      if (v <= lastT) return false;
      lastT = v;
    }
  }
  if (Math.abs(lastT - o.time) > 0.01) return false;
  return true;
}
