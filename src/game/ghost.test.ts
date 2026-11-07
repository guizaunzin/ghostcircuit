import { describe, expect, it } from 'vitest';
import { GhostRecorder, isValidRecording, sampleGhost, SAMPLE_HZ, STRIDE, type GhostPose, type Recording } from './ghost';
import { createDrone } from './drone';
import { buildTrack } from './track';
import { Simulation, DT } from './simulation';
import { Autopilot } from './autopilot';
import { TRACK_KEY } from './storage';

const track = buildTrack();

function pose(): GhostPose {
  return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
}

describe('ghost recorder', () => {
  it('records at a fixed rate with a final exact sample', () => {
    const rec = new GhostRecorder();
    const d = createDrone(0, 0, 0);
    let t = 0;
    for (let i = 0; i <= 120 * 2; i++) {
      d.x = t * 10;
      rec.record(t, d);
      t += DT;
    }
    const r = rec.finish(TRACK_KEY, 2.0041, [0.5, 1, 1.5, 1.9], { x: 20.041, y: 2, z: 0, yaw: 0, pitch: 0, roll: 0 })!;
    expect(r).not.toBeNull();
    const n = r.samples.length / STRIDE;
    expect(n).toBeGreaterThanOrEqual(2 * SAMPLE_HZ);
    expect(n).toBeLessThanOrEqual(2 * SAMPLE_HZ + 2);
    expect(r.samples[(n - 1) * STRIDE]).toBeCloseTo(2.004, 3);
    expect(isValidRecording(r, TRACK_KEY)).toBe(true);
  });

  it('flags overflow instead of growing without limit', () => {
    const rec = new GhostRecorder();
    const d = createDrone(0, 0, 0);
    for (let t = 0; t < 400; t += 0.05) rec.record(t, d);
    expect(rec.overflow).toBe(true);
    expect(rec.finish(TRACK_KEY, 400, [1, 2, 3, 4], pose())).toBeNull();
  });
});

describe('ghost playback', () => {
  const rec: Recording = {
    format: 1,
    track: TRACK_KEY,
    time: 3,
    splits: [0.5, 1, 1.5, 2],
    samples: [0, 0, 2, 0, 3.1, 0, 0, 1, 10, 2, 0, -3.1, 0, 0, 2, 20, 2, 0, -3.0, 0.2, 0, 3, 30, 2, 0, -2.9, 0.2, 0],
    createdAt: 0,
  };

  it('returns exact samples at their timestamps and clamps outside', () => {
    expect(sampleGhost(rec, 1, pose()).x).toBeCloseTo(10);
    expect(sampleGhost(rec, -5, pose()).x).toBeCloseTo(0);
    expect(sampleGhost(rec, 99, pose()).x).toBeCloseTo(30);
  });

  it('interpolates smoothly and wraps angles along the short arc', () => {
    const p = sampleGhost(rec, 0.5, pose());
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(10);
    // Evenly spaced samples interpolate linearly through Catmull-Rom.
    expect(sampleGhost(rec, 1.5, pose()).x).toBeCloseTo(15, 5);
    // 3.1 -> -3.1 is a short hop across PI, not a full turn.
    expect(Math.abs(Math.abs(p.yaw) - Math.PI)).toBeLessThan(0.1);
    expect(sampleGhost(rec, 1.5, pose()).pitch).toBeCloseTo(0.1, 5);
  });

  it('reproduces a real lap in sync with the race clock', () => {
    const sim = new Simulation(track);
    sim.skipCountdown();
    const ap = new Autopilot(track, { aggression: 0.6, useBoost: true, useShortcut: false });
    const input = { throttle: 0, brake: 0, steer: 0, boost: false };
    const truth: { t: number; x: number; z: number }[] = [];
    let recording: Recording | null = null;
    for (let i = 0; i < 120 * 120 && sim.phase === 'racing'; i++) {
      ap.drive(sim.drone, input);
      sim.step(input);
      if (sim.phase === 'racing') truth.push({ t: sim.raceTime, x: sim.drone.x, z: sim.drone.z });
      for (const e of sim.events) if (e.type === 'finish') recording = e.recording;
      sim.events.length = 0;
    }
    expect(recording).not.toBeNull();
    const r = recording!;
    expect(isValidRecording(r, TRACK_KEY)).toBe(true);
    expect(r.time).toBeCloseTo(sim.progress.finishTime!, 3);
    let maxErr = 0;
    const p = pose();
    for (const s of truth) {
      sampleGhost(r, s.t, p);
      maxErr = Math.max(maxErr, Math.hypot(p.x - s.x, p.z - s.z));
    }
    // Sub-meter error everywhere, at speeds above 40 m/s.
    expect(maxErr).toBeLessThan(0.5);
    // A JSON round-trip (persistence) keeps it valid.
    expect(isValidRecording(JSON.parse(JSON.stringify(r)), TRACK_KEY)).toBe(true);
  });
});

describe('recording validation', () => {
  it('rejects malformed data', () => {
    expect(isValidRecording(null, TRACK_KEY)).toBe(false);
    expect(isValidRecording({}, TRACK_KEY)).toBe(false);
    const ok: Recording = {
      format: 1,
      track: TRACK_KEY,
      time: 1,
      splits: [0.2, 0.4, 0.6, 0.8],
      samples: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0],
      createdAt: 0,
    };
    expect(isValidRecording(ok, TRACK_KEY)).toBe(true);
    expect(isValidRecording({ ...ok, track: 'other@1' }, TRACK_KEY)).toBe(false);
    expect(isValidRecording({ ...ok, splits: [0.4, 0.2, 0.6, 0.8] }, TRACK_KEY)).toBe(false);
    expect(isValidRecording({ ...ok, samples: [...ok.samples, 1] }, TRACK_KEY)).toBe(false);
    expect(isValidRecording({ ...ok, samples: ok.samples.map((v, i) => (i === 3 ? NaN : v)) }, TRACK_KEY)).toBe(false);
    expect(isValidRecording({ ...ok, samples: [1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0] }, TRACK_KEY)).toBe(false);
    expect(isValidRecording({ ...ok, time: 5 }, TRACK_KEY)).toBe(false);
  });
});
