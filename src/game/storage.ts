// Persistence of records, ghost recordings and preferences in localStorage.
// Versioned by format and track version; every read is validated and every
// failure degrades gracefully (the game never depends on storage working).

import { isValidRecording, type Recording } from './ghost';

export const SAVE_FORMAT = 1;
/** Runs are stored per map: `ghostcircuit:runs:<mapId>`. */
export const RUNS_PREFIX = 'ghostcircuit:runs:';
/** v1 stored a single map under this key (now obsolete). */
export const LEGACY_RUNS_KEY = 'ghostcircuit:runs';
export const PREFS_KEY = 'ghostcircuit:prefs';

/** Storage key for a track key like `arena-crepusculo@2`. */
export function runsKey(trackKey: string): string {
  return RUNS_PREFIX + trackKey.split('@')[0];
}

export type GhostChoice = 'last' | 'best';

export interface Prefs {
  ghost: GhostChoice;
  muted: boolean;
  /** Selected map id. */
  track: string | null;
}

export interface Runs {
  /** Last valid (completed) run. */
  last: Recording | null;
  /** Personal best. */
  best: Recording | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEFAULT_PREFS: Prefs = { ghost: 'last', muted: false, track: null };

/** Returns localStorage if it is actually usable, otherwise null. */
export function getBrowserStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const k = 'ghostcircuit:probe';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    return null;
  }
}

interface StoredRuns {
  format: number;
  track: string;
  last: Recording | null;
  /** 'last' when the best run is the same as the last one (saves space). */
  best: Recording | 'last' | null;
}

export class SaveStore {
  constructor(private storage: StorageLike | null) {
    this.safeRemove(LEGACY_RUNS_KEY);
  }

  get available(): boolean {
    return this.storage !== null;
  }

  loadRuns(trackKey: string): Runs {
    const empty: Runs = { last: null, best: null };
    if (!this.storage) return empty;
    const key = runsKey(trackKey);
    let raw: string | null;
    try {
      raw = this.storage.getItem(key);
    } catch {
      return empty;
    }
    if (!raw) return empty;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      this.safeRemove(key);
      return empty;
    }
    if (!data || typeof data !== 'object') return empty;
    const d = data as Partial<StoredRuns>;
    if (d.format !== SAVE_FORMAT || d.track !== trackKey) {
      // Different track/format version: old ghosts are not comparable.
      this.safeRemove(key);
      return empty;
    }
    const last = isValidRecording(d.last, trackKey) ? d.last : null;
    let best: Recording | null = null;
    if (d.best === 'last') best = last;
    else if (isValidRecording(d.best, trackKey)) best = d.best;
    // Consistency: the best can never be slower than the last valid run.
    if (last && (!best || last.time < best.time)) best = last;
    return { last, best };
  }

  /** Returns true if saved. Never throws. */
  saveRuns(trackKey: string, runs: Runs): boolean {
    if (!this.storage) return false;
    const key = runsKey(trackKey);
    const sameRun = runs.best !== null && runs.best === runs.last;
    const payload: StoredRuns = {
      format: SAVE_FORMAT,
      track: trackKey,
      last: runs.last,
      best: sameRun ? 'last' : runs.best,
    };
    try {
      this.storage.setItem(key, JSON.stringify(payload));
      return true;
    } catch {
      // Probably quota: keep at least the personal best.
      try {
        const minimal: StoredRuns = { format: SAVE_FORMAT, track: trackKey, last: runs.best, best: 'last' };
        this.storage.setItem(key, JSON.stringify(minimal));
        return true;
      } catch {
        return false;
      }
    }
  }

  loadPrefs(): Prefs {
    if (!this.storage) return { ...DEFAULT_PREFS };
    try {
      const raw = this.storage.getItem(PREFS_KEY);
      if (!raw) return { ...DEFAULT_PREFS };
      const p = JSON.parse(raw) as Partial<Prefs>;
      return {
        ghost: p.ghost === 'best' || p.ghost === 'last' ? p.ghost : DEFAULT_PREFS.ghost,
        muted: typeof p.muted === 'boolean' ? p.muted : DEFAULT_PREFS.muted,
        track: typeof p.track === 'string' && p.track.length < 80 ? p.track : null,
      };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  savePrefs(p: Prefs): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(PREFS_KEY, JSON.stringify({ ghost: p.ghost, muted: p.muted, track: p.track }));
      return true;
    } catch {
      return false;
    }
  }

  private safeRemove(key: string): void {
    try {
      this.storage?.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

export interface RunResult {
  runs: Runs;
  isNewBest: boolean;
  previousBest: number | null;
}

/** Applies a completed run: it always becomes "last", and "best" if faster. */
export function applyFinishedRun(runs: Runs, rec: Recording): RunResult {
  const previousBest = runs.best ? runs.best.time : null;
  const isNewBest = previousBest === null || rec.time < previousBest;
  return {
    runs: { last: rec, best: isNewBest ? rec : runs.best },
    isNewBest,
    previousBest,
  };
}

export function selectGhost(runs: Runs, choice: GhostChoice): Recording | null {
  if (choice === 'best') return runs.best ?? runs.last;
  return runs.last ?? runs.best;
}
