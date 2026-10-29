// Network model (lines, stops) for the prototype. Plain data + helpers; no UI.

import baked from '../data/istanbul/lines.json';
import { DEMO_LINES } from './demoLines.ts';
import { distanceM } from './roadGraph.ts';

export interface Stop {
  id: string;
  name: string;
  lngLat: [number, number];
  lines: string[];
  /** prototype numbers */
  waiting: number;
  demand: 'low' | 'medium' | 'high';
  catchmentM: number;
}

export interface LineStop {
  stopId: string;
  distance: number; // metres along the loop
}

export interface Line {
  id: string;
  number: string;
  name: string;
  colour: string;
  stops: LineStop[];
  path: [number, number][];
  cumulative: number[];
  length: number;
  fleetSize: number;
  headwayMin: number;
  service: [string, string];
  fare: number;
  draft?: boolean;
  /** prototype performance numbers */
  perf: { profitPerDay: number; load: number; satisfaction: number; ridersPerDay: number; onTime: number; issue?: string };
}

type Baked = { id: string; stops: { name: string; lngLat: [number, number]; distance: number }[]; path: [number, number][]; length: number }[];

const PERF: Record<string, Line['perf']> = {
  L26: { profitPerDay: 38_200, load: 0.46, satisfaction: 0.82, ridersPerDay: 3140, onTime: 0.91 },
  L32: { profitPerDay: -6_400, load: 0.21, satisfaction: 0.64, ridersPerDay: 1180, onTime: 0.78, issue: 'Long journey times across Unkapanı at peak' },
  L46: { profitPerDay: 17_100, load: 0.58, satisfaction: 0.71, ridersPerDay: 2290, onTime: 0.84, issue: 'Crowded between Karaköy and Şişhane' },
};

export function cumulativeOf(path: [number, number][]): number[] {
  const c = [0];
  for (let i = 1; i < path.length; i++) c.push(c[i - 1] + distanceM(path[i - 1], path[i]));
  return c;
}

export function buildNetwork(): { lines: Line[]; stops: Map<string, Stop> } {
  const stops = new Map<string, Stop>();
  const stopIdFor = (name: string, lngLat: [number, number]) => {
    // Shared stops (e.g. Karaköy) merge when within 120 m.
    for (const s of stops.values()) if (s.name === name && distanceM(s.lngLat, lngLat) < 120) return s.id;
    const id = `S${stops.size + 1}`;
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    stops.set(id, {
      id,
      name,
      lngLat,
      lines: [],
      waiting: 6 + (h % 31),
      demand: (['low', 'medium', 'high'] as const)[h % 3],
      catchmentM: 300,
    });
    return id;
  };
  const lines: Line[] = (baked as Baked).map((b) => {
    const def = DEMO_LINES.find((d) => d.id === b.id)!;
    const ls: LineStop[] = b.stops.map((s) => {
      const id = stopIdFor(s.name, s.lngLat);
      stops.get(id)!.lines.push(b.id);
      return { stopId: id, distance: s.distance };
    });
    const cumulative = cumulativeOf(b.path);
    const length = cumulative[cumulative.length - 1];
    return {
      id: b.id,
      number: def.number,
      name: def.name,
      colour: def.colour,
      stops: ls,
      path: b.path,
      cumulative,
      length,
      fleetSize: def.vehicles,
      headwayMin: Math.round(length / 1000 / 16 * 60 / def.vehicles),
      service: ['05:30', '23:30'],
      fare: 27,
      perf: PERF[b.id],
    };
  });
  // Karaköy is the busiest interchange in the demo.
  for (const s of stops.values()) if (s.lines.length > 1) { s.demand = 'high'; s.waiting += 18; }
  return { lines, stops };
}

/** Point + tangent at distance `d` along a path (wraps for loops). */
export function sampleAlong(path: [number, number][], cum: number[], d: number): { p: [number, number]; i: number } {
  const L = cum[cum.length - 1];
  d = ((d % L) + L) % L;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / seg;
  const a = path[lo], b = path[hi];
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], i: lo };
}
