// "Compare with a normal day": a figure for the last hour (or the last three hours, or today so
// far) against the same hours on comparable recorded days — the same day of the week, the same
// kind of day, or the last week. From Network Control's hourly records, so it reacts to what is
// unusual for that line or stop rather than to a fixed number.

import type { Game } from '../engine.ts';
import type { Id } from '../types.ts';
import type { DayRecord, NetDay, RouteDay, StopDay } from '../analytics/types.ts';
import { DAY, HOUR } from '../content.ts';
import { WEEKDAYS_LONG, weekdayOf } from '../time.ts';

export type BaseScope = 'line' | 'stop' | 'network';

interface Measure {
  id: string;
  scope: BaseScope;
  label: string;
  /** words after the number: "boardings", "%" … */
  unit: string;
  /** count (summed over the hours) or a ratio of two sums */
  num: (r: never, h: number) => number;
  den?: (r: never, h: number) => number;
  scale?: number;
  money?: boolean;
}

const at = (a: number[] | undefined, h: number) => a?.[h] ?? 0;
const line = (f: (r: RouteDay, h: number) => number) => f as Measure['num'];
const stop = (f: (r: StopDay, h: number) => number) => f as Measure['num'];
const net = (f: (r: NetDay, h: number) => number) => f as Measure['num'];

export const BASE_MEASURES: Measure[] = [
  { id: 'line.boardings', scope: 'line', label: 'Boardings on a line', unit: 'boardings', num: line((r, h) => at(r.b, h)) },
  { id: 'line.load', scope: 'line', label: 'How full a line’s buses were', unit: '%', num: line((r, h) => at(r.lf, h)), den: line((r, h) => at(r.dp, h)), scale: 100 },
  { id: 'line.delay', scope: 'line', label: 'A line’s average delay', unit: 'min', num: line((r, h) => at(r.dl, h)), den: line((r, h) => at(r.dp, h)), scale: 1 / 60 },
  { id: 'line.missed', scope: 'line', label: 'Departures missed on a line', unit: 'missed', num: line((r, h) => at(r.m, h)) },
  { id: 'line.fares', scope: 'line', label: 'Fares on a line', unit: '', num: line((r, h) => at(r.rv, h)), money: true },
  { id: 'stop.boardings', scope: 'stop', label: 'Boardings at a stop', unit: 'boardings', num: stop((r, h) => at(r.b, h)) },
  { id: 'stop.waiting', scope: 'stop', label: 'People waiting at a stop (end of the hour)', unit: 'waiting', num: stop((r, h) => at(r.w, h)) },
  { id: 'stop.gaveUp', scope: 'stop', label: 'People giving up at a stop', unit: 'gave up', num: stop((r, h) => at(r.g, h)) },
  { id: 'network.journeys', scope: 'network', label: 'Journeys on the network', unit: 'journeys', num: net((r, h) => at(r.j, h)) },
  { id: 'network.gaveUp', scope: 'network', label: 'People giving up, whole network', unit: 'gave up', num: net((r, h) => at(r.ab, h)) },
];
export const BASE_MEASURE: Record<string, Measure> = Object.fromEntries(BASE_MEASURES.map((m) => [m.id, m]));
export const BASE_OPTIONS = BASE_MEASURES.map((m) => ({ value: m.id, label: m.label, group: m.scope === 'line' ? 'Lines' : m.scope === 'stop' ? 'Stops' : 'Whole network' }));

export const BASE_WINDOWS = [
  { value: 'hour', label: 'The last full hour' },
  { value: '3h', label: 'The last three hours' },
  { value: 'today', label: 'Today so far' },
];
export const BASE_COMPARE = [
  { value: 'weekday', label: 'The same day of the week (last 4)' },
  { value: 'kind', label: 'The same kind of day: weekday or weekend (last 5)' },
  { value: 'week', label: 'Every day of the last week' },
];

export interface BaselineResult {
  value: number | null;
  normal: number | null;
  /** % above (+) or below (−) normal; null when normal is 0 or unknown */
  change: number | null;
  days: number;
  hours: string;
  against: string;
  why?: string;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

function recOf(d: DayRecord, m: Measure, id: Id | null): unknown {
  return m.scope === 'line' ? d.routes[id ?? ''] : m.scope === 'stop' ? d.stops[id ?? ''] : d.net;
}

function windowValue(m: Measure, rec: unknown, hours: number[]): number | null {
  if (!rec) return null;
  let n = 0, d = 0;
  for (const h of hours) {
    n += m.num(rec as never, h);
    if (m.den) d += m.den(rec as never, h);
  }
  if (!m.den) return n;
  return d > 0 ? (n / d) * (m.scale ?? 1) : null;
}

/** The comparison for one line or stop (or the network) now. */
export function compareBaseline(game: Game, measure: string, id: Id | null, win: string, compare: string): BaselineResult {
  const m = BASE_MEASURE[measure];
  const t = game.t;
  const hourNow = Math.floor((t % DAY) / HOUR);
  const today = Math.floor(t / DAY);
  const span = win === 'today' ? hourNow : win === '3h' ? Math.min(3, hourNow) : Math.min(1, hourNow);
  const hours = Array.from({ length: span }, (_, i) => hourNow - span + i);
  const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
  const hoursText = hours.length ? `${pad(hours[0])}–${pad(hourNow)}` : '';
  const sw = game.state.clock.startWeekday;
  const wd = weekdayOf(sw, t);
  const against = compare === 'weekday' ? WEEKDAYS_LONG[wd] : compare === 'kind' ? (wd >= 5 ? 'weekend day' : 'weekday') : 'day last week';
  const empty = (why: string): BaselineResult => ({ value: null, normal: null, change: null, days: 0, hours: hoursText, against, why });
  if (!m) return empty('Choose a figure.');
  if (!hours.length) return empty('No full hour recorded yet today.');
  const value = windowValue(m, recOf(game.state.analytics.today, m, id), hours) ?? (m.den ? null : 0);
  const same = (d: DayRecord) => {
    const w = weekdayOf(sw, d.day * DAY);
    return compare === 'weekday' ? w === wd : compare === 'kind' ? (w >= 5) === (wd >= 5) : true;
  };
  const pool = game.state.analytics.days.filter((d) => d.day < today && d.day >= today - (compare === 'weekday' ? 28 : compare === 'kind' ? 14 : 7) && !d.partial && same(d));
  const vals: number[] = [];
  for (const d of pool.slice(compare === 'week' ? -7 : compare === 'weekday' ? -4 : -5)) {
    const v = windowValue(m, recOf(d, m, id), hours);
    if (v !== null) vals.push(v);
  }
  if (!vals.length) return { ...empty(`No ${against === 'day last week' ? 'day last week' : against} recorded yet to compare with.`), value: value === null ? null : r1(value) };
  const normal = vals.reduce((a, b) => a + b, 0) / vals.length;
  const change = value === null || normal <= 0 ? null : r1(((value - normal) / normal) * 100);
  return { value: value === null ? null : r1(value), normal: r1(normal), change, days: vals.length, hours: hoursText, against };
}

/** The comparison in words: "Taksim: 140 boardings 17:00–18:00, 52% more than a normal Saturday (92 on average over 3)". */
export function baselineText(game: Game, measure: string, name: string, r: BaselineResult): string {
  const m = BASE_MEASURE[measure];
  if (!m) return 'Choose a figure.';
  const show = (v: number) => (m.money ? game.money(v, { compact: true }) : m.unit === '%' ? `${Math.round(v)}%` : m.unit === 'min' ? `${v} min` : `${Math.round(v * 10) / 10} ${m.unit}`);
  if (r.value === null && r.why) return `${name}: ${r.why}`;
  const now = r.value === null ? 'no figure' : show(r.value);
  if (r.normal === null) return `${name}: ${now} ${r.hours}. ${r.why ?? ''}`.trim();
  const diff = r.change === null ? (r.value && r.value > 0 ? 'where it is normally none' : 'the same as') : Math.abs(r.change) < 0.5 ? 'the same as' : `${Math.abs(Math.round(r.change))}% ${r.change > 0 ? 'more' : 'less'} than`;
  return `${name}: ${now} ${r.hours}, ${diff}${diff.endsWith('none') ? '' : ` a normal ${r.against}`} (${show(r.normal)} on average over ${r.days} day${r.days === 1 ? '' : 's'})`;
}
