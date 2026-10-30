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

// ───────────────────────────────────────────── typical patterns (plan 9.1)
//
// Where in the game year schools, universities, holidays and shops follow their typical
// pattern. Positions are weeks of a 12-week template year (scaled to the game's year length)
// and weekdays, never real dates. Written by hand per country and labelled "typical pattern".

/** One country's typical calendar, as positions in a 12-week template year. */
export interface CalendarPattern {
  /** public holidays: [template week 1–12, weekday 0 = Monday] */
  holidays: [number, number][];
  /** weeks without school, and single school days off ([week, weekday]) */
  schoolOff: number[];
  schoolDaysOff: [number, number][];
  /** universities: exam weeks and break weeks (the other weeks are teaching) */
  exams: number[];
  uniBreak: number[];
  /** the winter holiday period (festive shopping) */
  festive: number[];
  /** shops on Sundays and on public holidays: their trade relative to an ordinary day */
  sundayShops: number;
  holidayShops: number;
}

/** The default 12-week layout (plan 9.1). */
export const DEFAULT_PATTERN: CalendarPattern = {
  holidays: [[5, 3], [8, 0]],
  schoolOff: [5, 10, 11, 12],
  schoolDaysOff: [[7, 0], [7, 1]],
  exams: [6, 9],
  uniBreak: [10, 11, 12],
  festive: [5],
  sundayShops: 0.9,
  holidayShops: 0.7,
};

/**
 * Per country, what differs from the default. The number of public holidays is the real
 * yearly count scaled to an 84-day year (about one in four); shop rules follow each country's
 * usual Sunday trading.
 */
export const COUNTRY_PATTERN: Record<string, Partial<CalendarPattern>> = {
  TR: { holidays: [[2, 2], [5, 4], [8, 3]], sundayShops: 1, holidayShops: 0.8 },
  GB: { sundayShops: 0.6 },
  DE: { holidays: [[5, 3], [8, 4]], sundayShops: 0.08, holidayShops: 0.08 },
  ES: { holidays: [[3, 2], [5, 3], [8, 0]], sundayShops: 0.35, holidayShops: 0.3 },
  JP: { holidays: [[5, 0], [5, 1], [7, 3], [7, 4]], sundayShops: 1, holidayShops: 1 },
};

export function calendarPattern(country: string): CalendarPattern {
  return { ...DEFAULT_PATTERN, ...COUNTRY_PATTERN[country.toUpperCase()] };
}

/** What kind of day a game day is (plan 9.1, "the calendar provides"). */
export interface DayType {
  /** 0 = Monday */
  weekday: number;
  weekend: boolean;
  holiday: boolean;
  /** pupils go to school today */
  school: boolean;
  /** a school holiday (a weekday without school that is not a public holiday) */
  schoolHolidays: boolean;
  uni: 'teaching' | 'exams' | 'break';
  festive: boolean;
  /** shops' trade relative to an ordinary day (Sunday and holiday rules) */
  shops: number;
}

/** The template week (1–12) that a week of the game year falls in. */
function templateWeek(c: CalendarDay): number {
  return Math.min(12, Math.floor(((c.week - 1) * 12) / c.yearWeeks) + 1);
}
/** The first week of the game year that falls in template week `tw`. */
function firstWeekOf(tw: number, yearWeeks: number): number {
  return Math.ceil(((tw - 1) * yearWeeks) / 12) + 1;
}

export function dayType(c: CalendarDay, pattern: CalendarPattern): DayType {
  const tw = templateWeek(c);
  const wd = c.weekday;
  const weekend = wd >= 5;
  const at = (list: [number, number][]) => list.some(([w, d]) => d === wd && firstWeekOf(w, c.yearWeeks) === c.week);
  const holiday = !weekend && at(pattern.holidays);
  const offWeek = pattern.schoolOff.includes(tw);
  const school = !weekend && !holiday && !offWeek && !at(pattern.schoolDaysOff);
  const uni = pattern.uniBreak.includes(tw) ? 'break' : pattern.exams.includes(tw) ? 'exams' : 'teaching';
  return {
    weekday: wd,
    weekend,
    holiday,
    school,
    schoolHolidays: !weekend && !holiday && !school,
    uni,
    festive: pattern.festive.includes(tw),
    shops: holiday ? pattern.holidayShops : wd === 6 ? pattern.sundayShops : 1,
  };
}

/** A short label for the top bar, or '' on an ordinary day. */
export function dayTypeLabel(t: DayType): string {
  if (t.holiday) return 'Public holiday';
  if (t.schoolHolidays) return 'School holidays';
  if (t.uni === 'exams' && !t.weekend) return 'Exam week';
  return '';
}
