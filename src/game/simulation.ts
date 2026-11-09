// The whole game simulation for one attempt: countdown, drones, race rules,
// ghost recording, AI rivals and out-of-bounds recovery. Fixed timestep,
// deterministic, independent from rendering, audio and input devices.
//
// Two modes:
//  - ghost: single lap against a recorded ghost (no collisions with it);
//  - race: N laps against AI drones that use the same physics, with
//    drone-to-drone collisions and live positions.

import { AiDriver, AI_PROFILES, RIVALS, type Difficulty, type RivalView } from './ai';
import { copyDrone, createDrone, DRONE, NO_INPUT, speedOf, stepDrone, type CollisionInfo, type DroneInput, type DroneState } from './drone';
import { GhostRecorder, type Recording } from './ghost';
import { createProgress, gatesPassed, updateProgress, type GateCrossing, type RaceProgress } from './race';
import { indexAtDistance, nearestIndex, tangentAt, trackSdf, type SdfResult, type Track } from './track';

export const SIM_HZ = 120;
export const DT = 1 / SIM_HZ;
export const COUNTDOWN_STEP = 0.75;
export const COUNTDOWN_TIME = COUNTDOWN_STEP * 3;
/** Distance outside the playable area that triggers a recovery. */
export const OUT_OF_BOUNDS = 2.5;

export type SimPhase = 'countdown' | 'racing' | 'finished';
export type GameMode = 'ghost' | 'race';

export interface RaceSetup {
  difficulty: Difficulty;
  laps: number;
  /** Number of AI rivals (1..5). */
  opponents: number;
}

export type SimEvent =
  | { type: 'countdown'; n: number }
  | { type: 'go' }
  | { type: 'checkpoint'; index: number; lap: number; time: number; delta: number | null }
  | { type: 'lap'; lap: number; time: number }
  | { type: 'finish'; time: number; recording: Recording | null; delta: number | null; position: number | null }
  | { type: 'position'; position: number; previous: number }
  | { type: 'rivalFinish'; racer: number; time: number; position: number }
  | { type: 'collision'; impact: number; x: number; z: number }
  | { type: 'recovered' };

export interface Racer {
  index: number;
  name: string;
  color: string;
  isPlayer: boolean;
  drone: DroneState;
  progress: RaceProgress;
  ai: AiDriver | null;
  /** Live position (1 = leading). */
  position: number;
  finishPosition: number | null;
  input: DroneInput;
  lastSafe: { x: number; z: number; yaw: number };
  safeTimer: number;
  stuckTimer: number;
}

export class Simulation {
  readonly track: Track;
  mode: GameMode = 'ghost';
  setup: RaceSetup | null = null;
  racers: Racer[] = [];
  /** The player's drone (racers[0].drone). */
  drone: DroneState;
  phase: SimPhase = 'countdown';
  /** Seconds left in the countdown. */
  countdown = COUNTDOWN_TIME;
  /** Race time in seconds (0 at "GO"). */
  raceTime = 0;
  progress: RaceProgress = createProgress();
  /** Immutable recording raced against in this attempt (ghost mode). */
  ghost: Recording | null = null;
  events: SimEvent[] = [];
  readonly recorder = new GhostRecorder();
  /** Total steps since reset (for diagnostics/tests). */
  steps = 0;

  private lastCountdownBeat = 4;
  private finishedCount = 0;
  private rankTimer = 0;
  private readonly crossings: GateCrossing[] = [];
  private readonly collision: CollisionInfo = { impact: 0, x: 0, z: 0 };
  private readonly sdf: SdfResult = { d: 0, nx: 0, nz: 0 };
  private rivalViews: RivalView[] = [];

  constructor(track: Track) {
    this.track = track;
    this.drone = createDrone(track.start.x, track.start.z, track.start.yaw);
    this.reset(null);
  }

  /**
   * Restores everything to the initial state of an attempt.
   * Without `setup` it is a ghost-mode attempt; with it, a race against AI.
   */
  reset(ghost: Recording | null, setup: RaceSetup | null = null): void {
    this.mode = setup ? 'race' : 'ghost';
    this.setup = setup ? { ...setup, laps: clampInt(setup.laps, 1, 5), opponents: clampInt(setup.opponents, 1, RIVALS.length) } : null;
    this.phase = 'countdown';
    this.countdown = COUNTDOWN_TIME;
    this.raceTime = 0;
    this.ghost = setup ? null : ghost;
    this.events = [];
    this.recorder.reset();
    this.steps = 0;
    this.lastCountdownBeat = 4;
    this.finishedCount = 0;
    this.rankTimer = 0;

    const laps = this.setup ? this.setup.laps : 1;
    const count = this.setup ? this.setup.opponents + 1 : 1;
    const slots = this.setup ? gridSlots(this.track, count) : [this.track.start];
    // The player starts at the back of the grid.
    const playerSlot = slots[count - 1];
    copyDrone(createDrone(playerSlot.x, playerSlot.z, playerSlot.yaw), this.drone);
    const player = makeRacer(0, 'Você', '#ff7a2f', true, this.drone, laps, playerSlot);
    this.racers = [player];
    if (this.setup) {
      const profile = AI_PROFILES[this.setup.difficulty];
      for (let k = 0; k < this.setup.opponents; k++) {
        const slot = slots[k];
        const drone = createDrone(slot.x, slot.z, slot.yaw);
        const r = makeRacer(k + 1, RIVALS[k].name, RIVALS[k].color, false, drone, laps, slot);
        r.ai = new AiDriver(this.track, profile, k, (this.track.seed ?? 7) + laps);
        this.racers.push(r);
      }
    }
    this.progress = player.progress;
    this.rivalViews = this.racers.map((r) => ({ drone: r.drone, active: true }));
    this.updateRanks(false);
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
      // Keep the drones hovering in place (bob + idle attitude).
      for (const r of this.racers) stepDrone(r.drone, NO_INPUT, DT, this.track, this.collision);
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.phase = 'racing';
        this.raceTime = 0;
        if (this.mode === 'ghost') this.recorder.record(0, this.drone);
        this.events.push({ type: 'go' });
      }
      return;
    }

    const t0 = this.raceTime;
    // The clock keeps running for the rivals after the player finishes.
    const playerDone = this.phase === 'finished';
    const raceOver = this.racers.every((r) => r.progress.finishTime !== null);
    if (!playerDone || (this.mode === 'race' && !raceOver)) this.raceTime += DT;

    for (const r of this.racers) {
      const d = r.drone;
      const done = r.progress.finishTime !== null;
      if (r.isPlayer) r.input = done ? FINISHED_INPUT : input;
      else if (r.ai) {
        if (done) r.ai.drive(d, this.rivalViews, DT, r.input).throttle *= 0.6;
        else r.ai.drive(d, this.rivalViews, DT, r.input);
      }

      // Safety net: if a drone ended up outside the playable area (or with
      // invalid numbers), put it back on its last safe point.
      if (this.isOutside(d)) {
        this.recover(r);
        continue;
      }
      const p0x = d.x;
      const p0z = d.z;
      stepDrone(d, r.input, DT, this.track, this.collision);
      if (r.isPlayer && this.collision.impact > 1.5) {
        this.events.push({ type: 'collision', impact: this.collision.impact, x: this.collision.x, z: this.collision.z });
      }
      if (done) continue;

      // Race rules: swept test from the previous to the current position.
      this.crossings.length = 0;
      updateProgress(r.progress, this.track, p0x, p0z, d.x, d.z, t0, DT, this.crossings);
      for (const c of this.crossings) this.onCrossing(r, c, p0x, p0z, t0);
      if (r.progress.finishTime === null) this.updateRecovery(r);
    }

    if (this.mode === 'race') {
      this.resolveDroneContacts();
      if (++this.rankTimer >= 6) {
        this.rankTimer = 0;
        this.updateRanks(true);
      }
    }
    if (this.mode === 'ghost' && this.phase === 'racing') this.recorder.record(this.raceTime, this.drone);
  }

  private onCrossing(r: Racer, c: GateCrossing, p0x: number, p0z: number, t0: number): void {
    const i = c.gate.index;
    if (!r.isPlayer) {
      if (i === 4 && !c.final) {
        r.ai?.chooseRoute();
        r.ai?.resync(r.drone);
      }
      if (c.final) {
        r.finishPosition = ++this.finishedCount;
        this.rivalViews[r.index].active = false;
        this.events.push({ type: 'rivalFinish', racer: r.index, time: c.time, position: r.finishPosition });
      }
      return;
    }
    if (i < 4) {
      const g = this.ghost && this.ghost.splits[i] !== undefined ? this.ghost.splits[i] : null;
      this.events.push({ type: 'checkpoint', index: i, lap: c.lap, time: c.time, delta: g === null ? null : c.time - g });
    } else if (!c.final) {
      this.events.push({ type: 'lap', lap: c.lap + 1, time: c.time });
    } else {
      this.finish(r, c, p0x, p0z, t0);
    }
  }

  private finish(r: Racer, c: GateCrossing, p0x: number, p0z: number, t0: number): void {
    const d = r.drone;
    let recording: Recording | null = null;
    if (this.mode === 'ghost') {
      const f = (c.time - t0) / DT;
      recording = this.recorder.finish(this.track.key, c.time, this.progress.splits, {
        x: p0x + (d.x - p0x) * f,
        y: d.y,
        z: p0z + (d.z - p0z) * f,
        yaw: d.yaw,
        pitch: d.pitch,
        roll: d.roll,
      });
    }
    let position: number | null = null;
    if (this.mode === 'race') {
      r.finishPosition = ++this.finishedCount;
      position = r.finishPosition;
      this.rivalViews[r.index].active = false;
    }
    this.phase = 'finished';
    if (this.mode === 'ghost') this.raceTime = c.time;
    this.events.push({
      type: 'finish',
      time: c.time,
      recording,
      delta: this.ghost ? c.time - this.ghost.time : null,
      position,
    });
  }

  // ---------------------------------------------------------------------------
  // Positions

  /** Ranks racers: finished ones by finish order, the rest by progress. */
  private updateRanks(emit: boolean): void {
    if (this.racers.length < 2) return;
    const main = this.track.main;
    const L = main.length;
    const scores = this.racers.map((r) => {
      if (r.finishPosition !== null) return 1e9 - r.finishPosition;
      const next = Math.min(r.progress.next, 4);
      const gateIdx = this.track.gates[next].centerIndex;
      const prevIdx = this.track.gates[next === 0 ? 4 : next - 1].centerIndex;
      const idx = nearestIndex(main, r.drone.x, r.drone.z);
      let remaining = (main.dist[gateIdx] - main.dist[idx] + L) % L;
      const span = (main.dist[gateIdx] - main.dist[prevIdx] + L) % L || L;
      if (remaining > span + 30) remaining = 0; // just past a gate on a tight bend
      return gatesPassed(r.progress) * 10000 - remaining;
    });
    const order = this.racers.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
    const player = this.racers[0];
    const previous = player.position;
    order.forEach((ri, k) => (this.racers[ri].position = k + 1));
    if (emit && this.phase === 'racing' && player.position !== previous) {
      this.events.push({ type: 'position', position: player.position, previous });
    }
  }

  // ---------------------------------------------------------------------------
  // Drone-to-drone contacts (race mode). Finished drones no longer collide.

  private resolveDroneContacts(): void {
    const minD = DRONE.radius * 2;
    for (let i = 0; i < this.racers.length; i++) {
      const a = this.racers[i];
      if (a.progress.finishTime !== null) continue;
      for (let j = i + 1; j < this.racers.length; j++) {
        const b = this.racers[j];
        if (b.progress.finishTime !== null) continue;
        const da = a.drone;
        const db = b.drone;
        let nx = db.x - da.x;
        let nz = db.z - da.z;
        const dist = Math.hypot(nx, nz);
        if (dist >= minD) continue;
        if (dist < 1e-6) {
          nx = Math.sin(da.yaw);
          nz = Math.cos(da.yaw);
        } else {
          nx /= dist;
          nz /= dist;
        }
        const pen = minD - dist;
        da.x -= nx * pen * 0.5;
        da.z -= nz * pen * 0.5;
        db.x += nx * pen * 0.5;
        db.z += nz * pen * 0.5;
        // Equal masses: exchange the approaching velocity with a soft bounce.
        const vn = (db.vx - da.vx) * nx + (db.vz - da.vz) * nz;
        if (vn < 0) {
          const j2 = (-vn * (1 + 0.25)) / 2;
          da.vx -= nx * j2;
          da.vz -= nz * j2;
          db.vx += nx * j2;
          db.vz += nz * j2;
          const impact = -vn;
          if ((a.isPlayer || b.isPlayer) && impact > 2) {
            const pd = a.isPlayer ? da : db;
            pd.hitFlash = Math.max(pd.hitFlash, 0.25);
            this.events.push({ type: 'collision', impact, x: (da.x + db.x) / 2, z: (da.z + db.z) / 2 });
          }
        }
        this.clampToTrack(da);
        this.clampToTrack(db);
      }
    }
  }

  private clampToTrack(d: DroneState): void {
    trackSdf(this.track, d.x, d.z, this.sdf);
    const pen = this.sdf.d + DRONE.radius;
    if (pen > 0) {
      d.x -= this.sdf.nx * pen;
      d.z -= this.sdf.nz * pen;
    }
  }

  // ---------------------------------------------------------------------------
  // Recovery

  private updateRecovery(r: Racer): void {
    const d = r.drone;
    const outside = this.isOutside(d);
    // Stuck: pushing throttle without moving for a while.
    if (r.input.throttle > 0.5 && speedOf(d) < 1.2) r.stuckTimer += DT;
    else r.stuckTimer = 0;

    if (outside || r.stuckTimer > 3) {
      this.recover(r);
      return;
    }
    r.safeTimer += DT;
    if (r.safeTimer >= 0.5) {
      r.safeTimer = 0;
      if (this.sdf.d < -(DRONE.radius + 2) && d.hitFlash <= 0 && speedOf(d) > 2) {
        r.lastSafe.x = d.x;
        r.lastSafe.z = d.z;
        // Align with the closest corridor's direction of travel.
        r.lastSafe.yaw = this.trackYawAt(d.x, d.z, d.yaw);
      }
    }
  }

  private isOutside(d: DroneState): boolean {
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

  /** Puts a drone (the player's by default) back on its last safe point. */
  recover(r: Racer = this.racers[0]): void {
    const d = r.drone;
    d.x = r.lastSafe.x;
    d.z = r.lastSafe.z;
    d.yaw = r.lastSafe.yaw;
    d.vx = 0;
    d.vz = 0;
    d.yawRate = 0;
    d.pitch = 0;
    d.roll = 0;
    r.stuckTimer = 0;
    r.ai?.resync(d);
    if (r.isPlayer) this.events.push({ type: 'recovered' });
  }

  /** Index of the next gate (0..3 checkpoints, 4 finish). */
  get nextGate(): number {
    return this.progress.next;
  }

  /** The player's live position (1 = leading). */
  get playerPosition(): number {
    return this.racers[0].position;
  }
}

const FINISHED_INPUT: DroneInput = { throttle: 0, brake: 0.35, steer: 0, boost: false };

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(v) ? v : min)));
}

function makeRacer(
  index: number,
  name: string,
  color: string,
  isPlayer: boolean,
  drone: DroneState,
  laps: number,
  slot: { x: number; z: number; yaw: number },
): Racer {
  return {
    index,
    name,
    color,
    isPlayer,
    drone,
    progress: createProgress(laps),
    ai: null,
    position: index + 1,
    finishPosition: null,
    input: { throttle: 0, brake: 0, steer: 0, boost: false },
    lastSafe: { x: slot.x, z: slot.z, yaw: slot.yaw },
    safeTimer: 0,
    stuckTimer: 0,
  };
}

/**
 * Starting grid behind the finish line: two staggered columns, front to
 * back. Slot 0 is pole position.
 */
export function gridSlots(track: Track, count: number): { x: number; z: number; yaw: number }[] {
  const main = track.main;
  const out: { x: number; z: number; yaw: number }[] = [];
  for (let k = 0; k < count; k++) {
    const back = 6 + k * 6;
    const i = indexAtDistance(main, main.length - back);
    const p = main.points[i];
    const t = tangentAt(main, i);
    const lateral = (k % 2 === 0 ? 1 : -1) * Math.min(3.2, p.hw - 3);
    out.push({ x: p.x + -t.z * lateral, z: p.z + t.x * lateral, yaw: Math.atan2(t.x, t.z) });
  }
  return out;
}
