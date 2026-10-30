// Operational analytics, recorded from the company's first day (before Network Control is
// unlocked) so that a month of genuine history is waiting when it is.
//
// Storage is tiered to keep saves small:
// - `today`: the day being recorded (saved too, so a reload mid-day loses nothing);
// - `days`: finished days in full detail (hourly counts, segments, vehicles, origin–destination);
// - `summary`: compact daily totals per line and stop for older days.
// Arrays indexed by hour have 24 entries (hour of the calendar day). Ids are game ids, which
// are never reused, so history stays attributable after a stop or line is removed (`names`).

import type { Id } from '../types.ts';

/** Finished days kept in full detail (hourly, segments, vehicles, origin–destination). */
export const DETAIL_DAYS = 35;
/** Older days kept as compact daily totals. */
export const SUMMARY_DAYS = 120;
/** Route-assignment history entries kept. */
export const ASSIGNMENT_LOG = 500;

/** Time-of-day bands used for origin–destination detail (hours of the day, [from, to)). */
export const BANDS = [
  { id: 'night', label: 'Night', short: '00–06', from: 0, to: 6 },
  { id: 'am', label: 'Morning peak', short: '06–10', from: 6, to: 10 },
  { id: 'mid', label: 'Midday', short: '10–16', from: 10, to: 16 },
  { id: 'pm', label: 'Evening peak', short: '16–20', from: 16, to: 20 },
  { id: 'eve', label: 'Evening', short: '20–24', from: 20, to: 24 },
] as const;

export function bandOf(hour: number): number {
  for (let i = 0; i < BANDS.length; i++) if (hour >= BANDS[i].from && hour < BANDS[i].to) return i;
  return 0;
}

/** Per stop, one calendar day. */
export interface StopDay {
  /** boardings by hour */
  b: number[];
  /** alightings by hour */
  a: number[];
  /** passengers who gave up waiting, by hour */
  g: number[];
  /** passengers waiting, sampled at the end of each hour */
  w: number[];
  /** wait minutes of boarded passengers (sum), passengers counted, and the longest wait (minutes) */
  ws: number;
  wn: number;
  wx: number;
  /** boardings that were a transfer from another bus */
  x: number;
  /** passengers left behind by a full bus */
  lb: number;
  /** fares sold here (journeys that started here), and boardings by line */
  rv: number;
  bl: Record<Id, number>;
  /** boardings by traveller type (activity engine; missing on older days) */
  k?: number[];
}

/** Per line pattern (direction) and stop sequence: loads and run times per segment. */
export interface PatDay {
  pat: number;
  stops: Id[];
  /** sum of load factor at departure, and departures counted, per segment */
  ls: number[];
  ln: number[];
  /** sum of measured run seconds, and runs counted, per segment */
  rs: number[];
  rn: number[];
  /** sum of scheduled run seconds for the same runs (for delay attribution) */
  ss: number[];
}

/** Per line, one calendar day. Arrays have one entry per hour of the day. */
export interface RouteDay {
  /** boardings */
  b: number[];
  /** trips completed (by finish time), of which on time, and departures missed */
  d: number[];
  o: number[];
  m: number[];
  /** stop departures counted, with the sum of their load factors and of seconds late (early = 0) */
  dp: number[];
  lf: number[];
  dl: number[];
  /** passenger-km and place-km (capacity × km) between stops */
  pk: number[];
  ck: number[];
  /** fares sold */
  rv: number[];
  /** staffed bus-minutes on this line (driving, at stops, layover, deadhead, broken down) */
  vm: number[];
  /** passengers left behind by full buses, and departures that left someone behind */
  lb: number;
  cr: number;
  /** passengers who gave up waiting for this line */
  g: number;
  /** wait minutes before boarding this line (sum) and boardings counted */
  ws: number;
  wn: number;
  /** satisfaction of journeys whose ticket this line sold: sum and count */
  ss: number;
  sn: number;
  /** boardings that were transfers onto this line */
  x: number;
  /** segment detail by pattern key */
  p: Record<string, PatDay>;
  /** boardings by hour per pattern key (same keys as `p`; missing on older days) */
  bp?: Record<string, number[]>;
  /** boardings by traveller type and time band: [type × BANDS.length + band] (missing on older days) */
  k?: number[];
}

/** Per vehicle, one calendar day. Minutes by activity. */
export interface VehicleDay {
  /** in service (driving a trip or at a stop), layover, deadhead/preparing, parked, maintenance, broken */
  sv: number;
  ly: number;
  dh: number;
  pk: number;
  mt: number;
  bk: number;
  /** odometer (km) when the day's record started, and km driven (set when the day closes) */
  km0: number;
  km: number;
  /** boardings, passenger-km, fares sold on board */
  b: number;
  pkm: number;
  rv: number;
  /** maintenance spend posted today */
  ms: number;
  /** staffed minutes per line */
  rt: Record<Id, number>;
  /** delay at stop departures: sum of seconds late and stops counted */
  dl: number;
  dn: number;
  /** vehicle model (costs are computed at that model's rates) */
  mdl: string;
}

/** Network totals, one calendar day. */
export interface NetDay {
  /** journeys completed, by hour of completion */
  j: number[];
  /** journeys not completed, by hour: gave up waiting, or stranded with no bus home (`sd`) */
  ab: number[];
  /** satisfaction sum and count, component sums */
  ss: number;
  sn: number;
  comp: [number, number, number, number, number];
  /** journey minutes and wait minutes of completed journeys (sums) */
  jt: number;
  wt: number;
  /** completed journeys that used a transfer */
  xf: number;
  /** completed journeys, stranded travellers (no bus home) and people left behind, by traveller type */
  jk?: number[];
  sk?: number[];
  lk?: number[];
  /** stranded travellers by hour (included in `ab`; they have no origin–destination record) */
  sd?: number[];
}

export interface DayRecord {
  day: number;
  /** recording started part-way through this day (first day after the update) */
  partial?: boolean;
  net: NetDay;
  stops: Record<Id, StopDay>;
  routes: Record<Id, RouteDay>;
  veh: Record<Id, VehicleDay>;
  /**
   * Origin–destination journeys. Key `${origin}>${destination}>${itinerary}` where the itinerary
   * is the lines used and transfer stops, e.g. `r1` or `r1.s5.r3`. Value: groups of five numbers
   * per time band present: [band, completed, abandoned, journey minutes, wait minutes, ...].
   */
  od: Record<string, number[]>;
  /** completed journeys by traveller type per `od` key: [type, people, type, people, …] */
  odk?: Record<string, number[]>;
}

/** Compact totals for days older than the detail window. */
export interface DaySummary {
  day: number;
  /** per line: boardings, trips completed, on time, missed, passenger-km, place-km */
  r: Record<Id, [number, number, number, number, number, number]>;
  /** per stop: boardings, alightings, gave up */
  s: Record<Id, [number, number, number]>;
  /** network: journeys, abandoned, satisfaction sum, satisfaction count */
  n: [number, number, number, number];
}

export interface AssignmentEvent {
  t: number;
  v: Id;
  from: Id | null;
  to: Id | null;
  /** 'player', or the id of the workflow that requested it */
  src: string;
}

export interface AnalyticsState {
  v: 1;
  /** first day recorded in full; earlier days have no detail (older saves start on upgrade) */
  since: number;
  today: DayRecord;
  days: DayRecord[];
  summary: DaySummary[];
  assignments: AssignmentEvent[];
  /** display names for ids that may later be removed */
  names: { s: Record<Id, string>; r: Record<Id, { n: string; c: string }>; v: Record<Id, string> };
}

export const hours0 = () => new Array<number>(24).fill(0);
/** Traveller types recorded (see activity/params.ts TRAVELLERS). */
export const TYPE_COUNT = 10;
export const types0 = () => new Array<number>(TYPE_COUNT).fill(0);

export function emptyDay(day: number, partial = false): DayRecord {
  const d: DayRecord = {
    day,
    net: { j: hours0(), ab: hours0(), ss: 0, sn: 0, comp: [0, 0, 0, 0, 0], jt: 0, wt: 0, xf: 0 },
    stops: {},
    routes: {},
    veh: {},
    od: {},
  };
  if (partial) d.partial = true;
  return d;
}

export function emptyAnalytics(day: number, partial = false): AnalyticsState {
  return { v: 1, since: partial ? day + 1 : day, today: emptyDay(day, partial), days: [], summary: [], assignments: [], names: { s: {}, r: {}, v: {} } };
}
