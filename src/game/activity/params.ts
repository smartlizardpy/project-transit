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
  | 'work' | 'shift' | 'school' | 'university' | 'shopping' | 'errand' | 'health' | 'leisure' | 'night' | 'visit' | 'business' | 'airport' | 'event';

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
  /** departure times on working days, at weekends and on public holidays, and in exam weeks; time spent at the activity (hours) */
  start: { weekday: Curve; weekend: Curve; exams?: Curve };
  stay: Curve;
  /** volume by weekday (Monday first) relative to an ordinary working day */
  days: number[];
  /** the calendar rule that gates it (plan 9.1); places can override all of this (profiles.ts) */
  gate?: Gate;
}

/**
 * Calendar rules: 'working' (public holidays are like a Sunday), 'school' (term days only),
 * 'teaching' (university teaching weeks; exams lower and more spread; breaks near zero),
 * 'shops' (Sunday and holiday trading rules, festive shopping).
 */
export type Gate = 'working' | 'school' | 'teaching' | 'shops';

const T = TYPE;
export const KINDS: TourKind[] = [
  // shift changes at 06, 14 and 22 (industrial and city jobs; hospitals and airports differ, profiles.ts)
  { id: 'work', label: 'Work', type: T.commuter, attr: 'work', decay: 4200, doubly: true, gate: 'working', start: { weekday: [[1, 7.9, 1], [0.12, 13, 3]], weekend: [[1, 9.5, 1.8]] }, stay: [[1, 8.9, 0.9]], days: [1, 1, 1, 1, 1, 0.4, 0.24] },
  { id: 'shift', label: 'Shift work', type: T.shift, attr: 'shift', decay: 4500, doubly: true, gate: 'working', start: { weekday: [[0.4, 5.4, 0.4], [0.35, 13.4, 0.4], [0.25, 21.4, 0.4]], weekend: [[0.4, 5.4, 0.4], [0.35, 13.4, 0.4], [0.25, 21.4, 0.4]] }, stay: [[0.7, 8.3, 0.3], [0.3, 12, 0.3]], days: [1, 1, 1, 1, 1, 0.6, 0.45] },
  // arrival 07:30–08:15, home time 15:00–16:00
  { id: 'school', label: 'School', type: T.pupil, attr: 'school', decay: 1300, doubly: true, gate: 'school', start: { weekday: [[1, 7.45, 0.28]], weekend: [[1, 10, 2]] }, stay: [[1, 7.65, 0.3]], days: [1, 1, 1, 1, 1, 0, 0] },
  // teaching blocks 09–17 with spread arrivals; exam weeks lower and more spread
  { id: 'university', label: 'University', type: T.student, attr: 'university', decay: 5000, doubly: true, gate: 'teaching', start: { weekday: [[1, 8.8, 0.9], [0.45, 11.6, 1.3], [0.2, 14.3, 1.2]], weekend: [[1, 11, 2]], exams: [[1, 9.5, 1.8], [0.9, 13, 2.2]] }, stay: [[1, 5.5, 2]], days: [1, 1, 1, 1, 0.9, 0.12, 0.08] },
  { id: 'shopping', label: 'Shopping', type: T.shopper, attr: 'shopping', decay: 1800, optional: true, gate: 'shops', start: { weekday: [[1, 11.5, 2.2], [0.7, 17.5, 1.8]], weekend: [[1, 12.5, 2.6]] }, stay: [[1, 1.5, 0.7]], days: [0.95, 0.95, 0.95, 1, 1.1, 1.45, 1.25] },
  { id: 'errand', label: 'Errands', type: T.shopper, attr: 'errand', decay: 2000, optional: true, gate: 'working', start: { weekday: [[1, 10.5, 2.4], [0.4, 15, 2]], weekend: [[1, 12, 3]] }, stay: [[1, 1, 0.5]], days: [1, 1, 1, 1, 1, 0.85, 0.35] },
  { id: 'health', label: 'Health', type: T.patient, attr: 'health', decay: 3500, gate: 'working', start: { weekday: [[1, 10, 2], [0.4, 15, 2]], weekend: [[1, 12, 3]] }, stay: [[1, 1.7, 0.6]], days: [1, 1, 1, 1, 1, 0.6, 0.4] },
  { id: 'leisure', label: 'Leisure', type: T.leisure, attr: 'leisure', decay: 2600, optional: true, start: { weekday: [[0.4, 12, 2.5], [1, 19.3, 1.8]], weekend: [[1, 13, 3], [0.8, 19.5, 2]] }, stay: [[1, 2.6, 1.2]], days: [0.9, 0.9, 0.95, 1.05, 1.2, 1.5, 1.3] },
  // Friday and Saturday nights out
  { id: 'night', label: 'Nightlife', type: T.leisure, attr: 'night', decay: 3500, optional: true, start: { weekday: [[1, 21.6, 1.2]], weekend: [[1, 22, 1.3]] }, stay: [[1, 4, 1]], days: [0.75, 0.75, 0.85, 1.1, 2.3, 2.5, 0.9] },
  { id: 'visit', label: 'Sightseeing', type: T.visitor, attr: 'visit', decay: 3500, optional: true, start: { weekday: [[1, 10.5, 2], [0.4, 15, 2]], weekend: [[1, 11, 2.2]] }, stay: [[1, 3.5, 1.8]], days: [1, 1, 1, 1, 1, 1.2, 1.2] },
  { id: 'business', label: 'Business and lunch', type: T.commuter, attr: 'business', decay: 2200, gate: 'working', start: { weekday: [[1, 12.5, 1.4], [0.5, 15.5, 1.5]], weekend: [[1, 13, 2]] }, stay: [[1, 1, 0.4]], days: [1, 1, 1, 1, 1, 0.25, 0.15] },
  { id: 'fly', label: 'To the airport', type: T.air, attr: 'airport', decay: 60000, oneWay: true, start: { weekday: [[0.8, 6, 1.2], [1, 11.5, 2.5], [1, 17.5, 2.5]], weekend: [[1, 8, 2], [1, 14, 3], [0.8, 19, 2.5]] }, stay: [[1, 0, 1]], days: [1, 0.95, 0.95, 1, 1.1, 0.95, 1.05] },
  { id: 'landed', label: 'From the airport', type: T.air, attr: 'airport', decay: 60000, oneWay: true, toHome: true, start: { weekday: [[0.6, 8.5, 1.5], [1, 14, 2.5], [1, 20.5, 2.5]], weekend: [[1, 10, 2.5], [1, 15, 3], [0.8, 21, 2]] }, stay: [[1, 0, 1]], days: [1, 0.95, 0.95, 1, 1.1, 0.95, 1.05] },
  // attendees of matches, concerts, festivals and gatherings (events.ts): not part of the tour
  // matrix (no production here); their timing and way home come from the event itself
  { id: 'event', label: 'Events', type: T.event, attr: 'event', decay: 9000, start: { weekday: [[1, 19, 2]], weekend: [[1, 17, 3]] }, stay: [[1, 2.5, 0.5]], days: [1, 1, 1, 1, 1, 1, 1] },
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
/**
 * What those arriving travellers do (plan 6.7): commuters at the peaks on regional rail, metro
 * and ferries; travellers with luggage through the day at main and intercity stations.
 */
export const GATEWAY_MIX: Record<'main' | 'regional' | 'metro' | 'ferry' | 'coach', Partial<Record<string, number>>> = {
  main: { work: 0.3, business: 0.15, shopping: 0.1, leisure: 0.15, visit: 0.3 },
  regional: { work: 0.6, business: 0.1, shopping: 0.1, leisure: 0.1, visit: 0.1 },
  metro: { work: 0.5, business: 0.1, shopping: 0.15, leisure: 0.15, visit: 0.1 },
  ferry: { work: 0.45, business: 0.1, shopping: 0.1, leisure: 0.15, visit: 0.2 },
  coach: { work: 0.25, business: 0.15, shopping: 0.1, leisure: 0.15, visit: 0.35 },
};
/** Visitors to sights, parks and beaches by season, relative to spring (heat raises beaches). */
export const OUTDOOR_SEASON: Partial<Record<string, Record<Season, number>>> = {
  beach: { autumn: 0.6, winter: 0.2, spring: 1, summer: 2.2 },
  park: { autumn: 0.9, winter: 0.6, spring: 1, summer: 1.2 },
  attraction: { autumn: 1, winter: 0.8, spring: 1, summer: 1.25 },
};

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
  /**
   * your network: awareness and trust, as minutes added to each journey leg on it. It falls as
   * your reputation rises (straight between these, at reputation 0 and 100). It replaced the cap
   * on your network's share in phase 7; tuned with the calibration scenarios.
   */
  trust: { at0: 6.75, at100: 2.25 },
  /** existing transit (metro, tram, rail, ferry): a constant for its fare and comfort, minutes (assumed) */
  transitConst: 6,
};

/** Minutes of awareness and trust added to each journey leg on your network at this reputation. */
export function trustMinutes(reputation: number): number {
  const r = Math.max(0, Math.min(100, reputation)) / 100;
  return CHOICE.trust.at0 + (CHOICE.trust.at100 - CHOICE.trust.at0) * r;
}

/**
 * Nested choice (plan 7.5, phase 7): public transport (your network and the city's metro, tram,
 * rail and ferries), active modes (walking and cycling) and private ones (car and taxi). Modes in
 * one nest are closer substitutes, so a better bus line draws more from the metro than from cars.
 * Each nest's scale as a share of the logit scale (1: no nesting; lower: closer substitutes).
 */
export const NESTS = { transport: 0.6, active: 0.8, private: 0.8 };

// ───────────────────────────────────────────── weather (plan 9.2)
//
// Effects of the weather in each hour, by condition: dry, light rain, rain, heavy rain, snow.
// Game settings. Where published values exist they are the anchor: rain deters 8–25% of
// cyclists; bus ridership moves by single-digit percentages with weather (Eugene, Oregon:
// −5.7% on cold weekdays). Rain does not simply raise bus demand: people also walk to the stop
// and wait in it, roads are slower, and some trips are not made at all.

export const WEATHER = {
  /** walking time weighs more, per minute outdoors (whole walks, and walks to stops and stations) */
  walk: [1, 1.04, 1.12, 1.25, 1.3],
  /** cycling: riding time weighs more, plus minutes added to each journey (more put off by rain than walking) */
  bikeRide: [1, 1.08, 1.2, 1.5, 2],
  bike: [0, 1, 3, 7, 18],
  /** waiting time weighs more, but less than walking: many stops have a shelter */
  wait: [1, 1.04, 1.1, 1.2, 1.3],
  /** road speed (plan: about −8% in rain, −18% in heavy rain, −30% in snow) */
  road: [1, 0.97, 0.92, 0.82, 0.7],
  /** extra minutes to find a taxi */
  taxiWait: [0, 1, 3, 6, 8],
  /** trip making by what the tour is for (snow cancels some work trips rather than moving them to buses) */
  trips: {
    leisure: [1, 0.95, 0.88, 0.75, 0.65],
    night: [1, 0.97, 0.92, 0.82, 0.7],
    visit: [1, 0.95, 0.9, 0.8, 0.7],
    shopping: [1, 0.99, 0.96, 0.9, 0.75],
    errand: [1, 1, 0.97, 0.92, 0.8],
    health: [1, 1, 1, 0.97, 0.9],
    university: [1, 1, 0.98, 0.95, 0.85],
    school: [1, 1, 1, 1, 0.9],
    work: [1, 1, 1, 0.99, 0.94],
    shift: [1, 1, 1, 1, 0.96],
    business: [1, 1, 0.98, 0.95, 0.85],
    airport: [1, 1, 1, 1, 0.97],
    // ticket holders mostly go anyway
    event: [1, 1, 0.98, 0.95, 0.9],
  } as Record<Attraction, number[]>,
  /** visitors and leisure at parks and beaches, and shoppers at malls (people move indoors) */
  park: [1, 0.8, 0.55, 0.3, 0.4],
  beach: [1, 0.6, 0.35, 0.15, 0.1],
  mall: [1, 1.03, 1.08, 1.12, 1.05],
  /** heat (hour at or above `hotC`): long walks and waiting weigh more, beaches fill, parks empty at midday */
  hotC: 30,
  hot: { walk: 1.1, wait: 1.1, bike: 2, beach: 1.5, park: 0.85 },
  /** pleasant (dry, daytime, between these temperatures): more people out in parks and on bikes */
  pleasantC: [18, 27],
  pleasant: { leisure: 1.05, park: 1.15, beach: 1.1, bike: -0.5 },
  /** cold (hour at or below `coldC`) */
  coldC: 2,
  cold: { walk: 1.06, wait: 1.15, bike: 3, park: 0.8 },
};

/** Bus run times are scheduled with this crowding multiplier on in-vehicle time (1.0 seated, ≈1.6 at crush). */
export function crowding(load: number): number {
  return 1 + Math.max(0, Math.min(1.1, load) - 0.75) * 2.4;
}
