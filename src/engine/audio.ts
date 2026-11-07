// Discreet synthesized audio (Web Audio API): engine hum, countdown beeps,
// checkpoint chimes, finish fanfare and collision thumps. Created lazily on
// the first user gesture; every call is a no-op when unavailable.

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private osc1: OscillatorNode | null = null;
  private osc2: OscillatorNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private boostGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private _muted = false;

  get muted(): boolean {
    return this._muted;
  }

  /** Must be called from a user gesture handler. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.build();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  private build(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : 0.55;
    this.master.connect(ctx.destination);

    // Engine: two detuned oscillators through a lowpass.
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 500;
    this.filter.Q.value = 2;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    this.osc1.frequency.value = 70;
    this.osc2.frequency.value = 105;
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    this.osc1.connect(this.filter);
    this.osc2.connect(g2).connect(this.filter);
    this.filter.connect(this.engineGain).connect(this.master);
    this.osc1.start();
    this.osc2.start();

    // Noise buffer (boost whoosh + collisions).
    const len = ctx.sampleRate;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.8;
    this.boostGain = ctx.createGain();
    this.boostGain.gain.value = 0;
    noise.connect(bp).connect(this.boostGain).connect(this.master);
    noise.start();
  }

  setMuted(m: boolean): void {
    this._muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }

  /** Continuous engine sound. speed01 in 0..1; active=false silences it. */
  updateEngine(speed01: number, throttle: number, boosting: boolean, active: boolean): void {
    if (!this.ctx || !this.osc1 || !this.osc2 || !this.filter || !this.engineGain || !this.boostGain) return;
    const t = this.ctx.currentTime;
    const s = Math.max(0, Math.min(1.3, speed01));
    const f = 62 + s * 120 + throttle * 12;
    this.osc1.frequency.setTargetAtTime(f, t, 0.05);
    this.osc2.frequency.setTargetAtTime(f * 1.505, t, 0.05);
    this.filter.frequency.setTargetAtTime(380 + s * 1500 + (boosting ? 700 : 0), t, 0.06);
    this.engineGain.gain.setTargetAtTime(active ? 0.045 + s * 0.05 : 0, t, 0.08);
    this.boostGain.gain.setTargetAtTime(active && boosting ? 0.06 : 0, t, 0.06);
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType, vol: number, slideTo?: number): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(this.master);
    o.start(start);
    o.stop(start + dur + 0.05);
  }

  countdown(n: number): void {
    if (!this.ctx) return;
    this.tone(n > 0 ? 520 : 1040, this.ctx.currentTime, n > 0 ? 0.16 : 0.4, 'square', 0.08);
  }

  checkpoint(ahead: boolean | null): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (ahead === false) {
      this.tone(660, t, 0.12, 'triangle', 0.12);
      this.tone(520, t + 0.09, 0.18, 'triangle', 0.1);
    } else {
      this.tone(880, t, 0.12, 'triangle', 0.12);
      this.tone(1320, t + 0.08, 0.2, 'triangle', 0.1);
    }
  }

  finish(record: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const notes = record ? [523, 659, 784, 1047, 1319] : [523, 659, 784];
    notes.forEach((f, i) => this.tone(f, t + i * 0.09, 0.32, 'triangle', 0.12));
  }

  collision(intensity: number): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const g = ctx.createGain();
    const vol = Math.min(0.3, 0.05 + intensity * 0.012);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5, 0.25);
    this.tone(90, t, 0.18, 'sine', Math.min(0.25, vol), 45);
  }

  suspend(): void {
    this.updateEngine(0, 0, false, false);
  }
}
