import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { GameEngine, type HudRefs } from '../engine/engine';
import { Store, type UiState } from '../engine/store';
import { Hud } from './Hud';
import { Menu, PauseMenu, FinishScreen } from './Screens';
import { TouchControls } from './TouchControls';

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const PARAMS = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
/** `?test` exposes the engine on window for automated tests; `&speed=4` speeds up the simulation. */
const TEST_MODE = PARAMS.has('test');
const TIME_SCALE = Number(PARAMS.get('speed')) || 1;

const EMPTY_STORE = new Store({
  phase: 'menu',
  resumePhase: null,
  result: null,
  trackId: '',
  mode: 'ghost',
  difficulty: 'medio',
  laps: 2,
  raceRecords: {},
  trackBests: {},
  bestTime: null,
  lastTime: null,
  ghostChoice: 'last',
  activeGhost: null,
  muted: false,
  hasRuns: false,
  storageOk: true,
  touch: false,
});

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HudRefs | null>(null);
  const [engine, setEngine] = useState<GameEngine | null>(null);
  const [error, setError] = useState<string | null>(() =>
    hasWebGL() ? null : 'Seu navegador ou dispositivo não oferece WebGL, necessário para o 3D do jogo.',
  );

  useEffect(() => {
    if (error || !canvasRef.current || !hudRef.current) return;
    let eng: GameEngine;
    try {
      eng = new GameEngine(canvasRef.current, hudRef.current, { testMode: TEST_MODE, timeScale: TIME_SCALE });
    } catch (e) {
      console.error(e);
      setError('Não foi possível iniciar o 3D (WebGL) neste dispositivo.');
      return;
    }
    eng.start();
    setEngine(eng);
    if (TEST_MODE) (window as unknown as { __ghostCircuit?: GameEngine }).__ghostCircuit = eng;
    const onTouch = () => eng.setTouchMode(true);
    window.addEventListener('touchstart', onTouch, { passive: true, once: true });
    return () => {
      window.removeEventListener('touchstart', onTouch);
      eng.dispose();
      setEngine(null);
    };
  }, [error]);

  const store = engine?.store ?? EMPTY_STORE;
  const ui: UiState = useSyncExternalStore(store.subscribe, store.get);

  if (error) {
    return (
      <div className="fatal" role="alert">
        <h1>Ghost Circuit</h1>
        <p>{error}</p>
        <p className="muted">
          Tente atualizar o navegador, ativar a aceleração por hardware nas configurações ou abrir em outro dispositivo.
        </p>
      </div>
    );
  }

  return (
    <div className="game" data-phase={ui.phase} onContextMenu={(e) => e.preventDefault()}>
      <canvas ref={canvasRef} className="scene" />
      <Hud
        ref={hudRef}
        ui={ui}
        onPause={() => engine?.pause()}
        onMute={() => engine?.toggleMute()}
      />
      {engine && ui.touch && (ui.phase === 'countdown' || ui.phase === 'racing') && (
        <TouchControls input={engine.input} />
      )}
      {engine && ui.phase === 'menu' && <Menu ui={ui} engine={engine} />}
      {engine && ui.phase === 'paused' && <PauseMenu ui={ui} engine={engine} />}
      {engine && ui.phase === 'finished' && ui.result && <FinishScreen ui={ui} result={ui.result} engine={engine} />}
    </div>
  );
}
