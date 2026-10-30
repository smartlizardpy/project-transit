// Traffic. We have no licensed historical or live speed data, so this is an explicitly
// SIMULATED model: congestion is estimated from road class, nearby land-use density,
// bottlenecks (bridges, tunnels), time of day and day of week, plus day-to-day variation.
// The provider interface lets a measured data source replace it without touching the sim.

import { EDGE_BRIDGE, EDGE_TUNNEL, type RoadGraph } from './graph.ts';
import type { DemandGrid } from './region.ts';
import { DAY } from '../content.ts';
import { weekdayOf } from '../time.ts';

export interface TrafficProvider {
  /** shown in the UI legend */
  readonly label: string;
  /** true only for measured data; never true for the simulated model */
  readonly measured: boolean;
  /** Congestion 0 (free) .. 1 (jammed) on a directed edge at absolute game time t. */
  congestion(de: number, t: number): number;
  /** Typical congestion without day-to-day noise, used for timetables and planning. */
  typical(de: number, t: number): number;
  /** Speed multiplier for a congestion level. */
  speedFactor(c: number): number;
  /** City-wide typical congestion for an hour of day. */
  profile(hour: number, weekend: boolean): number;
}

const gauss = (x: number, mu: number, sigma: number) => Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));

export function weekdayProfile(h: number): number {
  const v = 0.1 + 0.62 * gauss(h, 8.2, 1.1) + 0.74 * gauss(h, 18.0, 1.45) + 0.3 * gauss(h, 13.2, 2.6) + 0.12 * gauss(h, 21, 1.5) - (h < 5.5 || h > 23.5 ? 0.06 : 0);
  return Math.max(0.03, Math.min(1, v));
}

export function weekendProfile(h: number): number {
  const v = 0.08 + 0.38 * gauss(h, 13.8, 3.2) + 0.3 * gauss(h, 19.5, 2) - (h < 7 ? 0.04 : 0);
  return Math.max(0.03, Math.min(1, v));
}

/** Busways barely congest; residential streets rarely jam. */
const CLASS_W = [1.15, 1.2, 1.1, 1.0, 0.85, 0.55, 0.3, 0.15];

function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export class SimulatedTraffic implements TrafficProvider {
  readonly label = 'Simulated typical traffic';
  readonly measured = false;
  /**
   * Live road conditions at game time t (the weather): a speed multiplier for moving buses and
   * their ETAs. Timetables keep typical traffic without it, so buses run late in bad weather
   * unless the player plans for it.
   */
  conditions: (t: number) => number = () => 1;
  /** per-edge static weight (class × density × bottleneck) */
  private weight: Float32Array;
  /** per-edge direction bias -1..1 (which way the morning peak flows) */
  private bias: Float32Array;
  /** city intensity 0.35..1.1 from overall density */
  readonly intensity: number;
  private cacheSlot = -1;
  private cache: Float32Array;

  private startWeekday: number;

  constructor(g: RoadGraph, demand: DemandGrid, startWeekday: number) {
    this.startWeekday = startWeekday;
    this.weight = new Float32Array(g.m);
    this.bias = new Float32Array(g.m);
    this.cache = new Float32Array(g.m * 2);
    // land-use activity around each edge, normalised by the region's 90th percentile
    const act = new Float32Array(demand.w * demand.h);
    for (let i = 0; i < act.length; i++) act[i] = demand.residents[i] + demand.jobs[i];
    const smooth = (cx: number, cy: number) => {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const X = cx + dx, Y = cy + dy;
          if (X >= 0 && Y >= 0 && X < demand.w && Y < demand.h) s += act[Y * demand.w + X];
        }
      return s / 9;
    };
    const sorted = Array.from(act).filter((v) => v > 0).sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] || 1;
    let total = 0, landCells = 0;
    for (let i = 0; i < act.length; i++) {
      total += act[i];
      if (demand.roads[i] > 30) landCells++;
    }
    const perKm2 = total / Math.max(0.5, (landCells * demand.cell * demand.cell) / 1e6);
    this.intensity = Math.max(0.35, Math.min(1.1, perKm2 / 22000));
    for (let e = 0; e < g.m; e++) {
      const a = g.ea[e], b = g.eb[e];
      const mx = (g.x[a] + g.x[b]) / 2, my = (g.y[a] + g.y[b]) / 2;
      const cx = Math.floor((mx - demand.x0) / demand.cell), cy = Math.floor((my - demand.y0) / demand.cell);
      const dens = Math.min(1.25, 0.35 + 0.8 * (smooth(cx, cy) / p90));
      let w = CLASS_W[g.cls[e]] * dens;
      if (g.flags[e] & EDGE_BRIDGE) w *= 1.3;
      if (g.flags[e] & EDGE_TUNNEL) w *= 1.1;
      // neighbouring edges share character in blocks
      w *= 0.85 + 0.3 * hash(Math.floor(e / 14) + 7);
      this.weight[e] = w;
      this.bias[e] = hash(Math.floor(e / 9) * 31 + 3) * 2 - 1;
    }
  }

  profile(hour: number, weekend: boolean): number {
    return weekend ? weekendProfile(hour) : weekdayProfile(hour);
  }

  speedFactor(c: number): number {
    return 1 - 0.74 * Math.pow(Math.max(0, Math.min(1, c)), 1.25);
  }

  private compute(de: number, t: number, noise: boolean): number {
    const e = de >> 1;
    const day = Math.floor(t / DAY);
    const hour = (t - day * DAY) / 3600;
    const weekend = weekdayOf(this.startWeekday, t) >= 5;
    const base = this.profile(hour, weekend) * this.intensity;
    // morning peak flows one way along a street, the evening peak the other
    const dir = (de & 1) === 0 ? 1 : -1;
    const tide = weekend ? 0 : (gauss(hour, 8.2, 1.4) - gauss(hour, 18, 1.6)) * 0.22 * this.bias[e] * dir;
    let c = base * this.weight[e] * (1 + tide);
    if (noise) {
      const blockDay = hash(Math.floor(e / 20) * 977 + day * 7919);
      const cityDay = hash(day * 104729 + 11);
      c *= 0.86 + 0.24 * blockDay + 0.12 * (cityDay - 0.5);
    }
    return Math.max(0, Math.min(1, c));
  }

  congestion(de: number, t: number): number {
    const slot = Math.floor(t / 300);
    if (slot !== this.cacheSlot) {
      this.cacheSlot = slot;
      const tt = slot * 300 + 150;
      for (let i = 0; i < this.cache.length; i++) this.cache[i] = this.compute(i, tt, true);
    }
    return this.cache[de];
  }

  typical(de: number, t: number): number {
    return this.compute(de, t, false);
  }
}
