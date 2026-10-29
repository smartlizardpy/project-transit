// Real bus stops from OpenStreetMap, baked by scripts/bake-istanbul.ts.
// New lines are built from these instead of player-placed stops.
import data from '../data/istanbul/stops.json';
import { distanceM } from './roadGraph.ts';
import { sim } from './sim.ts';

export interface OsmStop {
  id: string;
  name: string;
  lngLat: [number, number];
  /** road-graph node the bus halts at */
  node: number;
}

export const OSM_STOPS = data as OsmStop[];

const norm = (n: string) => n.replace(/\s+\d+$/, '').toLocaleLowerCase('tr').replace(/ı/g, 'i');

/** The game stop that already stands for this OSM stop (a demo-line stop or one added earlier), if any. */
export function servedStopFor(o: OsmStop): string | null {
  if (sim.stops.has(o.id)) return o.id;
  for (const s of sim.stops.values()) {
    const d = distanceM(s.lngLat, o.lngLat);
    if (d < 25 || (d < 90 && norm(s.name) === norm(o.name))) return s.id;
  }
  return null;
}
