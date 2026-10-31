// Builds RegionData from raw z14 vector tiles (OpenMapTiles schema).
// Pure function: used by the region web worker and by Node tests.

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { classifyRings, clipLine, clipRing, latToMercY, lngToMercX, mercXToLng, mercYToLat, tileUnitMeters, hash01 } from '../../geo/tiles.ts';
import { zoneId } from './zoneTiles.ts';
import { buildGraph, projector, RoadClass, EDGE_BRIDGE, EDGE_ONEWAY, EDGE_TUNNEL, distanceM, type LngLat, type Segment, buildIndex, nearestNode, STOP_CLASSES, nodeHasClass } from './graph.ts';
import type { DemandGrid, OsmStop, Place, Poi, PoiKind, RegionData, RegionSpec, StreetName, Zone } from './region.ts';
import { buildTransit } from './transitBuilder.ts';
import { buildPlaces, PLACE_AEROWAY, PLACE_LANDCOVER, PLACE_LANDUSE, PLACE_POI, ringArea, type RawAerodrome, type RawLine, type RawPoi, type RawPoly } from './placeBuilder.ts';
import { hashString } from '../hash.ts';

const Z = 14;

export interface TileInput {
  x: number;
  y: number;
  data: ArrayBuffer | Uint8Array | null;
}

export type Progress = (stage: string, done: number, total: number) => void;

const ROAD_CLASS: Record<string, number> = {
  motorway: RoadClass.motorway, trunk: RoadClass.trunk, primary: RoadClass.primary, secondary: RoadClass.secondary,
  tertiary: RoadClass.tertiary, minor: RoadClass.minor, service: RoadClass.service, busway: RoadClass.busway, bus_guideway: RoadClass.busway,
};

type Pt = { x: number; y: number };

interface PoiRule { kind: PoiKind; edu?: number; shop?: number; leis?: number; other?: number; jobs?: number; notable?: boolean }

function classifyPoi(cls: string, sub: string): PoiRule | null {
  switch (cls) {
    case 'school':
      return sub === 'kindergarten' ? { kind: 'school', edu: 50, jobs: 12 } : { kind: 'school', edu: 350, jobs: 45, notable: true };
    case 'college':
      return { kind: 'university', edu: 2400, jobs: 320, leis: 40, notable: true };
    case 'hospital':
      return sub === 'hospital' ? { kind: 'hospital', other: 900, jobs: 650, notable: true } : { kind: 'clinic', other: 90, jobs: 20 };
    case 'dentist': case 'doctors':
      return { kind: 'clinic', other: 40, jobs: 8 };
    case 'pharmacy':
      return { kind: 'shopping', shop: 10, other: 10, jobs: 4 };
    case 'shop': case 'clothing_store': case 'bakery': case 'butcher': case 'alcohol_shop': case 'florist': case 'jewelry': case 'shoes': case 'mobile_phone': case 'furniture': case 'hardware': case 'books': case 'gift': case 'music':
      if (sub === 'mall' || sub === 'department_store') return { kind: 'mall', shop: sub === 'mall' ? 700 : 300, jobs: 220, notable: true };
      return { kind: 'shopping', shop: 18, jobs: 4 };
    case 'grocery':
      if (sub === 'marketplace') return { kind: 'market', shop: 250, jobs: 60, notable: true };
      if (sub === 'department_store') return { kind: 'mall', shop: 300, jobs: 150, notable: true };
      if (sub === 'supermarket') return { kind: 'shopping', shop: 70, jobs: 18 };
      return { kind: 'shopping', shop: 28, jobs: 5 };
    case 'restaurant': case 'cafe': case 'fast_food': case 'bar': case 'beer': case 'ice_cream':
      return { kind: 'food', leis: 10, jobs: 6 };
    case 'museum': case 'art_gallery': case 'theatre': case 'cinema': case 'castle': case 'monument':
      return { kind: 'culture', leis: sub === 'artwork' ? 4 : 120, jobs: 15, notable: sub !== 'artwork' };
    case 'attraction':
      return { kind: 'culture', leis: sub === 'viewpoint' ? 15 : 90, jobs: 6, notable: sub !== 'viewpoint' };
    case 'stadium':
      return { kind: 'leisure', leis: 600, jobs: 40, notable: true };
    case 'sports_centre': case 'swimming_pool': case 'zoo': case 'theme_park': case 'water_park':
      return { kind: 'leisure', leis: 80, jobs: 15, notable: cls !== 'swimming_pool' };
    case 'park': case 'garden':
      return { kind: 'park', leis: 35, notable: true };
    case 'railway':
      if (sub === 'station' || sub === 'halt') return { kind: 'station', other: 1400, jobs: 60, notable: true };
      if (sub === 'tram_stop') return { kind: 'station', other: 120 };
      return null;
    case 'entrance':
      return sub === 'subway_entrance' ? { kind: 'station', other: 220 } : null;
    case 'bus':
      return sub === 'bus_station' ? { kind: 'station', other: 500, jobs: 20, notable: true } : null;
    case 'ferry_terminal':
      return { kind: 'ferry', other: 700, jobs: 20, notable: true };
    case 'office':
      if (sub === 'government') return { kind: 'civic', other: 60, jobs: 60 };
      if (sub === 'university' || sub === 'educational_institution') return { kind: 'university', edu: 220, jobs: 60 };
      return { kind: 'office', jobs: 25 };
    case 'town_hall': case 'police': case 'post': case 'fire_station': case 'library': case 'courthouse':
      return { kind: 'civic', other: cls === 'town_hall' ? 120 : 30, jobs: 25, notable: cls === 'town_hall' };
    case 'lodging':
      return { kind: 'hotel', leis: 25, jobs: 15 };
    case 'place_of_worship':
      return { kind: 'worship', leis: 12, other: 6, jobs: 2 };
    case 'bank':
      return { kind: 'office', shop: 8, jobs: 10 };
    default:
      return null;
  }
}

const LANDUSE_PRIORITY: Record<string, number> = {
  residential: 1, industrial: 2, commercial: 3, retail: 3, school: 4, university: 4, college: 4, kindergarten: 4, hospital: 4, railway: 2,
};

/** Residential share of floor area by cell land use, and m² per job for the remainder. */
function landMix(cls: number): { res: number; m2PerJob: number } {
  switch (cls) {
    case 2: return { res: 0.06, m2PerJob: 70 }; // industrial / railway
    case 3: return { res: 0.3, m2PerJob: 32 }; // commercial / retail
    case 4: return { res: 0.12, m2PerJob: 45 }; // institutions
    default: return { res: 0.78, m2PerJob: 35 }; // residential or unknown
  }
}

const M2_PER_RESIDENT = 52;

function inferFloors(area: number, h: number): number {
  if (area < 22) return 1 + Math.floor(h * 2);
  if (area < 70) return 2 + Math.floor(h * 3);
  if (area < 380) return 3 + Math.floor(h * 4);
  if (area < 1400) return 3 + Math.floor(h * 3);
  return 2 + Math.floor(h * 3);
}

function pointInPoly(x: number, y: number, ring: number[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function buildRegion(spec: RegionSpec, tiles: TileInput[], progress?: Progress): RegionData {
  const P = projector(spec.centre);
  const segs: Segment[] = [];
  const pois: Poi[] = [];
  const rawPoi: { rule: PoiRule; x: number; y: number }[] = [];
  const rawStops: { name: string; at: LngLat }[] = [];
  const places: Place[] = [];
  const streets: StreetName[] = [];
  const buildings: { x: number; y: number; fa: number }[] = [];
  const landuse: { cls: number; ring: number[]; holes: number[][]; x0: number; y0: number; x1: number; y1: number }[] = [];
  let nBuildings = 0, withHeight = 0, missingTiles = 0;
  const seenPoi = new Set<string>();
  const seenPlace = new Set<string>();
  // inputs for the Place Registry (placeBuilder.ts)
  const regPois: RawPoi[] = [];
  const regPolys = new Map<string, RawPoly>();
  const regLines: RawLine[] = [];
  const aerodromes: RawAerodrome[] = [];
  const seenAero = new Set<number>();
  /** the tile feature id (OSM-derived, stable for the same map data), or a hash when missing */
  const fid = (f: { id?: number }, salt: string) => (typeof f.id === 'number' && f.id > 0 ? f.id : hashString(salt));
  const addPoly = (layer: RawPoly['layer'], cls: string, id: number, ring: number[]) => {
    const key = `${layer}:${id}`;
    const area = ringArea(ring);
    let p = regPolys.get(key);
    if (!p) regPolys.set(key, (p = { id, layer, cls, rings: [], area: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
    p.rings.push(ring);
    p.area += area;
    for (let k = 0; k < ring.length; k += 2) {
      p.x0 = Math.min(p.x0, ring[k]);
      p.x1 = Math.max(p.x1, ring[k]);
      p.y0 = Math.min(p.y0, ring[k + 1]);
      p.y1 = Math.max(p.y1, ring[k + 1]);
    }
  };
  /** outer rings of a polygon feature in local metres, clipped to the tile */
  const outerRings = (f: { loadGeometry(): Pt[][] }, extent: number, ll: (p: Pt) => LngLat) =>
    classifyRings(f.loadGeometry()).map((poly) => {
      const out: number[] = [];
      for (const q of clipRing(poly[0], 0, extent)) {
        const [lng, lat] = ll(q);
        out.push(...P.toXY(lng, lat));
      }
      return out;
    }).filter((r) => r.length >= 6);

  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  tiles.forEach((t, ti) => {
    progress?.('Reading map data', ti, tiles.length);
    w = Math.min(w, mercXToLng(t.x / 2 ** Z));
    e = Math.max(e, mercXToLng((t.x + 1) / 2 ** Z));
    n = Math.max(n, mercYToLat(t.y / 2 ** Z));
    s = Math.min(s, mercYToLat((t.y + 1) / 2 ** Z));
    if (!t.data) {
      missingTiles++;
      return;
    }
    const vt = new VectorTile(new PbfReader(t.data instanceof Uint8Array ? t.data : new Uint8Array(t.data)));
    const toLL = (extent: number) => (p: Pt): LngLat => [mercXToLng((t.x + p.x / extent) / 2 ** Z), mercYToLat((t.y + p.y / extent) / 2 ** Z)];

    // ---------------- roads
    const T = vt.layers.transportation;
    if (T) {
      const ll = toLL(T.extent);
      for (let i = 0; i < T.length; i++) {
        const f = T.feature(i);
        if (f.type !== 2) continue;
        const p = f.properties as Record<string, string | number | boolean>;
        if (p.class === 'rail' || p.class === 'transit' || p.class === 'ferry') {
          const id = fid(f, `line|${t.x}|${t.y}|${i}`);
          for (const line of f.loadGeometry())
            for (const piece of clipLine(line, 0, T.extent)) {
              const pts: number[] = [];
              for (const q of piece) {
                const [lng, lat] = ll(q);
                pts.push(...P.toXY(lng, lat));
              }
              regLines.push({ id, cls: String(p.class), sub: String(p.subclass ?? ''), service: p.service ? String(p.service) : '', pts });
            }
          continue;
        }
        const cls = ROAD_CLASS[String(p.class)];
        if (cls === undefined) continue;
        if (p.service === 'parking_aisle' || p.service === 'driveway') continue;
        if (p.access === 'no' || p.access === 'private') continue;
        const bridge = p.brunnel === 'bridge';
        const tunnel = p.brunnel === 'tunnel';
        const layer = Number(p.layer ?? 0) || 0;
        const level = bridge ? Math.max(1, layer) : tunnel ? Math.min(-1, layer) : 0;
        for (const line of f.loadGeometry())
          for (const piece of clipLine(line, 0, T.extent)) segs.push({ coords: piece.map(ll), cls, oneway: Number(p.oneway ?? 0), level, bridge, tunnel });
      }
    }

    // ---------------- street names (for naming stops)
    const TN = vt.layers.transportation_name;
    if (TN) {
      const ll = toLL(TN.extent);
      for (let i = 0; i < TN.length; i++) {
        const f = TN.feature(i);
        if (f.type !== 2) continue;
        const p = f.properties as Record<string, string>;
        const name = p['name:latin'] ?? p.name;
        if (name && p.class === 'ferry') {
          // named ferry routes: how many call at a pier (Place Registry)
          for (const line of f.loadGeometry())
            for (const piece of clipLine(line, 0, TN.extent)) {
              const pts: number[] = [];
              for (const q of piece) {
                const [lng, lat] = ll(q);
                pts.push(...P.toXY(lng, lat));
              }
              regLines.push({ id: hashString(`ferry|${name}`), cls: 'ferry_route', sub: '', service: '', pts });
            }
          continue;
        }
        if (!name || !(String(p.class) in ROAD_CLASS)) continue;
        for (const line of f.loadGeometry())
          for (const piece of clipLine(line, 0, TN.extent)) {
            const pts: number[] = [];
            for (const q of piece) {
              const [lng, lat] = ll(q);
              pts.push(...P.toXY(lng, lat));
            }
            streets.push({ name, pts });
          }
      }
    }

    // ---------------- points of interest
    const PO = vt.layers.poi;
    if (PO) {
      const ll = toLL(PO.extent);
      for (let i = 0; i < PO.length; i++) {
        const f = PO.feature(i);
        const p = f.properties as Record<string, string | number>;
        const g = f.loadGeometry()[0]?.[0];
        if (!g || g.x < 0 || g.y < 0 || g.x > PO.extent || g.y > PO.extent) continue;
        const at = ll(g);
        const name = (p['name:latin'] ?? p.name) as string | undefined;
        if (PLACE_POI.has(String(p.class))) {
          const [x, y] = P.toXY(at[0], at[1]);
          regPois.push({ id: fid(f, `poi|${p.class}|${name ?? ''}|${at[0].toFixed(5)},${at[1].toFixed(5)}`), cls: String(p.class), sub: String(p.subclass ?? ''), name: name ? String(name) : '', x, y, rank: Number(p.rank ?? 99) });
        }
        if (p.subclass === 'bus_stop') {
          if (name) rawStops.push({ name: String(name), at });
          continue;
        }
        const rule = classifyPoi(String(p.class), String(p.subclass));
        if (!rule) continue;
        const key = `${p.class}|${name ?? ''}|${at[0].toFixed(5)},${at[1].toFixed(5)}`;
        if (seenPoi.has(key)) continue;
        seenPoi.add(key);
        const [x, y] = P.toXY(at[0], at[1]);
        rawPoi.push({ rule, x, y });
        if (rule.notable && name) {
          const weight = (rule.edu ?? 0) + (rule.shop ?? 0) + (rule.leis ?? 0) + (rule.other ?? 0);
          pois.push({ id: pois.length, name: String(name), kind: rule.kind, lngLat: [+at[0].toFixed(6), +at[1].toFixed(6)], weight });
        }
      }
    }

    // ---------------- places (neighbourhood names)
    const PL = vt.layers.place;
    if (PL) {
      const ll = toLL(PL.extent);
      for (let i = 0; i < PL.length; i++) {
        const f = PL.feature(i);
        const p = f.properties as Record<string, string>;
        const name = p['name:latin'] ?? p.name;
        const g = f.loadGeometry()[0]?.[0];
        if (!name || !g || g.x < 0 || g.y < 0 || g.x > PL.extent || g.y > PL.extent) continue;
        const key = `${p.class}|${name}`;
        if (seenPlace.has(key)) continue;
        seenPlace.add(key);
        places.push({ name, kind: String(p.class), lngLat: ll(g) });
      }
    }

    // ---------------- land use (for residential / commercial mix)
    const LU = vt.layers.landuse;
    if (LU) {
      const ll = toLL(LU.extent);
      for (let i = 0; i < LU.length; i++) {
        const f = LU.feature(i);
        if (f.type !== 3) continue;
        const luName = String((f.properties as Record<string, string>).class);
        if (PLACE_LANDUSE.has(luName)) {
          const id = fid(f, `landuse|${luName}|${t.x}|${t.y}|${i}`);
          for (const r of outerRings(f as unknown as { loadGeometry(): Pt[][] }, LU.extent, ll)) addPoly('landuse', luName, id, r);
        }
        const cls = LANDUSE_PRIORITY[luName];
        if (!cls) continue;
        for (const poly of classifyRings(f.loadGeometry() as Pt[][])) {
          const toXY = (r: Pt[]) => {
            const out: number[] = [];
            for (const q of clipRing(r, 0, LU.extent)) {
              const [lng, lat] = ll(q);
              out.push(...P.toXY(lng, lat));
            }
            return out;
          };
          const ring = toXY(poly[0]);
          if (ring.length < 6) continue;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (let k = 0; k < ring.length; k += 2) {
            x0 = Math.min(x0, ring[k]);
            x1 = Math.max(x1, ring[k]);
            y0 = Math.min(y0, ring[k + 1]);
            y1 = Math.max(y1, ring[k + 1]);
          }
          landuse.push({ cls, ring, holes: poly.slice(1).map(toXY).filter((h) => h.length >= 6), x0, y0, x1, y1 });
        }
      }
    }

    // ---------------- parks, gardens and beaches; airport aprons; airport labels (registry only)
    for (const [layerName, keep, key] of [['landcover', PLACE_LANDCOVER, 'subclass'], ['aeroway', PLACE_AEROWAY, 'class']] as const) {
      const L = vt.layers[layerName];
      if (!L) continue;
      const ll = toLL(L.extent);
      for (let i = 0; i < L.length; i++) {
        const f = L.feature(i);
        const c = String((f.properties as Record<string, string>)[key] ?? '');
        if (f.type !== 3 || !keep.has(c)) continue;
        const id = fid(f, `${layerName}|${c}|${t.x}|${t.y}|${i}`);
        for (const r of outerRings(f as unknown as { loadGeometry(): Pt[][] }, L.extent, ll)) addPoly(layerName, c, id, r);
      }
    }
    const AL = vt.layers.aerodrome_label;
    if (AL) {
      const ll = toLL(AL.extent);
      for (let i = 0; i < AL.length; i++) {
        const f = AL.feature(i);
        const p = f.properties as Record<string, string>;
        const g = f.loadGeometry()[0]?.[0];
        const id = fid(f, `aero|${p.iata ?? ''}|${p.icao ?? ''}|${p.name ?? ''}`);
        if (!g || seenAero.has(id)) continue;
        seenAero.add(id);
        aerodromes.push({ id, name: String(p['name:latin'] ?? p.name ?? ''), iata: p.iata || undefined, icao: p.icao || undefined, cls: String(p.class ?? ''), lngLat: ll(g) });
      }
    }

    // ---------------- buildings → floor area
    const B = vt.layers.building;
    if (B) {
      const unit = tileUnitMeters(Z, t.y, B.extent);
      const ll = toLL(B.extent);
      for (let i = 0; i < B.length; i++) {
        const f = B.feature(i);
        const p = f.properties as Record<string, unknown>;
        const rh = Number(p.render_height ?? 5);
        const rmin = Number(p.render_min_height ?? 0);
        const known = rh !== 5 && rh > 0;
        for (const poly of classifyRings(f.loadGeometry() as Pt[][])) {
          const ring = clipRing(poly[0], 0, B.extent);
          if (ring.length < 3) continue;
          let a = 0, cx = 0, cy = 0;
          for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
            a += ring[j].x * ring[k].y - ring[k].x * ring[j].y;
            cx += ring[k].x;
            cy += ring[k].y;
          }
          const area = (Math.abs(a) / 2) * unit * unit;
          if (area < 12) continue;
          nBuildings++;
          if (known) withHeight++;
          const centre = ll({ x: cx / ring.length, y: cy / ring.length });
          const floors = known ? Math.max(1, Math.round((rh - rmin) / 3.1)) : inferFloors(area, hash01(Math.round(cx), Math.round(cy), t.x + t.y));
          if (rmin > 6 && rh - rmin < 8) continue; // bridges, canopies: no floor space
          const [x, y] = P.toXY(centre[0], centre[1]);
          buildings.push({ x, y, fa: area * Math.min(floors, 40) });
        }
      }
    }
  });

  // ---------------- road graph
  progress?.('Building road network', 0, 1);
  const origin = spec.centre;
  const graph = buildGraph(segs, origin);
  const index = buildIndex(graph);

  // ---------------- demand grid
  progress?.('Estimating travel demand', 0, 1);
  const [gx0, gy0] = P.toXY(w, s);
  const [gx1, gy1] = P.toXY(e, n);
  const cell = 150;
  const gw = Math.ceil((gx1 - gx0) / cell), gh = Math.ceil((gy1 - gy0) / cell);
  const N = gw * gh;
  const grid: DemandGrid = {
    x0: gx0, y0: gy0, cell, w: gw, h: gh,
    residents: new Float32Array(N), jobs: new Float32Array(N), education: new Float32Array(N), shopping: new Float32Array(N),
    leisure: new Float32Array(N), other: new Float32Array(N), roads: new Float32Array(N),
    work: new Float32Array(N), floor: new Float32Array(N), health: new Float32Array(N), services: new Float32Array(N), lodging: new Float32Array(N),
  };
  const cellOf = (x: number, y: number) => {
    const cx = Math.floor((x - gx0) / cell), cy = Math.floor((y - gy0) / cell);
    return cx < 0 || cy < 0 || cx >= gw || cy >= gh ? -1 : cy * gw + cx;
  };
  // land use raster (highest priority class wins)
  const luClass = new Uint8Array(N);
  for (const lu of landuse) {
    for (let cy = Math.max(0, Math.floor((lu.y0 - gy0) / cell)); cy <= Math.min(gh - 1, Math.floor((lu.y1 - gy0) / cell)); cy++)
      for (let cx = Math.max(0, Math.floor((lu.x0 - gx0) / cell)); cx <= Math.min(gw - 1, Math.floor((lu.x1 - gx0) / cell)); cx++) {
        const k = cy * gw + cx;
        if (luClass[k] >= lu.cls) continue;
        const px = gx0 + (cx + 0.5) * cell, py = gy0 + (cy + 0.5) * cell;
        if (pointInPoly(px, py, lu.ring) && !lu.holes.some((h) => pointInPoly(px, py, h))) luClass[k] = lu.cls;
      }
  }
  for (const b of buildings) {
    const k = cellOf(b.x, b.y);
    if (k < 0) continue;
    const mix = landMix(luClass[k]);
    grid.residents[k] += (b.fa * mix.res) / M2_PER_RESIDENT;
    grid.jobs[k] += (b.fa * (1 - mix.res)) / mix.m2PerJob;
    grid.work![k] += (b.fa * (1 - mix.res)) / mix.m2PerJob;
    grid.floor![k] += b.fa * (1 - mix.res);
  }
  for (const r of rawPoi) {
    const k = cellOf(r.x, r.y);
    if (k < 0) continue;
    grid.education[k] += r.rule.edu ?? 0;
    grid.shopping[k] += r.rule.shop ?? 0;
    grid.leisure[k] += r.rule.leis ?? 0;
    grid.other[k] += r.rule.other ?? 0;
    grid.jobs[k] += r.rule.jobs ?? 0;
    // The activity engine's budget (plan section 6.4): the buildings hold the jobs, and a POI
    // adds its own jobs only where no building was mapped. `other` is split by kind; transport
    // hubs are left out because the Place Registry's stations stand in for them.
    if (!grid.floor![k]) grid.work![k] += r.rule.jobs ?? 0;
    const kind = r.rule.kind;
    if (kind === 'hospital' || kind === 'clinic') grid.health![k] += r.rule.other ?? 0;
    else if (kind === 'civic' || kind === 'worship') grid.services![k] += r.rule.other ?? 0;
    else if (kind === 'shopping' && r.rule.other) grid.health![k] += r.rule.other; // pharmacies
    if (kind === 'hotel') grid.lodging![k] += 1;
  }
  for (let ed = 0; ed < graph.m; ed++) {
    const a = graph.ea[ed], b = graph.eb[ed];
    const k = cellOf((graph.x[a] + graph.x[b]) / 2, (graph.y[a] + graph.y[b]) / 2);
    if (k >= 0) grid.roads[k] += graph.len[ed];
  }

  // ---------------- real bus stops: merge the pair either side of a street and numbered platforms
  const baseName = (nm: string) => nm.replace(/\s+\d+$/, '').trim();
  const norm = (nm: string) => baseName(nm).toLocaleLowerCase('tr').replace(/ı/g, 'i');
  const clusters: { key: string; name: string; sum: [number, number]; n: number; at: LngLat }[] = [];
  for (const r of rawStops) {
    const key = norm(r.name);
    const c = clusters.find((c) => (c.key === key && distanceM(c.at, r.at) < 130) || distanceM(c.at, r.at) < 12);
    if (c) {
      c.sum[0] += r.at[0];
      c.sum[1] += r.at[1];
      c.n++;
      c.at = [c.sum[0] / c.n, c.sum[1] / c.n];
    } else clusters.push({ key, name: baseName(r.name), sum: [r.at[0], r.at[1]], n: 1, at: r.at });
  }
  const osmStops: OsmStop[] = [];
  for (const c of clusters) {
    const [x, y] = P.toXY(c.at[0], c.at[1]);
    const v = nearestNode(graph, index, x, y, 45, (v) => nodeHasClass(graph, v, STOP_CLASSES));
    if (v >= 0) osmStops.push({ name: c.name, lngLat: [+c.at[0].toFixed(6), +c.at[1].toFixed(6)] });
  }

  // ---------------- zones
  progress?.('Mapping operating areas', 0, 1);
  const zones = buildZones(places, grid, pois, spec, P);

  // ---------------- the Place Registry
  progress?.('Finding airports, stations and destinations', 0, 1);
  const tileSet = new Set(spec.tiles.map(([x, y]) => `${x},${y}`));
  const cityPlaces = buildPlaces({
    centre: spec.centre,
    toXY: P.toXY,
    toLngLat: P.toLngLat,
    inRegion: (lng, lat) => tileSet.has(`${Math.floor(lngToMercX(lng) * 2 ** Z)},${Math.floor(latToMercY(lat) * 2 ** Z)}`),
    pois: regPois,
    polys: [...regPolys.values()],
    lines: regLines,
    aerodromes,
    buildings,
    labels: places,
  });
  const transit = buildTransit({ lines: regLines, places: cityPlaces, toXY: P.toXY });

  // ---------------- coverage
  let roadM = 0, oneway = 0, bridges = 0, tunnels = 0;
  for (let ed = 0; ed < graph.m; ed++) {
    roadM += graph.len[ed];
    if (graph.flags[ed] & EDGE_ONEWAY) oneway += graph.len[ed];
    if (graph.flags[ed] & EDGE_BRIDGE) bridges++;
    if (graph.flags[ed] & EDGE_TUNNEL) tunnels++;
  }
  let fp = 5381;
  const mix = (v: number) => (fp = (Math.imul(fp, 33) ^ v) >>> 0);
  mix(graph.n);
  mix(graph.m);
  for (let v = 0; v < graph.n; v += 37) {
    mix(Math.round(graph.lng[v] * 1e5));
    mix(Math.round(graph.lat[v] * 1e5));
  }

  return {
    spec,
    graph,
    bounds: { w, s, e, n },
    pois: pois.sort((a, b) => b.weight - a.weight),
    places,
    cityPlaces,
    transit,
    demand: grid,
    zones,
    osmStops,
    streets,
    coverage: {
      roadKm: Math.round(roadM / 100) / 10,
      oneWayShare: roadM ? oneway / roadM : 0,
      bridges,
      tunnels,
      buildings: nBuildings,
      buildingsWithHeight: withHeight,
      pois: rawPoi.length,
      osmStops: osmStops.length,
      places: places.length,
      cityPlaces: cityPlaces.length,
      traffic: 'simulated',
      missingTiles,
    },
    fingerprint: fp.toString(36),
  };
}

// ─────────────────────────────────────────────────────────────── zones

const PLACE_RANK: Record<string, number> = { quarter: 0, suburb: 1, neighbourhood: 2, village: 1, town: 3, hamlet: 3, isolated_dwelling: 5, city: 6 };

/** an area with less land than this is open water: never licensed, shown beside your areas */
export const WATER_KM2 = 0.12;

const COMPASS8 = ['East', 'North-East', 'North', 'North-West', 'West', 'South-West', 'South', 'South-East'];
function compass8(dx: number, dy: number): string {
  const a = Math.atan2(dy, dx);
  return COMPASS8[(Math.round(a / (Math.PI / 4)) + 8) % 8];
}

/**
 * Operating areas: one per z14 map tile (about 2 km across). Tiles are fixed worldwide, so an
 * area keeps its id and outline when the map grows. Each is named after the main OSM place
 * (quarter, suburb, village) inside it, or after the nearest one with a compass direction.
 * These are game areas, not official administrative boundaries.
 */
function buildZones(places: Place[], grid: DemandGrid, pois: Poi[], spec: RegionSpec, P: ReturnType<typeof projector>): Zone[] {
  const N = 2 ** Z;
  const tiles = spec.tiles;
  const index = new Map<string, number>();
  tiles.forEach(([x, y], i) => index.set(`${x},${y}`, i));
  const tileOfLL = (lng: number, lat: number) => index.get(`${Math.floor(lngToMercX(lng) * N)},${Math.floor(latToMercY(lat) * N)}`) ?? -1;
  const T = tiles.length;
  const res = new Float64Array(T), jobs = new Float64Array(T), land = new Float64Array(T);
  const wsum = new Float64Array(T), wx = new Float64Array(T), wy = new Float64Array(T);
  const cellKm2 = (grid.cell * grid.cell) / 1e6;
  for (let cy = 0; cy < grid.h; cy++)
    for (let cx = 0; cx < grid.w; cx++) {
      const k = cy * grid.w + cx;
      const w = grid.residents[k] + grid.jobs[k] + grid.roads[k] * 0.2;
      if (!w) continue;
      const x = grid.x0 + (cx + 0.5) * grid.cell, y = grid.y0 + (cy + 0.5) * grid.cell;
      const [lng, lat] = P.toLngLat(x, y);
      const t = tileOfLL(lng, lat);
      if (t < 0) continue;
      res[t] += grid.residents[k];
      jobs[t] += grid.jobs[k];
      land[t] += cellKm2;
      wsum[t] += w;
      wx[t] += w * x;
      wy[t] += w * y;
    }
  /** activity (people, jobs, streets) within ±3 cells of a point */
  const density = (x: number, y: number) => {
    let sum = 0;
    const cx = Math.floor((x - grid.x0) / grid.cell), cy = Math.floor((y - grid.y0) / grid.cell);
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const X = cx + dx, Y = cy + dy;
        if (X < 0 || Y < 0 || X >= grid.w || Y >= grid.h) continue;
        const k = Y * grid.w + X;
        sum += grid.residents[k] + grid.jobs[k] + grid.roads[k] * 0.2;
      }
    return sum;
  };
  const cands = places
    .filter((p) => p.kind in PLACE_RANK)
    .map((p) => {
      const [x, y] = P.toXY(p.lngLat[0], p.lngLat[1]);
      return { p, x, y, rank: PLACE_RANK[p.kind], d: density(x, y), tile: tileOfLL(p.lngLat[0], p.lngLat[1]) };
    })
    .filter((c) => c.d > 50)
    .sort((a, b) => a.rank - b.rank || b.d - a.d || a.p.name.localeCompare(b.p.name));
  const best = new Map<number, (typeof cands)[number]>();
  for (const c of cands) if (c.tile >= 0 && !best.has(c.tile)) best.set(c.tile, c);

  const used = new Set<string>();
  const unique = (name: string) => {
    let out = name;
    for (let i = 2; used.has(out); i++) out = `${name} ${i}`;
    used.add(out);
    return out;
  };
  const geo = tiles.map(([x, y]) => {
    const w = mercXToLng(x / N), e = mercXToLng((x + 1) / N), n = mercYToLat(y / N), s = mercYToLat((y + 1) / N);
    const centre: LngLat = [(w + e) / 2, (n + s) / 2];
    return { w, e, n, s, centre, xy: P.toXY(centre[0], centre[1]) };
  });
  // named tiles first, so a place's own tile keeps the plain name
  const order = tiles.map((_, i) => i).sort((a, b) => Number(best.has(b)) - Number(best.has(a)) || wsum[b] - wsum[a]);
  const names = new Array<string>(T);
  const named = new Array<boolean>(T).fill(false);
  for (const i of order) {
    const c = best.get(i);
    if (c) {
      names[i] = unique(c.p.name);
      named[i] = true;
      continue;
    }
    if (land[i] < WATER_KM2) {
      names[i] = 'Open water';
      continue;
    }
    const [x, y] = wsum[i] ? [wx[i] / wsum[i], wy[i] / wsum[i]] : geo[i].xy;
    let near: (typeof cands)[number] | null = null, nd = Infinity;
    for (const q of cands) {
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < nd) {
        nd = d;
        near = q;
      }
    }
    names[i] = unique(near ? `${near.p.name} ${compass8(x - near.x, y - near.y)}` : `Area ${tiles[i][0] % 1000}-${tiles[i][1] % 1000}`);
  }

  const zones: Zone[] = tiles.map(([x, y], i) => {
    const g = geo[i];
    const r6 = (v: number) => +v.toFixed(6);
    const areaKm2 = (distanceM([g.w, g.centre[1]], [g.e, g.centre[1]]) * distanceM([g.centre[0], g.s], [g.centre[0], g.n])) / 1e6;
    const water = land[i] < WATER_KM2;
    return {
      id: zoneId(x, y),
      name: names[i],
      ring: [[r6(g.w), r6(g.n)], [r6(g.e), r6(g.n)], [r6(g.e), r6(g.s)], [r6(g.w), r6(g.s)]],
      centroid: wsum[i] > 0 ? P.toLngLat(wx[i] / wsum[i], wy[i] / wsum[i]) : g.centre,
      seed: g.centre,
      neighbours: [],
      areaKm2,
      landKm2: Math.min(areaKm2, land[i]),
      ...(water ? { water: true } : {}),
      residents: Math.round(res[i]),
      jobs: Math.round(jobs[i]),
      named: named[i],
      highlights: [],
    };
  });
  // neighbours: the 8 tiles around; across a tile of open water, the land beyond counts too
  const around = (i: number) => {
    const [x, y] = tiles[i];
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const j = index.get(`${x + dx},${y + dy}`);
        if (j !== undefined) out.push(j);
      }
    return out;
  };
  zones.forEach((z, i) => {
    const set = new Set<number>();
    for (const j of around(i)) {
      if (z.water || !zones[j].water) set.add(j);
      else for (const k of around(j)) if (k !== i && !zones[k].water) set.add(k);
    }
    z.neighbours = [...set].map((j) => zones[j].id);
  });
  for (const p of pois) {
    const t = tileOfLL(p.lngLat[0], p.lngLat[1]);
    const z = t >= 0 ? zones[t] : null;
    if (z && z.highlights.length < 4 && !z.highlights.includes(p.name)) z.highlights.push(p.name);
  }
  return zones;
}
