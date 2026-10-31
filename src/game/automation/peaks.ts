// Peak hours for automation: when each line is busiest, from its timetable (how many buses it
// needs through the day) or from the riders recorded over the last week, and which buses can be
// lent between lines whose peaks fall at different times. Times are minutes from midnight of the
// service day's date, as in timetable bands (over 1440 runs past midnight).

import type { Game } from '../engine.ts';
import { TripState, type Id, type Vehicle } from '../types.ts';
import { DAY } from '../content.ts';
import { minutesLabel, serviceDayOf, serviceDayWeekend, weekdayOf } from '../time.ts';
import { recordedDays } from '../analytics/character.ts';
import { extraOption, vehicleNode, workEnds } from '../vehicles.ts';
import { busesAvailable } from './watch.ts';

export type PeakSource = 'timetable' | 'riders';

export interface NeedStep { from: number; to: number; need: number }

export interface Peak {
  line: Id;
  source: PeakSource;
  /** minutes from midnight of the service day's date */
  from: number;
  to: number;
  /** most buses the timetable needs during the peak */
  need: number;
  /** average boardings per hour during the peak (riders peaks; null for timetable peaks) */
  riders: number | null;
}

export const PEAK_SOURCES = [
  { value: 'timetable', label: 'Timetable: when it needs the most buses' },
  { value: 'riders', label: 'Riders: its busiest hours over the last week' },
];

/** The service day's first hour (03:00) as an index into hourly records. */
const FIRST_HOUR = 3;
/** Clock hours in service-day order, 03:00 … 02:00. */
const SERVICE_HOURS = Array.from({ length: 24 }, (_, i) => (FIRST_HOUR + i) % 24);
const hourToMin = (h: number) => (h < FIRST_HOUR ? h + 24 : h) * 60;

/** Minutes now, on the same scale as timetable bands. */
export function nowMinute(game: Game): number {
  return (game.t - serviceDayOf(game.t) * DAY) / 60;
}

export const periodLabel = (from: number, to: number) => `${minutesLabel(from)}–${minutesLabel(to)}`;

// Cached per game minute (timetables and fleets can change between minutes) and per day (history).
const cache = new WeakMap<Game, { minute: number; steps: Map<Id, NeedStep[]>; day: number; riders: Map<string, RidersByHour> }>();
function store(game: Game) {
  const minute = Math.floor(game.t / 60), day = Math.floor(game.t / DAY);
  let c = cache.get(game);
  if (!c) cache.set(game, (c = { minute, steps: new Map(), day, riders: new Map() }));
  if (c.minute !== minute) { c.minute = minute; c.steps.clear(); }
  if (c.day !== day) { c.day = day; c.riders.clear(); }
  return c;
}

/** Today's timetable as steps of buses needed (neighbouring bands with the same need merged). */
export function needSteps(game: Game, route: Id): NeedStep[] {
  const c = store(game);
  const hit = c.steps.get(route);
  if (hit) return hit;
  const out: NeedStep[] = [];
  const r = game.state.routes[route];
  const req = r && !r.suspended ? game.requirement(route) : null;
  for (const b of [...(req?.bands ?? [])].sort((x, y) => x.band.from - y.band.from)) {
    const last = out[out.length - 1];
    if (last && last.need === b.need && last.to === b.band.from) last.to = b.band.to;
    else out.push({ from: b.band.from, to: b.band.to, need: b.need });
  }
  c.steps.set(route, out);
  return out;
}

export const needAt = (steps: NeedStep[], m: number) => steps.find((s) => m >= s.from && m < s.to)?.need ?? 0;

/** Most buses needed at any moment between `from` and `to`. */
export function needOver(steps: NeedStep[], from: number, to: number): number {
  let n = 0;
  for (const s of steps) if (s.from < to && s.to > from) n = Math.max(n, s.need);
  return n;
}

/**
 * Timetable peaks: stretches that need more buses than the stretches either side of them (the
 * service day's start and end count as 0), widened over neighbours at least halfway up from the
 * level the peak rises from. A stretch covering more than half the service day is the
 * day's normal level, not a peak.
 */
export function timetablePeaks(game: Game, route: Id): Peak[] {
  const steps = needSteps(game, route).filter((s) => s.need > 0);
  if (steps.length < 2) return [];
  const span = steps[steps.length - 1].to - steps[0].from;
  const joined = (i: number, j: number) => steps[i] && steps[j] && (i < j ? steps[i].to === steps[j].from : steps[j].to === steps[i].from);
  const level = (i: number) => (i >= 0 && i < steps.length ? steps[i].need : 0);
  const out: Peak[] = [];
  for (let i = 0; i < steps.length; i++) {
    const top = steps[i].need;
    const left = joined(i - 1, i) ? level(i - 1) : 0, right = joined(i, i + 1) ? level(i + 1) : 0;
    if (top <= left || top <= right) continue;
    // the valley on each side: walk down while the need keeps falling
    let l = i, valleyL = top;
    while (l > 0 && joined(l - 1, l) && steps[l - 1].need < steps[l].need) { l--; valleyL = steps[l].need; }
    let r = i, valleyR = top;
    while (r < steps.length - 1 && joined(r, r + 1) && steps[r + 1].need < steps[r].need) { r++; valleyR = steps[r].need; }
    const bar = (top + Math.max(i === l ? 0 : valleyL, i === r ? 0 : valleyR)) / 2;
    let from = i, to = i;
    while (from > l && steps[from - 1].need >= bar) from--;
    while (to < r && steps[to + 1].need >= bar) to++;
    const p = { line: route, source: 'timetable' as const, from: steps[from].from, to: steps[to].to, need: top, riders: null };
    if (p.to - p.from > span / 2) continue;
    out.push(p);
  }
  return out;
}

export interface RidersByHour {
  /** average boardings per recorded day, by clock hour 0–23 */
  hours: number[];
  /** recorded days used */
  days: number;
  /** 'weekdays', 'weekends' or 'all days' (when none of today's kind is recorded yet) */
  kind: string;
}

/** Boardings by hour on recent days of today's kind (weekday or weekend). */
export function ridersByHour(game: Game, route: Id | null): RidersByHour {
  const c = store(game);
  const key = route ?? '*';
  const hit = c.riders.get(key);
  if (hit) return hit;
  const sw = game.state.clock.startWeekday;
  const weekend = serviceDayWeekend(sw, serviceDayOf(game.t));
  const all = recordedDays(game, 21);
  const isWeekend = (d: (typeof all)[number]) => d.lbl ? !!d.lbl.weekend : weekdayOf(sw, d.day * DAY) >= 5;
  let days = all.filter((d) => isWeekend(d) === weekend).slice(weekend ? -4 : -5);
  let kind = weekend ? 'weekends' : 'weekdays';
  if (!days.length) { days = all.slice(-7); kind = 'all days'; }
  const hours = new Array<number>(24).fill(0);
  for (const d of days) {
    const rows = route ? [d.routes[route]] : Object.values(d.routes);
    for (const rd of rows) if (rd) rd.b.forEach((v, h) => { hours[h] += v; });
  }
  const res = { hours: days.length ? hours.map((v) => Math.round((v / days.length) * 10) / 10) : hours, days: days.length, kind };
  c.riders.set(key, res);
  return res;
}

/** Riders peaks: runs of hours clearly busier than the line's average hour. */
export function ridersPeaks(game: Game, route: Id): Peak[] {
  const { hours, days } = ridersByHour(game, route);
  if (!days) return [];
  const seq = SERVICE_HOURS.map((h) => ({ h, v: hours[h] }));
  const used = seq.filter((x) => x.v > 0);
  if (!used.length) return [];
  const max = Math.max(...used.map((x) => x.v));
  const avg = used.reduce((s, x) => s + x.v, 0) / used.length;
  if (max < 3 || max < avg * 1.25) return []; // too few riders, or no hour stands out
  const bar = avg + (max - avg) * 0.4;
  const steps = needSteps(game, route);
  const out: Peak[] = [];
  let run: { h: number; v: number }[] = [];
  const close = () => {
    if (!run.length) return;
    const top = Math.max(...run.map((x) => x.v));
    if (top >= max * 0.6) {
      const from = hourToMin(run[0].h), to = from + run.length * 60;
      out.push({ line: route, source: 'riders', from, to, need: needOver(steps, from, to), riders: Math.round((run.reduce((s, x) => s + x.v, 0) / run.length) * 10) / 10 });
    }
    run = [];
  };
  for (const x of seq) { if (x.v > bar) run.push(x); else close(); }
  close();
  return out;
}

export function linePeaks(game: Game, route: Id, source: PeakSource): Peak[] {
  return source === 'riders' ? ridersPeaks(game, route) : timetablePeaks(game, route);
}

/** The line's peak going on now, or the next one today (null when none is left). */
export function currentOrNextPeak(game: Game, route: Id, source: PeakSource): { peak: Peak; now: boolean } | null {
  const m = nowMinute(game);
  for (const p of linePeaks(game, route, source)) {
    if (m < p.from) return { peak: p, now: false };
    if (m < p.to) return { peak: p, now: true };
  }
  return null;
}

/** Peak hours as words: "07:00–09:00 and 16:00–18:30". */
export function peaksText(peaks: Peak[]): string {
  const ls = peaks.map((p) => periodLabel(p.from, p.to));
  return ls.length <= 1 ? (ls[0] ?? '') : `${ls.slice(0, -1).join(', ')} and ${ls[ls.length - 1]}`;
}

/** Minutes two lists of peaks overlap. */
export function overlapMinutes(a: Peak[], b: Peak[]): number {
  let n = 0;
  for (const x of a) for (const y of b) n += Math.max(0, Math.min(x.to, y.to) - Math.max(x.from, y.from));
  return n;
}

// ───────────────────────────────────────────── lending buses

/** A bus that can work: not in the workshop, broken down, being sold or already leaving its line. */
const usable = (v: Vehicle | undefined): v is Vehicle => !!v && v.status !== 'maintenance' && v.status !== 'broken' && !v.withdraw && !v.sell && !v.handover;

/** Buses a line can do without from now until `until` (its working buses beyond the most it needs). */
export function canSpare(game: Game, route: Id, until: number): number {
  const r = game.state.routes[route];
  if (!r) return 0;
  const working = busesAvailable(game, route);
  if (r.suspended) return working;
  const m = nowMinute(game);
  return Math.max(0, working - needOver(needSteps(game, route), m, Math.max(until, m + 60)));
}

/**
 * How easily a bus can leave its line: 0 parked at the depot, 1 waiting with nothing to do,
 * 2 waiting for a trip that has not started (the game gives that trip to another of the line's
 * buses), 3 driving a trip (it finishes it first). Null while it cannot leave: carrying
 * passengers between trips, or in the workshop.
 */
function leaveRank(game: Game, v: Vehicle): number | null {
  if (!usable(v)) return null;
  const tr = v.trip !== null ? game.trip(v.trip) : undefined;
  const running = !!tr && tr.state === TripState.Running;
  if (running) return 3;
  if (v.load > 0) return null;
  if (v.status === 'parked' && v.pos.kind === 'depot' && v.trip === null && v.next === null) return 0;
  if (v.status === 'layover' || v.status === 'to_route' || v.status === 'preparing' || v.status === 'parked') return v.trip === null && v.next === null ? 1 : 2;
  return null;
}

/** When a bus's next piece of work starts (its trip's departure), for choosing which to free. */
function nextDeparture(game: Game, v: Vehicle): number {
  const id = v.trip ?? v.next;
  return id !== null ? game.trip(id)?.dep ?? Infinity : Infinity;
}

/**
 * A line's buses it will not need now or until `until` (default: the next hour), at most as many
 * as it can spare: parked ones first, then idle ones, then the ones whose trips end soonest. Moved
 * "after the trips it already has", none of the line's departures is missed.
 */
export function busesNotNeeded(game: Game, route: Id, until?: number): Vehicle[] {
  const r = game.state.routes[route];
  if (!r) return [];
  const n = canSpare(game, route, until ?? nowMinute(game) + 60);
  if (!n) return [];
  const s = game.state;
  const ranked: { v: Vehicle; rank: number; dep: number }[] = [];
  for (const id of r.vehicles) {
    const v = s.vehicles[id];
    if (!v || v.route !== route) continue;
    const rank = leaveRank(game, v);
    if (rank === null) continue;
    ranked.push({ v, rank: Math.min(rank, 2), dep: workEnds(game, v) ?? nextDeparture(game, v) });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.dep - b.dep);
  return ranked.slice(0, n).map((x) => x.v);
}

export interface Loan { bus: Vehicle; from: Id | null; ready: number }

/** When a bus could be at `start` to work another line: now if free, or after the trips it has. */
function readyFor(game: Game, v: Vehicle, start: number): number {
  const o = extraOption(game, v, start, game.t);
  if (o) return o.ready;
  const end = workEnds(game, v);
  const last = game.trip((v.next ?? v.trip) as number);
  const from = last ? game.pattern(last.route, last.pat)?.path.nodes.at(-1) : undefined;
  return (end ?? game.t) + game.travelSeconds(from ?? vehicleNode(game, v).node, start);
}

/**
 * Buses that could join `route` now and stay until `until`: spares at a depot first, then buses
 * other lines will not need until then. Soonest ready first; never a bus carrying passengers.
 */
export function busesToBorrow(game: Game, route: Id, until: number, opts: { spares?: boolean; lines?: boolean } = {}): { loans: Loan[]; lenders: { line: Id; canLend: number }[] } {
  const s = game.state, t = game.t;
  const p = game.patterns.get(route)?.find((x) => x.valid);
  if (!p) return { loans: [], lenders: [] };
  const start = p.path.nodes[0];
  const loans: Loan[] = [];
  if (opts.spares !== false) {
    for (const v of Object.values(s.vehicles)) {
      if (v.route !== null || !usable(v)) continue;
      const o = extraOption(game, v, start, t);
      if (o) loans.push({ bus: v, from: null, ready: o.ready });
    }
  }
  const lenders: { line: Id; canLend: number }[] = [];
  if (opts.lines !== false) {
    for (const r of Object.values(s.routes)) {
      if (r.id === route) continue;
      const n = canSpare(game, r.id, until);
      if (!n) continue;
      lenders.push({ line: r.id, canLend: n });
      const free = busesNotNeeded(game, r.id, until).map((v) => ({ bus: v, from: r.id, ready: readyFor(game, v, start) }));
      free.sort((a, b) => a.ready - b.ready);
      loans.push(...free.slice(0, n));
    }
  }
  loans.sort((a, b) => Number(a.from !== null) - Number(b.from !== null) || a.ready - b.ready);
  lenders.sort((a, b) => b.canLend - a.canLend);
  return { loans, lenders };
}

/** A line's peak-hour figures for its record (expressions, filters). */
export function linePeakFields(game: Game, route: Id) {
  const m = nowMinute(game);
  const steps = needSteps(game, route);
  const tp = timetablePeaks(game, route);
  const next = tp.find((p) => p.from > m);
  const inPeak = tp.some((p) => m >= p.from && m < p.to);
  const rp = ridersPeaks(game, route);
  return {
    neededSoon: needOver(steps, m, m + 60),
    neededMax: steps.reduce((x, s) => Math.max(x, s.need), 0),
    spareNow: canSpare(game, route, m + 60),
    peakHours: peaksText(tp),
    inPeak,
    nextPeak: next ? minutesLabel(next.from) : '',
    nextPeakIn: next ? Math.round(next.from - m) : null,
    busiestHours: peaksText(rp),
  };
}

/** The time a peak trigger fires for this peak (absolute seconds), for `at` 'start' or 'end'. */
export function peakFireTime(game: Game, p: Peak, at: 'start' | 'end', minutes: number): number {
  const base = serviceDayOf(game.t) * DAY;
  return at === 'end' ? base + (p.to + minutes) * 60 : base + (p.from - minutes) * 60;
}

/** The event a peak trigger hands on. */
export function peakEvent(game: Game, route: Id, p: Peak, at: 'start' | 'end') {
  const r = game.state.routes[route];
  const has = busesAvailable(game, route);
  return {
    kind: 'event', source: 'peak', at, line: route, lineNumber: r?.number ?? '', lineName: r ? r.name || `Line ${r.number}` : '',
    from: minutesLabel(p.from), to: minutesLabel(p.to), period: periodLabel(p.from, p.to), need: p.need, has, riders: p.riders, peakSource: p.source,
    buses: at === 'start' ? Math.max(0, p.need - has) : canSpare(game, route, nowMinute(game) + 60),
  };
}

/** When a peak trigger fires next today (absolute seconds) and for which line and peak. */
export function nextPeakFire(game: Game, c: Record<string, unknown>): { t: number; line: Id; peak: Peak } | null {
  const at = c.at === 'end' ? 'end' : 'start';
  const mins = Math.max(0, Number(c.minutes ?? 30) || 0);
  const source: PeakSource = c.source === 'riders' ? 'riders' : 'timetable';
  const s = game.state;
  const lines = typeof c.line === 'string' && c.line && s.routes[c.line] ? [s.routes[c.line]] : Object.values(s.routes);
  let best: { t: number; line: Id; peak: Peak } | null = null;
  for (const r of lines) {
    if (r.suspended) continue;
    for (const p of linePeaks(game, r.id, source)) {
      const x = peakFireTime(game, p, at, mins);
      if (x > game.t && (!best || x < best.t)) best = { t: x, line: r.id, peak: p };
    }
  }
  return best;
}
