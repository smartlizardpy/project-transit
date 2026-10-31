// Shared pieces for the Network Control tabs: filters, queries, number formatting and charts.
import { useMemo, type ReactNode } from 'react';
import { create } from 'zustand';
import type { Game } from '../../game/engine.ts';
import { DAY } from '../../game/content.ts';
import { BANDS } from '../../game/analytics/types.ts';
import { DAY_KINDS, EVENT_DAYS, WEATHER_GROUPS, weatherGroup, type DayKind, type EventDay, type WeatherGroup } from '../../game/analytics/labels.ts';
import { WEATHER_LABEL, type WeatherKind } from '../../game/weather.ts';
import { EVENT_TEMPLATES, type EventKind } from '../../game/events.ts';
import {
  aggregate, MEASURE, MEASURES, metricValue, weekdayName,
  type AnalyticsQuery, type Coverage, type CustomMetric, type DaySel, type GroupBy, type MeasureDef, type QueryResult, type Row, type Unit,
} from '../../game/analytics/query.ts';
import { useUI } from '../../state/store.ts';
import { Tip } from '../primitives.tsx';
import { X } from '@phosphor-icons/react';

// ───────────────────────────────────────────── filters

export type Period = 'today' | 'yesterday' | '7' | '35' | 'custom';
export interface Filters {
  period: Period;
  /** custom range, 1-based day numbers as shown to the player */
  from: number;
  to: number;
  /** all, weekday, weekend or wd0..wd6 */
  dayType: string;
  /** all, band id, or custom */
  time: string;
  h0: number;
  h1: number;
  line: string;
}
export const defaultFilters = (): Filters => ({ period: '7', from: 1, to: 7, dayType: 'all', time: 'all', h0: 6, h1: 10, line: '' });

interface NC {
  f: Filters;
  setF: (p: Partial<Filters>) => void;
  setAll: (f: Filters) => void;
  line: string | null;
  stop: string | null;
  setLine: (id: string | null) => void;
  setStop: (id: string | null) => void;
  /** custom metric ids shown as extra table columns */
  extra: string[];
  toggleExtra: (id: string) => void;
  /** the two periods of the line comparison */
  cmp: [Filters, Filters];
  setCmp: (i: 0 | 1, f: Filters) => void;
  /** journeys view to restore when a saved report is opened */
  odInit: { level: 'stop' | 'zone'; origin: string; destination: string } | null;
  setOdInit: (v: NC['odInit']) => void;
}
export const useNC = create<NC>((set, get) => ({
  f: defaultFilters(),
  setF: (p) => set({ f: { ...get().f, ...p } }),
  setAll: (f) => set({ f }),
  line: null,
  stop: null,
  setLine: (line) => set({ line }),
  setStop: (stop) => set({ stop }),
  extra: [],
  cmp: [{ ...defaultFilters(), period: '35', dayType: 'wd0', time: 'am' }, { ...defaultFilters(), period: '35', dayType: 'wd4', time: 'pm' }],
  setCmp: (i, f) => set({ cmp: i === 0 ? [f, get().cmp[1]] : [get().cmp[0], f] }),
  odInit: null,
  setOdInit: (odInit) => set({ odInit }),
  toggleExtra: (id) => set({ extra: get().extra.includes(id) ? get().extra.filter((x) => x !== id) : [...get().extra, id] }),
}));

export const todayNo = (game: Game) => Math.floor(game.t / DAY);
export const hoursOf = (f: Filters): [number, number] | null => {
  if (f.time === 'all') return null;
  if (f.time === 'custom') return f.h0 === f.h1 ? null : [f.h0, f.h1];
  const b = BANDS.find((x) => x.id === f.time);
  return b ? [b.from, b.to] : null;
};
/** The "Days" choice: all, weekdays, weekend, one weekday (`wd0`…), a kind of day (`k:`), weather (`w:`) or events (`e:`). */
export function dayFilterOf(v: string): Pick<AnalyticsQuery, 'dayType' | 'weekday' | 'weather' | 'dayKind' | 'eventDay'> {
  if (v.startsWith('wd')) return { dayType: 'all', weekday: Number(v.slice(2)) };
  if (v.startsWith('k:')) return { dayType: 'all', weekday: null, dayKind: v.slice(2) as DayKind };
  if (v.startsWith('w:')) return { dayType: 'all', weekday: null, weather: v.slice(2) as WeatherGroup };
  if (v.startsWith('e:')) return { dayType: 'all', weekday: null, eventDay: v.slice(2) as EventDay };
  return { dayType: v as 'all' | 'weekday' | 'weekend', weekday: null };
}
const dayTypeOf = (f: Filters) => dayFilterOf(f.dayType);

const DAY_GROUPS: { label: string; options: [string, string][] }[] = [
  { label: 'Days of the week', options: [['all', 'All days'], ['weekday', 'Weekdays'], ['weekend', 'Weekend'], ...Array.from({ length: 7 }, (_, i): [string, string] => [`wd${i}`, `${weekdayName(i)}s`])] },
  { label: 'Kind of day', options: DAY_KINDS.filter((k) => k.id !== 'weekend').map((k): [string, string] => [`k:${k.id}`, k.label]) },
  { label: 'Weather', options: WEATHER_GROUPS.map((w): [string, string] => [`w:${w.id}`, w.label]) },
  { label: 'Events', options: EVENT_DAYS.map((e): [string, string] => [`e:${e.id}`, e.id === 'event' ? 'Event days (your buses carried a crowd)' : e.label]) },
];

/** A plain label for a "Days" choice. */
export function dayFilterLabel(v: string): string {
  for (const g of DAY_GROUPS) for (const [k, l] of g.options) if (k === v) return l;
  return 'All days';
}

/** The "Days" options, grouped. */
export function DayOptions() {
  return <>{DAY_GROUPS.map((g) => <optgroup key={g.label} label={g.label}>{g.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</optgroup>)}</>;
}

/** Days and "include today" for a period. Day numbers are 0-based here. */
export function periodDays(f: Filters, today: number): { days: DaySel; includeToday: boolean } {
  switch (f.period) {
    case 'today': return { days: { from: today, to: today }, includeToday: true };
    case 'yesterday': return { days: { from: today - 1, to: today - 1 }, includeToday: false };
    case '7': return { days: { last: 7 }, includeToday: false };
    case '35': return { days: { last: 35 }, includeToday: false };
    default: return { days: { from: Math.min(f.from, f.to) - 1, to: Math.max(f.from, f.to) - 1 }, includeToday: false };
  }
}

export function toQuery(f: Filters, game: Game, groupBy: GroupBy, extra: Partial<AnalyticsQuery> = {}): AnalyticsQuery {
  const { days, includeToday } = periodDays(f, todayNo(game));
  return { groupBy, days, includeToday, hours: hoursOf(f), ...dayTypeOf(f), ...(f.line ? { lines: [f.line] } : {}), ...extra };
}

/** The period just before, same length (null for today so far: a partial day is not comparable). */
export function previousQuery(q: AnalyticsQuery, f: Filters, game: Game): AnalyticsQuery | null {
  if (f.period === 'today') return null;
  const t = todayNo(game);
  const { days } = periodDays(f, t);
  let from: number, to: number;
  if ('last' in days) { to = t - 1 - days.last; from = t - 2 * days.last; } else { const n = days.to - days.from + 1; to = days.from - 1; from = days.from - n; }
  return { ...q, days: { from, to }, includeToday: false };
}

export function filtersFromQuery(q: AnalyticsQuery | undefined, game: Game): Filters {
  const f = defaultFilters();
  if (!q) return f;
  const t = todayNo(game);
  if (q.days && 'last' in q.days) f.period = q.days.last === 7 ? '7' : q.days.last === 35 ? '35' : 'custom';
  if (q.days && 'last' in q.days && f.period === 'custom') { f.from = t - q.days.last + 1; f.to = t; }
  if (q.days && 'from' in q.days) {
    if (q.includeToday && q.days.from >= t) f.period = 'today';
    else { f.period = 'custom'; f.from = q.days.from + 1; f.to = q.days.to + 1; }
  }
  if (q.weekday !== undefined && q.weekday !== null) f.dayType = `wd${q.weekday}`;
  else if (q.dayKind && q.dayKind !== 'all') f.dayType = `k:${q.dayKind}`;
  else if (q.weather && q.weather !== 'all') f.dayType = `w:${q.weather}`;
  else if (q.eventDay && q.eventDay !== 'all') f.dayType = `e:${q.eventDay}`;
  else if (q.dayType) f.dayType = q.dayType;
  if (q.hours) {
    const b = BANDS.find((x) => x.from === q.hours![0] && x.to === q.hours![1]);
    if (b) f.time = b.id;
    else { f.time = 'custom'; f.h0 = q.hours[0]; f.h1 = q.hours[1]; }
  }
  if (q.lines?.[0]) f.line = q.lines[0];
  return f;
}

export function periodLabel(f: Filters): string {
  switch (f.period) {
    case 'today': return 'today so far';
    case 'yesterday': return 'yesterday';
    case '7': return 'the last 7 days';
    case '35': return 'the last 35 days';
    default: return `days ${f.from}–${f.to}`;
  }
}

/** Run a query, recomputing only when the history, the filters or (for today) the hour change. */
export function useAgg(game: Game, q: AnalyticsQuery | null): QueryResult | null {
  const rev = game.state.analytics.days.length;
  const tick = q?.includeToday ? Math.floor(game.t / 1800) : 0;
  const key = q ? JSON.stringify(q) : '';
  const nets = Object.keys(game.state.routes).length + Object.keys(game.state.stops).length + Object.keys(game.state.vehicles).length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (q ? aggregate(game, q) : null), [game, key, rev, tick, nets]);
}

// ───────────────────────────────────────────── formatting

export function fmt(game: Game, unit: Unit, v: number | null | undefined, decimals?: number, compact = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'money': return game.money(v, { compact: compact && Math.abs(v) >= 1000 });
    case 'percent': return `${v.toFixed(decimals ?? 0)}%`;
    case 'minutes': return `${v.toFixed(decimals ?? 1)} min`;
    case 'hours': return `${v.toFixed(decimals ?? 1)} h`;
    case 'km': return `${Math.round(v).toLocaleString('en-GB')} km`;
    case 'score': return v.toFixed(decimals ?? 0);
    case 'ratio': return v.toFixed(decimals ?? 2);
    default: return decimals !== undefined ? v.toFixed(decimals) : Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-GB') : v % 1 === 0 ? String(v) : v.toFixed(1);
  }
}
/** An estimate's precision: two or three significant figures. */
export const approx = (v: number) => (v >= 10_000 ? Math.round(v / 1000) * 1000 : v >= 1000 ? Math.round(v / 100) * 100 : v >= 100 ? Math.round(v / 10) * 10 : Math.round(v));
/** A share in whole percent, with "<1%" for a sliver rather than rounding it up or away. */
export const share = (v: number, of: number) => (!(of > 0) || !(v > 0) ? '—' : (v / of) * 100 < 0.5 ? '<1%' : `${Math.round((v / of) * 100)}%`);

export const fmtM = (game: Game, id: string, v: number | null | undefined) => fmt(game, MEASURE[id]?.unit ?? 'count', v);

export const SOURCE_TEXT: Record<string, string> = {
  measured: 'Measured: counted by the simulation as it happened.',
  ledger: 'Ledger: taken from the company ledger, so it matches Finances.',
  derived: 'Derived: calculated from recorded minutes and distance at the ledger rates, not booked in the ledger.',
};

/** Small marker for values that are not plain measurements. */
export function SrcMark({ source }: { source: string }) {
  if (source === 'measured') return null;
  return <i className={`nc-src ${source}`} title={SOURCE_TEXT[source]} />;
}

/** A value, or a dash with the reason it is not available. */
export function Val({ game, m, v, note, bare }: { game: Game; m: MeasureDef | { unit: Unit; decimals?: number }; v: number | null | undefined; note?: string; bare?: boolean }) {
  if (v === null || v === undefined || !Number.isFinite(v)) return <span className="nc-null" title={note || 'Not available for this selection.'}>—</span>;
  if (bare && m.unit === 'minutes') return <>{v.toFixed(('decimals' in m ? m.decimals : undefined) ?? 1)}</>;
  return <>{fmt(game, m.unit, v, 'decimals' in m ? m.decimals : undefined)}</>;
}

export function noteFor(res: QueryResult | null, label: string): string | undefined {
  return res?.notes.find((n) => n.toLowerCase().includes(label.toLowerCase())) ?? res?.notes[0];
}

export interface Col { id: string; label: string; unit: Unit; source: string; better: 'higher' | 'lower' | 'none'; describe: string; custom?: CustomMetric }
export function columns(game: Game, ids: string[], extra: string[]): Col[] {
  const out: Col[] = [];
  for (const id of ids) {
    const m = MEASURE[id];
    if (m) out.push({ id, label: SHORT[id] ?? m.label, unit: m.unit, source: m.source, better: m.better, describe: m.describe });
  }
  for (const id of extra) {
    const c = game.state.control.metrics.find((x) => x.id === id);
    if (c) out.push({ id, label: c.name, unit: c.unit, source: 'derived', better: c.better ?? 'none', describe: `Your metric: ${c.expr}`, custom: c });
  }
  return out;
}
export const colValue = (c: Col, row: Pick<Row, 'values'>): number | null => (c.custom ? metricValue(c.custom, row.values) : row.values[c.id] ?? null);

export function ColHead({ c, sort, onSort }: { c: Col; sort?: { id: string; dir: number }; onSort?: (id: string) => void }) {
  return (
    <th className={`${onSort ? 'sortable' : ''} ${sort?.id === c.id ? 'on' : ''}`} title={`${c.describe} ${c.custom ? '' : SOURCE_TEXT[c.source]}`} onClick={() => onSort?.(c.id)}>
      {c.label}{c.unit === 'minutes' ? ' (min)' : ''}{c.source !== 'measured' && <SrcMark source={c.source} />}{sort?.id === c.id ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}
    </th>
  );
}

/** Change against the previous period, as text and a tone. */
export function change(cur: number | null, prev: number | null, unit: Unit, better: 'higher' | 'lower' | 'none') {
  if (cur === null || prev === null || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return { text: 'no change', tone: '' as const };
  let text: string;
  if (unit === 'percent' || unit === 'score') text = `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(unit === 'percent' ? 1 : 0)} pts`;
  else if (unit === 'minutes') text = `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} min`;
  else if (Math.abs(prev) < 1e-9) text = d > 0 ? 'new' : '';
  else text = `${d > 0 ? '+' : '−'}${Math.abs((d / Math.abs(prev)) * 100).toFixed(Math.abs(d / prev) < 0.1 ? 1 : 0)}%`;
  const good = better === 'none' ? null : (d > 0) === (better === 'higher');
  return { text, tone: good === null ? ('' as const) : good ? ('good' as const) : ('bad' as const) };
}

export function coverageText(cov: Coverage | undefined): ReactNode {
  if (!cov) return null;
  const other = cov.other?.length ?? 0, unl = cov.unlabelled?.length ?? 0;
  const req = cov.requested.length - other - unl;
  const rec = cov.detailed.length + cov.summary.length;
  const parts: string[] = [];
  if (other || unl) parts.push(`${rec} matching day${rec === 1 ? '' : 's'} of ${cov.requested.length}`);
  else if (req) parts.push(`${rec} of ${req} day${req === 1 ? '' : 's'} recorded`);
  if (cov.today) parts.push('today so far');
  if (cov.unlabelled?.length) parts.push(`${cov.unlabelled.length} older day${cov.unlabelled.length === 1 ? '' : 's'} without weather or event labels left out`);
  if (cov.missing.length) parts.push(`not recorded before day ${cov.since + 1}`);
  else parts.push(`recording began day ${cov.since + 1}`);
  return parts.join(' · ');
}

// ───────────────────────────────────────────── filter bar

export function FilterBar({ game, time = true, line = false, res }: { game: Game; time?: boolean; line?: boolean; res?: { coverage: Coverage } | null }) {
  const f = useNC((s) => s.f);
  const setF = useNC((s) => s.setF);
  const t = todayNo(game) + 1;
  const routes = Object.values(game.state.routes);
  const num = (k: 'from' | 'to' | 'h0' | 'h1', max: number) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ [k]: Math.max(0, Math.min(max, Math.floor(Number(e.target.value) || 0))) });
  return (
    <div className="section tight" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="nc-filters">
        <label>Period
          <select className="pn-select" value={f.period} onChange={(e) => setF({ period: e.target.value as Period })}>
            <option value="today">Today so far</option>
            <option value="yesterday">Yesterday</option>
            <option value="7">Last 7 days</option>
            <option value="35">Last 35 days</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        {f.period === 'custom' && (
          <label>Days (1–{t - 1})
            <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input className="pn-input" type="number" min={1} max={t} value={f.from} onChange={num('from', t)} />–<input className="pn-input" type="number" min={1} max={t} value={f.to} onChange={num('to', t)} />
            </span>
          </label>
        )}
        <label>Days
          <select className="pn-select" value={f.dayType} onChange={(e) => setF({ dayType: e.target.value })}>
            <DayOptions />
          </select>
        </label>
        {time && (
          <label>Time of day
            <select className="pn-select" value={f.time} onChange={(e) => setF({ time: e.target.value })}>
              <option value="all">All day</option>
              {BANDS.map((b) => <option key={b.id} value={b.id}>{b.label} {b.short}</option>)}
              <option value="custom">Custom hours</option>
            </select>
          </label>
        )}
        {time && f.time === 'custom' && (
          <label>Hours
            <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input className="pn-input" type="number" min={0} max={24} value={f.h0} onChange={num('h0', 24)} />–<input className="pn-input" type="number" min={0} max={24} value={f.h1} onChange={num('h1', 24)} />
            </span>
          </label>
        )}
        {line && (
          <label>Line
            <select className="pn-select" value={f.line} onChange={(e) => setF({ line: e.target.value })}>
              <option value="">All lines</option>
              {routes.map((r) => <option key={r.id} value={r.id}>Line {r.number}</option>)}
            </select>
          </label>
        )}
      </div>
      {res && <div className="nc-cov">{coverageText(res.coverage)}</div>}
    </div>
  );
}

// ───────────────────────────────────────────── small pieces

export function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="p-head">
      <div className="grow">
        <div className="p-title" style={{ fontSize: 19 }}>{title}</div>
        <div className="p-sub">{sub}</div>
      </div>
      <button className="close-btn has-tip" onClick={() => useUI.getState().openPanel(null)} aria-label="Close panel">
        <X size={15} weight="bold" />
        <Tip label="Close" k="Esc" side="left" />
      </button>
    </div>
  );
}

export function SectionHead({ title, right }: { title: string; right?: ReactNode }) {
  return <div className="section-head"><span className="nc-sub">{title}</span>{right}</div>;
}

export function Notes({ res }: { res: QueryResult | null }) {
  if (!res?.notes.length) return null;
  return <div className="pn-note">{res.notes.map((n, i) => <div key={i}>{n}</div>)}</div>;
}

export const SHORT: Record<string, string> = { boardings: 'Boarded', alightings: 'Alighted', abandoned: 'Gave up', avgWait: 'Avg wait', maxWait: 'Max wait', leftBehind: 'Left behind', revenue: 'Fares', avgDelay: 'Delay', avgLoad: 'Load', onTime: 'On time', revenuePerBusHour: 'Fares / bus-h', profit: 'Result', satisfaction: 'Satisf.', vehicleCost: 'Running cost' };
export const lineOf = (game: Game, id: string) => game.state.routes[id];
export function lineLabel(game: Game, id: string | null) {
  if (!id) return '';
  const r = game.state.routes[id];
  return r ? `Line ${r.number}` : game.state.analytics.names.r[id]?.n ? `Line ${game.state.analytics.names.r[id].n}` : 'Removed line';
}
export const stopName = (game: Game, id: string) => game.state.stops[id]?.name ?? game.state.analytics.names.s[id] ?? 'Removed stop';
export const vehName = (game: Game, id: string) => game.state.vehicles[id]?.fleetNo ?? game.state.analytics.names.v[id] ?? 'Sold bus';

export const sortRows = <T,>(rows: T[], get: (r: T) => number | null, dir: number) =>
  [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * dir;
  });

// ───────────────────────────────────────────── charts

export interface Pt { x: number; label: string; v: number | null }
/** A day's marks above a daily chart: rain (wet), heavy rain or snow (storm), and an event your buses served. */
export interface DayMark { wx?: 'wet' | 'storm'; wxText?: string; ev?: string }

/** Marks for recorded days, from their labels (weather, and events your buses carried a crowd to). */
export function dayMarks(game: Game): Record<number, DayMark> {
  const out: Record<number, DayMark> = {};
  for (const rec of game.state.analytics.days) {
    const l = rec.lbl;
    if (!l) continue;
    const m: DayMark = {};
    const g = weatherGroup(l);
    if (g === 'wet' || g === 'storm') { m.wx = g; m.wxText = `${WEATHER_LABEL[l.wx!.k as WeatherKind]}, ${l.wx!.mm} mm`; }
    const ev = (l.ev ?? []).filter((e) => e.carried > 0 && e.kind !== 'rail' && e.kind !== 'flight');
    if (ev.length) m.ev = ev.map((e) => `${EVENT_TEMPLATES[e.kind as EventKind]?.label ?? e.kind} at ${e.venue}: ${e.carried} journeys on your buses`).join('; ');
    if (m.wx || m.ev) out[rec.day] = m;
  }
  return out;
}

/** A thin line chart (days or hours). Gaps where the value is missing. */
export function LineChart({ points, unit, game, height = 132, labelEvery = 5, today, marks }: { points: Pt[]; unit: Unit; game: Game; height?: number; labelEvery?: number; today?: number; marks?: Record<number, DayMark> }) {
  const hasMarks = !!marks && points.some((p) => marks[p.x]);
  const W = 572, H = height + (hasMarks ? 12 : 0), L = 44, T = hasMarks ? 20 : 8, B = 20, R = 6;
  const vals = points.map((p) => p.v).filter((v): v is number => v !== null);
  if (vals.length < 2) return <div className="pn-note">Not enough history yet. A trend appears after two recorded days.</div>;
  const max = Math.max(...vals, 0), min = Math.min(...vals, 0);
  const top = max === min ? max + 1 : max;
  const y = (v: number) => T + ((top - v) / (top - min || 1)) * (H - T - B);
  const x = (i: number) => L + (points.length === 1 ? 0 : (i / (points.length - 1)) * (W - L - R));
  let d = '';
  let pen = false;
  points.forEach((p, i) => {
    if (p.v === null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`;
    pen = true;
  });
  const grid = [top, (top + min) / 2, min];
  return (
    <svg className="pn-chart nc-chart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img">
      {grid.map((v, i) => (
        <g key={i}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.08)" /><text x={L - 5} y={y(v) + 3} textAnchor="end">{fmt(game, unit, v)}</text></g>
      ))}
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => p.v !== null && (
        <g key={i}>
          <circle cx={x(i)} cy={y(p.v)} r={p.x === today ? 3.6 : 2.2} fill={p.x === today ? 'var(--card-raised)' : 'var(--accent)'} stroke="var(--accent)" strokeWidth={p.x === today ? 1.6 : 0}>
            <title>{`${p.label}: ${fmt(game, unit, p.v, undefined, false)}${p.x === today ? ' (so far)' : ''}`}</title>
          </circle>
        </g>
      ))}
      {points.map((p, i) => (i % labelEvery === 0 || i === points.length - 1) && <text key={`l${i}`} x={x(i)} y={H - 6} textAnchor="middle">{p.label.replace(/^Day /, '')}</text>)}
      {hasMarks && points.map((p, i) => {
        const m = marks![p.x];
        if (!m) return null;
        const cx = x(i);
        return (
          <g key={`m${i}`}>
            {m.wx && <circle cx={m.ev ? cx - 4 : cx} cy={8} r={m.wx === 'storm' ? 3.4 : 2.6} fill={m.wx === 'storm' ? 'var(--accent)' : 'none'} stroke="var(--accent)" strokeWidth={1.4}><title>{`${p.label}: ${m.wxText}`}</title></circle>}
            {m.ev && <path d={`M${m.wx ? cx + 4 : cx} 4 l3.4 6.8 h-6.8 z`} fill="var(--amber)"><title>{`${p.label}: ${m.ev}`}</title></path>}
          </g>
        );
      })}
    </svg>
  );
}

export { MEASURES };
