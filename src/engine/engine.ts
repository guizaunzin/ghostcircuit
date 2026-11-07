// Game loop: fixed-timestep simulation + interpolated rendering, input,
// audio, HUD (direct DOM writes, no per-frame React), persistence and phases.

import { copyDrone, createDrone, DRONE, forwardSpeed, speedOf, type DroneInput, type DroneState } from '../game/drone';
import { Autopilot, type AutopilotOptions } from '../game/autopilot';
import type { Recording } from '../game/ghost';
import { clamp, lerp, lerpAngle } from '../game/math';
import { DT, Simulation, type SimEvent } from '../game/simulation';
import { applyFinishedRun, getBrowserStorage, SaveStore, selectGhost, type GhostChoice, type Runs } from '../game/storage';
import { getTrack, type Track } from '../game/track';
import { GameRenderer, type DronePose, type Quality, type ScreenPoint } from '../render/gameRenderer';
import { AudioEngine } from './audio';
import { formatDelta, formatTime } from './format';
import { InputManager } from './input';
import { Store, type Phase, type UiState } from './store';

export interface HudRefs {
  root: HTMLElement;
  time: HTMLElement;
  checkpoint: HTMLElement;
  speed: HTMLElement;
  boostFill: HTMLElement;
  boostBar: HTMLElement;
  ghostDelta: HTMLElement;
  flash: HTMLElement;
  countdown: HTMLElement;
  message: HTMLElement;
  hint: HTMLElement;
  arrow: HTMLElement;
  vignette: HTMLElement;
}

const GHOST_LABEL: Record<GhostChoice, string> = { last: 'Última corrida', best: 'Meu recorde' };

export function detectQuality(): { quality: Quality; mobile: boolean; touch: boolean; maxPixelRatio: number } {
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  const mobile = coarse || small;
  const dpr = window.devicePixelRatio || 1;
  const maxPixelRatio = mobile ? Math.min(dpr, 1.5) : Math.min(dpr, 2);
  return {
    mobile,
    // Touch UI only for touch-first devices; it also turns on at the first touch.
    touch: coarse,
    maxPixelRatio,
    quality: {
      pixelRatio: mobile ? Math.min(dpr, 1.25) : maxPixelRatio,
      antialias: !mobile,
      detail: mobile ? 0.55 : 1,
      particles: mobile ? 120 : 260,
    },
  };
}

export class GameEngine {
  readonly store: Store;
  readonly sim: Simulation;
  readonly input = new InputManager();
  readonly audio = new AudioEngine();
  private renderer: GameRenderer;
  private track: Track;
  private save: SaveStore;
  private runs: Runs;
  private prev: DroneState;
  private prevRaceTime = 0;
  private acc = 0;
  private lastFrame = 0;
  private raf = 0;
  private running = false;
  private stepInput: DroneInput = { throttle: 0, brake: 0, steer: 0, boost: false };
  private hud: HudRefs;
  private hudCache = { time: '', cp: '', speed: '', boost: -1, ghost: '' };
  private flashTimer = 0;
  private messageTimer = 0;
  private countdownTimer = 0;
  private hintTimer = 0;
  private lastCollisionSound = 0;
  private wallTime = 0;
  private screenPt: ScreenPoint = { x: 0, y: 0, behind: false };
  private pose: DronePose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  private frameTimes: number[] = [];
  private perfTimer = 0;
  private maxPixelRatio: number;
  private minPixelRatio = 0.6;
  private resizeObserver: ResizeObserver | null = null;
  private canvas: HTMLCanvasElement;
  /** Test mode allows more catch-up steps per frame (slow headless GPUs). */
  private maxStepsPerFrame = 12;
  private lastGhostDelta: number | null = null;
  /** Simulation speed multiplier (test mode only). */
  private timeScale = 1;

  constructor(canvas: HTMLCanvasElement, hud: HudRefs, opts: { testMode?: boolean; timeScale?: number } = {}) {
    this.canvas = canvas;
    this.hud = hud;
    this.track = getTrack();
    this.sim = new Simulation(this.track);
    this.prev = createDrone(0, 0, 0);
    copyDrone(this.sim.drone, this.prev);
    if (opts.testMode) {
      this.maxStepsPerFrame = 480;
      this.timeScale = clamp(opts.timeScale ?? 1, 0.1, 8);
    }

    const storage = getBrowserStorage();
    this.save = new SaveStore(storage);
    this.runs = this.save.loadRuns();
    const prefs = this.save.loadPrefs();
    this.audio.setMuted(prefs.muted);

    const { quality, touch, maxPixelRatio } = detectQuality();
    this.maxPixelRatio = maxPixelRatio;
    this.renderer = new GameRenderer(canvas, this.track, quality);

    this.store = new Store({
      phase: 'menu',
      resumePhase: null,
      result: null,
      bestTime: this.runs.best?.time ?? null,
      lastTime: this.runs.last?.time ?? null,
      ghostChoice: prefs.ghost,
      activeGhost: null,
      muted: prefs.muted,
      hasRuns: !!this.runs.last,
      storageOk: this.save.available,
      touch,
    });

    this.input.onAction = (a) => {
      const phase = this.store.get().phase;
      if (a === 'restart') {
        if (phase !== 'menu') this.restart();
      } else if (a === 'pause') {
        if (phase === 'paused') this.resume();
        else if (phase === 'countdown' || phase === 'racing') this.pause();
      } else if (a === 'mute') {
        this.toggleMute();
      } else if (a === 'confirm') {
        if (phase === 'finished' || phase === 'menu') this.play();
        else if (phase === 'paused') this.resume();
      }
    };
  }

  get state(): UiState {
    return this.store.get();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.input.attach();
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this.resize();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.input.detach();
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver?.disconnect();
    this.renderer.dispose();
  }

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.resize(w, h);
  }

  private onBlur = (): void => {
    this.input.clear();
    const p = this.store.get().phase;
    if (p === 'countdown' || p === 'racing') this.pause();
  };

  private onVisibility = (): void => {
    if (document.hidden) this.onBlur();
  };

  // ---------------------------------------------------------------------
  // Phase control

  /** Start (or retry) a race. Called from a user gesture: unlocks audio. */
  play(): void {
    this.audio.unlock();
    this.restart();
  }

  restart(): void {
    const choice = this.store.get().ghostChoice;
    const ghost: Recording | null = selectGhost(this.runs, choice);
    this.sim.reset(ghost);
    copyDrone(this.sim.drone, this.prev);
    this.prevRaceTime = 0;
    this.acc = 0;
    this.renderer.snapCamera(this.sim.drone.x, this.sim.drone.z, this.sim.drone.yaw);
    this.lastGhostDelta = null;
    this.resetHud(!ghost);
    this.store.set({
      phase: 'countdown',
      resumePhase: null,
      result: null,
      activeGhost: ghost ? choice : null,
    });
  }

  pause(): void {
    const p = this.store.get().phase;
    if (p !== 'countdown' && p !== 'racing') return;
    this.input.clear();
    this.audio.suspend();
    this.store.set({ phase: 'paused', resumePhase: p });
  }

  resume(): void {
    const s = this.store.get();
    if (s.phase !== 'paused') return;
    this.audio.unlock();
    this.lastFrame = performance.now();
    this.acc = 0;
    this.store.set({ phase: s.resumePhase ?? 'racing', resumePhase: null });
  }

  toMenu(): void {
    this.input.clear();
    this.audio.suspend();
    this.sim.reset(null);
    copyDrone(this.sim.drone, this.prev);
    this.hud.root.dataset.visible = 'false';
    this.store.set({ phase: 'menu', resumePhase: null, result: null });
  }

  setGhostChoice(c: GhostChoice): void {
    this.store.set({ ghostChoice: c });
    this.save.savePrefs({ ghost: c, muted: this.store.get().muted });
  }

  toggleMute(): void {
    const muted = !this.store.get().muted;
    this.audio.setMuted(muted);
    this.store.set({ muted });
    this.save.savePrefs({ ghost: this.store.get().ghostChoice, muted });
  }

  setTouchMode(touch: boolean): void {
    this.store.set({ touch });
  }

  // ---------------------------------------------------------------------
  // Test hooks

  setAutopilot(opts: AutopilotOptions | null): void {
    if (!opts) {
      this.input.override = null;
      return;
    }
    const ap = new Autopilot(this.track, opts);
    this.input.override = (out) => {
      if (this.sim.phase === 'racing') ap.drive(this.sim.drone, out);
      else {
        out.throttle = 0;
        out.brake = 0;
        out.steer = 0;
        out.boost = false;
      }
    };
  }

  getRuns(): Runs {
    return this.runs;
  }

  // ---------------------------------------------------------------------
  // Loop

  private frame = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const realDt = Math.min((now - this.lastFrame) / 1000, 0.25);
    this.lastFrame = now;
    this.wallTime += realDt;
    this.trackPerformance(realDt);

    const phase = this.store.get().phase;
    const simulating = phase === 'countdown' || phase === 'racing' || phase === 'finished';
    if (simulating) {
      this.acc += Math.min(realDt * this.timeScale, this.maxStepsPerFrame * DT);
      let steps = 0;
      while (this.acc >= DT && steps < this.maxStepsPerFrame) {
        copyDrone(this.sim.drone, this.prev);
        this.prevRaceTime = this.sim.raceTime;
        this.input.read(this.stepInput, DT);
        this.sim.step(this.stepInput);
        this.acc -= DT;
        steps++;
      }
      if (steps >= this.maxStepsPerFrame) this.acc = 0;
      this.handleEvents(this.sim.events);
      this.sim.events.length = 0;
    }

    const alpha = simulating ? clamp(this.acc / DT, 0, 1) : 1;
    const d = this.sim.drone;
    const p = this.prev;
    const pose = this.pose;
    pose.x = lerp(p.x, d.x, alpha);
    pose.y = lerp(p.y, d.y, alpha);
    pose.z = lerp(p.z, d.z, alpha);
    pose.yaw = lerpAngle(p.yaw, d.yaw, alpha);
    pose.pitch = lerp(p.pitch, d.pitch, alpha);
    pose.roll = lerp(p.roll, d.roll, alpha);
    if (phase === 'menu') pose.y = DRONE.hoverHeight + Math.sin(this.wallTime * 2.1) * 0.08;

    const raceTime = lerp(this.prevRaceTime, this.sim.raceTime, alpha);
    const speed = speedOf(d);
    this.renderer.render({
      mode: phase === 'menu' ? 'menu' : 'race',
      drone: pose,
      speed,
      boosting: d.boosting,
      hitFlash: d.hitFlash,
      ghost: this.sim.ghost,
      ghostTime: this.sim.phase === 'countdown' ? 0 : this.ghostClock(raceTime),
      showGhost: phase !== 'menu',
      nextGate: this.sim.progress.next,
      dt: phase === 'paused' ? 0 : realDt * this.timeScale,
      time: this.wallTime,
    });

    if (phase !== 'menu') this.updateHud(realDt, raceTime, phase);
    this.audio.updateEngine(
      Math.abs(forwardSpeed(d)) / DRONE.maxSpeed,
      this.stepInput.throttle,
      d.boosting,
      phase === 'racing' || phase === 'countdown' || phase === 'finished',
    );
  };

  /** After the player finishes, the ghost keeps going on its own clock. */
  private ghostClock(raceTime: number): number {
    if (this.sim.phase !== 'finished') return raceTime;
    return raceTime + this.finishedFor;
  }
  private finishedFor = 0;

  private handleEvents(events: SimEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'countdown':
          this.showCountdown(String(e.n));
          this.audio.countdown(e.n);
          break;
        case 'go':
          this.showCountdown('JÁ!');
          this.audio.countdown(0);
          this.store.set({ phase: 'racing' });
          break;
        case 'checkpoint':
          this.onCheckpoint(e.index, e.delta);
          break;
        case 'finish':
          this.onFinish(e.time, e.recording, e.delta);
          break;
        case 'collision': {
          this.renderer.collision(e.x, e.z, e.impact);
          if (this.wallTime - this.lastCollisionSound > 0.15) {
            this.lastCollisionSound = this.wallTime;
            this.audio.collision(e.impact);
          }
          break;
        }
        case 'recovered':
          this.showMessage('Drone recuperado');
          break;
      }
    }
  }

  private onCheckpoint(index: number, delta: number | null): void {
    this.audio.checkpoint(delta === null ? null : delta <= 0);
    const label = `Checkpoint ${index + 1}`;
    if (delta !== null) {
      this.lastGhostDelta = delta;
      this.flash(`${label}  ${formatDelta(delta)}`, delta <= 0 ? 'ahead' : 'behind');
    } else {
      this.flash(label, 'neutral');
    }
    this.hintTimer = Math.min(this.hintTimer, 0.5);
  }

  private onFinish(time: number, recording: Recording | null, delta: number | null): void {
    const s = this.store.get();
    const previousBest = this.runs.best?.time ?? null;
    let isNewBest = false;
    let persisted = false;
    if (recording) {
      const r = applyFinishedRun(this.runs, recording);
      this.runs = r.runs;
      isNewBest = r.isNewBest;
      persisted = this.save.saveRuns(this.runs);
    }
    this.finishedFor = 0;
    this.audio.finish(isNewBest);
    this.flash(isNewBest ? 'NOVO RECORDE!' : 'Chegada!', isNewBest ? 'record' : 'neutral');
    this.store.set({
      phase: 'finished',
      bestTime: this.runs.best?.time ?? null,
      lastTime: this.runs.last?.time ?? null,
      hasRuns: !!this.runs.last,
      result: {
        time,
        bestTime: this.runs.best?.time ?? null,
        previousBest,
        isNewBest,
        ghostDelta: delta,
        ghostLabel: s.activeGhost ? GHOST_LABEL[s.activeGhost] : null,
        ghostSaved: !!recording,
        persisted,
        splits: this.sim.progress.splits.slice(),
      },
    });
  }

  // ---------------------------------------------------------------------
  // HUD (direct DOM writes, only when values change)

  private resetHud(firstRun: boolean): void {
    const h = this.hud;
    h.root.dataset.visible = 'true';
    this.hudCache = { time: '', cp: '', speed: '', boost: -1, ghost: '' };
    h.flash.dataset.show = 'false';
    h.message.dataset.show = 'false';
    h.countdown.dataset.show = 'false';
    h.ghostDelta.textContent = '';
    h.ghostDelta.dataset.state = 'none';
    this.flashTimer = 0;
    this.messageTimer = 0;
    this.countdownTimer = 0;
    this.finishedFor = 0;
    this.hintTimer = firstRun ? 9 : 0;
    h.hint.textContent = firstRun ? 'Complete a pista para criar seu primeiro fantasma.' : '';
    h.hint.dataset.show = firstRun ? 'true' : 'false';
  }

  private showCountdown(text: string): void {
    const el = this.hud.countdown;
    el.textContent = text;
    el.dataset.show = 'true';
    // Restart the CSS pop animation.
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    this.countdownTimer = text === 'JÁ!' ? 0.8 : 1;
  }

  private flash(text: string, kind: 'ahead' | 'behind' | 'neutral' | 'record'): void {
    const el = this.hud.flash;
    el.textContent = text;
    el.dataset.kind = kind;
    el.dataset.show = 'true';
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    this.flashTimer = kind === 'record' ? 3 : 2.2;
  }

  private showMessage(text: string): void {
    this.hud.message.textContent = text;
    this.hud.message.dataset.show = 'true';
    this.messageTimer = 1.8;
  }

  private updateHud(dt: number, raceTime: number, phase: Phase): void {
    const h = this.hud;
    const c = this.hudCache;
    if (phase === 'finished') this.finishedFor += dt;
    const shownTime = this.sim.phase === 'finished' ? (this.sim.progress.finishTime ?? raceTime) : raceTime;
    const t = formatTime(shownTime);
    if (t !== c.time) {
      h.time.textContent = t;
      c.time = t;
    }
    const next = this.sim.progress.next;
    const cp = next < 4 ? `${next + 1}/4` : next === 4 ? 'Chegada' : '✓';
    if (cp !== c.cp) {
      h.checkpoint.textContent = cp;
      c.cp = cp;
    }
    const kmh = String(Math.round(speedOf(this.sim.drone) * 3.6));
    if (kmh !== c.speed) {
      h.speed.textContent = kmh;
      c.speed = kmh;
    }
    const boost = Math.round(this.sim.drone.boost * 100);
    if (boost !== c.boost) {
      h.boostFill.style.transform = `scaleX(${boost / 100})`;
      c.boost = boost;
    }
    h.boostBar.dataset.active = this.sim.drone.boosting ? 'true' : 'false';
    h.boostBar.dataset.low = this.sim.drone.boost < 0.12 ? 'true' : 'false';

    // Persistent comparison with the ghost (last checkpoint delta).
    const g = this.sim.ghost
      ? this.lastGhostDelta === null
        ? `Fantasma: ${GHOST_LABEL[this.store.get().activeGhost ?? 'last']}`
        : `vs fantasma ${formatDelta(this.lastGhostDelta)}`
      : '';
    if (g !== c.ghost) {
      h.ghostDelta.textContent = g;
      h.ghostDelta.dataset.state = this.lastGhostDelta === null ? 'none' : this.lastGhostDelta <= 0 ? 'ahead' : 'behind';
      c.ghost = g;
    }

    if (phase !== 'paused') {
      if (this.flashTimer > 0 && (this.flashTimer -= dt) <= 0) h.flash.dataset.show = 'false';
      if (this.messageTimer > 0 && (this.messageTimer -= dt) <= 0) h.message.dataset.show = 'false';
      if (this.countdownTimer > 0 && (this.countdownTimer -= dt) <= 0) h.countdown.dataset.show = 'false';
      if (this.hintTimer > 0 && (this.hintTimer -= dt) <= 0) h.hint.dataset.show = 'false';
    }

    h.vignette.style.opacity = String(Math.min(1, this.sim.drone.hitFlash * 2.5));
    this.updateArrow(phase);
  }

  /** Off-screen indicator pointing to the next gate. */
  private updateArrow(phase: Phase): void {
    const el = this.hud.arrow;
    const next = this.sim.progress.next;
    if ((phase !== 'racing' && phase !== 'countdown' && phase !== 'paused') || next > 4) {
      el.dataset.show = 'false';
      return;
    }
    const g = this.track.gates[next];
    const p = this.renderer.project(g.x, 4.5, g.z, this.screenPt);
    const margin = 0.88;
    const onScreen = !p.behind && Math.abs(p.x) < margin && Math.abs(p.y) < margin;
    if (onScreen) {
      el.dataset.show = 'false';
      return;
    }
    let x = p.x;
    let y = p.y;
    if (p.behind && Math.abs(x) < 0.05 && Math.abs(y) < 0.05) y = -1;
    const angle = Math.atan2(y, x);
    const k = Math.max(Math.abs(x) / margin, Math.abs(y) / margin, 1e-6);
    x /= k;
    y /= k;
    const w = this.canvas.clientWidth;
    const hgt = this.canvas.clientHeight;
    const px = ((x + 1) / 2) * w;
    const py = ((1 - y) / 2) * hgt;
    el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) rotate(${(-angle).toFixed(3)}rad)`;
    el.dataset.show = 'true';
  }

  // ---------------------------------------------------------------------
  // Adaptive resolution

  private trackPerformance(dt: number): void {
    if (dt <= 0 || dt > 0.2) return;
    this.frameTimes.push(dt);
    this.perfTimer += dt;
    if (this.perfTimer < 2.5) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    this.perfTimer = 0;
    const pr = this.renderer.quality.pixelRatio;
    if (avg > 1 / 45 && pr > this.minPixelRatio) {
      this.renderer.setPixelRatio(Math.max(this.minPixelRatio, pr * 0.85));
      this.resize();
    } else if (avg < 1 / 58 && pr < this.maxPixelRatio) {
      this.renderer.setPixelRatio(Math.min(this.maxPixelRatio, pr * 1.1));
      this.resize();
    }
  }

  get pixelRatio(): number {
    return this.renderer.quality.pixelRatio;
  }
}
