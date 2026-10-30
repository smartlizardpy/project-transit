// Game content and balance constants. Money is in a neutral base currency (≈ euros);
// the UI converts it to a local display currency (see currency.ts).
// All values are game-design estimates, documented in docs/economy.md. Running costs and fares
// are close to real European values; vehicle and depot prices are deliberately scaled down
// (about a third of real prices) so a well-used bus pays for itself in weeks of game time.

export const DT = 1; // simulation step, game seconds
export const DAY = 86400;
export const HOUR = 3600;
/** A service day runs from 03:00 to 03:00 the next morning. */
export const SERVICE_DAY_START = 3 * HOUR;

/** Game seconds per real second for each speed setting (0 = paused). */
export const SPEEDS = [0, 8, 30, 120, 720] as const;

export interface VehicleModel {
  id: string;
  name: string;
  kind: string;
  length: number;
  capacity: number;
  seats: number;
  price: number;
  /** energy (fuel or electricity) per km */
  energyPerKm: number;
  /** door channels; more doors board faster */
  doors: number;
  /** acceleration m/s² */
  accel: number;
  /** top-speed factor on free-flow road speeds */
  speed: number;
  /** condition lost per km (fraction) */
  wearPerKm: number;
  /** chance multiplier for breakdowns at low condition */
  reliability: number;
  /** maintenance cost for a full restore, as a share of price */
  serviceCost: number;
  /** reputation required to buy */
  unlockRep: number;
  /** objective that unlocks it early (optional) */
  unlockObjective?: string;
  electric?: boolean;
  /** 3D model family */
  body: 'mini' | 'midi' | 'std' | 'dd' | 'artic';
  blurb: string;
}

export const MODELS: VehicleModel[] = [
  {
    id: 'mini8', name: 'Hopper 8', kind: 'Minibus', length: 7.6, capacity: 34, seats: 16, price: 36_000, energyPerKm: 0.27, doors: 1,
    accel: 1.25, speed: 1.04, wearPerKm: 0.00011, reliability: 0.9, serviceCost: 0.07, unlockRep: 0, body: 'mini',
    blurb: 'Cheap and nimble. Fine for quiet streets, overwhelmed at rush hour.',
  },
  {
    id: 'midi10', name: 'Midi 10', kind: 'Midibus', length: 9.6, capacity: 58, seats: 26, price: 52_000, energyPerKm: 0.36, doors: 2,
    accel: 1.1, speed: 1.0, wearPerKm: 0.0001, reliability: 0.95, serviceCost: 0.065, unlockRep: 0, body: 'midi',
    blurb: 'A sensible all-rounder for narrow city streets.',
  },
  {
    id: 'city12', name: 'City 12', kind: 'Standard bus', length: 12, capacity: 90, seats: 34, price: 75_000, energyPerKm: 0.46, doors: 3,
    accel: 1.0, speed: 1.0, wearPerKm: 0.000095, reliability: 0.97, serviceCost: 0.06, unlockRep: 0, body: 'std',
    blurb: 'The backbone of most fleets. Three doors keep stops short.',
  },
  {
    id: 'ecity12', name: 'eCity 12', kind: 'Electric bus', length: 12, capacity: 84, seats: 32, price: 128_000, energyPerKm: 0.17, doors: 3,
    accel: 1.15, speed: 1.0, wearPerKm: 0.00007, reliability: 0.98, serviceCost: 0.04, unlockRep: 45, body: 'std', electric: true,
    blurb: 'Expensive to buy, far cheaper to run and maintain.',
  },
  {
    id: 'deck11', name: 'Decker 11', kind: 'Double-decker', length: 11.2, capacity: 104, seats: 78, price: 104_000, energyPerKm: 0.55, doors: 2,
    accel: 0.9, speed: 0.97, wearPerKm: 0.0001, reliability: 0.95, serviceCost: 0.06, unlockRep: 40, body: 'dd',
    blurb: 'Lots of seats on a short footprint, but two doors mean slower stops.',
  },
  {
    id: 'artic18', name: 'Artic 18', kind: 'Articulated bus', length: 18, capacity: 145, seats: 46, price: 132_000, energyPerKm: 0.62, doors: 4,
    accel: 0.85, speed: 0.95, wearPerKm: 0.00011, reliability: 0.95, serviceCost: 0.06, unlockRep: 60, unlockObjective: 'daily-5000', body: 'artic',
    blurb: 'Moves crowds on trunk routes. Thirsty and slow to accelerate.',
  },
];

export const MODEL = Object.fromEntries(MODELS.map((m) => [m.id, m])) as Record<string, VehicleModel>;

export const ECON = {
  startingFunds: 400_000,
  /** suggested fare, base currency per journey */
  referenceFare: 1.8,
  fareMin: 0.4,
  fareMax: 4.5,
  /** driver wage incl. on-costs, per staffed hour */
  driverPerHour: 24,
  /** diesel price per unit of energyPerKm */
  fuelPrice: 1,
  /** electricity is cheaper per unit */
  electricPrice: 0.75,
  /** insurance, licensing, cleaning and administration per vehicle per day */
  fleetFixedPerDay: 45,
  stopCost: 1_800,
  /** registering a new line with the transport authority */
  routeFee: 2_500,
  stopUpkeepPerDay: 3,
  depotCost: 60_000,
  depotCapacity: 8,
  depotUpkeepPerDay: 240,
  depotExpandCost: 40_000,
  depotExpandCapacity: 6,
  depotExpandUpkeep: 120,
  /** resale value fraction for a new bus, declining with age and wear */
  resaleNew: 0.72,
  overdraftLimit: -200_000,
  overdraftRatePerDay: 0.0012,
  loanMax: 400_000,
  loanRatePerDay: 0.00028,
  /** days in the red before insolvency proceedings */
  graceDays: 7,
} as const;

/** Maintenance: time per percentage point restored, and the auto-service default. */
export const SERVICE = {
  minutesPerPoint: 3.2,
  minMinutes: 45,
  defaultBelow: 0.7,
  breakdownBelow: 0.45,
} as const;

export const COMPANY_COLOURS = ['#e0573e', '#2f9e9a', '#4f7fd6', '#d9a03a', '#8b6fd6', '#3e9e5b', '#d65f8f', '#3b4a54'];

export const LINE_COLOURS = ['#2f9e9a', '#e3a33b', '#8b6fd6', '#e0667c', '#4f8fe0', '#3fae7a', '#d08a3c', '#5d6bd6', '#c45bb8', '#7a9e2f', '#d4573b', '#2c7fa3'];

export const STARTING_REPUTATION = 30;

export const STOP_RULES = {
  /** max distance from the click to a drivable road */
  snapM: 40,
  /** minimum spacing between two stops */
  minSpacingM: 120,
  /** walking catchment radius for demand */
  catchmentM: 450,
} as const;
