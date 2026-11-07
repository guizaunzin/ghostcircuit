// Map catalog. The first map is hand-made; the others were produced by the
// seeded generator (generator.ts, `npm run gen:map -- <seed>`) and baked here
// as data so every browser builds exactly the same track.

import { buildTrack, type Track, type TrackDef } from './track';
import { GENERATED_MAPS } from './generatedMaps';

export const ARENA_CREPUSCULO: TrackDef = {
  id: 'arena-crepusculo',
  name: 'Arena Crepúsculo',
  // v2: obstacles re-placed relative to the track (some sat inside walls).
  version: 2,
  seed: null,
  theme: 'crepusculo',
  main: [
    [0, -120, 10.5], // start / finish straight (boost)
    [0, -50, 10.5],
    [0, 20, 10.5],
    [1, 90, 10.5],
    [10, 142, 10], // wide sweeper
    [44, 182, 10],
    [100, 192, 10],
    [150, 170, 10],
    [168, 118, 9.5],
    [160, 74, 8.5], // technical chicane
    [128, 46, 7.5],
    [106, 16, 7.5],
    [114, -14, 7.5],
    [148, -36, 7.5],
    [158, -68, 8.5],
    [138, -108, 9.5], // long drop into the bottom U
    [96, -144, 10],
    [52, -163, 10.5],
    [16, -154, 10.5],
  ],
  // Cuts the inside of the sweeper: narrow, sharp entry, pillars.
  shortcut: [
    [-3, 118, 3.8],
    [12, 124, 3.8],
    [44, 136, 3.8],
    [84, 145, 3.8],
    [120, 141, 3.8],
    [148, 128, 3.8],
    [165, 104, 3.8],
  ],
  finish: 24,
  checkpoints: [157, 487, 711, 856],
  obstacles: [
    // Pillar splitting the boost straight: pick a side.
    { kind: 'pillar', on: 'main', s: 126, offset: 0, r: 1.7, h: 14 },
    // Shortcut slalom.
    { kind: 'pillar', on: 'shortcut', s: 78, offset: 1.3, r: 1.2, h: 10 },
    { kind: 'pillar', on: 'shortcut', s: 130, offset: -1.3, r: 1.2, h: 10 },
    // Sweeper block on the outside line.
    { kind: 'box', on: 'main', s: 322, offset: 4.9, wide: 1.6, long: 3, h: 3 },
    // Chicane block.
    { kind: 'box', on: 'main', s: 592, offset: -1.4, wide: 2, long: 3.5, h: 4 },
    // Bottom U: staggered pillars.
    { kind: 'pillar', on: 'main', s: 780, offset: -3, r: 1.6, h: 12 },
    { kind: 'pillar', on: 'main', s: 832, offset: 3.2, r: 1.6, h: 12 },
  ],
};

export const MAPS: TrackDef[] = [ARENA_CREPUSCULO, ...GENERATED_MAPS];
export const DEFAULT_MAP_ID = ARENA_CREPUSCULO.id;

const cache = new Map<string, Track>();

/** Builds (once) and returns a track by id, falling back to the default map. */
export function getTrack(id: string = DEFAULT_MAP_ID): Track {
  const def = MAPS.find((m) => m.id === id) ?? ARENA_CREPUSCULO;
  let t = cache.get(def.id);
  if (!t) {
    t = buildTrack(def);
    cache.set(def.id, t);
  }
  return t;
}

export function hasMap(id: string): boolean {
  return MAPS.some((m) => m.id === id);
}
