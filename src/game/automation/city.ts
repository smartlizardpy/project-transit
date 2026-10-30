// What automation sees of the city: the weather, the calendar and events (docs/city-activity-
// engine-plan.md, section 12). Plain records for data nodes and trigger outputs, and the filters
// that event and calendar triggers share. Reading never changes the game.

import type { Game } from '../engine.ts';
import type { Id } from '../types.ts';
import type { Rec } from './live.ts';
import { DAY, HOUR } from '../content.ts';
import { hhmm } from '../time.ts';
import { CROWD_KINDS, EVENT_TEMPLATES, actualEnd, whenLabel, type GameEvent } from '../events.ts';
import { WEATHER_LABEL, hourCondition, hourTemp, CONDITION_LABEL } from '../weather.ts';
import { SEASON_LABEL, dayTypeLabel } from '../calendar.ts';

/** Event kinds a trigger or data node can filter on. */
export const EVENT_FILTER = [
  { value: 'crowds', label: 'Matches, concerts, festivals, gatherings' },
  { value: 'football', label: 'Football matches' },
  { value: 'concert', label: 'Concerts' },
  { value: 'festival', label: 'Festivals' },
  { value: 'gathering', label: 'Public gatherings' },
  { value: 'disruption', label: 'Rail and flight disruptions' },
  { value: 'any', label: 'Any event' },
];

/** Short plural names for summaries ("60 min before matches"). */
export const EVENT_FILTER_SHORT: Record<string, string> = {
  crowds: 'big events', football: 'matches', concert: 'concerts', festival: 'festivals', gathering: 'gatherings', disruption: 'rail and flight disruptions', any: 'events',
};

export function eventKindMatches(filter: string, ev: GameEvent): boolean {
  if (!filter || filter === 'any') return true;
  if (filter === 'crowds') return CROWD_KINDS.has(ev.kind);
  if (filter === 'disruption') return ev.kind === 'rail' || ev.kind === 'flight';
  return ev.kind === filter;
}

/** Your lines with a stop within `m` metres of a point (sorted by line number). */
export function linesNear(game: Game, at: [number, number], m = 1000): Id[] {
  const [vx, vy] = game.geo.xy(at);
  const out: Id[] = [];
  for (const r of Object.values(game.state.routes)) {
    const ids = new Set([...r.stops, ...(r.returnStops ?? [])]);
    for (const id of ids) {
      const s = game.state.stops[id];
      if (!s) continue;
      const [x, y] = game.geo.xy(s.lngLat);
      if (Math.hypot(x - vx, y - vy) <= m) {
        out.push(r.id);
        break;
      }
    }
  }
  return out.sort((a, b) => (game.state.routes[a].number < game.state.routes[b].number ? -1 : 1));
}

/** Lines near an event: near the venue, or (disruptions) near the stations of the closed stretch. */
export function linesNearEvent(game: Game, ev: GameEvent): Id[] {
  if (ev.kind === 'rail' && ev.links) {
    const net = game.region.transit;
    const out = new Set<Id>();
    if (net)
      for (const li of ev.links) {
        const l = net.links[li];
        if (!l) continue;
        for (const s of [net.stations[l.a], net.stations[l.b]]) for (const r of linesNear(game, game.geo.P.toLngLat(s.x, s.y), 600)) out.add(r);
      }
    return [...out];
  }
  return linesNear(game, ev.at, 1000);
}

/** An event as a record: what, where, when, how many, and whether it is under way. */
export function eventRec(game: Game, ev: GameEvent): Rec {
  const t = game.t;
  const end = actualEnd(ev);
  return {
    kind: 'event', id: ev.id, type: ev.kind, label: EVENT_TEMPLATES[ev.kind].label, name: ev.title, title: ev.title, venue: ev.venue, place: ev.place,
    people: ev.people, day: Math.floor(ev.start / DAY) + 1, start: hhmm(ev.start), end: hhmm(end), when: whenLabel(ev, t, game.state.clock.startWeekday),
    startsIn: Math.round((ev.start - t) / 60), endsIn: Math.round((end - t) / 60), underWay: ev.start <= t && end > t, over: end <= t,
    cancelled: !!ev.cancelled, reason: ev.reason ?? ev.cancelled ?? '', lines: linesNearEvent(game, ev).length,
  };
}

/** Announced events (not called off) under way or starting within `hours`, soonest first. */
export function eventsAhead(game: Game, hours: number, filter: string, line?: Id): GameEvent[] {
  const t = game.t;
  return game
    .upcomingEvents(t)
    .filter((ev) => ev.start <= t + hours * HOUR && eventKindMatches(filter, ev) && (!line || linesNearEvent(game, ev).includes(line)));
}

/** The weather now, today and tomorrow (tomorrow once the 18:00 forecast is out). */
export function weatherRecs(game: Game): { now: Rec; today: Rec; tomorrow: Rec | null } {
  const t = game.t;
  const day = Math.floor(t / DAY), h = Math.floor((t % DAY) / HOUR);
  const w = game.weatherDay(day)?.actual;
  const cond = w ? hourCondition(w, h) : 0;
  const now: Rec = {
    kind: 'weather', condition: cond, label: CONDITION_LABEL[cond], raining: cond >= 1 && cond <= 3, heavy: cond === 3, snow: cond === 4,
    temp: w ? Math.round(hourTemp(w, h) * 10) / 10 : 15, rain: w ? Math.round(w.mm[h] * 10) / 10 : 0,
  };
  const today: Rec = w
    ? { kind: 'weather', type: w.kind, label: WEATHER_LABEL[w.kind], high: w.hi, low: w.lo, rain: Math.round(w.mm.reduce((a, b) => a + b, 0) * 10) / 10, wet: w.kind !== 'clear' && w.kind !== 'cloudy' }
    : { kind: 'weather', type: 'clear', label: 'Clear', high: 15, low: 10, rain: 0, wet: false };
  const f = game.weatherDay(day + 1)?.forecast;
  const tomorrow: Rec | null = f
    ? { kind: 'forecast', type: f.kind, label: WEATHER_LABEL[f.kind], high: f.hi, low: f.lo, chanceOfRain: f.pop, wet: f.kind !== 'clear' && f.kind !== 'cloudy', storm: f.kind === 'heavy' || f.kind === 'snow', hot: f.hi >= 32 }
    : null;
  return { now, today, tomorrow };
}

/** Forecast filters for the forecast trigger. */
export const FORECAST_FILTER = [
  { value: 'any', label: 'Every forecast' },
  { value: 'wet', label: 'Showers, rain, heavy rain or snow' },
  { value: 'storm', label: 'Heavy rain or snow' },
  { value: 'hot', label: 'A hot day (32 °C or more)' },
  { value: 'dry', label: 'A dry day' },
];

export function forecastMatches(filter: string, f: Rec): boolean {
  switch (filter) {
    case 'wet': return !!f.wet;
    case 'storm': return !!f.storm;
    case 'hot': return !!f.hot;
    case 'dry': return !f.wet;
    default: return true;
  }
}

/** Weather changes for the weather trigger (checked when the hour's conditions change). */
export const WEATHER_FILTER = [
  { value: 'rain', label: 'Rain starts (any rain)' },
  { value: 'heavy', label: 'Heavy rain or snow starts' },
  { value: 'dry', label: 'It stops raining' },
  { value: 'any', label: 'Any change' },
];

export function weatherChangeMatches(filter: string, from: number, to: number): boolean {
  const wet = (c: number) => c >= 1;
  const storm = (c: number) => c >= 3;
  switch (filter) {
    case 'rain': return wet(to) && !wet(from);
    case 'heavy': return storm(to) && !storm(from);
    case 'dry': return !wet(to) && wet(from);
    default: return to !== from;
  }
}

/** Kinds of day for the calendar trigger. */
export const DAY_FILTER = [
  { value: 'school_holidays', label: 'School holidays' },
  { value: 'school', label: 'School days' },
  { value: 'public_holiday', label: 'Public holidays' },
  { value: 'exams', label: 'University exam weeks' },
  { value: 'uni_break', label: 'University breaks' },
  { value: 'weekend', label: 'Weekends' },
  { value: 'weekday', label: 'Working days' },
  { value: 'autumn', label: 'Autumn' },
  { value: 'winter', label: 'Winter' },
  { value: 'spring', label: 'Spring' },
  { value: 'summer', label: 'Summer' },
];

/** Whether game day `day` is of a kind. */
export function dayMatches(game: Game, filter: string, day: number): boolean {
  const mid = day * DAY + DAY / 2;
  const d = game.dayTypeAt(mid);
  switch (filter) {
    case 'school_holidays': return d.schoolHolidays;
    case 'school': return d.school;
    case 'public_holiday': return d.holiday;
    case 'exams': return d.uni === 'exams' && !d.weekend && !d.holiday;
    case 'uni_break': return d.uni === 'break' && !d.weekend && !d.holiday;
    case 'weekend': return d.weekend;
    case 'weekday': return !d.weekend && !d.holiday;
    default: return game.calendarAt(mid).season === filter;
  }
}

/** The calendar today as a record. */
export function calendarRec(game: Game): Rec {
  const t = game.t;
  const c = game.calendarAt(t), d = game.dayTypeAt(t);
  return {
    kind: 'calendar', season: SEASON_LABEL[c.season], week: c.week, seasonWeek: c.seasonWeek, year: c.year, weekend: d.weekend, publicHoliday: d.holiday,
    schoolDay: d.school, schoolHolidays: d.schoolHolidays, university: d.uni, festive: d.festive, label: dayTypeLabel(d) || (d.weekend ? 'Weekend' : 'Working day'),
  };
}
