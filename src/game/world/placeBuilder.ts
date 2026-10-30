// Builds the Place Registry from the inputs the region builder collects from the z14 tiles,
// joined with two bundled extracts: OurAirports (public domain) for airport types and airports
// beyond the map, and Wikidata (CC0) for measured sizes (airport passengers, stadium seats,
// students, hospital beds).
//
// Duplicates across layers become one place: a hospital that is a land-use outline, a named
// point and buildings is one hospital; a metro station, its entrances and the tram stop
// outside are one interchange. Sizes are measured where a source has them and otherwise
// estimated from footprints and floor area, and every place says which.
// Pure function: runs in the region worker and in Node tests. Plan: section 6.

import { distanceM, type LngLat } from './graph.ts';
import { Grid, PLACE_LABEL, type CityPlace, type PlaceCategory, type PlaceScale, type ScaleUnit, type TransitMode } from './places.ts';
import airportsData from '../../data/airports.json';
import wikidataData from '../../data/wikidata-places.json';

// ─────────────────────────────────────────── inputs collected by the region builder

/** A point from the `poi` layer, in local metres. */
export interface RawPoi {
  id: number;
  cls: string;
  sub: string;
  name: string;
  x: number;
  y: number;
  rank: number;
}

/** An outline from `landuse`, `landcover` or `aeroway`; pieces of one feature across tiles merged by id. */
export interface RawPoly {
  id: number;
  layer: 'landuse' | 'landcover' | 'aeroway';
  /** landuse and aeroway class; landcover subclass (park, garden, beach) */
  cls: string;
  /** outer rings in local metres, flat x,y,… (one per tile piece) */
  rings: number[][];
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A rail, transit or ferry line from `transportation` (or a named ferry route, cls 'ferry_route'), in local metres. */
export interface RawLine {
  id: number;
  cls: string;
  sub: string;
  service: string;
  pts: number[];
}

export interface RawAerodrome {
  id: number;
  name: string;
  iata?: string;
  icao?: string;
  cls: string;
  lngLat: LngLat;
}

export interface PlaceInputs {
  centre: LngLat;
  toXY: (lng: number, lat: number) => [number, number];
  toLngLat: (x: number, y: number) => LngLat;
  inRegion: (lng: number, lat: number) => boolean;
  pois: RawPoi[];
  polys: RawPoly[];
  lines: RawLine[];
  aerodromes: RawAerodrome[];
  buildings: { x: number; y: number; fa: number }[];
  /** OSM place labels, for naming districts and unnamed outlines */
  labels: { name: string; kind: string; lngLat: LngLat }[];
}

// ─────────────────────────────────────────── bundled reference data

/** [iata, icao, type (L large, M medium, S small), name, lng, lat] */
type AirportRow = [string, string, 'L' | 'M' | 'S', string, number, number];
const AIRPORTS = (airportsData as unknown as { airports: AirportRow[] }).airports;
let airportByCode: Map<string, AirportRow> | null = null;
function airportRow(code: string | undefined): AirportRow | null {
  if (!code) return null;
  if (!airportByCode) {
    airportByCode = new Map();
    for (const a of AIRPORTS) {
      airportByCode.set(a[0], a);
      if (a[1]) airportByCode.set(a[1], a);
    }
  }
  return airportByCode.get(code) ?? null;
}

interface WikiPlace {
  q: string;
  name: string;
  kind: 'stadium' | 'university' | 'hospital';
  lng: number;
  lat: number;
  capacity?: number;
  students?: number;
  beds?: number;
}
/** airports: IATA → [annual passengers, year] */
const WIKI = wikidataData as unknown as { airports: Record<string, [number, number]>; places: WikiPlace[] };

// ─────────────────────────────────────────── geometry helpers

function pointInRing(x: number, y: number, ring: number[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outline, or within `pad` metres of its edge (a point mapped on the pavement outside). */
function inPoly(p: RawPoly, x: number, y: number, pad = 0): boolean {
  if (x < p.x0 - pad || x > p.x1 + pad || y < p.y0 - pad || y > p.y1 + pad) return false;
  if (p.rings.some((r) => pointInRing(x, y, r))) return true;
  if (!pad) return false;
  for (const r of p.rings)
    for (let i = 0; i < r.length; i += 2) if (Math.hypot(r[i] - x, r[i + 1] - y) < pad) return true;
  return false;
}

export function ringArea(r: number[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
  return Math.abs(a) / 2;
}

/** The largest piece, thinned to at most `max` points, for the outline on the map. */
function simplifiedRing(p: RawPoly, toLngLat: PlaceInputs['toLngLat'], max = 24): LngLat[] {
  const r = p.rings.slice().sort((a, b) => ringArea(b) - ringArea(a))[0] ?? [];
  const n = r.length / 2;
  const step = Math.max(1, Math.ceil(n / max));
  const out: LngLat[] = [];
  for (let i = 0; i < n; i += step) {
    const [lng, lat] = toLngLat(r[2 * i], r[2 * i + 1]);
    out.push([r6(lng), r6(lat)]);
  }
  return out;
}

const norm = (s: string) =>
  s.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Words that say what kind of place it is rather than which one (ignored when matching names). */
const GENERIC = new Set([
  'station', 'stasyonu', 'istasyonu', 'istasyon', 'gar', 'gari', 'bahnhof', 'hbf', 'estacio', 'estacion', 'eki', 'metro', 'tram', 'iskelesi', 'iskele',
  'vapur', 'pier', 'terminal', 'terminali', 'durak', 'duragi', 'the', 'de', 'del', 'la', 'el', 'stop', 'tramvay', 'u', 's',
  // operators and stand names that prefix many stop names
  'sehir', 'hatlari', 'iett', 'peronlari', 'peronu', 'otogari', 'otogar', 'teleferik', 'funikuler', 'ferry', 'ferries',
]);
/** A name, not a number or a code ("122", "B-4"). */
const properName = (s: string) => /\p{L}{3}/u.test(s);
/** Market words in the preset languages (in Turkish "market" alone is a grocery shop). */
const MARKET_NAME = /pazar|çarşı|carsi|bazaar|bazar|mercat|mercado|markt|market hall|halle|souk|市場|いちば/i;
const keyWords = (s: string) => norm(s).split(' ').filter((w) => w.length > 1 && !GENERIC.has(w));
function sameName(a: string, b: string): boolean {
  const A = keyWords(a), B = keyWords(b);
  if (!A.length || !B.length) return norm(a) === norm(b);
  return A[0] === B[0] && A[0].length >= 3;
}

const r6 = (v: number) => +v.toFixed(6);
/** 1 when v ≥ steps[0], 2 when v ≥ steps[1], … */
const tierBy = (v: number, steps: number[]) => {
  for (let i = 0; i < steps.length; i++) if (v >= steps[i]) return i + 1;
  return steps.length + 1;
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ─────────────────────────────────────────── rules

/** POI classes that name a place, by category. */
const POI_CATEGORY: Record<string, (sub: string, name: string) => PlaceCategory | null> = {
  hospital: (sub) => (sub === 'hospital' ? 'hospital' : null),
  college: (sub, name) => (/\blise(si)?\b|high school|gymnasium/i.test(name) ? 'school' : sub === 'university' || sub === 'college' ? 'university' : null),
  office: (sub) => (sub === 'university' || sub === 'educational_institution' ? 'university' : null),
  school: (sub) => (sub === 'school' ? 'school' : null),
  stadium: () => 'stadium',
  shop: (sub) => (sub === 'mall' ? 'mall' : null),
  grocery: (sub, name) => (sub === 'marketplace' && MARKET_NAME.test(name) ? 'market' : null),
  theatre: () => 'venue',
  art_gallery: (sub) => (sub === 'arts_centre' ? 'venue' : null),
  museum: () => 'attraction',
  castle: (sub) => (sub === 'castle' ? 'attraction' : null),
  attraction: (sub) => (sub === 'attraction' ? 'attraction' : null),
  theme_park: () => 'attraction',
  zoo: () => 'attraction',
  park: () => 'park',
};

/** Outlines that give a place its footprint. */
const POLY_CATEGORY: Record<string, PlaceCategory> = {
  'landuse:university': 'university', 'landuse:college': 'university', 'landuse:school': 'school', 'landuse:hospital': 'hospital',
  'landuse:stadium': 'stadium', 'landuse:music_venue': 'venue', 'landuse:theme_park': 'attraction', 'landuse:zoo': 'attraction',
  'landcover:park': 'park', 'landcover:garden': 'park',
};

/** The outline classes the region builder keeps for the registry. */
// (retail and commercial land use cover whole shopping districts, so malls are sized by their building)
export const PLACE_LANDUSE = new Set(['university', 'college', 'school', 'hospital', 'stadium', 'music_venue', 'theme_park', 'zoo', 'industrial', 'railway']);
export const PLACE_LANDCOVER = new Set(['park', 'garden', 'beach']);
export const PLACE_AEROWAY = new Set(['apron']);
/** POI classes the registry reads (named destinations, stations and the venues districts are made of). */
export const PLACE_POI = new Set([...Object.keys(POI_CATEGORY), 'railway', 'entrance', 'ferry_terminal', 'bus', 'aerialway', 'bar', 'beer', 'lodging']);

const STATION_MODE: Record<string, TransitMode> = {
  'railway/station': 'rail', 'railway/halt': 'rail', 'railway/subway': 'metro', 'railway/tram_stop': 'tram',
  'ferry_terminal/ferry_terminal': 'ferry', 'bus/bus_station': 'bus', 'aerialway/station': 'cable',
};
const MODE_ORDER: TransitMode[] = ['rail', 'metro', 'ferry', 'tram', 'funicular', 'cable', 'bus'];
const MODE_CATEGORY: Record<TransitMode, PlaceCategory> = {
  rail: 'rail_station', metro: 'metro_station', ferry: 'ferry_pier', tram: 'tram_stop', funicular: 'cable_car', cable: 'cable_car', bus: 'bus_station',
};
/** heavy modes: a station where two of them meet is an interchange, one tier up */
const HEAVY: TransitMode[] = ['rail', 'metro', 'ferry'];

/** Estimated people a day by station tier (game settings, shown as estimates). */
const STATION_USERS = [60000, 20000, 8000, 2500, 600];
/** Estimated passengers a year by airport tier, when no measured figure exists (game settings). */
const AIRPORT_PAX = [35e6, 15e6, 3e6, 4e5, 3e4];
/** Airports listed beyond the map: large and medium ones within 100 km, small ones within 50 km. */
const BEYOND_KM = { L: 100, M: 100, S: 50 } as const;

// ─────────────────────────────────────────── the registry

export function buildPlaces(inp: PlaceInputs): CityPlace[] {
  const out: CityPlace[] = [];
  const { toXY, toLngLat } = inp;

  const bgrid = new Grid<{ x: number; y: number; fa: number }>(200);
  for (const b of inp.buildings) bgrid.add(b.x, b.y, b);
  const floorIn = (p: RawPoly) => {
    let s = 0;
    const r = Math.max(p.x1 - p.x0, p.y1 - p.y0) / 2 + 50;
    for (const b of bgrid.near((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, r)) if (inPoly(p, b.x, b.y)) s += b.fa;
    return s;
  };
  const floorSum = (x: number, y: number, r: number) => {
    let s = 0;
    for (const b of bgrid.near(x, y, r)) if (Math.hypot(b.x - x, b.y - y) <= r) s += b.fa;
    return s;
  };
  /** the floor area of the largest building close by: the one a place without an outline is in */
  const largestNear = (x: number, y: number, r: number) => {
    let best = 0;
    for (const b of bgrid.near(x, y, r)) if (b.fa > best && Math.hypot(b.x - x, b.y - y) <= r) best = b.fa;
    return best;
  };

  const labelGrid = new Grid<{ name: string; x: number; y: number }>(1000);
  for (const l of inp.labels)
    if (l.kind === 'neighbourhood' || l.kind === 'quarter' || l.kind === 'suburb' || l.kind === 'village' || l.kind === 'town') {
      const [x, y] = toXY(l.lngLat[0], l.lngLat[1]);
      labelGrid.add(x, y, { name: l.name, x, y });
    }
  /** the nearest neighbourhood name, for districts and unnamed outlines */
  const areaName = (x: number, y: number) => {
    let best: string | null = null, bd = Infinity;
    for (const l of labelGrid.near(x, y, 2500)) {
      const d = Math.hypot(l.x - x, l.y - y);
      if (d < bd || (d === bd && best !== null && l.name < best)) {
        bd = d;
        best = l.name;
      }
    }
    return best;
  };
  const add = (p: Omit<CityPlace, 'distanceKm' | 'reachable' | 'lngLat'> & { x: number; y: number }) => {
    const { x, y, ...rest } = p;
    const [lng, lat] = toLngLat(x, y);
    // the projector is centred on the region centre
    out.push({ ...rest, lngLat: [r6(lng), r6(lat)], reachable: inp.inRegion(lng, lat), distanceKm: +(Math.hypot(x, y) / 1000).toFixed(1) });
  };

  // ---------------- named destinations, with their outline where one is mapped
  const polys = inp.polys.filter((p) => POLY_CATEGORY[`${p.layer}:${p.cls}`]);
  const polyGrid = new Grid<RawPoly>(500);
  for (const p of polys) polyGrid.add((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, p);
  /** the largest outline of this category that contains the point (or nearly) */
  const polyOf = (cat: PlaceCategory, x: number, y: number) => {
    let best: RawPoly | null = null;
    for (const p of polyGrid.near(x, y, 1500)) {
      if (POLY_CATEGORY[`${p.layer}:${p.cls}`] !== cat || !inPoly(p, x, y, 40)) continue;
      if (!best || p.area > best.area || (p.area === best.area && p.id < best.id)) best = p;
    }
    return best;
  };
  // points that name the same place are one group: inside the same outline (the faculties of a
  // campus, the models inside a miniature park), or the same name within 250 m. The most
  // prominent point (lowest tile rank, then the shortest name) names the place.
  type Group = { cat: PlaceCategory; members: RawPoi[]; x: number; y: number; poly: RawPoly | null };
  const groups: Group[] = [];
  const byPoly = new Map<RawPoly, Group>();
  const gGrid = new Grid<Group>(300);
  const named = inp.pois
    .map((poi) => ({ poi, cat: properName(poi.name) ? POI_CATEGORY[poi.cls]?.(poi.sub, poi.name) ?? null : null }))
    .filter((c): c is { poi: RawPoi; cat: PlaceCategory } => c.cat !== null)
    .sort((a, b) => a.poi.rank - b.poi.rank || a.poi.name.length - b.poi.name.length || a.poi.id - b.poi.id);
  for (const c of named) {
    const poly = polyOf(c.cat, c.poi.x, c.poi.y);
    const hit = (poly && byPoly.get(poly)) || gGrid.near(c.poi.x, c.poi.y, 250).find((g) => g.cat === c.cat && Math.hypot(g.x - c.poi.x, g.y - c.poi.y) < 250 && sameName(g.members[0].name, c.poi.name));
    if (hit) {
      hit.members.push(c.poi);
      if (poly && !hit.poly) {
        hit.poly = poly;
        byPoly.set(poly, hit);
      }
      continue;
    }
    const g: Group = { cat: c.cat, members: [c.poi], x: c.poi.x, y: c.poi.y, poly };
    groups.push(g);
    gGrid.add(g.x, g.y, g);
    if (poly) byPoly.set(poly, g);
  }
  for (const g of groups) {
    const poly = g.poly;
    // small parks and gardens are not destinations
    if (g.cat === 'park' && (!poly || poly.area < 15000)) continue;
    const lead = g.members[0];
    const area = poly?.area ?? 0;
    // without an outline: the building it is in (a bazaar spreads over many small ones)
    const floor = poly ? floorIn(poly) : g.cat === 'market' ? floorSum(lead.x, lead.y, 60) : largestNear(lead.x, lead.y, g.cat === 'mall' ? 90 : 40);
    add({
      id: `osm:${lead.id}`, name: lead.name, category: g.cat, x: lead.x, y: lead.y,
      ...(poly ? { ring: simplifiedRing(poly, toLngLat) } : {}),
      areaM2: Math.round(area), floorM2: Math.round(floor), scale: estimateScale(g.cat, area, floor),
      sources: poly ? ['tiles:poi', `tiles:${poly.layer}`] : ['tiles:poi'], location: 'measured', confidence: poly ? 0.9 : 0.7,
    });
  }
  const used = new Set(byPoly.keys());
  // large hospital, campus and stadium outlines without a named point, named after the area
  for (const p of polys) {
    if (used.has(p)) continue;
    const cat = POLY_CATEGORY[`${p.layer}:${p.cls}`];
    const min = cat === 'stadium' ? 12000 : cat === 'university' ? 40000 : cat === 'hospital' ? 25000 : Infinity;
    if (p.area < min) continue;
    const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
    const near = areaName(cx, cy);
    const floor = floorIn(p);
    add({
      id: `${p.layer}:${p.id}`, name: near ? `${PLACE_LABEL[cat]}, ${near}` : PLACE_LABEL[cat], category: cat, x: cx, y: cy, ring: simplifiedRing(p, toLngLat),
      areaM2: Math.round(p.area), floorM2: Math.round(floor), scale: estimateScale(cat, p.area, floor), sources: [`tiles:${p.layer}`], location: 'estimated', confidence: 0.5,
    });
  }

  // ---------------- stations: one place each, with every mode that calls there
  const lineGrid = new Grid<RawLine>(300);
  for (const l of inp.lines) {
    if (l.service) continue; // yards, sidings and crossovers are not running lines
    const step = 2 * Math.max(1, Math.floor(l.pts.length / 2 / 40));
    for (let i = 0; i < l.pts.length; i += step) lineGrid.add(l.pts[i], l.pts[i + 1], l);
  }
  /** distinct mapped lines within r metres (tracks through a station, ferry routes from a pier) */
  const linesNear = (x: number, y: number, r: number, pick: (l: RawLine) => boolean) => {
    const ids = new Set<number>();
    for (const l of lineGrid.near(x, y, r)) {
      if (ids.has(l.id) || !pick(l)) continue;
      for (let i = 0; i < l.pts.length; i += 2)
        if (Math.hypot(l.pts[i] - x, l.pts[i + 1] - y) < r) {
          ids.add(l.id);
          break;
        }
    }
    return ids.size;
  };
  /** a mapped railway station is also used for funiculars and some metro stations: the tracks tell */
  const railMode = (x: number, y: number): TransitMode => {
    if (linesNear(x, y, 150, (l) => l.cls === 'rail' && (l.sub === 'rail' || l.sub === 'narrow_gauge' || l.sub === 'light_rail'))) return 'rail';
    if (linesNear(x, y, 120, (l) => l.cls === 'rail' && l.sub === 'funicular')) return 'funicular';
    if (linesNear(x, y, 150, (l) => l.cls === 'transit' && (l.sub === 'subway' || l.sub === 'monorail'))) return 'metro';
    if (linesNear(x, y, 100, (l) => l.cls === 'transit' && l.sub === 'tram')) return 'tram';
    return 'rail';
  };
  type St = { name: string; id: number; x: number; y: number; modes: Set<TransitMode>; halt: boolean; n: number };
  const stations: St[] = [];
  const sGrid = new Grid<St>(400);
  const entrances: RawPoi[] = [];
  for (const poi of inp.pois.slice().sort((a, b) => a.rank - b.rank || a.id - b.id)) {
    if (poi.cls === 'entrance' && poi.sub === 'subway_entrance') {
      entrances.push(poi);
      continue;
    }
    let mode = STATION_MODE[`${poi.cls}/${poi.sub}`];
    if (!mode || !properName(poi.name)) continue;
    if (mode === 'rail') mode = railMode(poi.x, poi.y);
    // one station: the same name within 400 m (platforms, an interchange), the same mode within
    // 120 m (stands of one bus station), or another mode within 80 m
    const hit = sGrid.near(poi.x, poi.y, 400).find((s) => {
      const d = Math.hypot(s.x - poi.x, s.y - poi.y);
      return (d < 400 && sameName(s.name, poi.name)) || (d < 120 && s.modes.has(mode)) || (d < 80 && !s.modes.has(mode));
    });
    if (hit) {
      hit.modes.add(mode);
      if (poi.sub === 'station') hit.halt = false;
      hit.x = (hit.x * hit.n + poi.x) / (hit.n + 1);
      hit.y = (hit.y * hit.n + poi.y) / (hit.n + 1);
      hit.n++;
      continue;
    }
    const s: St = { name: poi.name, id: poi.id, x: poi.x, y: poi.y, modes: new Set([mode]), halt: poi.sub === 'halt', n: 1 };
    stations.push(s);
    sGrid.add(s.x, s.y, s);
  }
  const yards = inp.polys.filter((p) => p.layer === 'landuse' && p.cls === 'railway');
  for (const s of stations) {
    const modes = MODE_ORDER.filter((m) => s.modes.has(m));
    const main = modes[0];
    const tracks = main === 'rail' ? linesNear(s.x, s.y, 120, (l) => l.cls === 'rail' && l.sub === 'rail') : 0;
    // named ferry routes calling here
    const ferries = main === 'ferry' ? linesNear(s.x, s.y, 250, (l) => l.cls === 'ferry_route') : 0;
    const yard = main === 'rail' ? Math.max(0, ...yards.filter((p) => inPoly(p, s.x, s.y, 60)).map((p) => p.area)) : 0;
    // 1 main station, 2 regional, 3 metro or a busy pier, 4 tram or bus station, 5 small halt
    let tier =
      main === 'rail' ? (tracks >= 8 || yard > 40000 ? 1 : s.halt && tracks < 3 ? 5 : 2)
      : main === 'metro' ? 3
      : main === 'ferry' ? (ferries >= 4 ? 2 : 3)
      : main === 'cable' || main === 'funicular' ? 5
      : 4;
    if (modes.filter((m) => HEAVY.includes(m)).length > 1) tier = Math.max(1, tier - 1); // an interchange
    const access = modes.includes('metro') || modes.includes('rail')
      ? entrances.filter((e) => Math.hypot(e.x - s.x, e.y - s.y) < 250).slice(0, 6).map((e) => {
          const [lng, lat] = toLngLat(e.x, e.y);
          return [r6(lng), r6(lat)] as LngLat;
        })
      : [];
    add({
      id: `osm:${s.id}`, name: s.name, category: MODE_CATEGORY[main], x: s.x, y: s.y, areaM2: 0, floorM2: 0,
      scale: { value: STATION_USERS[tier - 1], unit: 'users_day', tier, measured: false, source: 'from the station type, tracks and connections' },
      modes, ...(access.length ? { access } : {}), sources: ['tiles:poi', ...(tracks || ferries ? ['tiles:transportation'] : [])], location: 'measured', confidence: 0.8,
    });
  }

  // ---------------- districts: dense clusters of bars or hotels (single venues are not places)
  const cluster = (pick: (p: RawPoi) => boolean, cell: number, seedMin: number, joinMin: number, cat: PlaceCategory, unit: ScaleUnit, steps: number[], suffix: string) => {
    const cells = new Map<string, { cx: number; cy: number; n: number; sx: number; sy: number }>();
    for (const p of inp.pois) {
      if (!pick(p)) continue;
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), k = `${cx},${cy}`;
      const c = cells.get(k) ?? { cx, cy, n: 0, sx: 0, sy: 0 };
      c.n++;
      c.sx += p.x;
      c.sy += p.y;
      cells.set(k, c);
    }
    const seen = new Set<string>();
    const seeds = [...cells.entries()].filter(([, c]) => c.n >= seedMin).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
    for (const [k0, c0] of seeds) {
      if (seen.has(k0)) continue;
      const stack = [k0];
      let n = 0, sx = 0, sy = 0;
      const members: string[] = [];
      while (stack.length) {
        const k = stack.pop()!;
        const c = cells.get(k);
        // a district stays within about a kilometre of its densest block
        if (seen.has(k) || !c || c.n < joinMin || Math.hypot(c.cx - c0.cx, c.cy - c0.cy) * cell > 900) continue;
        seen.add(k);
        members.push(k);
        n += c.n;
        sx += c.sx;
        sy += c.sy;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) stack.push(`${c.cx + dx},${c.cy + dy}`);
      }
      const x = sx / n, y = sy / n;
      const near = areaName(x, y);
      add({
        id: `cl:${cat}:${members.sort()[0]}`, name: near ? `${near} ${suffix}` : PLACE_LABEL[cat], category: cat, x, y, areaM2: Math.round(members.length * cell * cell), floorM2: 0,
        scale: { value: n, unit, tier: tierBy(n, steps), measured: false, source: 'from the count of mapped venues' }, sources: ['tiles:poi'], location: 'estimated', confidence: 0.6,
      });
    }
  };
  cluster((p) => (p.cls === 'bar' && (p.sub === 'bar' || p.sub === 'nightclub')) || (p.cls === 'beer' && p.sub === 'pub'), 200, 8, 3, 'nightlife', 'venues', [80, 40, 20, 10], 'nightlife');
  cluster((p) => p.cls === 'lodging' && p.sub === 'hotel', 250, 10, 5, 'hotel_area', 'hotels', [150, 60, 30, 15], 'hotels');

  // ---------------- industrial areas (shift work) and beaches
  for (const p of inp.polys) {
    const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
    if (p.layer === 'landuse' && p.cls === 'industrial' && p.area >= 30000) {
      const near = areaName(cx, cy);
      add({
        id: `landuse:${p.id}`, name: near ? `${near} industrial area` : 'Industrial area', category: 'industrial', x: cx, y: cy, ring: simplifiedRing(p, toLngLat),
        areaM2: Math.round(p.area), floorM2: Math.round(floorIn(p)), scale: { value: Math.round(p.area), unit: 'm2', tier: tierBy(p.area, [500000, 200000, 80000]), measured: true, source: 'the OpenStreetMap outline' },
        sources: ['tiles:landuse'], location: 'measured', confidence: 0.7,
      });
    }
    if (p.layer === 'landcover' && p.cls === 'beach' && p.area >= 4000) {
      const label = inp.pois.find((q) => q.name && /beach|plaj|platja|playa|strand/i.test(q.name) && inPoly(p, q.x, q.y, 150));
      const near = areaName(cx, cy);
      add({
        id: `landcover:${p.id}`, name: label?.name ?? (near ? `Beach, ${near}` : 'Beach'), category: 'beach', x: cx, y: cy, ring: simplifiedRing(p, toLngLat),
        areaM2: Math.round(p.area), floorM2: 0, scale: { value: Math.round(p.area), unit: 'm2', tier: tierBy(p.area, [100000, 40000, 15000]), measured: true, source: 'the OpenStreetMap outline' },
        sources: ['tiles:landcover'], location: 'measured', confidence: 0.7,
      });
    }
  }

  // ---------------- airports: on the map (with a landside anchor), then beyond it
  const aprons = inp.polys.filter((p) => p.layer === 'aeroway' && p.cls === 'apron');
  const seenAirport = new Set<string>();
  const airport = (code: string, name: string, row: AirportRow | null, iata: string | undefined, icao: string | undefined, x: number, y: number, mapped: boolean, sources: string[]) => {
    seenAirport.add(code);
    const wiki = WIKI.airports[row?.[0] ?? iata ?? ''];
    const type = row?.[2];
    const tier = wiki ? tierBy(wiki[0], [30e6, 10e6, 2e6, 2e5]) : type === 'L' ? 2 : type === 'M' ? 3 : type === 'S' ? 4 : 5;
    const scale: PlaceScale = wiki
      ? { value: wiki[0], unit: 'pax_year', tier, measured: true, source: `Wikidata, ${wiki[1]}` }
      : { value: AIRPORT_PAX[tier - 1], unit: 'pax_year', tier, measured: false, source: row ? 'from the airport type (OurAirports)' : 'from the map label' };
    add({
      id: `iata:${code}`, name, category: 'airport', x, y, areaM2: 0, floorM2: 0, codes: { ...(row?.[0] || iata ? { iata: row?.[0] || iata } : {}), ...(row?.[1] || icao ? { icao: row?.[1] || icao } : {}) },
      scale, sources: [...sources, ...(row ? ['ourairports'] : []), ...(wiki ? ['wikidata'] : [])], location: mapped ? 'measured' : 'estimated', confidence: mapped ? 0.75 : 0.5,
    });
  };
  for (const a of inp.aerodromes.slice().sort((p, q) => p.id - q.id)) {
    const row = airportRow(a.iata) ?? airportRow(a.icao);
    if (!row) continue; // airfields without scheduled passenger flights are not destinations
    const code = row[0];
    if (seenAirport.has(code)) continue;
    const [lx, ly] = toXY(a.lngLat[0], a.lngLat[1]);
    // landside: the biggest building beside an apron, within 4 km of the label (terminals sit there)
    let ax = lx, ay = ly, mapped = false, best = 0;
    for (const ap of aprons) {
      const mx = (ap.x0 + ap.x1) / 2, my = (ap.y0 + ap.y1) / 2;
      if (Math.hypot(mx - lx, my - ly) > 4000) continue;
      for (const b of bgrid.near(mx, my, Math.max(ap.x1 - ap.x0, ap.y1 - ap.y0) / 2 + 250))
        if (b.fa > best && inPoly(ap, b.x, b.y, 200)) {
          best = b.fa;
          ax = b.x;
          ay = b.y;
          mapped = true;
        }
    }
    airport(code, a.name || row[3], row, a.iata, a.icao, ax, ay, mapped, mapped ? ['tiles:aerodrome', 'tiles:aeroway'] : ['tiles:aerodrome']);
  }
  for (const row of AIRPORTS) {
    if (seenAirport.has(row[0])) continue;
    const km = distanceM(inp.centre, [row[4], row[5]]) / 1000;
    if (km > BEYOND_KM[row[2]]) continue;
    const [x, y] = toXY(row[4], row[5]);
    airport(row[0], row[3], row, undefined, undefined, x, y, false, []);
  }

  applyWikidata(out, toXY);
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.scale.tier - b.scale.tier || a.id.localeCompare(b.id));
}

/** Size from footprint and floor area: estimates (game settings), except outlines, which are mapped. Sources read "Estimated …". */
function estimateScale(cat: PlaceCategory, area: number, floor: number): PlaceScale {
  const est = (value: number, unit: ScaleUnit, tier: number, source: string): PlaceScale => ({ value: Math.round(value), unit, tier: Math.min(5, tier), measured: false, source });
  // grounds and parks are as big as their mapped outline
  const outline = (a: number): PlaceScale => ({ value: Math.round(a), unit: 'm2', tier: tierBy(a, [400000, 100000, 30000]), measured: true, source: 'the OpenStreetMap outline' });
  switch (cat) {
    case 'hospital': {
      const beds = floor ? clamp(floor / 120, 20, 2500) : 150;
      return est(beds, 'beds', tierBy(beds, [800, 300, 100, 40]), floor ? 'from the floor area' : 'as a typical size');
    }
    case 'university': {
      const st = floor ? clamp(floor / 15, 300, 45000) : 2000;
      return est(st, 'students', tierBy(st, [20000, 8000, 3000, 1000]), floor ? 'from the campus floor area' : 'as a typical size');
    }
    case 'school': {
      const pu = floor ? clamp(floor / 10, 100, 2500) : 450;
      return est(pu, 'pupils', tierBy(pu, [1500, 900, 450]) + 1, floor ? 'from the floor area' : 'as a typical size');
    }
    case 'stadium': {
      const seats = area ? clamp(0.6 * (area - 9000), 1000, 90000) : 5000;
      return est(seats, 'seats', tierBy(seats, [40000, 20000, 8000, 3000]), area ? 'from the stadium outline' : 'as a typical size');
    }
    case 'venue': {
      const seats = clamp((floor || 3000) * 0.1, 80, 5000);
      return est(seats, 'seats', tierBy(seats, [3000, 1200, 500]) + 1, floor ? 'from the building size' : 'as a typical size');
    }
    case 'mall':
    case 'market': {
      // a tower over a mall is mapped as one building: the shopping floors are a fraction of it
      const f = Math.min(floor || area || 3000, 250000);
      return est(f, 'm2_floor', tierBy(f, [80000, 30000, 10000, 3000]), floor ? 'from the building' : area ? 'from the mapped area' : 'as a typical size');
    }
    case 'attraction':
      if (area) return outline(area);
      // a museum or palace without grounds: its building
      return floor ? est(floor, 'm2_floor', tierBy(floor, [30000, 8000, 2500, 800]), 'from the building') : est(0, 'm2', 5, 'as a typical size');
    case 'park':
      return area ? outline(area) : est(0, 'm2', 4, 'as a typical size');
    default:
      return est(area, 'm2', 4, 'as a typical size');
  }
}

/** Shared distinctive words, as a share of the longer name (0 for names in different scripts). */
function nameScore(a: string, b: string): number {
  const A = new Set(keyWords(a).map(stem)), B = new Set(keyWords(b).map(stem));
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(1, A.size, B.size);
}
/** "üniversitesi" and "university", "hastanesi" and "hospital" count as the same word */
const stem = (w: string) => (/^univ/.test(w) ? 'univ' : /^(hastane|hospital|hospit|klinik)/.test(w) ? 'hosp' : /^(stad|estadi)/.test(w) ? 'stad' : w.slice(0, 6));

/** Measured sizes from the Wikidata extract: the place of the same kind within 400 m whose name matches best, then the nearest. */
function applyWikidata(places: CityPlace[], toXY: PlaceInputs['toXY']) {
  const byCat = new Map<PlaceCategory, { p: CityPlace; x: number; y: number }[]>();
  for (const p of places) {
    if (p.category !== 'stadium' && p.category !== 'university' && p.category !== 'hospital') continue;
    const [x, y] = toXY(p.lngLat[0], p.lngLat[1]);
    const l = byCat.get(p.category) ?? [];
    l.push({ p, x, y });
    byCat.set(p.category, l);
  }
  for (const w of WIKI.places) {
    const [wx, wy] = toXY(w.lng, w.lat);
    let best: CityPlace | null = null, bs = -1, bd = Infinity;
    for (const c of byCat.get(w.kind) ?? []) {
      const d = Math.hypot(c.x - wx, c.y - wy);
      const sc = nameScore(w.name, c.p.name);
      // a university's coordinate may sit at another faculty: an exact name match may be further away
      if (d >= 400 && !(sc >= 0.99 && d < 1500)) continue;
      if (sc > bs || (sc === bs && d < bd)) {
        bs = sc;
        bd = d;
        best = c.p;
      }
    }
    const value = w.capacity ?? w.students ?? w.beds;
    if (!best || !value) continue;
    const unit: ScaleUnit = w.capacity ? 'seats' : w.students ? 'students' : 'beds';
    const steps = unit === 'seats' ? [40000, 20000, 8000, 3000] : unit === 'students' ? [20000, 8000, 3000, 1000] : [800, 300, 100, 40];
    // a university's figure covers the whole institution, not only this campus
    best.scale = { value, unit, tier: tierBy(value, steps), measured: true, source: `Wikidata ${w.q}${unit === 'students' ? ', whole university' : ''}` };
    if (!best.sources.includes('wikidata')) best.sources.push('wikidata');
  }
}
