// Persistence of records, ghost recordings and preferences in localStorage.
// Versioned by format and track version; every read is validated and every
// failure degrades gracefully (the game never depends on storage working).

import { DIFFICULTIES, type Difficulty } from './ai';
import { isValidRecording, type Recording } from './ghost';

export const SAVE_FORMAT = 1;
/** Runs are stored per map: `ghostcircuit:runs:<mapId>`. */
export const RUNS_PREFIX = 'ghostcircuit:runs:';
/** v1 stored a single map under this key (now obsolete). */
export const LEGACY_RUNS_KEY = 'ghostcircuit:runs';
export const PREFS_KEY = 'ghostcircuit:prefs';
/** Race-mode results per map: `ghostcircuit:race:<mapId>`. */
export const RACE_PREFIX = 'ghostcircuit:race:';

/** Storage key for a track key like `arena-crepusculo@2`. */
export function runsKey(trackKey: string): string {
  return RUNS_PREFIX + trackKey.split('@')[0];
}

export type GhostChoice = 'last' | 'best';

export type ModePref = 'ghost' | 'race';

export interface Prefs {
  ghost: GhostChoice;
  muted: boolean;
  /** Selected map id. */
  track: string | null;
  mode: ModePref;
  difficulty: Difficulty;
  laps: number;
}

/** Best race-mode result for one configuration (difficulty + laps). */
export interface RaceRecord {
  bestPosition: number;
  bestTime: number;
  wins: number;
  races: number;
}

export type RaceRecords = Record<string, RaceRecord>;

export function raceRecordKey(difficulty: Difficulty, laps: number): string {
  return `${difficulty}-${laps}`;
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

export const DEFAULT_PREFS: Prefs = { ghost: 'last', muted: false, track: null, mode: 'ghost', difficulty: 'medio', laps: 2 };

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
        mode: p.mode === 'race' || p.mode === 'ghost' ? p.mode : DEFAULT_PREFS.mode,
        difficulty: DIFFICULTIES.includes(p.difficulty as Difficulty) ? (p.difficulty as Difficulty) : DEFAULT_PREFS.difficulty,
        laps: Number.isInteger(p.laps) && (p.laps as number) >= 1 && (p.laps as number) <= 3 ? (p.laps as number) : DEFAULT_PREFS.laps,
      };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  savePrefs(p: Prefs): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(
        PREFS_KEY,
        JSON.stringify({ ghost: p.ghost, muted: p.muted, track: p.track, mode: p.mode, difficulty: p.difficulty, laps: p.laps }),
      );
      return true;
    } catch {
      return false;
    }
  }

  loadRaceRecords(trackKey: string): RaceRecords {
    if (!this.storage) return {};
    const key = RACE_PREFIX + trackKey.split('@')[0];
    try {
      const raw = this.storage.getItem(key);
      if (!raw) return {};
      const d = JSON.parse(raw) as { format?: number; track?: string; results?: Record<string, unknown> };
      if (!d || d.format !== SAVE_FORMAT || d.track !== trackKey || typeof d.results !== 'object' || !d.results) {
        this.safeRemove(key);
        return {};
      }
      const out: RaceRecords = {};
      for (const [k, v] of Object.entries(d.results)) {
        const r = v as Partial<RaceRecord>;
        if (
          /^[a-z]+-[1-5]$/.test(k) &&
          Number.isInteger(r.bestPosition) && (r.bestPosition as number) >= 1 && (r.bestPosition as number) <= 6 &&
          typeof r.bestTime === 'number' && Number.isFinite(r.bestTime) && r.bestTime > 0 &&
          Number.isInteger(r.wins) && Number.isInteger(r.races) && (r.wins as number) >= 0 && (r.races as number) >= (r.wins as number)
        ) {
          out[k] = { bestPosition: r.bestPosition!, bestTime: r.bestTime, wins: r.wins!, races: r.races! };
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  saveRaceRecords(trackKey: string, records: RaceRecords): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(RACE_PREFIX + trackKey.split('@')[0], JSON.stringify({ format: SAVE_FORMAT, track: trackKey, results: records }));
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

export interface RaceResultUpdate {
  records: RaceRecords;
  record: RaceRecord;
  /** Better position, or same position with a faster time. */
  improved: boolean;
  firstWin: boolean;
}

/** Folds a finished race into the records for its configuration. */
export function applyRaceResult(records: RaceRecords, key: string, position: number, time: number): RaceResultUpdate {
  const prev = records[key];
  const win = position === 1;
  const record: RaceRecord = prev
    ? {
        bestPosition: Math.min(prev.bestPosition, position),
        bestTime: Math.min(prev.bestTime, time),
        wins: prev.wins + (win ? 1 : 0),
        races: prev.races + 1,
      }
    : { bestPosition: position, bestTime: time, wins: win ? 1 : 0, races: 1 };
  const improved = !prev || position < prev.bestPosition || (position === prev.bestPosition && time < prev.bestTime);
  return { records: { ...records, [key]: record }, record, improved, firstWin: win && (!prev || prev.wins === 0) };
}
