// Test-only regions built from tiles fetched with scripts/dev/fetch-test-tiles.mjs into
// src/game/test/tiles (not bundled with the game). Tests using them skip when they are absent.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRegion } from '../world/regionBuilder.ts';
import { prepareRegion } from '../world/geo.ts';
import type { Region, RegionSpec } from '../world/region.ts';

const ROOT = join(import.meta.dirname, 'tiles', '14');

/** El Born, Barcelona: the tiles fetched by `node scripts/dev/fetch-test-tiles.mjs` */
export const BARCELONA_BORN_SPEC: RegionSpec = {
  id: 'test-barcelona-born',
  city: 'Barcelona',
  area: 'El Born',
  country: 'ES',
  centre: [2.181, 41.386],
  tiles: [8290, 8291, 8292].flatMap((x) => [6118, 6119, 6120].map((y) => [x, y] as [number, number])),
};

/** Barcelona–El Prat airport and its terminals: `node scripts/dev/fetch-test-tiles.mjs 2.075 41.295 3 3` */
export const BARCELONA_AIRPORT_SPEC: RegionSpec = {
  id: 'test-barcelona-airport',
  city: 'Barcelona',
  area: 'El Prat airport',
  country: 'ES',
  centre: [2.075, 41.295],
  tiles: [8285, 8286, 8287].flatMap((x) => [6123, 6124, 6125].map((y) => [x, y] as [number, number])),
};

export function hasTiles(spec: RegionSpec): boolean {
  return existsSync(ROOT) && spec.tiles.every(([x, y]) => existsSync(join(ROOT, String(x), `${y}.pbf`)));
}

const cache = new Map<string, Region>();
export function tileRegion(spec: RegionSpec): Region {
  let r = cache.get(spec.id);
  if (r) return r;
  const tiles = spec.tiles.map(([x, y]) => {
    const f = join(ROOT, String(x), `${y}.pbf`);
    return { x, y, data: existsSync(f) ? new Uint8Array(readFileSync(f)) : null };
  });
  r = prepareRegion(buildRegion(spec, tiles));
  cache.set(spec.id, r);
  return r;
}

/** every tile folder present (for diagnostics in scripts) */
export function fetchedTiles(): [number, number][] {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT).flatMap((x) => readdirSync(join(ROOT, x)).map((f) => [Number(x), Number(f.replace('.pbf', ''))] as [number, number]));
}
