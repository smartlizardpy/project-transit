// Activity zones and the activity budget (docs/city-activity-engine-plan.md, sections 6.4, 7.1, 7.2).
//
// - Zones: 600 m squares (4 × 4 demand cells) inside the operated areas and one ring of areas
//   around them; one zone per operating area beyond that; and one zone per significant place
//   (airport, main station, pier, hospital, campus, mall, stadium, big market), so that its trips
//   end at its entrance. Airports beyond the map are zones without cells.
// - The building stock is the budget. Residents and jobs come from building floor area. Places
//   claim the cells inside their outline (their staff are the jobs there) and replace those
//   cells' attraction for their main purpose with one from their size. Small POIs (shops, cafés,
//   bars) change the kind of attraction in a cell, not its size.

import type { RegionData, DemandGrid } from '../world/region.ts';
import type { CityPlace } from '../world/places.ts';
import type { LngLat } from '../world/graph.ts';
import type { Season } from '../calendar.ts';
import { tileAt, zoneId } from '../world/zoneTiles.ts';
import { KINDS, KIND, KIND_COUNT, HOME_RATE, JOB_RATE, GUEST_RATE, HOTEL, OCCUPANCY, GATEWAY_SHARE, GATEWAY_MIX, OUTDOOR_SEASON, type Attraction } from './params.ts';
import { PROFILE, profileOf } from './profiles.ts';

export type ZoneKind = 'square' | 'area' | 'place' | 'beyond';

export interface ActivityZone {
  /** 'q<x>_<y>' (square), 'a:<area>' (operating area), 'p:<place id>' (place, also beyond the map) */
  id: string;
  kind: ZoneKind;
  /** operating area it lies in (for aggregation); '' beyond the map */
  area: string;
  place?: string;
  name: string;
  /** activity-weighted centre (local metres), and where people walk to and from (places: the entrance) */
  x: number;
  y: number;
  lngLat: LngLat;
  /** typical distance of a trip inside the zone, metres */
  inner: number;
  residents: number;
  jobs: number;
  /** share of people with a car available (estimated from density and distance to the centre) */
  car: number;
  /** minutes to find parking at the destination */
  parking: number;
}

export interface ActivityZones {
  /** identifies the inputs (map, territory, season): equal keys give equal zones */
  key: string;
  list: ActivityZone[];
  /** per demand cell: the zone its homes and its activities belong to (-1: none) */
  homeOf: Int32Array;
  actOf: Int32Array;
  /** per demand cell: weights for walking to stops (residents; all attraction) */
  homeW: Float32Array;
  actW: Float32Array;
  /** per zone and tour kind [z * KIND_COUNT + k]: tours produced per weekday, the share made from homes, and attraction */
  prod: Float64Array;
  homeShare: Float64Array;
  attr: Float64Array;
  /** per zone: the activity profile its tours keep to (profiles.ts; the city's own for squares and areas) */
  profile: Uint8Array;
}

/** Categories that get their own zone, with the largest tier that qualifies. */
const PLACE_ZONE: Partial<Record<CityPlace['category'], number>> = {
  airport: 5, rail_station: 3, ferry_pier: 3, metro_station: 3, bus_station: 3, hospital: 3, university: 3, mall: 3, stadium: 3, market: 2,
};
/** Places that add visitors to the zone they are in (by tier, visitors a day). */
const VISIT_BY_TIER: Partial<Record<CityPlace['category'], number[]>> = {
  attraction: [6000, 2500, 1000, 400, 100], park: [3000, 1200, 500, 200, 60], beach: [5000, 2000, 800, 300, 100], market: [3000, 1200, 500, 200, 80],
  venue: [800, 400, 200, 100, 50], hotel_area: [0, 0, 0, 0, 0],
};
/** Share of a place's jobs worked in shifts. */
const SHIFT_SHARE: Partial<Record<CityPlace['category'], number>> = { hospital: 0.6, airport: 0.8, industrial: 0.5 };

const ATTR_INDEX: Record<Attraction, number[]> = (() => {
  const out = {} as Record<Attraction, number[]>;
  KINDS.forEach((k, i) => (out[k.attr] ??= []).push(i));
  return out;
})();

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/** Attraction of one demand cell per kind of activity (people a day). */
function cellAttraction(g: DemandGrid, k: number, shift: number, uni: boolean): Record<Attraction, number> {
  const work = g.work?.[k] ?? g.jobs[k];
  const res = g.residents[k];
  const wShop = g.shopping[k], wLeis = g.leisure[k], wServ = g.services?.[k] ?? 0;
  // the floor area hosts visits; the POIs present decide what kind
  const cap = work * 10;
  const den = wShop + wLeis + wServ + work || 1;
  const shop = (cap * wShop) / den, leis = (cap * wLeis) / den, serv = (cap * wServ) / den;
  return {
    work: work * (1 - shift),
    shift: work * shift,
    school: uni ? 0 : g.education[k],
    university: uni ? g.education[k] : 0,
    shopping: shop,
    errand: serv + shop * 0.3 + res * 0.03,
    health: g.health?.[k] ?? 0,
    leisure: leis + res * 0.15,
    night: leis * 0.25,
    visit: leis * 0.15 + shop * 0.05,
    business: work * 0.5 + (shop + leis) * 0.3,
    airport: 0,
  };
}

export interface ZoneInputs {
  region: RegionData;
  toXY: (lng: number, lat: number) => [number, number];
  toLngLat: (x: number, y: number) => LngLat;
  owned: readonly string[];
  season: Season;
}

export function zonesKey(inp: ZoneInputs): string {
  return `${inp.region.fingerprint}|${inp.region.zones.length}|${[...inp.owned].sort().join(',')}|${inp.season}`;
}

export function buildActivityZones(inp: ZoneInputs): ActivityZones {
  const { region, toXY, toLngLat, owned, season } = inp;
  const g = region.demand;
  const N = g.w * g.h;
  const areas = new Map(region.zones.map((z) => [z.id, z]));
  // fine squares in the operated areas and one ring of areas around them
  const fine = new Set<string>(owned);
  for (const id of owned) for (const n of areas.get(id)?.neighbours ?? []) fine.add(n);
  const [cx0, cy0] = toXY(region.spec.centre[0], region.spec.centre[1]);

  const list: ActivityZone[] = [];
  const byId = new Map<string, number>();
  const homeOf = new Int32Array(N).fill(-1), actOf = new Int32Array(N).fill(-1);
  const cellXY = (k: number): [number, number] => [g.x0 + ((k % g.w) + 0.5) * g.cell, g.y0 + (Math.floor(k / g.w) + 0.5) * g.cell];
  const add = (z: ActivityZone) => {
    byId.set(z.id, list.length);
    list.push(z);
    return list.length - 1;
  };

  // ── square and area zones from the cells
  const cellArea = new Array<string>(N);
  for (let k = 0; k < N; k++) {
    const live = g.residents[k] + g.jobs[k] + g.education[k] + g.shopping[k] + g.leisure[k] + g.other[k];
    if (!(live > 0.5)) continue;
    const [x, y] = cellXY(k);
    const ll = toLngLat(x, y);
    const t = tileAt(ll);
    const area = zoneId(t[0], t[1]);
    if (!areas.has(area)) continue;
    cellArea[k] = area;
    const id = fine.has(area) ? `q${Math.floor((k % g.w) / 4)}_${Math.floor(Math.floor(k / g.w) / 4)}` : `a:${area}`;
    let zi = byId.get(id);
    if (zi === undefined) {
      const a = areas.get(area)!;
      zi = add({ id, kind: id[0] === 'q' ? 'square' : 'area', area, name: a.name, x: 0, y: 0, lngLat: ll, inner: id[0] === 'q' ? 310 : 950, residents: 0, jobs: 0, car: 0.5, parking: 2 });
    }
    homeOf[k] = zi;
    actOf[k] = zi;
  }

  // ── places that get their own zone claim the cells inside their outline (or the cell at their entrance)
  const places = (region.cityPlaces ?? [])
    .filter((p) => (PLACE_ZONE[p.category] ?? 0) >= p.scale.tier)
    .sort((a, b) => a.scale.tier - b.scale.tier || a.id.localeCompare(b.id));
  const claimedBy = new Int32Array(N).fill(-1);
  const shiftOf = new Float32Array(N);
  const uniCell = new Uint8Array(N);
  const cellOfXY = (x: number, y: number) => {
    const cx = Math.floor((x - g.x0) / g.cell), cy = Math.floor((y - g.y0) / g.cell);
    return cx < 0 || cy < 0 || cx >= g.w || cy >= g.h ? -1 : cy * g.w + cx;
  };
  const ringCells = (p: CityPlace): number[] => {
    const out: number[] = [];
    if (p.ring && p.ring.length >= 3) {
      const ring = p.ring.map((q) => toXY(q[0], q[1]));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of ring) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      for (let cy = Math.max(0, Math.floor((y0 - g.y0) / g.cell)); cy <= Math.min(g.h - 1, Math.floor((y1 - g.y0) / g.cell)); cy++)
        for (let cx = Math.max(0, Math.floor((x0 - g.x0) / g.cell)); cx <= Math.min(g.w - 1, Math.floor((x1 - g.x0) / g.cell)); cx++) {
          const k = cy * g.w + cx;
          const [px, py] = cellXY(k);
          if (pointInRing(px, py, ring)) out.push(k);
        }
    }
    if (!out.length) {
      const [x, y] = toXY(p.lngLat[0], p.lngLat[1]);
      const k = cellOfXY(x, y);
      if (k >= 0) out.push(k);
    }
    return out;
  };
  // industrial areas mark shift work without a zone of their own
  for (const p of region.cityPlaces ?? []) if (p.category === 'industrial') for (const k of ringCells(p)) shiftOf[k] = Math.max(shiftOf[k], SHIFT_SHARE.industrial!);
  const placeZone = new Map<number, CityPlace>();
  /** residents inside a place's outline (student housing on a campus) */
  const housed = new Map<number, number>();
  for (const p of places) {
    const [x, y] = toXY(p.lngLat[0], p.lngLat[1]);
    const t = tileAt(p.lngLat);
    const area = zoneId(t[0], t[1]);
    const beyond = !p.reachable;
    const zi = add({
      id: `p:${p.id}`, kind: beyond ? 'beyond' : 'place', area: areas.has(area) ? area : '', place: p.id, name: p.name, x, y, lngLat: p.lngLat,
      inner: 250, residents: 0, jobs: 0, car: 0.6, parking: p.category === 'stadium' ? 8 : 3,
    });
    placeZone.set(zi, p);
    if (beyond) continue;
    for (const k of ringCells(p)) {
      if (claimedBy[k] >= 0) continue;
      if (p.category === 'university') housed.set(zi, (housed.get(zi) ?? 0) + g.residents[k]);
      claimedBy[k] = zi;
      actOf[k] = zi;
      if (SHIFT_SHARE[p.category]) shiftOf[k] = SHIFT_SHARE[p.category]!;
      if (p.category === 'university') uniCell[k] = 1;
    }
  }

  // ── budget: production and attraction per zone and kind
  const Z = list.length, K = KIND_COUNT;
  const prod = new Float64Array(Z * K), homeProd = new Float64Array(Z * K), attr = new Float64Array(Z * K);
  const homeW = new Float32Array(N), actW = new Float32Array(N);
  const sx = new Float64Array(Z), sy = new Float64Array(Z), sw = new Float64Array(Z);
  const occ = OCCUPANCY[season];
  const claimedMain = new Map<number, Attraction>([]);
  for (const [zi, p] of placeZone) claimedMain.set(zi, mainAttraction(p));
  for (let k = 0; k < N; k++) {
    const hz = homeOf[k], az = actOf[k];
    if (hz < 0 && az < 0) continue;
    const res = g.residents[k];
    const work = g.work?.[k] ?? g.jobs[k];
    const a = cellAttraction(g, k, shiftOf[k], uniCell[k] === 1);
    // a place zone's own size replaces its cells' attraction for its main purpose
    const main = az >= 0 ? claimedMain.get(az) : undefined;
    if (main && main !== 'work' && main !== 'shift') a[main] = 0;
    let aw = 0;
    for (const key of Object.keys(a) as Attraction[]) {
      const v = a[key];
      if (!v || az < 0) continue;
      aw += v;
      for (const ki of ATTR_INDEX[key]) attr[az * K + ki] += v;
    }
    actW[k] = aw;
    homeW[k] = res;
    const guests = (g.lodging?.[k] ?? 0) * HOTEL.rooms * HOTEL.guests * occ;
    if (hz >= 0) {
      for (const [kind, rate] of Object.entries(HOME_RATE)) {
        prod[hz * K + KIND[kind]] += res * rate!;
        homeProd[hz * K + KIND[kind]] += res * rate!;
      }
      list[hz].residents += res;
    }
    if (az >= 0) {
      for (const [kind, rate] of Object.entries(JOB_RATE)) prod[az * K + KIND[kind]] += work * rate!;
      for (const [kind, rate] of Object.entries(GUEST_RATE)) prod[az * K + KIND[kind]] += guests * rate!;
      list[az].jobs += work;
    }
    const [x, y] = cellXY(k);
    const w = res + aw + 1e-3;
    const z = az >= 0 ? az : hz;
    if (list[z].kind === 'place') continue; // places keep their entrance as their centre
    sx[z] += x * w;
    sy[z] += y * w;
    sw[z] += w;
  }
  // places: size-based attraction for their main purpose, gateways, airports
  for (const [zi, p] of placeZone) {
    const z = list[zi];
    const main = claimedMain.get(zi)!;
    const v = placeVisitors(p);
    if (main === 'airport') {
      for (const ki of ATTR_INDEX.airport) attr[zi * K + ki] += v;
      if (!z.jobs && p.reachable) {
        z.jobs = (p.scale.value / 1e6) * 300; // staff when the map has no buildings there (estimated)
        attr[zi * K + KIND.shift] += z.jobs * SHIFT_SHARE.airport!;
        attr[zi * K + KIND.work] += z.jobs * (1 - SHIFT_SHARE.airport!);
      }
    } else if (GATEWAY_SHARE[p.category]) {
      // people arriving here and going on into the city, and people heading here to travel on
      const tours = v * GATEWAY_SHARE[p.category]!;
      for (const [kind, share] of Object.entries(GATEWAY_MIX[gatewayKind(p)])) prod[zi * K + KIND[kind]] += tours * share!;
      attr[zi * K + KIND.work] += tours * 0.45;
      attr[zi * K + KIND.errand] += tours * 0.25;
      attr[zi * K + KIND.leisure] += tours * 0.2;
    } else {
      // a residential campus: students who live on it walk to class, so fewer come from elsewhere
      const students = main === 'university' ? v / 0.75 : 0;
      const live = students > 0 ? Math.min(1, (housed.get(zi) ?? 0) / students) : 0;
      for (const ki of ATTR_INDEX[main]) attr[zi * K + ki] += v * (1 - 0.6 * live);
      if (!z.jobs) {
        const staff = placeStaff(p);
        z.jobs = staff;
        const sh = SHIFT_SHARE[p.category] ?? 0;
        attr[zi * K + KIND.shift] += staff * sh;
        attr[zi * K + KIND.work] += staff * (1 - sh);
      }
    }
  }
  // sights, parks, beaches, venues and nightlife districts add visitors where they are
  for (const p of region.cityPlaces ?? []) {
    if (!p.reachable) continue;
    const [x, y] = toXY(p.lngLat[0], p.lngLat[1]);
    const k = cellOfXY(x, y);
    const z = k >= 0 ? actOf[k] : -1;
    if (z < 0) continue;
    const tiers = VISIT_BY_TIER[p.category];
    if (tiers) {
      const v = (tiers[p.scale.tier - 1] ?? 0) * (OUTDOOR_SEASON[p.category]?.[season] ?? 1);
      attr[z * K + KIND.visit] += v;
      attr[z * K + KIND.leisure] += v * 0.5;
    }
    if (p.category === 'nightlife') attr[z * K + KIND.night] += p.scale.value * 80;
  }
  // centres, car availability and parking
  for (let z = 0; z < Z; z++) {
    const zone = list[z];
    if (sw[z] > 0) {
      zone.x = sx[z] / sw[z];
      zone.y = sy[z] / sw[z];
      zone.lngLat = toLngLat(zone.x, zone.y);
    }
    if (zone.kind === 'square' || zone.kind === 'area') {
      const km2 = zone.kind === 'square' ? 0.36 : Math.max(0.3, areas.get(zone.area)?.landKm2 ?? areas.get(zone.area)?.areaKm2 ?? 3.4);
      const dens = zone.residents / km2, jobsDens = zone.jobs / km2;
      const distKm = Math.hypot(zone.x - cx0, zone.y - cy0) / 1000;
      zone.car = Math.max(0.15, Math.min(0.75, 0.45 + 0.025 * distKm - 6e-6 * dens));
      zone.parking = 1 + 7 * Math.min(1, jobsDens / 40000);
    }
  }
  // places take the car availability of the square they are in
  for (const [zi, p] of placeZone) {
    if (!p.reachable) continue;
    const [x, y] = toXY(p.lngLat[0], p.lngLat[1]);
    const k = cellOfXY(x, y);
    if (k >= 0 && homeOf[k] >= 0) list[zi].car = list[homeOf[k]].car;
  }
  const homeShare = new Float64Array(Z * K);
  for (let i = 0; i < Z * K; i++) homeShare[i] = prod[i] > 0 ? homeProd[i] / prod[i] : 0;
  const profile = new Uint8Array(Z).fill(PROFILE.city);
  for (const [zi, p] of placeZone) profile[zi] = profileOf(p);
  return { key: zonesKey(inp), list, homeOf, actOf, homeW, actW, prod, homeShare, attr, profile };
}

/** Which gateway mix a station's arriving travellers follow. */
function gatewayKind(p: CityPlace): keyof typeof GATEWAY_MIX {
  switch (p.category) {
    case 'rail_station': return p.scale.tier <= 1 ? 'main' : 'regional';
    case 'ferry_pier': return 'ferry';
    case 'bus_station': return 'coach';
    default: return 'metro';
  }
}

/** The purpose a place zone mainly attracts. */
function mainAttraction(p: CityPlace): Attraction {
  switch (p.category) {
    case 'airport': return 'airport';
    case 'hospital': return 'health';
    case 'university': return 'university';
    case 'mall': case 'market': return 'shopping';
    case 'stadium': return 'leisure';
    default: return 'work'; // stations and piers: handled as gateways
  }
}

/** Visitors a day from a place's size (estimated), or daily users for stations and airports. */
export function placeVisitors(p: CityPlace): number {
  const s = p.scale;
  switch (p.category) {
    case 'airport': return s.value / 365 / 2; // departing travellers a day
    case 'hospital': return (s.unit === 'beds' ? s.value : s.value / 100) * 4;
    case 'university': {
      // Wikidata counts a whole university; a campus is sized from its floor area instead
      const students = s.unit === 'students' && !(s.measured && p.floorM2 > 0) ? s.value : p.floorM2 > 0 ? p.floorM2 / 12 : s.value;
      return students * 0.75;
    }
    case 'mall': return s.value * 0.12;
    case 'market': return s.value * 0.2;
    case 'stadium': return s.value * 0.004; // ordinary days: tours and visitors (match days come with events)
    default: return s.unit === 'users_day' ? s.value : 0;
  }
}

/** Staff when the map has no buildings for the place (estimated). */
function placeStaff(p: CityPlace): number {
  const v = placeVisitors(p);
  switch (p.category) {
    case 'hospital': return v * 0.6;
    case 'university': return v * 0.15;
    case 'mall': case 'market': return v * 0.04;
    case 'stadium': return v * 0.3;
    default: return 0;
  }
}

/** For tests: the activity budget of one cell (6.4: places claim, POIs change the mix). */
export const _cellAttraction = cellAttraction;
