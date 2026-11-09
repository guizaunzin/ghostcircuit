// AI rivals for the race mode. Each rival drives with the same physics as the
// player; difficulty only changes how it drives (speed it aims for, how hard
// it corners, boost and shortcut use, line precision).

import { Autopilot } from './autopilot';
import { DRONE, forwardSpeed, type DroneInput, type DroneState } from './drone';
import { clamp, damp, mulberry32 } from './math';
import { corridorSdf, type SdfResult, type Track } from './track';

export type Difficulty = 'facil' | 'medio' | 'dificil' | 'insano';

export interface AiProfile {
  label: string;
  /** Corner speed (0..1). */
  aggression: number;
  /** Highest speed aimed for (m/s). Above DRONE.maxSpeed means it uses boost. */
  speedCap: number;
  /** Chance of taking the shortcut on each lap. */
  shortcutChance: number;
  /** Amplitude (m) of a slow wander around the racing line (imprecision). */
  wobble: number;
  /** Skill gap between rivals of the same race (0..1). */
  spread: number;
}

export const DIFFICULTIES: Difficulty[] = ['facil', 'medio', 'dificil', 'insano'];

export const AI_PROFILES: Record<Difficulty, AiProfile> = {
  facil: { label: 'Fácil', aggression: 0.12, speedCap: 24, shortcutChance: 0, wobble: 2.2, spread: 0.06 },
  medio: { label: 'Médio', aggression: 0.26, speedCap: 26.5, shortcutChance: 0.15, wobble: 1.3, spread: 0.05 },
  dificil: { label: 'Difícil', aggression: 0.6, speedCap: DRONE.maxSpeed, shortcutChance: 0.45, wobble: 0.6, spread: 0.04 },
  insano: { label: 'Insano', aggression: 0.9, speedCap: DRONE.boostMaxSpeed, shortcutChance: 0.8, wobble: 0.2, spread: 0.025 },
};

export const RIVALS = [
  { name: 'Vespa', color: '#ff4d5e' },
  { name: 'Falcão', color: '#8dff4f' },
  { name: 'Cometa', color: '#b46bff' },
  { name: 'Faísca', color: '#ffd23f' },
  { name: 'Corvo', color: '#ff8fd8' },
];

export interface RivalView {
  drone: DroneState;
  /** Finished racers no longer interact. */
  active: boolean;
}

const OVERTAKE_OFFSET = 3.4;

export class AiDriver {
  private main: Autopilot;
  private short: Autopilot;
  private current: Autopilot;
  private rand: () => number;
  private offset = 0;
  private baseOffset: number;
  private phase: number;
  private time = 0;
  private aggression: number;
  private speedCap: number;
  private onShortcut = false;
  private sdf: SdfResult = { d: 0, nx: 0, nz: 0 };

  constructor(
    private track: Track,
    readonly profile: AiProfile,
    readonly index: number,
    seed: number,
  ) {
    this.rand = mulberry32(seed * 7919 + index * 104729 + 17);
    // Each rival is a little different: the first ones are the strongest.
    const skill = 1 - profile.spread * index;
    this.aggression = clamp(profile.aggression * skill, 0.05, 1);
    this.speedCap = profile.speedCap * (1 - profile.spread * 0.5 * index);
    const boost = this.speedCap > DRONE.maxSpeed;
    this.main = new Autopilot(track, { aggression: this.aggression, useBoost: boost, useShortcut: false });
    this.short = new Autopilot(track, { aggression: this.aggression, useBoost: boost, useShortcut: true });
    this.current = this.main;
    this.baseOffset = (index % 2 === 0 ? 1 : -1) * (0.8 + 0.4 * (index % 3));
    this.phase = this.rand() * Math.PI * 2;
    this.chooseRoute();
  }

  /** Picks the line for the next lap (main or shortcut). */
  chooseRoute(): void {
    this.current = this.rand() < this.profile.shortcutChance ? this.short : this.main;
  }

  resync(d: DroneState): void {
    this.main.resync(d.x, d.z);
    this.short.resync(d.x, d.z);
  }

  drive(self: DroneState, rivals: RivalView[], dt: number, out: DroneInput): DroneInput {
    this.time += dt;
    // Narrow shortcut: stay on its centerline.
    corridorSdf(this.track.shortcut, self.x, self.z, this.sdf);
    const inShortcut = this.sdf.d < 0;
    corridorSdf(this.track.main, self.x, self.z, this.sdf);
    this.onShortcut = inShortcut && this.sdf.d > -1;
    const maxOffset = this.onShortcut ? 0.6 : 4;

    // Look for a rival right ahead: pass on the freer side, or lift off.
    const fx = Math.sin(self.yaw);
    const fz = Math.cos(self.yaw);
    let desired = this.baseOffset + Math.sin(this.time * 0.55 + this.phase) * this.profile.wobble;
    let cap = this.speedCap;
    const mySpeed = Math.max(0, forwardSpeed(self));
    for (const r of rivals) {
      if (!r.active || r.drone === self) continue;
      const rx = r.drone.x - self.x;
      const rz = r.drone.z - self.z;
      const ahead = rx * fx + rz * fz;
      const lateral = rx * -fz + rz * fx; // + = rival on our left
      if (ahead > 0 && ahead < 14 && Math.abs(lateral) < 3.2) {
        desired = lateral > 0 ? -OVERTAKE_OFFSET : OVERTAKE_OFFSET;
        const theirSpeed = Math.max(0, forwardSpeed(r.drone));
        // Too close and no room yet: don't ram them.
        if (ahead < 5 && mySpeed > theirSpeed) cap = Math.min(cap, theirSpeed + 1);
      }
    }
    desired = clamp(desired, -maxOffset, maxOffset);
    this.offset += (desired - this.offset) * damp(this.onShortcut ? 8 : 2.2, dt);
    this.offset = clamp(this.offset, -maxOffset, maxOffset);
    return this.current.drive(self, out, this.offset, cap);
  }
}
