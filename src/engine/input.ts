// Keyboard + touch input, merged into a single DroneInput. Touch controls
// write into `touch` directly from pointer handlers (no React state).

import type { DroneInput } from '../game/drone';
import { clamp } from '../game/math';

export type InputAction = 'restart' | 'pause' | 'mute' | 'confirm';

const GAME_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
]);

export interface TouchState {
  steer: number;
  throttle: boolean;
  brake: boolean;
  boost: boolean;
  active: boolean;
}

export class InputManager {
  private keys = new Set<string>();
  readonly touch: TouchState = { steer: 0, throttle: false, brake: false, boost: false, active: false };
  private steerSmoothed = 0;
  onAction: ((a: InputAction) => void) | null = null;
  /** Test/automation override (autopilot). */
  override: ((out: DroneInput) => void) | null = null;

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (GAME_KEYS.has(e.code)) {
      // Keep arrows/space from scrolling or activating focused buttons.
      e.preventDefault();
      this.keys.add(e.code);
      return;
    }
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyR':
        this.onAction?.('restart');
        break;
      case 'Escape':
      case 'KeyP':
        this.onAction?.('pause');
        break;
      case 'KeyM':
        this.onAction?.('mute');
        break;
      case 'Enter':
        this.onAction?.('confirm');
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  /** Releases everything (focus loss, pause, restart). */
  clear(): void {
    this.keys.clear();
    this.touch.steer = 0;
    this.touch.throttle = false;
    this.touch.brake = false;
    this.touch.boost = false;
    this.steerSmoothed = 0;
  }

  private has(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  /** Reads the merged input for one simulation step. */
  read(out: DroneInput, dt: number): DroneInput {
    if (this.override) {
      this.override(out);
      return out;
    }
    const up = this.has('KeyW', 'ArrowUp');
    const down = this.has('KeyS', 'ArrowDown');
    const left = this.has('KeyA', 'ArrowLeft');
    const right = this.has('KeyD', 'ArrowRight');
    const keySteer = (right ? 1 : 0) - (left ? 1 : 0);
    // Keyboard steering ramps quickly (~0.1 s) instead of snapping.
    const rate = keySteer === 0 ? 14 : Math.sign(keySteer) !== Math.sign(this.steerSmoothed) ? 16 : 9;
    const delta = keySteer - this.steerSmoothed;
    this.steerSmoothed += clamp(delta, -rate * dt, rate * dt);

    const touchSteer = this.touch.steer;
    out.steer = Math.abs(touchSteer) > Math.abs(this.steerSmoothed) ? touchSteer : this.steerSmoothed;
    out.throttle = up || this.touch.throttle ? 1 : 0;
    out.brake = down || this.touch.brake ? 1 : 0;
    out.boost = this.has('Space') || this.touch.boost;
    return out;
  }
}
