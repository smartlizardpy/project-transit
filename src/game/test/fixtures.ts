// Test fixtures: real Istanbul region built from the bundled tiles, and a synthetic grid city.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildRegion } from '../world/regionBuilder.ts';
import type { RegionData, RegionSpec } from '../world/region.ts';
import { PRESETS, presetSpec } from '../../app/presets.ts';

/** the İstanbul starting city exactly as players get it (bundled tiles) */
export const ISTANBUL_SPEC: RegionSpec = presetSpec(PRESETS[0]);

let cached: RegionData | null = null;
export function istanbulRegion(): RegionData {
  if (cached) return cached;
  const root = join(import.meta.dirname, '..', '..', '..', 'public', 'tiles', '14');
  const tiles = ISTANBUL_SPEC.tiles.map(([x, y]) => {
    const f = join(root, String(x), `${y}.pbf`);
    return { x, y, data: existsSync(f) ? new Uint8Array(readFileSync(f)) : null };
  });
  cached = buildRegion(ISTANBUL_SPEC, tiles);
  return cached;
}
