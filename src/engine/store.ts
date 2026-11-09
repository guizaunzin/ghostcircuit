// Tiny external store for UI state that changes on game transitions only
// (never per frame). Consumed by React through useSyncExternalStore.

import type { Difficulty } from '../game/ai';
import type { GameMode } from '../game/simulation';
import type { GhostChoice, RaceRecords } from '../game/storage';

export type Phase = 'menu' | 'countdown' | 'racing' | 'paused' | 'finished';

export interface Standing {
  name: string;
  color: string;
  isPlayer: boolean;
  /** Final position, or live position for drones still racing. */
  position: number;
  /** Total race time; null while still racing. */
  time: number | null;
}

export interface FinishResult {
  mode: GameMode;
  time: number;
  /** Race mode: final position (1 = win). */
  position: number | null;
  standings: Standing[];
  difficulty: Difficulty | null;
  laps: number;
  /** Race mode: better than the previous best for this configuration. */
  raceImproved: boolean;
  firstWin: boolean;
  bestTime: number | null;
  previousBest: number | null;
  isNewBest: boolean;
  /** Difference to the ghost raced against (negative = faster). */
  ghostDelta: number | null;
  ghostLabel: string | null;
  /** False when the run could not be recorded (too long) or saved. */
  ghostSaved: boolean;
  persisted: boolean;
  splits: number[];
}

export interface UiState {
  phase: Phase;
  /** Phase to return to when resuming from pause. */
  resumePhase: Phase | null;
  result: FinishResult | null;
  /** Selected map. */
  trackId: string;
  mode: GameMode;
  difficulty: Difficulty;
  laps: number;
  /** Race-mode records of the selected map. */
  raceRecords: RaceRecords;
  /** Personal best per map id (for the map picker). */
  trackBests: Record<string, number | null>;
  bestTime: number | null;
  lastTime: number | null;
  ghostChoice: GhostChoice;
  /** Ghost used in the current/last attempt (null = none yet). */
  activeGhost: GhostChoice | null;
  muted: boolean;
  hasRuns: boolean;
  storageOk: boolean;
  touch: boolean;
}

type Listener = () => void;

export class Store {
  private state: UiState;
  private listeners = new Set<Listener>();

  constructor(initial: UiState) {
    this.state = initial;
  }

  get = (): UiState => this.state;

  set(patch: Partial<UiState>): void {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof UiState)[]) {
      if (this.state[k] !== patch[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}
