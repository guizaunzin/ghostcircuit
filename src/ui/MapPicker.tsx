import { useMemo } from 'react';
import type { GameEngine } from '../engine/engine';
import { formatTime } from '../engine/format';
import type { UiState } from '../engine/store';
import { getTrack, MAPS } from '../game/maps';
import type { Track } from '../game/track';
import { getTheme } from '../render/themes';

/** SVG path of the layout, mirrored so left/right match the in-game view. */
function layoutPaths(track: Track): { main: string; shortcut: string; start: [number, number]; viewBox: string } {
  const pts = track.corridors.flatMap((c) => c.points);
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minZ = Math.min(...pts.map((p) => p.z));
  const maxZ = Math.max(...pts.map((p) => p.z));
  const pad = 16;
  const X = (x: number) => (maxX - x + pad).toFixed(0);
  const Y = (z: number) => (maxZ - z + pad).toFixed(0);
  const path = (list: { x: number; z: number }[], closed: boolean) =>
    list
      .filter((_, i) => i % 4 === 0 || i === list.length - 1)
      .map((p, i) => `${i ? 'L' : 'M'}${X(p.x)} ${Y(p.z)}`)
      .join('') + (closed ? 'Z' : '');
  return {
    main: path(track.main.points, true),
    shortcut: path(track.shortcut.points, false),
    start: [Number(X(track.gates[4].x)), Number(Y(track.gates[4].z))],
    viewBox: `0 0 ${(maxX - minX + pad * 2).toFixed(0)} ${(maxZ - minZ + pad * 2).toFixed(0)}`,
  };
}

export function MapPicker({ ui, engine }: { ui: UiState; engine: GameEngine }) {
  const index = Math.max(0, MAPS.findIndex((m) => m.id === ui.trackId));
  const def = MAPS[index];
  const theme = getTheme(def.theme);
  const layout = useMemo(() => layoutPaths(getTrack(def.id)), [def.id]);
  const go = (d: number) => engine.selectTrack(MAPS[(index + d + MAPS.length) % MAPS.length].id);
  const best = ui.trackBests[def.id] ?? null;

  return (
    <div className="map-picker" style={{ ['--map-accent' as string]: theme.ui }}>
      <button className="map-arrow" onClick={() => go(-1)} aria-label="Pista anterior">
        ‹
      </button>
      <div className="map-card" aria-live="polite">
        <svg className="map-shape" viewBox={layout.viewBox} aria-hidden="true">
          <path d={layout.main} className="map-main" />
          <path d={layout.shortcut} className="map-shortcut" />
          <circle cx={layout.start[0]} cy={layout.start[1]} r="9" className="map-start" />
        </svg>
        <div className="map-info">
          <strong>{def.name}</strong>
          <span className="map-meta">
            {theme.label} · {def.seed === null ? 'original' : `seed ${def.seed}`}
          </span>
          <span className="map-best">Recorde {best !== null ? formatTime(best) : '—'}</span>
          <span className="map-count">
            {index + 1}/{MAPS.length}
          </span>
        </div>
      </div>
      <button className="map-arrow" onClick={() => go(1)} aria-label="Próxima pista">
        ›
      </button>
    </div>
  );
}
