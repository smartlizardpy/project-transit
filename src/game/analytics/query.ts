// The analytics query layer, shared by Network Control and automation. A query names a
// grouping (network, line, stop, bus, area, day, hour, weekday), a set of days, optional hour
// and day-type filters and entity filters; the result has one row of measures per group.
//
// Every measure says where it comes from (measured in the simulation, booked in the ledger, or
// derived from measurements at the ledger's rates) and whether it can be split by hour.
// Measures that cannot honour a filter return null and the result explains why, instead of
// showing a number that means something else.

import type { Game } from '../engine.ts';
import type { Id } from '../types.ts';
import { DAY, ECON, MODEL } from '../content.ts';
import { weekdayOf } from '../time.ts';
import { compile, type EValue } from '../expr.ts';
import type { DayEstimate } from '../activity/model.ts';
import type { LngLat } from '../world/graph.ts';
import type { TransitMode } from '../world/places.ts';
import { KINDS, KIND_COUNT } from '../activity/params.ts';
import { MIN_FERRY_M, TRANSIT_SERVICE } from '../activity/transit.ts';
import { BANDS, TYPE_COUNT, type DayLabel, type DayRecord, type DaySummary } from './types.ts';
import { DAY_KINDS, EVENT_DAYS, WEATHER_GROUPS, dayKind, eventDay, makeDayLabel, weatherGroup, type DayKind, type EventDay, type WeatherGroup } from './labels.ts';
import { TRAVELLERS } from '../activity/params.ts';

export type GroupBy = 'network' | 'line' | 'stop' | 'vehicle' | 'zone' | 'day' | 'hour' | 'weekday' | 'weather' | 'daykind' | 'eventday' | 'type';
/** Groupings with one row per kind of day: they mean what a weekday grouping means. */
export const DAY_LEVEL = new Set<GroupBy>(['day', 'weekday', 'weather', 'daykind', 'eventday']);

/** Filters on the recorded days' labels (days recorded before labels were kept never match one). */
export interface LabelFilter {
  weather?: 'all' | WeatherGroup;
  dayKind?: 'all' | DayKind;
  eventDay?: 'all' | EventDay;
}
export type DaySel = { last: number } | { from: number; to: number };

export interface AnalyticsQuery {
  groupBy: GroupBy;
  /** finished days: the last N, or a range of day numbers (default: last 7) */
  days?: DaySel;
  /** include today so far */
  includeToday?: boolean;
  /** hours of the day [from, to); wraps past midnight when from > to */
  hours?: [number, number] | null;
  dayType?: 'all' | 'weekday' | 'weekend';
  /** one day of the week (0 = Monday) */
  weekday?: number | null;
  lines?: Id[];
  stops?: Id[];
  zones?: string[];
  vehicles?: Id[];
  weather?: 'all' | WeatherGroup;
  dayKind?: 'all' | DayKind;
  eventDay?: 'all' | EventDay;
}

export type Unit = 'count' | 'money' | 'percent' | 'minutes' | 'hours' | 'km' | 'score' | 'ratio';
export type Source = 'measured' | 'ledger' | 'derived';

/** Totals collected from day records; measures are computed from these. */
export interface Acc {
  boardings: number; alightings: number; gaveUp: number; leftBehind: number; crowded: number;
  waitSum: number; waitN: number; waitMax: number; transfers: number;
  trips: number; onTime: number; missed: number; deps: number; loadSum: number; delaySum: number;
  pkm: number; ckm: number; fares: number; busMin: number;
  satSum: number; satN: number; journeys: number; abandoned: number; journeyMin: number; journeyWait: number; journeyXf: number;
  cost: number | null;
  svMin: number; lyMin: number; dhMin: number; pkMin: number; mtMin: number; bkMin: number; km: number; maint: number;
  driverCost: number; fuelCost: number; fixedCost: number; vehDays: number;
  /** pieces of data this row had (to tell "zero" from "no data") */
  seen: number;
}

const emptyAcc = (): Acc => ({
  boardings: 0, alightings: 0, gaveUp: 0, leftBehind: 0, crowded: 0, waitSum: 0, waitN: 0, waitMax: 0, transfers: 0,
  trips: 0, onTime: 0, missed: 0, deps: 0, loadSum: 0, delaySum: 0, pkm: 0, ckm: 0, fares: 0, busMin: 0,
  satSum: 0, satN: 0, journeys: 0, abandoned: 0, journeyMin: 0, journeyWait: 0, journeyXf: 0, cost: null,
  svMin: 0, lyMin: 0, dhMin: 0, pkMin: 0, mtMin: 0, bkMin: 0, km: 0, maint: 0, driverCost: 0, fuelCost: 0, fixedCost: 0, vehDays: 0, seen: 0,
});

function merge(into: Acc, a: Acc) {
  for (const k of Object.keys(a) as (keyof Acc)[]) {
    if (k === 'waitMax') into.waitMax = Math.max(into.waitMax, a.waitMax);
    else if (k === 'cost') into.cost = a.cost === null ? into.cost : (into.cost ?? 0) + a.cost;
    else (into[k] as number) += a[k] as number;
  }
}

export interface MeasureDef {
  id: string;
  label: string;
  unit: Unit;
  source: Source;
  /** honours an hour-of-day filter */
  hourly: boolean;
  /** groupings where the measure means something */
  groups: GroupBy[];
  /** which way is good, for colouring changes */
  better: 'higher' | 'lower' | 'none';
  describe: string;
  calc: (a: Acc, days: number) => number | null;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const ALL: GroupBy[] = ['network', 'line', 'stop', 'vehicle', 'zone', 'day', 'hour', 'weekday'];
const NET: GroupBy[] = ['network', 'line', 'day', 'hour', 'weekday'];
const STOPS: GroupBy[] = ['network', 'stop', 'zone', 'day', 'hour', 'weekday'];
const VEH: GroupBy[] = ['network', 'vehicle', 'day', 'weekday'];

export const MEASURES: MeasureDef[] = [
  { id: 'boardings', label: 'Boardings', unit: 'count', source: 'measured', hourly: true, groups: [...ALL, 'type'], better: 'higher', describe: 'Passengers who got on a bus (a transfer counts again).', calc: (a) => a.boardings },
  { id: 'alightings', label: 'Alightings', unit: 'count', source: 'measured', hourly: true, groups: STOPS, better: 'none', describe: 'Passengers who got off at the stop.', calc: (a) => a.alightings },
  { id: 'journeys', label: 'Journeys', unit: 'count', source: 'measured', hourly: true, groups: ['network', 'line', 'stop', 'zone', 'day', 'hour', 'weekday', 'type'], better: 'higher', describe: 'Completed journeys (for a line: journeys that started on it; for a stop: journeys that started there).', calc: (a) => a.journeys },
  { id: 'abandoned', label: 'Gave up', unit: 'count', source: 'measured', hourly: true, groups: ['network', 'line', 'stop', 'zone', 'day', 'hour', 'weekday'], better: 'lower', describe: 'Passengers who gave up their journey (waited too long or no way to continue).', calc: (a) => a.abandoned },
  { id: 'leftBehind', label: 'Left behind', unit: 'count', source: 'measured', hourly: false, groups: ['network', 'line', 'stop', 'zone', 'day', 'weekday', 'type'], better: 'lower', describe: 'Passengers who could not board because the bus was full.', calc: (a) => a.leftBehind },
  { id: 'avgWait', label: 'Average wait', unit: 'minutes', source: 'measured', hourly: false, groups: ['network', 'line', 'stop', 'zone', 'day', 'weekday'], better: 'lower', describe: 'Average minutes waited at the stop before boarding.', calc: (a) => ratio(a.waitSum, a.waitN) },
  { id: 'maxWait', label: 'Longest wait', unit: 'minutes', source: 'measured', hourly: false, groups: ['network', 'stop', 'zone', 'day', 'weekday'], better: 'lower', describe: 'Longest wait before boarding.', calc: (a) => (a.waitN > 0 ? a.waitMax : null) },
  { id: 'transfers', label: 'Transfers', unit: 'count', source: 'measured', hourly: false, groups: ['network', 'line', 'stop', 'zone', 'day', 'weekday'], better: 'none', describe: 'Boardings that were a change from another bus.', calc: (a) => a.transfers },
  { id: 'trips', label: 'Trips run', unit: 'count', source: 'measured', hourly: true, groups: NET, better: 'higher', describe: 'Timetabled trips completed.', calc: (a) => a.trips },
  { id: 'onTime', label: 'On time', unit: 'percent', source: 'measured', hourly: true, groups: NET, better: 'higher', describe: 'Share of trips within 1 min early to 3 min late at their worst point.', calc: (a) => ratio(a.onTime * 100, a.trips) },
  { id: 'missed', label: 'Missed trips', unit: 'count', source: 'measured', hourly: true, groups: NET, better: 'lower', describe: 'Timetabled trips that did not run (no bus, too late or a breakdown).', calc: (a) => a.missed },
  { id: 'avgLoad', label: 'Average load', unit: 'percent', source: 'measured', hourly: true, groups: NET, better: 'none', describe: 'Average share of capacity in use when buses left a stop.', calc: (a) => ratio(a.loadSum * 100, a.deps) },
  { id: 'occupancy', label: 'Occupancy', unit: 'percent', source: 'measured', hourly: true, groups: NET, better: 'higher', describe: 'Passenger-km as a share of place-km offered.', calc: (a) => ratio(a.pkm * 100, a.ckm) },
  { id: 'pkm', label: 'Passenger-km', unit: 'km', source: 'measured', hourly: true, groups: [...NET, 'vehicle'], better: 'higher', describe: 'Distance travelled by passengers between stops.', calc: (a) => a.pkm },
  { id: 'avgDelay', label: 'Average delay', unit: 'minutes', source: 'measured', hourly: true, groups: [...NET, 'vehicle'], better: 'lower', describe: 'Average minutes late when leaving a stop (early counts as on time).', calc: (a) => ratio(a.delaySum / 60, a.deps) },
  { id: 'revenue', label: 'Fares', unit: 'money', source: 'measured', hourly: true, groups: ['network', 'line', 'stop', 'zone', 'vehicle', 'day', 'hour', 'weekday'], better: 'higher', describe: 'Fares sold (for a stop: journeys that started there; for a bus: tickets sold on board).', calc: (a) => a.fares },
  { id: 'cost', label: 'Costs', unit: 'money', source: 'ledger', hourly: false, groups: ['network', 'line', 'day', 'weekday'], better: 'lower', describe: 'Operating costs booked in the ledger (drivers, energy, maintenance, fleet, and for the network depots and stops).', calc: (a) => a.cost },
  { id: 'profit', label: 'Operating result', unit: 'money', source: 'ledger', hourly: false, groups: ['network', 'line', 'day', 'weekday'], better: 'higher', describe: 'Fares minus booked operating costs.', calc: (a) => (a.cost === null ? null : a.fares - a.cost) },
  { id: 'busHours', label: 'Bus-hours', unit: 'hours', source: 'measured', hourly: true, groups: NET, better: 'none', describe: 'Hours of staffed bus time on the line (driving, at stops, layover, positioning).', calc: (a) => a.busMin / 60 },
  { id: 'revenuePerBusHour', label: 'Fares per bus-hour', unit: 'money', source: 'measured', hourly: true, groups: NET, better: 'higher', describe: 'Fares divided by staffed bus-hours.', calc: (a) => ratio(a.fares, a.busMin / 60) },
  { id: 'satisfaction', label: 'Satisfaction', unit: 'score', source: 'measured', hourly: false, groups: ['network', 'line', 'day', 'weekday'], better: 'higher', describe: 'Average journey satisfaction (0–100).', calc: (a) => ratio(a.satSum * 100, a.satN) },
  { id: 'journeyTime', label: 'Journey time', unit: 'minutes', source: 'measured', hourly: false, groups: ['network', 'day', 'weekday'], better: 'lower', describe: 'Average door-to-door minutes of completed journeys (stop to stop, including waits).', calc: (a) => ratio(a.journeyMin, a.journeys) },
  { id: 'serviceHours', label: 'In service', unit: 'hours', source: 'measured', hourly: false, groups: VEH, better: 'none', describe: 'Hours driving trips or at stops.', calc: (a) => (a.vehDays ? a.svMin / 60 : null) },
  { id: 'utilisation', label: 'Utilisation', unit: 'percent', source: 'measured', hourly: false, groups: VEH, better: 'higher', describe: 'Share of the day in passenger service.', calc: (a) => (a.vehDays ? (a.svMin * 100) / (a.vehDays * 1440) : null) },
  { id: 'deadheadHours', label: 'Positioning', unit: 'hours', source: 'measured', hourly: false, groups: VEH, better: 'lower', describe: 'Hours preparing or driving empty to or from the line.', calc: (a) => (a.vehDays ? a.dhMin / 60 : null) },
  { id: 'layoverHours', label: 'Layover', unit: 'hours', source: 'measured', hourly: false, groups: VEH, better: 'none', describe: 'Hours waiting at a terminus between trips.', calc: (a) => (a.vehDays ? a.lyMin / 60 : null) },
  { id: 'idleHours', label: 'Parked', unit: 'hours', source: 'measured', hourly: false, groups: VEH, better: 'none', describe: 'Hours parked at the depot.', calc: (a) => (a.vehDays ? a.pkMin / 60 : null) },
  { id: 'downHours', label: 'Maintenance & breakdowns', unit: 'hours', source: 'measured', hourly: false, groups: VEH, better: 'lower', describe: 'Hours in the workshop or broken down.', calc: (a) => (a.vehDays ? (a.mtMin + a.bkMin) / 60 : null) },
  { id: 'km', label: 'Distance', unit: 'km', source: 'measured', hourly: false, groups: VEH, better: 'none', describe: 'Kilometres driven, including positioning.', calc: (a) => (a.vehDays ? a.km : null) },
  { id: 'vehicleCost', label: 'Running cost', unit: 'money', source: 'derived', hourly: false, groups: VEH, better: 'lower', describe: 'Driver hours and energy at the rates the ledger uses, plus maintenance spent and the daily fleet charge.', calc: (a) => (a.vehDays ? a.driverCost + a.fuelCost + a.maint + a.fixedCost : null) },
];

export const MEASURE: Record<string, MeasureDef> = Object.fromEntries(MEASURES.map((m) => [m.id, m]));

export function measuresFor(g: GroupBy): MeasureDef[] {
  return MEASURES.filter((m) => m.groups.includes(g) || (DAY_LEVEL.has(g) && m.groups.includes('weekday')));
}

/** Whether a recorded day's label passes the filters; null when a filter is set and the day has no label. */
export function labelMatches(l: DayLabel | undefined, f: LabelFilter): boolean | null {
  const any = (f.weather && f.weather !== 'all') || (f.dayKind && f.dayKind !== 'all') || (f.eventDay && f.eventDay !== 'all');
  if (!any) return true;
  if (!l) return null;
  if (f.weather && f.weather !== 'all' && weatherGroup(l) !== f.weather) return false;
  if (f.dayKind && f.dayKind !== 'all' && dayKind(l) !== f.dayKind) return false;
  if (f.eventDay && f.eventDay !== 'all' && eventDay(l) !== f.eventDay) return false;
  return true;
}

// ───────────────────────────────────────────── day selection and coverage

export interface Coverage {
  /** day numbers asked for */
  requested: number[];
  /** days with full detail */
  detailed: number[];
  /** days with compact totals only (older than the detail window) */
  summary: number[];
  /** days with no record (before recording started, or past retention) */
  missing: number[];
  /** today so far was included */
  today: boolean;
  /** first day recorded in full */
  since: number;
  /** selected days left out because they were recorded before day labels were kept (weather, kind of day, events) */
  unlabelled?: number[];
  /** recorded days left out because their weather, kind of day or events do not match the filter */
  other?: number[];
}

function selectDays(game: Game, q: { days?: DaySel; dayType?: string; weekday?: number | null }): number[] {
  const today = Math.floor(game.t / DAY);
  const sel = q.days ?? { last: 7 };
  let from: number, to: number;
  if ('last' in sel) {
    to = today - 1;
    from = today - Math.max(1, sel.last);
  } else {
    from = sel.from;
    to = Math.min(sel.to, today - 1);
  }
  const out: number[] = [];
  const sw = game.state.clock.startWeekday;
  for (let d = Math.max(0, from); d <= to; d++) {
    const wd = weekdayOf(sw, d * DAY);
    if (q.weekday !== undefined && q.weekday !== null && wd !== q.weekday) continue;
    if (q.dayType === 'weekday' && wd >= 5) continue;
    if (q.dayType === 'weekend' && wd < 5) continue;
    out.push(d);
  }
  return out;
}

function gather(game: Game, q: { days?: DaySel; dayType?: string; weekday?: number | null; includeToday?: boolean } & LabelFilter) {
  const a = game.state.analytics;
  const days = selectDays(game, q);
  const byDay = new Map<number, DayRecord>();
  for (const r of a.days) byDay.set(r.day, r);
  const sumByDay = new Map<number, DaySummary>();
  for (const s of a.summary) sumByDay.set(s.day, s);
  const detail: DayRecord[] = [], summary: DaySummary[] = [];
  const cov: Coverage = { requested: days, detailed: [], summary: [], missing: [], today: false, since: a.since };
  const keep = (d: number, l: DayLabel | undefined) => {
    const m = labelMatches(l, q);
    if (m === null) (cov.unlabelled ??= []).push(d);
    else if (!m) (cov.other ??= []).push(d);
    return m === true;
  };
  for (const d of days) {
    const r = byDay.get(d);
    if (r) {
      if (!keep(d, r.lbl)) continue;
      detail.push(r);
      cov.detailed.push(d);
      continue;
    }
    const s = sumByDay.get(d);
    if (s) {
      if (!keep(d, s.l)) continue;
      summary.push(s);
      cov.summary.push(d);
    } else cov.missing.push(d);
  }
  const today = Math.floor(game.t / DAY);
  if (q.includeToday && a.today.day === today) {
    const wd = weekdayOf(game.state.clock.startWeekday, today * DAY);
    const okDay = (q.weekday === undefined || q.weekday === null || wd === q.weekday) && !(q.dayType === 'weekday' && wd >= 5) && !(q.dayType === 'weekend' && wd < 5);
    if (okDay && labelMatches(makeDayLabel(game, today), q) === true) {
      detail.push(a.today);
      cov.today = true;
    }
  }
  return { detail, summary, cov };
}

// ───────────────────────────────────────────── aggregation

export interface Row {
  key: string;
  id: string | null;
  label: string;
  colour?: string;
  values: Record<string, number | null>;
}

export interface QueryResult {
  query: AnalyticsQuery;
  rows: Row[];
  total: Row;
  coverage: Coverage;
  /** plain-language notes about filters some measures cannot honour */
  notes: string[];
}

const hourSet = (h: [number, number] | null | undefined): boolean[] => {
  const out = new Array<boolean>(24).fill(!h);
  if (!h) return out;
  const [a, b] = h;
  for (let i = 0; i < 24; i++) out[i] = a <= b ? i >= a && i < b : i >= a || i < b;
  return out;
};

const hsum = (arr: number[] | undefined, hs: boolean[]) => {
  if (!arr) return 0;
  let s = 0;
  for (let i = 0; i < 24; i++) if (hs[i]) s += arr[i] ?? 0;
  return s;
};

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const weekdayName = (i: number) => WEEKDAYS[i] ?? '';

/** First line of an itinerary signature (`r1.s5.r3` → `r1`). */
const firstLine = (sig: string) => sig.split('.')[0];

export function aggregate(game: Game, q: AnalyticsQuery): QueryResult {
  const st = game.state;
  const names = st.analytics.names;
  const { detail, summary, cov } = gather(game, q);
  const hs = hourSet(q.hours);
  const hourly = !!q.hours;
  const lineSet = q.lines?.length ? new Set(q.lines) : null;
  const stopSet = q.stops?.length ? new Set(q.stops) : null;
  const zoneSet = q.zones?.length ? new Set(q.zones) : null;
  const vehSet = q.vehicles?.length ? new Set(q.vehicles) : null;
  const zoneOf = (s: Id) => st.stops[s]?.zone ?? null;
  const stopOk = (s: Id) => (!stopSet || stopSet.has(s)) && (!zoneSet || zoneSet.has(zoneOf(s) ?? ''));
  const lineOk = (r: Id) => !lineSet || lineSet.has(r);
  const sw = st.clock.startWeekday;
  const g = q.groupBy;
  const dayLevel = DAY_LEVEL.has(g);
  const todayNo = Math.floor(game.t / DAY);
  const labels = new Map<number, DayLabel | undefined>();
  for (const r of detail) labels.set(r.day, r.day === todayNo && r === st.analytics.today ? makeDayLabel(game, todayNo) : r.lbl);
  for (const s of summary) labels.set(s.day, s.l);
  const dayKeyOf = (day: number): string => {
    const l = labels.get(day);
    switch (g) {
      case 'day': return String(day);
      case 'weekday': return String(weekdayOf(sw, day * DAY));
      case 'weather': return weatherGroup(l) ?? 'unknown';
      case 'daykind': return dayKind(l) ?? 'unknown';
      case 'eventday': return eventDay(l) ?? 'unknown';
      default: return 'all';
    }
  };
  const groups = new Map<string, Acc>();
  const acc = (key: string) => {
    let a = groups.get(key);
    if (!a) groups.set(key, (a = emptyAcc()));
    return a;
  };
  const hourAccs = g === 'hour' ? Array.from({ length: 24 }, (_, h) => (hs[h] ? acc(String(h)) : emptyAcc())) : null;
  const notes: string[] = [];
  const useStops = g === 'stop' || g === 'zone' || ((g === 'network' || dayLevel || g === 'hour') && (!!stopSet || !!zoneSet));
  const useLines = !useStops || g === 'network' || dayLevel || g === 'hour';
  const finance = st.finance;
  // by traveller type: boardings (by time band), journeys and people left behind (whole days)
  let typeNoData = 0;
  const typeRows = (rec: DayRecord) => {
    let seen = false;
    const byBand = (k: number[] | undefined, mul = 1) => {
      if (!k) return;
      seen = true;
      for (let i = 0; i < k.length; i++) if (!hourly || bandInHours(i % BANDS.length, hs)) acc(String(Math.floor(i / BANDS.length))).boardings += k[i] * mul;
    };
    if (stopSet || zoneSet) for (const [sid, sd] of Object.entries(rec.stops)) {
      if (!stopOk(sid) || !sd.k) continue;
      seen = true;
      for (let t = 0; t < sd.k.length; t++) acc(String(t)).boardings += sd.k[t];
    }
    else for (const [rid, r] of Object.entries(rec.routes)) if (lineOk(rid)) byBand(r.k);
    if (!hourly) {
      if (!lineSet && !stopSet && !zoneSet) {
        rec.net.jk?.forEach((n, t) => (acc(String(t)).journeys += n));
        rec.net.lk?.forEach((n, t) => (acc(String(t)).leftBehind += n));
      } else if (rec.odk) {
        for (const [k, arr] of Object.entries(rec.odk)) {
          const [o, , sig] = k.split('>');
          if (!lineOk(firstLine(sig)) || !stopOk(o)) continue;
          for (let i = 0; i < arr.length; i += 2) acc(String(arr[i])).journeys += arr[i + 1];
        }
      }
    }
    if (seen) for (let t = 0; t < TYPE_COUNT; t++) acc(String(t)).seen++;
    else typeNoData++;
  };

  for (const rec of detail) {
    const dayKey = dayKeyOf(rec.day);
    if (g === 'type') { typeRows(rec); continue; }
    // lines
    if (useLines && !useStops) {
      for (const [rid, r] of Object.entries(rec.routes)) {
        if (!lineOk(rid)) continue;
        if (g === 'hour') {
          for (let h = 0; h < 24; h++) {
            if (!hs[h]) continue;
            const a = hourAccs![h];
            a.boardings += r.b[h]; a.trips += r.d[h]; a.onTime += r.o[h]; a.missed += r.m[h];
            a.deps += r.dp[h]; a.loadSum += r.lf[h]; a.delaySum += r.dl[h]; a.pkm += r.pk[h]; a.ckm += r.ck[h];
            a.fares += r.rv[h]; a.busMin += r.vm[h]; a.seen++;
          }
          continue;
        }
        const key = g === 'line' ? rid : dayKey;
        if (g !== 'line' && g !== 'network' && !dayLevel) continue;
        const a = acc(key);
        a.boardings += hsum(r.b, hs); a.trips += hsum(r.d, hs); a.onTime += hsum(r.o, hs); a.missed += hsum(r.m, hs);
        a.deps += hsum(r.dp, hs); a.loadSum += hsum(r.lf, hs); a.delaySum += hsum(r.dl, hs);
        a.pkm += hsum(r.pk, hs); a.ckm += hsum(r.ck, hs); a.fares += hsum(r.rv, hs); a.busMin += hsum(r.vm, hs);
        a.gaveUp += r.g; a.leftBehind += r.lb; a.crowded += r.cr; a.waitSum += r.ws; a.waitN += r.wn; a.transfers += r.x;
        if (g === 'line') { a.satSum += r.ss; a.satN += r.sn; a.abandoned += r.g; }
        a.seen++;
      }
    }
    // stops
    if (useStops) {
      for (const [sid, s] of Object.entries(rec.stops)) {
        if (!stopOk(sid)) continue;
        const key = g === 'stop' ? sid : g === 'zone' ? zoneOf(sid) ?? 'unknown' : dayKey;
        if (g === 'hour') {
          for (let h = 0; h < 24; h++) {
            if (!hs[h]) continue;
            const a = hourAccs![h];
            a.boardings += lineSet ? 0 : s.b[h]; a.alightings += s.a[h]; a.abandoned += s.g[h]; a.gaveUp += s.g[h]; a.seen++;
          }
          continue;
        }
        const a = acc(key);
        if (lineSet) for (const [rid, n] of Object.entries(s.bl)) { if (lineSet.has(rid)) a.boardings += n; }
        else a.boardings += hsum(s.b, hs);
        a.alightings += hsum(s.a, hs); a.gaveUp += hsum(s.g, hs); a.abandoned += hsum(s.g, hs);
        a.waitSum += s.ws; a.waitN += s.wn; a.waitMax = Math.max(a.waitMax, s.wx); a.transfers += s.x; a.leftBehind += s.lb;
        a.fares += s.rv;
        a.seen++;
      }
    }
    // vehicles
    if (g === 'vehicle' || ((g === 'network' || dayLevel) && !useStops && !lineSet)) {
      for (const [vid, v] of Object.entries(rec.veh)) {
        if (vehSet && !vehSet.has(vid)) continue;
        if (g !== 'vehicle' && vehSet) continue;
        const a = acc(g === 'vehicle' ? vid : dayKey);
        a.svMin += v.sv; a.lyMin += v.ly; a.dhMin += v.dh; a.pkMin += v.pk; a.mtMin += v.mt; a.bkMin += v.bk;
        a.km += v.km; a.maint += v.ms; a.vehDays++;
        const m = MODEL[v.mdl];
        const staffed = v.sv + v.ly + v.dh + v.bk;
        a.driverCost += (staffed * ECON.driverPerHour) / 60;
        if (m) a.fuelCost += v.km * m.energyPerKm * (m.electric ? ECON.electricPrice : ECON.fuelPrice);
        a.fixedCost += ECON.fleetFixedPerDay;
        if (g === 'vehicle') {
          a.boardings += v.b; a.pkm += v.pkm; a.fares += v.rv; a.delaySum += v.dl; a.deps += v.dn; a.seen++;
        }
      }
    }
    // journeys and satisfaction
    if (g === 'network' || dayLevel || g === 'hour') {
      if (!lineSet && !stopSet && !zoneSet) {
        if (g === 'hour') {
          for (let h = 0; h < 24; h++) if (hs[h]) { hourAccs![h].journeys += rec.net.j[h]; if (!useStops) hourAccs![h].abandoned += rec.net.ab[h]; }
        } else {
          const a = acc(dayKey);
          a.journeys += hsum(rec.net.j, hs);
          a.abandoned += hsum(rec.net.ab, hs);
          a.satSum += rec.net.ss; a.satN += rec.net.sn;
          a.journeyMin += rec.net.jt; a.journeyWait += rec.net.wt; a.journeyXf += rec.net.xf;
        }
      }
    }
    // journeys started on a line or at a stop: from origin–destination records (by time band)
    if (g === 'line' || g === 'stop' || g === 'zone' || ((lineSet || stopSet || zoneSet) && g !== 'hour' && g !== 'vehicle')) {
      for (const [k, arr] of Object.entries(rec.od)) {
        const [o, , sig] = k.split('>');
        const line = firstLine(sig);
        if (!lineOk(line) || !stopOk(o)) continue;
        const key = g === 'line' ? line : g === 'stop' ? o : g === 'zone' ? zoneOf(o) ?? 'unknown' : dayKey;
        const a = acc(key);
        for (let i = 0; i < arr.length; i += 5) {
          if (hourly && !bandInHours(arr[i], hs)) continue;
          a.journeys += arr[i + 1];
          if (g === 'line' || g === 'stop' || g === 'zone') continue;
          a.abandoned += arr[i + 2];
        }
      }
    }
  }

  // older days: compact totals (counts only)
  if (summary.length && !hourly && (g === 'network' || g === 'line' || g === 'stop' || g === 'zone' || dayLevel)) {
    for (const s of summary) {
      const dayKey = dayKeyOf(s.day);
      if (!useStops) {
        for (const [rid, r] of Object.entries(s.r)) {
          if (!lineOk(rid)) continue;
          const a = acc(g === 'line' ? rid : dayKey);
          a.boardings += r[0]; a.trips += r[1]; a.onTime += r[2]; a.missed += r[3]; a.pkm += r[4]; a.ckm += r[5]; a.seen++;
        }
      } else {
        for (const [sid, x] of Object.entries(s.s)) {
          if (!stopOk(sid)) continue;
          const a = acc(g === 'stop' ? sid : g === 'zone' ? zoneOf(sid) ?? 'unknown' : dayKey);
          a.boardings += x[0]; a.alightings += x[1]; a.gaveUp += x[2]; a.seen++;
        }
      }
      if (!lineSet && !stopSet && !zoneSet && g !== 'line' && g !== 'stop' && g !== 'zone') {
        const a = acc(dayKey);
        a.journeys += s.n[0]; a.abandoned += s.n[1]; a.satSum += s.n[2]; a.satN += s.n[3];
      }
    }
    notes.push(`${summary.length} older day${summary.length > 1 ? 's are' : ' is'} kept as daily totals only: waits, loads, delays and fares come from the last ${cov.detailed.length} detailed days.`);
  }

  // money from the ledger (whole days only)
  if (!hourly && (g === 'line' || g === 'network' || dayLevel) && !useStops) {
    const ledgerDays = [...cov.detailed, ...cov.summary, ...(cov.today ? [Math.floor(game.t / DAY)] : [])];
    for (const d of ledgerDays) {
      const dayKey = dayKeyOf(d);
      if (g === 'line' || lineSet) {
        const rd = finance.routeDaily[d];
        if (!rd) continue;
        for (const [rid, x] of Object.entries(rd)) {
          if (!lineOk(rid)) continue;
          const a = acc(g === 'line' ? rid : dayKey);
          a.cost = (a.cost ?? 0) + x.cost;
        }
      } else {
        const fd = finance.daily[d];
        if (!fd) continue;
        let cost = 0;
        for (const [cat, v] of Object.entries(fd)) if (['driver', 'fuel', 'maintenance', 'fleet_fixed', 'depot', 'stops', 'interest'].includes(cat)) cost -= v ?? 0;
        const a = acc(dayKey);
        a.cost = (a.cost ?? 0) + cost;
      }
    }
    // fares on summary days come from the ledger too
    for (const d of cov.summary) {
      const dayKey = dayKeyOf(d);
      if (g === 'line' || lineSet) {
        for (const [rid, x] of Object.entries(finance.routeDaily[d] ?? {})) if (lineOk(rid)) acc(g === 'line' ? rid : dayKey).fares += x.rev;
      } else acc(dayKey).fares += finance.daily[d]?.fares ?? 0;
    }
  }
  if (hourly && g !== 'type') notes.push('Costs, waits, satisfaction, crowding and bus activity are recorded per day, so they are left out when you pick hours.');
  if (g === 'type') {
    if (hourly) notes.push('By traveller type, boardings are recorded by time band (the bands that overlap the hours you picked count in full); journeys and people left behind are whole-day figures and are left out.');
    if (summary.length) notes.push(`${summary.length} older day${summary.length > 1 ? 's have' : ' has'} no traveller types (only the last ${cov.detailed.length} days keep them).`);
    if (typeNoData) notes.push(`${typeNoData} day${typeNoData > 1 ? 's were' : ' was'} recorded before traveller types were kept.`);
    if (stopSet || zoneSet) notes.push('At stops, boardings by type are whole-day figures.');
  }
  if (cov.unlabelled?.length) notes.push(`${cov.unlabelled.length} selected day${cov.unlabelled.length > 1 ? 's were' : ' was'} recorded before the weather, kind of day and events were kept with each day, so ${cov.unlabelled.length > 1 ? 'they are' : 'it is'} left out.`);
  if (lineSet && (g === 'stop' || g === 'zone')) notes.push('With a line selected, stop boardings count that line only; alightings and waits include every line.');

  // rows
  const ndays = cov.detailed.length + cov.summary.length + (cov.today ? 1 : 0);
  const defs = measuresFor(g);
  const values = (a: Acc) => {
    const out: Record<string, number | null> = {};
    for (const m of defs) out[m.id] = hourly && !m.hourly ? null : m.calc(a, ndays);
    return out;
  };
  const rows: Row[] = [];
  const zone = (id: string) => game.geo.zone(id)?.name ?? id;
  const wantKeys = (): string[] => {
    // entities the player asked for show up even with no data (as zero / no data)
    if (g === 'line' && lineSet) return [...lineSet];
    if (g === 'stop' && stopSet) return [...stopSet];
    if (g === 'vehicle' && vehSet) return [...vehSet];
    if (g === 'hour') return Array.from({ length: 24 }, (_, h) => String(h)).filter((h) => hs[+h]);
    return [];
  };
  for (const k of wantKeys()) acc(k);
  if (g === 'network' && !groups.size) acc('all');
  for (const [key, a] of groups) {
    let label = key, colour: string | undefined, id: string | null = key;
    switch (g) {
      case 'line': { const r = st.routes[key]; const n = names.r[key]; label = r ? `Line ${r.number}` : n ? `Line ${n.n} (removed)` : key; colour = r?.colour ?? n?.c; break; }
      case 'stop': label = st.stops[key]?.name ?? (names.s[key] ? `${names.s[key]} (removed)` : key); break;
      case 'vehicle': label = st.vehicles[key]?.fleetNo ?? (names.v[key] ? `${names.v[key]} (sold)` : key); break;
      case 'zone': label = zone(key); break;
      case 'day': label = `Day ${+key + 1} · ${weekdayName(weekdayOf(sw, +key * DAY)).slice(0, 3)}`; break;
      case 'hour': label = `${String(key).padStart(2, '0')}:00`; break;
      case 'weekday': label = weekdayName(+key); break;
      case 'network': label = 'Network'; id = null; break;
      case 'weather': label = WEATHER_GROUPS.find((x) => x.id === key)?.label ?? 'Weather not recorded'; break;
      case 'daykind': label = DAY_KINDS.find((x) => x.id === key)?.label ?? 'Not recorded'; break;
      case 'eventday': label = EVENT_DAYS.find((x) => x.id === key)?.label ?? 'Not recorded'; break;
      case 'type': label = TRAVELLERS[+key]?.label ?? key; break;
    }
    rows.push({ key, id, label, colour, values: values(a) });
  }
  const ORDER: Partial<Record<GroupBy, string[]>> = { weather: WEATHER_GROUPS.map((x) => x.id), daykind: DAY_KINDS.map((x) => x.id), eventday: EVENT_DAYS.map((x) => x.id) };
  const order = ORDER[g];
  if (g === 'day' || g === 'hour' || g === 'weekday') rows.sort((a, b) => +a.key - +b.key);
  else if (order) rows.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
  else if (g === 'type') rows.sort((a, b) => (b.values.boardings ?? 0) - (a.values.boardings ?? 0) || +a.key - +b.key);
  else rows.sort((a, b) => (b.values.boardings ?? 0) - (a.values.boardings ?? 0) || a.label.localeCompare(b.label));
  const tot = emptyAcc();
  for (const a of groups.values()) merge(tot, a);
  // the network total of per-line journeys double counts nothing (each journey starts on one line)
  const total: Row = { key: 'total', id: null, label: 'Total', values: values(tot) };
  if (!cov.detailed.length && !cov.summary.length && !cov.today) notes.unshift('No recorded days match this selection yet.');
  else if (cov.missing.length) notes.push(`${cov.missing.length} selected day${cov.missing.length > 1 ? 's were' : ' was'} not recorded (before recording started, or past the ${120}-day history).`);
  return { query: q, rows, total, coverage: cov, notes };
}

function bandInHours(band: number, hs: boolean[]): boolean {
  const b = BANDS[band];
  if (!b) return false;
  for (let h = b.from; h < b.to; h++) if (hs[h]) return true;
  return false;
}

// ───────────────────────────────────────────── custom metrics

export interface CustomMetric {
  id: string;
  name: string;
  /** expression over measure ids, e.g. `revenue / busHours` */
  expr: string;
  unit: Unit;
  decimals?: number;
  better?: 'higher' | 'lower' | 'none';
}

export function metricValue(m: CustomMetric, values: Record<string, number | null>): number | null {
  try {
    const v = compile(m.expr).run(values as Record<string, EValue>);
    return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : null;
  } catch {
    return null;
  }
}

/** A saved analysis: a table (one query), a comparison of two periods, or journeys (OD). */
export interface SavedReport {
  id: string;
  name: string;
  kind: 'table' | 'compare' | 'od';
  query?: AnalyticsQuery;
  /** the second period of a comparison (same grouping) */
  compare?: AnalyticsQuery;
  od?: OdQuery;
  /** measure ids and custom metric ids shown as columns */
  columns: string[];
  created: number;
}

/** Measure ids a custom metric may use. */
export const METRIC_VARIABLES = MEASURES.map((m) => m.id);

// ───────────────────────────────────────────── origin–destination

export interface OdQuery extends LabelFilter {
  days?: DaySel;
  includeToday?: boolean;
  dayType?: 'all' | 'weekday' | 'weekend';
  weekday?: number | null;
  /** only journeys of one traveller type (index into TRAVELLERS); counts completed journeys only */
  type?: number | null;
  /** time bands (see BANDS) of the journey start; empty = all */
  bands?: number[];
  /** stop-to-stop, or area-to-area */
  level: 'stop' | 'zone';
  /** journeys using any of these lines */
  lines?: Id[];
  /** only journeys from / to this stop or area (by level) */
  origin?: string | null;
  destination?: string | null;
  /** journeys touching any of these stops */
  stops?: Id[];
  limit?: number;
}

export interface OdFlow {
  key: string;
  o: string;
  d: string;
  oLabel: string;
  dLabel: string;
  journeys: number;
  abandoned: number;
  /** average minutes, completed journeys */
  journeyMin: number | null;
  waitMin: number | null;
  /** completed journeys that changed bus */
  transfers: number;
  itineraries: { sig: string; label: string; journeys: number }[];
}

export interface OdResult {
  flows: OdFlow[];
  /** totals by origin and destination (at the query level) */
  origins: { id: string; label: string; journeys: number }[];
  destinations: { id: string; label: string; journeys: number }[];
  total: { journeys: number; abandoned: number; pairs: number };
  coverage: Coverage;
  notes: string[];
}

export function itineraryLabel(game: Game, sig: string): string {
  const st = game.state, names = st.analytics.names;
  const parts = sig.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i % 2 === 0) {
      const r = st.routes[p];
      out.push(`Line ${r?.number ?? names.r[p]?.n ?? '?'}`);
    } else out.push(`change at ${st.stops[p]?.name ?? names.s[p] ?? 'a removed stop'}`);
  }
  return out.join(' → ');
}

export function odMatrix(game: Game, q: OdQuery): OdResult {
  const st = game.state, names = st.analytics.names;
  const { detail, summary, cov } = gather(game, q);
  const bands = q.bands?.length ? new Set(q.bands) : null;
  const lineSet = q.lines?.length ? new Set(q.lines) : null;
  const stopSet = q.stops?.length ? new Set(q.stops) : null;
  const typeOn = q.type !== undefined && q.type !== null;
  const zoneOf = (s: Id) => st.stops[s]?.zone ?? 'unknown';
  const keyOf = (s: Id) => (q.level === 'zone' ? zoneOf(s) : s);
  const flows = new Map<string, OdFlow & { jt: number; wt: number; its: Map<string, number> }>();
  const label = (id: string) => (q.level === 'zone' ? game.geo.zone(id)?.name ?? id : st.stops[id]?.name ?? names.s[id] ?? id);
  for (const rec of detail) {
    for (const [k, arr] of Object.entries(rec.od)) {
      const [o, d, sig] = k.split('>');
      const parts = sig.split('.');
      if (lineSet && !parts.some((p, i) => i % 2 === 0 && lineSet.has(p))) continue;
      if (stopSet && !stopSet.has(o) && !stopSet.has(d)) continue;
      const ko = keyOf(o), kd = keyOf(d);
      if (q.origin && ko !== q.origin) continue;
      if (q.destination && kd !== q.destination) continue;
      if (q.level === 'zone' && ko === kd && !q.origin) {
        // journeys within one area still count (shown as a loop) but only when asked for
      }
      let jn = 0, ab = 0, jt = 0, wt = 0;
      for (let i = 0; i < arr.length; i += 5) {
        if (bands && !bands.has(arr[i])) continue;
        jn += arr[i + 1]; ab += arr[i + 2]; jt += arr[i + 3]; wt += arr[i + 4];
      }
      if (typeOn) {
        // the type's share of the pair's completed journeys (types are kept per pair, not per band)
        const tk = rec.odk?.[k];
        let all = 0, mine = 0;
        if (tk) for (let i = 0; i < tk.length; i += 2) { all += tk[i + 1]; if (tk[i] === q.type) mine += tk[i + 1]; }
        const share = all > 0 ? mine / all : 0;
        jn *= share; jt *= share; wt *= share; ab = 0;
      }
      if (!jn && !ab) continue;
      const fk = `${ko}>${kd}`;
      let f = flows.get(fk);
      if (!f) flows.set(fk, (f = { key: fk, o: ko, d: kd, oLabel: label(ko), dLabel: label(kd), journeys: 0, abandoned: 0, journeyMin: null, waitMin: null, transfers: 0, itineraries: [], jt: 0, wt: 0, its: new Map() }));
      f.journeys += jn; f.abandoned += ab; f.jt += jt; f.wt += wt;
      if (parts.length > 1) f.transfers += jn;
      f.its.set(sig, (f.its.get(sig) ?? 0) + jn);
    }
  }
  const out: OdFlow[] = [];
  const ot = new Map<string, number>(), dt = new Map<string, number>();
  let tj = 0, ta = 0;
  for (const f of flows.values()) {
    f.journeyMin = f.journeys ? f.jt / f.journeys : null;
    f.waitMin = f.journeys + f.abandoned ? f.wt / (f.journeys + f.abandoned) : null;
    f.itineraries = [...f.its].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([sig, n]) => ({ sig, label: itineraryLabel(game, sig), journeys: n }));
    tj += f.journeys; ta += f.abandoned;
    ot.set(f.o, (ot.get(f.o) ?? 0) + f.journeys);
    dt.set(f.d, (dt.get(f.d) ?? 0) + f.journeys);
    const { jt: _a, wt: _b, its: _c, ...flow } = f;
    out.push(flow);
  }
  out.sort((a, b) => b.journeys - a.journeys || b.abandoned - a.abandoned);
  const notes: string[] = [];
  if (summary.length) notes.push(`Journey detail is kept for ${cov.detailed.length} days; ${summary.length} older selected day${summary.length > 1 ? 's are' : ' is'} not included.`);
  if (!detail.length) notes.push('No recorded journeys match this selection yet.');
  if (typeOn) notes.push(`Only ${TRAVELLERS[q.type!]?.label.toLowerCase() ?? 'that type'}: completed journeys, rounded; who gave up is not kept by type.`);
  if (cov.unlabelled?.length) notes.push(`${cov.unlabelled.length} selected day${cov.unlabelled.length > 1 ? 's were' : ' was'} recorded before the weather, kind of day and events were kept with each day, so ${cov.unlabelled.length > 1 ? 'they are' : 'it is'} left out.`);
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([id, journeys]) => ({ id, label: label(id), journeys }));
  return {
    flows: q.limit ? out.slice(0, q.limit) : out,
    origins: top(ot),
    destinations: top(dt),
    total: { journeys: tj, abandoned: ta, pairs: out.length },
    coverage: cov,
    notes,
  };
}

// ───────────────────────────────────────────── estimated demand (the model, not observations)

/** Areas (operating areas), or places with their own zone (stations, hospitals, campuses…) and the areas they link to. */
export type DemandLevel = 'zone' | 'place';

export interface DemandFlow {
  o: string;
  d: string;
  oLabel: string;
  dLabel: string;
  /** where the map arc starts and ends: a place's entrance, or the middle of your stops in an area */
  oAt: LngLat | null;
  dAt: LngLat | null;
  /** modelled trips per day by all modes, in this direction */
  trips: number;
  /** the same by mode, in MODES order: walk, bike, car, taxi, your network, existing transit */
  modes: number[];
  /** your network links at least part of it at some hour today */
  served: boolean;
  /** trips with no link on your network: no stop within a walk of one end, or no line between the stops */
  noStop: number;
  noLink: number;
}

export interface DemandEstimate {
  flows: DemandFlow[];
  total: { trips: number; network: number; unserved: number };
}

const estimates = new WeakMap<Game, { key: string; est: DayEstimate | null }>();

/** The model's day estimate, kept until the network, day, fare or reputation changes. */
function dayEstimate(game: Game): DayEstimate | null {
  const st = game.state;
  const key = `${game.rev}|${Math.floor(game.t / DAY)}|${st.company.fare}|${Math.round(st.company.reputation)}|${st.territory.owned.length}`;
  const hit = estimates.get(game);
  if (hit && hit.key === key) return hit.est;
  const owned = new Set(st.territory.owned);
  const dm = game.demand;
  const zs = dm.activity.ensureZones(game);
  const est = dm.estimateDay(game, (z) => owned.has(zs.list[z].area));
  estimates.set(game, { key, est });
  return est;
}

/**
 * Estimated daily travel demand by mode (walk, bike, car, taxi, your network) from the City
 * Activity Engine, for trips that start or end in your territory. It is an estimate, not an
 * observation. `view: 'unserved'` keeps only the trips your network cannot carry at any hour
 * today: potential, with no passengers and no fares.
 */
export function estimatedDemand(game: Game, opts: { level: DemandLevel; view?: 'all' | 'unserved'; origin?: string | null; destination?: string | null; limit?: number }): DemandEstimate {
  const empty: DemandEstimate = { flows: [], total: { trips: 0, network: 0, unserved: 0 } };
  const est = dayEstimate(game);
  if (!est) return empty;
  const am = game.demand.activity;
  const zs = am.zones!;
  const st = game.state;
  const isPlace = (z: number) => zs.list[z].kind === 'place' || zs.list[z].kind === 'beyond';
  const keyOf = (z: number) => (opts.level === 'place' && isPlace(z)) || !zs.list[z].area ? zs.list[z].id : zs.list[z].area;
  const areaAt = new Map<string, LngLat | null>();
  const where = (z: number): LngLat | null => {
    const zone = zs.list[z];
    if (isPlace(z) && keyOf(z) === zone.id) return zone.lngLat;
    let at = areaAt.get(zone.area);
    if (at === undefined) {
      let x = 0, y = 0, n = 0;
      for (const s of Object.values(st.stops)) {
        if (s.zone !== zone.area) continue;
        x += s.lngLat[0];
        y += s.lngLat[1];
        n++;
      }
      at = n ? [x / n, y / n] : game.geo.zone(zone.area)?.centroid ?? null;
      areaAt.set(zone.area, at);
    }
    return at;
  };
  const label = (z: number) => (keyOf(z) === zs.list[z].id ? zs.list[z].name : game.geo.zone(zs.list[z].area)?.name ?? zs.list[z].area);
  const out = new Map<string, DemandFlow>();
  const total = { trips: 0, network: 0, unserved: 0 };
  for (const [pk, m] of est.trips) {
    const i = Math.floor(pk / est.Z), j = pk % est.Z;
    if (opts.level === 'place' && !isPlace(i) && !isPlace(j)) continue;
    const ko = keyOf(i), kd = keyOf(j);
    if (opts.origin && ko !== opts.origin) continue;
    if (opts.destination && kd !== opts.destination) continue;
    const served = est.served.has(pk);
    if (opts.view === 'unserved' && served) continue;
    let sum = 0;
    for (let x = 0; x < m.length; x++) sum += Math.max(0, m[x]);
    if (!(sum > 0)) continue;
    total.trips += sum;
    total.network += Math.max(0, m[4]);
    if (!served) total.unserved += sum;
    const fk = `${ko}>${kd}`;
    let f = out.get(fk);
    if (!f) out.set(fk, (f = { o: ko, d: kd, oLabel: label(i), dLabel: label(j), oAt: where(i), dAt: where(j), trips: 0, modes: [0, 0, 0, 0, 0, 0], served: false, noStop: 0, noLink: 0 }));
    f.trips += sum;
    for (let x = 0; x < m.length; x++) f.modes[x] += Math.max(0, m[x]);
    if (served) f.served = true;
    else if (am.access[i]?.length && am.access[j]?.length) f.noLink += sum;
    else f.noStop += sum;
  }
  const flows = [...out.values()].sort((a, b) => b.trips - a.trips || (a.o + a.d).localeCompare(b.o + b.d));
  return { flows: opts.limit ? flows.slice(0, opts.limit) : flows, total };
}

export interface PlaceTravel {
  /** modelled trips a day to and from the place, from and to your areas */
  trips: number;
  /** by mode, in MODES order: walk, bike, car, taxi, your network, existing transit */
  modes: number[];
  /** your network links it at some hour today */
  served: boolean;
}

const placeSums = new WeakMap<DayEstimate, Map<number, PlaceTravel>>();

/**
 * How people travel to and from a place, from the model's day estimate (the place card). Null when
 * the place has no zone of its own: its trips are counted with the area around it.
 */
export function placeTravel(game: Game, placeId: string): PlaceTravel | null {
  const est = dayEstimate(game);
  const zs = game.demand.activity.zones;
  if (!est || !zs) return null;
  let sums = placeSums.get(est);
  if (!sums) {
    sums = new Map();
    for (const [pk, m] of est.trips) {
      const i = Math.floor(pk / est.Z), j = pk % est.Z;
      for (const z of i === j ? [i] : [i, j]) {
        if (zs.list[z].kind !== 'place' && zs.list[z].kind !== 'beyond') continue;
        let t = sums.get(z);
        if (!t) sums.set(z, (t = { trips: 0, modes: [0, 0, 0, 0, 0, 0], served: false }));
        for (let x = 0; x < m.length; x++) {
          const v = Math.max(0, m[x]);
          t.modes[x] += v;
          t.trips += v;
        }
        if (est.served.has(pk)) t.served = true;
      }
    }
    placeSums.set(est, sums);
  }
  const z = zs.list.findIndex((x) => x.id === `p:${placeId}`);
  return z >= 0 ? sums.get(z) ?? { trips: 0, modes: [0, 0, 0, 0, 0, 0], served: false } : null;
}

// ───────────────────────────────────────────── place timing (plan 13: "When it's busy")

export interface PlaceDay {
  /** modelled trips to and from the place by the hour they set off, today, all modes */
  hours: number[];
  total: number;
}

const placeDays = new WeakMap<Game, { key: string; out: Map<string, PlaceDay | null> }>();

/** When a place with a zone of its own is busy today (the model's tours, its profile and the calendar). */
export function placeDay(game: Game, placeId: string): PlaceDay | null {
  const am = game.demand.activity;
  const zs = am.ensureZones(game);
  const m = am.tours;
  if (!m) return null;
  const d = Math.floor(game.t / DAY);
  const key = `${zs.key}|${d}`;
  let c = placeDays.get(game);
  if (!c || c.key !== key) placeDays.set(game, (c = { key, out: new Map() }));
  if (c.out.has(placeId)) return c.out.get(placeId)!;
  const z = zs.list.findIndex((x) => x.place === placeId);
  let res: PlaceDay | null = null;
  if (z >= 0) {
    const timing = am.timing(game, d * DAY + 12 * 3600);
    const K = KIND_COUNT;
    const hours = new Array<number>(24).fill(0);
    for (let e = 0; e < m.tours.length; e++) {
      if (m.o[e] !== z && m.d[e] !== z) continue;
      const k = m.k[e];
      const pk = zs.profile[KINDS[k].toHome ? m.o[e] : m.d[e]] * K + k;
      const daily = m.tours[e] * timing.factor[pk];
      for (let h = 0; h < 24; h++) hours[h] += daily * timing.share[pk * 24 + h];
    }
    const total = hours.reduce((a, b) => a + b, 0);
    res = total > 0 ? { hours, total } : null;
  }
  c.out.set(placeId, res);
  return res;
}

export interface StationLink {
  name: string;
  place: string;
  mode: TransitMode;
  /** metres along the track, and assumed minutes on board */
  m: number;
  min: number;
}

/** A station's links on the city's existing transit network, and the modes switched off there (with why). */
export function stationLinks(game: Game, placeId: string): { links: StationLink[]; off: { mode: TransitMode; reason: string }[] } | null {
  const net = game.region.transit;
  const p = game.geo.places.byId.get(placeId);
  if (!net || !p?.modes) return null;
  const s = net.stations.findIndex((x) => x.place === placeId);
  const links: StationLink[] = [];
  if (s >= 0)
    for (const l of net.links) {
      if (l.a !== s && l.b !== s) continue;
      if (!net.modes[l.mode]?.ok) continue;
      if (l.mode === 'ferry' && l.m < MIN_FERRY_M) continue; // piers side by side
      const o = net.stations[l.a === s ? l.b : l.a];
      const kmh = TRANSIT_SERVICE[l.mode]?.kmh ?? 20;
      links.push({ name: o.name, place: o.place, mode: l.mode, m: l.m, min: (l.m / 1000 / kmh) * 60 });
    }
  links.sort((a, b) => a.mode.localeCompare(b.mode) || a.m - b.m || a.name.localeCompare(b.name));
  // two stations with the same name (a pier mapped twice): keep the nearer
  const seen = new Set<string>();
  for (let i = 0; i < links.length; i++) {
    const k = `${links[i].mode}|${links[i].name}`;
    if (seen.has(k)) links.splice(i--, 1);
    else seen.add(k);
  }
  const off = p.modes.filter((m) => m !== 'bus' && net.modes[m] && !net.modes[m]!.ok).map((m) => ({ mode: m, reason: net.modes[m]!.reason ?? 'Its tracks are not complete on the map.' }));
  return { links, off };
}
