import { describe, expect, it } from 'vitest';
import { applyFinishedRun, applyRaceResult, raceRecordKey, RACE_PREFIX, LEGACY_RUNS_KEY, PREFS_KEY, runsKey, SaveStore, selectGhost, type StorageLike } from './storage';

const TRACK_KEY = 'arena-crepusculo@2';
const RUNS_KEY = runsKey(TRACK_KEY);
import type { Recording } from './ghost';

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  quota = Infinity;
  getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string) {
    if (v.length > this.quota) throw new DOMException('quota', 'QuotaExceededError');
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

function run(time: number, tag = 0): Recording {
  return {
    format: 1,
    track: TRACK_KEY,
    time,
    splits: [time * 0.2, time * 0.4, time * 0.6, time * 0.8],
    samples: [0, tag, 0, 0, 0, 0, 0, time, tag, 1, 1, 0, 0, 0],
    createdAt: tag,
  };
}

describe('record keeping', () => {
  it('first run becomes both last and best', () => {
    const r = applyFinishedRun({ last: null, best: null }, run(40, 1));
    expect(r.isNewBest).toBe(true);
    expect(r.runs.last).toBe(r.runs.best);
  });

  it('a slower run updates last only; a faster run updates both', () => {
    let runs = applyFinishedRun({ last: null, best: null }, run(40, 1)).runs;
    const slower = applyFinishedRun(runs, run(45, 2));
    expect(slower.isNewBest).toBe(false);
    expect(slower.runs.last!.time).toBe(45);
    expect(slower.runs.best!.time).toBe(40);
    runs = slower.runs;
    const faster = applyFinishedRun(runs, run(38, 3));
    expect(faster.isNewBest).toBe(true);
    expect(faster.previousBest).toBe(40);
    expect(faster.runs.best!.time).toBe(38);
    expect(faster.runs.last!.time).toBe(38);
  });

  it('selects the ghost by preference with fallback', () => {
    const runs = { last: run(45, 2), best: run(40, 1) };
    expect(selectGhost(runs, 'last')!.time).toBe(45);
    expect(selectGhost(runs, 'best')!.time).toBe(40);
    expect(selectGhost({ last: null, best: null }, 'best')).toBeNull();
  });
});

describe('SaveStore', () => {
  it('round-trips runs and prefs', () => {
    const mem = new MemoryStorage();
    const store = new SaveStore(mem);
    const best = run(40, 1);
    const last = run(45, 2);
    expect(store.saveRuns(TRACK_KEY, { last, best })).toBe(true);
    expect(store.savePrefs({ ghost: 'best', muted: true, track: null, mode: 'ghost', difficulty: 'medio', laps: 2 })).toBe(true);
    const again = new SaveStore(mem);
    const loaded = again.loadRuns(TRACK_KEY);
    expect(loaded.best!.time).toBe(40);
    expect(loaded.last!.time).toBe(45);
    expect(again.loadPrefs()).toEqual({ ghost: 'best', muted: true, track: null, mode: 'ghost', difficulty: 'medio', laps: 2 });
  });

  it('stores a shared last/best run only once', () => {
    const mem = new MemoryStorage();
    const store = new SaveStore(mem);
    const r = run(40, 1);
    store.saveRuns(TRACK_KEY, { last: r, best: r });
    expect(JSON.parse(mem.getItem(RUNS_KEY)!).best).toBe('last');
    const loaded = store.loadRuns(TRACK_KEY);
    expect(loaded.best!.time).toBe(40);
    expect(loaded.last).toBe(loaded.best);
  });

  it('survives corrupted JSON and invalid recordings', () => {
    const mem = new MemoryStorage();
    mem.setItem(RUNS_KEY, '{not json');
    mem.setItem(PREFS_KEY, '[]oops');
    const store = new SaveStore(mem);
    expect(store.loadRuns(TRACK_KEY)).toEqual({ last: null, best: null });
    expect(store.loadPrefs()).toEqual({ ghost: 'last', muted: false, track: null, mode: 'ghost', difficulty: 'medio', laps: 2 });
    mem.setItem(RUNS_KEY, JSON.stringify({ format: 1, track: TRACK_KEY, last: { bogus: true }, best: run(40, 1) }));
    const loaded = store.loadRuns(TRACK_KEY);
    expect(loaded.last).toBeNull();
    expect(loaded.best!.time).toBe(40);
  });

  it('discards ghosts from another track version but keeps prefs', () => {
    const mem = new MemoryStorage();
    mem.setItem(RUNS_KEY, JSON.stringify({ format: 1, track: 'arena-crepusculo@1', last: run(40), best: 'last' }));
    mem.setItem(PREFS_KEY, JSON.stringify({ ghost: 'best', muted: false }));
    const store = new SaveStore(mem);
    expect(store.loadRuns(TRACK_KEY)).toEqual({ last: null, best: null });
    expect(mem.getItem(RUNS_KEY)).toBeNull();
    expect(store.loadPrefs().ghost).toBe('best');
  });

  it('works without storage and never throws', () => {
    const store = new SaveStore(null);
    expect(store.available).toBe(false);
    expect(store.saveRuns(TRACK_KEY, { last: run(40), best: run(40) })).toBe(false);
    expect(store.loadRuns(TRACK_KEY)).toEqual({ last: null, best: null });
    const throwing: StorageLike = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
      removeItem() {
        throw new Error('SecurityError');
      },
    };
    const s2 = new SaveStore(throwing);
    expect(s2.loadRuns(TRACK_KEY)).toEqual({ last: null, best: null });
    expect(s2.loadPrefs()).toEqual({ ghost: 'last', muted: false, track: null, mode: 'ghost', difficulty: 'medio', laps: 2 });
    expect(s2.saveRuns(TRACK_KEY, { last: run(40), best: run(40) })).toBe(false);
    expect(s2.savePrefs({ ghost: 'best', muted: true, track: null, mode: 'ghost', difficulty: 'medio', laps: 2 })).toBe(false);
  });

  it('falls back to saving only the best run when quota is tight', () => {
    const mem = new MemoryStorage();
    const store = new SaveStore(mem);
    const best = run(40, 1);
    const last = run(45, 2);
    mem.quota = JSON.stringify({ format: 1, track: TRACK_KEY, last: best, best: 'last' }).length + 5;
    expect(store.saveRuns(TRACK_KEY, { last, best })).toBe(true);
    const loaded = store.loadRuns(TRACK_KEY);
    expect(loaded.best!.time).toBe(40);
  });

  it('keeps runs separate per map and remembers the selected map', () => {
    const mem = new MemoryStorage();
    const store = new SaveStore(mem);
    store.saveRuns(TRACK_KEY, { last: run(40, 1), best: run(40, 1) });
    const other = 'neon-noturno@1';
    expect(store.loadRuns(other)).toEqual({ last: null, best: null });
    const r: Recording = { ...run(33, 5), track: other };
    store.saveRuns(other, { last: r, best: r });
    expect(store.loadRuns(other).best!.time).toBe(33);
    expect(store.loadRuns(TRACK_KEY).best!.time).toBe(40);
    store.savePrefs({ ghost: 'last', muted: false, track: 'neon-noturno', mode: 'ghost', difficulty: 'medio', laps: 2 });
    expect(new SaveStore(mem).loadPrefs().track).toBe('neon-noturno');
  });

  it('removes the obsolete single-map key from v1', () => {
    const mem = new MemoryStorage();
    mem.setItem(LEGACY_RUNS_KEY, '{"format":1,"track":"arena-crepusculo@1"}');
    new SaveStore(mem);
    expect(mem.getItem(LEGACY_RUNS_KEY)).toBeNull();
  });

  it('stores race results per map and configuration, and race prefs', () => {
    const mem = new MemoryStorage();
    const store = new SaveStore(mem);
    const key = raceRecordKey('dificil', 2);
    let r = applyRaceResult({}, key, 3, 70.5);
    expect(r.improved).toBe(true);
    expect(r.firstWin).toBe(false);
    r = applyRaceResult(r.records, key, 3, 72);
    expect(r.improved).toBe(false);
    r = applyRaceResult(r.records, key, 1, 69.1);
    expect(r.firstWin).toBe(true);
    expect(r.record).toEqual({ bestPosition: 1, bestTime: 69.1, wins: 1, races: 3 });
    expect(store.saveRaceRecords(TRACK_KEY, r.records)).toBe(true);
    expect(new SaveStore(mem).loadRaceRecords(TRACK_KEY)[key]).toEqual(r.record);
    expect(store.loadRaceRecords('neon-noturno@1')).toEqual({});
    // Other track version: discarded.
    expect(store.loadRaceRecords('arena-crepusculo@9')).toEqual({});
    // Garbage entries are dropped, valid ones kept.
    mem.setItem(RACE_PREFIX + 'arena-crepusculo', JSON.stringify({ format: 1, track: TRACK_KEY, results: { [key]: r.record, 'x-9': { bestPosition: -1 } } }));
    expect(Object.keys(store.loadRaceRecords(TRACK_KEY))).toEqual([key]);
    store.savePrefs({ ghost: 'last', muted: false, track: null, mode: 'race', difficulty: 'insano', laps: 3 });
    expect(store.loadPrefs()).toMatchObject({ mode: 'race', difficulty: 'insano', laps: 3 });
    mem.setItem('ghostcircuit:prefs', JSON.stringify({ mode: 'x', difficulty: 'impossivel', laps: 99 }));
    expect(store.loadPrefs()).toMatchObject({ mode: 'ghost', difficulty: 'medio', laps: 2 });
  });
});
