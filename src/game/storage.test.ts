import { describe, expect, it } from 'vitest';
import { applyFinishedRun, PREFS_KEY, RUNS_KEY, SaveStore, selectGhost, TRACK_KEY, type StorageLike } from './storage';
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
    expect(store.saveRuns({ last, best })).toBe(true);
    expect(store.savePrefs({ ghost: 'best', muted: true })).toBe(true);
    const again = new SaveStore(mem);
    const loaded = again.loadRuns();
    expect(loaded.best!.time).toBe(40);
    expect(loaded.last!.time).toBe(45);
    expect(again.loadPrefs()).toEqual({ ghost: 'best', muted: true });
  });

  it('stores a shared last/best run only once', () => {
    const mem = new MemoryStorage();
    const store = new SaveStore(mem);
    const r = run(40, 1);
    store.saveRuns({ last: r, best: r });
    expect(JSON.parse(mem.getItem(RUNS_KEY)!).best).toBe('last');
    const loaded = store.loadRuns();
    expect(loaded.best!.time).toBe(40);
    expect(loaded.last).toBe(loaded.best);
  });

  it('survives corrupted JSON and invalid recordings', () => {
    const mem = new MemoryStorage();
    mem.setItem(RUNS_KEY, '{not json');
    mem.setItem(PREFS_KEY, '[]oops');
    const store = new SaveStore(mem);
    expect(store.loadRuns()).toEqual({ last: null, best: null });
    expect(store.loadPrefs()).toEqual({ ghost: 'last', muted: false });
    mem.setItem(RUNS_KEY, JSON.stringify({ format: 1, track: TRACK_KEY, last: { bogus: true }, best: run(40, 1) }));
    const loaded = store.loadRuns();
    expect(loaded.last).toBeNull();
    expect(loaded.best!.time).toBe(40);
  });

  it('discards ghosts from another track version but keeps prefs', () => {
    const mem = new MemoryStorage();
    mem.setItem(RUNS_KEY, JSON.stringify({ format: 1, track: 'arena-crepusculo@0', last: run(40), best: 'last' }));
    mem.setItem(PREFS_KEY, JSON.stringify({ ghost: 'best', muted: false }));
    const store = new SaveStore(mem);
    expect(store.loadRuns()).toEqual({ last: null, best: null });
    expect(mem.getItem(RUNS_KEY)).toBeNull();
    expect(store.loadPrefs().ghost).toBe('best');
  });

  it('works without storage and never throws', () => {
    const store = new SaveStore(null);
    expect(store.available).toBe(false);
    expect(store.saveRuns({ last: run(40), best: run(40) })).toBe(false);
    expect(store.loadRuns()).toEqual({ last: null, best: null });
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
    expect(s2.loadRuns()).toEqual({ last: null, best: null });
    expect(s2.loadPrefs()).toEqual({ ghost: 'last', muted: false });
    expect(s2.saveRuns({ last: run(40), best: run(40) })).toBe(false);
    expect(s2.savePrefs({ ghost: 'best', muted: true })).toBe(false);
  });

  it('falls back to saving only the best run when quota is tight', () => {
    const mem = new MemoryStorage();
    const store = new SaveStore(mem);
    const best = run(40, 1);
    const last = run(45, 2);
    mem.quota = JSON.stringify({ format: 1, track: TRACK_KEY, last: best, best: 'last' }).length + 5;
    expect(store.saveRuns({ last, best })).toBe(true);
    const loaded = store.loadRuns();
    expect(loaded.best!.time).toBe(40);
  });
});
