// Race rules: ordered checkpoints, direction-aware crossing detection that is
// robust at high speed (swept segment test between simulation steps).

import type { Gate, Track } from './track';

export const CHECKPOINT_COUNT = 4;
export const FINISH_GATE = 4;

export interface RaceProgress {
  /** Index of the gate that must be crossed next (0..3 checkpoints, 4 = finish, 5 = done). */
  next: number;
  /** Race time at which each checkpoint was crossed. */
  splits: number[];
  finishTime: number | null;
}

export function createProgress(): RaceProgress {
  return { next: 0, splits: [], finishTime: null };
}

export interface GateCrossing {
  gate: Gate;
  /** Exact (sub-step) race time of the crossing. */
  time: number;
  /** Interpolated crossing position. */
  x: number;
  z: number;
}

/**
 * Tests if the motion p0 -> p1 crosses the gate forward (along gate.dir) and
 * within its width. Returns the fraction along the motion (0..1) or -1.
 * Moving backward through a gate, or staying inside it, never counts.
 */
export function gateCrossFraction(gate: Gate, p0x: number, p0z: number, p1x: number, p1z: number): number {
  const s0 = (p0x - gate.x) * gate.dirX + (p0z - gate.z) * gate.dirZ;
  const s1 = (p1x - gate.x) * gate.dirX + (p1z - gate.z) * gate.dirZ;
  if (!(s0 < 0 && s1 >= 0)) return -1;
  const f = s0 / (s0 - s1);
  const cx = p0x + (p1x - p0x) * f;
  const cz = p0z + (p1z - p0z) * f;
  // Lateral offset from the gate center (normal = left perpendicular).
  const lat = (cx - gate.x) * -gate.dirZ + (cz - gate.z) * gate.dirX;
  const half = Math.hypot(gate.ax - gate.bx, gate.az - gate.bz) * 0.5;
  if (Math.abs(lat) > half) return -1;
  return f;
}

/**
 * Advances race progress for a step from (p0, t0) to (p1, t0 + dt).
 * Only the next expected gate can be validated, so skipping checkpoints or
 * crossing out of order never progresses the race.
 */
export function updateProgress(
  progress: RaceProgress,
  track: Track,
  p0x: number,
  p0z: number,
  p1x: number,
  p1z: number,
  t0: number,
  dt: number,
  out: GateCrossing[],
): void {
  if (progress.next > FINISH_GATE) return;
  const gate = track.gates[progress.next];
  const f = gateCrossFraction(gate, p0x, p0z, p1x, p1z);
  if (f < 0) return;
  // Millisecond precision: identical to what is stored with the ghost.
  const time = Math.round((t0 + dt * f) * 1000) / 1000;
  const crossing: GateCrossing = { gate, time, x: p0x + (p1x - p0x) * f, z: p0z + (p1z - p0z) * f };
  if (progress.next < CHECKPOINT_COUNT) {
    progress.splits.push(time);
  } else {
    progress.finishTime = time;
  }
  progress.next++;
  out.push(crossing);
}

export function isFinished(progress: RaceProgress): boolean {
  return progress.finishTime !== null && progress.splits.length === CHECKPOINT_COUNT;
}
