// Improve service: what makes passengers unhappy, and a plan of changes that would help.
//
// The plan only uses the player's own tools. It puts spare buses to work, moves buses from lines
// that can spare one to the lines that need them, buys buses when the company can afford them,
// runs each timetable as often as the line's buses allow in the hours people travel, and takes
// the shorter routes the route check finds. Nothing changes until the player applies it.
// `testPlan` plays the next hours on two copies of the company, one with the plan, and measures
// both, like the Simulation Lab.

import { Game } from './engine.ts';
import type { Band, DayPlan, GameState, Id, Timetable, Vehicle } from './types.ts';
import { requirement } from './timetable.ts';
import { DAY, HOUR, MODEL, MODELS } from './content.ts';
import { minutesLabel, serviceDayOf } from './time.ts';
import { applyFix, routeTarget, sameShape, suggestFixes, type AppliedFix, type FixPlan, type LineShape } from './diagnostics.ts';
import { unlockedModels, window as statWindow, SAT_COMPONENTS } from './progress.ts';
import { dayTotals } from './finance.ts';
import { labTotals, labMetrics, type LabMetrics } from './automation/lab.ts';
import type { DayRecord } from './analytics/types.ts';

// ───────────────────────────────────────────── tuning (assumed, see docs/improve-service.md)

/** Shortest headway the plan proposes, minutes (shorter ones bunch). */
const MIN_HEADWAY = 4;
/** spare time in a timetable the plan makes or repairs: buses that run late with more riders still make the next departure (measured: an exact fit missed 2–4 departures an hour) */
const SLACK = 0.1;
/** A departure should carry at least this many riders on average before the plan adds more of them. */
const RIDERS_PER_DEPARTURE = 10;
/** Waiting minutes a day a bus must save before the plan moves one (one bus × one rider-minute is noise). */
const MIN_GAIN = 60;
/** ...and before it buys one. */
const BUY_GAIN = 400;
const MAX_BUYS = 6;
const MAX_STEPS_MOVES = 12;
/** Money kept back when buying: at least this, and at least a week of running costs. */
const RESERVE = 60_000;
/** Days of history read for demand by hour. */
const HISTORY_DAYS = 7;

/** Expected wait for a headway, minutes: half of it, until people start timing their arrival (as in the itinerary model). */
const expWait = (h: number) => (h <= 12 ? h / 2 : 4 + h / 8);
const clampHw = (h: number) => Math.max(MIN_HEADWAY, Math.min(120, Math.round(h)));
const lineNo = (game: Game, id: Id) => `Line ${game.state.routes[id]?.number ?? '?'}`;
const int = (x: number) => Math.round(x).toLocaleString('en-GB');

// ───────────────────────────────────────────── what passengers dislike

export interface LineLook {
  route: Id;
  number: string;
  colour: string;
  kind: 'linear' | 'loop';
  /** buses on the line (not being sold) */
  buses: number;
  /** buses its timetable needs today */
  need: number;
  /** riders a day (recent days) */
  boardings: number;
  /** average wait before boarding, minutes */
  avgWait: number | null;
  gaveUp: number;
  leftBehind: number;
  missed: number;
  /** average and highest hourly load at stop departures (0–1) */
  load: number | null;
  peakLoad: number | null;
  satisfaction: number | null;
  /** today's headways, lowest and highest */
  headway: [number, number] | null;
}

export interface Cause {
  key: 'stranded' | 'wait' | 'journey' | 'crowding' | 'missed' | 'loops' | 'fare';
  title: string;
  text: string;
}

export interface Diagnosis {
  satisfaction: number | null;
  /** 0–1 per SAT_COMPONENTS */
  comp: number[];
  avgWait: number;
  journeys: number;
  abandoned: number;
  stranded: number;
  causes: Cause[];
  lines: LineLook[];
  /** what the figures cover */
  window: string;
}

interface Hist {
  /** riders by clock hour, average per day, [weekday, weekend] */
  byHour: [number[], number[]];
  days: [number, number];
  boardings: number;
  waitSum: number;
  waitN: number;
  gaveUp: number;
  leftBehind: number;
  missed: number;
  dp: number;
  lf: number;
  peakLoad: number | null;
  ss: number;
  sn: number;
  /** complete days read (0: only today so far) */
  complete: number;
}

/** The last complete days (up to a week), or today so far when there are none. */
function recentRecords(game: Game): { recs: DayRecord[]; complete: number } {
  const a = game.state.analytics;
  const today = a.today.day;
  const recs = a.days.filter((d) => d.day >= today - HISTORY_DAYS && d.day < today && !d.partial);
  return recs.length ? { recs, complete: recs.length } : { recs: [a.today], complete: 0 };
}

const weekendOf = (game: Game, rec: DayRecord) => rec.lbl?.weekend ?? game.isWeekend(rec.day * DAY + 12 * HOUR);

function history(game: Game, route: Id): Hist {
  const { recs, complete } = recentRecords(game);
  const h: Hist = { byHour: [new Array(24).fill(0), new Array(24).fill(0)], days: [0, 0], boardings: 0, waitSum: 0, waitN: 0, gaveUp: 0, leftBehind: 0, missed: 0, dp: 0, lf: 0, peakLoad: null, ss: 0, sn: 0, complete };
  const nowHour = Math.floor((game.t % DAY) / HOUR);
  for (const rec of recs) {
    const w = weekendOf(game, rec) ? 1 : 0;
    h.days[w]++;
    const r = rec.routes[route];
    if (!r) continue;
    const hours = complete ? 24 : Math.max(1, nowHour);
    for (let i = 0; i < 24; i++) h.byHour[w][i] += r.b[i] ?? 0;
    // today only: hours not reached yet take the average of those that were
    if (!complete) {
      const seen = r.b.slice(0, hours).reduce((p, q) => p + q, 0) / hours;
      for (let i = hours; i < 24; i++) h.byHour[w][i] = Math.max(h.byHour[w][i], seen * 0.5);
    }
    h.boardings += r.b.reduce((p, q) => p + q, 0);
    h.waitSum += r.ws;
    h.waitN += r.wn;
    h.gaveUp += r.g;
    h.leftBehind += r.lb;
    h.missed += r.m.reduce((p, q) => p + q, 0);
    for (let i = 0; i < 24; i++) {
      h.dp += r.dp[i] ?? 0;
      h.lf += r.lf[i] ?? 0;
      if ((r.dp[i] ?? 0) >= 2) h.peakLoad = Math.max(h.peakLoad ?? 0, r.lf[i] / r.dp[i]);
    }
    h.ss += r.ss;
    h.sn += r.sn;
  }
  for (const w of [0, 1]) if (h.days[w]) h.byHour[w] = h.byHour[w].map((x) => x / h.days[w]);
  // a day type not seen yet: assume the other's pattern, a little lighter at weekends
  if (!h.days[1] && h.days[0]) h.byHour[1] = h.byHour[0].map((x) => x * 0.75);
  if (!h.days[0] && h.days[1]) h.byHour[0] = h.byHour[1].map((x) => x / 0.75);
  return h;
}

function busesOn(game: Game, route: Id): Vehicle[] {
  return (game.state.routes[route]?.vehicles ?? []).map((id) => game.state.vehicles[id]).filter((v): v is Vehicle => !!v && !v.sell);
}

export function diagnose(game: Game): Diagnosis {
  const s = game.state;
  const w = statWindow(s, 24);
  const { recs, complete } = recentRecords(game);
  const sum = (x?: number[]) => (x ?? []).reduce((p, q) => p + q, 0);
  let stranded = 0, journeys = 0, jt = 0, daytime = 0;
  for (const rec of recs) {
    stranded += sum(rec.net.sd);
    daytime += sum(rec.net.sd?.slice(7, 20));
    journeys += sum(rec.net.j);
    jt += rec.net.jt;
  }
  const n = Math.max(1, recs.length);
  const lines: LineLook[] = [];
  for (const r of Object.values(s.routes)) {
    const h = history(game, r.id);
    const sd = serviceDayOf(game.t);
    const plan = game.dayPlan(r.id, sd).plan;
    const hws = plan.bands.map((b) => b.headway);
    lines.push({
      route: r.id, number: r.number, colour: r.colour, kind: r.kind,
      buses: busesOn(game, r.id).length,
      need: game.requirement(r.id)?.peak ?? 0,
      boardings: Math.round(h.boardings / n),
      avgWait: h.waitN ? h.waitSum / h.waitN : null,
      gaveUp: Math.round(h.gaveUp / n),
      leftBehind: Math.round(h.leftBehind / n),
      missed: Math.round(h.missed / n),
      load: h.dp ? h.lf / h.dp : null,
      peakLoad: h.peakLoad,
      satisfaction: h.sn ? h.ss / h.sn : null,
      headway: hws.length ? [Math.min(...hws), Math.max(...hws)] : null,
    });
  }
  lines.sort((a, b) => b.boardings - a.boardings);
  const causes: Cause[] = [];
  const perDayStranded = Math.round(stranded / n);
  const perDayJourneys = Math.round(journeys / n);
  if (w.satisfaction !== null) {
    if (perDayStranded > Math.max(20, 0.05 * (perDayJourneys + perDayStranded))) {
      // when: after the buses stop, or while they run (no line goes their way back)
      const when = daytime >= 0.5 * stranded
        ? `Most of them (${Math.round((100 * daytime) / Math.max(1, stranded))}%) set off home between 07:00 and 20:00, while your buses were running, but none of your lines took them back the way they came. Lines that run both ways, and lines that meet, help.`
        : 'Most of them set off home in the evening or at night, after your service had stopped. Running later in the evening helps.';
      causes.push({ key: 'stranded', title: `${int(perDayStranded)} travellers a day found no bus home`, text: `They went out on your buses and gave up on the way back, so each one scores almost nothing for waiting and journey time. ${when}` });
    }
    const typical = lines.filter((l) => l.boardings > 0 && l.headway).map((l) => l.headway![1]);
    if (w.comp[0] < 0.75) {
      const hw = typical.length ? typical.sort((a, b) => a - b)[Math.floor(typical.length / 2)] : null;
      causes.push({ key: 'wait', title: `Waiting: ${Math.round(w.comp[0] * 100)}%`, text: `People wait ${(w.avgWait).toFixed(1)} min on average${hw ? `; most lines run only every ${hw} min at their quietest` : ''}. A wait under 2 minutes scores full marks, 18 minutes scores nothing.` });
    }
    if (w.comp[1] < 0.6) {
      const avgJt = journeys ? jt / journeys : null;
      causes.push({ key: 'journey', title: `Journey time: ${Math.round(w.comp[1] * 100)}%`, text: `A journey is scored against driving the same trip, and the time includes waiting${avgJt ? ` (average ${avgJt.toFixed(0)} min door to stop)` : ''}. Shorter waits help most; then direct routes and fewer changes.` });
    }
    const lb = lines.reduce((p, l) => p + l.leftBehind, 0);
    if (lb > 50) {
      const worst = lines.filter((l) => l.leftBehind > 0).sort((a, b) => b.leftBehind - a.leftBehind)[0];
      causes.push({ key: 'crowding', title: `${int(lb)} left behind a day by full buses`, text: `Mostly on Line ${worst.number} (${int(worst.leftBehind)}). They wait for the next bus, or give up.` });
    }
    const missed = lines.reduce((p, l) => p + l.missed, 0);
    if (missed > 3) causes.push({ key: 'missed', title: `${int(missed)} departures missed a day`, text: 'A timetable that needs more buses than the line has leaves gaps; people wait twice as long.' });
    const loops = lines.filter((l) => l.kind === 'loop' && l.boardings > 0);
    if (loops.length && w.comp[1] < 0.6) causes.push({ key: 'loops', title: `${loops.length} of your lines are loops`, text: 'On a loop, people going the other way ride round the whole loop. For busy pairs of stops a two-way line is quicker.' });
    if (w.comp[4] < 0.6) causes.push({ key: 'fare', title: `Fares: ${Math.round(w.comp[4] * 100)}%`, text: 'The fare is high for many travellers. This plan does not change it; see Finances.' });
  }
  return {
    satisfaction: w.satisfaction, comp: w.comp, avgWait: w.avgWait, journeys: w.trips, abandoned: w.abandoned, stranded: perDayStranded, causes, lines,
    window: complete ? `the last ${complete} day${complete === 1 ? '' : 's'}` : 'today so far',
  };
}

// ───────────────────────────────────────────── timetables for a number of buses

interface BandLook { band: Band; cycle: number; riders: number }

/** Bands of a day plan with their round-trip time and riders (people per day travelling in the band). */
function bandLooks(game: Game, route: Id, plan: DayPlan, weekend: boolean, byHour: number[], scale: number): BandLook[] {
  const r = game.state.routes[route];
  const prof = game.profiles.get(route);
  if (!r || !prof) return [];
  const req = requirement(r, prof, weekend, plan);
  return req.bands.map(({ band, cycle }) => {
    let riders = 0;
    for (let m = band.from; m < band.to; m += 15) riders += (byHour[Math.floor((m % 1440) / 60)] ?? 0) / 4;
    return { band, cycle, riders: riders * scale };
  });
}

/** Headway for a band run by `n` buses: as often as they allow where people travel, never less often than now unless they cannot keep up. */
function targetHeadway(b: BandLook, n: number): number {
  if (n <= 0 || b.cycle <= 0) return b.band.headway;
  // a timetable that already works stays; a new or repaired one keeps some time to catch up
  const fleetMin = Math.ceil((b.cycle * (1 + SLACK)) / n - 1e-6);
  if (b.band.headway < Math.ceil(b.cycle / n - 1e-6)) return clampHw(fleetMin);
  const hours = (b.band.to - b.band.from) / 60;
  const perHour = hours > 0 ? b.riders / hours : 0;
  const byDemand = perHour > 0 ? (60 * RIDERS_PER_DEPARTURE) / perHour : 120;
  return clampHw(Math.min(b.band.headway, Math.max(fleetMin, Math.ceil(byDemand), MIN_HEADWAY)));
}

/** Waiting minutes a day for the band at a headway (missed departures: no better than the buses can run). */
const bandWait = (b: BandLook, h: number) => b.riders * expWait(h);

interface LineModel {
  route: Id;
  n: number;
  /** [weekday, weekend] */
  looks: [BandLook[], BandLook[]];
  /** the line runs an enabled service plan: it is not a donor */
  plans: boolean;
  hist: Hist;
}

/** Waiting minutes on an average day (5 weekdays, 2 weekend days), headway by band. */
function dayWait(m: LineModel, headway: (b: BandLook) => number): number {
  let total = 0;
  m.looks.forEach((looks, w) => {
    for (const b of looks) total += (w ? 2 / 7 : 5 / 7) * bandWait(b, headway(b));
  });
  return total;
}

/** ...as the line runs now (a timetable its buses cannot keep runs no more often than they can). */
const waitNow = (m: LineModel) => dayWait(m, (b) => (b.cycle > 0 && m.n ? Math.max(b.band.headway, Math.ceil(b.cycle / m.n - 1e-6)) : b.band.headway));

/** ...with `n` buses and the timetable fitted to them. */
const waitWith = (m: LineModel, n: number) => dayWait(m, (b) => targetHeadway(b, n));

/** The line's timetable fitted to `n` buses, or null when nothing changes. */
function fittedTimetable(game: Game, m: LineModel, n: number): Timetable | null {
  const r = game.state.routes[m.route];
  if (!r) return null;
  const tt: Timetable = structuredClone(r.timetable);
  let changed = false;
  (['weekday', 'weekend'] as const).forEach((k, w) => {
    const looks = m.looks[w];
    tt[k].bands = tt[k].bands.map((b, i) => {
      const look = looks[i];
      if (!look) return b;
      const h = targetHeadway(look, n);
      if (h !== b.headway) changed = true;
      return { ...b, headway: h };
    });
  });
  return changed ? tt : null;
}

function describeTimetable(game: Game, route: Id, before: Timetable, after: Timetable): string[] {
  const out: string[] = [];
  for (const [k, label] of [['weekday', 'weekdays'], ['weekend', 'weekends']] as const) {
    const parts: string[] = [];
    after[k].bands.forEach((b, i) => {
      const was = before[k].bands[i];
      if (!was || was.headway === b.headway) return;
      parts.push(`every ${b.headway} min ${minutesLabel(b.from)}–${minutesLabel(b.to)} (now ${was.headway})`);
    });
    if (parts.length) out.push(`${lineNo(game, route)}, ${label}: ${parts.join('; ')}`);
  }
  return out;
}

// ───────────────────────────────────────────── the plan

export type Change =
  | { kind: 'move'; vehicle: Id; from: Id | null; to: Id }
  | { kind: 'buy'; model: string; depot: Id; to: Id; price: number }
  | { kind: 'timetable'; route: Id; before: Timetable; after: Timetable }
  | { kind: 'route'; route: Id; base: LineShape; fix: FixPlan };

export interface Step {
  id: string;
  kind: 'buses' | 'timetable' | 'route';
  title: string;
  why: string;
  details: string[];
  changes: Change[];
  /** money spent at once (buses bought) */
  cost: number;
  /** waiting minutes a day it should save (estimate before testing; 0 for route changes) */
  saves: number;
  /** ticked by default */
  on: boolean;
  lines: Id[];
}

export interface Plan {
  at: number;
  steps: Step[];
  notes: string[];
  diagnosis: Diagnosis;
}

function shapeOf(game: Game, id: Id): LineShape | null {
  const r = game.state.routes[id];
  return r ? { id: r.id, number: r.number, colour: r.colour, kind: r.kind, stops: r.stops, returnStops: r.returnStops, via: r.via } : null;
}

const STATUS_RANK: Partial<Record<Vehicle['status'], number>> = { parked: 0, layover: 1, preparing: 1, to_route: 2, at_stop: 3, in_service: 3, to_depot: 1, maintenance: 4, broken: 5 };

function whyLine(l: LineLook): string {
  const parts = [`${int(l.boardings)} riders a day`];
  if (l.avgWait !== null) parts.push(`an average wait of ${l.avgWait.toFixed(1)} min`);
  if (l.leftBehind) parts.push(`${int(l.leftBehind)} left behind by full buses`);
  if (l.gaveUp) parts.push(`${int(l.gaveUp)} gave up waiting`);
  if (l.missed) parts.push(`${int(l.missed)} departures missed`);
  return `${parts.join(', ')}.`;
}

function pickModel(game: Game, route: Id, peakLoad: number | null): string | null {
  const unlocked = unlockedModels(game.state);
  const onLine = busesOn(game, route).map((v) => v.model);
  const count = new Map<string, number>();
  for (const m of onLine) count.set(m, (count.get(m) ?? 0) + 1);
  let model = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (unlocked.has('city12') ? 'city12' : null);
  // full buses at the busiest hour: one size up, if it is unlocked
  if (model && peakLoad !== null && peakLoad >= 0.85) {
    const cap = MODEL[model].capacity;
    const bigger = MODELS.filter((m) => unlocked.has(m.id) && m.capacity > cap && m.id !== 'ecity12').sort((a, b) => a.capacity - b.capacity)[0];
    if (bigger) model = bigger.id;
  }
  if (model && !unlocked.has(model)) model = MODELS.filter((m) => unlocked.has(m.id)).sort((a, b) => a.price - b.price)[0]?.id ?? null;
  return model;
}

function depotFor(game: Game, route: Id, extra: Map<Id, number>): Id | null {
  const s = game.state;
  const own = busesOn(game, route).map((v) => v.depot);
  const order = [...new Set([...own, ...Object.keys(s.depots)])];
  for (const id of order) {
    const d = s.depots[id];
    if (d && game.depotUse(id) + (extra.get(id) ?? 0) < d.capacity) return id;
  }
  return null;
}

export function planService(game: Game): Plan {
  const s = game.state;
  const diagnosis = diagnose(game);
  const notes: string[] = [];
  const look = new Map(diagnosis.lines.map((l) => [l.route, l]));
  const models = new Map<Id, LineModel>();
  for (const r of Object.values(s.routes)) {
    if (r.suspended || !game.profiles.get(r.id)) continue;
    const hist = history(game, r.id);
    const lk = look.get(r.id)!;
    const scale = 1 + Math.min(1, (lk.gaveUp + 0.5 * lk.leftBehind) / Math.max(1, lk.boardings));
    models.set(r.id, {
      route: r.id,
      n: busesOn(game, r.id).length,
      looks: [bandLooks(game, r.id, r.timetable.weekday, false, hist.byHour[0], scale), bandLooks(game, r.id, r.timetable.weekend, true, hist.byHour[1], scale)],
      plans: !!r.timetable.plans?.some((p) => p.enabled),
      hist,
    });
  }
  if (diagnosis.lines.some((l) => l.boardings === 0 && l.buses > 0)) notes.push('Lines with no riders yet are left as they are.');

  // greedy: give a bus to the line where it saves the most waiting, from spares, a line that can spare one, or a purchase
  const n = new Map([...models].map(([id, m]) => [id, m.n]));
  const spares = Object.values(s.vehicles).filter((v) => !v.route && !v.sell && v.status !== 'broken');
  const receivers = new Map<Id, Change[]>();
  const donorOf = new Map<Id, Id>();
  const exhausted = new Set<Id>();
  const taken = new Set<Id>();
  const depotExtra = new Map<Id, number>();
  const daily = Math.max(0, -dayTotals(s, Math.floor(game.t / DAY) - 1).operating);
  let money = s.finance.balance - Math.max(RESERVE, 7 * daily);
  let buys = 0;
  const gainOf = (id: Id) => {
    const m = models.get(id)!;
    const k = n.get(id)!;
    return m.hist.boardings > 0 && k > 0 ? waitWith(m, k) - waitWith(m, k + 1) : 0;
  };
  // a line gives up a bus only if no part of its day then runs less often than now
  const canSpare = (id: Id) => {
    const m = models.get(id)!;
    const k = n.get(id)! - 1;
    return k >= 1 && m.looks.every((looks) => looks.every((b) => targetHeadway(b, k) <= b.band.headway));
  };
  const lossOf = (id: Id) => {
    const m = models.get(id)!;
    const k = n.get(id)!;
    return waitWith(m, k - 1) - waitWith(m, k);
  };
  for (let iter = 0; iter < MAX_STEPS_MOVES; iter++) {
    const cands = [...models.keys()].filter((id) => !exhausted.has(id) && !donorOf.has(id)).map((id) => ({ id, gain: gainOf(id) })).sort((a, b) => b.gain - a.gain);
    const best = cands[0];
    if (!best || best.gain < MIN_GAIN) break;
    const R = best.id;
    const ch = receivers.get(R) ?? [];
    const spare = spares.find((v) => !taken.has(v.id));
    if (spare) {
      taken.add(spare.id);
      ch.push({ kind: 'move', vehicle: spare.id, from: null, to: R });
    } else {
      const donors = [...models.keys()]
        .filter((id) => id !== R && !receivers.has(id) && (donorOf.get(id) ?? R) === R && !models.get(id)!.plans && canSpare(id))
        .map((id) => ({ id, loss: lossOf(id) }))
        .sort((a, b) => a.loss - b.loss);
      const d = donors[0];
      if (d && best.gain - d.loss >= Math.max(MIN_GAIN, 0.3 * best.gain)) {
        const bus = busesOn(game, d.id).filter((v) => !taken.has(v.id)).sort((a, b) => (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3))[0];
        if (!bus) { exhausted.add(R); continue; }
        taken.add(bus.id);
        donorOf.set(d.id, R);
        n.set(d.id, n.get(d.id)! - 1);
        ch.push({ kind: 'move', vehicle: bus.id, from: d.id, to: R });
      } else {
        const model = buys < MAX_BUYS && best.gain >= BUY_GAIN ? pickModel(game, R, look.get(R)?.peakLoad ?? null) : null;
        const depot = model ? depotFor(game, R, depotExtra) : null;
        const price = model ? MODEL[model].price : 0;
        if (!model || !depot || price > money || s.company.status !== 'ok') {
          if (model && !depot) notes.push(`${lineNo(game, R)} could use another bus, but your depots are full. Expand one in Fleet → Depots.`);
          else if (model && price > money) notes.push(`${lineNo(game, R)} could use another bus (${game.money(price)}), but buying it would leave too little money in the bank.`);
          exhausted.add(R);
          continue;
        }
        buys++;
        money -= price;
        depotExtra.set(depot, (depotExtra.get(depot) ?? 0) + 1);
        ch.push({ kind: 'buy', model, depot, to: R, price });
      }
    }
    receivers.set(R, ch);
    n.set(R, n.get(R)! + 1);
  }

  const steps: Step[] = [];
  const touched = new Set<Id>();
  const timetableChange = (id: Id, k: number): Change | null => {
    const m = models.get(id)!;
    const after = fittedTimetable(game, m, k);
    return after ? { kind: 'timetable', route: id, before: structuredClone(s.routes[id].timetable), after } : null;
  };
  for (const [R, ch] of receivers) {
    const lk = look.get(R)!;
    const changes: Change[] = [...ch];
    const details: string[] = [];
    let saves = waitNow(models.get(R)!) - waitWith(models.get(R)!, n.get(R)!);
    for (const c of ch) {
      if (c.kind === 'move') {
        const v = s.vehicles[c.vehicle];
        details.push(c.from ? `Bus ${v.fleetNo} moves from ${lineNo(game, c.from)} once it has run the trips it has` : `Bus ${v.fleetNo} (a spare) joins ${lineNo(game, R)}`);
      } else if (c.kind === 'buy') details.push(`Buy a ${MODEL[c.model].name} (${game.money(c.price)}) for ${lineNo(game, R)}, based at ${s.depots[c.depot]?.name}`);
    }
    const tt = timetableChange(R, n.get(R)!);
    if (tt && tt.kind === 'timetable') { changes.push(tt); details.push(...describeTimetable(game, R, tt.before, tt.after)); }
    for (const [D, to] of donorOf) {
      if (to !== R) continue;
      const dt = timetableChange(D, n.get(D)!);
      if (dt && dt.kind === 'timetable') { changes.push(dt); details.push(...describeTimetable(game, D, dt.before, dt.after)); }
      saves += waitNow(models.get(D)!) - waitWith(models.get(D)!, n.get(D)!);
      touched.add(D);
    }
    touched.add(R);
    const added = ch.length;
    const cost = ch.reduce((p, c) => p + (c.kind === 'buy' ? c.price : 0), 0);
    steps.push({
      id: `buses:${R}`, kind: 'buses',
      title: `${added} more bus${added === 1 ? '' : 'es'} on ${lineNo(game, R)}`,
      why: whyLine(lk), details, changes, cost, saves: Math.max(0, saves), on: true,
      lines: [R, ...[...donorOf].filter(([, to]) => to === R).map(([d]) => d)],
    });
  }
  // lines that can run better with the buses they have (idle buses, or a timetable they cannot keep)
  for (const [id, m] of models) {
    if (touched.has(id) || m.hist.boardings === 0 && !look.get(id)!.missed) continue;
    const tt = timetableChange(id, m.n);
    if (!tt || tt.kind !== 'timetable') continue;
    const lk = look.get(id)!;
    const missing = lk.need > m.n;
    const saves = waitNow(m) - waitWith(m, m.n);
    steps.push({
      id: `timetable:${id}`, kind: 'timetable',
      title: missing ? `${lineNo(game, id)}: a timetable its buses can keep` : `${lineNo(game, id)}: use the buses it has`,
      why: missing ? `Its timetable needs ${lk.need} buses but it has ${m.n}, so departures are missed and people wait twice as long.` : `Its ${m.n} bus${m.n === 1 ? '' : 'es'} can run it more often in the hours people travel. ${whyLine(lk)}`,
      details: describeTimetable(game, id, tt.before, tt.after), changes: [tt], cost: 0, saves: Math.max(0, saves), on: true, lines: [id],
    });
  }
  steps.sort((a, b) => b.saves - a.saves);

  // shorter routes from the route check (detours and one-way trouble)
  for (const r of Object.values(s.routes)) {
    const base = shapeOf(game, r.id);
    if (!base || r.suspended) continue;
    const diags = (game.patterns.get(r.id) ?? []).flatMap((p) => p.diagnostics ?? []).filter((d) => (d.kind === 'detour' || d.kind === 'contraflow') && d.severity !== 'info').slice(0, 4);
    let best: FixPlan | null = null;
    for (const d of diags) {
      for (const f of suggestFixes(game, base, d, { maxPlans: 2 })) if (!best || f.savedM > best.savedM) best = f;
    }
    if (!best || best.savedM < 200) continue;
    const touchesStops = Object.keys(best.moves).length + Object.keys(best.builds).length > 0;
    steps.push({
      id: `route:${r.id}`, kind: 'route',
      title: `A shorter route for ${lineNo(game, r.id)}`,
      why: `The route check found a detour: ${best.title.charAt(0).toLowerCase()}${best.title.slice(1)}. It saves ${(best.savedM / 1000).toFixed(1)} km a round trip, so journeys are quicker.`,
      details: [touchesStops ? 'This moves or builds a stop, which also changes other lines that use it. Look at it in the route check first.' : 'Only the streets change; the stops stay.'],
      changes: [{ kind: 'route', route: r.id, base, fix: best }], cost: 0, saves: 0, on: !touchesStops, lines: [r.id],
    });
  }
  if (!steps.length) notes.push(diagnosis.satisfaction === null ? 'There are no rated journeys yet. Run the game for a while first.' : 'Every line already runs as often as its buses and riders allow, and no route check found a shorter way.');
  return { at: game.t, steps, notes: [...new Set(notes)], diagnosis };
}

// ───────────────────────────────────────────── applying it

export interface Applied {
  done: string[];
  problems: string[];
  /** put the timetables, buses and routes back (bought buses stay) */
  undo: () => string[];
}

const sameBands = (a: Timetable, b: Timetable) => JSON.stringify([a.weekday, a.weekend, a.layover]) === JSON.stringify([b.weekday, b.weekend, b.layover]);

/** Apply the chosen steps with the game's own commands. Each step is checked against the company as it is now. */
export function applyPlan(game: Game, plan: Plan, ids: Iterable<string>, src = 'player'): Applied {
  const s = game.state;
  const pick = new Set(ids);
  const done: string[] = [], problems: string[] = [];
  const undoTt: { route: Id; tt: Timetable }[] = [];
  const undoBus: { vehicle: Id; route: Id | null }[] = [];
  const undoFix: AppliedFix[] = [];
  for (const step of plan.steps) {
    if (!pick.has(step.id)) continue;
    // check first: nothing in a step happens unless all of it still fits
    const stale = step.changes.find((c) =>
      c.kind === 'timetable' ? !s.routes[c.route] || !sameBands(s.routes[c.route].timetable, c.before)
        : c.kind === 'move' ? !s.vehicles[c.vehicle] || s.vehicles[c.vehicle].route !== c.from || !!s.vehicles[c.vehicle].sell || !s.routes[c.to]
          : c.kind === 'buy' ? !s.routes[c.to] || !s.depots[c.depot] || s.finance.balance < c.price
            : !s.routes[c.route] || !sameShape(shapeOf(game, c.route)!, c.base));
    if (stale) {
      problems.push(`${step.title}: the company has changed since this plan was made. Make a new plan.`);
      continue;
    }
    let failed = '';
    for (const c of step.changes) {
      if (c.kind === 'buy') {
        const b = game.buyVehicle(c.model, c.depot);
        if (!b.ok) { failed = b.error; break; }
        const a = game.handoverVehicle(b.value, c.to, src);
        if (!a.ok) { failed = a.error; break; }
      } else if (c.kind === 'move') {
        const r = game.handoverVehicle(c.vehicle, c.to, src);
        if (!r.ok) { failed = r.error; break; }
        undoBus.push({ vehicle: c.vehicle, route: c.from });
      } else if (c.kind === 'timetable') {
        const prev = structuredClone(s.routes[c.route].timetable);
        const r = game.setTimetable(c.route, { ...c.after, plans: prev.plans });
        if (!r.ok) { failed = r.error; break; }
        undoTt.push({ route: c.route, tt: prev });
      } else {
        const res = applyFix(game, c.base, c.fix, routeTarget(game, c.route, c.base));
        if (typeof res === 'string') { failed = res; break; }
        undoFix.push(res);
      }
    }
    if (failed) problems.push(`${step.title}: ${failed}`);
    else done.push(step.title);
  }
  return {
    done, problems,
    undo: () => {
      const errs: string[] = [];
      for (const f of undoFix.reverse()) { const e = f.undo(); if (e) errs.push(e); }
      for (const { route, tt } of undoTt.reverse()) { const r = game.setTimetable(route, tt); if (!r.ok) errs.push(r.error); }
      for (const { vehicle, route } of undoBus.reverse()) {
        if (!s.vehicles[vehicle]) continue;
        const r = game.handoverVehicle(vehicle, route, src);
        if (!r.ok) errs.push(r.error);
      }
      return errs;
    },
  };
}

// ───────────────────────────────────────────── testing it on copies

export const TEST_HOURS = [6, 24] as const;

export interface PlanTest {
  from: number;
  to: number;
  hours: number;
  baseline: LabMetrics;
  variant: LabMetrics;
  /** steps that could not be applied in the copy */
  problems: string[];
  lines: { route: Id; number: string; before: { boardings: number; wait: number | null }; after: { boardings: number; wait: number | null } }[];
  wallMs: number;
}

function lineTotals(state: GameState, route: Id, d0: number) {
  const a = state.analytics;
  let b = 0, ws = 0, wn = 0;
  for (const rec of [...a.days.filter((d) => d.day >= d0), a.today]) {
    const r = rec.routes[route];
    if (!r) continue;
    b += r.b.reduce((p, q) => p + q, 0);
    ws += r.ws;
    wn += r.wn;
  }
  return { b, ws, wn };
}

const CHUNK = 15 * 60;

/** Play the next hours twice on copies of the company, without the plan and with it. The real game is not touched. */
export async function testPlan(game: Game, plan: Plan, ids: Iterable<string>, hours: number, progress?: (done: number) => void, cancelled?: () => boolean): Promise<PlanTest | null> {
  const started = performance.now();
  const json = JSON.stringify(game.state);
  const base = new Game(JSON.parse(json) as GameState, game.region);
  const test = new Game(JSON.parse(json) as GameState, game.region);
  const applied = applyPlan(test, plan, ids, 'player');
  const from = game.t, to = from + hours * HOUR;
  const d0 = Math.floor(from / DAY);
  const routes = [...new Set(plan.steps.filter((st) => [...ids].includes(st.id)).flatMap((st) => st.lines))];
  const t0b = labTotals(base.state, d0), t0t = labTotals(test.state, d0);
  const l0b = new Map(routes.map((r) => [r, lineTotals(base.state, r, d0)]));
  const l0t = new Map(routes.map((r) => [r, lineTotals(test.state, r, d0)]));
  for (let t = from; t < to; t += CHUNK) {
    if (cancelled?.()) return null;
    const step = Math.min(CHUNK, to - t);
    base.run(step);
    test.run(step);
    progress?.((t + step - from) / (to - from));
    await new Promise((r) => setTimeout(r, 0));
  }
  const diff = (g: Game, r: Id, a: { b: number; ws: number; wn: number }) => {
    const b = lineTotals(g.state, r, d0);
    const wn = b.wn - a.wn;
    return { boardings: b.b - a.b, wait: wn ? Math.round(((b.ws - a.ws) / wn) * 10) / 10 : null };
  };
  return {
    from, to, hours,
    baseline: labMetrics(t0b, labTotals(base.state, d0)),
    variant: labMetrics(t0t, labTotals(test.state, d0)),
    problems: applied.problems,
    lines: routes.filter((r) => game.state.routes[r]).map((r) => ({ route: r, number: game.state.routes[r].number, before: diff(base, r, l0b.get(r)!), after: diff(test, r, l0t.get(r)!) })),
    wallMs: Math.round(performance.now() - started),
  };
}

export { SAT_COMPONENTS };
