import { describe, expect, it } from 'vitest';
import { AiDriver, AI_PROFILES, DIFFICULTIES, type AiProfile, type Difficulty } from './ai';
import { Autopilot } from './autopilot';
import { DRONE, NO_INPUT, type DroneInput } from './drone';
import { getTrack, MAPS } from './maps';
import { createProgress, updateProgress, type GateCrossing } from './race';
import { gridSlots, Simulation, type SimEvent } from './simulation';
import { trackSdf } from './track';

const STRONG: AiProfile = { label: 'forte', aggression: 0.95, speedCap: DRONE.boostMaxSpeed, shortcutChance: 1, wobble: 0, spread: 0 };
const WEAK: AiProfile = { label: 'fraco', aggression: 0.1, speedCap: 22, shortcutChance: 0, wobble: 0, spread: 0 };

/** Runs a full race where the player is driven by an AI with the given profile. */
function race(mapId: string, difficulty: Difficulty, player: AiProfile, laps = 1) {
  const track = getTrack(mapId);
  const sim = new Simulation(track);
  sim.reset(null, { difficulty, laps, opponents: 3 });
  const pilot = new AiDriver(track, player, 5, 99);
  const views = sim.racers.map((r) => ({ drone: r.drone, active: true }));
  const input: DroneInput = { throttle: 0, brake: 0, steer: 0, boost: false };
  const events: SimEvent[] = [];
  let lastLap = 0;
  for (let i = 0; i < 120 * 60 * (laps + 1) && sim.phase !== 'finished'; i++) {
    if (sim.phase === 'racing') {
      if (sim.progress.lap !== lastLap) {
        lastLap = sim.progress.lap;
        pilot.chooseRoute();
      }
      pilot.drive(sim.drone, views, 1 / 120, input);
    } else Object.assign(input, NO_INPUT);
    sim.step(input);
    events.push(...sim.events);
    sim.events.length = 0;
  }
  return { sim, events };
}

/**
 * A player who holds throttle + boost the whole time and never brakes, on a
 * clean line without the shortcut (the play style reported as beating the
 * old Insano by 10 s). Optionally takes the shortcut too. Starts last, 2 laps.
 */
function boostHolderRace(mapId: string, difficulty: Difficulty, shortcut = false) {
  const track = getTrack(mapId);
  const sim = new Simulation(track);
  sim.reset(null, { difficulty, laps: 2, opponents: 3 });
  const line = new Autopilot(track, { aggression: 1, useBoost: true, useShortcut: shortcut });
  const input: DroneInput = { throttle: 0, brake: 0, steer: 0, boost: false };
  let position: number | null = null;
  for (let i = 0; i < 120 * 150 && sim.phase !== 'finished'; i++) {
    if (sim.phase === 'racing') {
      line.drive(sim.drone, input);
      input.throttle = 1;
      input.brake = 0;
      input.boost = true;
    } else Object.assign(input, NO_INPUT);
    sim.step(input);
    for (const e of sim.events) if (e.type === 'finish') position = e.position;
    sim.events.length = 0;
  }
  return position;
}

describe('multi-lap rules', () => {
  it('requires every checkpoint on every lap before the final finish', () => {
    const track = getTrack();
    const p = createProgress(2);
    const out: GateCrossing[] = [];
    const cross = (gi: number, t: number) => {
      const g = track.gates[gi];
      out.length = 0;
      updateProgress(p, track, g.x - g.dirX * 0.5, g.z - g.dirZ * 0.5, g.x + g.dirX * 0.5, g.z + g.dirZ * 0.5, t, 0.1, out);
      return out[0];
    };
    for (const gi of [0, 1, 2, 3]) cross(gi, gi + 1);
    const lap1 = cross(4, 5);
    expect(lap1.final).toBe(false);
    expect(p.lap).toBe(1);
    expect(p.next).toBe(0);
    expect(p.finishTime).toBeNull();
    expect(cross(4, 6)).toBeUndefined(); // finish line again without checkpoints
    for (const gi of [0, 1, 2, 3]) cross(gi, gi + 7);
    expect(cross(4, 12).final).toBe(true);
    expect(p.finishTime).toBeCloseTo(12.05, 6);
    expect(p.lapTimes).toHaveLength(2);
    expect(p.splits).toHaveLength(8);
  });
});

describe('starting grid', () => {
  it.each(MAPS.map((m) => m.id))('fits inside the track on %s', (id) => {
    const track = getTrack(id);
    const slots = gridSlots(track, 6);
    for (const s of slots) expect(trackSdf(track, s.x, s.z, { d: 0, nx: 0, nz: 0 }).d).toBeLessThan(-DRONE.radius - 0.5);
    for (let i = 0; i < slots.length; i++)
      for (let j = i + 1; j < slots.length; j++)
        expect(Math.hypot(slots[i].x - slots[j].x, slots[i].z - slots[j].z)).toBeGreaterThan(DRONE.radius * 2.5);
  });
});

describe('race mode', { timeout: 180000 }, () => {
  it('sets up rivals behind the player-free grid and starts the player last', () => {
    const sim = new Simulation(getTrack());
    sim.reset(null, { difficulty: 'medio', laps: 2, opponents: 3 });
    expect(sim.mode).toBe('race');
    expect(sim.racers).toHaveLength(4);
    expect(sim.ghost).toBeNull();
    expect(sim.playerPosition).toBe(4);
    expect(sim.racers.every((r) => r.progress.laps === 2)).toBe(true);
  });

  it('all rivals finish every map on every difficulty, faster when harder', () => {
    for (const m of MAPS) {
      const avg: number[] = [];
      for (const diff of DIFFICULTIES) {
        const sim = new Simulation(getTrack(m.id));
        sim.reset(null, { difficulty: diff, laps: 1, opponents: 3 });
        for (let i = 0; i < 120 * 90 && sim.racers.some((r) => !r.isPlayer && r.progress.finishTime === null); i++) {
          sim.step(NO_INPUT);
          sim.events.length = 0;
        }
        const times = sim.racers.filter((r) => !r.isPlayer).map((r) => r.progress.finishTime);
        expect(times.every((t) => t !== null), `${m.id} ${diff}`).toBe(true);
        avg.push((times as number[]).reduce((a, b) => a + b, 0) / times.length);
      }
      for (let k = 1; k < avg.length; k++) expect(avg[k], `${m.id}: ${avg.map((v) => v.toFixed(1))}`).toBeLessThan(avg[k - 1]);
    }
  });

  it('a strong pilot beats Fácil and Médio on every map, starting last', () => {
    for (const m of MAPS) {
      for (const diff of ['facil', 'medio'] as const) {
        const { sim, events } = race(m.id, diff, STRONG);
        const fin = events.find((e) => e.type === 'finish');
        expect(fin && fin.type === 'finish' ? fin.position : null, `${m.id} ${diff}`).toBe(1);
        expect(sim.racers[0].finishPosition).toBe(1);
      }
    }
  });

  it('holding boost all race beats Médio but loses to Insano on every map', () => {
    for (const m of MAPS) {
      expect(boostHolderRace(m.id, 'medio'), `${m.id} médio`).toBe(1);
      expect(boostHolderRace(m.id, 'insano'), `${m.id} insano`).toBeGreaterThan(1);
    }
  });

  it('even holding boost through the shortcut on a perfect line loses to Insano', () => {
    for (const m of MAPS) expect(boostHolderRace(m.id, 'insano', true), m.id).toBeGreaterThan(1);
  });

  it('a weak pilot cannot beat Insano', () => {
    const { events } = race(MAPS[0].id, 'insano', WEAK);
    const fin = events.find((e) => e.type === 'finish');
    expect(fin && fin.type === 'finish' ? fin.position : 0).toBe(4);
  });

  it('reports laps, overtakes and the final position; positions stay consistent', () => {
    const { sim, events } = race(MAPS[0].id, 'medio', STRONG, 2);
    expect(events.filter((e) => e.type === 'lap')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'checkpoint')).toHaveLength(8);
    expect(events.some((e) => e.type === 'position' && e.position < e.previous)).toBe(true);
    const positions = sim.racers.map((r) => r.position).sort();
    expect(positions).toEqual([1, 2, 3, 4]);
    // No recording: race-mode runs never become ghosts.
    const fin = events.find((e) => e.type === 'finish');
    expect(fin && fin.type === 'finish' ? fin.recording : 'x').toBeNull();
  });

  it('drones collide with each other but never leave the track or overlap', () => {
    const track = getTrack();
    const sim = new Simulation(track);
    sim.reset(null, { difficulty: 'insano', laps: 1, opponents: 5 });
    sim.skipCountdown();
    const sdf = { d: 0, nx: 0, nz: 0 };
    let minGap = Infinity;
    for (let i = 0; i < 120 * 20; i++) {
      // The player brakes on the line: everyone has to get around it.
      sim.step({ throttle: 0, brake: 1, steer: 0, boost: false });
      sim.events.length = 0;
      for (const r of sim.racers) expect(trackSdf(track, r.drone.x, r.drone.z, sdf).d + DRONE.radius).toBeLessThan(0.05);
      for (const a of sim.racers)
        for (const b of sim.racers)
          if (a !== b && a.progress.finishTime === null && b.progress.finishTime === null)
            minGap = Math.min(minGap, Math.hypot(a.drone.x - b.drone.x, a.drone.z - b.drone.z));
    }
    expect(minGap).toBeGreaterThan(DRONE.radius * 2 - 0.15);
    // Everyone got past the stopped player.
    expect(sim.racers.filter((r) => !r.isPlayer && r.progress.next >= 1).length).toBe(5);
  });

  it('is deterministic', () => {
    const a = race(MAPS[1].id, 'dificil', STRONG).sim;
    const b = race(MAPS[1].id, 'dificil', STRONG).sim;
    expect(a.racers.map((r) => r.progress.finishTime)).toEqual(b.racers.map((r) => r.progress.finishTime));
  });

  it('every difficulty profile is defined with a label', () => {
    for (const d of DIFFICULTIES) expect(AI_PROFILES[d].label.length).toBeGreaterThan(2);
  });
});
