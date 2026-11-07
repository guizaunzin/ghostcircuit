// Shared evaluation used by the map scripts and tests: drives the autopilot
// around a track with and without the shortcut.
import { Autopilot, type AutopilotOptions } from '../src/game/autopilot';
import { Simulation } from '../src/game/simulation';
import type { Track } from '../src/game/track';

export interface LapStats {
  finished: boolean;
  time: number;
  collisions: number;
  recoveries: number;
}

export function autopilotLap(track: Track, opts: AutopilotOptions, maxSeconds = 120): LapStats {
  const sim = new Simulation(track);
  sim.skipCountdown();
  const ap = new Autopilot(track, opts);
  const input = { throttle: 0, brake: 0, steer: 0, boost: false };
  let collisions = 0;
  let recoveries = 0;
  for (let i = 0; i < 120 * maxSeconds && sim.phase === 'racing'; i++) {
    ap.drive(sim.drone, input);
    sim.step(input);
    for (const e of sim.events) {
      if (e.type === 'collision') collisions++;
      if (e.type === 'recovered') recoveries++;
    }
    sim.events.length = 0;
  }
  return { finished: sim.phase === 'finished', time: sim.progress.finishTime ?? Infinity, collisions, recoveries };
}
