// The node library. Each node type declares its ports, settings and what it does; the editor
// and the executor both read this registry, so adding a node is adding one definition here.
//
// Values: numbers, booleans, text, records (a line, stop, bus, row: plain objects with `kind`
// and `id`) and lists. A branch that is not taken carries OFF: nodes that receive it do not run.

import type { Value, WfNode } from './types.ts';
import type { Command } from '../commands.ts';
import type { Game } from '../engine.ts';
import type { LiveData, Rec } from './live.ts';
import { compile, truthy, type EValue } from '../expr.ts';
import { aggregate, estimatedDemand, MEASURE, type GroupBy } from '../analytics/query.ts';
import { extraOption } from '../vehicles.ts';
import { DAY, HOUR } from '../content.ts';
import { hhmm } from '../time.ts';
import { DAYS_OPTIONS, FIGURE, FIGURE_OPTIONS, REPEAT_PER } from './watch.ts';
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
}

// ───────────────────────────────────────────── helpers

const num = (v: Value | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : null);
const str = (v: Value | undefined) => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v));
const isRec = (v: Value | undefined): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const idOf = (v: Value | undefined, kind: string): string | null => {
  if (typeof v === 'string' && v) return v;
  if (isRec(v) && (v.kind === kind || kind === 'any') && typeof v.id === 'string') return v.id;
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

const whenIn: PortDef = { id: 'when', label: 'When', type: 'any', optional: true, help: 'Connect a condition or a value: the action only runs when it is active and true.' };
/** An action's `when` input: unconnected = go, false/empty = skip. */
const go = (inp: Record<string, Value | undefined>) => !('when' in inp) || inp.when === undefined || truthy(inp.when as EValue);

// ───────────────────────────────────────────── the library

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
    config: [lineCfg('Line', true), { id: 'which', label: 'Which', kind: 'select', default: 'all', options: [{ value: 'all', label: 'All' }, { value: 'free', label: 'Free now' }, { value: 'spare', label: 'Spare (no line)' }, { value: 'working', label: 'On a trip' }] }],
    run: (ctx, inp, cfg) => {
      const lid = idOf(inp.line, 'line') ?? (str(cfg.line) || null);
      const which = str(cfg.which);
      let list = ctx.game.vehicleList().map((v) => ctx.live.bus(v));
      if (lid) list = list.filter((b) => b.line === lid);
      if (which === 'free') list = list.filter((b) => b.free);
      if (which === 'spare') list = list.filter((b) => b.spare);
      if (which === 'working') list = list.filter((b) => b.status === 'in_service' || b.status === 'at_stop');
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
      const flows: Value[] = between.slice(0, n).map((f) => ({
        kind: 'flow', from: f.oLabel, to: f.dLabel, label: `${f.oLabel} → ${f.dLabel}`, trips: Math.round(f.trips), value: Math.round(f.trips),
        missing: f.noStop >= f.noLink ? 'stop' : 'line', estimate: true,
      }));
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
      const val = (x: Value) => (isRec(x) ? x[f] : null);
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
      const vals = list.map((x) => (isRec(x) ? num(x[f]) : num(x))).filter((x): x is number => x !== null);
      const v = op === 'count' ? list.length : !vals.length ? null : op === 'sum' ? vals.reduce((a, b) => a + b, 0) : op === 'avg' ? vals.reduce((a, b) => a + b, 0) / vals.length : op === 'min' ? Math.min(...vals) : Math.max(...vals);
      return { out: { value: v }, note: `${op} of ${f} over ${list.length} item${list.length === 1 ? '' : 's'} = ${fmt(v)}` };
    },
  },
  {
    type: 'math.field', category: 'math', label: 'Get field', description: 'Reads one field of a record, e.g. a line’s occupancy.',
    inputs: [{ id: 'record', label: 'Record', type: 'record' }], outputs: [{ id: 'value', label: 'Value', type: 'any' }], config: [{ id: 'field', label: 'Field', kind: 'text', default: 'occupancy' }],
    run: (_ctx, inp, cfg) => { const f = str(cfg.field); const v = isRec(inp.record) && Object.hasOwn(inp.record, f) ? inp.record[f] : null; return { out: { value: v }, note: `${f} = ${fmt(v)}` }; },
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
    type: 'action.assign', category: 'action', label: 'Move bus to line', description: 'Moves a bus to a line. A bus with passengers finishes its trip and goes via the depot first.',
    inputs: [whenIn, { id: 'bus', label: 'Bus', type: 'vehicle', list: true }, { id: 'line', label: 'Line', type: 'line', optional: true }], outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }],
    config: [lineCfg()], action: { impact: 'low' },
    run: (ctx, inp, cfg) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false.' };
      const route = idOf(inp.line, 'line') ?? (str(cfg.line) || null);
      if (!route) throw new Error('Choose or connect a line.');
      const buses = items(inp.bus).map((x) => idOf(x, 'vehicle')).filter((x): x is string => !!x);
      if (!buses.length) return { out: { result: OFF, done: false }, note: 'No bus connected.' };
      return actionOut(buses.map((vehicle) => ctx.act({ type: 'assign_vehicle', vehicle, route })));
    },
  },
  {
    type: 'action.release', category: 'action', label: 'Take bus off line', description: 'Makes a bus a spare. It finishes any trip first, then returns to its depot.',
    inputs: [whenIn, { id: 'bus', label: 'Bus', type: 'vehicle', list: true }], outputs: [{ id: 'result', label: 'Result', type: 'record' }, { id: 'done', label: 'Done', type: 'boolean' }], config: [], action: { impact: 'low' },
    run: (ctx, inp) => {
      if (!go(inp)) return { out: { result: OFF, done: false }, note: 'Condition was false.' };
      const buses = items(inp.bus).map((x) => idOf(x, 'vehicle')).filter((x): x is string => !!x);
      if (!buses.length) return { out: { result: OFF, done: false }, note: 'No bus connected.' };
      return actionOut(buses.map((vehicle) => ctx.act({ type: 'assign_vehicle', vehicle, route: null })));
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
    type: 'action.moveDepot', category: 'action', label: 'Move bus to depot', description: 'Bases a bus at another depot. A parked bus drives there on the road; a working bus goes there next time it returns.',
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
    case 'trigger.manual': return 'Run by hand';
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
