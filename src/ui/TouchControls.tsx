import { useEffect, useRef } from 'react';
import type { InputManager, TouchState } from '../engine/input';

/**
 * Mobile controls: floating steering stick on the left, accelerate / brake /
 * boost buttons on the right. Multi-touch via pointer ids; writes straight
 * into the input manager (no React state updates while driving).
 */
export function TouchControls({ input }: { input: InputManager }) {
  const zone = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const touch = input.touch;
    touch.active = true;
    const el = zone.current!;
    let stickId: number | null = null;
    let originX = 0;
    let originY = 0;
    const radius = 56;

    const setKnob = (dx: number) => {
      if (knob.current) knob.current.style.transform = `translate(${dx}px, 0)`;
    };
    const down = (e: PointerEvent) => {
      if (stickId !== null) return;
      e.preventDefault();
      stickId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      const r = el.getBoundingClientRect();
      originX = e.clientX;
      originY = e.clientY;
      if (base.current) {
        base.current.style.left = `${originX - r.left}px`;
        base.current.style.top = `${originY - r.top}px`;
        base.current.dataset.active = 'true';
      }
      setKnob(0);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== stickId) return;
      e.preventDefault();
      const dx = Math.max(-radius, Math.min(radius, e.clientX - originX));
      void originY;
      setKnob(dx);
      let v = dx / radius;
      const dead = 0.08;
      v = Math.abs(v) < dead ? 0 : (Math.sign(v) * (Math.abs(v) - dead)) / (1 - dead);
      // Slight curve for finer control near the centre.
      touch.steer = Math.sign(v) * Math.pow(Math.abs(v), 1.3);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      touch.steer = 0;
      setKnob(0);
      if (base.current) base.current.dataset.active = 'false';
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      touch.steer = 0;
      touch.throttle = false;
      touch.brake = false;
      touch.boost = false;
      touch.active = false;
    };
  }, [input]);

  return (
    <div className="touch">
      <div ref={zone} className="touch-stick-zone" aria-label="Direção">
        <div ref={base} className="touch-stick" data-active="false">
          <div ref={knob} className="touch-knob" />
        </div>
        <span className="touch-stick-hint">◀ direção ▶</span>
      </div>
      <div className="touch-buttons">
        <HoldButton input={input} field="boost" className="t-boost" label="Boost" />
        <HoldButton input={input} field="brake" className="t-brake" label="Frear" />
        <HoldButton input={input} field="throttle" className="t-throttle" label="Acelerar" />
      </div>
    </div>
  );
}

function HoldButton({
  input,
  field,
  className,
  label,
}: {
  input: InputManager;
  field: keyof Pick<TouchState, 'throttle' | 'brake' | 'boost'>;
  className: string;
  label: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const pointers = new Set<number>();
    const sync = () => {
      input.touch[field] = pointers.size > 0;
      el.dataset.pressed = pointers.size > 0 ? 'true' : 'false';
    };
    const down = (e: PointerEvent) => {
      e.preventDefault();
      pointers.add(e.pointerId);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      sync();
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      sync();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      input.touch[field] = false;
    };
  }, [input, field]);
  return (
    <button ref={ref} className={`touch-btn ${className}`} data-pressed="false" aria-label={label} tabIndex={-1}>
      {label}
    </button>
  );
}
