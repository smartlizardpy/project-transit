// Test fixtures: real Istanbul region built from the bundled tiles, and a synthetic grid city.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildRegion } from '../world/regionBuilder.ts';
import type { RegionData, RegionSpec } from '../world/region.ts';

export const ISTANBUL_SPEC: RegionSpec = {
  id: 'istanbul-galata',
  city: 'İstanbul',
  area: 'Beyoğlu & Fatih',
  country: 'TR',
  centre: [28.9766, 41.0262],
  tiles: [9509, 9510, 9511, 9512].flatMap((x) => [6140, 6141, 6142].map((y) => [x, y] as [number, number])),
};

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
