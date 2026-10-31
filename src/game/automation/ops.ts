// Data for control-room automation: stops near a place, the road route between two places,
// how many residents and jobs a line's stops reach, where lines meet for a change, how full each
// coming departure is expected to be, who is about to miss a connection, and the gaps between
// buses on a line (bunching). Everything is read from the simulation; estimates say so.

import type { Game } from '../engine.ts';
import type { Pattern } from '../network.ts';
import type { Value } from './types.ts';
import type { Rec } from './live.ts';
import { DAY, HOUR, MODEL } from '../content.ts';
import { TripState, type Id, type Trip, type Vehicle } from '../types.ts';
import { hhmm } from '../time.ts';
import { startTime, tripSchedule, vehicleXY } from '../vehicles.ts';
import { arrivalsAt, vehicleStops } from '../eta.ts';
import { freeSpeed, nearestNode, route as routeLeg, type LngLat } from '../world/graph.ts';
import { demandForecast } from './city.ts';
import { upcomingTrips } from '../operations.ts';

const r1 = (x: number) => Math.round(x * 10) / 10;
const isRec = (v: Value | undefined): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/** Streets are not straight lines: a walk is about a quarter longer than the distance. */
export const WALK_FACTOR = 1.25;
/** Walking speed, metres a minute. */
export const WALK_M_PER_MIN = 80;

// ───────────────────────────────────────────── where things are

function busPoint(game: Game, v: Vehicle): LngLat | null {
  const xy = vehicleXY(game, v);
  if (xy) return game.geo.P.toLngLat(xy.x, xy.y);
  return game.state.depots[v.depot]?.lngLat ?? null;
}

/** Where a value is on the map: a stop, bus, depot, place or event (record or id), or anything with lng and lat. */
export function pointOf(game: Game, v: Value | undefined): LngLat | null {
  const s = game.state;
  if (typeof v === 'string') {
    if (s.stops[v]) return s.stops[v].lngLat;
    if (s.vehicles[v]) return busPoint(game, s.vehicles[v]);
    if (s.depots[v]) return s.depots[v].lngLat;
    return null;
  }
  if (!isRec(v)) return null;
  if (typeof v.lng === 'number' && typeof v.lat === 'number') return [v.lng, v.lat];
  const id = typeof v.id === 'string' ? v.id : null;
  if (id && v.kind === 'stop') return s.stops[id]?.lngLat ?? null;
  if (id && v.kind === 'vehicle' && s.vehicles[id]) return busPoint(game, s.vehicles[id]);
  if (id && v.kind === 'depot') return s.depots[id]?.lngLat ?? null;
  const place = v.kind === 'place' ? id : typeof v.place === 'string' ? v.place : null;
  if (place) {
    const p = (game.region.cityPlaces ?? []).find((x) => x.id === place);
    if (p) return p.lngLat;
  }
  if (typeof v.stop === 'string' && s.stops[v.stop]) return s.stops[v.stop].lngLat;
  if (typeof v.vehicle === 'string' && s.vehicles[v.vehicle]) return busPoint(game, s.vehicles[v.vehicle]);
  return null;
}

export const metresBetween = (game: Game, a: LngLat, b: LngLat) => {
  const [ax, ay] = game.geo.xy(a), [bx, by] = game.geo.xy(b);
  return Math.hypot(ax - bx, ay - by);
};

/** The lines calling at each stop (both directions). */
function linesByStop(game: Game): Map<Id, Id[]> {
  const out = new Map<Id, Id[]>();
  for (const r of Object.values(game.state.routes)) for (const s of new Set([...r.stops, ...(r.returnStops ?? [])])) out.set(s, [...(out.get(s) ?? []), r.id]);
  return out;
}

/** A line's nearest stop to a point, and how far it is. */
export function nearestStopOfLine(game: Game, route: Id, at: LngLat): { stop: Id; m: number } | null {
  const r = game.state.routes[route];
  if (!r) return null;
  let best: { stop: Id; m: number } | null = null;
  for (const id of new Set([...r.stops, ...(r.returnStops ?? [])])) {
    const st = game.state.stops[id];
    if (!st) continue;
    const m = metresBetween(game, at, st.lngLat);
    if (!best || m < best.m) best = { stop: id, m };
  }
  return best;
}

// ───────────────────────────────────────────── nearby stops

/** Your stops within a walk of a point, nearest first. */
export function nearbyStops(game: Game, at: LngLat, walkM: number, limit = 20): Rec[] {
  const s = game.state;
  const lines = linesByStop(game);
  const found: { id: Id; m: number }[] = [];
  for (const st of Object.values(s.stops)) {
    const m = metresBetween(game, at, st.lngLat);
    if (m * WALK_FACTOR <= walkM) found.push({ id: st.id, m });
  }
  found.sort((a, b) => a.m - b.m || a.id.localeCompare(b.id));
  return found.slice(0, limit).map(({ id, m }) => {
    const st = s.stops[id];
    const ls = lines.get(id) ?? [];
    return {
      kind: 'stop', id, name: st.name, label: st.name, distance: Math.round(m), walk: Math.round(m * WALK_FACTOR), walkMin: r1((m * WALK_FACTOR) / WALK_M_PER_MIN),
      lines: ls.map((r) => s.routes[r].number), lineIds: ls, served: ls.length > 0,
      waiting: (s.pax.waiting[id] ?? []).reduce((a, g) => a + g.n, 0), lng: st.lngLat[0], lat: st.lngLat[1],
    };
  });
}

// ───────────────────────────────────────────── road route between two places

/** The quickest legal road route between two points: distance, free-flow minutes and minutes in today's traffic and weather now. */
export function roadTrip(game: Game, a: LngLat, b: LngLat): Rec | null {
  const g = game.region.graph, idx = game.region.index;
  const [ax, ay] = game.geo.xy(a), [bx, by] = game.geo.xy(b);
  const na = nearestNode(g, idx, ax, ay, 400), nb = nearestNode(g, idx, bx, by, 400);
  if (na < 0 || nb < 0) return null;
  const leg = routeLeg(g, na, nb) ?? routeLeg(g, na, nb, { lenient: true });
  if (!leg) return null;
  const t = game.t;
  const road = game.weatherEffectAt(t).road;
  let now = 0;
  for (const de of leg.dedges) {
    const e = de >> 1;
    now += g.len[e] / Math.max(0.5, freeSpeed(g, e) * game.traffic.speedFactor(game.traffic.congestion(de, t)) * road);
  }
  return {
    kind: 'route', km: r1(leg.metres / 1000), minutes: r1(leg.seconds / 60), minutesNow: r1(now / 60),
    slowerBy: leg.seconds > 0 ? Math.round((now / leg.seconds - 1) * 100) : 0, straightKm: r1(Math.hypot(ax - bx, ay - by) / 1000),
    oneWayRules: leg.contraflow.length === 0, estimate: true,
  };
}

// ───────────────────────────────────────────── coverage

const masks = new WeakMap<Game, { key: string; mask: Uint8Array; zone: Int32Array; zones: string[] }>();

/** Grid cells with people or jobs, and the area of each (cached until the territory changes). */
function cellAreas(game: Game) {
  const d = game.region.demand;
  const key = `${game.state.territory.owned.join(',')}|${d.w}x${d.h}`;
  const hit = masks.get(game);
  if (hit && hit.key === key) return hit;
  const owned = new Set(game.state.territory.owned);
  const mask = new Uint8Array(d.w * d.h);
  const zone = new Int32Array(d.w * d.h).fill(-1);
  const zones: string[] = [];
  const zi = new Map<string, number>();
  for (let j = 0; j < d.h; j++) for (let i = 0; i < d.w; i++) {
    const c = j * d.w + i;
    if (d.residents[c] + d.jobs[c] <= 0) continue;
    const z = game.geo.zoneAt(game.geo.P.toLngLat(d.x0 + (i + 0.5) * d.cell, d.y0 + (j + 0.5) * d.cell));
    if (!zi.has(z.id)) {
      zi.set(z.id, zones.length);
      zones.push(z.id);
    }
    zone[c] = zi.get(z.id)!;
    if (owned.has(z.id)) mask[c] = 1;
  }
  const out = { key, mask, zone, zones };
  masks.set(game, out);
  return out;
}

/**
 * Share of the residents and jobs in your areas (or one area) within a walk of the given stops,
 * and the biggest places left out. From the map's land use: estimates, not a census.
 */
export function coverage(game: Game, stops: Id[], walkM: number, area?: string | null): Rec {
  const d = game.region.demand;
  const { mask, zone, zones } = cellAreas(game);
  const want = area ? zones.indexOf(area) : -1;
  const inScope = (c: number) => (area ? zone[c] === want : mask[c] === 1);
  const covered = new Uint8Array(d.w * d.h);
  const r = walkM / WALK_FACTOR;
  for (const id of stops) {
    const st = game.state.stops[id];
    if (!st) continue;
    const [x, y] = game.geo.xy(st.lngLat);
    const i0 = Math.max(0, Math.floor((x - r - d.x0) / d.cell)), i1 = Math.min(d.w - 1, Math.floor((x + r - d.x0) / d.cell));
    const j0 = Math.max(0, Math.floor((y - r - d.y0) / d.cell)), j1 = Math.min(d.h - 1, Math.floor((y + r - d.y0) / d.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (Math.hypot(d.x0 + (i + 0.5) * d.cell - x, d.y0 + (j + 0.5) * d.cell - y) <= r) covered[j * d.w + i] = 1;
    }
  }
  let res = 0, jobs = 0, resIn = 0, jobsIn = 0;
  const gaps: { c: number; n: number }[] = [];
  for (let c = 0; c < covered.length; c++) {
    if (!inScope(c)) continue;
    res += d.residents[c];
    jobs += d.jobs[c];
    if (covered[c]) {
      resIn += d.residents[c];
      jobsIn += d.jobs[c];
    } else gaps.push({ c, n: d.residents[c] + d.jobs[c] });
  }
  gaps.sort((a, b) => b.n - a.n || a.c - b.c);
  const pct = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : null);
  return {
    kind: 'coverage', stops: stops.length, walk: Math.round(walkM), area: area ? game.geo.zone(area)?.name ?? null : null,
    residents: pct(resIn, res), jobs: pct(jobsIn, jobs), residentsReached: Math.round(resIn), residentsTotal: Math.round(res), jobsReached: Math.round(jobsIn), jobsTotal: Math.round(jobs),
    gaps: gaps.slice(0, 8).map(({ c }) => {
      const i = c % d.w, j = Math.floor(c / d.w);
      const ll = game.geo.P.toLngLat(d.x0 + (i + 0.5) * d.cell, d.y0 + (j + 0.5) * d.cell);
      const z = zone[c] >= 0 ? game.geo.zone(zones[zone[c]]) : undefined;
      return { kind: 'place', id: `cell:${c}`, label: z?.name ?? 'Unnamed area', area: z?.name ?? null, areaId: z?.id ?? null, residents: Math.round(d.residents[c]), jobs: Math.round(d.jobs[c]), lng: Math.round(ll[0] * 1e6) / 1e6, lat: Math.round(ll[1] * 1e6) / 1e6 } as Rec;
    }),
    estimate: true,
  };
}

// ───────────────────────────────────────────── where lines meet

/** Journeys that changed from one line to another at a stop on recent days: `${from}>${to}@${stop}` → people a day. */
function recordedChanges(game: Game, days = 7): Map<string, number> {
  const a = game.state.analytics;
  const recs = [...a.days.slice(-days), a.today];
  const out = new Map<string, number>();
  for (const d of recs) for (const [key, v] of Object.entries(d.od)) {
    const parts = key.split('>')[2]?.split('.') ?? [];
    if (parts.length < 3) continue;
    let done = 0;
    for (let k = 0; k + 1 < v.length; k += 5) done += v[k + 1];
    if (!done) continue;
    for (let k = 0; k + 2 < parts.length; k += 2) {
      const id = `${parts[k]}>${parts[k + 2]}@${parts[k + 1]}`;
      out.set(id, (out.get(id) ?? 0) + done);
    }
  }
  for (const [k, v] of out) out.set(k, r1(v / recs.length));
  return out;
}

/** Places where two lines meet (the same stop, or stops within a short walk), with the average wait for the second line and the changes people made there recently. */
export function transferPoints(game: Game, line: Id | null, walkM: number, limit = 30): Rec[] {
  const s = game.state;
  const routes = Object.values(s.routes);
  const stopsOf = (id: Id) => [...new Set([...s.routes[id].stops, ...(s.routes[id].returnStops ?? [])])].filter((x) => s.stops[x]);
  const changes = recordedChanges(game);
  const out: Rec[] = [];
  for (const A of line ? routes.filter((r) => r.id === line) : routes) {
    const sa = stopsOf(A.id);
    for (const B of routes) {
      if (B.id === A.id) continue;
      const sb = stopsOf(B.id);
      let best: { a: Id; b: Id; m: number } | null = null;
      for (const x of sa) for (const y of sb) {
        const m = x === y ? 0 : metresBetween(game, s.stops[x].lngLat, s.stops[y].lngLat) * WALK_FACTOR;
        if (m <= walkM && (!best || m < best.m || (m === best.m && `${x}${y}` < `${best.a}${best.b}`))) best = { a: x, b: y, m };
      }
      if (!best) continue;
      const head = B.suspended ? null : game.headwayAt(B.id, 0, game.t);
      let made = 0;
      for (const x of sa) for (const y of sb) if (x === y || metresBetween(game, s.stops[x].lngLat, s.stops[y].lngLat) * WALK_FACTOR <= walkM) made += changes.get(`${A.id}>${B.id}@${y}`) ?? changes.get(`${A.id}>${B.id}@${x}`) ?? 0;
      const st = s.stops[best.a];
      out.push({
        kind: 'transfer', id: `${A.id}>${B.id}`, label: `Line ${A.number} → line ${B.number} at ${st.name}`,
        line: A.id, lineNumber: A.number, toLine: B.id, toLineNumber: B.number,
        stop: best.a, stopName: st.name, toStop: best.b, toStopName: s.stops[best.b].name, walk: Math.round(best.m),
        wait: head === null ? null : r1(head / 2), headway: head, changesPerDay: r1(made), lng: st.lngLat[0], lat: st.lngLat[1],
      });
    }
  }
  out.sort((a, b) => (b.changesPerDay as number) - (a.changesPerDay as number) || (a.walk as number) - (b.walk as number) || String(a.id).localeCompare(String(b.id)));
  return out.slice(0, limit);
}

// ───────────────────────────────────────────── coming departures and how full they will be

/** A departure as a record (a trip that has not left yet, or the one a bus is on). */
export function departureRec(game: Game, trip: Trip): Rec {
  const s = game.state;
  const r = s.routes[trip.route];
  const p = game.pattern(trip.route, trip.pat);
  const v = trip.veh ? s.vehicles[trip.veh] : null;
  const at = startTime(game, trip);
  return {
    kind: 'departure', id: String(trip.id), trip: trip.id, label: `Line ${r?.number ?? '?'} at ${hhmm(at)}`,
    line: trip.route, lineNumber: r?.number ?? '', time: hhmm(at), in: Math.round((at - game.t) / 60), dir: trip.pat,
    from: p ? s.stops[p.stops[trip.from ?? 0]]?.name ?? null : null, towards: p ? s.stops[p.stops[p.stops.length - 1]]?.name ?? null : null,
    bus: v?.id ?? null, fleetNo: v?.fleetNo ?? null, hasBus: !!v, extra: !!trip.extra, moved: trip.adj ? hhmm(trip.adj.from) : null,
  };
}

/** Departures of a line that have not left yet within `hours` hours. */
export function departures(game: Game, route: Id, hours: number, limit = 30): Rec[] {
  return upcomingTrips(game, route, hours).slice(0, limit).map((t) => departureRec(game, t));
}

/**
 * How full a direction's busiest point gets compared with its boardings per trip, from recent
 * days (the line's own pattern of riding). Null when too little has been recorded.
 */
export function peakRatio(game: Game, route: Id, pat: number, capacity: number): number | null {
  const a = game.state.analytics;
  const p = game.pattern(route, pat);
  if (!p) return null;
  let trips = 0, boards = 0;
  const ls = new Array<number>(p.stops.length - 1).fill(0), ln = new Array<number>(p.stops.length - 1).fill(0);
  for (const d of [...a.days.slice(-7), a.today]) {
    const rd = d.routes[route];
    if (!rd) continue;
    for (const [key, pd] of Object.entries(rd.p)) {
      if (pd.pat !== pat || pd.stops.length !== p.stops.length || pd.stops.some((x, i) => x !== p.stops[i])) continue;
      trips += pd.ln[0] ?? 0;
      boards += (rd.bp?.[key] ?? []).reduce((x, y) => x + y, 0);
      for (let i = 0; i < ls.length; i++) {
        ls[i] += pd.ls[i] ?? 0;
        ln[i] += pd.ln[i] ?? 0;
      }
    }
  }
  if (trips < 6 || boards <= 0) return null;
  let peak = 0;
  for (let i = 0; i < ls.length; i++) if (ln[i]) peak = Math.max(peak, ls[i] / ln[i]);
  return Math.max(0.2, Math.min(1.2, (peak * capacity) / (boards / trips)));
}

/** A typical share for a city line when nothing has been recorded yet: the fullest point carries about 60% of a trip's boardings. */
export const DEFAULT_PEAK_RATIO = 0.6;

/**
 * The line's next departures with the expected boardings and how full each will be at its
 * fullest point: the demand forecast for each hour, split by direction as people have been
 * riding, shared between that hour's departures, times the line's own peak-to-boardings
 * ratio, against the bus's places. An estimate.
 */
export function forecastOccupancy(game: Game, route: Id, count: number, hours: number): Rec[] {
  const s = game.state;
  const r = s.routes[route];
  if (!r) return [];
  const h = Math.max(1, Math.min(6, Math.round(hours)));
  const f = demandForecast(game, h, route)?.lines[0];
  if (!f) return [];
  const trips = upcomingTrips(game, route, h).slice(0, Math.max(1, Math.min(30, count)));
  const caps = r.vehicles.map((id) => s.vehicles[id]).filter(Boolean).map((v) => MODEL[v.model].capacity);
  const lineCap = caps.length ? caps.reduce((a, b) => a + b, 0) / caps.length : MODEL.city12?.capacity ?? 90;
  const hour0 = Math.floor(game.t / HOUR);
  const hoursRec = (f.hours as Rec[]) ?? [];
  // direction shares by hour from recent days (boardings per pattern by hour)
  const share = (pat: number, hourOfDay: number) => {
    let mine = 0, all = 0;
    for (const d of [...s.analytics.days.slice(-7), s.analytics.today]) {
      const rd = d.routes[route];
      if (!rd?.bp) continue;
      for (const [key, arr] of Object.entries(rd.bp)) {
        const n = arr[hourOfDay] ?? 0;
        all += n;
        if (rd.p[key]?.pat === pat) mine += n;
      }
    }
    const pats = (game.patterns.get(route) ?? []).filter((p) => p.valid).length || 1;
    return all > 20 ? mine / all : 1 / pats;
  };
  return trips.map((trip) => {
    const k = Math.floor(trip.dep / HOUR) - hour0;
    const hr = hoursRec[k];
    const riders = hr ? Number(hr.riders) || 0 : 0;
    const hourStart = (hour0 + k) * HOUR;
    const sameDir = (s.trips[route] ?? []).filter((x) => x.pat === trip.pat && x.dep >= Math.max(hourStart, game.t) && x.dep < hourStart + HOUR && x.state !== TripState.Missed).length || 1;
    const board = (riders * share(trip.pat, Math.floor((trip.dep % DAY) / HOUR))) / sameDir;
    const v = trip.veh ? s.vehicles[trip.veh] : null;
    const cap = v ? MODEL[v.model].capacity : lineCap;
    const ratio = peakRatio(game, route, trip.pat, lineCap);
    const peak = board * (ratio ?? DEFAULT_PEAK_RATIO);
    return {
      ...departureRec(game, trip), boardings: r1(board), peakLoad: Math.round(peak), capacity: Math.round(cap), occupancy: Math.round((peak / cap) * 100),
      ratioFrom: ratio === null ? 'assumed' : 'recorded', estimate: true,
    };
  });
}

// ───────────────────────────────────────────── connections about to be missed

/**
 * People on buses now who change to another line at a stop ahead, with whether the departure
 * they would want leaves before they get there. From their own journey plans and the buses'
 * predicted times. `holdNeeded`: minutes the connecting bus would have to wait.
 */
export function missedConnections(game: Game, line: Id | null, horizonMin: number, limit = 30): Rec[] {
  const s = game.state;
  const now = game.t;
  const out: Rec[] = [];
  for (const v of game.vehicleList()) {
    if (v.trip === null || (v.status !== 'in_service' && v.status !== 'at_stop') || v.pos.kind !== 'pattern') continue;
    if (line && v.pos.route !== line) continue;
    const route = v.pos.route;
    const groups = new Map<string, { a: Id; r: Id; p: number; n: number }>();
    for (const g of s.pax.onboard[v.id] ?? []) {
      const cur = g.legs[g.leg], next = g.legs[g.leg + 1];
      if (!cur || !next || next.r === route) continue;
      const k = `${cur.a}|${next.r}|${next.p}`;
      const x = groups.get(k);
      if (x) x.n += g.n;
      else groups.set(k, { a: cur.a, r: next.r, p: next.p, n: g.n });
    }
    if (!groups.size) continue;
    const etas = vehicleStops(game, v);
    for (const c of groups.values()) {
      const at = etas.find((x) => x.stop === c.a && x.index >= v.stopIdx);
      if (!at || at.eta > now + horizonMin * 60) continue;
      const ready = at.eta + 30; // getting off and across to the other bus
      const deps = arrivalsAt(game, c.a, 16, 2 * HOUR).filter((x) => x.route === c.r && x.pat === c.p && !x.terminates && x.eta >= now);
      const before = deps.filter((x) => x.eta < ready && x.eta >= ready - 10 * 60).at(-1);
      const after = deps.find((x) => x.eta >= ready);
      const target = before ?? after;
      if (!target) continue;
      const margin = (target.eta - ready) / 60;
      const to = s.routes[c.r];
      const connecting = target.veh ? s.vehicles[target.veh] : null;
      out.push({
        kind: 'connection', id: `${v.id}:${c.a}:${c.r}`, label: `${v.fleetNo} → line ${to?.number ?? '?'} at ${s.stops[c.a]?.name ?? ''}`,
        vehicle: v.id, fleetNo: v.fleetNo, line: route, lineNumber: s.routes[route]?.number ?? '',
        stop: c.a, stopName: s.stops[c.a]?.name ?? '', arrive: hhmm(at.eta), in: Math.round((at.eta - now) / 60), people: c.n,
        toLine: c.r, toLineNumber: to?.number ?? '', departs: hhmm(target.eta), connectingBus: connecting?.id ?? null, connectingFleetNo: connecting?.fleetNo ?? null,
        margin: r1(margin), missed: !!before, holdNeeded: before ? Math.ceil(-margin) : 0,
        waitIfMissed: before && after ? r1((after.eta - ready) / 60) : null, estimate: true,
      });
    }
  }
  out.sort((a, b) => Number(b.missed) - Number(a.missed) || (b.people as number) - (a.people as number) || String(a.id).localeCompare(String(b.id)));
  return out.slice(0, limit);
}

// ───────────────────────────────────────────── gaps between buses

export interface GapOptions {
  /** a gap ahead shorter than this share of the headway counts as bunched */
  bunch: number;
  /** a gap ahead longer than this share of the headway counts as a gap in service */
  gap: number;
}
export const GAP_DEFAULTS: GapOptions = { bunch: 0.35, gap: 1.6 };
/** A node's "close together" and "big gap" settings (percent of the timetable gap). */
export const gapOptions = (c: Record<string, Value>): GapOptions => ({
  bunch: Math.max(10, Math.min(80, Number(c.bunch ?? 35) || 35)) / 100,
  gap: Math.max(110, Math.min(400, Number(c.gap ?? 160) || 160)) / 100,
});

export interface Running {
  v: Vehicle;
  trip: Trip;
  p: Pattern;
  /** scheduled seconds from the trip's start to where the bus is now */
  pos: number;
}

export interface GapBus {
  run: Running;
  /** timetable minutes to the bus ahead and behind in the same direction (null: none) */
  ahead: number | null;
  behind: number | null;
  /** minutes to hold it to even out the gaps around it (0–10) */
  hold: number;
}

/** Scheduled running time from the start of the pattern to where the bus is (seconds). */
function schedPos(game: Game, v: Vehicle, trip: Trip, p: Pattern): number | null {
  const sch = tripSchedule(game, trip);
  if (!sch || v.pos.kind !== 'pattern') return null;
  const i = Math.min(v.stopIdx, p.stops.length - 1);
  if (v.status === 'at_stop' || i === 0) return sch[i] ?? 0;
  const a = p.stopS[i - 1], b = p.stopS[i];
  const f = b > a ? Math.max(0, Math.min(1, (v.pos.s - a) / (b - a))) : 1;
  return (sch[i - 1] ?? 0) + f * ((sch[i] ?? 0) - (sch[i - 1] ?? 0));
}

/**
 * The buses on a line now, in order along each direction, with the time gap to the bus ahead
 * and behind (in scheduled running minutes), the timetable headway, and the hold that would even
 * out the gaps. Also suggestions to fill a big gap with a late bus from the other direction
 * turning back early. `bunched`: pairs closer than the bunch share; `worstGap`: the longest gap
 * ahead of a bus, as a share of the headway.
 */
export function lineGaps(game: Game, route: Id, o: GapOptions = GAP_DEFAULTS) {
  const s = game.state;
  const r = s.routes[route];
  const headway = r && !r.suspended ? game.headwayAt(route, 0, game.t) : null;
  const byPat = new Map<number, Running[]>();
  for (const id of r?.vehicles ?? []) {
    const v = s.vehicles[id];
    if (!v || v.trip === null || (v.status !== 'in_service' && v.status !== 'at_stop') || v.pos.kind !== 'pattern' || v.pos.route !== route) continue;
    const trip = game.trip(v.trip);
    const p = game.pattern(route, v.pos.pat);
    if (!trip || !p || trip.state !== TripState.Running) continue;
    const pos = schedPos(game, v, trip, p);
    if (pos === null) continue;
    byPat.set(p.index, [...(byPat.get(p.index) ?? []), { v, trip, p, pos }]);
  }
  const buses: GapBus[] = [];
  let bunched = 0, worst: number | null = null;
  const gapsFound: { pat: number; ahead: Running; behind: Running; minutes: number }[] = [];
  for (const list of byPat.values()) {
    list.sort((a, b) => b.pos - a.pos || a.v.id.localeCompare(b.v.id));
    for (let i = 0; i < list.length; i++) {
      const ahead = i > 0 ? (list[i - 1].pos - list[i].pos) / 60 : null;
      const behind = i + 1 < list.length ? (list[i].pos - list[i + 1].pos) / 60 : null;
      let hold = 0;
      if (headway && ahead !== null && ahead < headway) hold = behind !== null ? (behind - ahead) / 2 : (headway - ahead) / 2;
      buses.push({ run: list[i], ahead, behind, hold: Math.max(0, Math.min(10, Math.round(hold))) });
      if (headway && ahead !== null) {
        if (ahead < o.bunch * headway) bunched++;
        const share = ahead / headway;
        worst = worst === null ? share : Math.max(worst, share);
        if (ahead > o.gap * headway) gapsFound.push({ pat: list[i].p.index, ahead: list[i - 1], behind: list[i], minutes: ahead });
      }
    }
  }
  // a late bus going the other way can turn back inside a gap: at the first stop ahead of it
  // that lies, in the gap's direction, between the two buses
  const turnBacks: Rec[] = [];
  const used = new Set<Id>();
  for (const gp of gapsFound.sort((a, b) => b.minutes - a.minutes)) {
    const opp = byPat.get(1 - gp.pat) ?? [];
    const p = gp.behind.p;
    const lo = gp.behind.v.stopIdx, hi = gp.ahead.v.stopIdx - 1;
    for (const c of [...opp].sort((a, b) => b.v.delay - a.v.delay)) {
      if (used.has(c.v.id) || c.v.delay < 3 * 60 || r?.kind === 'loop') continue;
      const cp = c.p;
      let pick: { stop: Id; at: number } | null = null;
      for (let k = Math.max(c.v.stopIdx, 1); k < cp.stops.length - 1; k++) {
        const j = p.stops.indexOf(cp.stops[k]);
        if (j >= lo && j <= hi && j < p.stops.length - 1) {
          pick = { stop: cp.stops[k], at: k };
          break;
        }
      }
      if (!pick) continue;
      used.add(c.v.id);
      turnBacks.push({
        kind: 'vehicle', id: c.v.id, fleetNo: c.v.fleetNo, line: route, lineNumber: r?.number ?? '', stop: pick.stop, stopName: s.stops[pick.stop]?.name ?? '',
        late: r1(c.v.delay / 60), gap: r1(gp.minutes), label: `${c.v.fleetNo} could turn back at ${s.stops[pick.stop]?.name ?? ''}`,
      });
      break;
    }
  }
  return { headway, buses, bunched, worstGap: worst === null ? null : Math.round(worst * 100), turnBacks };
}

// ───────────────────────────────────────────── assignment

/**
 * The cheapest one-to-one assignment of rows to columns (the Hungarian method). `cost[i][j]` is
 * Infinity where row i may not take column j. Returns the column for each row, or -1. Rows and
 * columns need not be the same number. Exact, O(n³); the caller keeps n small.
 */
export function assignRows(cost: number[][]): number[] {
  const rows = cost.length, cols = rows ? cost[0].length : 0;
  if (!rows || !cols) return new Array(rows).fill(-1);
  const n = Math.max(rows, cols);
  // forbidden pairs cost more than any allowed assignment could, so they are used only when
  // nothing else is possible (and then dropped)
  let big = 1;
  for (const row of cost) for (const c of row) if (Number.isFinite(c)) big = Math.max(big, Math.abs(c));
  const BIG = big * (n + 1) * 4 + 1;
  const a = (i: number, j: number) => (i < rows && j < cols ? (Number.isFinite(cost[i][j]) ? cost[i][j] : BIG) : 0);
  const u = new Float64Array(n + 1), v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1), way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= n; j++) {
    const i = p[j] - 1;
    if (i >= 0 && i < rows && j - 1 < cols && Number.isFinite(cost[i][j - 1])) out[i] = j - 1;
  }
  return out;
}

// ───────────────────────────────────────────── a sketch of a new line

/** The stop in an area nearest to where its people and jobs are (its weighted centre). */
export function areaStop(game: Game, area: string): Id | null {
  const z = game.geo.zone(area);
  if (!z) return null;
  let best: { id: Id; m: number } | null = null;
  for (const st of Object.values(game.state.stops)) {
    if (st.zone !== area) continue;
    const m = metresBetween(game, st.lngLat, z.centroid);
    if (!best || m < best.m || (m === best.m && st.id < best.id)) best = { id: st.id, m };
  }
  return best?.id ?? null;
}

/**
 * Your existing stops along the quickest road between two stops (within 150 m of it, at least
 * 300 m apart), in order: a first sketch of a line for the player to review. Null when no road
 * links them.
 */
export function corridorStops(game: Game, a: Id, b: Id, max = 20): Id[] | null {
  const s = game.state;
  const A = s.stops[a], B = s.stops[b];
  if (!A || !B || a === b) return null;
  const g = game.region.graph;
  const leg = routeLeg(g, A.node, B.node) ?? routeLeg(g, A.node, B.node, { lenient: true });
  if (!leg) return null;
  const xs = leg.nodes.map((n) => g.x[n]), ys = leg.nodes.map((n) => g.y[n]);
  const cum = [0];
  for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
  const total = cum[cum.length - 1];
  const NEAR = 150;
  const minX = Math.min(...xs) - NEAR, maxX = Math.max(...xs) + NEAR, minY = Math.min(...ys) - NEAR, maxY = Math.max(...ys) + NEAR;
  const found: { id: Id; at: number }[] = [];
  for (const st of Object.values(s.stops)) {
    if (st.id === a || st.id === b) continue;
    const [x, y] = game.geo.xy(st.lngLat);
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    let best = Infinity, at = 0;
    for (let i = 0; i + 1 < xs.length; i++) {
      const dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i];
      const L2 = dx * dx + dy * dy;
      const f = L2 > 0 ? Math.max(0, Math.min(1, ((x - xs[i]) * dx + (y - ys[i]) * dy) / L2)) : 0;
      const d = Math.hypot(x - (xs[i] + f * dx), y - (ys[i] + f * dy));
      if (d < best) {
        best = d;
        at = cum[i] + f * Math.sqrt(L2);
      }
    }
    if (best <= NEAR) found.push({ id: st.id, at });
  }
  found.sort((p, q) => p.at - q.at || p.id.localeCompare(q.id));
  const out: Id[] = [a];
  let last = 0;
  for (const f of found) {
    if (f.at - last < 300 || total - f.at < 300) continue;
    out.push(f.id);
    last = f.at;
  }
  // too many: keep the ends and an even spread between them
  let mid = out.slice(1);
  if (mid.length > max - 2) mid = Array.from({ length: max - 2 }, (_, k) => mid[Math.round(((k + 0.5) * mid.length) / (max - 2) - 0.5)]);
  return [a, ...mid, b];
}
