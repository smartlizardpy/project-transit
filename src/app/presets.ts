// Starting locations. Any place on Earth with OpenStreetMap data can be played (see the
// "start here" option in the new-company flow); these presets are tested starting points
// with different urban forms. Istanbul's tiles ship with the game and work offline.

import type { LngLat } from '../game/world/graph.ts';
import type { RegionSpec } from '../game/world/region.ts';
import { tilesAround } from '../game/world/regionBuilder.ts';

export interface CityPreset {
  id: string;
  city: string;
  area: string;
  country: string;
  centre: LngLat;
  note: string;
  /** region size in z14 tiles */
  cols: number;
  rows: number;
  view: { zoom: number; bearing: number; pitch: number };
  /** explicit tile list (bundled offline tiles) */
  tiles?: [number, number][];
  offline?: boolean;
}

export const PRESETS: CityPreset[] = [
  {
    id: 'istanbul-galata',
    city: 'İstanbul',
    area: 'Beyoğlu & Fatih',
    country: 'TR',
    centre: [28.9766, 41.0262],
    note: 'Dense historic core, one-way streets, the Golden Horn bridges',
    cols: 4,
    rows: 3,
    view: { zoom: 15.6, bearing: -28, pitch: 54 },
    tiles: [9509, 9510, 9511, 9512].flatMap((x) => [6140, 6141, 6142].map((y) => [x, y] as [number, number])),
    offline: true,
  },
  {
    id: 'durham',
    city: 'Durham',
    area: 'City centre',
    country: 'GB',
    centre: [-1.5752, 54.7745],
    note: 'Small university city on a river peninsula',
    cols: 4,
    rows: 4,
    view: { zoom: 15.2, bearing: 12, pitch: 52 },
  },
  {
    id: 'barcelona-eixample',
    city: 'Barcelona',
    area: 'Eixample',
    country: 'ES',
    centre: [2.165, 41.391],
    note: 'Regular grid of chamfered blocks',
    cols: 3,
    rows: 3,
    view: { zoom: 15.4, bearing: -45, pitch: 52 },
  },
  {
    id: 'hamburg-altstadt',
    city: 'Hamburg',
    area: 'Altstadt & St. Pauli',
    country: 'DE',
    centre: [9.985, 53.549],
    note: 'Port city with canals and ring roads',
    cols: 4,
    rows: 4,
    view: { zoom: 15.2, bearing: -18, pitch: 52 },
  },
  {
    id: 'tokyo-shibuya',
    city: 'Tokyo',
    area: 'Shibuya',
    country: 'JP',
    centre: [139.7005, 35.6595],
    note: 'Very dense, rail-centred, narrow streets',
    cols: 3,
    rows: 3,
    view: { zoom: 15.4, bearing: -10, pitch: 52 },
  },
];

/** Region size in tiles so a game area spans roughly 5–6 km at any latitude. */
export function tilesForLatitude(lat: number): number {
  const tileKm = 2.446 * Math.cos((lat * Math.PI) / 180);
  return Math.max(3, Math.min(5, Math.round(5.6 / tileKm)));
}

export function presetSpec(p: CityPreset): RegionSpec {
  return { id: p.id, city: p.city, area: p.area, country: p.country, centre: p.centre, tiles: p.tiles ?? tilesAround(p.centre, p.cols, p.rows) };
}

/** A region centred anywhere (search result or the current map view). */
export function customSpec(centre: LngLat, city: string, area: string, country: string): RegionSpec {
  const n = tilesForLatitude(centre[1]);
  const id = `${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${centre[0].toFixed(3)}-${centre[1].toFixed(3)}`;
  return { id, city, area, country, centre, tiles: tilesAround(centre, n, n) };
}

export function presetFor(id: string): CityPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
