// Recording hooks for operational analytics. Each function is called from the place in the
// simulation where the thing actually happens (a boarding in serveStop, a departure in
// departStop, a vehicle-minute in minuteVehicles, ...), so analytics are measurements of the
// simulation, never reconstructions. All functions are cheap: a few lookups and additions.

import type { GameState, Id, PaxGroup, Vehicle } from '../types.ts';
import type { Pattern } from '../network.ts';
import { DAY, HOUR } from '../content.ts';
import { ASSIGNMENT_LOG, BANDS, DETAIL_DAYS, SUMMARY_DAYS, TYPE_COUNT, bandOf, emptyDay, hours0, types0, type DayRecord, type DaySummary, type PatDay, type RouteDay, type StopDay, type VehicleDay } from './types.ts';

/**
 * Hour of the calendar day an event at time t is recorded in. An event at exactly midnight
 * belongs to the day that is ending (the day closes at the end of that tick).
 */
export const recHour = (t: number) => Math.floor((((t - 1) % DAY) + DAY) % DAY / HOUR);

function stopDay(state: GameState, id: Id): StopDay {
  const rec = state.analytics.today;
  let s = rec.stops[id];
  if (!s) {
    s = rec.stops[id] = { b: hours0(), a: hours0(), g: hours0(), w: hours0(), ws: 0, wn: 0, wx: 0, x: 0, lb: 0, rv: 0, bl: {} };
    const st = state.stops[id];
    if (st) state.analytics.names.s[id] = st.name;
  }
  return s;
}

function routeDay(state: GameState, id: Id): RouteDay {
  const rec = state.analytics.today;
  let r = rec.routes[id];
  if (!r) {
    r = rec.routes[id] = { b: hours0(), d: hours0(), o: hours0(), m: hours0(), dp: hours0(), lf: hours0(), dl: hours0(), pk: hours0(), ck: hours0(), rv: hours0(), vm: hours0(), lb: 0, cr: 0, g: 0, ws: 0, wn: 0, ss: 0, sn: 0, x: 0, p: {} };
    const ro = state.routes[id];
    if (ro) state.analytics.names.r[id] = { n: ro.number, c: ro.colour };
  }
  return r;
}

function vehDay(state: GameState, v: Vehicle): VehicleDay {
  const rec = state.analytics.today;
  let d = rec.veh[v.id];
  if (!d) {
    d = rec.veh[v.id] = { sv: 0, ly: 0, dh: 0, pk: 0, mt: 0, bk: 0, km0: v.km, km: 0, b: 0, pkm: 0, rv: 0, ms: 0, rt: {}, dl: 0, dn: 0, mdl: v.model };
    state.analytics.names.v[v.id] = v.fleetNo;
  }
  return d;
}

function patDay(rd: RouteDay, p: Pattern): PatDay {
  const key = `${p.index}|${p.stops.join(',')}`;
  let pd = rd.p[key];
  if (!pd) {
    const n = Math.max(0, p.stops.length - 1);
    const z = () => new Array<number>(n).fill(0);
    pd = rd.p[key] = { pat: p.index, stops: [...p.stops], ls: z(), ln: z(), rs: z(), rn: z(), ss: z() };
  }
  return pd;
}

// ───────────────────────────────────────────── passengers

export function recBoard(state: GameState, stop: Id, route: Id, veh: Vehicle, n: number, waitedSec: number, transfer: boolean, type?: number) {
  const h = recHour(state.clock.t);
  const sd = stopDay(state, stop);
  sd.b[h] += n;
  if (type !== undefined) {
    (sd.k ??= types0())[type] += n;
    (routeDay(state, route).k ??= new Array<number>(TYPE_COUNT * BANDS.length).fill(0))[type * BANDS.length + bandOf(h)] += n;
  }
  const wm = Math.max(0, waitedSec) / 60;
  sd.ws += wm * n;
  sd.wn += n;
  if (wm > sd.wx) sd.wx = wm;
  sd.bl[route] = (sd.bl[route] ?? 0) + n;
  const rd = routeDay(state, route);
  rd.b[h] += n;
  rd.ws += wm * n;
  rd.wn += n;
  vehDay(state, veh).b += n;
  if (transfer) {
    sd.x += n;
    rd.x += n;
  }
}

/** A fare sold at `stop` on `route` by bus `veh` (the first boarding of a journey). */
export function recFare(state: GameState, stop: Id, route: Id, veh: Vehicle, amt: number) {
  stopDay(state, stop).rv += amt;
  routeDay(state, route).rv[recHour(state.clock.t)] += amt;
  vehDay(state, veh).rv += amt;
}

export function recAlight(state: GameState, stop: Id, n: number) {
  stopDay(state, stop).a[recHour(state.clock.t)] += n;
}

export function recLeftBehind(state: GameState, stop: Id, route: Id, n: number, byType?: number[]) {
  if (n <= 0) return;
  stopDay(state, stop).lb += n;
  if (byType) {
    const net = state.analytics.today.net;
    byType.forEach((v, k) => {
      if (v) (net.lk ??= types0())[k] += v;
    });
  }
  const rd = routeDay(state, route);
  rd.lb += n;
  rd.cr++;
}

export function recGaveUp(state: GameState, stop: Id, route: Id | undefined, n: number) {
  stopDay(state, stop).g[recHour(state.clock.t)] += n;
  if (route && state.routes[route]) routeDay(state, route).g += n;
}

/** Lines used and transfer stops of an itinerary, e.g. `r1` or `r1.s5.r3`. */
export function itinerarySig(g: PaxGroup): string {
  return g.legs.map((l, i) => (i < g.legs.length - 1 ? `${l.r}.${l.a}` : l.r)).join('.');
}

/** A journey ended: completed at its destination or abandoned. */
export function recJourney(state: GameState, g: PaxGroup, completed: boolean, sat: { overall: number; comp: number[] }, stranded = false) {
  const t = state.clock.t;
  const rec = state.analytics.today;
  const h = recHour(t);
  const net = rec.net;
  if (completed) {
    net.j[h] += g.n;
    net.jt += ((t - g.t0) / 60) * g.n;
    net.wt += (g.w / 60) * g.n;
    if (g.legs.length > 1) net.xf += g.n;
    if (g.k !== undefined) (net.jk ??= types0())[g.k] += g.n;
  } else {
    net.ab[h] += g.n;
    if (stranded) {
      (net.sd ??= hours0())[h] += g.n;
      if (g.k !== undefined) (net.sk ??= types0())[g.k] += g.n;
    }
  }
  net.ss += sat.overall * g.n;
  net.sn += g.n;
  for (let i = 0; i < 5; i++) net.comp[i] += (sat.comp[i] ?? 0) * g.n;
  const route = g.fr ?? g.legs[0]?.r;
  if (route && state.routes[route]) {
    const rd = routeDay(state, route);
    rd.ss += sat.overall * g.n;
    rd.sn += g.n;
  }
  // origin–destination, by the time band the journey started in (stranded travellers never had
  // a line or an itinerary: they are counted in `net` only)
  if (stranded) return;
  const key = `${g.o}>${g.d}>${itinerarySig(g)}`;
  const band = bandOf(Math.floor((((g.t0 % DAY) + DAY) % DAY) / HOUR));
  const arr = (rec.od[key] ??= []);
  let i = 0;
  while (i < arr.length && arr[i] !== band) i += 5;
  if (i >= arr.length) arr.push(band, 0, 0, 0, 0);
  if (completed) {
    arr[i + 1] += g.n;
    arr[i + 3] += ((t - g.t0) / 60) * g.n;
  } else arr[i + 2] += g.n;
  arr[i + 4] += (g.w / 60) * g.n;
  // completed journeys by traveller type: [type, people, type, people, …]
  if (completed && g.k !== undefined) {
    const tv = ((rec.odk ??= {})[key] ??= []);
    let j = 0;
    while (j < tv.length && tv[j] !== g.k) j += 2;
    if (j >= tv.length) tv.push(g.k, 0);
    tv[j + 1] += g.n;
  }
  for (const id of [g.o, g.d]) if (!(id in state.analytics.names.s) && state.stops[id]) state.analytics.names.s[id] = state.stops[id].name;
}

// ───────────────────────────────────────────── vehicles and trips

/** A bus leaves stop `idx` of pattern `p` with its current load. */
export function recDepart(state: GameState, p: Pattern, idx: number, v: Vehicle, capacity: number, delaySec: number) {
  const rd = routeDay(state, p.route);
  const vd = vehDay(state, v);
  const h = recHour(state.clock.t);
  // every stop departure counts, the first one too: a late start is a delay passengers feel
  const late = Math.max(0, delaySec);
  rd.dp[h]++;
  rd.lf[h] += capacity > 0 ? v.load / capacity : 0;
  rd.dl[h] += late;
  vd.dl += late;
  vd.dn++;
  if (idx >= p.stops.length - 1) return;
  const len = Math.max(0, p.stopS[idx + 1] - p.stopS[idx]) / 1000;
  rd.pk[h] += v.load * len;
  rd.ck[h] += capacity * len;
  vd.pkm += v.load * len;
  const pd = patDay(rd, p);
  pd.ls[idx] += capacity > 0 ? v.load / capacity : 0;
  pd.ln[idx]++;
}

/**
 * A bus reached stop `to` having left stop `from` `elapsed` seconds ago (it may have passed
 * stops nobody needed). The time is split over the segments by length. `scheduled` is the
 * timetabled run time for the same stretch.
 */
export function recRun(state: GameState, p: Pattern, from: number, to: number, elapsed: number, scheduled: number) {
  if (to <= from || to >= p.stops.length || elapsed <= 0) return;
  const pd = patDay(routeDay(state, p.route), p);
  const total = p.stopS[to] - p.stopS[from];
  for (let i = from; i < to; i++) {
    const share = total > 0 ? (p.stopS[i + 1] - p.stopS[i]) / total : 1 / (to - from);
    pd.rs[i] += elapsed * share;
    pd.ss[i] += Math.max(0, scheduled) * share;
    pd.rn[i]++;
  }
}

export function recTripDone(state: GameState, route: Id, onTime: boolean) {
  const rd = routeDay(state, route);
  const h = recHour(state.clock.t);
  rd.d[h]++;
  if (onTime) rd.o[h]++;
}

export function recMissed(state: GameState, route: Id) {
  routeDay(state, route).m[recHour(state.clock.t)]++;
}

const STAFFED = new Set(['preparing', 'to_route', 'in_service', 'at_stop', 'layover', 'to_depot', 'broken']);

/** One simulated minute of a vehicle's day. */
export function recVehicleMinute(state: GameState, v: Vehicle) {
  const vd = vehDay(state, v);
  switch (v.status) {
    case 'in_service': case 'at_stop': vd.sv++; break;
    case 'layover': vd.ly++; break;
    case 'to_route': case 'to_depot': case 'preparing': vd.dh++; break;
    case 'parked': vd.pk++; break;
    case 'maintenance': vd.mt++; break;
    case 'broken': vd.bk++; break;
  }
  const line = v.route ?? v.target?.route;
  if (line && STAFFED.has(v.status) && state.routes[line]) {
    vd.rt[line] = (vd.rt[line] ?? 0) + 1;
    routeDay(state, line).vm[recHour(state.clock.t)]++;
  }
  vd.km = v.km - vd.km0;
}

export function recMaintenance(state: GameState, v: Vehicle, cost: number) {
  vehDay(state, v).ms += cost;
}

export function recAssignment(state: GameState, v: Id, from: Id | null, to: Id | null, src: string) {
  const log = state.analytics.assignments;
  log.push({ t: state.clock.t, v, from, to, src });
  if (log.length > ASSIGNMENT_LOG) log.splice(0, log.length - ASSIGNMENT_LOG);
}

/** On the hour: how many passengers are waiting at each stop. */
export function sampleWaiting(state: GameState) {
  const h = recHour(state.clock.t);
  for (const [stop, list] of Object.entries(state.pax.waiting)) {
    let n = 0;
    for (const g of list) n += g.n;
    if (n > 0) stopDay(state, stop).w[h] = n;
  }
}

// ───────────────────────────────────────────── day close

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Round accumulated sums so the save stays compact (measurements keep 0.1 precision). */
function compact(rec: DayRecord) {
  const n = rec.net;
  n.ss = r1(n.ss); n.jt = r1(n.jt); n.wt = r1(n.wt);
  n.comp = n.comp.map(r1) as typeof n.comp;
  for (const s of Object.values(rec.stops)) { s.ws = r1(s.ws); s.wx = r1(s.wx); s.rv = r2(s.rv); }
  for (const r of Object.values(rec.routes)) {
    r.pk = r.pk.map(r1); r.ck = r.ck.map(r1); r.dl = r.dl.map(Math.round); r.lf = r.lf.map(r3); r.rv = r.rv.map(r2); r.ss = r1(r.ss); r.ws = r1(r.ws);
    for (const p of Object.values(r.p)) {
      p.ls = p.ls.map(r3); p.rs = p.rs.map(Math.round); p.ss = p.ss.map(Math.round);
    }
  }
  for (const v of Object.values(rec.veh)) { v.km = r3(v.km); v.km0 = r3(v.km0); v.pkm = r1(v.pkm); v.rv = r2(v.rv); v.ms = Math.round(v.ms); v.dl = Math.round(v.dl); }
  for (const arr of Object.values(rec.od)) for (let i = 0; i < arr.length; i += 5) { arr[i + 3] = r1(arr[i + 3]); arr[i + 4] = r1(arr[i + 4]); }
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

export function summarise(rec: DayRecord): DaySummary {
  const out: DaySummary = { day: rec.day, r: {}, s: {}, n: [sum(rec.net.j), sum(rec.net.ab), r1(rec.net.ss), rec.net.sn] };
  for (const [id, r] of Object.entries(rec.routes)) out.r[id] = [sum(r.b), sum(r.d), sum(r.o), sum(r.m), r1(sum(r.pk)), r1(sum(r.ck))];
  for (const [id, s] of Object.entries(rec.stops)) out.s[id] = [sum(s.b), sum(s.a), sum(s.g)];
  return out;
}

/** Close the calendar day `day`: file today's record, start the next, fold old detail. */
export function closeAnalyticsDay(state: GameState, day: number): DayRecord {
  const a = state.analytics;
  const rec = a.today;
  rec.day = day;
  // vehicles that sat in the depot all day still have a day (utilisation 0 is a fact)
  compact(rec);
  // keep display names current
  for (const s of Object.values(state.stops)) a.names.s[s.id] = s.name;
  for (const r of Object.values(state.routes)) a.names.r[r.id] = { n: r.number, c: r.colour };
  for (const v of Object.values(state.vehicles)) a.names.v[v.id] = v.fleetNo;
  a.days.push(rec);
  a.today = emptyDay(day + 1);
  while (a.days.length > DETAIL_DAYS) a.summary.push(summarise(a.days.shift()!));
  while (a.summary.length && a.summary[0].day < day - SUMMARY_DAYS) a.summary.shift();
  return rec;
}

/** The recorded day `day` (finished, or today's partial record), if it is still in detail. */
export function dayRecord(state: GameState, day: number): DayRecord | null {
  const a = state.analytics;
  if (a.today.day === day) return a.today;
  // days are in order; search from the end (recent days are asked for most)
  for (let i = a.days.length - 1; i >= 0; i--) {
    if (a.days[i].day === day) return a.days[i];
    if (a.days[i].day < day) break;
  }
  return null;
}

/** Boardings and completed trips on a recorded day (for qualifying operating days). */
export function dayActivity(rec: DayRecord) {
  let boardings = 0, trips = 0;
  for (const r of Object.values(rec.routes)) {
    boardings += sum(r.b);
    trips += sum(r.d);
  }
  return { boardings, trips };
}
