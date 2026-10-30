// Stop spots: the only places a bus stop can be built. Real bus stops from OpenStreetMap
// where they are mapped, plus generated spots along main roads, and on residential streets
// where nothing else is near, so every part of the city has somewhere to stop.
// Derived from the region alone (deterministic), so they are never saved.
import { EDGE_BRIDGE, EDGE_TUNNEL, STOP_CLASSES, RoadClass, type LngLat } from './world/graph.ts';
import type { Region } from './world/region.ts';

export interface StopSpot {
  lngLat: LngLat;
  /** the real stop's name; generated spots get a name when a stop is built there */
  name: string;
  /** a real stop location from OpenStreetMap */
  osm: boolean;
}

/** generated spots along main roads, at least this far from any other spot (metres) */
export const MAIN_GAP = 300;
/** residential streets get a spot only where no other spot is this close (metres) */
export const LOCAL_GAP = 450;

const MAIN = new Set<number>([RoadClass.trunk, RoadClass.primary, RoadClass.secondary, RoadClass.tertiary, RoadClass.busway]);
const cache = new WeakMap<Region, StopSpot[]>();

export function stopSpots(region: Region): StopSpot[] {
  let spots = cache.get(region);
  if (!spots) cache.set(region, (spots = buildSpots(region)));
  return spots;
}

function buildSpots(region: Region): StopSpot[] {
  const g = region.graph;
  const b = region.bounds;
  const spots: StopSpot[] = [];
  // spatial hash of accepted spots, local metres
  const CELL = 150;
  const hash = new Map<number, number[]>();
  const hkey = (cx: number, cy: number) => cx * 100_003 + cy;
  const xy = (ll: LngLat): [number, number] => [(ll[0] - g.origin[0]) * g.kx, (ll[1] - g.origin[1]) * g.ky];
  const add = (s: StopSpot) => {
    const [x, y] = xy(s.lngLat);
    const k = hkey(Math.floor(x / CELL), Math.floor(y / CELL));
    const list = hash.get(k);
    if (list) list.push(x, y);
    else hash.set(k, [x, y]);
    spots.push(s);
  };
  const near = (x: number, y: number, r: number) => {
    const R = Math.ceil(r / CELL), cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let dx = -R; dx <= R; dx++)
      for (let dy = -R; dy <= R; dy++) {
        const list = hash.get(hkey(cx + dx, cy + dy));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 2) if (Math.hypot(list[i] - x, list[i + 1] - y) < r) return true;
      }
    return false;
  };

  for (const o of region.osmStops) add({ lngLat: o.lngLat, name: o.name, osm: true });

  // candidate nodes on stop-capable, at-grade roads: mid-street points (two incident edges)
  // first; junctions only where a dense block of short streets leaves nothing else
  const main: number[] = [];
  const local: number[] = [];
  const junction: number[] = [];
  const inside = (v: number) => g.lng[v] > b.w + 0.0012 && g.lng[v] < b.e - 0.0012 && g.lat[v] > b.s + 0.0009 && g.lat[v] < b.n - 0.0009;
  for (let v = 0; v < g.n; v++) {
    const s = g.adjStart[v], e = g.adjStart[v + 1];
    if (e - s < 2 || !inside(v)) continue;
    let isMain = false, ok = true;
    for (let i = s; i < e; i++) {
      const edge = g.adjEdge[i];
      if (!STOP_CLASSES.has(g.cls[edge]) || g.flags[edge] & (EDGE_BRIDGE | EDGE_TUNNEL)) ok = false;
      if (MAIN.has(g.cls[edge])) isMain = true;
    }
    if (!ok) continue;
    if (e - s > 2) junction.push(v);
    else (isMain ? main : local).push(v);
  }
  const put = (v: number) => add({ lngLat: [g.lng[v], g.lat[v]], name: '', osm: false });
  for (const v of main) if (!near(g.x[v], g.y[v], MAIN_GAP)) put(v);
  for (const v of local) if (!near(g.x[v], g.y[v], LOCAL_GAP)) put(v);
  for (const v of junction) if (!near(g.x[v], g.y[v], LOCAL_GAP)) put(v);
  return spots;
}
