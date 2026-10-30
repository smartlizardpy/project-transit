// The Place Registry: one entry per significant real place (airports, stations, hospitals,
// campuses, schools, stadiums, malls, markets, nightlife districts, hotel areas, sights, parks,
// beaches, industrial areas). Built with the region from the map tiles (placeBuilder.ts); this
// module holds the types, labels and lookups that the game and the interface share.
// See docs/city-activity-engine-plan.md, section 6.

import { distanceM, type LngLat } from './graph.ts';

export type PlaceCategory =
  | 'airport' | 'rail_station' | 'metro_station' | 'tram_stop' | 'ferry_pier' | 'bus_station' | 'cable_car'
  | 'hospital' | 'university' | 'school' | 'stadium' | 'venue' | 'mall' | 'market' | 'nightlife' | 'hotel_area'
  | 'attraction' | 'park' | 'beach' | 'industrial';

export type TransitMode = 'rail' | 'metro' | 'tram' | 'ferry' | 'bus' | 'funicular' | 'cable';

export type ScaleUnit = 'pax_year' | 'users_day' | 'seats' | 'students' | 'pupils' | 'beds' | 'm2_floor' | 'venues' | 'hotels' | 'm2';

export interface PlaceScale {
  value: number;
  unit: ScaleUnit;
  /** 1 (largest) … 5 (smallest) within the category */
  tier: number;
  /** true when the value comes from a measured source, false when estimated */
  measured: boolean;
  /** where the value comes from, shown on the place card */
  source: string;
}

export interface CityPlace {
  /** stable for the same map data: 'osm:<tile feature id>', 'iata:<code>', or a cluster key */
  id: string;
  name: string;
  category: PlaceCategory;
  /** where people arrive: a mapped entrance, terminal or the named point, not the centroid */
  lngLat: LngLat;
  /** simplified outline, when the place has one */
  ring?: LngLat[];
  /** footprint area and the building floor area inside it, m² (0 when unknown) */
  areaM2: number;
  floorM2: number;
  scale: PlaceScale;
  /** stations: the transport modes that call here, main mode first */
  modes?: TransitMode[];
  /** stations: other ways in (metro entrances) */
  access?: LngLat[];
  codes?: { iata?: string; icao?: string };
  /** the data that contributed: 'tiles:poi', 'tiles:landuse', 'ourairports', 'wikidata', … */
  sources: string[];
  /** 'measured': a mapped point or outline; 'estimated': inferred (cluster centre, airfield point) */
  location: 'measured' | 'estimated';
  confidence: number;
  /** inside the loaded map (false: airports beyond it) */
  reachable: boolean;
  /** straight-line distance from the region centre, km */
  distanceKm: number;
}

export const PLACE_LABEL: Record<PlaceCategory, string> = {
  airport: 'Airport', rail_station: 'Train station', metro_station: 'Metro station', tram_stop: 'Tram stop', ferry_pier: 'Ferry pier',
  bus_station: 'Bus station', cable_car: 'Cable car or funicular', hospital: 'Hospital', university: 'University', school: 'School', stadium: 'Stadium',
  venue: 'Theatre or venue', mall: 'Shopping centre', market: 'Market', nightlife: 'Nightlife district', hotel_area: 'Hotel district',
  attraction: 'Sight', park: 'Park', beach: 'Beach', industrial: 'Industrial area',
};

export const MODE_LABEL: Record<TransitMode, string> = { rail: 'Train', metro: 'Metro', tram: 'Tram', ferry: 'Ferry', bus: 'Bus', funicular: 'Funicular', cable: 'Cable car' };

export const SCALE_LABEL: Record<ScaleUnit, string> = {
  pax_year: 'passengers a year', users_day: 'people a day', seats: 'seats', students: 'students', pupils: 'pupils', beds: 'beds',
  m2_floor: 'm² of floor space', venues: 'bars and clubs', hotels: 'hotels', m2: 'm²',
};

export const TIER_LABEL = ['Major', 'Large', 'Medium', 'Small', 'Minor'];

/** How much a place matters as a destination, for picking map markers and the save snapshot. */
const CATEGORY_WEIGHT: Record<PlaceCategory, number> = {
  airport: 10, rail_station: 6, hospital: 5, university: 5, stadium: 5, ferry_pier: 4, metro_station: 4, mall: 4, beach: 3,
  bus_station: 3, market: 3, attraction: 3, nightlife: 3, venue: 2, hotel_area: 2, park: 2, industrial: 2, cable_car: 2, tram_stop: 1.5, school: 1.5,
};
export function placeSignificance(p: CityPlace): number {
  return CATEGORY_WEIGHT[p.category] * (6 - p.scale.tier);
}

/** "84 million passengers a year", "52,652 seats", "about 2,000 students" */
export function describeScale(s: PlaceScale): string {
  const v = s.value >= 1e6 ? `${(s.value / 1e6).toFixed(s.value >= 1e7 ? 0 : 1)} million` : s.value.toLocaleString('en-GB');
  return `${s.measured ? '' : 'about '}${v} ${SCALE_LABEL[s.unit]}`;
}

// ─────────────────────────────────────────── spatial lookup

/** A coarse uniform grid for neighbour lookups (local metres). */
export class Grid<T> {
  private readonly cells = new Map<string, T[]>();
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  private key(x: number, y: number) {
    return `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`;
  }
  add(x: number, y: number, v: T) {
    const k = this.key(x, y);
    const l = this.cells.get(k);
    if (l) l.push(v);
    else this.cells.set(k, [v]);
  }
  /** everything in the cells that a circle of radius r around (x, y) touches */
  near(x: number, y: number, r: number): T[] {
    const out: T[] = [];
    const c0 = Math.floor((x - r) / this.size), c1 = Math.floor((x + r) / this.size);
    const d0 = Math.floor((y - r) / this.size), d1 = Math.floor((y + r) / this.size);
    for (let cx = c0; cx <= c1; cx++)
      for (let cy = d0; cy <= d1; cy++) {
        const l = this.cells.get(`${cx},${cy}`);
        if (l) for (const v of l) out.push(v);
      }
    return out;
  }
}

/** Lookups over the registry at run time (not saved). */
export class PlaceIndex {
  readonly places: CityPlace[];
  readonly byId = new Map<string, CityPlace>();
  private readonly grid = new Grid<number>(300);
  private readonly xy: [number, number][];
  private readonly toXY: (lng: number, lat: number) => [number, number];

  constructor(places: CityPlace[], toXY: (lng: number, lat: number) => [number, number]) {
    this.places = places;
    this.toXY = toXY;
    this.xy = places.map((p) => toXY(p.lngLat[0], p.lngLat[1]));
    places.forEach((p, i) => {
      this.byId.set(p.id, p);
      if (p.reachable) this.grid.add(this.xy[i][0], this.xy[i][1], i);
    });
  }

  /** Reachable places within `radius` metres of a point, nearest first. */
  near(lngLat: LngLat, radius: number, pick?: (p: CityPlace) => boolean): { place: CityPlace; d: number }[] {
    const [x, y] = this.toXY(lngLat[0], lngLat[1]);
    const out: { place: CityPlace; d: number }[] = [];
    for (const i of this.grid.near(x, y, radius)) {
      const d = Math.hypot(this.xy[i][0] - x, this.xy[i][1] - y);
      if (d <= radius && (!pick || pick(this.places[i]))) out.push({ place: this.places[i], d });
    }
    return out.sort((a, b) => a.d - b.d || a.place.id.localeCompare(b.place.id));
  }

  /** Places beyond the map (airports), nearest first. */
  beyond(): CityPlace[] {
    return this.places.filter((p) => !p.reachable).sort((a, b) => a.distanceKm - b.distanceKm);
  }
}

/** Walking distance (straight line) from a point to a place's nearest way in: its anchor or an entrance. */
export function walkDistanceM(p: CityPlace, at: LngLat): number {
  let best = distanceM(at, p.lngLat);
  for (const a of p.access ?? []) best = Math.min(best, distanceM(at, a));
  return best;
}

/** Map data credits for a place's sources. */
export function placeCredits(p: CityPlace): string[] {
  const out = ['OpenStreetMap contributors'];
  if (p.sources.includes('ourairports')) out.push('OurAirports');
  if (p.sources.includes('wikidata')) out.push('Wikidata');
  return out;
}

// ─────────────────────────────────────────── the snapshot kept in the save

/** The part of a place a save keeps: enough to list it and to notice when the map changed. */
export interface PlaceSnapshot {
  id: string;
  name: string;
  category: PlaceCategory;
  lngLat: LngLat;
  tier: number;
  value: number;
  unit: ScaleUnit;
  /** beyond the map (airports) */
  beyond?: true;
}

export interface PlaceSnapshotState {
  /** changes when the registry built from the map changes */
  digest: string;
  significant: PlaceSnapshot[];
}

export const SNAPSHOT_MAX = 300;

/** The most significant places (every airport first, then by significance), at most SNAPSHOT_MAX. */
export function placeSnapshot(places: CityPlace[]): PlaceSnapshotState {
  const ranked = places
    .slice()
    .sort((a, b) => Number(b.category === 'airport') - Number(a.category === 'airport') || placeSignificance(b) - placeSignificance(a) || a.id.localeCompare(b.id))
    .slice(0, SNAPSHOT_MAX);
  return {
    digest: placesDigest(places),
    significant: ranked.map((p) => ({
      id: p.id, name: p.name, category: p.category, lngLat: [+p.lngLat[0].toFixed(5), +p.lngLat[1].toFixed(5)], tier: p.scale.tier, value: p.scale.value, unit: p.scale.unit,
      ...(p.reachable ? {} : { beyond: true as const }),
    })),
  };
}

/** A short hash over ids, categories and tiers: equal registries give equal digests. */
export function placesDigest(places: CityPlace[]): string {
  let h = 0x811c9dc5;
  for (const s of places.map((p) => `${p.id}|${p.category}|${p.scale.tier};`).sort())
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${places.length.toString(36)}-${(h >>> 0).toString(36)}`;
}
