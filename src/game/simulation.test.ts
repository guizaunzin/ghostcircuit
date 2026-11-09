import { describe, expect, it } from 'vitest';
import { trackSdf } from './track';
import { getTrack } from './maps';
import { COUNTDOWN_TIME, DT, Simulation, type SimEvent } from './simulation';
import { Autopilot, type AutopilotOptions } from './autopilot';
import { DRONE, NO_INPUT, type DroneInput } from './drone';
import type { Recording } from './ghost';

const track = getTrack();

function runLap(opts: AutopilotOptions, ghost: Recording | null = null) {
  const sim = new Simulation(track);
  sim.reset(ghost);
  const ap = new Autopilot(track, opts);
  const input: DroneInput = { throttle: 0, brake: 0, steer: 0, boost: false };
  const events: SimEvent[] = [];
  for (let i = 0; i < 120 * 150 && sim.phase !== 'finished'; i++) {
    if (sim.phase === 'racing') ap.drive(sim.drone, input);
    sim.step(input);
    events.push(...sim.events);
    sim.events.length = 0;
  }
  return { sim, events };
}

describe('simulation', () => {
  it('runs the countdown before the race starts and keeps the drone still', () => {
    const sim = new Simulation(track);
    const x = sim.drone.x;
    const z = sim.drone.z;
    let goAt = -1;
    for (let i = 0; i < 400 && goAt < 0; i++) {
      sim.step({ throttle: 1, brake: 0, steer: 1, boost: true });
      if (sim.events.some((e) => e.type === 'go')) goAt = i;
    }
    expect(goAt * DT).toBeCloseTo(COUNTDOWN_TIME, 1);
    expect(sim.drone.x).toBeCloseTo(x, 6);
    expect(sim.drone.z).toBeCloseTo(z, 6);
    expect(sim.events.filter((e) => e.type === 'countdown').map((e) => (e.type === 'countdown' ? e.n : 0))).toEqual([3, 2, 1]);
  });

  it('completes a full lap with the autopilot (track is drivable)', () => {
    const { sim, events } = runLap({ aggression: 0.5, useBoost: true, useShortcut: false });
    expect(sim.phase).toBe('finished');
    expect(sim.progress.splits).toHaveLength(4);
    const fin = events.find((e) => e.type === 'finish');
    expect(fin && fin.type === 'finish' && fin.recording).toBeTruthy();
    // Target lap length: 30-60 s with practice.
    expect(sim.progress.finishTime!).toBeGreaterThan(25);
    expect(sim.progress.finishTime!).toBeLessThan(60);
  });

  it('completes a lap through the shortcut', () => {
    const { sim } = runLap({ aggression: 0.8, useBoost: true, useShortcut: true });
    expect(sim.phase).toBe('finished');
  });

  it('is deterministic', () => {
    const a = runLap({ aggression: 0.6, useBoost: true, useShortcut: false });
    const b = runLap({ aggression: 0.6, useBoost: true, useShortcut: false });
    expect(a.sim.progress.finishTime).toBe(b.sim.progress.finishTime);
  });

  it('reports checkpoint deltas against the ghost splits', () => {
    const first = runLap({ aggression: 0.4, useBoost: false, useShortcut: false });
    const fin = first.events.find((e) => e.type === 'finish');
    const ghost = fin && fin.type === 'finish' ? fin.recording : null;
    expect(ghost).not.toBeNull();
    const second = runLap({ aggression: 0.9, useBoost: true, useShortcut: false }, ghost);
    const cps = second.events.filter((e) => e.type === 'checkpoint');
    expect(cps).toHaveLength(4);
    for (const e of cps) {
      if (e.type !== 'checkpoint') continue;
      expect(e.delta).not.toBeNull();
      expect(e.delta!).toBeCloseTo(e.time - ghost!.splits[e.index], 6);
    }
    const fin2 = second.events.find((e) => e.type === 'finish');
    expect(fin2 && fin2.type === 'finish' && fin2.delta! < 0).toBe(true);
  });

  it('reset restores the initial state of an attempt', () => {
    const { sim } = runLap({ aggression: 0.5, useBoost: true, useShortcut: false });
    const ghost = { format: 1 } as unknown as Recording;
    sim.reset(ghost);
    const fresh = new Simulation(track);
    expect(sim.phase).toBe('countdown');
    expect(sim.raceTime).toBe(0);
    expect(sim.progress).toEqual({ next: 0, lap: 0, laps: 1, splits: [], lapTimes: [], finishTime: null });
    expect(sim.drone).toEqual(fresh.drone);
    expect(sim.drone.boost).toBe(1);
    expect(sim.recorder.sampleCount).toBe(0);
    expect(sim.ghost).toBe(ghost);
  });

  it('never lets the drone leave the playable area when hugging walls', () => {
    const sim = new Simulation(track);
    sim.skipCountdown();
    const sdf = { d: 0, nx: 0, nz: 0 };
    let worst = -Infinity;
    for (let i = 0; i < 120 * 20; i++) {
      const steer = Math.sin(i / 90) > 0 ? 1 : -0.6;
      sim.step({ throttle: 1, brake: 0, steer, boost: i % 400 < 200 });
      trackSdf(track, sim.drone.x, sim.drone.z, sdf);
      worst = Math.max(worst, sdf.d + DRONE.radius);
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('recovers to the last safe point when outside the playable area', () => {
    const sim = new Simulation(track);
    sim.skipCountdown();
    for (let i = 0; i < 240; i++) sim.step({ throttle: 1, brake: 0, steer: 0, boost: false });
    sim.events.length = 0;
    sim.drone.x = 500;
    sim.drone.z = 500;
    sim.step(NO_INPUT);
    expect(sim.events.some((e) => e.type === 'recovered')).toBe(true);
    const sdf = trackSdf(track, sim.drone.x, sim.drone.z, { d: 0, nx: 0, nz: 0 });
    expect(sdf.d).toBeLessThan(0);
    expect(sim.drone.vx).toBe(0);
  });

  it('collisions slow the drone and emit feedback', () => {
    const sim = new Simulation(track);
    sim.skipCountdown();
    // Accelerate, then turn hard into the side wall of the straight.
    for (let i = 0; i < 180; i++) sim.step({ throttle: 1, brake: 0, steer: 0, boost: false });
    sim.events.length = 0;
    let hit = false;
    for (let i = 0; i < 240 && !hit; i++) {
      sim.step({ throttle: 1, brake: 0, steer: 1, boost: false });
      hit = sim.events.some((e) => e.type === 'collision');
    }
    expect(hit).toBe(true);
    expect(sim.drone.hitFlash).toBeGreaterThan(0);
  });
});
