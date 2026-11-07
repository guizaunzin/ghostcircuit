// The whole game simulation for one attempt: countdown, drone, race rules,
// ghost recording and out-of-bounds recovery. Fixed timestep, deterministic,
// independent from rendering, audio and input devices.

import { copyDrone, createDrone, DRONE, NO_INPUT, speedOf, stepDrone, type CollisionInfo, type DroneInput, type DroneState } from './drone';
import { GhostRecorder, type Recording } from './ghost';
import { createProgress, updateProgress, type GateCrossing, type RaceProgress } from './race';
import { nearestIndex, tangentAt, trackSdf, type SdfResult, type Track } from './track';
import { TRACK_KEY } from './storage';

export const SIM_HZ = 120;
export const DT = 1 / SIM_HZ;
export const COUNTDOWN_STEP = 0.75;
export const COUNTDOWN_TIME = COUNTDOWN_STEP * 3;
/** Distance outside the playable area that triggers a recovery. */
export const OUT_OF_BOUNDS = 2.5;

export type SimPhase = 'countdown' | 'racing' | 'finished';

export type SimEvent =
  | { type: 'countdown'; n: number }
  | { type: 'go' }
  | { type: 'checkpoint'; index: number; time: number; delta: number | null }
  | { type: 'finish'; time: number; recording: Recording | null; delta: number | null }
  | { type: 'collision'; impact: number; x: number; z: number }
  | { type: 'recovered' };

export class Simulation {
  readonly track: Track;
  drone: DroneState;
  phase: SimPhase = 'countdown';
  /** Seconds left in the countdown. */
  countdown = COUNTDOWN_TIME;
  /** Race time in seconds (0 at "GO"). */
  raceTime = 0;
  progress: RaceProgress = createProgress();
  /** Immutable recording raced against in this attempt. */
  ghost: Recording | null = null;
  events: SimEvent[] = [];
  readonly recorder = new GhostRecorder();
  /** Total steps since reset (for diagnostics/tests). */
  steps = 0;

  private lastSafe = { x: 0, z: 0, yaw: 0 };
  private safeTimer = 0;
  private stuckTimer = 0;
  private lastCountdownBeat = 4;
  private readonly crossings: GateCrossing[] = [];
  private readonly collision: CollisionInfo = { impact: 0, x: 0, z: 0 };
  private readonly sdf: SdfResult = { d: 0, nx: 0, nz: 0 };

  constructor(track: Track) {
    this.track = track;
    this.drone = createDrone(track.start.x, track.start.z, track.start.yaw);
    this.reset(null);
  }

  /** Restores everything to the initial state of an attempt. */
  reset(ghost: Recording | null): void {
    const s = this.track.start;
    copyDrone(createDrone(s.x, s.z, s.yaw), this.drone);
    this.phase = 'countdown';
    this.countdown = COUNTDOWN_TIME;
    this.raceTime = 0;
    this.progress = createProgress();
    this.ghost = ghost;
    this.events = [];
    this.recorder.reset();
    this.steps = 0;
    this.lastSafe = { x: s.x, z: s.z, yaw: s.yaw };
    this.safeTimer = 0;
    this.stuckTimer = 0;
    this.lastCountdownBeat = 4;
  }

  /** Skips the countdown (used by tests). */
  skipCountdown(): void {
    while (this.phase === 'countdown') this.step(NO_INPUT);
  }

  step(input: DroneInput): void {
    this.steps++;
    if (this.phase === 'countdown') {
      this.countdown -= DT;
      const beat = Math.ceil(this.countdown / COUNTDOWN_STEP);
      if (beat < this.lastCountdownBeat && beat > 0) {
        this.lastCountdownBeat = beat;
        this.events.push({ type: 'countdown', n: beat });
      }
      // Keep the drone hovering in place (bob + idle attitude).
      stepDrone(this.drone, NO_INPUT, DT, this.track, this.collision);
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.phase = 'racing';
        this.raceTime = 0;
        this.recorder.record(0, this.drone);
        this.events.push({ type: 'go' });
      }
      return;
    }

    const d = this.drone;
    const p0x = d.x;
    const p0z = d.z;
    const t0 = this.raceTime;
    const effective = this.phase === 'finished' ? FINISHED_INPUT : input;

    // Safety net: if the drone somehow ended up outside the playable area
    // (or with invalid numbers), put it back on the last safe point.
    if (this.isOutside()) {
      this.recover();
      return;
    }

    stepDrone(d, effective, DT, this.track, this.collision);
    if (this.collision.impact > 1.5) {
      this.events.push({ type: 'collision', impact: this.collision.impact, x: this.collision.x, z: this.collision.z });
    }

    if (this.phase === 'finished') return;

    this.raceTime += DT;

    // Race rules: swept test from the previous to the current position.
    this.crossings.length = 0;
    updateProgress(this.progress, this.track, p0x, p0z, d.x, d.z, t0, DT, this.crossings);
    for (const c of this.crossings) {
      const i = c.gate.index;
      if (i < 4) {
        const g = this.ghost && this.ghost.splits[i] !== undefined ? this.ghost.splits[i] : null;
        this.events.push({ type: 'checkpoint', index: i, time: c.time, delta: g === null ? null : c.time - g });
      } else {
        this.finish(c, p0x, p0z, t0);
        return;
      }
    }

    this.recorder.record(this.raceTime, d);
    this.updateRecovery(input);
  }

  private finish(c: GateCrossing, p0x: number, p0z: number, t0: number): void {
    const d = this.drone;
    const f = (c.time - t0) / DT;
    const recording = this.recorder.finish(TRACK_KEY, c.time, this.progress.splits, {
      x: p0x + (d.x - p0x) * f,
      y: d.y,
      z: p0z + (d.z - p0z) * f,
      yaw: d.yaw,
      pitch: d.pitch,
      roll: d.roll,
    });
    this.phase = 'finished';
    this.raceTime = c.time;
    this.events.push({
      type: 'finish',
      time: c.time,
      recording,
      delta: this.ghost ? c.time - this.ghost.time : null,
    });
  }

  private updateRecovery(input: DroneInput): void {
    const d = this.drone;
    const outside = this.isOutside();
    // Stuck: pushing throttle without moving for a while.
    if (input.throttle > 0.5 && speedOf(d) < 1.2) this.stuckTimer += DT;
    else this.stuckTimer = 0;

    if (outside || this.stuckTimer > 3) {
      this.recover();
      return;
    }
    this.safeTimer += DT;
    if (this.safeTimer >= 0.5) {
      this.safeTimer = 0;
      if (this.sdf.d < -(DRONE.radius + 2) && d.hitFlash <= 0 && speedOf(d) > 2) {
        this.lastSafe.x = d.x;
        this.lastSafe.z = d.z;
        // Align with the closest corridor's direction of travel.
        this.lastSafe.yaw = this.trackYawAt(d.x, d.z, d.yaw);
      }
    }
  }

  private isOutside(): boolean {
    const d = this.drone;
    if (!Number.isFinite(d.x) || !Number.isFinite(d.z) || !Number.isFinite(d.vx) || !Number.isFinite(d.vz)) return true;
    trackSdf(this.track, d.x, d.z, this.sdf);
    return this.sdf.d > OUT_OF_BOUNDS;
  }

  private trackYawAt(x: number, z: number, fallback: number): number {
    let bestYaw = fallback;
    let bestD = Infinity;
    for (const c of this.track.corridors) {
      const i = nearestIndex(c, x, z);
      const p = c.points[i];
      const dd = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (dd < bestD) {
        bestD = dd;
        const t = tangentAt(c, i);
        bestYaw = Math.atan2(t.x, t.z);
      }
    }
    return bestYaw;
  }

  /** Puts the drone back on the last safe point. */
  recover(): void {
    const d = this.drone;
    d.x = this.lastSafe.x;
    d.z = this.lastSafe.z;
    d.yaw = this.lastSafe.yaw;
    d.vx = 0;
    d.vz = 0;
    d.yawRate = 0;
    d.pitch = 0;
    d.roll = 0;
    this.stuckTimer = 0;
    this.events.push({ type: 'recovered' });
  }

  /** Index of the next gate (0..3 checkpoints, 4 finish). */
  get nextGate(): number {
    return this.progress.next;
  }
}

const FINISHED_INPUT: DroneInput = { throttle: 0, brake: 0.35, steer: 0, boost: false };
