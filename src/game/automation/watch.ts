// Trigger timing and the "Watch a figure" trigger. Condition triggers (a figure above or below a
// value, people waiting, a line short of buses…) fire when the condition has held for a set time
// and fire again only once it has cleared. Every trigger can be limited to hours and kinds of day,
// and event triggers to once every so often for the same line, stop or bus. The state lives in
// `automation.schedule`, so a reload carries on exactly where it was.

import type { Game } from '../engine.ts';
import type { Id, Vehicle } from '../types.ts';
import type { AutomationState, WfNode, Workflow } from './types.ts';
import { DAY, HOUR, MODEL } from '../content.ts';
import { hhmm, serviceDayOf, weekdayOf } from '../time.ts';
import { routeWindow } from '../progress.ts';
import { companyLevel } from '../control.ts';
import { dayTotals } from '../finance.ts';
import { nextPeakFire, periodLabel } from './peaks.ts';
import { gapOptions, lineGaps } from './ops.ts';

export type Scope = 'line' | 'stop' | 'bus' | 'company';

export interface Figure {
  id: string;
  scope: Scope;
  label: string;
  unit: string;
  /** a sensible threshold for a new node */
  def: number;
  /** usual direction */
  op: 'above' | 'below';
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const sum = (a: number[] | undefined) => (a ? a.reduce((x, y) => x + y, 0) : 0);

/** Figures a "Watch a figure" trigger can watch. Every one is read from the simulation. */
export const FIGURES: Figure[] = [
  { id: 'line.load3h', scope: 'line', label: 'Average load, last 3 hours', unit: '%', def: 85, op: 'above' },
  { id: 'line.occupancy', scope: 'line', label: 'How full its buses are now', unit: '%', def: 85, op: 'above' },
  { id: 'line.onTime3h', scope: 'line', label: 'Trips on time, last 3 hours', unit: '%', def: 75, op: 'below' },
  { id: 'line.delay', scope: 'line', label: 'Average delay now', unit: 'min', def: 5, op: 'above' },
  { id: 'line.waiting', scope: 'line', label: 'People waiting for it', unit: 'people', def: 60, op: 'above' },
  { id: 'line.missedToday', scope: 'line', label: 'Departures missed today', unit: 'departures', def: 3, op: 'above' },
  { id: 'line.short', scope: 'line', label: 'Buses short of its timetable now', unit: 'buses', def: 0, op: 'above' },
  { id: 'line.congestion', scope: 'line', label: 'Road traffic along it', unit: '%', def: 60, op: 'above' },
  { id: 'line.bunched', scope: 'line', label: 'Bunched buses (pairs closer than a third of the timetable gap)', unit: 'pairs', def: 0, op: 'above' },
  { id: 'line.gap', scope: 'line', label: 'Longest gap between buses, share of the timetable gap', unit: '%', def: 160, op: 'above' },
  { id: 'stop.waiting', scope: 'stop', label: 'People waiting', unit: 'people', def: 40, op: 'above' },
  { id: 'stop.longestWait', scope: 'stop', label: 'Longest wait now', unit: 'min', def: 20, op: 'above' },
  { id: 'stop.gaveUpHour', scope: 'stop', label: 'People who gave up, last hour', unit: 'people', def: 8, op: 'above' },
  { id: 'bus.condition', scope: 'bus', label: 'Condition', unit: '%', def: 78, op: 'below' },
  { id: 'bus.delay', scope: 'bus', label: 'How late it is', unit: 'min', def: 8, op: 'above' },
  { id: 'bus.occupancy', scope: 'bus', label: 'How full it is', unit: '%', def: 95, op: 'above' },
  { id: 'company.reputation', scope: 'company', label: 'Reputation', unit: 'points', def: 50, op: 'below' },
  { id: 'company.satisfactionToday', scope: 'company', label: 'Passenger satisfaction today', unit: '%', def: 60, op: 'below' },
  { id: 'company.balance', scope: 'company', label: 'Balance', unit: 'money', def: 20000, op: 'below' },
  { id: 'company.resultToday', scope: 'company', label: 'Today’s result so far', unit: 'money', def: 0, op: 'below' },
];
export const FIGURE: Record<string, Figure> = Object.fromEntries(FIGURES.map((f) => [f.id, f]));

const SCOPE_LABEL: Record<Scope, string> = { line: 'Lines', stop: 'Stops', bus: 'Buses', company: 'The company' };
export const FIGURE_OPTIONS = FIGURES.map((f) => ({ value: f.id, label: f.label, group: SCOPE_LABEL[f.scope] }));

// ───────────────────────────────────────────── reading figures

/** Buses a line's timetable needs at this moment (0 outside its hours). */
export function busesNeededNow(game: Game, route: Id): number {
  const req = game.requirement(route);
  if (!req) return 0;
  const sd = serviceDayOf(game.t);
  const m = (game.t - sd * DAY) / 60;
  return req.bands.find((b) => m >= b.band.from && m < b.band.to)?.need ?? 0;
}

/** Buses on the line that can work: not under maintenance, broken down or leaving the fleet. */
export function busesAvailable(game: Game, route: Id): number {
  const s = game.state;
  const r = s.routes[route];
  if (!r) return 0;
  let n = 0;
  for (const id of r.vehicles) {
    const v = s.vehicles[id];
    if (v && v.status !== 'maintenance' && v.status !== 'broken' && !v.withdraw && !v.sell && !v.handover) n++;
  }
  return n;
}

/** How many buses short of its timetable the line is now (0 when suspended or covered). */
export function shortOf(game: Game, route: Id): number {
  const r = game.state.routes[route];
  if (!r || r.suspended) return 0;
  return Math.max(0, busesNeededNow(game, route) - busesAvailable(game, route));
}

/** People who gave up waiting at a stop in the last 60 minutes (this hour, plus the matching part of the last). */
export function gaveUpLastHour(game: Game, stop: Id): number {
  const rec = game.state.analytics.today.stops[stop];
  if (!rec) return 0;
  const h = Math.floor((game.t % DAY) / HOUR);
  const part = ((game.t % HOUR) / HOUR);
  return Math.round(rec.g[h] + (h > 0 ? rec.g[h - 1] * (1 - part) : 0));
}

/** Satisfaction of today's finished journeys, 0–100 (null before any). */
export function satisfactionToday(game: Game): number | null {
  const n = game.state.analytics.today.net;
  return n.sn ? r1((n.ss / n.sn) * 100) : null;
}

function lineValue(game: Game, id: Id, f: string): number | null {
  const s = game.state;
  const r = s.routes[id];
  if (!r) return null;
  switch (f) {
    case 'line.load3h': case 'line.onTime3h': {
      const w = routeWindow(s, id, 3);
      const x = f === 'line.load3h' ? w.load : w.ontime;
      return x === null ? null : r1(x * 100);
    }
    case 'line.occupancy': case 'line.delay': {
      let n = 0, occ = 0, late = 0;
      for (const vid of r.vehicles) {
        const v = s.vehicles[vid];
        if (!v || !(v.status === 'in_service' || v.status === 'at_stop') || v.pos.kind !== 'pattern' || v.pos.route !== id) continue;
        n++;
        occ += (v.sp ?? v.load) / MODEL[v.model].capacity;
        late += Math.max(0, v.delay);
      }
      if (!n) return f === 'line.occupancy' ? 0 : 0;
      return f === 'line.occupancy' ? r1((occ / n) * 100) : r1(late / n / 60);
    }
    case 'line.waiting': {
      let w = 0;
      for (const list of Object.values(s.pax.waiting)) for (const g of list) if (g.legs[g.leg]?.r === id) w += g.n;
      return w;
    }
    case 'line.missedToday': return sum(s.analytics.today.routes[id]?.m);
    case 'line.short': return shortOf(game, id);
    case 'line.bunched': return lineGaps(game, id).bunched;
    case 'line.gap': return lineGaps(game, id).worstGap;
    case 'line.congestion': {
      const p = game.patterns.get(id)?.find((x) => x.valid);
      if (!p) return null;
      let t = 0, n = 0;
      for (let i = 0; i < p.path.dedges.length; i += 3) { t += game.traffic.congestion(p.path.dedges[i], game.t); n++; }
      return n ? r1((t / n) * 100) : null;
    }
  }
  return null;
}

function stopValue(game: Game, id: Id, f: string): number | null {
  const s = game.state;
  if (!s.stops[id]) return null;
  switch (f) {
    case 'stop.waiting': return (s.pax.waiting[id] ?? []).reduce((a, g) => a + g.n, 0);
    case 'stop.longestWait': return r1((s.pax.waiting[id] ?? []).reduce((a, g) => Math.max(a, (s.clock.t - g.tl) / 60), 0));
    case 'stop.gaveUpHour': return gaveUpLastHour(game, id);
  }
  return null;
}

function busValue(v: Vehicle, f: string): number | null {
  switch (f) {
    case 'bus.condition': return Math.round(v.condition * 100);
    case 'bus.delay': return v.route && (v.status === 'in_service' || v.status === 'at_stop') ? r1(Math.max(0, v.delay) / 60) : 0;
    case 'bus.occupancy': return r1(((v.sp ?? v.load) / MODEL[v.model].capacity) * 100);
  }
  return null;
}

function companyValue(game: Game, f: string): number | null {
  const s = game.state;
  switch (f) {
    case 'company.reputation': return r1(s.company.reputation);
    case 'company.satisfactionToday': return satisfactionToday(game);
    case 'company.balance': return Math.round(s.finance.balance);
    case 'company.resultToday': return Math.round(dayTotals(s, Math.floor(game.t / DAY)).result);
  }
  return null;
}

/** One figure for one line, stop or bus (or the company): what "Wait until" checks each minute. */
export function figureValue(game: Game, figId: string, id: string | null): number | null {
  const fig = FIGURE[figId];
  if (!fig) return null;
  if (fig.scope === 'line') return id ? lineValue(game, id, figId) : null;
  if (fig.scope === 'stop') return id ? stopValue(game, id, figId) : null;
  if (fig.scope === 'bus') {
    const v = id ? game.state.vehicles[id] : undefined;
    return v ? busValue(v, figId) : null;
  }
  return companyValue(game, figId);
}

export interface Watched {
  /** schedule key suffix for this item */
  key: string;
  kind: Scope;
  id: string | null;
  name: string;
  value: number | null;
  line: Id | null;
  stop: Id | null;
  vehicle: Id | null;
}

/** The items a watch node looks at now, with the figure's value for each. */
export function watchedItems(game: Game, c: WfNode['config']): Watched[] {
  const fig = FIGURE[String(c.figure ?? '')];
  if (!fig) return [];
  const s = game.state;
  const only = typeof c.line === 'string' && c.line && s.routes[c.line] ? s.routes[c.line] : null;
  const out: Watched[] = [];
  if (fig.scope === 'line') {
    for (const r of only ? [only] : Object.values(s.routes)) {
      if (r.suspended && fig.id !== 'line.missedToday') continue;
      out.push({ key: r.id, kind: 'line', id: r.id, name: `Line ${r.number}`, value: lineValue(game, r.id, fig.id), line: r.id, stop: null, vehicle: null });
    }
  } else if (fig.scope === 'stop') {
    const ids = only ? [...new Set([...only.stops, ...(only.returnStops ?? [])])] : Object.keys(s.stops);
    for (const id of ids.slice(0, 600)) out.push({ key: id, kind: 'stop', id, name: s.stops[id]?.name ?? id, value: stopValue(game, id, fig.id), line: only?.id ?? null, stop: id, vehicle: null });
  } else if (fig.scope === 'bus') {
    for (const v of Object.values(s.vehicles)) {
      if (only && v.route !== only.id) continue;
      out.push({ key: v.id, kind: 'bus', id: v.id, name: `Bus ${v.fleetNo}`, value: busValue(v, fig.id), line: v.route, stop: null, vehicle: v.id });
    }
  } else {
    out.push({ key: 'company', kind: 'company', id: null, name: 'The company', value: companyValue(game, fig.id), line: null, stop: null, vehicle: null });
  }
  return out;
}

/** Above or below the threshold, and cleared again (with the chosen margin). */
export function watchTest(c: WfNode['config'], value: number | null): { on: boolean; off: boolean } {
  if (value === null) return { on: false, off: true };
  const above = String(c.op ?? 'above') !== 'below';
  const x = Number(c.value) || 0;
  const margin = String(c.again ?? 'margin') === 'margin' ? Math.max(Math.abs(x) * 0.1, 1) : 0;
  if (above) return { on: value > x, off: value <= x - margin };
  return { on: value < x, off: value >= x + margin };
}

// ───────────────────────────────────────────── timing

export const DAYS_OPTIONS = [
  { value: 'all', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekend', label: 'Weekends' },
];

/** The trigger's hours and kind of day allow time `t`. */
export function timeOk(game: Game, c: WfNode['config'], t: number): boolean {
  const from = Number(c.from ?? 0), to = Number(c.to ?? 24);
  const h = Math.floor((t % DAY) / HOUR);
  const inHours = from === to || (from < to ? h >= from && h < to : h >= from || h < to);
  if (!inHours) return false;
  const days = String(c.days ?? 'all');
  if (days === 'all') return true;
  const wd = weekdayOf(game.state.clock.startWeekday, t);
  return days === 'weekend' ? wd >= 5 : wd < 5;
}

/** Schedule keys for a condition trigger's item: fired, and building up since. */
export const firedKey = (wf: string, node: string, item: string) => `${wf}:${node}:${item}`;
export const pendingKey = (wf: string, node: string, item: string) => `p:${wf}:${node}:${item}`;

/**
 * One minute of a condition trigger for one item. Returns true when it should fire now; the caller
 * fires and then calls `markFired`. While fired it waits for the condition to clear (`off`).
 */
export function condStep(a: AutomationState, key: string, pkey: string, t: number, on: boolean, off: boolean, forMin: number): boolean {
  if (a.schedule[key]) {
    if (off) delete a.schedule[key];
    if (a.schedule[pkey] !== undefined) delete a.schedule[pkey];
    return false;
  }
  if (!on) {
    if (a.schedule[pkey] !== undefined) delete a.schedule[pkey];
    return false;
  }
  if (forMin <= 0) return true;
  const since = a.schedule[pkey] ?? (a.schedule[pkey] = t);
  return t - since >= forMin * 60;
}

export function markFired(a: AutomationState, key: string, pkey: string) {
  a.schedule[key] = 1;
  delete a.schedule[pkey];
}

/** Forget a workflow's half-built conditions (switched off, paused or edited: nothing was watched meanwhile). */
export function clearPending(a: AutomationState, wf?: string) {
  const pre = wf ? `p:${wf}:` : 'p:';
  for (const k of Object.keys(a.schedule)) if (k.startsWith(pre)) delete a.schedule[k];
}

/** Event triggers: "at most once every N minutes" for the same line, stop or bus. */
export function repeatOk(a: AutomationState, wf: string, node: string, target: string, t: number, minutes: number): boolean {
  if (!(minutes > 0)) return true;
  const k = `rp:${wf}:${node}:${target}`;
  if ((a.schedule[k] ?? 0) > t) return false;
  a.schedule[k] = t + minutes * 60;
  return true;
}

/** What "at most once every" counts by, per event trigger. */
export const REPEAT_PER: Record<string, { field: string; label: string }> = {
  'trigger.arrive': { field: 'stop', label: 'for each stop' },
  'trigger.crowded': { field: 'line', label: 'for each line' },
  'trigger.late': { field: 'line', label: 'for each line' },
  'trigger.missed': { field: 'line', label: 'for each line' },
  'trigger.breakdown': { field: 'vehicle', label: 'for each bus' },
  'trigger.leftBehind': { field: 'stop', label: 'for each stop' },
};

// ───────────────────────────────────────────── live status (for the editor)

export interface TriggerStatus {
  state: 'off' | 'waiting' | 'building' | 'fired' | 'idle';
  /** one short line for the node card */
  text: string;
  /** last time it fired, and how many times today */
  last: number | null;
  today: number;
}

const fmtVal = (game: Game, f: Figure | undefined, v: number | null) => {
  if (v === null) return 'no figure yet';
  if (!f) return String(v);
  if (f.unit === 'money') return game.money(v, { compact: true });
  if (f.unit === '%') return `${v}%`;
  return `${v} ${f.unit}`;
};

function nextClock(game: Game, node: WfNode): number | null {
  const c = node.config, t = game.t;
  if (node.type === 'trigger.every') {
    const every = Math.max(5, Number(c.minutes) || 15) * 60;
    for (let x = (Math.floor(t / every) + 1) * every, i = 0; i < 400; i++, x += every) if (timeOk(game, c, x)) return x;
    return null;
  }
  if (node.type === 'trigger.time' || node.type === 'trigger.calendar') {
    const [hh, mm] = String(c.time ?? '07:00').split(':').map(Number);
    const at = ((hh || 0) * 60 + (mm || 0)) * 60;
    for (let d = Math.floor(t / DAY), i = 0; i < 8; i++, d++) {
      const x = d * DAY + at;
      if (x <= t) continue;
      if (node.type === 'trigger.calendar') return x; // its kind of day is checked when it comes
      const days = String(c.days ?? 'all'), wd = weekdayOf(game.state.clock.startWeekday, x);
      if (days === 'weekdays' && wd >= 5) continue;
      if (days === 'weekend' && wd < 5) continue;
      return x;
    }
  }
  return null;
}

/** A plain-words status for a trigger node of a saved workflow, for the canvas. */
/** What a Wait or One-at-a-time node is holding now, for the editor. */
export function pendingStatus(game: Game, wf: Workflow, node: WfNode): { state: 'waiting' | 'building' | 'off'; text: string } {
  const a = game.state.automation;
  if (!wf.enabled || a.paused) return { state: 'off', text: a.paused ? 'All automation paused' : 'Switched off: nothing waits' };
  const list = (a.pending ?? []).filter((p) => p.wf === wf.id && p.node === node.id);
  const next = list.reduce<number | null>((m, p) => (m === null || p.due < m ? p.due : m), null);
  if (node.type === 'logic.queue') {
    const q = a.memory[wf.id]?.[`@queue:${node.id}`];
    const n = q && typeof q === 'object' && !Array.isArray(q) && Array.isArray(q.items) ? q.items.length : 0;
    return n ? { state: 'building', text: `${n} waiting${next !== null ? ` · next at ${hhmm(next)}` : ''}` } : { state: 'waiting', text: 'Nothing waiting' };
  }
  if (!list.length) return { state: 'waiting', text: 'Nothing waiting' };
  const until = list.some((p) => p.until);
  return { state: 'building', text: `${list.length} waiting · ${until ? 'at the latest' : 'next'} ${hhmm(next!)}${list.length === 1 ? ` (${list[0].label})` : ''}` };
}

export function triggerStatus(game: Game, wf: Workflow, node: WfNode): TriggerStatus {
  const a = game.state.automation;
  const today = Math.floor(game.t / DAY);
  let last: number | null = null, n = 0;
  for (const r of a.runs) {
    if (r.wf !== wf.id || r.trigger !== node.id || r.test) continue;
    if (last === null || r.t > last) last = r.t;
    if (Math.floor(r.t / DAY) === today) n++;
  }
  const lastText = last === null ? 'not fired yet' : `last ${Math.floor(last / DAY) === today ? hhmm(last) : `day ${Math.floor(last / DAY) + 1} ${hhmm(last)}`}${n ? ` · ${n} today` : ''}`;
  const base = { last, today: n };
  if (!wf.enabled || a.paused) return { ...base, state: 'off', text: `${a.paused ? 'All automation paused' : 'Switched off'} · ${lastText}` };
  if (node.disabled) return { ...base, state: 'off', text: 'This trigger is switched off' };
  const c = node.config;

  if (node.type === 'trigger.every' || node.type === 'trigger.time' || node.type === 'trigger.calendar') {
    const nx = nextClock(game, node);
    return { ...base, state: 'idle', text: `${nx !== null ? `Next ${Math.floor(nx / DAY) === today ? hhmm(nx) : `day ${Math.floor(nx / DAY) + 1} ${hhmm(nx)}`}` : 'No time ahead'} · ${lastText}` };
  }

  if (node.type === 'trigger.peak') {
    const nx = nextPeakFire(game, c);
    const r = nx ? game.state.routes[nx.line] : null;
    const when = nx ? (Math.floor(nx.t / DAY) === today ? hhmm(nx.t) : `day ${Math.floor(nx.t / DAY) + 1} ${hhmm(nx.t)}`) : '';
    return { ...base, state: 'idle', text: `${nx && r ? `Next ${when}: line ${r.number}, peak ${periodLabel(nx.peak.from, nx.peak.to)}` : 'No peak left today'} · ${lastText}` };
  }

  // condition triggers: what they watch now
  const cond = condItems(game, node);
  if (cond) {
    const forMin = Number(c.for ?? 0) || 0;
    let fired = 0, building = 0, best = 0;
    for (const it of cond.items) {
      if (a.schedule[firedKey(wf.id, node.id, it.key)]) fired++;
      const since = a.schedule[pendingKey(wf.id, node.id, it.key)];
      if (since !== undefined) { building++; best = Math.max(best, game.t - since); }
    }
    const reading = cond.reading;
    const outside = !timeOk(game, c, game.t) ? ' · outside its hours' : '';
    if (building) return { ...base, state: 'building', text: `${reading}Building up: ${Math.min(forMin, Math.floor(best / 60))} of ${forMin} min${building > 1 ? ` (${building})` : ''}${outside}` };
    if (fired) return { ...base, state: 'fired', text: `${reading}Fired, waits to clear${fired > 1 ? ` (${fired})` : ''} · ${lastText}${outside}` };
    return { ...base, state: 'waiting', text: `${reading}Watching · ${lastText}${outside}` };
  }
  return { ...base, state: 'waiting', text: `Listening · ${lastText}` };
}

/** The items and a reading for condition triggers (null for other kinds). */
function condItems(game: Game, node: WfNode): { items: { key: string }[]; reading: string } | null {
  const c = node.config, s = game.state;
  switch (node.type) {
    case 'trigger.watch': {
      const fig = FIGURE[String(c.figure ?? '')];
      const items = watchedItems(game, c);
      if (!fig) return { items, reading: '' };
      const vals = items.filter((x) => x.value !== null);
      const above = String(c.op ?? 'above') !== 'below';
      const worst = vals.sort((p, q) => (above ? (q.value! - p.value!) : (p.value! - q.value!)))[0];
      const reading = worst ? `${items.length > 1 ? `${worst.name} ` : 'Now '}${fmtVal(game, fig, worst.value)}, fires ${above ? 'above' : 'below'} ${fmtVal(game, fig, Number(c.value) || 0)} · ` : '';
      return { items, reading };
    }
    case 'trigger.shortBuses': {
      const lines = typeof c.line === 'string' && c.line && s.routes[c.line] ? [s.routes[c.line]] : Object.values(s.routes);
      const short = lines.map((r) => ({ key: r.id, n: shortOf(game, r.id), r }));
      const top = short.filter((x) => x.n > 0).sort((p, q) => q.n - p.n)[0];
      return { items: short, reading: top ? `Line ${top.r.number} short of ${top.n} · ` : 'Every line covered · ' };
    }
    case 'trigger.waiting': {
      const line = typeof c.line === 'string' && c.line ? s.routes[c.line] : null;
      const ids = line ? [...new Set([...line.stops, ...(line.returnStops ?? [])])] : Object.keys(s.stops);
      let top = 0, name = '';
      for (const id of ids) { const w = (s.pax.waiting[id] ?? []).reduce((x, g) => x + g.n, 0); if (w > top) { top = w; name = s.stops[id]?.name ?? ''; } }
      return { items: ids.map((key) => ({ key })), reading: top ? `Most: ${top} at ${name} · ` : 'Nobody waiting · ' };
    }
    case 'trigger.gaveUp': {
      const line = typeof c.line === 'string' && c.line ? s.routes[c.line] : null;
      const ids = line ? [...new Set([...line.stops, ...(line.returnStops ?? [])])] : Object.keys(s.stops);
      let top = 0, name = '';
      for (const id of ids) { const g = gaveUpLastHour(game, id); if (g > top) { top = g; name = s.stops[id]?.name ?? ''; } }
      return { items: ids.map((key) => ({ key })), reading: top ? `Most: ${top} at ${name} · ` : 'Nobody gave up this hour · ' };
    }
    case 'trigger.balance':
      return { items: [{ key: 'balance' }], reading: `Now ${game.money(Math.round(s.finance.balance), { compact: true })} · ` };
    case 'trigger.bunching': {
      const lines = (typeof c.line === 'string' && c.line && s.routes[c.line] ? [s.routes[c.line]] : Object.values(s.routes)).filter((r) => !r.suspended);
      const o = gapOptions(c);
      const gap = String(c.what ?? 'bunch') === 'gap';
      const read = lines.map((r) => ({ key: r.id, r, g: lineGaps(game, r.id, o) }));
      const top = read.sort((p, q) => (gap ? (q.g.worstGap ?? 0) - (p.g.worstGap ?? 0) : q.g.bunched - p.g.bunched))[0];
      const reading = !top ? '' : gap ? (top.g.worstGap !== null ? `Line ${top.r.number}: longest gap ${top.g.worstGap}% · ` : 'No line has two buses out · ') : top.g.bunched ? `Line ${top.r.number}: ${top.g.bunched} close pair${top.g.bunched === 1 ? '' : 's'} · ` : 'No buses close together · ';
      return { items: read, reading };
    }
  }
  return null;
}

/** Company record extras used by the watch trigger's event. */
export function companyFigures(game: Game) {
  const lv = companyLevel(game.state.company.reputation);
  return { level: lv.level, satisfactionToday: satisfactionToday(game) };
}
