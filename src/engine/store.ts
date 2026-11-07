// Tiny external store for UI state that changes on game transitions only
// (never per frame). Consumed by React through useSyncExternalStore.

import type { GhostChoice } from '../game/storage';

export type Phase = 'menu' | 'countdown' | 'racing' | 'paused' | 'finished';

export interface FinishResult {
  time: number;
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
