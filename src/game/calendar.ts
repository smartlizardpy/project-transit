// The game calendar: a game year of four seasons, counted in weeks.
//
// The game never shows real dates, months or years. A real date would soon be a future one,
// and real holiday dates for future years cannot be known. Weekdays stay real (Mon–Sun); game
// day numbers ("Day 12") are unchanged. A year starts in week 1 of autumn, the start of the
// school and university year. See docs/city-activity-engine-plan.md, section 9.1.

import { DAY } from './content.ts';
import { weekdayOf } from './time.ts';

export const SEASONS = ['autumn', 'winter', 'spring', 'summer'] as const;
export type Season = (typeof SEASONS)[number];
export const SEASON_LABEL: Record<Season, string> = { autumn: 'Autumn', winter: 'Winter', spring: 'Spring', summer: 'Summer' };

/** Default game year: 12 weeks, three per season (owner's decision; a game setting). */
export const YEAR_WEEKS = 12;

/** Saved calendar settings (`state.world.calendar`). */
export interface CalendarState {
  /** weeks in a game year; a multiple of 4 */
  yearWeeks: number;
  /** game day number of Monday, week 1 of year 1 (autumn). May be negative. */
  epochDay: number;
}

/** Where a game day falls in the game year. */
export interface CalendarDay {
  /** game day number (0 = the first day of the company) */
  day: number;
  /** 1-based game year, counted from the company's start */
  year: number;
  /** 1-based week of the year */
  week: number;
  season: Season;
  /** 1-based week within the season */
  seasonWeek: number;
  /** 0-based day within the year */
  dayOfYear: number;
  /** position in the year, 0 (start of autumn) to 1 (end of summer) */
  phase: number;
  /** 0 = Monday */
  weekday: number;
  /** weeks in this game year, and in each season */
  yearWeeks: number;
  seasonWeeks: number;
}

/** A new company: day 0 falls in week 1 of autumn. */
export function newCalendar(startWeekday: number, yearWeeks = YEAR_WEEKS): CalendarState {
  return { yearWeeks, epochDay: 0 - weekdayOf(startWeekday, 0) };
}

/** An older save: the week containing `day` becomes week 1 of autumn, year 1. */
export function calendarFrom(startWeekday: number, day: number, yearWeeks = YEAR_WEEKS): CalendarState {
  return { yearWeeks, epochDay: day - weekdayOf(startWeekday, day * DAY) };
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Calendar position of a game day. Days before the calendar's start fall in "year 0". */
export function calendarDay(cal: CalendarState, startWeekday: number, day: number): CalendarDay {
  const len = cal.yearWeeks * 7;
  const rel = day - cal.epochDay;
  const dayOfYear = mod(rel, len);
  const week = Math.floor(dayOfYear / 7) + 1;
  const perSeason = cal.yearWeeks / SEASONS.length;
  const si = Math.min(SEASONS.length - 1, Math.floor((week - 1) / perSeason));
  return {
    day,
    year: Math.floor(rel / len) + 1,
    week,
    season: SEASONS[si],
    seasonWeek: week - si * perSeason,
    dayOfYear,
    phase: dayOfYear / len,
    weekday: weekdayOf(startWeekday, day * DAY),
    yearWeeks: cal.yearWeeks,
    seasonWeeks: perSeason,
  };
}

/** "Autumn, week 2" */
export function seasonWeekLabel(c: CalendarDay): string {
  return `${SEASON_LABEL[c.season]}, week ${c.seasonWeek}`;
}

/** "Year 2 · Spring" */
export function yearSeasonLabel(c: CalendarDay): string {
  return `Year ${c.year} · ${SEASON_LABEL[c.season]}`;
}
