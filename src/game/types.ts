// Serialisable game state. Everything the player can lose by closing the app lives here;
// derived data (paths, caches, indexes) is rebuilt from it on load.

import type { LngLat } from './world/graph.ts';
import type { RegionSpec } from './world/region.ts';
import type { PlaceSnapshotState } from './world/places.ts';

import type { AnalyticsState } from './analytics/types.ts';
import type { ControlState } from './control.ts';
import type { AutomationState } from './automation/types.ts';
import type { CalendarState } from './calendar.ts';

export type Id = string;

export const SAVE_VERSION = 3;

// ─────────────────────────────────────────── company

export interface Company {
  name: string;
  colour: string;
  /** index into LOGOS */
  logo: number;
  founded: number;
  /** 0..100 */
  reputation: number;
  /** base-currency fare per journey (transfers included) */
  fare: number;
  status: 'ok' | 'warning' | 'insolvent' | 'bankrupt';
  /** consecutive day-ends with a negative balance */
  redDays: number;
}

// ─────────────────────────────────────────── network

export interface Stop {
  id: Id;
  name: string;
  /** road-graph node the bus halts at (re-snapped from lngLat if the graph changes) */
  node: number;
  /** halt on the opposite carriageway of a divided road (-1 = none), so both directions can serve the stop */
  alt?: number;
  lngLat: LngLat;
  zone: string;
  built: number;
}

/** A headway band within a service day. Minutes since 00:00; may exceed 1440 for after-midnight service. */
export interface Band {
  from: number;
  to: number;
  headway: number;
}

export interface DayPlan {
  bands: Band[];
}

export interface Timetable {
  weekday: DayPlan;
  weekend: DayPlan;
  /** minimum recovery time at termini, minutes */
  layover: number;
}

export type RouteKind = 'loop' | 'linear';

export interface Route {
  id: Id;
  number: string;
  name: string;
  colour: string;
  kind: RouteKind;
  /** outbound stop sequence (loop: the cycle, starting at the terminus) */
  stops: Id[];
  /** linear only: custom return sequence; null = outbound reversed */
  returnStops: Id[] | null;
  /** waypoints forcing street choices, per leg key `o:<i>` (after outbound stop i) or `r:<i>` */
  via: Record<string, LngLat[]>;
  timetable: Timetable;
  /** vehicles allocated to this line */
  vehicles: Id[];
  created: number;
  /** service suspended by the player */
  suspended: boolean;
}

export interface Depot {
  id: Id;
  name: string;
  node: number;
  lngLat: LngLat;
  zone: string;
  capacity: number;
  level: number;
  built: number;
}

// ─────────────────────────────────────────── vehicles

export type VehicleStatus =
  | 'parked' | 'preparing' | 'to_route' | 'in_service' | 'at_stop' | 'layover' | 'to_depot' | 'maintenance' | 'broken';

export type VehiclePos =
  | { kind: 'depot' }
  | { kind: 'pattern'; route: Id; pat: number; s: number }
  /** deadhead along road nodes; `to` = where it is heading */
  | { kind: 'path'; nodes: number[]; s: number; to: 'route' | 'depot' };

export interface Vehicle {
  /** last stop departure on the current trip (analytics: measured segment run times) */
  seg?: { trip: number; i: number; t: number };
  id: Id;
  fleetNo: string;
  model: string;
  depot: Id;
  route: Id | null;
  status: VehicleStatus;
  since: number;
  /** 1 = new, 0 = wreck */
  condition: number;
  km: number;
  bought: number;
  price: number;
  pos: VehiclePos;
  /** speed, m/s */
  v: number;
  /** next stop index within the current pattern */
  stopIdx: number;
  /** trip being run, and the trip reserved after it */
  trip: number | null;
  next: number | null;
  /** end of dwell / layover / preparation / maintenance */
  until: number;
  /** passengers on board (mirrors the passenger groups) */
  load: number;
  /** space taken on board, in commuter places: luggage and bags take more (missing: equal to load) */
  sp?: number;
  /** seconds behind schedule at the last stop (negative = early) */
  delay: number;
  /** player asked for this bus to leave service */
  withdraw: boolean;
  /** heading for maintenance after the current work */
  wantsService: boolean;
  /** pattern this vehicle will start when its deadhead arrives */
  target?: { route: Id; pat: number };
  /** sell the bus once it is back at its depot */
  sell?: boolean;
}

// ─────────────────────────────────────────── timetable trips

export const TripState = {
  Planned: 0,
  Assigned: 1,
  Running: 2,
  Done: 3,
  Missed: 4,
} as const;
export type TripState = (typeof TripState)[keyof typeof TripState];

export interface Trip {
  id: number;
  route: Id;
  pat: number;
  /** scheduled departure from the first stop, absolute game seconds */
  dep: number;
  veh: Id | null;
  state: TripState;
  /** departure delay from the first stop, seconds */
  startDelay?: number;
  /** arrival delay at the final stop, seconds (set when done) */
  endDelay?: number;
  /** an extra departure outside the timetable, and who asked for it ('player' or a workflow id) */
  extra?: string;
}

// ─────────────────────────────────────────── passengers

export interface Leg {
  /** route, pattern, alight stop */
  r: Id;
  p: number;
  a: Id;
}

export interface PaxGroup {
  n: number;
  /** origin and final destination stops */
  o: Id;
  d: Id;
  legs: Leg[];
  leg: number;
  /** alternative first legs (common lines), only before the first boarding */
  alt?: Leg[];
  /** average time the group started its journey */
  t0: number;
  /** average time the group arrived at its current stop (waiting) or boarded (on board) */
  tl: number;
  /** accumulated per-passenger wait and ride seconds */
  w: number;
  r: number;
  /** accumulated per-passenger crowding exposure (load factor × seconds) */
  cr: number;
  /** accumulated absolute schedule deviation seen at boardings, seconds */
  dl: number;
  /** route that sold the ticket */
  fr: Id | null;
  /** load factor when the group boarded (for crowding exposure) */
  lb?: number;
  /**
   * City Activity Engine: traveller type (index into TRAVELLERS), tour kind (index into KINDS),
   * and set on the way home of a round trip. Missing on groups from older saves (a mixed type).
   */
  k?: number;
  pu?: number;
  ret?: 1;
}

export interface PassengerState {
  waiting: Record<Id, PaxGroup[]>;
  onboard: Record<Id, PaxGroup[]>;
  /** fractional generation accumulators per OD pair */
  acc: Record<string, number>;
  /**
   * The away pool: people who travelled out on your network and will travel home later.
   * Key `${from stop}>${to stop}>${tour kind}`; value [minute, people, minute, people, …], sorted.
   */
  away: Record<string, number[]>;
}

// ─────────────────────────────────────────── finance

export type LedgerCategory =
  | 'equity' | 'fares' | 'grant' | 'contract' | 'vehicle_sale' | 'loan'
  | 'vehicle_purchase' | 'driver' | 'fuel' | 'maintenance' | 'fleet_fixed' | 'depot' | 'stops' | 'licence' | 'interest' | 'repayment' | 'construction';

export interface LedgerEntry {
  id: number;
  t: number;
  amt: number;
  cat: LedgerCategory;
  memo: string;
  route?: Id;
  veh?: Id;
  ref?: string;
}

export interface FinanceState {
  balance: number;
  /** recent detailed entries (older ones are folded into `archive`) */
  ledger: LedgerEntry[];
  /** folded daily totals of entries older than the ledger window */
  archive: { day: number; cat: LedgerCategory; route?: Id; amt: number }[];
  /** derived aggregates, maintained by `post` */
  daily: Record<number, Partial<Record<LedgerCategory, number>>>;
  routeDaily: Record<number, Record<Id, { rev: number; cost: number }>>;
  /** costs and fares accrued during the current hour, flushed to the ledger on the hour */
  acc: {
    fares: Record<Id, { amt: number; n: number }>;
    driver: Record<Id, number>;
    fuel: Record<Id, number>;
  };
  loan: number;
  /** total ever posted, for reconciliation */
  opening: number;
}

// ─────────────────────────────────────────── stats

export interface HourStats {
  /** absolute hour index */
  h: number;
  boardings: number;
  trips: number;
  abandoned: number;
  satSum: number;
  satN: number;
  /** component sums: wait, journey, crowding, reliability, price */
  comp: [number, number, number, number, number];
  waitSum: number;
  deps: number;
  ontime: number;
  missed: number;
  loadSum: number;
  loadN: number;
}

export interface RouteHour {
  h: number;
  boardings: number;
  deps: number;
  ontime: number;
  missed: number;
  loadSum: number;
  loadN: number;
  satSum: number;
  satN: number;
}

export interface DayStats {
  day: number;
  trips: number;
  boardings: number;
  abandoned: number;
  satisfaction: number;
  ontime: number;
  revenue: number;
  costs: number;
  reputation: number;
  balance: number;
}

export interface StatsState {
  hours: HourStats[];
  routeHours: Record<Id, RouteHour[]>;
  days: DayStats[];
  total: { trips: number; boardings: number; abandoned: number };
}

// ─────────────────────────────────────────── progression

export interface ObjectiveState {
  done: boolean;
  day?: number;
  progress: number;
}

export interface Notification {
  id: number;
  t: number;
  tone: 'info' | 'good' | 'warn' | 'bad';
  title: string;
  body?: string;
  ref?: { kind: 'vehicle' | 'route' | 'stop' | 'depot' | 'zone'; id: Id };
  read?: boolean;
}

export interface GameState {
  version: number;
  meta: { id: string; created: number; saved: number; playSeconds: number };
  region: RegionSpec & { fingerprint: string };
  company: Company;
  clock: { t: number; startWeekday: number };
  rng: number;
  stops: Record<Id, Stop>;
  routes: Record<Id, Route>;
  depots: Record<Id, Depot>;
  vehicles: Record<Id, Vehicle>;
  /** trips of the current and next service day, per route */
  trips: Record<Id, Trip[]>;
  /** service day the trips were generated for, per route */
  tripDay: Record<Id, number>;
  pax: PassengerState;
  finance: FinanceState;
  stats: StatsState;
  /** start: the areas the company was founded with (older saves: just the home area) */
  territory: { owned: string[]; home: string; start?: string[] };
  objectives: Record<string, ObjectiveState>;
  notifications: Notification[];
  counters: { stop: number; route: number; vehicle: number; depot: number; ledger: number; trip: number; notification: number };
  settings: { autoService: boolean; serviceBelow: number };
  onboarding: { active: boolean; step: number; flags: Record<string, boolean> };
  /** operational history, recorded from day one (save version 2) */
  analytics: AnalyticsState;
  /** company level progress and the Network Control unlock (save version 2) */
  control: ControlState;
  /** Automation Studio workflows, memory and history (save version 2) */
  automation: AutomationState;
  /** the city around the company: calendar, and later weather, events and places (save version 3) */
  world: WorldState;
}

/**
 * City Activity Engine state (save version 3). `seed` never changes after creation: weather,
 * events and other city randomness hash it with the day, so they never draw from `rng` (which
 * breakdowns advance) and a reloaded game sees the same city.
 */
export interface WorldState {
  seed: number;
  calendar: CalendarState;
  /**
   * The most significant places of the Place Registry (at most ~300), refreshed when the map
   * data changes. Lets tools list places without the map tiles, and later anchors saved events.
   */
  places: PlaceSnapshotState;
}
