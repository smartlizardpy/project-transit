// Game settings for the City Activity Engine (docs/city-activity-engine-plan.md, section 7).
// Everything here is a game setting, not a measurement. Values are anchored on the ranges in
// docs/passenger-choice-research.md where published values exist; the rest are design values,
// chosen so that totals stay close to the earlier model (about 2.7 trips per person per day).

import type { Season } from '../calendar.ts';

// ───────────────────────────────────────────── traveller types (plan 7.4)

export interface TravellerType {
  id: string;
  label: string;
  /** fare sensitivity: multiplies the fare's minutes (1 = medium) */
  fare: number;
  /** weight on waiting time */
  wait: number;
  /** penalty per change, minutes */
  change: number;
  /** weight on walking to and from stops */
  walk: number;
  /** weight on unreliable service */
  rel: number;
  /** space taken on board relative to a commuter, and extra seconds to board (applied from phase 3) */
  space: number;
  board: number;
  /** car availability relative to the area's share (0: never drives) */
  car: number;
  /** taxi cost as minutes, relative to a commuter (lower: more willing to take a taxi) */
  taxi: number;
  /** cycling: multiplies the propensity constant (higher: less likely to cycle; 0 means never) */
  bike: number;
  /** walking as the whole journey: multiplies its time */
  walkMode: number;
  /** patience at the stop, relative to the default */
  patience: number;
}

export const TRAVELLERS: TravellerType[] = [
  { id: 'commuter', label: 'Commuter', fare: 1, wait: 1.6, change: 13, walk: 1.2, rel: 1.4, space: 1, board: 0, car: 1, taxi: 1, bike: 1, walkMode: 1, patience: 1 },
  { id: 'student', label: 'University student', fare: 1.6, wait: 1.5, change: 10, walk: 1.05, rel: 1, space: 1, board: 0, car: 0.3, taxi: 1.3, bike: 0.75, walkMode: 0.9, patience: 1.1 },
  { id: 'pupil', label: 'Pupil', fare: 1.5, wait: 1.5, change: 15, walk: 1.5, rel: 1, space: 1, board: 0, car: 0.6, taxi: 2, bike: 1, walkMode: 1, patience: 1 },
  { id: 'shift', label: 'Shift worker', fare: 1, wait: 1.8, change: 13, walk: 1.2, rel: 1.8, space: 1, board: 0, car: 1, taxi: 1, bike: 1, walkMode: 1, patience: 0.9 },
  { id: 'shopper', label: 'Shopper or errands', fare: 1.2, wait: 1.8, change: 15, walk: 1.5, rel: 0.6, space: 1.1, board: 0.5, car: 1, taxi: 1, bike: 1.3, walkMode: 1.1, patience: 1 },
  { id: 'leisure', label: 'Leisure or nightlife', fare: 1, wait: 1.8, change: 15, walk: 1.2, rel: 0.6, space: 1, board: 0, car: 0.9, taxi: 0.8, bike: 1, walkMode: 1, patience: 1 },
  { id: 'visitor', label: 'Visitor', fare: 0.5, wait: 1.7, change: 20, walk: 1.2, rel: 1, space: 1.2, board: 1, car: 0, taxi: 0.6, bike: 1.5, walkMode: 0.9, patience: 1.1 },
  { id: 'air', label: 'Air traveller', fare: 0.35, wait: 2, change: 25, walk: 1.5, rel: 2.5, space: 1.6, board: 2, car: 1, taxi: 0.5, bike: 0, walkMode: 1.6, patience: 0.8 },
  { id: 'event', label: 'Event attendee', fare: 1, wait: 1.4, change: 12, walk: 1.05, rel: 0.6, space: 1, board: 0, car: 1, taxi: 1, bike: 1, walkMode: 0.9, patience: 1.2 },
  { id: 'patient', label: 'Patient or visitor', fare: 1, wait: 1.8, change: 15, walk: 1.6, rel: 1, space: 1.1, board: 0.5, car: 1, taxi: 0.9, bike: 1.5, walkMode: 1.2, patience: 1 },
];
export const TYPE = Object.fromEntries(TRAVELLERS.map((t, i) => [t.id, i])) as Record<string, number>;
export const TYPE_COUNT = TRAVELLERS.length;

// ───────────────────────────────────────────── tour kinds (plan 7.2, 7.3)

/** What a tour is for; each kind has its traveller type, destinations and timing. */
export type Attraction =
  | 'work' | 'shift' | 'school' | 'university' | 'shopping' | 'errand' | 'health' | 'leisure' | 'night' | 'visit' | 'business' | 'airport';

/** A mixture of normal curves: [weight, mean, sd] in hours. */
export type Curve = [number, number, number][];

export interface TourKind {
  id: string;
  label: string;
  type: number;
  attr: Attraction;
  /** distance decay length, metres */
  decay: number;
  /** production and attraction totals both match (work and education) */
  doubly?: boolean;
  /** one-way journeys (to or from an airport): no return leg */
  oneWay?: boolean;
  /** optional tours can be skipped (stay home) */
  optional?: boolean;
  /** the destination side is people's homes (arrivals from an airport) */
  toHome?: boolean;
  /** departure times by day type, and time spent at the activity (hours) */
  start: { weekday: Curve; weekend: Curve };
  stay: Curve;
  /** weekend volume relative to weekdays */
  weekend: number;
}

const T = TYPE;
export const KINDS: TourKind[] = [
  { id: 'work', label: 'Work', type: T.commuter, attr: 'work', decay: 4200, doubly: true, start: { weekday: [[1, 7.9, 1], [0.12, 13, 3]], weekend: [[1, 9.5, 1.8]] }, stay: [[1, 8.9, 0.9]], weekend: 0.32 },
  { id: 'shift', label: 'Shift work', type: T.shift, attr: 'shift', decay: 4500, doubly: true, start: { weekday: [[0.4, 6, 0.5], [0.35, 14, 0.5], [0.25, 21.8, 0.5]], weekend: [[0.4, 6, 0.5], [0.35, 14, 0.5], [0.25, 21.8, 0.5]] }, stay: [[0.7, 8.3, 0.3], [0.3, 12, 0.3]], weekend: 0.8 },
  { id: 'school', label: 'School', type: T.pupil, attr: 'school', decay: 1300, doubly: true, start: { weekday: [[1, 7.7, 0.45]], weekend: [[1, 10, 2]] }, stay: [[1, 6.8, 0.6]], weekend: 0.03 },
  { id: 'university', label: 'University', type: T.student, attr: 'university', decay: 5000, doubly: true, start: { weekday: [[1, 9.3, 1.5], [0.3, 13.5, 1.5]], weekend: [[1, 11, 2]] }, stay: [[1, 5.5, 2]], weekend: 0.1 },
  { id: 'shopping', label: 'Shopping', type: T.shopper, attr: 'shopping', decay: 1800, optional: true, start: { weekday: [[1, 11.5, 2.2], [0.7, 17.5, 1.8]], weekend: [[1, 12.5, 2.6]] }, stay: [[1, 1.5, 0.7]], weekend: 1.35 },
  { id: 'errand', label: 'Errands', type: T.shopper, attr: 'errand', decay: 2000, optional: true, start: { weekday: [[1, 10.5, 2.4], [0.4, 15, 2]], weekend: [[1, 12, 3]] }, stay: [[1, 1, 0.5]], weekend: 0.6 },
  { id: 'health', label: 'Health', type: T.patient, attr: 'health', decay: 3500, start: { weekday: [[1, 10, 2], [0.4, 15, 2]], weekend: [[1, 12, 3]] }, stay: [[1, 1.7, 0.6]], weekend: 0.5 },
  { id: 'leisure', label: 'Leisure', type: T.leisure, attr: 'leisure', decay: 2600, optional: true, start: { weekday: [[0.4, 12, 2.5], [1, 19.3, 1.8]], weekend: [[1, 13, 3], [0.8, 19.5, 2]] }, stay: [[1, 2.6, 1.2]], weekend: 1.4 },
  { id: 'night', label: 'Nightlife', type: T.leisure, attr: 'night', decay: 3500, optional: true, start: { weekday: [[1, 21.6, 1.2]], weekend: [[1, 22, 1.3]] }, stay: [[1, 4, 1]], weekend: 2 },
  { id: 'visit', label: 'Sightseeing', type: T.visitor, attr: 'visit', decay: 3500, optional: true, start: { weekday: [[1, 10.5, 2], [0.4, 15, 2]], weekend: [[1, 11, 2.2]] }, stay: [[1, 3.5, 1.8]], weekend: 1.2 },
  { id: 'business', label: 'Business and lunch', type: T.commuter, attr: 'business', decay: 2200, start: { weekday: [[1, 12.5, 1.4], [0.5, 15.5, 1.5]], weekend: [[1, 13, 2]] }, stay: [[1, 1, 0.4]], weekend: 0.2 },
  { id: 'fly', label: 'To the airport', type: T.air, attr: 'airport', decay: 60000, oneWay: true, start: { weekday: [[0.8, 6, 1.2], [1, 11.5, 2.5], [1, 17.5, 2.5]], weekend: [[1, 8, 2], [1, 14, 3], [0.8, 19, 2.5]] }, stay: [[1, 0, 1]], weekend: 1 },
  { id: 'landed', label: 'From the airport', type: T.air, attr: 'airport', decay: 60000, oneWay: true, toHome: true, start: { weekday: [[0.6, 8.5, 1.5], [1, 14, 2.5], [1, 20.5, 2.5]], weekend: [[1, 10, 2.5], [1, 15, 3], [0.8, 21, 2]] }, stay: [[1, 0, 1]], weekend: 1 },
];
export const KIND = Object.fromEntries(KINDS.map((k, i) => [k.id, i])) as Record<string, number>;
export const KIND_COUNT = KINDS.length;

// ───────────────────────────────────────────── who makes tours (plan 7.2)

/**
 * Tours per resident per weekday, by kind. Shares of workers, pupils, students and others are
 * folded in: 0.40 work tours per resident is about 45% of residents working on a given day.
 */
export const HOME_RATE: Partial<Record<string, number>> = {
  work: 0.4, shift: 0.06, school: 0.13, university: 0.045, shopping: 0.2, errand: 0.08, health: 0.035, leisure: 0.2, night: 0.03, fly: 0.002,
};
/** Tours from a workplace per job and day (lunch, meetings, errands from work). */
export const JOB_RATE: Partial<Record<string, number>> = { business: 0.22 };
/** Tours per hotel guest and day. */
export const GUEST_RATE: Partial<Record<string, number>> = { visit: 1, leisure: 0.35, shopping: 0.25, night: 0.1, fly: 0.1 };
/** Rooms per hotel, guests per room. */
export const HOTEL = { rooms: 35, guests: 1.7 };
/** Hotel occupancy by season (a typical city; weather and events come later). */
export const OCCUPANCY: Record<Season, number> = { autumn: 0.72, winter: 0.55, spring: 0.72, summer: 0.88 };

/**
 * People who arrive at a station or pier and continue on foot or by your network, as a share of
 * the station's daily users. Their tours start and end at the station.
 */
export const GATEWAY_SHARE: Partial<Record<string, number>> = { rail_station: 0.05, ferry_pier: 0.06, metro_station: 0.025, bus_station: 0.08 };
/** What those arriving travellers do. */
export const GATEWAY_MIX: Partial<Record<string, number>> = { work: 0.45, business: 0.1, shopping: 0.15, leisure: 0.15, visit: 0.15 };

/** Optional tours not made when nothing good is on offer (stay home); at most +15% (1 / (1 − 0.13)). */
export const STAY_HOME = 0.13;

// ───────────────────────────────────────────── choice (plan 7.5)

export const CHOICE = {
  /** logit scale per journey leg, generalised minutes (unchanged from the earlier model) */
  scale: 5.5,
  /** walking speed m/min and the detour from straight lines to streets */
  walkSpeed: 75,
  detour: 1.25,
  /** the longest walk to a stop, metres along streets */
  accessM: 600,
  /** cycling speed m/min, the propensity constant (minutes; a city with little cycling), longest ride */
  bikeSpeed: 233,
  bikeConst: 60,
  bikeMaxM: 8000,
  /** longest walk as a whole journey, metres */
  walkMaxM: 3000,
  /** taxi: wait minutes, fare base and per km, value of time (currency per minute, as in the fare's minutes) */
  taxiWait: 5,
  taxiBase: 2.5,
  taxiPerKm: 1.1,
  valueOfTime: 0.15,
  /** generalised minutes of being stranded without a way home (a taxi found late) */
  stranded: 15,
  /** your network: a constant for awareness and trust, tuned with the calibration scenarios */
  networkConst: 1,
};

/** Bus run times are scheduled with this crowding multiplier on in-vehicle time (1.0 seated, ≈1.6 at crush). */
export function crowding(load: number): number {
  return 1 + Math.max(0, Math.min(1.1, load) - 0.75) * 2.4;
}
