// Seeds baked into src/game/generatedMaps.ts by `npm run gen:maps`.
// To add a map: find a good seed with `npm run gen:map -- scan 1 50`,
// add it here (bump `version` if you change an existing entry) and rerun.
import type { ThemeId } from '../src/game/track';

export const MAP_SEEDS: { seed: number; id: string; name: string; theme: ThemeId; version: number }[] = [
  { seed: 16, id: 'neon-noturno', name: 'Neon Noturno', theme: 'noturno', version: 1 },
  { seed: 3, id: 'duna-solar', name: 'Duna Solar', theme: 'duna', version: 1 },
  { seed: 30, id: 'aurora-glacial', name: 'Aurora Glacial', theme: 'aurora', version: 1 },
  { seed: 28, id: 'vale-tempestade', name: 'Vale da Tempestade', theme: 'tempestade', version: 1 },
];
