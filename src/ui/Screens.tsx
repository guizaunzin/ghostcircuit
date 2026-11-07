import { useEffect, useRef } from 'react';
import type { GameEngine } from '../engine/engine';
import { formatDelta, formatTime } from '../engine/format';
import type { FinishResult, UiState } from '../engine/store';
import { MAPS } from '../game/maps';
import { MapPicker } from './MapPicker';

function GhostSelector({ ui, engine }: { ui: UiState; engine: GameEngine }) {
  if (!ui.hasRuns) {
    return <p className="ghost-empty">Complete uma corrida para criar seu primeiro fantasma.</p>;
  }
  return (
    <div className="ghost-select" role="radiogroup" aria-label="Fantasma">
      <span className="ghost-select-label">Fantasma</span>
      <div className="segmented">
        <button
          role="radio"
          aria-checked={ui.ghostChoice === 'last'}
          data-on={ui.ghostChoice === 'last'}
          onClick={() => engine.setGhostChoice('last')}
        >
          Última corrida
          <small>{formatTime(ui.lastTime)}</small>
        </button>
        <button
          role="radio"
          aria-checked={ui.ghostChoice === 'best'}
          data-on={ui.ghostChoice === 'best'}
          onClick={() => engine.setGhostChoice('best')}
        >
          Meu recorde
          <small>{formatTime(ui.bestTime)}</small>
        </button>
      </div>
    </div>
  );
}

function useAutoFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    // Only grab focus on devices with a keyboard-like pointer.
    if (!matchMedia('(pointer: coarse)').matches) ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}

export function Menu({ ui, engine }: { ui: UiState; engine: GameEngine }) {
  const play = useAutoFocus<HTMLButtonElement>();
  return (
    <div className="overlay menu">
      <div className="panel">
        <h1 className="title">
          GHOST<span>CIRCUIT</span>
        </h1>
        <p className="tagline">Corra contra o seu próprio fantasma.</p>
        <MapPicker ui={ui} engine={engine} />
        <GhostSelector ui={ui} engine={engine} />
        <button ref={play} className="btn-primary" onClick={() => engine.play()}>
          Jogar
        </button>
        <div className="howto">
          {ui.touch ? (
            <p>
              <b>Esquerda:</b> arraste para virar · <b>Direita:</b> acelerar, frear e boost
            </p>
          ) : (
            <p>
              <kbd>W</kbd>/<kbd>↑</kbd> acelerar · <kbd>S</kbd>/<kbd>↓</kbd> frear · <kbd>A</kbd> <kbd>D</kbd> virar ·{' '}
              <kbd>Espaço</kbd> boost · <kbd>R</kbd> reiniciar · <kbd>Esc</kbd> pausar
            </p>
          )}
          <p className="muted">
            Passe pelos 4 checkpoints em ordem e cruze a chegada. Cada corrida completa vira um fantasma para você bater.
            Há um atalho estreito escondido — vale o risco?
          </p>
        </div>
        <div className="menu-footer">
          <button className="btn-ghost" onClick={() => engine.toggleMute()}>
            {ui.muted ? '🔇 Som desligado' : '🔊 Som ligado'}
          </button>
        </div>
        {!ui.storageOk && (
          <p className="warn">Armazenamento indisponível: recordes e fantasmas não serão salvos ao fechar a página.</p>
        )}
      </div>
    </div>
  );
}

export function PauseMenu({ ui, engine }: { ui: UiState; engine: GameEngine }) {
  const resume = useAutoFocus<HTMLButtonElement>();
  return (
    <div className="overlay pause">
      <div className="panel small">
        <h2>Pausado</h2>
        <button ref={resume} className="btn-primary" onClick={() => engine.resume()}>
          Continuar
        </button>
        <button className="btn-secondary" onClick={() => engine.restart()}>
          Reiniciar tentativa
        </button>
        <GhostSelector ui={ui} engine={engine} />
        {ui.hasRuns && <p className="muted small-print">A escolha do fantasma vale a partir da próxima tentativa.</p>}
        <div className="row">
          <button className="btn-ghost" onClick={() => engine.toggleMute()}>
            {ui.muted ? '🔇 Som desligado' : '🔊 Som ligado'}
          </button>
          <button className="btn-ghost" onClick={() => engine.toMenu()}>
            Menu
          </button>
        </div>
      </div>
    </div>
  );
}

export function FinishScreen({ ui, result, engine }: { ui: UiState; result: FinishResult; engine: GameEngine }) {
  const retry = useAutoFocus<HTMLButtonElement>();
  const d = result.ghostDelta;
  return (
    <div className="overlay finish" data-record={result.isNewBest}>
      {result.isNewBest && result.previousBest !== null && <Confetti />}
      <div className="panel">
        <h2 className={result.isNewBest ? 'record-title' : ''}>
          {result.isNewBest ? (result.previousBest === null ? 'Primeiro fantasma criado!' : 'Novo recorde!') : 'Chegada!'}
        </h2>
        <div className="final-map">{MAPS.find((m) => m.id === ui.trackId)?.name}</div>
        <div className="final-time">{formatTime(result.time)}</div>
        <dl className="stats">
          <div>
            <dt>Recorde</dt>
            <dd>{formatTime(result.bestTime)}</dd>
          </div>
          {result.isNewBest && result.previousBest !== null && (
            <div>
              <dt>Recorde anterior</dt>
              <dd>
                {formatTime(result.previousBest)} <span className="ahead">{formatDelta(result.time - result.previousBest)}</span>
              </dd>
            </div>
          )}
          {d !== null && (
            <div>
              <dt>vs {result.ghostLabel ?? 'fantasma'}</dt>
              <dd className={d <= 0 ? 'ahead' : 'behind'}>{formatDelta(d)}</dd>
            </div>
          )}
        </dl>
        {!result.ghostSaved && <p className="warn">Corrida longa demais para gravar o fantasma.</p>}
        {result.ghostSaved && !result.persisted && ui.storageOk && (
          <p className="warn">Não foi possível salvar no navegador; o fantasma vale até fechar a página.</p>
        )}
        <button ref={retry} className="btn-primary big" onClick={() => engine.play()}>
          Tentar novamente
        </button>
        <GhostSelector ui={ui} engine={engine} />
        <div className="row">
          <button className="btn-ghost" onClick={() => engine.toMenu()}>
            Trocar pista / Menu
          </button>
        </div>
        <p className="muted small-print">{ui.touch ? '' : 'Enter ou R para tentar de novo'}</p>
      </div>
    </div>
  );
}

function Confetti() {
  const pieces = Array.from({ length: 36 }, (_, i) => i);
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((i) => (
        <i
          key={i}
          style={{
            left: `${(i * 37) % 100}%`,
            animationDelay: `${(i % 9) * 0.06}s`,
            background: ['#ff3ea5', '#38e8ff', '#ffb347', '#ffffff'][i % 4],
            transform: `rotate(${i * 23}deg)`,
          }}
        />
      ))}
    </div>
  );
}
