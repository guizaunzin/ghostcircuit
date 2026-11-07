import { describe, expect, it } from 'vitest';
import { MAPS, getTrack } from './maps';
import { generateTrackDef } from './generator';
import { corridorSdf, indexAtDistance, trackSdf, type SdfResult } from './track';
import { Simulation } from './simulation';
import { Autopilot, type AutopilotOptions } from './autopilot';

const sdf = (): SdfResult => ({ d: 0, nx: 0, nz: 0 });

function lap(id: string, opts: AutopilotOptions) {
  const track = getTrack(id);
  const sim = new Simulation(track);
  sim.skipCountdown();
  const ap = new Autopilot(track, opts);
  const input = { throttle: 0, brake: 0, steer: 0, boost: false };
  let recoveries = 0;
  for (let i = 0; i < 120 * 90 && sim.phase === 'racing'; i++) {
    ap.drive(sim.drone, input);
    sim.step(input);
    recoveries += sim.events.filter((e) => e.type === 'recovered').length;
    sim.events.length = 0;
  }
  return { finished: sim.phase === 'finished', time: sim.progress.finishTime ?? Infinity, recoveries };
}

describe('map catalog', () => {
  it('has unique ids and at least 5 maps', () => {
    const ids = MAPS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(MAPS.length).toBeGreaterThanOrEqual(5);
  });

  it('generated maps are exactly what their seed produces', () => {
    for (const def of MAPS.filter((m) => m.seed !== null)) {
      const again = generateTrackDef(def.seed!, { id: def.id, name: def.name, theme: def.theme });
      expect(again).not.toBeNull();
      expect({ ...again!, version: def.version }).toEqual(def);
    }
  });
});

describe.each(MAPS.map((m) => [m.name, m.id] as const))('%s', (_name, id) => {
  const track = getTrack(id);
  const def = MAPS.find((m) => m.id === id)!;

  it('keeps every obstacle inside its lane, away from walls and portals', () => {
    for (const o of def.obstacles) {
      const c = o.on === 'main' ? track.main : track.shortcut;
      const hw = c.points[indexAtDistance(c, o.s)].hw;
      const half = o.kind === 'pillar' ? o.r : o.wide;
      const nearGap = hw - Math.abs(o.offset) - half;
      const farGap = hw + Math.abs(o.offset) - half;
      if (o.on === 'main') {
        // Room to pass on both sides: obstacles sit in the lane, not in a wall.
        expect(nearGap, `${o.kind} at s=${o.s}`).toBeGreaterThanOrEqual(3);
      } else {
        // Shortcut slalom: one side is passable, and it never touches the wall.
        expect(farGap, `shortcut ${o.kind} at s=${o.s}`).toBeGreaterThanOrEqual(2.6);
        expect(nearGap, `shortcut ${o.kind} at s=${o.s}`).toBeGreaterThanOrEqual(0.8);
      }
    }
    // Same check on the built geometry (union of corridors).
    for (const o of track.obstacles) {
      const half = o.kind === 'pillar' ? o.r : o.hx;
      expect(trackSdf(track, o.x, o.z, sdf()).d).toBeLessThan(-(half + 0.8));
      for (const g of track.gates) expect(Math.hypot(g.x - o.x, g.z - o.z)).toBeGreaterThan(15);
    }
  });

  it('has checkpoints in order that cannot be bypassed', () => {
    const cps = def.checkpoints;
    for (let i = 1; i < 4; i++) expect(cps[i] - cps[i - 1]).toBeGreaterThan(60);
    expect(track.main.length - cps[3]).toBeGreaterThan(50);
    for (const g of track.gates) {
      // Gate ends lie outside the playable area: no way around a portal.
      expect(trackSdf(track, g.ax, g.az, sdf()).d).toBeGreaterThan(0);
      expect(trackSdf(track, g.bx, g.bz, sdf()).d).toBeGreaterThan(0);
      // Portals are never on the shortcut.
      expect(corridorSdf(track.shortcut, g.x, g.z, sdf()).d).toBeGreaterThan(2);
    }
  });

  it('places the shortcut between two consecutive checkpoints', () => {
    const [a, b] = track.shortcutRange;
    expect(a).toBeLessThan(b);
    const inside = track.gates.filter((g) => g.centerIndex >= a - 5 && g.centerIndex <= b + 5);
    expect(inside).toHaveLength(0);
    // And it really is shorter than the main line it replaces.
    const replaced = track.main.dist[b] - track.main.dist[a];
    expect(track.shortcut.length).toBeLessThan(replaced - 25);
  });

  it('starts inside the track, behind the finish line', () => {
    expect(trackSdf(track, track.start.x, track.start.z, sdf()).d).toBeLessThan(-3);
  });

  it('is completable by the autopilot on the main line and through the shortcut', () => {
    const calm = lap(id, { aggression: 0.35, useBoost: false, useShortcut: false });
    expect(calm.finished).toBe(true);
    expect(calm.recoveries).toBe(0);
    expect(calm.time).toBeGreaterThan(25);
    expect(calm.time).toBeLessThan(50);
    const short = lap(id, { aggression: 0.9, useBoost: true, useShortcut: true });
    expect(short.finished).toBe(true);
    expect(short.recoveries).toBe(0);
  });
});
