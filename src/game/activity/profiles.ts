// Place-specific activity profiles (docs/city-activity-engine-plan.md, sections 8 and 9.1).
//
// A profile is data. For each tour kind a kind of place attracts, it can change when people set
// off (start curves), on which days and how many (volume by weekday) and the calendar rule that
// gates it. A tour's timing comes from the profile at its activity end. For example, shift
// workers at a hospital change at 07, 15 and 23, at an airport at 05, 13 and 21, and elsewhere
// at 06, 14 and 22. Anything a profile leaves out keeps the tour kind's own setting (KINDS).
// Volumes still come from each place's own size (zones.ts). A new kind of place is a new entry
// here, not new code.

import type { CityPlace } from '../world/places.ts';
import type { DayType } from '../calendar.ts';
import { hashString } from '../hash.ts';
import { KINDS, KIND_COUNT, type Curve, type Gate } from './params.ts';

export interface Timing {
  start?: { weekday: Curve; weekend: Curve; exams?: Curve };
  days?: number[];
  gate?: Gate | 'none';
}

export interface Profile {
  id: string;
  /** what the place card says about its timing ('' for the city in general) */
  note: string;
  kinds: Partial<Record<string, Timing>>;
}

const EVERY_DAY = [1, 1, 1, 1, 1, 1, 1];
/** floor area above which a market is a covered bazaar, m² */
const COVERED_M2 = 3000;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Shift workers by the hour their shift changes (they set off about 35 minutes earlier). */
const shifts = (a: number, b: number, c: number): Timing => {
  const curve: Curve = [[0.45, a - 0.6, 0.4], [0.35, b - 0.6, 0.4], [0.2, c - 0.6, 0.4]];
  return { start: { weekday: curve, weekend: curve }, days: EVERY_DAY, gate: 'none' };
};

/** Air travellers set off about 2½ hours before their flight; flights come in waves by airport size. */
const AIR_WAVES: Record<number, { fly: Curve; landed: Curve }> = {
  // hubs: banks of departures through the day, 04:30 to 23:30
  1: {
    fly: [[0.7, 3.4, 0.5], [1, 6.2, 0.7], [0.9, 9.8, 0.8], [1, 13.2, 0.8], [0.9, 16.6, 0.8], [0.6, 19.8, 0.7]],
    landed: [[0.5, 6.8, 0.6], [1, 9.8, 0.7], [0.9, 13.3, 0.8], [1, 16.8, 0.8], [0.9, 20.2, 0.8], [0.6, 23, 0.5]],
  },
  2: {
    fly: [[0.9, 3.6, 0.6], [1, 7.5, 1.1], [1, 13.5, 1.2], [0.8, 17.5, 1.1]],
    landed: [[0.8, 8.5, 0.8], [1, 12, 1.1], [1, 17.5, 1.2], [0.7, 21.8, 0.9]],
  },
  // small airports: a few flights in the morning, at midday and in the evening
  3: {
    fly: [[1, 4, 0.6], [0.7, 10.5, 1.2], [0.9, 15.5, 1]],
    landed: [[0.8, 9, 0.8], [0.6, 14, 1.2], [1, 20.5, 0.9]],
  },
};
const airTier = (tier: number) => (tier <= 1 ? 1 : tier === 2 ? 2 : 3);

/** A weekly street market: busy on its market day, quieter otherwise, shut on Sundays. */
const marketDays = (day: number) => [0, 1, 2, 3, 4, 5, 6].map((d) => (d === 6 ? 0.25 : d === day ? 1.8 : 0.85));

function build(): Profile[] {
  const list: Profile[] = [{ id: 'city', note: '', kinds: {} }];
  list.push({
    id: 'hospital',
    note: 'Staff change shifts around 07:00, 15:00 and 23:00, every day. Outpatients come on weekdays, 08:00–16:00; visitors 14:00–20:00.',
    kinds: {
      shift: shifts(7, 15, 23),
      // outpatients (weekdays) and visitors (every day)
      health: {
        start: { weekday: [[0.65, 10.2, 2.1], [0.35, 16.3, 1.6]], weekend: [[0.2, 11, 2.5], [0.8, 16.3, 1.6]] },
        days: [1, 1, 1, 1, 1, 0.45, 0.45],
        gate: 'working',
      },
    },
  });
  for (const t of [1, 2, 3])
    list.push({
      id: `airport${t}`,
      note:
        t === 1
          ? 'Travellers come in waves through the day, from about 04:30 to 23:30. Staff change shifts around 05:00, 13:00 and 21:00.'
          : t === 2
            ? 'Travellers come in four waves, from early morning to the evening. Staff change shifts around 05:00, 13:00 and 21:00.'
            : 'A few flights: travellers in the early morning, at midday and in the evening. Staff change shifts around 05:00, 13:00 and 21:00.',
      kinds: {
        shift: shifts(5, 13, 21),
        work: { days: EVERY_DAY, gate: 'none' },
        fly: { start: { weekday: AIR_WAVES[t].fly, weekend: AIR_WAVES[t].fly } },
        landed: { start: { weekday: AIR_WAVES[t].landed, weekend: AIR_WAVES[t].landed } },
      },
    });
  list.push({
    id: 'university',
    note: 'Students come in teaching weeks, 09:00–17:00. Exam weeks are quieter and more spread out; the summer break is nearly empty.',
    kinds: {},
  });
  list.push({
    id: 'mall',
    note: 'Open every day, about 10:00–22:00, busiest at weekends and in the evening.',
    kinds: { shopping: { start: { weekday: [[1, 12.5, 2.2], [1, 18, 1.7]], weekend: [[1, 13.5, 2.6], [0.5, 18.5, 1.6]] }, days: [0.9, 0.9, 0.9, 1, 1.15, 1.6, 1.4] } },
  });
  // a permanent covered market (a bazaar): mornings and middays, quiet on Sundays
  list.push({
    id: 'bazaar',
    note: 'A covered market: busiest in the late morning and on Saturdays, quiet on Sundays (many close).',
    kinds: {
      shopping: { start: { weekday: [[1, 10.5, 1.8], [0.5, 14.5, 1.8]], weekend: [[1, 11, 2]] }, days: [1, 1, 1, 1, 1, 1.3, 0.35] },
      visit: { days: [1, 1, 1, 1, 1, 1.1, 0.5] },
    },
  });
  for (let d = 0; d < 6; d++)
    list.push({
      id: `market${d}`,
      note: `Market day: ${WEEKDAYS[d]} (assumed; the map does not say). Busiest in the morning; shut on Sundays.`,
      kinds: { shopping: { start: { weekday: [[1, 9.8, 1.6], [0.4, 14, 1.8]], weekend: [[1, 10.5, 2]] }, days: marketDays(d) } },
    });
  list.push({
    id: 'stadium',
    note: 'Quiet on ordinary days: tours and a small staff. Match days come with events.',
    kinds: {},
  });
  // stations and piers: people arriving to travel on, with commuter peaks
  list.push({ id: 'station', note: 'Commuters at the peaks, and travellers through the day.', kinds: {} });
  return list;
}

export const PROFILES: Profile[] = build();
export const PROFILE = Object.fromEntries(PROFILES.map((p, i) => [p.id, i])) as Record<string, number>;

/** The profile for a place zone (the city's own for anything not listed). */
export function profileOf(p: CityPlace): number {
  switch (p.category) {
    case 'hospital': return PROFILE.hospital;
    case 'airport': return PROFILE[`airport${airTier(p.scale.tier)}`];
    case 'university': return PROFILE.university;
    case 'mall': return PROFILE.mall;
    // a market in a large building is a covered bazaar, open all week; an open-air market has a market day
    case 'market': return p.scale.tier <= 1 || p.floorM2 >= COVERED_M2 ? PROFILE.bazaar : PROFILE[`market${marketDayOf(p)}`];
    case 'stadium': return PROFILE.stadium;
    case 'rail_station': case 'metro_station': case 'ferry_pier': case 'bus_station': return PROFILE.station;
    default: return PROFILE.city;
  }
}

/** What the place card says about places without a profile of their own (typical pattern). */
const CATEGORY_NOTE: Partial<Record<CityPlace['category'], string>> = {
  school: 'Pupils arrive 07:30–08:15 and go home 15:00–16:00, on school days only. The holidays are nearly empty.',
  university: PROFILES[PROFILE.university].note,
  nightlife: 'Busiest on Friday and Saturday nights, from about 21:00 to 01:00; quieter on weekdays.',
  park: 'Busiest in the afternoon and at weekends; more in spring and summer.',
  beach: 'Mostly in summer, at weekends and on warm afternoons; quiet in winter.',
  attraction: 'Visitors through the day, more at weekends and in summer.',
  venue: 'Busiest in the evening.',
  industrial: 'Shift workers change around 06:00, 14:00 and 22:00, mostly on weekdays.',
  hotel_area: 'Visitors set off for sights, shops and the airport; more in summer.',
  tram_stop: PROFILES[PROFILE.station].note,
  cable_car: 'Visitors through the day.',
};

/** The place card's line about when a place is busy ('' when there is nothing to say). */
export function placeNote(p: CityPlace): string {
  return PROFILES[profileOf(p)].note || CATEGORY_NOTE[p.category] || '';
}

/** A street market's day, Monday to Saturday, from a hash of its id (the map has no market days). */
export function marketDayOf(p: CityPlace): number {
  return hashString(`market|${p.id}`) % 6;
}

const gauss = (x: number, mu: number, s: number) => Math.exp(-((x - mu) ** 2) / (2 * s * s));
function shape(c: Curve): Float64Array {
  const a = new Float64Array(24);
  let sum = 0;
  for (let h = 0; h < 24; h++) {
    // wrap early-morning starts round midnight, so a 04:30 wave is not cut off
    let v = 0;
    for (const [w, mu, sd] of c) v += w * (gauss(h + 0.5, mu, sd) + gauss(h + 24.5, mu, sd));
    a[h] = v;
    sum += v;
  }
  for (let h = 0; h < 24; h++) a[h] /= sum || 1;
  return a;
}

/** One day's timing for every profile and tour kind. */
export interface DayTiming {
  /** volume relative to an ordinary weekday, [profile × KIND_COUNT + kind] */
  factor: Float64Array;
  /** share of the day's tours starting in each hour, [(profile × KIND_COUNT + kind) × 24 + hour] */
  share: Float64Array;
}

const shapes = new Map<Curve, Float64Array>();
const shapeOf = (c: Curve) => {
  let s = shapes.get(c);
  if (!s) shapes.set(c, (s = shape(c)));
  return s;
};

/** Volume of a tour kind on this day under its calendar rule, relative to an ordinary weekday. */
function gated(gate: Gate | 'none' | undefined, days: number[], d: DayType, festive: boolean): number {
  const v = days[d.weekday];
  switch (gate) {
    case 'working': return d.holiday ? days[6] : v;
    case 'school': return d.school ? v : 0.01;
    case 'teaching': {
      const base = d.holiday ? days[6] : v;
      return base * (d.uni === 'break' ? 0.15 : d.uni === 'exams' ? 0.6 : 1);
    }
    case 'shops': return (d.holiday ? days[6] : v) * (d.weekday === 6 || d.holiday ? d.shops : 1) * (festive ? 1.2 : 1);
    default: return v;
  }
}

export function dayTiming(d: DayType): DayTiming {
  const P = PROFILES.length, K = KIND_COUNT;
  const factor = new Float64Array(P * K), share = new Float64Array(P * K * 24);
  const rest = d.weekend || d.holiday;
  for (let p = 0; p < P; p++)
    for (let k = 0; k < K; k++) {
      const kind = KINDS[k];
      const o = PROFILES[p].kinds[kind.id] ?? {};
      const start = o.start ?? kind.start;
      factor[p * K + k] = gated(o.gate ?? kind.gate, o.days ?? kind.days, d, d.festive && kind.attr === 'shopping');
      const curve = rest ? start.weekend : d.uni === 'exams' && start.exams ? start.exams : start.weekday;
      share.set(shapeOf(curve), (p * K + k) * 24);
    }
  return { factor, share };
}
