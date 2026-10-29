// Path geometry and vehicle kinematics shared by buses and run-time estimates.

import { freeSpeed, head, type RoadGraph } from './world/graph.ts';

export interface Path {
  nodes: Int32Array;
  /** directed edge between vertex i and i+1 */
  dedges: Int32Array;
  x: Float64Array;
  y: Float64Array;
  cum: Float64Array;
  length: number;
  /** speed limit at each vertex from the path's curvature, m/s */
  vmax: Float32Array;
  /** number of edges driven against a one-way restriction */
  contraflow: number;
}

export function buildPath(g: RoadGraph, nodes: number[], dedges: number[], contraflow = 0): Path {
  const n = nodes.length;
  const p: Path = {
    nodes: Int32Array.from(nodes),
    dedges: Int32Array.from(dedges),
    x: new Float64Array(n),
    y: new Float64Array(n),
    cum: new Float64Array(n),
    length: 0,
    vmax: new Float32Array(n).fill(99),
    contraflow,
  };
  for (let i = 0; i < n; i++) {
    p.x[i] = g.x[nodes[i]];
    p.y[i] = g.y[nodes[i]];
    if (i > 0) p.cum[i] = p.cum[i - 1] + Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1]);
  }
  p.length = p.cum[n - 1] ?? 0;
  // curvature over a ±14 m window so gentle multi-vertex bends also slow the bus
  for (let i = 1; i < n - 1; i++) {
    const a = pointAt(p, p.cum[i] - 14), b = pointAt(p, p.cum[i]), c = pointAt(p, p.cum[i] + 14);
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1 || lv < 1) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
    let lim = 99;
    if (ang > 2.4) lim = 2.2; // hairpin / U-turn
    else if (ang > 1.25) lim = 4; // right-angle turn
    else if (ang > 0.7) lim = 6;
    else if (ang > 0.35) lim = 9;
    p.vmax[i] = lim;
  }
  return p;
}

/** Index i with cum[i] <= s < cum[i+1]; `hint` speeds up sequential lookups. */
export function segmentAt(p: Path, s: number, hint = 0): number {
  const n = p.cum.length;
  if (n < 2) return 0;
  if (s <= 0) return 0;
  if (s >= p.length) return n - 2;
  let i = Math.max(0, Math.min(n - 2, hint));
  if (p.cum[i] <= s && s < p.cum[i + 1]) return i;
  if (p.cum[i + 1] <= s && i + 2 < n && s < p.cum[i + 2]) return i + 1;
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function pointAt(p: Path, s: number, hint = 0): { x: number; y: number; i: number } {
  const n = p.cum.length;
  if (n === 0) return { x: 0, y: 0, i: 0 };
  if (n === 1) return { x: p.x[0], y: p.y[0], i: 0 };
  const sc = Math.max(0, Math.min(p.length, s));
  const i = segmentAt(p, sc, hint);
  const seg = p.cum[i + 1] - p.cum[i] || 1;
  const t = (sc - p.cum[i]) / seg;
  return { x: p.x[i] + (p.x[i + 1] - p.x[i]) * t, y: p.y[i] + (p.y[i + 1] - p.y[i]) * t, i };
}

export interface Kinematics {
  accel: number;
  decel: number;
  /** top-speed factor of the vehicle model */
  speed: number;
}

/** Speed (m/s) a bus may drive on edge index i of the path at the current traffic level. */
export type EdgeSpeed = (i: number) => number;

export function edgeSpeedFn(g: RoadGraph, p: Path, speedFactor: (de: number) => number, kin: Kinematics): EdgeSpeed {
  return (i: number) => {
    const de = p.dedges[Math.max(0, Math.min(p.dedges.length - 1, i))];
    if (de === undefined) return 8;
    return freeSpeed(g, de >> 1) * kin.speed * speedFactor(de);
  };
}

export interface StepResult {
  s: number;
  v: number;
  arrived: boolean;
  seg: number;
}

/**
 * Advance a vehicle by dt seconds: accelerate towards the road speed, brake for bends,
 * slower edges ahead and the stopping point `stopAt`.
 */
export function step(p: Path, s: number, v: number, dt: number, stopAt: number, kin: Kinematics, speedOn: EdgeSpeed, hint = 0): StepResult {
  const i = segmentAt(p, s, hint);
  let target = speedOn(i);
  const b = kin.decel;
  const look = (v * v) / (2 * b) + 30;
  const n = p.cum.length;
  for (let j = i + 1; j < n - 1 && p.cum[j] - s < look; j++) {
    const d = Math.max(0, p.cum[j] - s);
    const lim = Math.min(p.vmax[j], speedOn(j));
    const allowed = Math.sqrt(lim * lim + 2 * b * d);
    if (allowed < target) target = allowed;
  }
  const toStop = stopAt - s;
  if (toStop < look + 5) {
    const allowed = Math.sqrt(2 * b * Math.max(0, toStop - 0.4));
    if (allowed < target) target = allowed;
  }
  const dv = target - v;
  const nv = Math.max(0, dv > 0 ? v + Math.min(dv, kin.accel * dt) : v + Math.max(dv, -b * 1.6 * dt));
  let ns = s + ((v + nv) / 2) * dt;
  // creep the last metre so a bus never stalls just short of its stop
  if (nv < 0.3 && toStop > 0 && toStop < 6) ns = Math.min(stopAt, s + Math.max(0.6 * dt, ((v + nv) / 2) * dt));
  if (ns >= stopAt - 0.05) return { s: stopAt, v: 0, arrived: true, seg: segmentAt(p, stopAt, i) };
  return { s: ns, v: nv, arrived: false, seg: segmentAt(p, ns, i) };
}

/** Node at the end of the path's last edge (helper for chaining legs). */
export function lastEdge(p: Path): number {
  return p.dedges.length ? p.dedges[p.dedges.length - 1] : -1;
}

export function endNode(g: RoadGraph, p: Path): number {
  const de = lastEdge(p);
  return de >= 0 ? head(g, de) : p.nodes[0];
}
