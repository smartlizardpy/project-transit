// The node library. Each node type declares its ports, settings and what it does; the editor
// and the executor both read this registry, so adding a node is adding one definition here.
//
// Values: numbers, booleans, text, records (a line, stop, bus, row: plain objects with `kind`
// and `id`) and lists. A branch that is not taken carries OFF: nodes that receive it do not run.

import type { Pending, Value, WfNode } from './types.ts';
import type { Command } from '../commands.ts';
import type { Game } from '../engine.ts';
import type { LiveData, Rec } from './live.ts';
import { compile, truthy, type EValue } from '../expr.ts';
import { aggregate, estimatedDemand, MEASURE, odMatrix, type GroupBy } from '../analytics/query.ts';
import { BANDS } from '../analytics/types.ts';
import { BASE_COMPARE, BASE_MEASURE, BASE_OPTIONS, BASE_WINDOWS, baselineText, compareBaseline } from './baseline.ts';
import { extraOption } from '../vehicles.ts';
import { DAY, HOUR } from '../content.ts';
import { hhmm, minutesLabel } from '../time.ts';
import { DAYS_OPTIONS, FIGURE, FIGURE_OPTIONS, REPEAT_PER, busesAvailable, figureValue } from './watch.ts';
import { areaStop, assignRows, corridorStops, coverage, forecastOccupancy, gapOptions, lineGaps, missedConnections, nearbyStops, nearestStopOfLine, pointOf, roadTrip, transferPoints, type GapBus } from './ops.ts';
import { turnPlan } from '../operations.ts';
import type { LngLat } from '../world/graph.ts';
import { PEAK_SOURCES, busesNotNeeded, busesToBorrow, currentOrNextPeak, linePeaks, needAt, needOver, needSteps, nowMinute, overlapMinutes, peaksText, periodLabel, ridersByHour, type Peak, type PeakSource } from './peaks.ts';
import { DAY_FILTER, EVENT_FILTER, EVENT_FILTER_SHORT, FORECAST_FILTER, PLACE_FILTER, PLACE_SERVED_M, WEATHER_FILTER, calendarRec, demandForecast, eventRec, eventsAhead, linesNearEvent, placeRec, placesOf, weatherRecs } from './city.ts';

/** Marker for "this branch is not active". Never stored in the save. */
export const OFF: { readonly __off: true } = Object.freeze({ __off: true as const });
export type Flow = Value | typeof OFF | undefined;
export const isOff = (v: unknown): v is typeof OFF => v === OFF;

export type PortType = 'any' | 'number' | 'boolean' | 'text' | 'record' | 'list' | 'line' | 'stop' | 'vehicle' | 'event';

export interface PortDef {
  id: string;
  label: string;
  type: PortType;
  /** an unconnected optional input uses the matching setting, or nothing */
  optional?: boolean;
  /** entity inputs that also accept a list (the action runs once per item) */
  list?: boolean;
  help?: string;
}

export type FieldKind = 'number' | 'text' | 'boolean' | 'select' | 'line' | 'stop' | 'vehicle' | 'depot' | 'expr' | 'time' | 'measure' | 'workflow' | 'textarea';

export interface ConfigField {
  id: string;
  label: string;
  kind: FieldKind;
  default: Value;
  options?: { value: string; label: string; group?: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  help?: string;
  /** variables an expression field can use (besides those listed in the node's help) */
  vars?: string[];
  /** a picker that may be left empty (= any) */
  allowAny?: boolean;
  /** shown under "When it may fire" in the inspector */
  section?: 'timing';
}

export type Category = 'trigger' | 'data' | 'logic' | 'math' | 'state' | 'action' | 'advanced';

export const CATEGORIES: { id: Category; label: string; help: string }[] = [
  { id: 'trigger', label: 'Triggers', help: 'Start a workflow: on a schedule or when something happens in the game.' },
  { id: 'data', label: 'Data', help: 'Read live lines, stops, buses, the company and Network Control analytics.' },
  { id: 'logic', label: 'Logic', help: 'Compare, branch and work with lists.' },
  { id: 'math', label: 'Maths', help: 'Calculate with numbers and expressions.' },
  { id: 'state', label: 'Memory', help: 'Remember values between runs, count, and avoid repeating yourself.' },
  { id: 'action', label: 'Actions', help: 'Change the game, with the same rules as when you do it yourself.' },
  { id: 'advanced', label: 'Advanced', help: 'Reusable functions and notes.' },
];

export interface NodeCtx {
  game: Game;
  live: LiveData;
  /** the event that started the run (a record) */
  event: Rec;
  /** this workflow's memory (a scratch copy during tests) */
  memory: Record<string, Value>;
  /** key prefix for per-node state (`wf:node`) */
  key: string;
  /** request an action; returns the outcome record */
  act: (cmd: Command) => Rec;
  /** call a function workflow */
  call: (workflowId: string, inputs: Record<string, Value>) => Value;
  /** add to the run's report */
  report: (text: string) => void;
  notify: (tone: 'info' | 'good' | 'warn' | 'bad', title: string, body: string) => Rec;
  /** count work for the run's budget */
  spend: (n: number) => void;
  /** a test run from the editor: nothing in the game changes */
  test: boolean;
  /** pause the workflow at this node and carry on later (Wait, One at a time) */
  later: (spec: LaterSpec) => { ok: boolean; note: string };
}

export interface LaterSpec {
  kind: Pending['kind'];
  due: number;
  value?: Value;
  until?: Pending['until'];
  label: string;
  key: string;
}

export interface NodeResult {
  out: Record<string, Flow>;
  /** plain-language explanation for the debugger */
  note?: string;
}

export interface TriggerSpec {
  /** the game event it listens to (queued), or 'clock' / 'condition' (checked each minute), or 'manual' */
  source: 'clock' | 'condition' | 'manual' | 'arrive' | 'depart' | 'missed' | 'breakdown' | 'day' | 'week' | 'forecast' | 'weather' | 'eventAnnounced' | 'leftBehind';
}

export interface NodeDef {
  type: string;
  category: Category;
  label: string;
  /** short description shown in the library and the inspector */
  description: string;
  inputs: PortDef[];
  outputs: PortDef[];
  config: ConfigField[];
  trigger?: TriggerSpec;
  /** action nodes: what they ask the game to do */
  action?: { impact: 'low' | 'high' | 'none' };
  run: (ctx: NodeCtx, inp: Record<string, Value | undefined>, cfg: Record<string, Value>, node: WfNode) => NodeResult;
  /** Wait and One at a time: the outputs when the workflow carries on from this node */
  resume?: (ctx: NodeCtx, p: Pending, cfg: Record<string, Value>, node: WfNode) => NodeResult;
}

// ───────────────────────────────────────────── helpers

const num = (v: Value | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : null);
const str = (v: Value | undefined) => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v));
const isRec = (v: Value | undefined): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
/** A field of a record; a dotted name reads inside it (`match.riders`). */
const fieldOf = (x: Value | undefined, path: string): Value | undefined => {
  let cur: Value | undefined = x;
  for (const part of path.split('.')) {
    if (!isRec(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
};
/** A value used to match or group items: a record by its id, numbers and text as text. */
const keyOf = (v: Value | undefined): string | null => (v === undefined || v === null ? null : isRec(v) ? (typeof v.id === 'string' ? v.id : null) : Array.isArray(v) ? null : String(v));
const idOf = (v: Value | undefined, kind: string): string | null => {
  if (typeof v === 'string' && v) return v;
  if (isRec(v) && (v.kind === kind || kind === 'any') && typeof v.id === 'string') return v.id;
  // a bus, peak or watched item connected where a line is wanted stands for its line
  if (kind === 'line' && isRec(v) && typeof v.line === 'string' && v.line) return v.line;
  // a pair from "Best pairs" stands for its bus or stop
  if (isRec(v) && v.kind === 'pair' && (kind === 'vehicle' || kind === 'stop') && typeof v[kind] === 'string' && v[kind]) return v[kind] as string;
  return null;
};
const fmt = (v: Value | undefined): string => {
  if (v === null || v === undefined) return 'nothing';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(1);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') return String(v.name || v.fleetNo || (v.number !== undefined && v.number !== null ? `Line ${v.number}` : v.label || 'a record'));
  return `"${v}"`;
};
export const describeValue = fmt;

/** Items of an entity input that may be one record or a list (capped). */
function items(v: Value | undefined, max = 10): Value[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.slice(0, max);
  return [v];
}

/** Evaluate an expression with the run's variables. */
function expr(ctx: NodeCtx, src: string, vars: Record<string, Value | undefined>): Value {
  const all: Record<string, EValue> = { event: ctx.event as EValue, time: ctx.live.time() as EValue, memory: ctx.memory as EValue };
  for (const [k, v] of Object.entries(vars)) all[k] = (v === undefined ? null : v) as EValue;
  ctx.spend(1);
  return compile(src).run(all) as Value;
}

const lineCfg = (label = 'Line', allowAny = false): ConfigField => ({ id: 'line', label, kind: 'line', default: '', allowAny, help: allowAny ? 'Leave empty for any line.' : undefined });
const OPS = [
  { value: '>', label: 'is more than' }, { value: '>=', label: 'is at least' }, { value: '<', label: 'is less than' },
  { value: '<=', label: 'is at most' }, { value: '==', label: 'equals' }, { value: '!=', label: 'is not' },
];
const compareOp = (op: string, a: number, b: number) => (op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : op === '<=' ? a <= b : op === '==' ? Math.abs(a - b) < 1e-9 : Math.abs(a - b) >= 1e-9);
const OP_SYMBOL: Record<string, string> = { '>': '>', '>=': '≥', '<': '<', '<=': '≤', '==': '=', '!=': '≠' };

const eventOut: PortDef = { id: 'event', label: 'Event', type: 'event' };
const triggerEntity = (ctx: NodeCtx) => {
  const e = ctx.event;
  return {
    bus: typeof e.vehicle === 'string' ? ctx.live.busById(e.vehicle) ?? OFF : OFF,
    line: typeof e.line === 'string' ? ctx.live.line(e.line) ?? OFF : OFF,
    stop: typeof e.stop === 'string' ? ctx.live.stop(e.stop) ?? OFF : OFF,
  };
};

/** Event triggers: the event as a record, and your lines near it. */
function eventTriggerOut(ctx: NodeCtx, what: string): NodeResult {
  const ev = ctx.game.eventList().find((x) => x.id === ctx.event.event);
  if (!ev) return { out: { event: ctx.event, details: OFF, lines: [] }, note: `${what}: the event is no longer on the calendar.` };
  const lines = linesNearEvent(ctx.game, ev).map((id) => ctx.live.line(id)).filter((x): x is Rec => !!x);
  // like "First item": with none of your lines nearby, nothing connected to "Your lines nearby" runs
  const near = lines.length ? `${lines.length} of your lines nearby.` : 'None of your lines is nearby, so nothing connected to “Your lines nearby” runs.';
  return { out: { event: ctx.event, details: eventRec(ctx.game, ev), lines: lines.length ? lines : OFF }, note: `${what}: ${ev.title}, ${str(ctx.event.when)}${ev.people ? `, about ${ev.people} people` : ''}. ${near}` };
}
const eventKindCfg = (def = 'crowds'): ConfigField => ({ id: 'kinds', label: 'Events', kind: 'select', default: def, options: EVENT_FILTER });
const minPeopleCfg: ConfigField = { id: 'people', label: 'At least', kind: 'number', default: 0, min: 0, max: 200000, step: 500, unit: 'people', help: 'Only events expected to draw at least this many (0: any size).' };
const eventScope = (game: Game, c: WfNode['config']) => {
  const kinds = EVENT_FILTER_SHORT[String(c.kinds ?? 'crowds')] ?? 'events';
  const people = Number(c.people) || 0;
  const line = typeof c.line === 'string' && c.line ? ` near line ${game.state.routes[c.line]?.number ?? '?'}` : '';
  return `${kinds}${people ? ` of ${people.toLocaleString('en-GB')}+` : ''}${line}`;
};
const nearLineCfg: ConfigField = { id: 'line', label: 'Near line', kind: 'line', default: '', allowAny: true, help: 'Only events within a kilometre of this line’s stops. Leave empty for any event.' };
const eventOuts: PortDef[] = [{ id: 'event', label: 'Event', type: 'event' }, { id: 'details', label: 'Event details', type: 'record' }, { id: 'lines', label: 'Lines nearby', type: 'list', help: 'Your lines with a stop within 1 km. When there are none, nothing connected here runs.' }];


// ── peak hours
const peakSourceCfg: ConfigField = { id: 'source', label: 'Peak hours from', kind: 'select', default: 'timetable', options: PEAK_SOURCES, help: 'Timetable: the hours the line needs the most buses to run its timetable. Riders: its busiest hours on recent days of the same kind (weekday or weekend).' };
const srcOf = (c: Record<string, Value>): PeakSource => (str(c.source) === 'riders' ? 'riders' : 'timetable');
/** A peak as a record: connect it where a line is wanted and it stands for its line. */
function peakRec(game: Game, p: Peak): Rec {
  const r = game.state.routes[p.line];
  const m = nowMinute(game);
  const has = busesAvailable(game, p.line);
  return {
    kind: 'peak', id: `${p.line}:${p.from}`, line: p.line, lineNumber: r?.number ?? null, name: `Line ${r?.number ?? '?'} ${periodLabel(p.from, p.to)}`,
    from: minutesLabel(p.from), to: minutesLabel(p.to), period: periodLabel(p.from, p.to), minutes: p.to - p.from,
    need: p.need, has, short: Math.max(0, p.need - has), riders: p.riders, source: p.source,
    now: m >= p.from && m < p.to, startsIn: Math.round(p.from - m),
  };
}

// ── trigger timing: hours, kinds of day, "for at least" and "at most once every"
const fromCfg: ConfigField = { id: 'from', label: 'From', kind: 'number', default: 0, min: 0, max: 23, unit: 'h', section: 'timing', help: 'Only between these hours of the day (0 to 24: all day).' };
const toCfg: ConfigField = { id: 'to', label: 'Until', kind: 'number', default: 24, min: 1, max: 24, unit: 'h', section: 'timing' };
const daysCfg: ConfigField = { id: 'days', label: 'On', kind: 'select', default: 'all', options: DAYS_OPTIONS, section: 'timing' };
const forCfg = (def = 0): ConfigField => ({ id: 'for', label: 'For at least', kind: 'number', default: def, min: 0, max: 240, step: 5, unit: 'min', section: 'timing', help: 'It must stay that way this long before the trigger fires, so a short spike does not set it off. 0: straight away. It fires again only once things are back to normal.' });
const repeatCfg = (type: string, def = 0): ConfigField => ({ id: 'repeat', label: 'At most once every', kind: 'number', default: def, min: 0, max: 1440, step: 5, unit: 'min', section: 'timing', help: `Counted ${REPEAT_PER[type]?.label ?? 'for each item'}. 0: every time.` });
const hoursDays = [fromCfg, toCfg, daysCfg];
const eventTiming = (type: string, repeat = 0) => [repeatCfg(type, repeat), ...hoursDays];

/** Timing settings in words, for trigger labels ("" when unrestricted). */
function timingWords(c: WfNode['config'], opts: { hours?: boolean } = {}): string {
  const out: string[] = [];
  const f = Number(c.for ?? 0) || 0;
  if (f > 0) out.push(`for ${f}+ min`);
  const from = Number(c.from ?? 0), to = Number(c.to ?? 24);
  if (opts.hours !== false && !(from === 0 && to === 24) && from !== to) out.push(`${String(from).padStart(2, '0')}:00–${String(to).padStart(2, '0')}:00`);
  const d = String(c.days ?? 'all');
  if (d !== 'all') out.push(d === 'weekdays' ? 'weekdays' : 'weekends');
  const r = Number(c.repeat ?? 0) || 0;
  if (r > 0) out.push(`at most every ${r} min`);
  return out.length ? ` · ${out.join(', ')}` : '';
}

function actionOut(rec: Rec | Rec[]): NodeResult {
  const list = Array.isArray(rec) ? rec : [rec];
  const done = list.some((r) => r.outcome === 'executed' || r.outcome === 'deferred');
  const note = list.map((r) => `${r.summary}: ${r.outcomeLabel}${r.reason ? ` (${r.reason})` : ''}`).join('; ');
  return { out: { result: Array.isArray(rec) ? list : list[0], done }, note: note || 'Nothing to do.' };
}

/** Data nodes: wire a trigger here so the node reads its figures when (and only when) that trigger fires. */
const afterIn: PortDef = { id: 'after', label: 'After', type: 'any', optional: true, help: 'Connect a trigger (or any step) here: this node then runs only when that step ran. Unconnected, it runs whenever the workflow runs.' };

const moveAfterCfg: ConfigField = { id: 'after', label: 'When', kind: 'select', default: 'trips', options: [{ value: 'trips', label: 'After the trips it already has (no departure missed)' }, { value: 'now', label: 'Straight away (it gives up trips it has not started)' }], help: 'A bus on a line is usually already given its next trip or two. After them, it takes no new trips and moves on once they are done.' };
const afterOf = (cfg: Record<string, Value>): 'trips' | 'now' => (str(cfg.after) === 'now' ? 'now' : 'trips');
const whenIn: PortDef = { id: 'when', label: 'When', type: 'any', optional: true, help: 'Connect a condition or a value: the action only runs when it is active and true.' };
/** An action's `when` input: unconnected = go, false/empty = skip. */
const go = (inp: Record<string, Value | undefined>) => !('when' in inp) || inp.when === undefined || truthy(inp.when as EValue);

// ───────────────────────────────────────────── the library

// ── control room helpers
/** An action node's result when some items needed nothing doing. */
function actionsOut(recs: Rec[], skipped: string[]): NodeResult {
  if (!recs.length) return { out: { result: OFF, done: false }, note: skipped.length ? skipped.join(' ') : 'Nothing to do.' };
  const r = actionOut(recs);
  return skipped.length ? { ...r, note: `${r.note}. ${skipped.join(' ')}` } : r;
}

/** Lines, stops and buses as they are now (a Wait carries on with fresh figures). */
function fresh(ctx: NodeCtx, v: Value): Value {
  if (Array.isArray(v)) return v.map((x) => fresh(ctx, x));
  if (!isRec(v) || typeof v.id !== 'string') return v;
  if (v.kind === 'line') return ctx.live.line(v.id) ?? v;
  if (v.kind === 'stop') return ctx.live.stop(v.id) ?? v;
  if (v.kind === 'vehicle') return ctx.live.busById(v.id) ?? v;
  return v;
}

/** A bus from "Gaps between buses": its live record with the gaps around it. */
function gapRec(ctx: NodeCtx, b: GapBus, headway: number | null): Rec {
  const s = ctx.game.state;
  const p = b.run.p;
  const next = p.stops[Math.min(b.run.v.stopIdx, p.stops.length - 1)];
  const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  return { ...ctx.live.bus(b.run.v), ahead: r1(b.ahead), behind: r1(b.behind), hold: b.hold, headway, dir: p.index, nextStop: next, nextStopName: s.stops[next]?.name ?? null, towards: s.stops[p.stops[p.stops.length - 1]]?.name ?? null };
}

// "One at a time": the queue lives in the workflow's memory
interface QueueMem { items: Value[]; last: number | null; done: Record<string, Value> }
const itemKey = (v: Value): string => keyOf(v) ?? JSON.stringify(v);
function queueState(ctx: NodeCtx, node: string): QueueMem {
  const k = `@queue:${node}`;
  const m = ctx.memory[k];
  if (isRec(m) && Array.isArray(m.items) && isRec(m.done)) return m as unknown as QueueMem;
  const q: QueueMem = { items: [], last: null, done: {} };
  ctx.memory[k] = q as unknown as Value;
  return q;
}
function releaseQueue(ctx: NodeCtx, cfg: Record<string, Value>, q: QueueMem, added: number): NodeResult {
  const t = ctx.game.t;
  const every = Math.max(1, num(cfg.every) ?? 30) * 60;
  const per = Math.max(1, Math.min(10, num(cfg.per) ?? 1));
  const due = q.last === null ? t : q.last + every;
  const addNote = added ? `${added} added. ` : '';
  if (!q.items.length) return { out: { next: OFF, batch: OFF, waiting: 0 }, note: `${addNote}Nothing waiting.` };
  if (t < due) {
    const r = ctx.later({ kind: 'queue', due, label: `${q.items.length} waiting`, key: 'queue' });
    return { out: { next: OFF, batch: OFF, waiting: q.items.length }, note: `${addNote}${q.items.length} waiting; the next one goes at ${hhmm(due)}.${r.ok || ctx.test ? '' : ` ${r.note}`}` };
  }
  const batch = q.items.splice(0, per).map((x) => fresh(ctx, x));
  for (const x of batch) q.done[itemKey(x)] = t;
  q.last = t;
  if (q.items.length) ctx.later({ kind: 'queue', due: t + every, label: `${q.items.length} waiting`, key: 'queue' });
  return { out: { next: batch[0], batch, waiting: q.items.length }, note: `${addNote}Passed on ${batch.map((x) => fmt(x)).join(', ')}; ${q.items.length ? `${q.items.length} still waiting, the next at ${hhmm(t + every)}` : 'none left'}.` };
}

// "Best pairs": distances between items, and pair records that work as a bus, line or stop
/** A line (or peak) item: distances to it are to its nearest stop. */
function linePoint(v: Value): string | null {
  return isRec(v) && (v.kind === 'line' || v.kind === 'peak') ? idOf(v, 'line') : null;
}
function pairKm(ctx: NodeCtx, pa: LngLat | null, la: string | null, pb: LngLat | null, lb: string | null): number | null {
  const km = (m: number) => Math.round(m / 100) / 10;
  if (la && pb) { const n = nearestStopOfLine(ctx.game, la, pb); return n ? km(n.m) : null; }
  if (lb && pa) { const n = nearestStopOfLine(ctx.game, lb, pa); return n ? km(n.m) : null; }
  if (!pa || !pb) return null;
  const [ax, ay] = ctx.game.geo.xy(pa), [bx, by] = ctx.game.geo.xy(pb);
  return km(Math.hypot(ax - bx, ay - by));
}
function pairRec(a: Value, b: Value, score: number): Rec {
  const pickId = (kind: string) => {
    for (const x of [a, b]) if (isRec(x) && x.kind === kind && typeof x.id === 'string') return x.id;
    return null;
  };
  const line = (isRec(b) && (b.kind === 'line' || b.kind === 'peak') ? idOf(b, 'line') : null) ?? (isRec(a) && (a.kind === 'line' || a.kind === 'peak') ? idOf(a, 'line') : null);
  return { kind: 'pair', id: `${itemKey(a)}+${itemKey(b)}`, label: `${fmt(a)} → ${fmt(b)}`, a, b, score: Math.round(score * 100) / 100, vehicle: pickId('vehicle'), line, stop: pickId('stop') };
}

export const NODES: NodeDef[] = [
  // ── triggers
  {
    type: 'trigger.every', category: 'trigger', label: 'Every few minutes', description: 'Runs on a regular game-time schedule, e.g. every 15 minutes. Pauses and speeds up with the game.',
    inputs: [], outputs: [eventOut], trigger: { source: 'clock' },
    config: [
      { id: 'minutes', label: 'Every', kind: 'number', default: 15, min: 5, max: 720, step: 5, unit: 'min' },
      ...hoursDays,
    ],
    run: (ctx) => ({ out: { event: ctx.event }, note: `Ran at ${str(ctx.event.time)}.` }),
  },
  {
    type: 'trigger.time', category: 'trigger', label: 'At a time of day', description: 'Runs once a day at a set time.',
    inputs: [], outputs: [eventOut], trigger: { source: 'clock' },
    config: [
      { id: 'time', label: 'At', kind: 'time', default: '07:00' },
      { id: 'days', label: 'On', kind: 'select', default: 'all', options: [{ value: 'all', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' }, { value: 'weekend', label: 'Weekends' }] },
    ],
    run: (ctx) => ({ out: { event: ctx.event }, note: `Ran at ${str(ctx.event.time)}.` }),
  },
  {
    type: 'trigger.day', category: 'trigger', label: 'End of the day', description: 'Runs at midnight with the day that just ended: boardings, journeys, fares and costs.',
    inputs: [], outputs: [eventOut, { id: 'summary', label: 'Day summary', type: 'record' }], trigger: { source: 'day' }, config: [],
    run: (ctx) => ({ out: { event: ctx.event, summary: ctx.event }, note: `Day ${str(ctx.event.dayNumber)} ended.` }),
  },
  {
    type: 'trigger.week', category: 'trigger', label: 'End of the week', description: 'Runs at midnight when a game week ends, with the week’s journeys, fares and satisfaction and the change on the week before.',
    inputs: [], outputs: [eventOut, { id: 'summary', label: 'Week summary', type: 'record' }], trigger: { source: 'week' }, config: [],
    run: (ctx) => ({ out: { event: ctx.event, summary: ctx.event }, note: `Week ${str(ctx.event.week)} ended: ${str(ctx.event.journeys)} journeys.` }),
  },
  {
    type: 'trigger.arrive', category: 'trigger', label: 'A bus arrives at a stop', description: 'Runs every time a bus on a trip reaches a stop (filter by line and stop).',
    inputs: [], outputs: [eventOut, { id: 'bus', label: 'Bus', type: 'vehicle' }, { id: 'line', label: 'Line', type: 'line' }, { id: 'stop', label: 'Stop', type: 'stop' }],
    trigger: { source: 'arrive' }, config: [lineCfg('Line', true), { id: 'stop', label: 'Stop', kind: 'stop', default: '', allowAny: true, help: 'Leave empty for any stop.' }, ...eventTiming('trigger.arrive')],
    run: (ctx) => ({ out: { event: ctx.event, ...triggerEntity(ctx) }, note: `${str(ctx.event.fleetNo)} arrived at ${str(ctx.event.stopName)}.` }),
  },
  {
    type: 'trigger.crowded', category: 'trigger', label: 'A crowded bus leaves', description: 'Runs when a bus leaves a stop at or above a load.',
    inputs: [], outputs: [eventOut, { id: 'bus', label: 'Bus', type: 'vehicle' }, { id: 'line', label: 'Line', type: 'line' }, { id: 'stop', label: 'Stop', type: 'stop' }],
    trigger: { source: 'depart' }, config: [{ id: 'load', label: 'Load at least', kind: 'number', default: 85, min: 10, max: 100, unit: '%' }, lineCfg('Line', true), ...eventTiming('trigger.crowded')],
    run: (ctx) => ({ out: { event: ctx.event, ...triggerEntity(ctx) }, note: `${str(ctx.event.fleetNo)} left ${str(ctx.event.stopName)} ${str(ctx.event.occupancy)}% full${num(ctx.event.leftBehind) ? `, ${ctx.event.leftBehind} left behind` : ''}.` }),
  },
  {
    type: 'trigger.late', category: 'trigger', label: 'A bus is running late', description: 'Runs once per trip when a bus leaves a stop later than the threshold.',
    inputs: [], outputs: [eventOut, { id: 'bus', label: 'Bus', type: 'vehicle' }, { id: 'line', label: 'Line', type: 'line' }],
    trigger: { source: 'depart' }, config: [{ id: 'minutes', label: 'Late by at least', kind: 'number', default: 5, min: 1, max: 60, unit: 'min' }, lineCfg('Line', true), ...eventTiming('trigger.late')],
    run: (ctx) => ({ out: { event: ctx.event, ...triggerEntity(ctx) }, note: `${str(ctx.event.fleetNo)} is ${str(ctx.event.delay)} min late at ${str(ctx.event.stopName)}.` }),
  },
  {
    type: 'trigger.missed', category: 'trigger', label: 'A departure is missed', description: 'Runs when a timetabled departure does not run.',
    inputs: [], outputs: [eventOut, { id: 'line', label: 'Line', type: 'line' }], trigger: { source: 'missed' }, config: [lineCfg('Line', true), ...eventTiming('trigger.missed')],
    run: (ctx) => ({ out: { event: ctx.event, line: triggerEntity(ctx).line }, note: `Line ${str(ctx.event.lineNumber)} missed the ${str(ctx.event.dep)} departure.` }),
  },
  {
    type: 'trigger.breakdown', category: 'trigger', label: 'A bus breaks down', description: 'Runs when a bus breaks down.',
    inputs: [], outputs: [eventOut, { id: 'bus', label: 'Bus', type: 'vehicle' }, { id: 'line', label: 'Line', type: 'line' }], trigger: { source: 'breakdown' }, config: [lineCfg('Line', true), ...eventTiming('trigger.breakdown')],
    run: (ctx) => ({ out: { event: ctx.event, ...triggerEntity(ctx) }, note: `${str(ctx.event.fleetNo)} broke down.` }),
  },
  {
    type: 'trigger.waiting', category: 'trigger', label: 'Many people waiting', description: 'Runs when the number waiting at a stop rises above a threshold (again only after it has dropped well below).',
    inputs: [], outputs: [eventOut, { id: 'stop', label: 'Stop', type: 'stop' }], trigger: { source: 'condition' },
    config: [{ id: 'threshold', label: 'At least', kind: 'number', default: 30, min: 2, max: 500, unit: 'people' }, lineCfg('On line', true), forCfg(0), ...hoursDays],
    run: (ctx) => ({ out: { event: ctx.event, stop: triggerEntity(ctx).stop }, note: `${str(ctx.event.waiting)} people waiting at ${str(ctx.event.stopName)}.` }),
  },
  {
    type: 'trigger.balance', category: 'trigger', label: 'Balance falls below', description: 'Runs when the bank balance drops below an amount.',
    inputs: [], outputs: [eventOut, { id: 'company', label: 'Company', type: 'record' }], trigger: { source: 'condition' },
    config: [{ id: 'amount', label: 'Below', kind: 'number', default: 20000, min: -1_000_000, max: 100_000_000, step: 1000 }, forCfg(0)],
    run: (ctx) => ({ out: { event: ctx.event, company: ctx.live.company() }, note: `Balance ${str(ctx.event.balance)}.` }),
  },
  {
    type: 'trigger.watch', category: 'trigger', label: 'Watch a figure',
    description: 'Runs when a figure goes above or below a value and stays there: a line’s load or punctuality, people waiting at a stop, a bus’s condition, your reputation… Checked every minute, for each line, stop or bus. It fires again only once the figure is back to normal.',
    inputs: [], outputs: [eventOut, { id: 'item', label: 'Line, stop or bus', type: 'record', help: 'The line, stop or bus (or the company) whose figure crossed the value, with its live figures.' }, { id: 'value', label: 'Figure', type: 'number' }],
    trigger: { source: 'condition' },
    config: [
      { id: 'figure', label: 'Watch', kind: 'select', default: 'line.load3h', options: FIGURE_OPTIONS },
      { id: 'line', label: 'Only on line', kind: 'line', default: '', allowAny: true, help: 'For line, stop and bus figures: only this line, its stops or its buses. Leave empty for all.' },
      { id: 'op', label: 'When it goes', kind: 'select', default: 'above', options: [{ value: 'above', label: 'Above' }, { value: 'below', label: 'Below' }] },
      { id: 'value', label: 'Value', kind: 'number', default: 85, min: -100_000_000, max: 100_000_000 },
      forCfg(10),
      { id: 'again', label: 'Fire again', kind: 'select', default: 'margin', section: 'timing', options: [{ value: 'margin', label: 'Once it is clearly back (by a tenth)' }, { value: 'clear', label: 'As soon as it is back' }], help: 'After firing it waits for the figure to come back before it can fire again for the same line, stop or bus.' },
      ...hoursDays,
    ],
    run: (ctx) => {
      const e = ctx.event;
      const kind = str(e.scope), id = str(e.itemId);
      const item = kind === 'line' ? ctx.live.line(id) : kind === 'stop' ? ctx.live.stop(id) : kind === 'bus' ? ctx.live.busById(id) : ctx.live.company();
      const fig = FIGURE[str(e.figure)];
      return { out: { event: e, item: item ?? OFF, value: num(e.value) ?? OFF }, note: `${str(e.name)}: ${fig?.label.toLowerCase() ?? 'figure'} ${str(e.reading)} (${str(e.op) === 'below' ? 'below' : 'above'} ${str(e.threshold)}${num(e.for) ? ` for ${e.for} min` : ''}).` };
    },
  },
  {
    type: 'trigger.shortBuses', category: 'trigger', label: 'A line is short of buses',
    description: 'Runs when a line has fewer working buses than its timetable needs right now (buses under maintenance or broken down do not count). Every departure it cannot run is missed, and missed departures cost reputation. Fires again only once the line is covered.',
    inputs: [], outputs: [eventOut, { id: 'line', label: 'Line', type: 'line' }, { id: 'short', label: 'Buses short', type: 'number' }], trigger: { source: 'condition' },
    config: [lineCfg('Line', true), forCfg(0), ...hoursDays],
    run: (ctx) => ({ out: { event: ctx.event, line: triggerEntity(ctx).line, short: num(ctx.event.short) ?? 0 }, note: `Line ${str(ctx.event.lineNumber)} needs ${str(ctx.event.needed)} buses now and has ${str(ctx.event.buses)} working.` }),
  },
  {
    type: 'trigger.peak', category: 'trigger', label: 'Peak hours start or end',
    description: 'Runs for each line a set time before its peak hours start, or after they end. Peak hours come from its timetable (when it needs the most buses) or its riders (its busiest hours over the last week). Use it to bring in a spare bus before the rush and park it again afterwards.',
    inputs: [], trigger: { source: 'clock' },
    outputs: [eventOut, { id: 'line', label: 'Line', type: 'line' }, { id: 'peak', label: 'Peak', type: 'record' }, { id: 'buses', label: 'Buses to add or free', type: 'number', help: 'Before the start: buses the line needs at its peak beyond those it has working. After the end: buses it can now spare.' }],
    config: [
      lineCfg('Line', true),
      { id: 'at', label: 'When', kind: 'select', default: 'start', options: [{ value: 'start', label: 'Before the peak starts' }, { value: 'end', label: 'After the peak ends' }] },
      { id: 'minutes', label: 'How long', kind: 'number', default: 30, min: 0, max: 180, step: 5, unit: 'min', help: 'Before the start, or after the end. A bus from the depot needs a few minutes to get ready and then drives to the line.' },
      peakSourceCfg,
      daysCfg,
    ],
    run: (ctx) => {
      const e = ctx.event;
      const peak: Rec = { kind: 'peak', id: `${str(e.line)}:${str(e.from)}`, line: e.line ?? null, lineNumber: e.lineNumber ?? null, name: `Line ${str(e.lineNumber)} ${str(e.period)}`, from: e.from ?? null, to: e.to ?? null, period: e.period ?? null, need: e.need ?? null, has: e.has ?? null, riders: e.riders ?? null, source: e.peakSource ?? null };
      const n = num(e.buses) ?? 0;
      if (!e.period) return { out: { event: e, line: OFF, peak: OFF, buses: OFF }, note: 'No line has peak hours today.' };
      const example = e.example ? 'No line has peak hours today, so this test uses an example. ' : '';
      const what = example + (e.at === 'end'
        ? `Line ${str(e.lineNumber)}’s peak ${str(e.period)} has ended: it can spare ${n} bus${n === 1 ? '' : 'es'} now.`
        : `Line ${str(e.lineNumber)}’s peak ${str(e.period)} is coming: it needs ${str(e.need)} buses and has ${str(e.has)} working${n ? `, ${n} short` : ''}.`);
      return { out: { event: e, line: triggerEntity(ctx).line, peak, buses: n }, note: what };
    },
  },
  {
    type: 'trigger.leftBehind', category: 'trigger', label: 'People left behind',
    description: 'Runs when a full bus leaves people behind at a stop.',
    inputs: [], outputs: [eventOut, { id: 'bus', label: 'Bus', type: 'vehicle' }, { id: 'line', label: 'Line', type: 'line' }, { id: 'stop', label: 'Stop', type: 'stop' }], trigger: { source: 'leftBehind' },
    config: [{ id: 'people', label: 'At least', kind: 'number', default: 5, min: 1, max: 200, unit: 'people' }, lineCfg('Line', true), ...eventTiming('trigger.leftBehind', 20)],
    run: (ctx) => ({ out: { event: ctx.event, ...triggerEntity(ctx) }, note: `${str(ctx.event.fleetNo)} was full at ${str(ctx.event.stopName)}: ${str(ctx.event.leftBehind)} left behind.` }),
  },
  {
    type: 'trigger.gaveUp', category: 'trigger', label: 'People give up waiting',
    description: 'Runs when people waiting at a stop give up and travel another way: at least this many at one stop within the last hour. Fires again for that stop only once it has calmed down.',
    inputs: [], outputs: [eventOut, { id: 'stop', label: 'Stop', type: 'stop' }], trigger: { source: 'condition' },
    config: [{ id: 'people', label: 'At least', kind: 'number', default: 8, min: 1, max: 500, unit: 'people' }, lineCfg('On line', true), forCfg(0), ...hoursDays],
    run: (ctx) => ({ out: { event: ctx.event, stop: triggerEntity(ctx).stop }, note: `${str(ctx.event.gaveUp)} people gave up waiting at ${str(ctx.event.stopName)} in the last hour.` }),
  },
  {
    type: 'trigger.forecast', category: 'trigger', label: 'Tomorrow’s forecast', description: 'Runs at 18:00 when tomorrow’s weather forecast comes out. About 8 forecasts in 10 are right; a miss is usually close.',
    inputs: [], outputs: [eventOut, { id: 'forecast', label: 'Forecast', type: 'record' }], trigger: { source: 'forecast' },
    config: [{ id: 'when', label: 'When it says', kind: 'select', default: 'any', options: FORECAST_FILTER }],
    run: (ctx) => ({ out: { event: ctx.event, forecast: weatherRecs(ctx.game).tomorrow ?? OFF }, note: `Forecast for tomorrow: ${str(ctx.event.label)}, ${str(ctx.event.high)} °C, ${str(ctx.event.chanceOfRain)}% chance of rain.` }),
  },
  {
    type: 'trigger.weather', category: 'trigger', label: 'The weather changes', description: 'Runs on the hour when the weather changes: rain starts, heavy rain or snow starts, or it dries up. Roads are slower in rain and fewer people walk or cycle.',
    inputs: [], outputs: [eventOut, { id: 'weather', label: 'Weather now', type: 'record' }], trigger: { source: 'weather' },
    config: [
      { id: 'when', label: 'When', kind: 'select', default: 'rain', options: WEATHER_FILTER },
      { id: 'from', label: 'From', kind: 'number', default: 0, min: 0, max: 23, unit: 'h', help: 'Only between these hours of the day.' },
      { id: 'to', label: 'Until', kind: 'number', default: 24, min: 1, max: 24, unit: 'h' },
    ],
    run: (ctx) => ({ out: { event: ctx.event, weather: weatherRecs(ctx.game).now }, note: `${str(ctx.event.label)} from ${str(ctx.event.time)} (was ${str(ctx.event.wasLabel).toLowerCase()}).` }),
  },
  {
    type: 'trigger.eventAnnounced', category: 'trigger', label: 'An event is announced', description: 'Runs when a match, concert, festival or gathering is announced (usually 3 to 10 days ahead, short-notice ones the day before), or when a rail or flight disruption begins.',
    inputs: [], outputs: eventOuts, trigger: { source: 'eventAnnounced' }, config: [eventKindCfg('any'), minPeopleCfg, nearLineCfg],
    run: (ctx) => eventTriggerOut(ctx, 'Announced'),
  },
  {
    type: 'trigger.eventStart', category: 'trigger', label: 'Before an event starts', description: 'Runs a set time before an announced event starts, once per event. Crowds arrive over the three hours before a match.',
    inputs: [], outputs: eventOuts, trigger: { source: 'condition' },
    config: [{ id: 'minutes', label: 'Minutes before', kind: 'number', default: 90, min: 0, max: 360, step: 5, unit: 'min' }, eventKindCfg(), minPeopleCfg, nearLineCfg],
    run: (ctx) => eventTriggerOut(ctx, 'Starting soon'),
  },
  {
    type: 'trigger.eventEnd', category: 'trigger', label: 'When an event ends', description: 'Runs a set time before or after an event ends, once per event. Most people leave within half an hour of the end; a match may go to extra time.',
    inputs: [], outputs: eventOuts, trigger: { source: 'condition' },
    config: [{ id: 'minutes', label: 'Minutes after the end', kind: 'number', default: -10, min: -120, max: 120, step: 5, unit: 'min', help: 'Negative: before the end (for example -10 to have buses waiting when it finishes).' }, eventKindCfg(), minPeopleCfg, nearLineCfg],
    run: (ctx) => eventTriggerOut(ctx, 'Ending'),
  },
  {
    type: 'trigger.calendar', category: 'trigger', label: 'A kind of day', description: 'Runs at a set time on days of a kind: school holidays, public holidays, exam weeks, weekends or a season. The calendar is a typical pattern, not real dates.',
    inputs: [], outputs: [eventOut, { id: 'calendar', label: 'Calendar', type: 'record' }], trigger: { source: 'clock' },
    config: [
      { id: 'day', label: 'On', kind: 'select', default: 'school_holidays', options: DAY_FILTER },
      { id: 'time', label: 'At', kind: 'time', default: '05:00' },
      { id: 'first', label: 'Only the first day of a run', kind: 'boolean', default: true, help: 'For example the first day of the school holidays, not every day of them.' },
    ],
    run: (ctx) => ({ out: { event: ctx.event, calendar: calendarRec(ctx.game) }, note: `${str(calendarRec(ctx.game).label)}, ${str(ctx.event.time)}.` }),
  },
  {
    type: 'trigger.manual', category: 'trigger', label: 'Run by hand', description: 'Runs when you press Run in Automation Studio.',
    inputs: [], outputs: [eventOut], trigger: { source: 'manual' }, config: [],
    run: (ctx) => ({ out: { event: ctx.event }, note: 'Started by hand.' }),
  },

  // ── data
  {
    type: 'data.lines', category: 'data', label: 'All lines', description: 'Every line with its live figures: occupancy, waiting, buses, delay, on time.',
    inputs: [afterIn], outputs: [{ id: 'lines', label: 'Lines', type: 'list' }], config: [],
    run: (ctx) => {
      const out = Object.keys(ctx.game.state.routes).map((id) => ctx.live.line(id)!).filter(Boolean);
      ctx.spend(out.length);
      return { out: { lines: out }, note: `${out.length} line${out.length === 1 ? '' : 's'}.` };
    },
  },
  {
    type: 'data.line', category: 'data', label: 'Line', description: 'One line and its live figures (pick it, or connect one).',
    inputs: [afterIn, { id: 'line', label: 'Line', type: 'line', optional: true }], outputs: [{ id: 'line', label: 'Line', type: 'line' }, { id: 'occupancy', label: 'Occupancy %', type: 'number' }, { id: 'waiting', label: 'Waiting', type: 'number' }],
    config: [lineCfg()],
    run: (ctx, inp, cfg) => {
      const id = idOf(inp.line, 'line') ?? str(cfg.line);
      const r = id ? ctx.live.line(id) : null;
      if (!r) throw new Error(id ? 'That line no longer exists.' : 'Choose a line.');
      return { out: { line: r, occupancy: r.occupancy, waiting: r.waiting }, note: `Line ${str(r.number)}: ${str(r.occupancy)}% full on average, ${str(r.waiting)} waiting.` };
    },
  },
  {
    type: 'data.stops', category: 'data', label: 'Stops', description: 'Stops with the people waiting now and today’s figures (optionally one line’s stops).',
    inputs: [afterIn, { id: 'line', label: 'Line', type: 'line', optional: true }], outputs: [{ id: 'stops', label: 'Stops', type: 'list' }], config: [lineCfg('Line', true)],
    run: (ctx, inp, cfg) => {
      const s = ctx.game.state;
      const lid = idOf(inp.line, 'line') ?? (str(cfg.line) || null);
      const r = lid ? s.routes[lid] : null;
      const ids = r ? [...new Set([...r.stops, ...(r.returnStops ?? [])])] : Object.keys(s.stops);
      const out = ids.map((id) => ctx.live.stop(id)).filter((x): x is Rec => !!x).slice(0, 500);
      ctx.spend(out.length);
      return { out: { stops: out }, note: `${out.length} stop${out.length === 1 ? '' : 's'}.` };
    },
  },
  {
    type: 'data.stop', category: 'data', label: 'Stop', description: 'One stop: waiting now, longest wait, today’s boardings.',
    inputs: [afterIn, { id: 'stop', label: 'Stop', type: 'stop', optional: true }], outputs: [{ id: 'stop', label: 'Stop', type: 'stop' }, { id: 'waiting', label: 'Waiting', type: 'number' }],
    config: [{ id: 'stop', label: 'Stop', kind: 'stop', default: '' }],
    run: (ctx, inp, cfg) => {
      const id = idOf(inp.stop, 'stop') ?? str(cfg.stop);
      const r = id ? ctx.live.stop(id) : null;
      if (!r) throw new Error(id ? 'That stop no longer exists.' : 'Choose a stop.');
      return { out: { stop: r, waiting: r.waiting }, note: `${str(r.name)}: ${str(r.waiting)} waiting.` };
    },
  },
  {
    type: 'data.buses', category: 'data', label: 'Buses', description: 'Buses with their status, load and condition. Filter by line or by what they are doing.',
    inputs: [afterIn, { id: 'line', label: 'Line', type: 'line', optional: true }], outputs: [{ id: 'buses', label: 'Buses', type: 'list' }],
    config: [lineCfg('Line', true), { id: 'which', label: 'Which', kind: 'select', default: 'all', options: [{ value: 'all', label: 'All' }, { value: 'free', label: 'Free now' }, { value: 'spare', label: 'Spare (no line)' }, { value: 'parked', label: 'Spare and parked at a depot' }, { value: 'notNeeded', label: 'Not needed by their line for the next hour' }, { value: 'working', label: 'On a trip' }] }],
    run: (ctx, inp, cfg) => {
      const lid = idOf(inp.line, 'line') ?? (str(cfg.line) || null);
      const which = str(cfg.which);
      let list = ctx.game.vehicleList().map((v) => ctx.live.bus(v));
      if (lid) list = list.filter((b) => b.line === lid);
      if (which === 'free') list = list.filter((b) => b.free);
      if (which === 'spare') list = list.filter((b) => b.spare);
      if (which === 'working') list = list.filter((b) => b.status === 'in_service' || b.status === 'at_stop');
      if (which === 'parked') list = list.filter((b) => b.spare && b.status === 'parked');
      if (which === 'notNeeded') {
        const ok = new Set((lid ? [lid] : Object.keys(ctx.game.state.routes)).flatMap((r) => busesNotNeeded(ctx.game, r).map((v) => v.id)));
        list = list.filter((b) => ok.has(String(b.id)));
      }
      ctx.spend(list.length);
      return { out: { buses: list }, note: `${list.length} bus${list.length === 1 ? '' : 'es'}.` };
    },
  },
  {
    type: 'data.bus', category: 'data', label: 'Bus', description: 'One bus: its line, what it is doing, load and condition (pick it, or connect one).',
    inputs: [afterIn, { id: 'bus', label: 'Bus', type: 'vehicle', optional: true }], outputs: [{ id: 'bus', label: 'Bus', type: 'vehicle' }, { id: 'load', label: 'Passengers', type: 'number' }],
    config: [{ id: 'bus', label: 'Bus', kind: 'vehicle', default: '' }],
    run: (ctx, inp, cfg) => {
      const id = idOf(inp.bus, 'vehicle') ?? str(cfg.bus);
      const b = id ? ctx.live.busById(id) : null;
      if (!b) throw new Error(id ? 'That bus no longer exists.' : 'Choose a bus.');
      return { out: { bus: b, load: b.load }, note: `${str(b.fleetNo)}: ${str(b.statusLabel)}, ${str(b.load)} on board.` };
    },
  },
  {
    type: 'data.findBus', category: 'data', label: 'Find a free bus', description: 'The bus that could start an extra trip on a line soonest: one of the line’s own idle buses, or a spare at a depot. Buses carrying passengers are never chosen.',
    inputs: [{ id: 'line', label: 'Line', type: 'line', optional: true }], outputs: [{ id: 'bus', label: 'Bus', type: 'vehicle' }, { id: 'found', label: 'Found', type: 'boolean' }],
    config: [lineCfg(), { id: 'from', label: 'Take from', kind: 'select', default: 'both', options: [{ value: 'both', label: 'The line or spares' }, { value: 'line', label: 'Only the line’s buses' }, { value: 'spare', label: 'Only spare buses' }] }],
    run: (ctx, inp, cfg) => {
      const game = ctx.game;
      const lid = idOf(inp.line, 'line') ?? str(cfg.line);
      const r = lid ? game.state.routes[lid] : null;
      if (!r) throw new Error(lid ? 'That line no longer exists.' : 'Choose or connect a line.');
      const p = game.patterns.get(r.id)?.find((x) => x.valid);
      if (!p) return { out: { bus: OFF, found: false }, note: `Line ${r.number} has no drivable route.` };
      const from = str(cfg.from) || 'both';
      let best: { v: string; ready: number } | null = null;
      for (const v of game.vehicleList()) {
        if (!(v.route === r.id && from !== 'spare') && !(v.route === null && from !== 'line')) continue;
        const o = extraOption(game, v, p.path.nodes[0], game.t);
        if (o && (!best || o.ready < best.ready)) best = { v: v.id, ready: o.ready };
      }
      ctx.spend(game.vehicleList().length);
      if (!best) return { out: { bus: OFF, found: false }, note: `No free bus for line ${r.number}.` };
      const bus: Rec = { ...(ctx.live.busById(best.v) as Rec), readyAt: hhmm(best.ready) };
      return { out: { bus, found: true }, note: `${str(bus.fleetNo)} could start at ${hhmm(best.ready)}.` };
    },
  },
  {
    type: 'data.peaks', category: 'data', label: 'Peak hours',
    description: 'When lines are busiest today, from the timetable (the hours a line needs the most buses) or from riders (its busiest hours on recent days of the same kind). Each peak comes with its times and the buses it needs, plus riders and buses needed hour by hour, and a summary that points out lines whose peaks are at different times (they can share buses).',
    inputs: [afterIn, { id: 'line', label: 'Line', type: 'line', optional: true }],
    outputs: [{ id: 'peaks', label: 'Peaks', type: 'list' }, { id: 'busiest', label: 'Biggest peak', type: 'record' }, { id: 'hours', label: 'Hour by hour', type: 'list' }, { id: 'summary', label: 'In words', type: 'text' }],
    config: [lineCfg('Line', true), peakSourceCfg],
    run: (ctx, inp, cfg) => {
      const game = ctx.game, s = game.state;
      const lid = idOf(inp.line, 'line') ?? (str(cfg.line) || null);
      if (lid && !s.routes[lid]) throw new Error('That line no longer exists.');
      const source = srcOf(cfg);
      const lines = (lid ? [s.routes[lid]] : Object.values(s.routes)).filter((r) => !r.suspended);
      ctx.spend(lines.length * 24);
      const per = lines.map((r) => ({ r, peaks: linePeaks(game, r.id, source) }));
      const peaks = per.flatMap((x) => x.peaks.map((p) => peakRec(game, p)));
      const big = per.flatMap((x) => x.peaks).sort((a, b) => (source === 'riders' ? (b.riders ?? 0) - (a.riders ?? 0) : b.need - a.need))[0];
      // hour by hour, in service-day order from 03:00
      const rid = ridersByHour(game, lid);
      const steps = lines.map((r) => needSteps(game, r.id));
      const hours: Value[] = Array.from({ length: 24 }, (_, i) => {
        const h = (3 + i) % 24, m = (h < 3 ? h + 24 : h) * 60;
        return { kind: 'hour', id: String(h), hour: h, time: minutesLabel(m), riders: rid.hours[h], need: steps.reduce((x, st) => x + needAt(st, m + 30), 0) };
      });
      // in words, with lines whose peaks never overlap
      const parts = per.filter((x) => x.peaks.length).map((x) => `Line ${x.r.number}: ${peaksText(x.peaks)}${source === 'timetable' ? ` (${Math.max(...x.peaks.map((p) => p.need))} buses)` : ''}`);
      const pairs: string[] = [];
      const withPeaks = per.filter((x) => x.peaks.length);
      for (let i = 0; i < withPeaks.length && pairs.length < 3; i++) for (let j = i + 1; j < withPeaks.length && pairs.length < 3; j++) {
        if (overlapMinutes(withPeaks[i].peaks, withPeaks[j].peaks) === 0) pairs.push(`${withPeaks[i].r.number} and ${withPeaks[j].r.number}`);
      }
      const none = source === 'riders' && !rid.days ? 'No full day of riders recorded yet.' : lid ? `Line ${s.routes[lid].number} has no clear peak hours today${source === 'timetable' ? ': its timetable needs the same buses all day' : ''}.` : 'No line has clear peak hours today.';
      const summary = parts.length
        ? `${parts.join('. ')}.${pairs.length ? ` Lines ${pairs.join(', ')} peak at different times, so they could share buses.` : ''}${source === 'riders' ? ` From ${rid.days} recorded ${rid.kind === 'all days' ? 'days' : rid.kind}.` : ''}`
        : none;
      return { out: { peaks, busiest: big ? peakRec(game, big) : OFF, hours, summary }, note: summary };
    },
  },
  {
    type: 'data.borrow', category: 'data', label: 'Buses to borrow',
    description: 'Buses that could join a line now and stay until its peak is over: spare buses parked at a depot first, then buses other lines will not need until then (lines whose own peak is at another time). Never a bus carrying passengers, and never one its line still needs.',
    inputs: [afterIn, { id: 'line', label: 'Line', type: 'line', optional: true }, { id: 'count', label: 'How many', type: 'number', optional: true }],
    outputs: [{ id: 'buses', label: 'Buses', type: 'list' }, { id: 'bus', label: 'First bus', type: 'vehicle' }, { id: 'lenders', label: 'Lines that can lend', type: 'list' }, { id: 'found', label: 'Found', type: 'boolean' }],
    config: [
      lineCfg(),
      { id: 'count', label: 'How many', kind: 'number', default: 1, min: 0, max: 10 },
      { id: 'from', label: 'Take from', kind: 'select', default: 'both', options: [{ value: 'both', label: 'Spares, then other lines' }, { value: 'spare', label: 'Only spare buses' }, { value: 'lines', label: 'Only other lines' }] },
      { id: 'until', label: 'Needed until', kind: 'select', default: 'peak', options: [{ value: 'peak', label: 'The end of the line’s peak (timetable)' }, { value: 'hour', label: 'An hour from now' }], help: 'A line lends a bus only if it will not need it before then.' },
    ],
    run: (ctx, inp, cfg) => {
      const game = ctx.game, s = game.state;
      const lid = idOf(inp.line, 'line') ?? str(cfg.line);
      const r = lid ? s.routes[lid] : null;
      if (!r) throw new Error(lid ? 'That line no longer exists.' : 'Choose or connect a line.');
      const count = Math.max(0, Math.min(10, Math.round(num(inp.count) ?? num(cfg.count) ?? 1)));
      const m = nowMinute(game);
      const pk = str(cfg.until) === 'hour' ? null : currentOrNextPeak(game, r.id, 'timetable');
      const until = pk ? pk.peak.to : m + 60;
      const from = str(cfg.from) || 'both';
      ctx.spend(Object.keys(s.vehicles).length + Object.keys(s.routes).length * 4);
      const { loans, lenders } = busesToBorrow(game, r.id, until, { spares: from !== 'lines', lines: from !== 'spare' });
      const picked = loans.slice(0, count);
      const buses: Value[] = picked.map((l) => ({ ...ctx.live.bus(l.bus), fromLine: l.from ? s.routes[l.from]?.number ?? null : null, readyAt: Number.isFinite(l.ready) ? hhmm(l.ready) : null }));
      const lend: Value[] = lenders.map((x) => ({ ...(ctx.live.line(x.line) ?? {}), canLend: x.canLend }));
      const why = `until ${minutesLabel(until)}${pk ? ` (the end of its peak ${periodLabel(pk.peak.from, pk.peak.to)})` : ''}`;
      const note = !count ? 'Asked for no buses.' : picked.length
        ? `${picked.map((l) => `${l.bus.fleetNo}${l.from ? ` from line ${s.routes[l.from]?.number ?? '?'}` : ' (spare)'}`).join(', ')} could join line ${r.number} ${why}.`
        : `No bus free to join line ${r.number} ${why}: no spare is parked and no other line can do without one.`;
      return { out: { buses, bus: buses.length ? buses[0] : OFF, lenders: lend, found: buses.length > 0 }, note };
    },
  },
  {
    type: 'data.company', category: 'data', label: 'Company', description: 'Balance, reputation, level, fare and today’s result.',
    inputs: [afterIn], outputs: [{ id: 'company', label: 'Company', type: 'record' }, { id: 'balance', label: 'Balance', type: 'number' }], config: [],
    run: (ctx) => { const c = ctx.live.company(); return { out: { company: c, balance: c.balance } }; },
  },
  {
    type: 'data.time', category: 'data', label: 'Time', description: 'The game clock: time, hour, weekday, weekend.',
    inputs: [afterIn], outputs: [{ id: 'time', label: 'Time', type: 'record' }, { id: 'hour', label: 'Hour', type: 'number' }], config: [],
    run: (ctx) => { const t = ctx.live.time(); return { out: { time: t, hour: t.hour } }; },
  },
  {
    type: 'data.weather', category: 'data', label: 'Weather', description: 'The weather now (rain, temperature), today’s weather and tomorrow’s forecast once it is out at 18:00.',
    inputs: [afterIn],
    outputs: [{ id: 'now', label: 'Now', type: 'record' }, { id: 'today', label: 'Today', type: 'record' }, { id: 'tomorrow', label: 'Tomorrow (forecast)', type: 'record' }, { id: 'raining', label: 'Raining now', type: 'boolean' }, { id: 'temp', label: 'Temperature', type: 'number' }],
    config: [],
    run: (ctx) => {
      const w = weatherRecs(ctx.game);
      return { out: { now: w.now, today: w.today, tomorrow: w.tomorrow ?? OFF, raining: !!w.now.raining || !!w.now.snow, temp: w.now.temp }, note: `${str(w.now.label)}, ${str(w.now.temp)} °C. Today: ${str(w.today.label).toLowerCase()}.${w.tomorrow ? ` Tomorrow: ${str(w.tomorrow.label).toLowerCase()}.` : ' No forecast for tomorrow yet.'}` };
    },
  },
  {
    type: 'data.calendar', category: 'data', label: 'Calendar', description: 'Today’s season and week, and the kind of day: weekend, public holiday, school day or holidays, university teaching, exams or break (a typical pattern).',
    inputs: [afterIn],
    outputs: [{ id: 'calendar', label: 'Calendar', type: 'record' }, { id: 'schoolHolidays', label: 'School holidays', type: 'boolean' }, { id: 'publicHoliday', label: 'Public holiday', type: 'boolean' }],
    config: [],
    run: (ctx) => {
      const c = calendarRec(ctx.game);
      return { out: { calendar: c, schoolHolidays: !!c.schoolHolidays, publicHoliday: !!c.publicHoliday }, note: `${str(c.season)}, week ${str(c.seasonWeek)}: ${str(c.label).toLowerCase()}.` };
    },
  },
  {
    type: 'data.events', category: 'data', label: 'Events', description: 'Announced events under way or coming up, soonest first: matches, concerts, festivals, gatherings and disruptions.',
    inputs: [afterIn],
    outputs: [{ id: 'events', label: 'Events', type: 'list' }, { id: 'next', label: 'Next event', type: 'record' }, { id: 'count', label: 'How many', type: 'number' }],
    config: [
      { id: 'hours', label: 'Within', kind: 'select', default: '24', options: [{ value: '3', label: 'The next 3 hours' }, { value: '24', label: 'The next day' }, { value: '72', label: 'The next 3 days' }, { value: '240', label: 'The next 10 days' }] },
      eventKindCfg('any'),
      nearLineCfg,
    ],
    run: (ctx, _inp, cfg) => {
      const list = eventsAhead(ctx.game, Number(cfg.hours) || 24, str(cfg.kinds) || 'any', str(cfg.line) || undefined).map((ev) => eventRec(ctx.game, ev));
      ctx.spend(list.length);
      return { out: { events: list, next: list[0] ?? OFF, count: list.length }, note: list.length ? `${list.length} event${list.length === 1 ? '' : 's'}; next: ${str(list[0].title)}, ${str(list[0].when)}.` : 'No events in that time.' };
    },
  },
  {
    type: 'data.place', category: 'data', label: 'Places', description: 'Airports, stations, hospitals, universities, stadiums and other places of a kind, largest first: your nearest stop, the lines there, and the model’s estimate of trips today and how busy the place is this hour.',
    inputs: [afterIn],
    outputs: [{ id: 'places', label: 'Places', type: 'list' }, { id: 'first', label: 'Largest', type: 'record' }, { id: 'lines', label: 'Lines at the largest', type: 'list' }, { id: 'unserved', label: 'Not served', type: 'list' }, { id: 'count', label: 'How many', type: 'number' }],
    config: [
      { id: 'category', label: 'Kind', kind: 'select', default: 'airport', options: PLACE_FILTER },
      { id: 'line', label: 'Near line', kind: 'line', default: '', allowAny: true, help: 'Only places within a kilometre of this line’s stops. Leave empty for the whole map.' },
      { id: 'limit', label: 'At most', kind: 'number', default: 10, min: 1, max: 20 },
    ],
    run: (ctx, _inp, cfg) => {
      const list = placesOf(ctx.game, str(cfg.category) || 'any', str(cfg.line) || undefined, Math.max(1, Math.min(20, num(cfg.limit) || 10)));
      ctx.spend(list.length * 20);
      const recs = list.map((p) => placeRec(ctx.game, p));
      const unserved = recs.filter((r) => !r.served);
      const kind = PLACE_FILTER.find((x) => x.value === str(cfg.category))?.label.toLowerCase() ?? 'places';
      const lines = recs[0] && Array.isArray(recs[0].lines) ? recs[0].lines : [];
      return {
        // with no line at the largest place, nothing connected to its lines runs
        out: { places: recs, first: recs[0] ?? OFF, lines: lines.length ? lines : OFF, unserved, count: recs.length },
        note: recs.length
          ? `${recs.length} place${recs.length === 1 ? '' : 's'} (${kind}), ${unserved.length} without one of your stops within ${PLACE_SERVED_M} m.${lines.length ? '' : ` None of your lines stops at ${str(recs[0].name)}.`} Trips and busyness are the model’s estimate.`
          : 'No places of that kind on this map.',
      };
    },
  },
  {
    type: 'data.unserved', category: 'data', label: 'Unserved trips', description: 'The busiest connections between two of your areas that your network does not link today, from the demand model: trips a day by every mode and purpose, and whether a stop or a line is missing.',
    inputs: [afterIn],
    outputs: [{ id: 'flows', label: 'Connections', type: 'list' }, { id: 'first', label: 'Busiest', type: 'record' }, { id: 'count', label: 'How many', type: 'number' }, { id: 'trips', label: 'Trips', type: 'number' }],
    config: [{ id: 'limit', label: 'Busiest (estimate)', kind: 'number', default: 5, min: 1, max: 20 }],
    run: (ctx, _inp, cfg) => {
      const n = Math.max(1, Math.min(20, num(cfg.limit) || 5));
      ctx.spend(400);
      // between two different areas: trips within one area are mostly short walks, not corridors
      const between = estimatedDemand(ctx.game, { level: 'zone', view: 'unserved' }).flows.filter((f) => f.o !== f.d);
      const unserved = between.reduce((a, f) => a + f.trips, 0);
      const flows: Value[] = between.slice(0, n).map((f) => {
        // a first sketch of a line: your stops along the road between the two areas
        const a = areaStop(ctx.game, f.o), b = areaStop(ctx.game, f.d);
        const stops = a && b ? corridorStops(ctx.game, a, b) : null;
        if (stops) ctx.spend(40);
        return {
          kind: 'flow', from: f.oLabel, to: f.dLabel, label: `${f.oLabel} → ${f.dLabel}`, trips: Math.round(f.trips), value: Math.round(f.trips),
          missing: f.noStop >= f.noLink ? 'stop' : 'line', fromArea: f.o, toArea: f.d, fromStop: a, toStop: b, stops: stops ?? [], estimate: true,
        };
      });
      const first = flows[0] as Rec | undefined;
      return {
        out: { flows, first: first ?? OFF, count: flows.length, trips: Math.round(unserved) },
        note: first ? `Estimate: about ${Math.round(unserved).toLocaleString('en-GB')} trips a day between your areas that your network does not link; the busiest is ${str(first.label)} (about ${Number(first.trips).toLocaleString('en-GB')}).` : 'The model finds no unlinked trips between your areas today.',
      };
    },
  },
  {
    type: 'data.demandForecast', category: 'data', label: 'Demand forecast', description: 'Expected riders per line for each of the next few hours, from the demand model: the lines running then, today’s weather, announced events and people due home. An estimate: riders also depend on how your buses perform.',
    inputs: [afterIn],
    outputs: [{ id: 'lines', label: 'Lines', type: 'list' }, { id: 'hours', label: 'By hour', type: 'list' }, { id: 'busiest', label: 'Busiest line', type: 'record' }, { id: 'total', label: 'Riders', type: 'number' }],
    config: [
      { id: 'hours', label: 'Estimate for', kind: 'select', default: '3', options: [{ value: '1', label: 'The next hour' }, { value: '3', label: 'The next 3 hours' }, { value: '6', label: 'The next 6 hours' }] },
      lineCfg('Line', true),
    ],
    run: (ctx, _inp, cfg) => {
      const hours = Math.max(1, Math.min(6, Number(cfg.hours) || 3));
      ctx.spend(hours * 60);
      const f = demandForecast(ctx.game, hours, str(cfg.line) || undefined);
      if (!f) throw new Error('The demand model is not available in this game.');
      const top = f.lines[0];
      const scope = str(cfg.line) ? `on ${str(top?.label) || 'that line'}` : 'on your network';
      return {
        out: { lines: f.lines, hours: f.hours, busiest: top ?? OFF, total: f.total },
        note: `Estimate: about ${f.total.toLocaleString('en-GB')} boarding${f.total === 1 ? '' : 's'} ${scope} in the next ${hours === 1 ? 'hour' : `${hours} hours`}${top && top.busiestHour ? `, busiest ${str(top.label)} at ${str(top.busiestHour)} (about ${str(top.busiest)})` : ''}.${f.clipped ? ' Stops at midnight.' : ''}`,
      };
    },
  },
  {
    type: 'data.analytics', category: 'data', label: 'Network Control figure', description: 'A measure from Network Control’s recorded history, e.g. average wait per stop over the last 7 days.',
    inputs: [afterIn], outputs: [{ id: 'rows', label: 'Rows', type: 'list' }, { id: 'value', label: 'Total', type: 'number' }],
    config: [
      { id: 'measure', label: 'Measure', kind: 'measure', default: 'boardings' },
      { id: 'groupBy', label: 'For each', kind: 'select', default: 'line', options: [{ value: 'network', label: 'Whole network' }, { value: 'line', label: 'Line' }, { value: 'stop', label: 'Stop' }, { value: 'vehicle', label: 'Bus' }] },
      { id: 'days', label: 'Days', kind: 'select', default: '7', options: [{ value: '0', label: 'Today so far' }, { value: '1', label: 'Yesterday' }, { value: '7', label: 'Last 7 days' }, { value: '35', label: 'Last 35 days' }] },
    ],
    run: (ctx, _inp, cfg) => {
      const m = MEASURE[str(cfg.measure)];
      if (!m) throw new Error('Choose a measure.');
      const days = Number(cfg.days ?? 7);
      const res = aggregate(ctx.game, { groupBy: (str(cfg.groupBy) || 'line') as GroupBy, days: days === 0 ? { last: 0 } : { last: days }, includeToday: days === 0 });
      ctx.spend(res.rows.length * 2);
      const rows = res.rows.map((r) => ({ kind: str(cfg.groupBy) === 'vehicle' ? 'vehicle' : str(cfg.groupBy) || 'row', id: r.id, label: r.label, value: r.values[m.id] ?? null, ...(r.values as Record<string, Value>) }));
      return { out: { rows, value: res.total.values[m.id] ?? null }, note: `${m.label}: ${fmt(res.total.values[m.id] ?? null)} in total, ${rows.length} row${rows.length === 1 ? '' : 's'}.${res.notes[0] ? ` ${res.notes[0]}` : ''}` };
    },
  },

  {
    type: 'data.journeys', category: 'data', label: 'Passenger journeys',
    description: 'Where your passengers travel: recorded journeys from one stop or area to another (origin to destination), a day on average, with how many gave up, the average journey and wait, how many changed bus and the lines they used. Narrow it to journeys from or to a stop, on a line, on the same kind of day as today or at one time of day.',
    inputs: [
      afterIn,
      { id: 'from', label: 'From', type: 'any', optional: true, help: 'A stop or an area (or nothing: from anywhere).' },
      { id: 'to', label: 'To', type: 'any', optional: true, help: 'A stop or an area (or nothing: to anywhere).' },
      { id: 'line', label: 'Using line', type: 'line', optional: true },
    ],
    outputs: [
      { id: 'flows', label: 'Journeys', type: 'list', help: 'Busiest first. Each: from, to, journeys (a day), gaveUp, journeyMin, waitMin, changedPct, usual (the lines most took), lines, and between areas `within` (starts and ends in the same area: filter with not item.within).' },
      { id: 'top', label: 'Busiest', type: 'record' },
      { id: 'origins', label: 'Where they start', type: 'list', help: 'Stops or areas, busiest first. A stop here can be connected wherever a stop is wanted.' },
      { id: 'destinations', label: 'Where they go', type: 'list' },
      { id: 'total', label: 'Journeys a day', type: 'number' },
    ],
    config: [
      { id: 'level', label: 'Between', kind: 'select', default: 'zone', options: [{ value: 'zone', label: 'Areas' }, { value: 'stop', label: 'Stops' }] },
      { id: 'from', label: 'From stop', kind: 'stop', default: '', allowAny: true, help: 'Between areas, this means the stop’s area. Leave empty for anywhere.' },
      { id: 'to', label: 'To stop', kind: 'stop', default: '', allowAny: true },
      lineCfg('Using line', true),
      { id: 'days', label: 'Days', kind: 'select', default: '7', options: [{ value: '1', label: 'Yesterday' }, { value: '7', label: 'The last 7 days' }, { value: '28', label: 'The last 28 days' }, { value: '0', label: 'Today so far' }] },
      { id: 'dayType', label: 'Kind of day', kind: 'select', default: 'same', options: [{ value: 'same', label: 'The same kind as today (weekday or weekend)' }, { value: 'all', label: 'Every day' }, { value: 'weekday', label: 'Weekdays' }, { value: 'weekend', label: 'Weekends' }] },
      { id: 'band', label: 'Setting off', kind: 'select', default: 'all', options: [{ value: 'all', label: 'At any time' }, ...BANDS.map((b, i) => ({ value: String(i), label: `${b.label} (${b.short})` }))] },
      { id: 'limit', label: 'Busiest', kind: 'number', default: 10, min: 1, max: 50, unit: 'journeys' },
    ],
    run: (ctx, inp, cfg) => {
      const game = ctx.game, s = game.state;
      const level = str(cfg.level) === 'stop' ? 'stop' : 'zone';
      // a stop or an area, connected or chosen
      const place = (v: Value | undefined, setting: string): { stop?: string; zone?: string } | null => {
        if (isRec(v) && v.kind === 'area' && typeof v.id === 'string') return { zone: v.id };
        const id = idOf(v, 'stop') ?? (v === undefined ? setting || null : null);
        if (!id) return null;
        const st = s.stops[id];
        if (!st) throw new Error('That stop no longer exists.');
        return { stop: id, zone: st.zone };
      };
      const from = place(inp.from, str(cfg.from)), to = place(inp.to, str(cfg.to));
      const line = idOf(inp.line, 'line') ?? (str(cfg.line) || null);
      const today = Math.floor(game.t / DAY);
      const n = Number(cfg.days ?? 7);
      const wd = (s.clock.startWeekday + today) % 7;
      const dt = str(cfg.dayType) || 'same';
      const dayType = (dt === 'same' ? (wd >= 5 ? 'weekend' : 'weekday') : dt) as 'all' | 'weekday' | 'weekend';
      const band = str(cfg.band) === 'all' || cfg.band === undefined ? null : Number(cfg.band);
      ctx.spend(300);
      const res = odMatrix(game, {
        level, dayType, days: n === 0 ? { from: today, to: today } : { last: n }, includeToday: n === 0,
        bands: band === null ? [] : [band], lines: line ? [line] : [],
        origin: from ? (level === 'zone' ? from.zone : from.stop) ?? null : null,
        destination: to ? (level === 'zone' ? to.zone : to.stop) ?? null : null,
      });
      // an area asked for between stops: keep the stops in it
      const inZone = (stopId: string, z?: string) => !z || s.stops[stopId]?.zone === z;
      const flows0 = level === 'stop' ? res.flows.filter((f) => (!from || from.stop || inZone(f.o, from.zone)) && (!to || to.stop || inZone(f.d, to.zone))) : res.flows;
      const days = Math.max(1, res.coverage.detailed.length + (res.coverage.today ? 1 : 0));
      const r1x = (x: number) => Math.round(x * 10) / 10;
      const limit = Math.max(1, Math.min(50, num(cfg.limit) || 10));
      const flows: Rec[] = flows0.slice(0, limit).map((f) => {
        const top = f.itineraries[0];
        // between areas, trips that start and end in the same area are shown as "Within …"
        const within = level === 'zone' && f.o === f.d;
        const label = within ? `Within ${f.oLabel}` : `${f.oLabel} → ${f.dLabel}`;
        const lines = top ? top.sig.split('.').filter((_, i) => i % 2 === 0).map((id) => s.routes[id]?.number ?? s.analytics.names.r[id]?.n ?? '?') : [];
        return {
          kind: 'flow', id: f.key, from: f.oLabel, to: f.dLabel, fromId: f.o, toId: f.d, label, name: label, within,
          journeys: r1x(f.journeys / days), gaveUp: r1x(f.abandoned / days), value: r1x(f.journeys / days),
          journeyMin: f.journeyMin === null ? null : r1x(f.journeyMin), waitMin: f.waitMin === null ? null : r1x(f.waitMin),
          changedPct: f.journeys ? Math.round((f.transfers / f.journeys) * 100) : 0, usual: top?.label ?? null, lines,
        };
      });
      const kind = level === 'stop' ? 'stop' : 'area';
      const ends = (list: { id: string; label: string; journeys: number }[]) => list.slice(0, 10).map((x) => ({ kind, id: x.id, name: x.label, journeys: r1x(x.journeys / days), value: r1x(x.journeys / days) }));
      const total = r1x(flows0.reduce((a, f) => a + f.journeys, 0) / days);
      const gave = r1x(flows0.reduce((a, f) => a + f.abandoned, 0) / days);
      const first = flows[0];
      const scope = `${n === 0 ? 'Today so far' : n === 1 ? 'Yesterday' : `The last ${n} days`}${dayType === 'all' ? '' : ` (${dayType}s only)`}`;
      const round = (x: number) => (x >= 10 ? Math.round(x) : x).toLocaleString('en-GB');
      const note = first
        ? `${scope}: about ${round(total)} journeys a day${level === 'zone' ? ', by area' : ' between stops'}${gave ? `, and ${round(gave)} gave up` : ''}. Busiest: ${str(first.label)}, ${round(Number(first.journeys))} a day${first.waitMin !== null ? `, ${str(first.waitMin)} min wait` : ''}.`
        : `${scope}: ${res.notes.find((x) => x.startsWith('No recorded')) ?? 'no journeys match.'}`;
      return { out: { flows, top: first ?? OFF, origins: ends(res.origins), destinations: ends(res.destinations), total }, note };
    },
  },
  {
    type: 'data.baseline', category: 'data', label: 'Compare with a normal day',
    description: 'Is a figure unusual for the time of day? Compares the last hour (or three, or today so far) with the same hours on comparable recorded days: the same day of the week, the same kind of day, or every day last week. E.g. 140 boardings at a stop 17:00–18:00 against 92 on a normal Saturday is 52% more. With no line or stop chosen it compares each one, most unusual first.',
    inputs: [afterIn, { id: 'item', label: 'Line or stop', type: 'any', optional: true, list: true, help: 'A line or a stop, or a list of them. Unconnected: the one chosen below, or every one.' }],
    outputs: [
      { id: 'change', label: '% above normal', type: 'number', help: 'Below normal is negative. Nothing when it is normally zero.' },
      { id: 'now', label: 'Now', type: 'number' },
      { id: 'normal', label: 'Normal', type: 'number' },
      { id: 'results', label: 'Each one', type: 'list', help: 'Most above normal first. Each is the line or stop with now, normal, change and compared (days).' },
      { id: 'first', label: 'Most above normal', type: 'record' },
      { id: 'text', label: 'In words', type: 'text' },
    ],
    config: [
      { id: 'measure', label: 'Figure', kind: 'select', default: 'stop.boardings', options: BASE_OPTIONS },
      lineCfg('Line', true),
      { id: 'stop', label: 'Stop', kind: 'stop', default: '', allowAny: true, help: 'For stop figures. Leave the line or stop empty to compare every one.' },
      { id: 'window', label: 'Over', kind: 'select', default: 'hour', options: BASE_WINDOWS },
      { id: 'compare', label: 'Against', kind: 'select', default: 'weekday', options: BASE_COMPARE },
      { id: 'minNormal', label: 'Skip when normally below', kind: 'number', default: 0, min: 0, max: 10000, help: 'Leaves out small figures, where a few extra people look like a big change: e.g. 10 skips a stop that normally sees 2 boardings and now sees 6 (+200%).' },
    ],
    run: (ctx, inp, cfg) => {
      const game = ctx.game, s = game.state;
      const mid = str(cfg.measure);
      const m = BASE_MEASURE[mid];
      if (!m) throw new Error('Choose a figure.');
      const win = str(cfg.window) || 'hour', cmp = str(cfg.compare) || 'weekday';
      const floor = num(cfg.minNormal) ?? 0;
      let ids: (string | null)[];
      if (m.scope === 'network') ids = [null];
      else if (inp.item !== undefined && inp.item !== null) {
        ids = items(inp.item, 200).map((x) => (m.scope === 'line' ? idOf(x, 'line') : idOf(x, 'stop')));
        if (ids.some((x) => !x)) throw new Error(`This figure is for ${m.scope === 'line' ? 'lines: connect a line (or a bus, which stands for its line)' : 'stops: connect a stop'}.`);
      } else {
        const one = m.scope === 'line' ? str(cfg.line) : str(cfg.stop);
        if (one) ids = [one];
        else if (m.scope === 'line') ids = Object.keys(s.routes);
        else ids = [...new Set(Object.values(s.routes).flatMap((r) => [...r.stops, ...(r.returnStops ?? [])]))].slice(0, 300);
      }
      ctx.spend(ids.length * 4);
      const results: Rec[] = [];
      for (const id of ids) {
        const base: Rec | null = id === null ? { kind: 'network', id: 'network', name: 'The whole network' } : m.scope === 'line' ? ctx.live.line(id) : ctx.live.stop(id);
        if (!base) throw new Error(`That ${m.scope} no longer exists.`);
        const r = compareBaseline(game, mid, id, win, cmp);
        if (r.normal !== null && r.normal < floor) continue;
        const name = m.scope === 'line' ? `Line ${str(base.number)}` : str(base.name);
        // the comparison first: the debugger shows the first fields of a record
        results.push({ kind: base.kind, id: base.id, name: base.name ?? name, now: r.value, normal: r.normal, change: r.change, compared: r.days, hours: r.hours, baseline: baselineText(game, mid, name, r), ...base });
      }
      results.sort((a, b) => (num(b.change) ?? -Infinity) - (num(a.change) ?? -Infinity));
      const first = results[0];
      if (!first) return { out: { change: OFF, now: OFF, normal: OFF, results: [], first: OFF, text: 'Nothing to compare.' }, note: floor ? `None normally reaches ${floor}.` : 'Nothing to compare.' };
      const above = results.filter((x) => (num(x.change) ?? 0) > 0).length;
      const text = results.length === 1 ? str(first.baseline) : `${str(first.baseline)}. ${above} of ${results.length} are above normal.`;
      return { out: { change: first.change, now: first.now, normal: first.normal, results, first, text }, note: text };
    },
  },

  // ── logic
  {
    type: 'logic.compare', category: 'logic', label: 'Compare', description: 'Is a number above, below or equal to another (or a threshold)?',
    inputs: [{ id: 'a', label: 'Value', type: 'number' }, { id: 'b', label: 'Compared with', type: 'number', optional: true }], outputs: [{ id: 'result', label: 'Result', type: 'boolean' }],
    config: [{ id: 'op', label: 'Test', kind: 'select', default: '>', options: OPS }, { id: 'b', label: 'Threshold', kind: 'number', default: 80, help: 'Used when nothing is connected to “Compared with”.' }],
    run: (_ctx, inp, cfg) => {
      const a = num(inp.a), b = inp.b !== undefined ? num(inp.b) : num(cfg.b);
      const op = str(cfg.op) || '>';
      if (a === null || b === null) return { out: { result: false }, note: `${fmt(inp.a)} ${OP_SYMBOL[op]} ${fmt(inp.b ?? cfg.b)}: no number to compare, so false.` };
      const r = compareOp(op, a, b);
      return { out: { result: r }, note: `${fmt(a)} ${OP_SYMBOL[op]} ${fmt(b)} → ${r ? 'true' : 'false'}` };
    },
  },
  {
    type: 'logic.if', category: 'logic', label: 'If / else', description: 'Sends the value down “Yes” when the condition is true, otherwise down “No”. Nodes on the other branch do not run.',
    inputs: [{ id: 'condition', label: 'Condition', type: 'boolean' }, { id: 'value', label: 'Value', type: 'any', optional: true }],
    outputs: [{ id: 'yes', label: 'Yes', type: 'any' }, { id: 'no', label: 'No', type: 'any' }], config: [],
    run: (_ctx, inp) => {
      const c = truthy((inp.condition ?? null) as EValue);
      const v = inp.value !== undefined ? inp.value : true;
      return { out: { yes: c ? v : OFF, no: c ? OFF : v }, note: `Condition is ${c ? 'true → Yes' : 'false → No'}.` };
    },
  },
  {
    type: 'logic.and', category: 'logic', label: 'All of', description: 'True when every connected input is true.',
    inputs: [{ id: 'a', label: 'A', type: 'boolean' }, { id: 'b', label: 'B', type: 'boolean' }, { id: 'c', label: 'C', type: 'boolean', optional: true }], outputs: [{ id: 'result', label: 'Result', type: 'boolean' }], config: [],
    run: (_ctx, inp) => { const vals = ['a', 'b', 'c'].filter((k) => inp[k] !== undefined).map((k) => truthy(inp[k] as EValue)); const r = vals.every(Boolean); return { out: { result: r }, note: `${vals.map((x) => (x ? 'true' : 'false')).join(' and ')} → ${r}` }; },
  },
  {
    type: 'logic.or', category: 'logic', label: 'Any of', description: 'True when at least one connected input is true.',
    inputs: [{ id: 'a', label: 'A', type: 'boolean' }, { id: 'b', label: 'B', type: 'boolean' }, { id: 'c', label: 'C', type: 'boolean', optional: true }], outputs: [{ id: 'result', label: 'Result', type: 'boolean' }], config: [],
    run: (_ctx, inp) => { const vals = ['a', 'b', 'c'].filter((k) => inp[k] !== undefined).map((k) => truthy(inp[k] as EValue)); const r = vals.some(Boolean); return { out: { result: r }, note: `${vals.map((x) => (x ? 'true' : 'false')).join(' or ')} → ${r}` }; },
  },
  {
    type: 'logic.not', category: 'logic', label: 'Not', description: 'Turns true into false and false into true.',
    inputs: [{ id: 'a', label: 'Value', type: 'boolean' }], outputs: [{ id: 'result', label: 'Result', type: 'boolean' }], config: [],
    run: (_ctx, inp) => ({ out: { result: !truthy((inp.a ?? null) as EValue) } }),
  },
  {
    type: 'logic.either', category: 'logic', label: 'Either', description: 'Passes on whichever input is active (A first). Joins two branches back together.',
    inputs: [{ id: 'a', label: 'A', type: 'any', optional: true }, { id: 'b', label: 'B', type: 'any', optional: true }], outputs: [{ id: 'value', label: 'Value', type: 'any' }], config: [],
    run: (_ctx, inp) => ({ out: { value: inp.a !== undefined ? inp.a : inp.b !== undefined ? inp.b : OFF } }),
  },
  {
    type: 'logic.during', category: 'logic', label: 'Only during', description: 'Passes the value on only between two hours (and on chosen days).',
    inputs: [{ id: 'value', label: 'Value', type: 'any', optional: true }], outputs: [{ id: 'value', label: 'Value', type: 'any' }],
    config: [{ id: 'from', label: 'From', kind: 'number', default: 6, min: 0, max: 23, unit: 'h' }, { id: 'to', label: 'Until', kind: 'number', default: 10, min: 1, max: 24, unit: 'h' }, { id: 'days', label: 'On', kind: 'select', default: 'all', options: [{ value: 'all', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' }, { value: 'weekend', label: 'Weekends' }] }],
    run: (ctx, inp, cfg) => {
      const t = ctx.live.time();
      const h = Number(t.hour), from = num(cfg.from) ?? 0, to = num(cfg.to) ?? 24;
      const inHours = from <= to ? h >= from && h < to : h >= from || h < to;
      const d = str(cfg.days);
      const inDays = d === 'weekdays' ? !t.weekend : d === 'weekend' ? !!t.weekend : true;
      const pass = inHours && inDays;
      return { out: { value: pass ? (inp.value !== undefined ? inp.value : true) : OFF }, note: `${str(t.time)} ${pass ? 'is' : 'is not'} within ${from}:00–${to}:00${d !== 'all' ? ` on ${d}` : ''}.` };
    },
  },
  {
    type: 'logic.filter', category: 'logic', label: 'Filter', description: 'Keeps the items of a list for which the condition is true. Use `item` for each item, e.g. item.occupancy > 80.',
    inputs: [{ id: 'list', label: 'List', type: 'list' }], outputs: [{ id: 'list', label: 'Kept', type: 'list' }, { id: 'count', label: 'Count', type: 'number' }],
    config: [{ id: 'expr', label: 'Keep when', kind: 'expr', default: 'item.occupancy > 80', vars: ['item', 'event', 'time', 'memory'] }],
    run: (ctx, inp, cfg) => {
      const list = Array.isArray(inp.list) ? inp.list : [];
      const kept = list.filter((item) => truthy(expr(ctx, str(cfg.expr), { item }) as EValue));
      return { out: { list: kept, count: kept.length }, note: `${kept.length} of ${list.length} kept.` };
    },
  },
  {
    type: 'logic.sort', category: 'logic', label: 'Sort', description: 'Orders a list by a field, e.g. occupancy, highest first.',
    inputs: [{ id: 'list', label: 'List', type: 'list' }], outputs: [{ id: 'list', label: 'Sorted', type: 'list' }],
    config: [{ id: 'field', label: 'By field', kind: 'text', default: 'occupancy' }, { id: 'order', label: 'Order', kind: 'select', default: 'desc', options: [{ value: 'desc', label: 'Highest first' }, { value: 'asc', label: 'Lowest first' }] }],
    run: (ctx, inp, cfg) => {
      const list = Array.isArray(inp.list) ? [...inp.list] : [];
      const f = str(cfg.field), dir = str(cfg.order) === 'asc' ? 1 : -1;
      const val = (x: Value) => fieldOf(x, f) ?? null;
      ctx.spend(list.length);
      list.sort((a, b) => {
        const x = val(a), y = val(b);
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return String(x).localeCompare(String(y)) * dir;
      });
      return { out: { list }, note: list.length ? `First: ${fmt(list[0])} (${f} ${fmt(val(list[0]))}).` : 'Empty list.' };
    },
  },
  {
    type: 'logic.take', category: 'logic', label: 'First few', description: 'Keeps the first N items of a list.',
    inputs: [{ id: 'list', label: 'List', type: 'list' }], outputs: [{ id: 'list', label: 'List', type: 'list' }], config: [{ id: 'n', label: 'How many', kind: 'number', default: 3, min: 1, max: 100 }],
    run: (_ctx, inp, cfg) => { const list = Array.isArray(inp.list) ? inp.list.slice(0, num(cfg.n) ?? 3) : []; return { out: { list }, note: `${list.length} kept.` }; },
  },
  {
    type: 'logic.first', category: 'logic', label: 'First item', description: 'The first item of a list. If the list is empty, nothing after it runs.',
    inputs: [{ id: 'list', label: 'List', type: 'list' }], outputs: [{ id: 'item', label: 'Item', type: 'any' }, { id: 'found', label: 'Found', type: 'boolean' }], config: [],
    run: (_ctx, inp) => { const list = Array.isArray(inp.list) ? inp.list : []; return { out: { item: list.length ? list[0] : OFF, found: list.length > 0 }, note: list.length ? `${fmt(list[0])}.` : 'The list is empty.' }; },
  },
  {
    type: 'logic.pick', category: 'logic', label: 'Pick the highest or lowest',
    description: 'The item of a list with the highest (or lowest) value of a field, e.g. the line with the highest load3h. Items without that figure are skipped. If none has it, nothing after it runs.',
    inputs: [{ id: 'list', label: 'List', type: 'list' }], outputs: [{ id: 'item', label: 'Item', type: 'any' }, { id: 'value', label: 'Its value', type: 'number' }, { id: 'found', label: 'Found', type: 'boolean' }],
    config: [{ id: 'field', label: 'Field', kind: 'text', default: 'load3h' }, { id: 'order', label: 'Pick', kind: 'select', default: 'desc', options: [{ value: 'desc', label: 'The highest' }, { value: 'asc', label: 'The lowest' }] }],
    run: (ctx, inp, cfg) => {
      const list = Array.isArray(inp.list) ? inp.list : [];
      const f = str(cfg.field), low = str(cfg.order) === 'asc';
      ctx.spend(list.length);
      let best: Rec | null = null, bv = 0;
      for (const x of list) {
        if (!isRec(x)) continue;
        const v = num(fieldOf(x, f));
        if (v === null) continue;
        if (!best || (low ? v < bv : v > bv)) { best = x; bv = v; }
      }
      return best ? { out: { item: best, value: bv, found: true }, note: `${fmt(best)}: ${f} ${fmt(bv)}.` } : { out: { item: OFF, value: OFF, found: false }, note: list.length ? `No item has a figure “${f}”.` : 'The list is empty.' };
    },
  },
  {
    type: 'logic.groupBy', category: 'logic', label: 'Group by',
    description: 'Sorts the items of a list into groups that share a field, e.g. buses by line or depot, stops by area, journeys by where they go. Each group has its key, how many items it has, the items, and a total, average, smallest or largest of another field. Biggest group first. A group of buses by line stands for that line.',
    inputs: [{ id: 'list', label: 'List', type: 'list' }],
    outputs: [{ id: 'groups', label: 'Groups', type: 'list', help: 'Each: key, name, count, value, items.' }, { id: 'largest', label: 'Biggest group', type: 'record' }, { id: 'count', label: 'How many groups', type: 'number' }],
    config: [
      { id: 'field', label: 'Group by field', kind: 'text', default: 'line', help: 'e.g. line, depot, area, status, to. A dotted name reads inside a record: match.line.' },
      { id: 'op', label: 'For each group', kind: 'select', default: 'count', options: [{ value: 'count', label: 'Count the items' }, { value: 'sum', label: 'Total of a field' }, { value: 'avg', label: 'Average of a field' }, { value: 'min', label: 'Smallest of a field' }, { value: 'max', label: 'Largest of a field' }] },
      { id: 'of', label: 'Of field', kind: 'text', default: 'load', help: 'For a total, average, smallest or largest.' },
    ],
    run: (ctx, inp, cfg) => {
      const list = Array.isArray(inp.list) ? inp.list : [];
      const f = str(cfg.field), op = str(cfg.op) || 'count', of = str(cfg.of);
      if (!f) throw new Error('Name the field to group by.');
      ctx.spend(list.length * 2);
      const s = ctx.game.state;
      const groups = new Map<string, { key: Value; items: Value[] }>();
      for (const x of list) {
        const raw = fieldOf(x, f);
        const k = keyOf(raw) ?? '';
        let g = groups.get(k);
        if (!g) {
          if (groups.size >= 100) continue;
          groups.set(k, (g = { key: raw === undefined ? null : isRec(raw) ? (raw.id as Value) : raw, items: [] }));
        }
        g.items.push(x);
      }
      const out: Rec[] = [...groups.entries()].map(([k, g]) => {
        const vals = g.items.map((x) => num(fieldOf(x, of))).filter((v): v is number => v !== null);
        const value = op === 'count' ? g.items.length : !vals.length ? null : op === 'sum' ? vals.reduce((a, b) => a + b, 0) : op === 'avg' ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : op === 'min' ? Math.min(...vals) : Math.max(...vals);
        // a key that is one of your lines, depots or stops: named, and a line group stands for its line
        const r = s.routes[k], d = s.depots[k], st = s.stops[k];
        const name = !k ? 'None' : r ? `Line ${r.number}` : d ? d.name : st ? st.name : k;
        return { kind: 'group', id: k || 'none', key: g.key, name, count: g.items.length, value, items: g.items, ...(r ? { line: k, lineNumber: r.number } : {}), ...(d ? { depot: k } : {}) };
      });
      out.sort((a, b) => (num(b.value) ?? -Infinity) - (num(a.value) ?? -Infinity) || Number(b.count) - Number(a.count));
      const what = op === 'count' ? '' : ` (${op === 'sum' ? 'total' : op === 'avg' ? 'average' : op === 'min' ? 'smallest' : 'largest'} ${of})`;
      const shown = out.slice(0, 4).map((g) => `${str(g.name)} ${fmt(g.value)}`).join(', ');
      return {
        out: { groups: out, largest: out[0] ?? OFF, count: out.length },
        note: out.length ? `${out.length} group${out.length === 1 ? '' : 's'} by ${f}${what}: ${shown}${out.length > 4 ? ', …' : ''}.${groups.size >= 100 ? ' At most 100 groups.' : ''}` : 'The list is empty.',
      };
    },
  },
  {
    type: 'logic.join', category: 'logic', label: 'Join lists',
    description: 'Matches the items of two lists on a shared field and adds each match to the item of list A, under one name: e.g. your lines (id) with a demand forecast (id), then item.match.riders. Combines figures from different blocks so you can filter, sort or calculate with both.',
    inputs: [{ id: 'a', label: 'List A', type: 'list' }, { id: 'b', label: 'List B', type: 'list' }],
    outputs: [{ id: 'list', label: 'Joined', type: 'list' }, { id: 'unmatched', label: 'A without a match', type: 'list' }, { id: 'count', label: 'Matched', type: 'number' }],
    config: [
      { id: 'fieldA', label: 'Field in A', kind: 'text', default: 'id' },
      { id: 'fieldB', label: 'Matches field in B', kind: 'text', default: 'id', help: 'e.g. A: buses by line, B: lines by id. A record in a field matches by its id.' },
      { id: 'as', label: 'Add the match as', kind: 'text', default: 'match', help: 'The field each item of A gets, holding its match from B. Read it with a dotted name, e.g. match.riders.' },
      { id: 'keep', label: 'Keep', kind: 'select', default: 'matched', options: [{ value: 'matched', label: 'Only items of A with a match' }, { value: 'all', label: 'Every item of A (no match: nothing)' }] },
    ],
    run: (ctx, inp, cfg) => {
      const a = Array.isArray(inp.a) ? inp.a : [], b = Array.isArray(inp.b) ? inp.b : [];
      const fa = str(cfg.fieldA) || 'id', fb = str(cfg.fieldB) || 'id', as = str(cfg.as).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(as) || as === 'kind' || as === 'id') throw new Error('Name the field for the match: one word, not kind or id.');
      ctx.spend(a.length + b.length);
      const index = new Map<string, Value>();
      let twice = 0;
      for (const y of b) {
        const k = keyOf(fieldOf(y, fb));
        if (k === null) continue;
        if (index.has(k)) twice++;
        else index.set(k, y);
      }
      const joined: Value[] = [], unmatched: Value[] = [];
      for (const x of a) {
        const k = keyOf(fieldOf(x, fa));
        const y = k === null ? undefined : index.get(k);
        if (y === undefined) {
          unmatched.push(x);
          if (str(cfg.keep) === 'all') joined.push(isRec(x) ? { kind: x.kind ?? null, id: x.id ?? null, [as]: null, ...x, [as]: null } : { item: x, [as]: null });
          continue;
        }
        // the match near the front, where the debugger shows it; it wins over a field of the same name
        joined.push(isRec(x) ? { kind: x.kind ?? null, id: x.id ?? null, [as]: y, ...x, [as]: y } : { item: x, [as]: y });
      }
      const matched = a.length - unmatched.length;
      return {
        out: { list: joined, unmatched, count: matched },
        note: `${matched} of ${a.length} matched on ${fa} = ${fb}.${unmatched.length ? ` ${unmatched.length} without a match${str(cfg.keep) === 'all' ? ' kept, with nothing as their match' : ' left out'}.` : ''}${twice ? ` ${twice} item${twice === 1 ? '' : 's'} of B shared a key with an earlier one: the first was used.` : ''}`,
      };
    },
  },
  {
    type: 'logic.comparePeaks', category: 'logic', label: 'Compare peaks',
    description: 'Compares two lines’ peak hours: whether they overlap, by how long, and how many buses line B could lend line A during A’s peaks without missing its own departures. Lines that peak at different times can share buses.',
    inputs: [{ id: 'a', label: 'Line A', type: 'line', optional: true }, { id: 'b', label: 'Line B', type: 'line', optional: true }],
    outputs: [{ id: 'overlap', label: 'Overlap', type: 'boolean' }, { id: 'minutes', label: 'Overlap (min)', type: 'number' }, { id: 'lend', label: 'B can lend A', type: 'number' }, { id: 'text', label: 'In words', type: 'text' }],
    config: [{ id: 'a', label: 'Line A', kind: 'line', default: '' }, { id: 'b', label: 'Line B', kind: 'line', default: '' }, peakSourceCfg],
    run: (ctx, inp, cfg) => {
      const game = ctx.game, s = game.state;
      const ida = idOf(inp.a, 'line') ?? str(cfg.a), idb = idOf(inp.b, 'line') ?? str(cfg.b);
      const ra = ida ? s.routes[ida] : null, rb = idb ? s.routes[idb] : null;
      if (!ra || !rb) throw new Error('Choose or connect two lines.');
      if (ra.id === rb.id) throw new Error('Choose two different lines.');
      ctx.spend(48);
      const source = srcOf(cfg);
      const pa = linePeaks(game, ra.id, source), pb = linePeaks(game, rb.id, source);
      const ov = overlapMinutes(pa, pb);
      const stepsB = needSteps(game, rb.id), hasB = busesAvailable(game, rb.id);
      const lend = pa.length && !rb.suspended ? Math.max(0, Math.min(...pa.map((p) => hasB - needOver(stepsB, p.from, p.to)))) : rb.suspended ? hasB : 0;
      const desc = (n: string, p: Peak[]) => (p.length ? `Line ${n} is busiest ${peaksText(p)}` : `Line ${n} has no clear peak hours`);
      const dur = ov >= 60 ? `${Math.round((ov / 60) * 10) / 10} h` : `${ov} min`;
      const text = `${desc(ra.number, pa)}; ${desc(rb.number, pb).replace(/^Line/, 'line')}. ${!pa.length || !pb.length ? '' : ov ? `They overlap by ${dur}. ` : 'They do not overlap. '}${pa.length ? (lend ? `Line ${rb.number} could lend line ${ra.number} ${lend} bus${lend === 1 ? '' : 'es'} during its peaks.` : `Line ${rb.number} needs all its buses during line ${ra.number}’s peaks.`) : ''}`.trim();
      return { out: { overlap: ov > 0, minutes: ov, lend, text }, note: text };
    },
  },

  // ── maths
  {
    type: 'math.expr', category: 'math', label: 'Expression', description: 'Calculates with up to three inputs (a, b, c), e.g. round(a / b * 100, 1). Also available: event, time, memory.',
    inputs: [{ id: 'a', label: 'a', type: 'any', optional: true }, { id: 'b', label: 'b', type: 'any', optional: true }, { id: 'c', label: 'c', type: 'any', optional: true }],
    outputs: [{ id: 'value', label: 'Result', type: 'any' }], config: [{ id: 'expr', label: 'Expression', kind: 'expr', default: 'a', vars: ['a', 'b', 'c', 'event', 'time', 'memory'] }],
    run: (ctx, inp, cfg) => { const v = expr(ctx, str(cfg.expr), { a: inp.a, b: inp.b, c: inp.c }); return { out: { value: v }, note: `${str(cfg.expr)} = ${fmt(v)}` }; },
  },
  {
    type: 'math.arith', category: 'math', label: 'Calculate', description: 'Adds, subtracts, multiplies or divides two numbers.',
    inputs: [{ id: 'a', label: 'A', type: 'number' }, { id: 'b', label: 'B', type: 'number', optional: true }], outputs: [{ id: 'value', label: 'Result', type: 'number' }],
    config: [{ id: 'op', label: 'Operation', kind: 'select', default: '+', options: [{ value: '+', label: 'A + B' }, { value: '-', label: 'A − B' }, { value: '*', label: 'A × B' }, { value: '/', label: 'A ÷ B' }, { value: 'min', label: 'Smaller of A and B' }, { value: 'max', label: 'Larger of A and B' }] }, { id: 'b', label: 'B', kind: 'number', default: 1, help: 'Used when nothing is connected to B.' }],
    run: (_ctx, inp, cfg) => {
      const a = num(inp.a), b = inp.b !== undefined ? num(inp.b) : num(cfg.b);
      const op = str(cfg.op);
      const v = a === null || b === null ? null : op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? (b === 0 ? null : a / b) : op === 'min' ? Math.min(a, b) : Math.max(a, b);
      return { out: { value: v }, note: `${fmt(a)} ${op} ${fmt(b)} = ${fmt(v)}` };
    },
  },
  {
    type: 'math.aggregate', category: 'math', label: 'Summarise list', description: 'Total, average, smallest, largest or count of a field across a list.',
    inputs: [{ id: 'list', label: 'List', type: 'list' }], outputs: [{ id: 'value', label: 'Result', type: 'number' }],
    config: [{ id: 'op', label: 'Calculate', kind: 'select', default: 'avg', options: [{ value: 'sum', label: 'Total' }, { value: 'avg', label: 'Average' }, { value: 'min', label: 'Smallest' }, { value: 'max', label: 'Largest' }, { value: 'count', label: 'Count' }] }, { id: 'field', label: 'Of field', kind: 'text', default: 'occupancy' }],
    run: (ctx, inp, cfg) => {
      const list = Array.isArray(inp.list) ? inp.list : [];
      const f = str(cfg.field), op = str(cfg.op);
      ctx.spend(list.length);
      const vals = list.map((x) => (isRec(x) ? num(fieldOf(x, f)) : num(x))).filter((x): x is number => x !== null);
      const v = op === 'count' ? list.length : !vals.length ? null : op === 'sum' ? vals.reduce((a, b) => a + b, 0) : op === 'avg' ? vals.reduce((a, b) => a + b, 0) / vals.length : op === 'min' ? Math.min(...vals) : Math.max(...vals);
      return { out: { value: v }, note: `${op} of ${f} over ${list.length} item${list.length === 1 ? '' : 's'} = ${fmt(v)}` };
    },
  },
  {
    type: 'math.field', category: 'math', label: 'Get field', description: 'Reads one field of a record, e.g. a line’s occupancy.',
    inputs: [{ id: 'record', label: 'Record', type: 'record' }], outputs: [{ id: 'value', label: 'Value', type: 'any' }], config: [{ id: 'field', label: 'Field', kind: 'text', default: 'occupancy' }],
    run: (_ctx, inp, cfg) => { const f = str(cfg.field); const v = fieldOf(inp.record, f) ?? null; return { out: { value: v }, note: `${f} = ${fmt(v)}` }; },
  },
  {
    type: 'math.map', category: 'math', label: 'Calculate for each', description: 'Adds a field `value` to every item of a list from an expression with `item`.',
    inputs: [{ id: 'list', label: 'List', type: 'list' }], outputs: [{ id: 'list', label: 'List', type: 'list' }],
    config: [{ id: 'expr', label: 'Value', kind: 'expr', default: 'item.waiting / max(1, item.buses)', vars: ['item', 'event', 'time', 'memory'] }],
    run: (ctx, inp, cfg) => {
      const list = Array.isArray(inp.list) ? inp.list : [];
      const out: Value[] = list.map((item): Value => (isRec(item) ? { ...item, value: expr(ctx, str(cfg.expr), { item }) } : { item, value: expr(ctx, str(cfg.expr), { item }) }));
      return { out: { list: out }, note: `${out.length} item${out.length === 1 ? '' : 's'} calculated.` };
    },
  },

  // ── memory
  {
    type: 'state.get', category: 'state', label: 'Remembered value', description: 'Reads a value this workflow remembered in an earlier run.',
    inputs: [], outputs: [{ id: 'value', label: 'Value', type: 'any' }], config: [{ id: 'key', label: 'Name', kind: 'text', default: 'count' }, { id: 'default', label: 'If nothing yet', kind: 'number', default: 0 }],
    run: (ctx, _inp, cfg) => { const k = str(cfg.key); const v = Object.hasOwn(ctx.memory, k) ? ctx.memory[k] : cfg.default ?? null; return { out: { value: v }, note: `${k} = ${fmt(v)}` }; },
  },
  {
    type: 'state.set', category: 'state', label: 'Remember', description: 'Stores a value for later runs of this workflow and passes it on.',
    inputs: [{ id: 'value', label: 'Value', type: 'any' }], outputs: [{ id: 'value', label: 'Value', type: 'any' }], config: [{ id: 'key', label: 'Name', kind: 'text', default: 'count' }],
    run: (ctx, inp, cfg) => { const k = str(cfg.key); if (!k) throw new Error('Name the value to remember.'); ctx.memory[k] = trim(inp.value ?? null); return { out: { value: inp.value ?? null }, note: `Remembered ${k} = ${fmt(inp.value)}` }; },
  },
  {
    type: 'state.counter', category: 'state', label: 'Counter', description: 'Counts how often it runs (optionally restarting each day).',
    inputs: [{ id: 'value', label: 'Count when', type: 'any', optional: true }], outputs: [{ id: 'count', label: 'Count', type: 'number' }],
    config: [{ id: 'key', label: 'Name', kind: 'text', default: 'counter' }, { id: 'daily', label: 'Restart each day', kind: 'boolean', default: true }],
    run: (ctx, _inp, cfg) => {
      const k = `#${str(cfg.key)}`;
      const day = Math.floor(ctx.game.t / DAY);
      const prev = isRec(ctx.memory[k]) ? (ctx.memory[k] as Rec) : { n: 0, day };
      const n = (cfg.daily && prev.day !== day ? 0 : num(prev.n) ?? 0) + 1;
      ctx.memory[k] = { n, day };
      return { out: { count: n }, note: `Count ${n}${cfg.daily ? ' today' : ''}.` };
    },
  },
  {
    type: 'state.changed', category: 'state', label: 'Has it changed?', description: 'Compares a value with the one from the previous run.',
    inputs: [{ id: 'value', label: 'Value', type: 'any' }], outputs: [{ id: 'changed', label: 'Changed', type: 'boolean' }, { id: 'previous', label: 'Previous', type: 'any' }], config: [{ id: 'key', label: 'Name', kind: 'text', default: 'last' }],
    run: (ctx, inp, cfg) => {
      const k = `~${str(cfg.key)}`;
      const prev = Object.hasOwn(ctx.memory, k) ? ctx.memory[k] : null;
      const cur = trim(inp.value ?? null);
      const changed = JSON.stringify(prev) !== JSON.stringify(cur);
      ctx.memory[k] = cur;
      return { out: { changed, previous: prev }, note: changed ? `Changed from ${fmt(prev)} to ${fmt(cur)}.` : `Still ${fmt(cur)}.` };
    },
  },
  {
    type: 'state.cooldown', category: 'state', label: 'Wait before repeating', description: 'Passes the value on, then blocks it for a number of game minutes (per line, stop or bus when connected to one).',
    inputs: [{ id: 'value', label: 'Value', type: 'any' }], outputs: [{ id: 'value', label: 'Value', type: 'any' }], config: [{ id: 'minutes', label: 'Wait', kind: 'number', default: 60, min: 1, max: 1440, unit: 'min' }],
    run: (ctx, inp, cfg) => {
      const who = isRec(inp.value) && typeof inp.value.id === 'string' ? inp.value.id : '*';
      const k = `@cool:${ctx.key}:${who}`;
      const last = num(ctx.memory[k]);
      const mins = num(cfg.minutes) ?? 60;
      if (last !== null && ctx.game.t - last < mins * 60) return { out: { value: OFF }, note: `Blocked: last passed ${Math.round((ctx.game.t - last) / 60)} min ago (wait ${mins}).` };
      ctx.memory[k] = ctx.game.t;
      return { out: { value: inp.value ?? true }, note: 'Passed; now waiting before the next time.' };
    },
  },
  {
    type: 'state.once', category: 'state', label: 'Once a day', description: 'Passes the value on only the first time each day (per line, stop or bus when connected to one).',
    inputs: [{ id: 'value', label: 'Value', type: 'any' }], outputs: [{ id: 'value', label: 'Value', type: 'any' }], config: [],
    run: (ctx, inp) => {
      const who = isRec(inp.value) && typeof inp.value.id === 'string' ? inp.value.id : '*';
      const k = `@once:${ctx.key}:${who}`;
      const day = Math.floor(ctx.game.t / DAY);
      if (num(ctx.memory[k]) === day) return { out: { value: OFF }, note: 'Already passed today.' };
      ctx.memory[k] = day;
      return { out: { value: inp.value ?? true }, note: 'First time today.' };
    },
  },

  // ── actions
  {
    type: 'action.dispatch', category: 'action', label: 'Extra departure', description: 'Runs an extra trip on a line now with a free bus (the one connected, or the best free one). It follows every normal rule: the bus prepares, drives to the first stop and runs the trip.',
    inputs: [whenIn, { id: 'line', label: 'Line', type: 'line', optional: true, list: true }, { id: 'bus', label: 'Bus', type: 'vehicle', optional: true }], outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [lineCfg()], action: { impact: 'low' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false: no departure requested.' };
      const lines = inp.line !== undefined ? items(inp.line).map((x) => idOf(x, 'line')).filter((x): x is string => !!x) : [str(cfg.line)].filter(Boolean);
      if (!lines.length) throw new Error('Choose or connect a line.');
      const bus = idOf(inp.bus, 'vehicle') ?? undefined;
      return actionOut(lines.map((route) => ctx.act({ type: 'dispatch_extra', route, vehicle: bus })));
    },
  },
  {
    type: 'action.scheduleExtra', category: 'action', label: 'Schedule extra departure',
    description: 'Plans an extra trip on a line for a set time later, up to 24 hours ahead: e.g. 10 minutes before a peak starts or a match ends. When it is due, the bus connected runs it if it is free then, or else one of the line’s free buses or a spare. If no bus is free it is dropped and you are told; it never counts as a missed departure. Timetable changes keep it, and you can cancel it on the line.',
    inputs: [
      whenIn,
      { id: 'line', label: 'Line', type: 'line', optional: true, list: true },
      { id: 'at', label: 'Time', type: 'any', optional: true, help: 'A time such as "17:30" (the next one), a number of minutes from now, or a peak (its start). Unconnected: the setting.' },
      { id: 'bus', label: 'Bus', type: 'vehicle', optional: true },
    ],
    outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [
      lineCfg(),
      { id: 'mode', label: 'When', kind: 'select', default: 'at', options: [{ value: 'at', label: 'At a time of day' }, { value: 'in', label: 'In a number of minutes' }] },
      { id: 'time', label: 'At', kind: 'time', default: '17:00' },
      { id: 'minutes', label: 'In', kind: 'number', default: 30, min: 10, max: 1440, step: 5, unit: 'min' },
      { id: 'shift', label: 'Earlier (−) or later (+) by', kind: 'number', default: 0, min: -180, max: 180, step: 5, unit: 'min', help: 'Moves the time: e.g. −10 with a peak connected leaves ten minutes before it starts.' },
      { id: 'dir', label: 'Direction', kind: 'select', default: 'auto', options: [{ value: 'auto', label: 'Where most people are waiting when it is planned' }, { value: '0', label: 'Outward (first stop to last)' }, { value: '1', label: 'Return' }] },
    ],
    action: { impact: 'low' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false: no departure scheduled.' };
      const lines = inp.line !== undefined ? items(inp.line).map((x) => idOf(x, 'line')).filter((x): x is string => !!x) : [str(cfg.line)].filter(Boolean);
      if (!lines.length) throw new Error('Choose or connect a line.');
      const t = ctx.game.t;
      // the next time of day hh:mm (today, or tomorrow once it has passed)
      const nextClock = (txt: string) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(txt.trim());
        if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`“${txt}” is not a time like 17:30.`);
        const at = Math.floor(t / DAY) * DAY + Number(m[1]) * HOUR + Number(m[2]) * 60;
        return at <= t ? at + DAY : at;
      };
      const v = inp.at;
      let at: number;
      if (typeof v === 'number') at = t + v * 60;
      else if (typeof v === 'string' && v) at = nextClock(v);
      else if (isRec(v) && typeof v.from === 'string') at = nextClock(v.from);
      else if (v !== undefined && v !== null) throw new Error('Connect a time such as "17:30", a number of minutes, or a peak.');
      else at = str(cfg.mode) === 'in' ? t + (num(cfg.minutes) ?? 30) * 60 : nextClock(str(cfg.time) || '17:00');
      at += (num(cfg.shift) ?? 0) * 60;
      const pat = str(cfg.dir) === '0' ? 0 : str(cfg.dir) === '1' ? 1 : undefined;
      const bus = idOf(inp.bus, 'vehicle') ?? undefined;
      return actionOut(lines.map((route) => ctx.act({ type: 'schedule_extra', route, at, ...(pat === undefined ? {} : { pat }), ...(bus ? { vehicle: bus } : {}) })));
    },
  },
  {
    type: 'action.assign', category: 'action', label: 'Move bus to line', description: 'Moves a bus to a line. A bus with passengers finishes its trip and goes via the depot first.',
    inputs: [whenIn, { id: 'bus', label: 'Bus', type: 'vehicle', list: true }, { id: 'line', label: 'Line', type: 'line', optional: true }], outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [lineCfg(), moveAfterCfg], action: { impact: 'low' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false.' };
      const fixed = idOf(inp.line, 'line') ?? (str(cfg.line) || null);
      // a pair from "Best pairs" brings its own line
      const jobs = items(inp.bus).map((x) => ({ vehicle: idOf(x, 'vehicle'), route: inp.line === undefined && isRec(x) && x.kind === 'pair' && typeof x.line === 'string' ? x.line : fixed })).filter((x): x is { vehicle: string; route: string | null } => !!x.vehicle);
      if (!jobs.length) return { out: { result: OFF, done: false }, note: 'No bus connected.' };
      if (jobs.some((j) => !j.route)) throw new Error('Choose or connect a line.');
      return actionOut(jobs.map((j) => ctx.act({ type: 'assign_vehicle', vehicle: j.vehicle, route: j.route!, after: afterOf(cfg) })));
    },
  },
  {
    type: 'action.release', category: 'action', label: 'Park bus at its depot', description: 'Takes a bus off its line and parks it at its depot as a spare, ready for any line. By default it first runs the trips it already has, so no departure is missed. Pair it with Buses set to “Not needed by their line” to park only buses a line can do without.',
    inputs: [whenIn, { id: 'bus', label: 'Bus', type: 'vehicle', list: true }], outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }], config: [moveAfterCfg], action: { impact: 'low' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false.' };
      const buses = items(inp.bus).map((x) => idOf(x, 'vehicle')).filter((x): x is string => !!x);
      if (!buses.length) return { out: { result: OFF, done: false }, note: 'No bus connected.' };
      return actionOut(buses.map((vehicle) => ctx.act({ type: 'assign_vehicle', vehicle, route: null, after: afterOf(cfg) })));
    },
  },
  {
    type: 'action.service', category: 'action', label: 'Send for maintenance', description: 'Sends a bus to the workshop when it has finished its current work.',
    inputs: [whenIn, { id: 'bus', label: 'Bus', type: 'vehicle', list: true }], outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }], config: [], action: { impact: 'low' },
    run: (ctx, inp) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false.' };
      const buses = items(inp.bus).map((x) => idOf(x, 'vehicle')).filter((x): x is string => !!x);
      if (!buses.length) return { out: { result: OFF, done: false }, note: 'No bus connected.' };
      return actionOut(buses.map((vehicle) => ctx.act({ type: 'service_vehicle', vehicle })));
    },
  },
  {
    type: 'action.moveDepot', category: 'action', label: 'Base bus at another depot', description: 'Bases a bus at another depot. A parked bus drives there on the road; a working bus goes there next time it returns.',
    inputs: [whenIn, { id: 'bus', label: 'Bus', type: 'vehicle', list: true }], outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [{ id: 'depot', label: 'Depot', kind: 'depot', default: '' }], action: { impact: 'low' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false.' };
      const depot = str(cfg.depot);
      if (!depot) throw new Error('Choose a depot.');
      const buses = items(inp.bus).map((x) => idOf(x, 'vehicle')).filter((x): x is string => !!x);
      if (!buses.length) return { out: { result: OFF, done: false }, note: 'No bus connected.' };
      return actionOut(buses.map((vehicle) => ctx.act({ type: 'move_depot', vehicle, depot })));
    },
  },
  {
    type: 'action.headway', category: 'action', label: 'Change frequency', description: 'Sets how often a line runs. High impact: needs your approval unless the workflow is allowed to make big changes.',
    inputs: [whenIn, { id: 'line', label: 'Line', type: 'line', optional: true }, { id: 'minutes', label: 'Every (min)', type: 'number', optional: true }], outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [lineCfg(), { id: 'minutes', label: 'Every', kind: 'number', default: 10, min: 3, max: 120, unit: 'min' }, { id: 'days', label: 'Timetable', kind: 'select', default: 'both', options: [{ value: 'both', label: 'Weekdays and weekends' }, { value: 'weekday', label: 'Weekdays' }, { value: 'weekend', label: 'Weekends' }] }],
    action: { impact: 'high' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false.' };
      const route = idOf(inp.line, 'line') ?? str(cfg.line);
      if (!route) throw new Error('Choose or connect a line.');
      const minutes = num(inp.minutes) ?? num(cfg.minutes) ?? 10;
      return actionOut(ctx.act({ type: 'set_headway', route, minutes, days: (str(cfg.days) || 'both') as 'both' }));
    },
  },
  {
    type: 'action.suspend', category: 'action', label: 'Suspend or resume line', description: 'Stops or restarts a line’s timetable. High impact.',
    inputs: [whenIn, { id: 'line', label: 'Line', type: 'line', optional: true }], outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [lineCfg(), { id: 'suspend', label: 'Action', kind: 'select', default: 'suspend', options: [{ value: 'suspend', label: 'Suspend' }, { value: 'resume', label: 'Resume' }] }], action: { impact: 'high' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false.' };
      const route = idOf(inp.line, 'line') ?? str(cfg.line);
      if (!route) throw new Error('Choose or connect a line.');
      return actionOut(ctx.act({ type: 'suspend_line', route, suspended: str(cfg.suspend) !== 'resume' }));
    },
  },
  {
    type: 'action.servicePlan', category: 'action', label: 'Switch a service plan', description: 'Switches one of a line’s manual service plans on or off (made in the line’s timetable, for example a "Rain" or "Match day" plan). Departures not yet given to buses follow it. High impact.',
    inputs: [whenIn, { id: 'line', label: 'Line', type: 'line', optional: true, list: true }], outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [lineCfg(), { id: 'plan', label: 'Plan name', kind: 'text', default: 'Rain', help: 'The name of a manual service plan on the line.' }, { id: 'on', label: 'Switch', kind: 'select', default: 'on', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] }],
    action: { impact: 'high' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false.' };
      const lines = inp.line !== undefined ? items(inp.line).map((x) => idOf(x, 'line')).filter((x): x is string => !!x) : [str(cfg.line)].filter(Boolean);
      if (!lines.length) throw new Error('Choose or connect a line.');
      return actionOut(lines.map((route) => ctx.act({ type: 'service_plan', route, plan: str(cfg.plan), on: str(cfg.on) !== 'off' })));
    },
  },
  {
    type: 'action.fare', category: 'action', label: 'Change the fare', description: 'Sets the fare for every new journey. High impact.',
    inputs: [whenIn, { id: 'fare', label: 'Fare', type: 'number', optional: true }], outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [{ id: 'fare', label: 'Fare', kind: 'number', default: 1.8, min: 0, max: 10, step: 0.05 }], action: { impact: 'high' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false.' };
      return actionOut(ctx.act({ type: 'set_fare', fare: num(inp.fare) ?? num(cfg.fare) ?? 1.8 }));
    },
  },
  {
    type: 'action.notify', category: 'action', label: 'Send a notification', description: 'Adds a notification for you. Use {value} or {event.fleetNo} in the text to include values.',
    inputs: [whenIn, { id: 'value', label: 'Value', type: 'any', optional: true }], outputs: [{ id: 'result', label: 'Result', type: 'record' }],
    config: [
      { id: 'title', label: 'Title', kind: 'text', default: 'Line {value.number} is crowded' },
      { id: 'body', label: 'Message', kind: 'textarea', default: '' },
      { id: 'tone', label: 'Tone', kind: 'select', default: 'info', options: [{ value: 'info', label: 'Information' }, { value: 'good', label: 'Good news' }, { value: 'warn', label: 'Warning' }, { value: 'bad', label: 'Problem' }] },
    ],
    action: { impact: 'none' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF }, note: 'Condition was false.' };
      const vars: Record<string, Value> = { value: inp.value ?? null, event: ctx.event };
      const title = template(str(cfg.title), vars).slice(0, 80) || 'Automation';
      const body = template(str(cfg.body), vars).slice(0, 240);
      const r = ctx.notify((str(cfg.tone) || 'info') as 'info', title, body);
      return { out: { result: r }, note: `${r.outcomeLabel}: “${title}”` };
    },
  },
  {
    type: 'action.report', category: 'action', label: 'Add to report', description: 'Writes a line to this workflow’s report (shown in its history). Use {value} to include a value.',
    inputs: [{ id: 'value', label: 'Value', type: 'any', optional: true }], outputs: [], config: [{ id: 'text', label: 'Text', kind: 'text', default: 'Value: {value}' }], action: { impact: 'none' },
    run: (ctx, inp, cfg) => {
      const text = template(str(cfg.text), { value: inp.value ?? null, event: ctx.event }).slice(0, 200);
      ctx.report(text);
      return { out: {}, note: `Reported: ${text}` };
    },
  },

  // ── advanced
  {
    type: 'adv.function', category: 'advanced', label: 'Use a function', description: 'Runs one of your function workflows with inputs a, b, c and gives back its result.',
    inputs: [{ id: 'a', label: 'a', type: 'any', optional: true }, { id: 'b', label: 'b', type: 'any', optional: true }, { id: 'c', label: 'c', type: 'any', optional: true }], outputs: [{ id: 'value', label: 'Result', type: 'any' }],
    config: [{ id: 'workflow', label: 'Function', kind: 'workflow', default: '' }],
    run: (ctx, inp, cfg) => {
      const id = str(cfg.workflow);
      if (!id) throw new Error('Choose a function.');
      const v = ctx.call(id, { a: inp.a ?? null, b: inp.b ?? null, c: inp.c ?? null });
      return { out: { value: v }, note: `Returned ${fmt(v)}.` };
    },
  },
  {
    type: 'adv.forEach', category: 'advanced', label: 'For each item, use a function',
    description: 'Runs one of your functions once for every item of a list (at most 20): the item is its input a, its position (1, 2, …) is b, and whatever is connected to c is c. Gives back the results as a list. Actions inside the function run once per item.',
    inputs: [{ id: 'list', label: 'List', type: 'list' }, { id: 'c', label: 'c', type: 'any', optional: true }],
    outputs: [{ id: 'results', label: 'Results', type: 'list' }, { id: 'count', label: 'Count', type: 'number' }],
    config: [{ id: 'workflow', label: 'Function', kind: 'workflow', default: '' }, { id: 'max', label: 'At most', kind: 'number', default: 10, min: 1, max: 20, unit: 'items' }],
    run: (ctx, inp, cfg) => {
      const id = str(cfg.workflow);
      if (!id) throw new Error('Choose a function.');
      const list = Array.isArray(inp.list) ? inp.list : [];
      const max = Math.max(1, Math.min(20, Math.round(num(cfg.max) ?? 10)));
      const results: Value[] = list.slice(0, max).map((item, i) => ctx.call(id, { a: item, b: i + 1, c: inp.c ?? null }));
      const more = list.length > max ? ` (${list.length - max} more left out: at most ${max})` : '';
      return { out: { results, count: results.length }, note: `Ran the function for ${results.length} item${results.length === 1 ? '' : 's'}${more}.` };
    },
  },
  {
    type: 'adv.input', category: 'advanced', label: 'Function inputs', description: 'In a function: the values a, b and c it was called with.',
    inputs: [], outputs: [{ id: 'a', label: 'a', type: 'any' }, { id: 'b', label: 'b', type: 'any' }, { id: 'c', label: 'c', type: 'any' }], config: [],
    run: (ctx) => ({ out: { a: ctx.event.a ?? null, b: ctx.event.b ?? null, c: ctx.event.c ?? null } }),
  },
  {
    type: 'adv.output', category: 'advanced', label: 'Function result', description: 'In a function: the value it gives back.',
    inputs: [{ id: 'value', label: 'Value', type: 'any' }], outputs: [], config: [],
    run: (ctx, inp) => {
      ctx.memory['@result'] = trim(inp.value ?? null);
      return { out: {}, note: `Result ${fmt(inp.value)}.` };
    },
  },
  {
    type: 'adv.note', category: 'advanced', label: 'Note', description: 'A note on the canvas. It does nothing.',
    inputs: [], outputs: [], config: [{ id: 'text', label: 'Text', kind: 'textarea', default: '' }],
    run: () => ({ out: {} }),
  },
  // ───────────────────────────────────────────── control room: where buses are and where people go

  {
    type: 'trigger.bunching', category: 'trigger', label: 'Buses bunch or a gap opens',
    description: 'Runs when two buses on a line run close together, or a big gap opens between two buses, measured in timetable minutes between them (so slow traffic on its own does not set it off). The bus that has caught up comes out with how long to hold it to even out the gaps, and any late bus going the other way that could turn back early to fill a gap. Fires again only once the line is back to normal.',
    inputs: [], trigger: { source: 'condition' },
    outputs: [eventOut, { id: 'line', label: 'Line', type: 'line' }, { id: 'buses', label: 'Buses to hold', type: 'list', help: 'The bus behind in each close pair, with `hold`: the minutes that even out the gaps around it. Connect to “Hold a bus”.' }, { id: 'turnBacks', label: 'Could turn back', type: 'list', help: 'Late buses going the other way that could turn back early into the gap, each with the stop. Connect to “Turn a bus back early”.' }, { id: 'headway', label: 'Timetable gap', type: 'number' }],
    config: [
      lineCfg('Line', true),
      { id: 'what', label: 'When', kind: 'select', default: 'bunch', options: [{ value: 'bunch', label: 'Two buses run close together' }, { value: 'gap', label: 'A big gap opens' }] },
      { id: 'bunch', label: 'Close together: under', kind: 'number', default: 35, min: 10, max: 80, step: 5, unit: '%', help: 'Of the timetable gap. 35%: with a bus every 10 minutes, two buses under 3½ minutes apart.' },
      { id: 'gap', label: 'Big gap: over', kind: 'number', default: 160, min: 110, max: 400, step: 10, unit: '%', help: 'Of the timetable gap. 160%: with a bus every 10 minutes, 16 minutes or more between two buses.' },
      forCfg(5), ...hoursDays,
    ],
    run: (ctx, _inp, cfg) => {
      const line = str(ctx.event.line);
      if (!line || !ctx.game.state.routes[line]) return { out: { event: ctx.event, line: OFF, buses: OFF, turnBacks: OFF, headway: OFF }, note: 'The line no longer exists.' };
      const gp = lineGaps(ctx.game, line, gapOptions(cfg));
      ctx.spend(gp.buses.length * 3 + 5);
      const o = gapOptions(cfg);
      const hold = gp.buses.filter((b) => gp.headway && b.ahead !== null && b.ahead < o.bunch * gp.headway && b.hold > 0).map((b) => gapRec(ctx, b, gp.headway));
      const turn = gp.turnBacks;
      const num0 = ctx.game.state.routes[line].number;
      return {
        out: { event: ctx.event, line: ctx.live.line(line) ?? OFF, buses: hold.length ? hold : OFF, turnBacks: turn.length ? turn : OFF, headway: gp.headway ?? OFF },
        note: `Line ${num0}: ${gp.bunched} close pair${gp.bunched === 1 ? '' : 's'}${gp.worstGap !== null ? `, longest gap ${gp.worstGap}% of the timetable gap` : ''}${gp.headway ? ` (a bus every ${gp.headway} min)` : ''}. ${hold.length ? `${hold.length} bus${hold.length === 1 ? '' : 'es'} to hold.` : 'None needs holding now.'}${turn.length ? ` ${turn.length} could turn back.` : ''}`,
      };
    },
  },
  {
    type: 'data.gaps', category: 'data', label: 'Gaps between buses',
    description: 'The buses on a line now, in order along each direction, with the time to the bus ahead and behind (in timetable minutes), the timetable gap, and how long each would have to wait to even out the gaps. Also late buses going the other way that could turn back early to fill a big gap.',
    inputs: [afterIn, { id: 'line', label: 'Line', type: 'line', optional: true }],
    outputs: [{ id: 'buses', label: 'Buses', type: 'list' }, { id: 'hold', label: 'To hold', type: 'list', help: 'Buses close behind another, with `hold` (minutes).' }, { id: 'turnBacks', label: 'Could turn back', type: 'list' }, { id: 'headway', label: 'Timetable gap', type: 'number' }, { id: 'worst', label: 'Longest gap', type: 'number', help: 'As a share of the timetable gap (%).' }],
    config: [lineCfg(), { id: 'bunch', label: 'Close together: under', kind: 'number', default: 35, min: 10, max: 80, step: 5, unit: '%' }, { id: 'gap', label: 'Big gap: over', kind: 'number', default: 160, min: 110, max: 400, step: 10, unit: '%' }],
    run: (ctx, inp, cfg) => {
      const line = idOf(inp.line, 'line') ?? (str(cfg.line) || null);
      if (!line || !ctx.game.state.routes[line]) throw new Error('Choose or connect a line.');
      const o = gapOptions(cfg);
      const gp = lineGaps(ctx.game, line, o);
      ctx.spend(gp.buses.length * 3 + 5);
      const buses = gp.buses.map((b) => gapRec(ctx, b, gp.headway));
      const hold = gp.buses.filter((b) => gp.headway && b.ahead !== null && b.ahead < o.bunch * gp.headway && b.hold > 0).map((b) => gapRec(ctx, b, gp.headway));
      const n = ctx.game.state.routes[line].number;
      return {
        out: { buses, hold, turnBacks: gp.turnBacks, headway: gp.headway ?? OFF, worst: gp.worstGap ?? OFF },
        note: gp.headway === null ? `Line ${n} has no timetable running now.` : `Line ${n}: ${buses.length} bus${buses.length === 1 ? '' : 'es'} on trips, a bus every ${gp.headway} min, ${gp.bunched} close pair${gp.bunched === 1 ? '' : 's'}${gp.worstGap !== null ? `, longest gap ${gp.worstGap}%` : ''}.`,
      };
    },
  },
  {
    type: 'data.connections', category: 'data', label: 'Connections at risk',
    description: 'People on your buses now who change to another of your lines at a stop ahead, and whether the bus they want leaves before they get there, from their own journey plans and the buses’ predicted times. `holdNeeded`: how many minutes the connecting bus would have to wait for them. An estimate: traffic can change it.',
    inputs: [afterIn, { id: 'line', label: 'Arriving on line', type: 'line', optional: true }],
    outputs: [{ id: 'connections', label: 'Connections', type: 'list' }, { id: 'first', label: 'Most people', type: 'record' }, { id: 'people', label: 'People', type: 'number' }, { id: 'count', label: 'How many', type: 'number' }],
    config: [
      lineCfg('Arriving on line', true),
      { id: 'within', label: 'Arriving within', kind: 'number', default: 15, min: 3, max: 60, step: 1, unit: 'min' },
      { id: 'show', label: 'Show', kind: 'select', default: 'risk', options: [{ value: 'risk', label: 'Only those about to miss it' }, { value: 'tight', label: 'Also those with under 2 minutes to spare' }, { value: 'all', label: 'Every connection' }] },
    ],
    run: (ctx, inp, cfg) => {
      const line = idOf(inp.line, 'line') ?? (str(cfg.line) || null);
      const all = missedConnections(ctx.game, line, Math.max(3, Math.min(60, num(cfg.within) ?? 15)), 40);
      ctx.spend(ctx.game.vehicleList().length * 4 + all.length * 10);
      const show = str(cfg.show) || 'risk';
      const list = all.filter((c) => show === 'all' || c.missed || (show === 'tight' && (c.margin as number) < 2));
      const people = list.reduce((a, c) => a + (c.people as number), 0);
      const top = [...list].sort((a, b) => (b.people as number) - (a.people as number))[0];
      return {
        out: { connections: list, first: top ?? OFF, people, count: list.length },
        note: list.length ? `${list.length} connection${list.length === 1 ? '' : 's'}, ${people} ${people === 1 ? 'person' : 'people'}${top ? `; most at ${str(top.stopName)} onto line ${str(top.toLineNumber)} (${str(top.people)}, ${top.missed ? `the bus leaves ${Math.abs(num(top.margin) ?? 0)} min before they arrive` : `${str(top.margin)} min to spare`})` : ''}. Estimate.` : `No connection${show === 'all' ? 's' : ' at risk'} in the next ${num(cfg.within) ?? 15} min.`,
      };
    },
  },
  {
    type: 'data.occupancyForecast', category: 'data', label: 'How full departures will be',
    description: 'A line’s next departures with the expected boardings and how full each bus will be at its fullest point: the demand forecast for each hour shared between that hour’s departures, scaled by how the line’s riders have been spread along it on recent days. An estimate: use it to spot a crowded departure before it leaves.',
    inputs: [afterIn, { id: 'line', label: 'Line', type: 'line', optional: true, list: true }],
    outputs: [{ id: 'departures', label: 'Departures', type: 'list' }, { id: 'fullest', label: 'Fullest', type: 'record' }, { id: 'count', label: 'How many', type: 'number' }],
    config: [lineCfg(), { id: 'count', label: 'Next', kind: 'number', default: 6, min: 1, max: 30, unit: 'departures' }, { id: 'hours', label: 'Within', kind: 'select', default: '3', options: [{ value: '1', label: 'The next hour' }, { value: '3', label: 'The next 3 hours' }, { value: '6', label: 'The next 6 hours' }] }],
    run: (ctx, inp, cfg) => {
      const lines = inp.line !== undefined ? items(inp.line, 5).map((x) => idOf(x, 'line')).filter((x): x is string => !!x) : [str(cfg.line)].filter(Boolean);
      if (!lines.length) throw new Error('Choose or connect a line.');
      const hours = Math.max(1, Math.min(6, Number(cfg.hours) || 3));
      const n = Math.max(1, Math.min(30, num(cfg.count) ?? 6));
      ctx.spend(hours * 60 * lines.length);
      const deps = lines.flatMap((l) => forecastOccupancy(ctx.game, l, n, hours));
      const fullest = deps.reduce<Rec | null>((a, d) => (!a || (d.occupancy as number) > (a.occupancy as number) ? d : a), null);
      const assumed = deps.some((d) => d.ratioFrom === 'assumed');
      return {
        out: { departures: deps, fullest: fullest ?? OFF, count: deps.length },
        note: fullest ? `${deps.length} departure${deps.length === 1 ? '' : 's'}; fullest ${str(fullest.label)}: about ${str(fullest.occupancy)}% full at its busiest point. Estimate${assumed ? ' (with little recorded riding yet, a typical spread along the line is assumed)' : ''}.` : 'No departures in that time.',
      };
    },
  },
  {
    type: 'data.nearbyStops', category: 'data', label: 'Stops nearby',
    description: 'Your stops within a walk of a place, stop, bus or event, nearest first, with the lines at each and the people waiting. The walk is estimated as a quarter longer than the straight line.',
    inputs: [afterIn, { id: 'at', label: 'Near', type: 'any', help: 'A place, stop, bus or event, or any record with lng and lat (e.g. a gap from Coverage).' }],
    outputs: [{ id: 'stops', label: 'Stops', type: 'list' }, { id: 'nearest', label: 'Nearest', type: 'record' }, { id: 'lines', label: 'Lines there', type: 'list' }, { id: 'count', label: 'How many', type: 'number' }],
    config: [{ id: 'walk', label: 'Within a walk of', kind: 'number', default: 500, min: 50, max: 2000, step: 50, unit: 'm' }, { id: 'limit', label: 'At most', kind: 'number', default: 10, min: 1, max: 30 }],
    run: (ctx, inp, cfg) => {
      const at = pointOf(ctx.game, inp.at);
      if (!at) throw new Error('Connect a place, stop, bus or event (or a record with lng and lat).');
      ctx.spend(Math.ceil(Object.keys(ctx.game.state.stops).length / 10) + 5);
      const walk = Math.max(50, Math.min(2000, num(cfg.walk) ?? 500));
      const stops = nearbyStops(ctx.game, at, walk, Math.max(1, Math.min(30, num(cfg.limit) ?? 10)));
      const ids = [...new Set(stops.flatMap((s) => s.lineIds as string[]))].sort();
      const lines = ids.map((id) => ctx.live.line(id)).filter((x): x is Rec => !!x);
      return {
        out: { stops, nearest: stops[0] ?? OFF, lines: lines.length ? lines : OFF, count: stops.length },
        note: stops.length ? `${stops.length} stop${stops.length === 1 ? '' : 's'} within ${walk} m; nearest ${str(stops[0].name)} (about ${str(stops[0].walk)} m, ${str(stops[0].walkMin)} min on foot). Lines there: ${lines.map((l) => l.number).join(', ') || 'none'}.` : `None of your stops is within a ${walk} m walk.`,
      };
    },
  },
  {
    type: 'data.roadRoute', category: 'data', label: 'Road route between',
    description: 'The quickest legal road route a bus could take between two places: distance, minutes at free-flow speed, and minutes in the traffic and weather now. Use it to check whether a detour or a new link is worth it.',
    inputs: [afterIn, { id: 'from', label: 'From', type: 'any' }, { id: 'to', label: 'To', type: 'any' }],
    outputs: [{ id: 'route', label: 'Route', type: 'record' }, { id: 'minutes', label: 'Minutes now', type: 'number' }, { id: 'km', label: 'Distance', type: 'number' }],
    config: [],
    run: (ctx, inp) => {
      const a = pointOf(ctx.game, inp.from), b = pointOf(ctx.game, inp.to);
      if (!a || !b) throw new Error('Connect two places, stops, buses or events (or records with lng and lat).');
      ctx.spend(60);
      const r = roadTrip(ctx.game, a, b);
      if (!r) return { out: { route: OFF, minutes: OFF, km: OFF }, note: 'No road links those two places.' };
      return { out: { route: r, minutes: r.minutesNow, km: r.km }, note: `${str(r.km)} km by road: ${str(r.minutes)} min at free-flow speed, about ${str(r.minutesNow)} min now${(r.slowerBy as number) > 0 ? ` (${str(r.slowerBy)}% slower in traffic)` : ''}. Estimate.` };
    },
  },
  {
    type: 'data.coverage', category: 'data', label: 'Coverage',
    description: 'How many of the residents and jobs in your areas are within a walk of your stops (or one line’s stops), and the biggest places left out, each with lng and lat (connect one to “Stops nearby”). From the map’s land use: an estimate.',
    inputs: [afterIn, { id: 'line', label: 'Line', type: 'line', optional: true, list: true }],
    outputs: [{ id: 'coverage', label: 'Coverage', type: 'record' }, { id: 'residents', label: 'Residents reached', type: 'number', help: '%' }, { id: 'jobs', label: 'Jobs reached', type: 'number', help: '%' }, { id: 'gaps', label: 'Left out', type: 'list' }],
    config: [lineCfg('Only the stops of line', true), { id: 'walk', label: 'Within a walk of', kind: 'number', default: 400, min: 100, max: 1000, step: 50, unit: 'm' }],
    run: (ctx, inp, cfg) => {
      const s = ctx.game.state;
      const lines = inp.line !== undefined ? items(inp.line, 20).map((x) => idOf(x, 'line')).filter((x): x is string => !!x) : [str(cfg.line)].filter(Boolean);
      const stops = lines.length ? [...new Set(lines.flatMap((l) => (s.routes[l] ? [...s.routes[l].stops, ...(s.routes[l].returnStops ?? [])] : [])))] : Object.keys(s.stops);
      ctx.spend(200);
      const c = coverage(ctx.game, stops, Math.max(100, Math.min(1000, num(cfg.walk) ?? 400)));
      const who = lines.length ? `line${lines.length === 1 ? '' : 's'} ${lines.map((l) => s.routes[l]?.number ?? '?').join(', ')}` : 'your stops';
      return {
        out: { coverage: c, residents: c.residents ?? OFF, jobs: c.jobs ?? OFF, gaps: c.gaps },
        note: c.residents === null ? 'Nobody lives or works in your areas on this map.' : `Within ${str(c.walk)} m of ${who}: ${str(c.residents)}% of residents and ${str(c.jobs)}% of jobs in your areas. Estimate.`,
      };
    },
  },
  {
    type: 'data.transfers', category: 'data', label: 'Where lines meet',
    description: 'Places where two of your lines meet, at the same stop or stops a short walk apart, with the average wait for the second line (half its timetable gap) and how many people changed there a day over the last week.',
    inputs: [afterIn, { id: 'line', label: 'From line', type: 'line', optional: true }],
    outputs: [{ id: 'transfers', label: 'Changes', type: 'list' }, { id: 'busiest', label: 'Busiest', type: 'record' }, { id: 'count', label: 'How many', type: 'number' }],
    config: [lineCfg('From line', true), { id: 'walk', label: 'Stops at most', kind: 'number', default: 200, min: 0, max: 600, step: 50, unit: 'm apart', help: '0: only the same stop.' }, { id: 'limit', label: 'At most', kind: 'number', default: 10, min: 1, max: 30 }],
    run: (ctx, inp, cfg) => {
      const line = idOf(inp.line, 'line') ?? (str(cfg.line) || null);
      const n = Object.keys(ctx.game.state.routes).length;
      ctx.spend(n * (line ? 1 : n) * 4 + 20);
      const list = transferPoints(ctx.game, line, Math.max(0, Math.min(600, num(cfg.walk) ?? 200)), Math.max(1, Math.min(30, num(cfg.limit) ?? 10)));
      const top = list[0];
      return {
        out: { transfers: list, busiest: top ?? OFF, count: list.length },
        note: top ? `${list.length} place${list.length === 1 ? '' : 's'} where lines meet; busiest ${str(top.label)} (about ${str(top.changesPerDay)} changes a day${top.wait !== null ? `, ${str(top.wait)} min average wait` : ''}).` : 'None of your lines meet.',
      };
    },
  },

  // ───────────────────────────────────────────── control room: timing and choosing

  {
    type: 'logic.wait', category: 'logic', label: 'Wait',
    description: 'Pauses here and carries on later: after a number of minutes, or once a figure for the line, stop or bus passed in crosses a value (e.g. until line 3’s buses are under 80% full, giving up after an hour). Then only the steps after it run, with fresh figures for the line, stop or bus; nothing before it runs again. Use it to check whether an action worked.',
    inputs: [{ id: 'value', label: 'Value', type: 'any', help: 'What it carries on with. For “until”, the line, stop or bus whose figure it checks.' }],
    outputs: [{ id: 'then', label: 'Then', type: 'any' }, { id: 'timeout', label: 'Gave up', type: 'any', help: 'Waiting until a figure: it did not get there in time.' }, { id: 'waited', label: 'Minutes waited', type: 'number' }],
    config: [
      { id: 'mode', label: 'Wait', kind: 'select', default: 'minutes', options: [{ value: 'minutes', label: 'A number of minutes' }, { value: 'until', label: 'Until a figure crosses a value' }] },
      { id: 'minutes', label: 'For', kind: 'number', default: 30, min: 1, max: 720, step: 5, unit: 'min' },
      { id: 'figure', label: 'Until', kind: 'select', default: 'line.occupancy', options: FIGURE_OPTIONS },
      { id: 'op', label: 'Is', kind: 'select', default: 'below', options: [{ value: 'below', label: 'Below' }, { value: 'above', label: 'Above' }] },
      { id: 'value', label: 'Value', kind: 'number', default: 80 },
      { id: 'timeout', label: 'Give up after', kind: 'number', default: 60, min: 5, max: 720, step: 5, unit: 'min' },
    ],
    run: (ctx, inp, cfg) => {
      const v = inp.value === undefined ? null : inp.value;
      const what = fmt(v);
      const t = ctx.game.t;
      if (str(cfg.mode) !== 'until') {
        const m = Math.max(1, Math.min(720, num(cfg.minutes) ?? 30));
        if (ctx.test) return { out: { then: v, timeout: OFF, waited: 0 }, note: `Test run: carries straight on. A real run waits ${m} min here (until ${hhmm(t + m * 60)}).` };
        const r = ctx.later({ kind: 'wait', due: t + m * 60, value: v, label: what, key: keyOf(v) ?? 'all' });
        return { out: { then: OFF, timeout: OFF, waited: OFF }, note: r.ok ? `Waiting ${m} min, until ${hhmm(t + m * 60)}, then carries on with ${what}.` : r.note };
      }
      const fig = FIGURE[str(cfg.figure)];
      if (!fig) throw new Error('Choose a figure to wait for.');
      const kind = fig.scope === 'bus' ? 'vehicle' : fig.scope;
      const item = fig.scope === 'company' ? null : idOf(v, kind);
      if (fig.scope !== 'company' && !item) throw new Error(`“${fig.label}” is a figure for a ${fig.scope}: connect one.`);
      const op = str(cfg.op) === 'above' ? 'above' : 'below';
      const thr = num(cfg.value) ?? 0;
      const now = figureValue(ctx.game, fig.id, item);
      const label = fig.scope === 'company' ? 'the company' : what;
      if (now !== null && (op === 'above' ? now > thr : now < thr)) return { out: { then: v, timeout: OFF, waited: 0 }, note: `${fig.label} for ${label} is already ${op} ${thr} (${now}): carries straight on.` };
      const m = Math.max(5, Math.min(720, num(cfg.timeout) ?? 60));
      if (ctx.test) return { out: { then: v, timeout: OFF, waited: 0 }, note: `Test run: carries straight on. A real run waits until ${fig.label.toLowerCase()} for ${label} is ${op} ${thr} (now ${now ?? 'unknown'}), giving up at ${hhmm(t + m * 60)}.` };
      const r = ctx.later({ kind: 'wait', due: t + m * 60, value: v, until: { figure: fig.id, item, op, value: thr }, label, key: item ?? 'company' });
      return { out: { then: OFF, timeout: OFF, waited: OFF }, note: r.ok ? `Waiting until ${fig.label.toLowerCase()} for ${label} is ${op} ${thr} (now ${now ?? 'unknown'}); gives up at ${hhmm(t + m * 60)}.` : r.note };
    },
    resume: (ctx, p) => {
      const mins = Math.round((ctx.game.t - p.from) / 60);
      const v = fresh(ctx, p.value ?? null);
      if (p.outcome === 'timeout') return { out: { then: OFF, timeout: v, waited: mins }, note: `Gave up after ${mins} min: carries on down “Gave up” with ${fmt(v)}.` };
      return { out: { then: v, timeout: OFF, waited: mins }, note: `Carried on after ${mins} min with ${fmt(v)}${p.until ? ` (${FIGURE[p.until.figure]?.label.toLowerCase() ?? 'the figure'} is ${p.until.op} ${p.until.value})` : ''}.` };
    },
  },
  {
    type: 'logic.queue', category: 'logic', label: 'One at a time',
    description: 'Lines items up and passes them on one (or a few) at a time, at most once every so many minutes, and carries on by itself until none are left: e.g. send worn buses for maintenance one by one so no line is left short. An item already waiting, or passed on recently, is not added again.',
    inputs: [{ id: 'items', label: 'Items', type: 'any', help: 'A list, or one item each run (e.g. from an event trigger).' }],
    outputs: [{ id: 'next', label: 'Next', type: 'any' }, { id: 'batch', label: 'Passed on', type: 'list' }, { id: 'waiting', label: 'Still waiting', type: 'number' }],
    config: [
      { id: 'per', label: 'How many at a time', kind: 'number', default: 1, min: 1, max: 10 },
      { id: 'every', label: 'At most once every', kind: 'number', default: 30, min: 1, max: 1440, step: 5, unit: 'min' },
      { id: 'again', label: 'Do not take the same one again for', kind: 'number', default: 240, min: 0, max: 2880, step: 30, unit: 'min' },
    ],
    run: (ctx, inp, cfg, node) => {
      const q = queueState(ctx, node.id);
      const t = ctx.game.t;
      const again = Math.max(0, num(cfg.again) ?? 240) * 60;
      for (const [k, at] of Object.entries(q.done)) if (t - (at as number) >= again) delete q.done[k];
      const incoming = Array.isArray(inp.items) ? inp.items.slice(0, 50) : inp.items === undefined || inp.items === null ? [] : [inp.items];
      let added = 0;
      for (const it of incoming) {
        const k = itemKey(it);
        if (q.done[k] !== undefined || q.items.some((x) => itemKey(x) === k) || q.items.length >= 50) continue;
        q.items.push(it);
        added++;
      }
      ctx.spend(incoming.length + 1);
      return releaseQueue(ctx, cfg, q, added);
    },
    resume: (ctx, _p, cfg, node) => releaseQueue(ctx, cfg, queueState(ctx, node.id), 0),
  },
  {
    type: 'logic.assign', category: 'logic', label: 'Best pairs',
    description: 'Pairs items of list A with items of list B so the total score is as low (or as high) as possible, choosing every pair together rather than one at a time. E.g. spare buses (A) to lines short of buses (B), scored by `km`, the distance from the bus to the line. Each item is used at most once; a pair whose score is empty (null) is never made.',
    inputs: [{ id: 'a', label: 'A', type: 'list' }, { id: 'b', label: 'B', type: 'list' }],
    outputs: [{ id: 'pairs', label: 'Pairs', type: 'list', help: 'Each with `a`, `b` and `score`. A pair of a bus and a line works where a bus or a line is wanted (e.g. “Move bus to line”).' }, { id: 'first', label: 'Best pair', type: 'record' }, { id: 'leftA', label: 'A left over', type: 'list' }, { id: 'leftB', label: 'B left over', type: 'list' }],
    config: [
      { id: 'score', label: 'Score', kind: 'expr', default: 'km', vars: ['a', 'b', 'km'], help: '`a` and `b` are the two items, `km` the distance between them on the map (null if either has no place). E.g. km, or km - b.short * 5.' },
      { id: 'goal', label: 'Best is', kind: 'select', default: 'low', options: [{ value: 'low', label: 'The lowest total' }, { value: 'high', label: 'The highest total' }] },
      { id: 'max', label: 'At most', kind: 'number', default: 10, min: 1, max: 30, unit: 'pairs' },
    ],
    run: (ctx, inp, cfg) => {
      const A = Array.isArray(inp.a) ? inp.a.slice(0, 30) : [];
      const B = Array.isArray(inp.b) ? inp.b.slice(0, 30) : [];
      if (!A.length || !B.length) return { out: { pairs: [], first: OFF, leftA: A, leftB: B }, note: `Nothing to pair: list ${A.length ? 'B' : 'A'} is empty.` };
      const src = str(cfg.score) || 'km';
      const high = str(cfg.goal) === 'high';
      const ptsA = A.map((x) => pointOf(ctx.game, x)), ptsB = B.map((x) => pointOf(ctx.game, x));
      const lineA = A.map(linePoint), lineB = B.map(linePoint);
      const score: number[][] = A.map((a, i) => B.map((b, j) => {
        const km = pairKm(ctx, ptsA[i], lineA[i], ptsB[j], lineB[j]);
        const v = expr(ctx, src, { a, b, km });
        const n = num(v);
        return n === null ? Infinity : high ? -n : n;
      }));
      const pick = assignRows(score);
      const max = Math.max(1, Math.min(30, num(cfg.max) ?? 10));
      let pairs = pick.map((j, i) => (j < 0 ? null : { i, j, s: high ? -score[i][j] : score[i][j] })).filter((x): x is { i: number; j: number; s: number } => !!x);
      pairs.sort((x, y) => (high ? y.s - x.s : x.s - y.s) || x.i - y.i);
      pairs = pairs.slice(0, max);
      const usedA = new Set(pairs.map((p) => p.i)), usedB = new Set(pairs.map((p) => p.j));
      const recs = pairs.map((p) => pairRec(A[p.i], B[p.j], p.s));
      const total = pairs.reduce((n, p) => n + p.s, 0);
      return {
        out: { pairs: recs, first: recs[0] ?? OFF, leftA: A.filter((_, i) => !usedA.has(i)), leftB: B.filter((_, j) => !usedB.has(j)) },
        note: recs.length ? `${recs.length} pair${recs.length === 1 ? '' : 's'}, total score ${Math.round(total * 10) / 10} (${high ? 'highest' : 'lowest'} possible): ${recs.slice(0, 3).map((r) => str(r.label)).join('; ')}${recs.length > 3 ? '…' : ''}.` : 'No pair has a score: nothing paired.',
      };
    },
  },

  // ───────────────────────────────────────────── control room: actions

  {
    type: 'action.hold', category: 'action', label: 'Hold a bus',
    description: 'Keeps a bus at a stop for a few minutes after its normal stop, doors open, then it carries on. Use it to even out bunched buses (hold the one that has caught up) or to wait for people changing from a late bus. A bus from “Gaps between buses” is held for the minutes that even out the gaps; a connection from “Connections at risk” holds the connecting bus as long as needed.',
    inputs: [whenIn, { id: 'bus', label: 'Bus', type: 'any', list: true, help: 'A bus, a bus from “Gaps between buses”, or a connection from “Connections at risk”.' }, { id: 'stop', label: 'At stop', type: 'stop', optional: true, help: 'Unconnected: its next stop (or the stop it is at), or the connection’s stop.' }, { id: 'minutes', label: 'Minutes', type: 'number', optional: true }],
    outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [
      { id: 'minutes', label: 'For', kind: 'number', default: 2, min: 1, max: 10, unit: 'min', help: 'For a plain bus. Buses from “Gaps between buses” and connections bring their own minutes.' },
      { id: 'max', label: 'Never longer than', kind: 'number', default: 5, min: 1, max: 10, unit: 'min', help: 'People on board wait too, so keep holds short.' },
    ],
    action: { impact: 'low' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false: no bus held.' };
      const list = items(inp.bus);
      if (!list.length) return { out: { result: OFF, done: false }, note: 'No bus connected.' };
      const cap = Math.max(1, Math.min(10, num(cfg.max) ?? 5));
      const recs: Rec[] = [], skipped: string[] = [];
      for (const x of list) {
        let bus: string | null, stop = idOf(inp.stop, 'stop'), m = num(inp.minutes) ?? (num(cfg.minutes) ?? 2);
        if (isRec(x) && x.kind === 'connection') {
          bus = str(x.connectingBus) || null;
          stop ??= str(x.stop) || null;
          if (inp.minutes === undefined) m = num(x.holdNeeded) ?? 0;
          if (!bus) { skipped.push(`No bus is running the connection at ${str(x.stopName)} yet.`); continue; }
        } else {
          bus = idOf(x, 'vehicle');
          if (inp.minutes === undefined && isRec(x) && typeof x.hold === 'number') m = x.hold;
        }
        if (!bus) continue;
        if (m < 1) { skipped.push(`${isRec(x) && x.kind === 'connection' ? `Line ${str(x.toLineNumber)} at ${str(x.stopName)}` : fmt(x)} needs no hold.`); continue; }
        recs.push(ctx.act({ type: 'hold_vehicle', vehicle: bus, minutes: Math.min(cap, Math.round(m)), ...(stop ? { stop } : {}) }));
      }
      return actionsOut(recs, skipped);
    },
  },
  {
    type: 'action.shortTurn', category: 'action', label: 'Turn a bus back early',
    description: 'Ends a bus’s trip at a stop before the end of the line and runs it back the other way from there. Everyone going further gets off for the next bus (they have already paid). The usual way to get a late bus back on time, or to fill a big gap going the other way. Connect a suggestion from “Gaps between buses” (it says where), or a bus and a stop. Lines that go both ways only.',
    inputs: [whenIn, { id: 'bus', label: 'Bus', type: 'any', list: true }, { id: 'stop', label: 'At stop', type: 'stop', optional: true, help: 'Unconnected: the stop the suggestion names.' }],
    outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [{ id: 'people', label: 'Only if at most', kind: 'number', default: 15, min: 0, max: 150, unit: 'people', help: 'have to get off and wait for the next bus.' }],
    action: { impact: 'low' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false: no bus turned back.' };
      const list = items(inp.bus, 3);
      if (!list.length) return { out: { result: OFF, done: false }, note: 'No bus connected.' };
      const most = Math.max(0, num(cfg.people) ?? 15);
      const recs: Rec[] = [], skipped: string[] = [];
      for (const x of list) {
        const bus = idOf(x, 'vehicle');
        const stop = idOf(inp.stop, 'stop') ?? (isRec(x) && typeof x.stop === 'string' ? x.stop : null);
        if (!bus) continue;
        if (!stop) throw new Error('Connect a stop to turn back at (or a suggestion from “Gaps between buses”).');
        const plan = turnPlan(ctx.game, bus, stop);
        if (plan.ok && plan.value.riders > most) { skipped.push(`${ctx.game.state.vehicles[bus]?.fleetNo ?? 'The bus'} has ${plan.value.riders} people going further: more than ${most}, so it carries on.`); continue; }
        recs.push(ctx.act({ type: 'short_turn', vehicle: bus, stop }));
      }
      return actionsOut(recs, skipped);
    },
  },
  {
    type: 'action.adjustDeparture', category: 'action', label: 'Move a departure',
    description: 'Moves one departure a few minutes earlier or later (at most 15 from its timetable time) without changing the rest of the timetable: e.g. spread two crowded departures apart, or leave a little later for people off a late train. Connect a departure from “How full departures will be”. A timetable change puts it back.',
    inputs: [whenIn, { id: 'departure', label: 'Departure', type: 'any', list: true }, { id: 'minutes', label: 'Minutes', type: 'number', optional: true }],
    outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [{ id: 'minutes', label: 'By', kind: 'number', default: 3, min: -10, max: 15, unit: 'min', help: 'Negative: earlier. It can only leave 5 minutes from now or later.' }],
    action: { impact: 'low' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false: no departure moved.' };
      const m = Math.round(num(inp.minutes) ?? num(cfg.minutes) ?? 3);
      const recs: Rec[] = [];
      for (const x of items(inp.departure, 5)) {
        const trip = isRec(x) ? num(x.trip) : num(x);
        const route = isRec(x) ? str(x.line) : '';
        const t = trip !== null ? ctx.game.trip(trip) : undefined;
        if (!t) throw new Error('Connect a departure from “How full departures will be”.');
        recs.push(ctx.act({ type: 'adjust_departure', route: route || t.route, trip: t.id, minutes: m }));
      }
      return actionsOut(recs, []);
    },
  },
  {
    type: 'action.detour', category: 'action', label: 'Temporary detour',
    description: 'Sends a line round an area for a while (a busy event, a jam, a closure) on the quickest other roads between the same stops. The stops stay the same; a stop inside the area is still served. Each changed stretch switches over once no bus is driving it, and back when the time is up. Choose “End the detour” to end one early.',
    inputs: [whenIn, { id: 'line', label: 'Line', type: 'line', optional: true, list: true }, { id: 'at', label: 'Around', type: 'any', optional: true, help: 'A place, event or stop, or a record with lng and lat.' }],
    outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [
      lineCfg(),
      { id: 'do', label: 'Do', kind: 'select', default: 'start', options: [{ value: 'start', label: 'Start a detour' }, { value: 'end', label: 'End the detour' }] },
      { id: 'radius', label: 'Avoid within', kind: 'number', default: 300, min: 100, max: 800, step: 50, unit: 'm', help: 'Of the centre of what is connected to “Around”.' },
      { id: 'minutes', label: 'For', kind: 'number', default: 120, min: 15, max: 360, step: 15, unit: 'min' },
    ],
    action: { impact: 'low' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false: no detour.' };
      const lines = inp.line !== undefined ? items(inp.line, 5).map((x) => idOf(x, 'line')).filter((x): x is string => !!x) : [str(cfg.line)].filter(Boolean);
      if (!lines.length) throw new Error('Choose or connect a line.');
      if (str(cfg.do) === 'end') return actionsOut(lines.map((route) => ctx.act({ type: 'end_detour', route })), []);
      const at = pointOf(ctx.game, inp.at);
      if (!at) throw new Error('Connect what to drive round: a place, event or stop.');
      ctx.spend(lines.length * 80);
      const why = isRec(inp.at) ? str(inp.at.eventTitle) || str(inp.at.title) || str(inp.at.name) || str(inp.at.label) : '';
      return actionsOut(lines.map((route) => ctx.act({ type: 'detour', route, at, radius: num(cfg.radius) ?? 300, minutes: num(cfg.minutes) ?? 120, why })), []);
    },
  },
  {
    type: 'action.proposeRoute', category: 'action', label: 'Suggest a route change',
    description: 'Prepares a change to your network for you to review: add a stop to a line (where it adds the least distance), take a stop off a line, or a new line through a list of stops (e.g. a corridor from “Unserved trips”). It never changes anything by itself: each suggestion waits for your approval in Network Control → Automation for 3 days, with the distance, time and buses it would add.',
    inputs: [whenIn, { id: 'line', label: 'Line', type: 'line', optional: true }, { id: 'stop', label: 'Stop', type: 'stop', optional: true, list: true }, { id: 'stops', label: 'Stops of a new line', type: 'list', optional: true, help: 'Stops in order, or a connection from “Unserved trips” (it brings a sketch of the line).' }],
    outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [
      { id: 'op', label: 'Suggest', kind: 'select', default: 'add_stop', options: [{ value: 'add_stop', label: 'Add a stop to a line' }, { value: 'remove_stop', label: 'Take a stop off a line' }, { value: 'new_line', label: 'A new line' }] },
      lineCfg('Line', true),
    ],
    action: { impact: 'high' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false: nothing suggested.' };
      const op = str(cfg.op) || 'add_stop';
      if (op === 'new_line') {
        const src = inp.stops;
        const sketches: string[][] = [];
        const listOf = (v: Value | undefined) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
        const all = listOf(src);
        if (all.some((x) => isRec(x) && x.kind === 'flow')) {
          for (const f of all.slice(0, 3)) if (isRec(f) && Array.isArray(f.stops) && f.stops.length >= 2) sketches.push(f.stops.map((x) => str(x)));
        } else {
          const ids = all.map((x) => idOf(x, 'stop')).filter((x): x is string => !!x);
          if (ids.length) sketches.push(ids);
        }
        if (!sketches.length) return { out: { result: OFF, done: false }, note: 'No stops to make a line from (a connection from “Unserved trips” needs stops in both areas).' };
        return actionsOut(sketches.map((stops) => ctx.act({ type: 'change_route', change: { op: 'new_line', stops } })), []);
      }
      const route = idOf(inp.line, 'line') ?? (str(cfg.line) || null);
      if (!route) throw new Error('Choose or connect a line.');
      const stops = items(inp.stop, 3).map((x) => idOf(x, 'stop')).filter((x): x is string => !!x);
      if (!stops.length) return { out: { result: OFF, done: false }, note: 'No stop connected.' };
      return actionsOut(stops.map((stop) => ctx.act({ type: 'change_route', change: { op: op === 'remove_stop' ? 'remove_stop' : 'add_stop', route, stop } })), []);
    },
  },
];

export const NODE: Record<string, NodeDef> = Object.fromEntries(NODES.map((n) => [n.type, n]));

/** Default settings for a new node of `type`. */
export function defaultConfig(type: string): Record<string, Value> {
  const def = NODE[type];
  return Object.fromEntries((def?.config ?? []).map((f) => [f.id, f.default]));
}

/** Fill {value}, {value.number}, {event.fleetNo} placeholders. */
export function template(text: string, vars: Record<string, Value>): string {
  return text.replace(/\{([a-zA-Z_][\w.]*)\}/g, (_m, path: string) => {
    let cur: Value | undefined = vars;
    for (const part of path.split('.')) {
      if (!isRec(cur) || !Object.hasOwn(cur, part)) return '';
      cur = cur[part];
    }
    if (cur === null || cur === undefined) return '';
    // large whole numbers get thousands separators; small ones (fleet and day numbers) stay plain
    if (typeof cur === 'number') return Number.isInteger(cur) ? (Math.abs(cur) >= 10000 ? cur.toLocaleString('en-GB') : String(cur)) : cur.toFixed(1);
    if (typeof cur === 'object') return fmt(cur);
    return String(cur);
  });
}

/** Keep stored values small (memory, traces). */
export function trim(v: Value, depth = 0): Value {
  if (v === null || typeof v !== 'object') return typeof v === 'string' ? v.slice(0, 200) : v;
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => trim(x, depth + 1));
  const out: Record<string, Value> = {};
  let n = 0;
  for (const [k, x] of Object.entries(v)) {
    if (n++ > 24) break;
    out[k] = trim(x, depth + 1);
  }
  return out;
}

/** Port type compatibility for connections. */
export function canConnect(from: PortType, to: PortType, toList = false): boolean {
  if (from === to || from === 'any' || to === 'any') return true;
  const entity = (t: PortType) => t === 'line' || t === 'stop' || t === 'vehicle';
  if (to === 'record' && (entity(from) || from === 'event')) return true;
  if (entity(to) && from === 'record') return true;
  if (entity(to) && from === 'list' && toList) return true;
  if (to === 'number' && from === 'boolean') return true;
  if (to === 'boolean' && (from === 'number' || from === 'list' || from === 'record' || entity(from))) return true;
  if (to === 'text' && (from === 'number' || from === 'boolean')) return true;
  return false;
}

/** Label shown on a trigger node for its current settings (also used in history). */
export function triggerLabel(game: Game, node: WfNode): string {
  const c = node.config;
  const line = typeof c.line === 'string' && c.line ? ` on line ${game.state.routes[c.line]?.number ?? '?'}` : '';
  switch (node.type) {
    case 'trigger.every': return `Every ${c.minutes} minutes${timingWords(c)}`;
    case 'trigger.time': return `Every day at ${c.time}${c.days === 'weekdays' ? ' (weekdays)' : c.days === 'weekend' ? ' (weekends)' : ''}`;
    case 'trigger.day': return 'At the end of each day';
    case 'trigger.week': return 'At the end of each week';
    case 'trigger.arrive': return `A bus arrives${line}${timingWords(c)}`;
    case 'trigger.crowded': return `A bus leaves ${c.load}% full${line}${timingWords(c)}`;
    case 'trigger.late': return `A bus is ${c.minutes}+ min late${line}${timingWords(c)}`;
    case 'trigger.missed': return `A departure is missed${line}${timingWords(c)}`;
    case 'trigger.breakdown': return `A bus breaks down${line}${timingWords(c)}`;
    case 'trigger.waiting': return `${c.threshold}+ people waiting${line}${timingWords(c)}`;
    case 'trigger.balance': return `Balance below ${game.money(Number(c.amount) || 0, { compact: true })}${timingWords(c)}`;
    case 'trigger.leftBehind': return `${c.people}+ people left behind${line}${timingWords(c)}`;
    case 'trigger.gaveUp': return `${c.people}+ give up waiting at a stop${line}${timingWords(c)}`;
    case 'trigger.shortBuses': return `${line ? `Line ${game.state.routes[String(c.line)]?.number ?? '?'}` : 'A line'} short of buses${timingWords(c)}`;
    case 'trigger.watch': {
      const f = FIGURE[String(c.figure ?? '')];
      if (!f) return 'Watch a figure';
      const v = Number(c.value) || 0;
      const shown = f.unit === 'money' ? game.money(v, { compact: true }) : f.unit === '%' ? `${v}%` : `${v} ${f.unit}`;
      const who = f.scope === 'company' ? '' : line ? ` (line ${game.state.routes[String(c.line)]?.number ?? '?'})` : f.scope === 'line' ? ' (any line)' : f.scope === 'stop' ? ' (any stop)' : ' (any bus)';
      return `${f.label}${who} ${String(c.op) === 'below' ? 'below' : 'above'} ${shown}${timingWords(c)}`;
    }
    case 'trigger.peak': {
      const m = Number(c.minutes ?? 30) || 0;
      const who = line ? `line ${game.state.routes[String(c.line)]?.number ?? '?'}’s` : 'a line’s';
      const src = String(c.source) === 'riders' ? 'busiest hours' : 'peak';
      const when = String(c.at) === 'end' ? `${m ? `${m} min after` : 'When'} ${who} ${src} end${src === 'peak' ? 's' : ''}` : `${m ? `${m} min before` : 'When'} ${who} ${src} start${src === 'peak' ? 's' : ''}`;
      return `${when}${timingWords(c)}`;
    }
    case 'trigger.manual': return 'Run by hand';
    case 'trigger.bunching': {
      const who = line ? `Line ${game.state.routes[String(c.line)]?.number ?? '?'}` : 'A line';
      return String(c.what) === 'gap' ? `${who}: a gap over ${c.gap ?? 160}% of the timetable gap${timingWords(c)}` : `${who}: buses under ${c.bunch ?? 35}% of the timetable gap apart${timingWords(c)}`;
    }
    case 'trigger.forecast': {
      const f = String(c.when ?? 'any');
      return f === 'any' ? 'Tomorrow’s forecast (18:00)' : `Forecast at 18:00: ${FORECAST_FILTER.find((x) => x.value === f)?.label.toLowerCase() ?? f}`;
    }
    case 'trigger.weather': {
      const w = WEATHER_FILTER.find((x) => x.value === c.when)?.label.replace(/ \(any rain\)$/, '') ?? 'The weather changes';
      return `${w}${(c.from ?? 0) !== 0 || (c.to ?? 24) !== 24 ? `, ${String(c.from).padStart(2, '0')}:00–${String(c.to).padStart(2, '0')}:00` : ''}`;
    }
    case 'trigger.eventAnnounced': return `Announced: ${eventScope(game, c)}`;
    case 'trigger.eventStart': return `${Number(c.minutes) || 0} min before ${eventScope(game, c)}`;
    case 'trigger.eventEnd': {
      const m = Number(c.minutes) || 0;
      return `${m === 0 ? 'At the end of' : m < 0 ? `${-m} min before the end of` : `${m} min after the end of`} ${eventScope(game, c)}`;
    }
    case 'trigger.calendar': {
      const d = DAY_FILTER.find((x) => x.value === c.day)?.label ?? String(c.day);
      return `${c.first !== false ? `First day of ${d.toLowerCase()}` : d}, ${c.time}`;
    }
    default: return NODE[node.type]?.label ?? node.type;
  }
}

export const HOUR_S = HOUR;
