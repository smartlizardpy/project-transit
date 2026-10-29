// Timetables: headway bands, scheduled run times, trip generation and fleet requirements.
//
// Scheduled run times come from a "ghost bus" driven along the line with the same movement
// code real buses use, under typical (noise-free) simulated traffic for each hour, stopping
// at every stop with an average dwell. Timetables therefore match what buses actually do.

import type { RoadGraph } from './world/graph.ts';
import type { TrafficProvider } from './world/traffic.ts';
import type { Pattern } from './network.ts';
import { edgeSpeedFn, step } from './paths.ts';
import type { Band, DayPlan, Id, Route, Timetable, Trip } from './types.ts';
import { TripState } from './types.ts';
import { DAY, MODEL } from './content.ts';
import { minutesLabel } from './time.ts';

/** Average dwell assumed at each intermediate stop for scheduling, seconds. */
export const SCHEDULE_DWELL = 22;
/** Service-day minute range: 03:00 → 03:00 next day. */
export const SERVICE_MIN = 180;
export const SERVICE_MAX = 1620;

export function defaultTimetable(): Timetable {
  return {
    weekday: {
      bands: [
        { from: 360, to: 420, headway: 15 },
        { from: 420, to: 600, headway: 10 },
        { from: 600, to: 960, headway: 15 },
        { from: 960, to: 1170, headway: 10 },
        { from: 1170, to: 1380, headway: 20 },
      ],
    },
    weekend: { bands: [{ from: 420, to: 1380, headway: 20 }] },
    layover: 4,
  };
}

/** A simple all-day timetable at one frequency. */
export function flatTimetable(headway: number, from = 360, to = 1380, layover = 4): Timetable {
  return { weekday: { bands: [{ from, to, headway }] }, weekend: { bands: [{ from: Math.max(from, 420), to, headway: Math.round(headway * 1.5) }] }, layover };
}

/** Sort, clamp and merge bands so they never overlap. */
export function normaliseBands(bands: Band[]): Band[] {
  const out = bands
    .map((b) => ({ from: clamp(Math.round(b.from), SERVICE_MIN, SERVICE_MAX), to: clamp(Math.round(b.to), SERVICE_MIN, SERVICE_MAX), headway: clamp(Math.round(b.headway), 2, 120) }))
    .filter((b) => b.to - b.from >= 5)
    .sort((a, b) => a.from - b.from);
  for (let i = 1; i < out.length; i++) if (out[i].from < out[i - 1].to) out[i].from = out[i - 1].to;
  return out.filter((b) => b.to - b.from >= 5);
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Departure minutes (since 00:00 of the service day) for a day plan. */
export function departures(plan: DayPlan): number[] {
  const out: number[] = [];
  for (const b of plan.bands) for (let m = b.from; m < b.to; m += b.headway) out.push(m);
  return out;
}

export function bandAt(plan: DayPlan, minute: number): Band | null {
  for (const b of plan.bands) if (minute >= b.from && minute < b.to) return b;
  return null;
}

// ───────────────────────────────────────────── run times

export interface RunProfile {
  /** [weekend?1:0][hour] → cumulative seconds at each stop of the pattern */
  table: Float32Array[][];
  /** total seconds by hour, weekday/weekend */
  total: number[][];
}

/** Drive a ghost bus along the pattern at a given time to measure its scheduled run time. */
export function ghostRun(g: RoadGraph, p: Pattern, traffic: TrafficProvider, t: number, modelId = 'city12'): Float32Array {
  const m = MODEL[modelId];
  const kin = { accel: m.accel, decel: 1.3, speed: m.speed };
  const speedOn = edgeSpeedFn(g, p.path, (de) => traffic.speedFactor(traffic.typical(de, t)), kin);
  const out = new Float32Array(p.stops.length);
  let s = 0, v = 0, time = 0, seg = 0;
  for (let i = 1; i < p.stops.length; i++) {
    const target = p.stopS[i];
    let guard = 0;
    while (s < target - 0.01 && guard++ < 20000) {
      const r = step(p.path, s, v, 1, target, kin, speedOn, seg);
      s = r.s;
      v = r.v;
      seg = r.seg;
      time += 1;
      if (r.arrived) break;
    }
    out[i] = time;
    if (i < p.stops.length - 1) time += SCHEDULE_DWELL;
    v = 0;
  }
  return out;
}

export function buildRunProfile(g: RoadGraph, p: Pattern, traffic: TrafficProvider, weekdayDay: number, weekendDay: number): RunProfile {
  const table: Float32Array[][] = [[], []];
  const total: number[][] = [[], []];
  for (let w = 0; w < 2; w++) {
    const base = (w ? weekendDay : weekdayDay) * DAY;
    for (let h = 0; h < 24; h++) {
      const arr = p.valid ? ghostRun(g, p, traffic, base + h * 3600 + 1800) : new Float32Array(p.stops.length);
      table[w].push(arr);
      total[w].push(arr[arr.length - 1] ?? 0);
    }
  }
  return { table, total };
}

/** Scheduled cumulative seconds per stop for a departure at minute-of-day `m`. */
export function scheduleAt(prof: RunProfile, weekend: boolean, m: number): Float32Array {
  const h = Math.floor(((m % 1440) + 1440) % 1440 / 60);
  return prof.table[weekend ? 1 : 0][h];
}

// ───────────────────────────────────────────── trips

/** Trips for one service day of a route (all patterns), departures after `after`. */
export function generateTrips(route: Route, patterns: Pattern[], sd: number, weekend: boolean, nextId: () => number, after = -Infinity): Trip[] {
  const plan = weekend ? route.timetable.weekend : route.timetable.weekday;
  const deps = departures(plan);
  const trips: Trip[] = [];
  for (const p of patterns) {
    if (!p.valid) continue;
    for (const m of deps) {
      const dep = sd * DAY + m * 60;
      if (dep <= after) continue;
      trips.push({ id: nextId(), route: route.id, pat: p.index, dep, veh: null, state: TripState.Planned });
    }
  }
  return trips.sort((a, b) => a.dep - b.dep || a.pat - b.pat);
}

// ───────────────────────────────────────────── requirements

export interface Requirement {
  /** peak number of buses needed to run the timetable */
  peak: number;
  /** when the peak occurs */
  peakLabel: string;
  /** per band: buses needed and round-trip (cycle) minutes */
  bands: { band: Band; need: number; cycle: number }[];
}

/** Buses needed = round trip including layovers ÷ headway, rounded up, for each band. */
export function requirement(route: Route, profiles: RunProfile[], weekend: boolean): Requirement {
  const plan = weekend ? route.timetable.weekend : route.timetable.weekday;
  const bands: Requirement['bands'] = [];
  let peak = 0, peakLabel = '';
  for (const b of plan.bands) {
    // worst hour inside the band
    let cycle = 0;
    for (let m = b.from; m < b.to; m += 30) {
      const h = Math.floor((m % 1440) / 60);
      let c = 0;
      for (const prof of profiles) c += prof.total[weekend ? 1 : 0][h] / 60 + route.timetable.layover;
      cycle = Math.max(cycle, c);
    }
    const need = profiles.length ? Math.ceil(cycle / b.headway - 1e-6) : 0;
    bands.push({ band: b, need, cycle });
    if (need > peak) {
      peak = need;
      peakLabel = `${minutesLabel(b.from)}–${minutesLabel(b.to)}`;
    }
  }
  return { peak, peakLabel, bands };
}

/** Headway that the given number of buses can sustain for the line's slowest hour. */
export function sustainableHeadway(profiles: RunProfile[], layover: number, buses: number, weekend = false): number {
  if (!buses || !profiles.length) return 0;
  let cycle = 0;
  for (let h = 6; h < 23; h++) {
    let c = 0;
    for (const prof of profiles) c += prof.total[weekend ? 1 : 0][h] / 60 + layover;
    cycle = Math.max(cycle, c);
  }
  return Math.ceil(cycle / buses);
}

export function describeTimetable(tt: Timetable, weekend: boolean): string {
  const plan = weekend ? tt.weekend : tt.weekday;
  if (!plan.bands.length) return 'No service';
  const first = plan.bands[0].from, last = plan.bands[plan.bands.length - 1].to;
  const hs = plan.bands.map((b) => b.headway);
  const lo = Math.min(...hs), hi = Math.max(...hs);
  return `${minutesLabel(first)}–${minutesLabel(last)}, every ${lo === hi ? lo : `${lo}–${hi}`} min`;
}

export type TripId = number;
export type { Id };
