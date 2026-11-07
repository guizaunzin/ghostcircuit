import { describe, expect, it } from 'vitest';
import { type Gate } from './track';
import { getTrack } from './maps';
import { createProgress, gateCrossFraction, updateProgress, type GateCrossing } from './race';
import { Simulation } from './simulation';
import { NO_INPUT } from './drone';

const track = getTrack();

/** Points just before/after a gate along its direction. */
function around(g: Gate, before: number, after: number, lateral = 0) {
  const nx = -g.dirZ;
  const nz = g.dirX;
  return {
    p0: { x: g.x - g.dirX * before + nx * lateral, z: g.z - g.dirZ * before + nz * lateral },
    p1: { x: g.x + g.dirX * after + nx * lateral, z: g.z + g.dirZ * after + nz * lateral },
  };
}

describe('gate crossing', () => {
  const g = track.gates[0];

  it('counts a forward crossing and returns the exact fraction', () => {
    const { p0, p1 } = around(g, 1, 3);
    expect(gateCrossFraction(g, p0.x, p0.z, p1.x, p1.z)).toBeCloseTo(0.25, 5);
  });

  it('ignores a backward crossing', () => {
    const { p0, p1 } = around(g, 1, 3);
    expect(gateCrossFraction(g, p1.x, p1.z, p0.x, p0.z)).toBe(-1);
  });

  it('ignores crossings outside the gate width', () => {
    const { p0, p1 } = around(g, 1, 1, g.halfWidth + 5);
    expect(gateCrossFraction(g, p0.x, p0.z, p1.x, p1.z)).toBe(-1);
  });

  it('detects crossings at very high speed (large step)', () => {
    const { p0, p1 } = around(g, 6, 6);
    expect(gateCrossFraction(g, p0.x, p0.z, p1.x, p1.z)).toBeCloseTo(0.5, 5);
  });

  it('does not count while staying on/inside the gate', () => {
    const { p1 } = around(g, 0, 0.5);
    const { p1: p2 } = around(g, 0, 1);
    expect(gateCrossFraction(g, p1.x, p1.z, p2.x, p2.z)).toBe(-1);
    // Exactly on the plane then moving forward does not count either.
    expect(gateCrossFraction(g, g.x, g.z, p2.x, p2.z)).toBe(-1);
  });
});

describe('race progress', () => {
  function cross(progress: ReturnType<typeof createProgress>, gi: number, t: number) {
    const out: GateCrossing[] = [];
    const { p0, p1 } = around(track.gates[gi], 0.5, 0.5);
    updateProgress(progress, track, p0.x, p0.z, p1.x, p1.z, t, 0.1, out);
    return out;
  }

  it('requires checkpoints in order', () => {
    const p = createProgress();
    expect(cross(p, 1, 1)).toHaveLength(0); // CP2 before CP1
    expect(cross(p, 4, 1)).toHaveLength(0); // finish before anything
    expect(cross(p, 0, 2)).toHaveLength(1);
    expect(cross(p, 0, 3)).toHaveLength(0); // same CP again
    expect(cross(p, 2, 4)).toHaveLength(0); // skip CP2
    expect(cross(p, 1, 5)).toHaveLength(1);
    expect(cross(p, 2, 6)).toHaveLength(1);
    expect(cross(p, 4, 7)).toHaveLength(0); // finish without CP4
    expect(cross(p, 3, 8)).toHaveLength(1);
    expect(p.finishTime).toBeNull();
    expect(cross(p, 4, 9)).toHaveLength(1);
    expect(p.finishTime).toBeCloseTo(9.05, 6);
    expect(p.splits).toEqual([2.05, 5.05, 6.05, 8.05].map((v) => expect.closeTo(v, 6)));
  });
});

describe('simulation race validity', () => {
  function teleportThrough(sim: Simulation, gi: number) {
    const { p0, p1 } = around(track.gates[gi], 0.2, 0.2);
    sim.drone.x = p0.x;
    sim.drone.z = p0.z;
    sim.drone.vx = (p1.x - p0.x) * 120;
    sim.drone.vz = (p1.z - p0.z) * 120;
    sim.drone.yaw = Math.atan2(track.gates[gi].dirX, track.gates[gi].dirZ);
    sim.step(NO_INPUT);
  }

  it('cannot finish by skipping checkpoints', () => {
    const sim = new Simulation(track);
    sim.skipCountdown();
    teleportThrough(sim, 0);
    teleportThrough(sim, 2);
    teleportThrough(sim, 3);
    teleportThrough(sim, 4);
    expect(sim.phase).toBe('racing');
    expect(sim.progress.next).toBe(1);
  });

  it('finishes after all checkpoints in order and the finish line', () => {
    const sim = new Simulation(track);
    sim.skipCountdown();
    for (const gi of [0, 1, 2, 3, 4]) teleportThrough(sim, gi);
    expect(sim.phase).toBe('finished');
    const fin = sim.events.find((e) => e.type === 'finish');
    expect(fin).toBeDefined();
  });

  it('ignores the start line at the beginning (drone starts behind it)', () => {
    const sim = new Simulation(track);
    sim.skipCountdown();
    for (let i = 0; i < 120; i++) sim.step({ throttle: 1, brake: 0, steer: 0, boost: false });
    expect(sim.phase).toBe('racing');
    expect(sim.progress.next).toBe(0);
  });
});
