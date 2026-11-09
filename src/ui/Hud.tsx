import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { HudRefs } from '../engine/engine';
import type { UiState } from '../engine/store';

interface Props {
  ui: UiState;
  onPause: () => void;
  onMute: () => void;
}

/**
 * Static HUD markup. Values are written directly by the engine through refs
 * (no React re-render per frame).
 */
export const Hud = forwardRef<HudRefs | null, Props>(function Hud({ ui, onPause, onMute }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const time = useRef<HTMLDivElement>(null);
  const checkpoint = useRef<HTMLSpanElement>(null);
  const speed = useRef<HTMLSpanElement>(null);
  const boostFill = useRef<HTMLDivElement>(null);
  const boostBar = useRef<HTMLDivElement>(null);
  const ghostDelta = useRef<HTMLDivElement>(null);
  const position = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const countdown = useRef<HTMLDivElement>(null);
  const message = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLDivElement>(null);
  const vignette = useRef<HTMLDivElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      root: root.current!,
      time: time.current!,
      checkpoint: checkpoint.current!,
      speed: speed.current!,
      boostFill: boostFill.current!,
      boostBar: boostBar.current!,
      ghostDelta: ghostDelta.current!,
      position: position.current!,
      flash: flash.current!,
      countdown: countdown.current!,
      message: message.current!,
      hint: hint.current!,
      arrow: arrow.current!,
      vignette: vignette.current!,
    }),
    [],
  );

  const racing = ui.phase === 'countdown' || ui.phase === 'racing';

  return (
    <div ref={root} className="hud" data-visible="false" data-touch={ui.touch ? 'true' : 'false'}>
      <div ref={vignette} className="hit-vignette" />
      <div className="hud-top">
        <div className="hud-left">
          <div className="hud-cp" aria-label="Checkpoint">
            <span className="hud-label">CP</span>
            <span ref={checkpoint} className="hud-cp-value">
              1/4
            </span>
          </div>
          <div ref={position} className="hud-position" aria-label="Posição" data-lead="false" />
        </div>
        <div className="hud-center">
          <div ref={time} className="hud-time" aria-live="off">
            0:00.00
          </div>
          <div ref={ghostDelta} className="hud-ghost" data-state="none" />
        </div>
        <div className="hud-buttons">
          {racing && (
            <button className="icon-btn" onClick={onPause} aria-label="Pausar">
              ❚❚
            </button>
          )}
          <button className="icon-btn" onClick={onMute} aria-label={ui.muted ? 'Ativar som' : 'Silenciar'}>
            {ui.muted ? '🔇' : '🔊'}
          </button>
        </div>
      </div>
      <div ref={hint} className="hud-hint" data-show="false" />
      <div ref={flash} className="hud-flash" data-show="false" />
      <div ref={countdown} className="hud-countdown" data-show="false" />
      <div ref={message} className="hud-message" data-show="false" />
      <div className="hud-speed">
        <div className="hud-speed-value">
          <span ref={speed}>0</span>
          <small>km/h</small>
        </div>
        <div ref={boostBar} className="boost-bar" data-active="false" data-low="false">
          <div ref={boostFill} className="boost-fill" />
          <span className="boost-label">BOOST</span>
        </div>
      </div>
      <div ref={arrow} className="hud-arrow" data-show="false" aria-hidden="true">
        <svg viewBox="0 0 40 40" width="40" height="40">
          <path d="M8 8 L34 20 L8 32 L14 20 Z" />
        </svg>
      </div>
    </div>
  );
});
