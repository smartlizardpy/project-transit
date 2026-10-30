// Operating areas are z14 map tiles (about 2 km across). Tiles are fixed worldwide, so an area
// keeps its id and shape when the map grows around it.
import { lngLatToTile } from '../../geo/tiles.ts';
import type { LngLat } from './graph.ts';
import type { RegionSpec } from './region.ts';

export const ZONE_Z = 14;
/** tiles kept loaded around the operated area, so everything that can be licensed next is on the map */
export const GROW_MARGIN = 2;

export const zoneId = (x: number, y: number) => `t${x}_${y}`;

export function zoneTile(id: string): [number, number] | null {
  const m = /^t(\d+)_(\d+)$/.exec(id);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export const tileAt = (ll: LngLat): [number, number] => lngLatToTile(ll[0], ll[1], ZONE_Z);

/**
 * The tiles a region needs for this territory: the operated area plus GROW_MARGIN tiles all
 * round, merged with what is already loaded (a region never shrinks). null when nothing is missing.
 */
export function tilesNeeded(spec: RegionSpec, owned: readonly string[]): [number, number][] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  };
  let any = false;
  for (const id of owned) {
    const t = zoneTile(id);
    if (!t) continue;
    any = true;
    grow(t[0] - GROW_MARGIN, t[1] - GROW_MARGIN);
    grow(t[0] + GROW_MARGIN, t[1] + GROW_MARGIN);
  }
  if (!any) return null;
  for (const [x, y] of spec.tiles) grow(x, y);
  const have = new Set(spec.tiles.map(([x, y]) => `${x},${y}`));
  const out: [number, number][] = [];
  let missing = false;
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      out.push([x, y]);
      if (!have.has(`${x},${y}`)) missing = true;
    }
  return missing ? out : null;
}
