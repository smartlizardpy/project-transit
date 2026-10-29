import { DAY, HOUR, SERVICE_DAY_START } from './content.ts';

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const dayOf = (t: number) => Math.floor(t / DAY);
export const secondOfDay = (t: number) => t - dayOf(t) * DAY;
export const hourOfDay = (t: number) => secondOfDay(t) / HOUR;
/** Weekday index (0 = Monday) of absolute time t. */
export const weekdayOf = (startWeekday: number, t: number) => (((startWeekday + dayOf(t)) % 7) + 7) % 7;
export const isWeekend = (startWeekday: number, t: number) => weekdayOf(startWeekday, t) >= 5;
/** Service day (03:00 → 03:00) containing t. */
export const serviceDayOf = (t: number) => Math.floor((t - SERVICE_DAY_START) / DAY);
/** Absolute start of a service day. */
export const serviceDayStart = (sd: number) => sd * DAY + SERVICE_DAY_START;
/** Is the given service day a weekend day? */
export const serviceDayWeekend = (startWeekday: number, sd: number) => weekdayOf(startWeekday, sd * DAY) >= 5;

export function hhmm(t: number): string {
  const s = Math.floor(secondOfDay(t) / 60);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Minutes since 00:00 (may exceed 1440) → "HH:MM", wrapping after midnight. */
export function minutesLabel(m: number): string {
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
}
