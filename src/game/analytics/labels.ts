// Day labels and weekly roll-ups (docs/city-activity-engine-plan.md, section 12): each recorded
// day keeps its season, kind of day, weather and events, so Network Control can group and filter
// days by them, and every game week adds its totals to a roll-up kept for three game years.

import type { Game } from '../engine.ts';
import type { GameState } from '../types.ts';
import { DAY } from '../content.ts';
import { CROWD_KINDS, type GameEvent } from '../events.ts';
import { BANDS, TYPE_COUNT, WEEKS_KEPT, type DayLabel, type DayRecord } from './types.ts';

/** Weather groups for filters and groupings. */
export const WEATHER_GROUPS = [
  { id: 'dry', label: 'Dry days' },
  { id: 'wet', label: 'Showers or rain' },
  { id: 'storm', label: 'Heavy rain or snow' },
] as const;
export type WeatherGroup = (typeof WEATHER_GROUPS)[number]['id'];

/** Kinds of day for filters and groupings. */
export const DAY_KINDS = [
  { id: 'working', label: 'Working days in term' },
  { id: 'school_holidays', label: 'School holidays' },
  { id: 'weekend', label: 'Weekends' },
  { id: 'holiday', label: 'Public holidays' },
] as const;
export type DayKind = (typeof DAY_KINDS)[number]['id'];

export const EVENT_DAYS = [
  { id: 'event', label: 'Event days' },
  { id: 'none', label: 'Days without events' },
] as const;
export type EventDay = (typeof EVENT_DAYS)[number]['id'];

export function weatherGroup(l: DayLabel | undefined): WeatherGroup | null {
  if (!l?.wx) return null;
  const k = l.wx.k;
  return k === 'heavy' || k === 'snow' ? 'storm' : k === 'showers' || k === 'rain' ? 'wet' : 'dry';
}

export function dayKind(l: DayLabel | undefined): DayKind | null {
  if (!l) return null;
  return l.holiday ? 'holiday' : l.weekend ? 'weekend' : l.schoolHolidays ? 'school_holidays' : 'working';
}

/** An event day: a match, concert, festival or gathering whose crowd your buses carried. */
export function eventDay(l: DayLabel | undefined): EventDay | null {
  if (!l) return null;
  return l.ev?.some((e) => CROWD_KINDS.has(e.kind as GameEvent['kind']) && !e.cancelled && e.carried > 0) ? 'event' : 'none';
}

/** Events that started on game day `day` and touched your network (or closed rail links), with their results so far. */
function eventsOn(game: Game, day: number): DayLabel['ev'] {
  const out = game
    .eventList()
    .filter((ev) => Math.floor(ev.start / DAY) === day && ev.ann <= game.t && ((ev.carried ?? 0) + (ev.lost ?? 0) > 0 || ev.kind === 'rail'))
    .map((ev) => ({ id: ev.id, kind: ev.kind, venue: ev.venue, people: ev.people, carried: ev.carried ?? 0, lost: ev.lost ?? 0, ...(ev.cancelled ? { cancelled: true } : {}) }));
  return out.length ? out : undefined;
}

/** The label of game day `day` (calendar and weather are known for today and recent days). */
export function makeDayLabel(game: Game, day: number): DayLabel {
  const mid = day * DAY + DAY / 2;
  const c = game.calendarAt(mid), d = game.dayTypeAt(mid);
  const w = game.weatherDay(day)?.actual;
  const l: DayLabel = { y: c.year, season: c.season, week: c.week, uni: d.uni };
  if (d.weekend) l.weekend = true;
  if (d.holiday) l.holiday = true;
  if (d.school) l.school = true;
  if (d.schoolHolidays) l.schoolHolidays = true;
  if (d.festive) l.festive = true;
  if (w) l.wx = { k: w.kind, mm: Math.round(w.mm.reduce((a, b) => a + b, 0) * 10) / 10, hi: w.hi, lo: w.lo };
  const ev = eventsOn(game, day);
  if (ev) l.ev = ev;
  return l;
}

/** Labels the day being closed, and brings yesterday's event results up to date (crowds go home after midnight). */
export function labelClosingDay(game: Game, day: number) {
  const a = game.state.analytics;
  a.today.lbl = makeDayLabel(game, day);
  const prev = a.days.at(-1);
  if (prev?.lbl && prev.day === day - 1) {
    const ev = eventsOn(game, day - 1);
    if (ev) prev.lbl.ev = ev;
    else delete prev.lbl.ev;
  }
}

const sum = (a: number[] | undefined) => (a ? a.reduce((x, y) => x + y, 0) : 0);

/** Adds a closed day to its game week's roll-up. */
export function rollWeek(state: GameState, rec: DayRecord) {
  const l = rec.lbl;
  if (!l) return;
  const a = state.analytics;
  const weeks = (a.weeks ??= []);
  let w = weeks.at(-1);
  if (!w || w.y !== l.y || w.w !== l.week) {
    w = { y: l.y, w: l.week, season: l.season, from: rec.day, n: 0, r: {}, net: [0, 0, 0, 0, 0], wx: [0, 0, 0, 0, 0, 0] };
    weeks.push(w);
    while (weeks.length > WEEKS_KEPT) weeks.shift();
  }
  w.n++;
  let fares = 0;
  for (const [id, r] of Object.entries(rec.routes)) {
    const row = (w.r[id] ??= new Array<number>(2 + TYPE_COUNT).fill(0));
    const rv = sum(r.rv);
    row[0] += sum(r.b);
    row[1] = Math.round((row[1] + rv) * 100) / 100;
    fares += rv;
    if (r.k) for (let i = 0; i < r.k.length; i++) row[2 + Math.floor(i / BANDS.length)] += r.k[i];
  }
  const j = sum(rec.net.j);
  w.net[0] += j;
  w.net[1] += sum(rec.net.ab);
  w.net[2] = Math.round((w.net[2] + rec.net.ss) * 10) / 10;
  w.net[3] += rec.net.sn;
  w.net[4] = Math.round((w.net[4] + fares) * 100) / 100;
  const g = weatherGroup(l);
  if (g) {
    const i = g === 'dry' ? 0 : g === 'wet' ? 2 : 4;
    w.wx[i]++;
    w.wx[i + 1] += j;
  }
}

/** Weeks of the same season across game years, for comparisons: per year, the average day. */
export function seasonYears(state: GameState, season: string): { y: number; days: number; journeys: number; fares: number; satisfaction: number | null; weeks: number }[] {
  const by = new Map<number, { y: number; days: number; journeys: number; fares: number; ss: number; sn: number; weeks: number }>();
  for (const w of state.analytics.weeks ?? []) {
    if (w.season !== season) continue;
    const x = by.get(w.y) ?? { y: w.y, days: 0, journeys: 0, fares: 0, ss: 0, sn: 0, weeks: 0 };
    x.days += w.n; x.journeys += w.net[0]; x.fares += w.net[4]; x.ss += w.net[2]; x.sn += w.net[3]; x.weeks++;
    by.set(w.y, x);
  }
  return [...by.values()].sort((a, b) => a.y - b.y).map((x) => ({ y: x.y, days: x.days, journeys: x.days ? x.journeys / x.days : 0, fares: x.days ? x.fares / x.days : 0, satisfaction: x.sn ? (x.ss / x.sn) * 100 : null, weeks: x.weeks }));
}
