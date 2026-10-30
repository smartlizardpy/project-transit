// Route diagnostics: structured, measured problems with a line, their causes and fixes.
//
// A Diagnostic says what is wrong (kind, severity), where (route, pattern, leg, stops, path span),
// how much (measurements taken from the routing graph, never estimated), why (a cause found by
// counterfactual routing on the same graph the buses use) and what could be done about it.
//
// Pattern-level diagnostics (detours, contraflow, missing connections) are built by
// buildPatterns() in network.ts; line-level ones (enough buses for the timetable) by
// lineDiagnostics(). Fix plans are evaluated by routing the changed line with buildPatterns, so a
// suggestion is only offered when the road network really has something better.
//
// Extension point: to add a kind (overlap, coverage gap, schedule conflict, crowding…) add it to
// DiagnosticKind, build it in patternDiagnostics() or lineDiagnostics(), and give it a renderer in
// src/ui/RouteCheck.tsx. Everything else (lists, clicks, the map overlay) works from the generic
// fields.

import { CLASS_LABELS, EDGE_BRIDGE, EDGE_ONEWAY, EDGE_TUNNEL, RoadClass, distanceM, head, isContraflow, route, turnAngle, type LngLat, type RoadGraph } from './world/graph.ts';
import type { Region } from './world/region.ts';
import type { Geo } from './world/geo.ts';
import type { Path } from './paths.ts';
import type { GameState, Id, Route, RouteKind, Stop } from './types.ts';
import type { Game } from './engine.ts';
import { STOP_RULES, ECON } from './content.ts';
import { buildPatterns, checkStop, type Pattern } from './network.ts';
import { stopSpots } from './spots.ts';

// ───────────────────────────────────────────── types

export type DiagnosticKind = 'detour' | 'contraflow' | 'no-connection' | 'insufficient-buses';
export type Severity = 'info' | 'warn' | 'bad';

export type CauseKind =
  /** one-way restrictions force the detour (the route ignoring them is much shorter) */
  | 'oneway'
  /** the bus may not turn round at an intermediate stop and the next stop is behind it */
  | 'no-uturn'
  /** the stop's halt on the other carriageway of a divided road gives a much shorter leg */
  | 'wrong-side'
  /** a much shorter legal path exists; the router prefers faster main roads */
  | 'route-choice'
  /** the leg is forced along waypoints set by the player */
  | 'waypoints'
  /** no short link even ignoring one-way rules, and road ends nearly meet: possibly missing in the map data */
  | 'data-gap'
  /** no short link even ignoring one-way rules: water, rail, a motorway or a park in between */
  | 'geography'
  /** the path already drives against a one-way street (no legal way in the map data) */
  | 'contraflow'
  /** no road path at all */
  | 'unreachable'
  /** not a routing problem */
  | 'none';

export type FixKind = 'move-stop' | 'waypoint' | 'return-route' | 'other-stop' | 'remove-stop' | 'timetable' | 'assign-buses';

/** A one-way street on the counterfactual path that the bus may not drive along. */
export interface BlockingStreet {
  name: string;
  /** coordinates in the permitted direction of travel */
  coords: LngLat[];
  /** compass direction traffic may go, e.g. "north-east" */
  allowed: string;
  metres: number;
}

export interface LegCause {
  kind: CauseKind;
  /** shortest legal distance with the same halts and arrival direction (metres) */
  legalM: number | null;
  /** legal, but free to leave the first stop in either direction */
  turnFreeM: number | null;
  /** legal, from the stop's other halt on a divided road */
  otherHaltM: number | null;
  /** ignoring one-way rules, same arrival direction */
  onewayFreeM: number | null;
  /** ignoring one-way rules and the arrival direction */
  unrestrictedM: number | null;
  /** one-way streets that block the short way */
  blocking: BlockingStreet[];
  /** the shortest path the cause refers to (node ids), e.g. ignoring one-way rules */
  counterfactual: number[] | null;
  /** dead-end road nodes near the direct line (possible missing links) */
  gaps: LngLat[];
  /** what lies between the stops when no road link exists */
  barrier: string | null;
  /** route-choice: hairpin turns and metres of minor streets on the shorter legal way */
  sharpTurns: number;
  minorM: number;
}

export interface Measure {
  /** straight line between the two stops (visual reference only, not drivable) */
  directM: number;
  /** distance the bus drives along the current path */
  roadM: number;
  extraM: number;
  ratio: number;
}

export interface Diagnostic {
  /** stable within a pattern build, e.g. "detour:0:3" */
  id: string;
  kind: DiagnosticKind;
  severity: Severity;
  route: Id;
  /** pattern index (0 outbound / loop, 1 return), null for line-level diagnostics */
  pat: number | null;
  /** leg index: from stop `leg` to stop `leg + 1` of the pattern */
  leg: number | null;
  stops: Id[];
  /** node-index range of the leg inside pattern.path */
  span: [number, number] | null;
  measure: Measure | null;
  cause: LegCause | null;
  /** short title for lists */
  title: string;
  /** the one-line text (identical to the legacy warning or problem string) */
  text: string;
  explanation: string;
  fixes: FixKind[];
}

// ───────────────────────────────────────────── counterfactual shortest paths (metres)

class Work {
  dist: Float64Array;
  prev: Int32Array;
  stamp: Int32Array;
  cur = 0;
  hk: Float64Array;
  hv: Int32Array;
  size = 0;
  cap: number;
  constructor(cap: number) {
    this.cap = cap;
    this.dist = new Float64Array(cap);
    this.prev = new Int32Array(cap);
    this.stamp = new Int32Array(cap);
    this.hk = new Float64Array(1024);
    this.hv = new Int32Array(1024);
  }
  reset() {
    this.cur++;
    this.size = 0;
  }
  get(i: number) {
    return this.stamp[i] === this.cur ? this.dist[i] : Infinity;
  }
  set(i: number, d: number, p: number) {
    this.stamp[i] = this.cur;
    this.dist[i] = d;
    this.prev[i] = p;
  }
  push(k: number, v: number) {
    if (this.size >= this.hk.length) {
      const nk = new Float64Array(this.hk.length * 2), nv = new Int32Array(this.hv.length * 2);
      nk.set(this.hk);
      nv.set(this.hv);
      this.hk = nk;
      this.hv = nv;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.hk[p] <= k) break;
      this.hk[i] = this.hk[p];
      this.hv[i] = this.hv[p];
      i = p;
    }
    this.hk[i] = k;
    this.hv[i] = v;
  }
  /** key of the last popped entry */
  topK = 0;
  pop(): number {
    const v = this.hv[0];
    this.topK = this.hk[0];
    const n = --this.size;
    if (n > 0) {
      const lk = this.hk[n], lv = this.hv[n];
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && this.hk[c + 1] < this.hk[c]) c++;
        if (this.hk[c] >= lk) break;
        this.hk[i] = this.hk[c];
        this.hv[i] = this.hv[c];
        i = c;
      }
      this.hk[i] = lk;
      this.hv[i] = lv;
    }
    return v;
  }
}
const works = new WeakMap<RoadGraph, Work>();

export interface ShortestOptions {
  /** directed edge the bus arrives on: it may not turn straight back along it */
  prevEdge?: number;
  /** drive along one-way streets in either direction (counterfactual only) */
  ignoreOneway?: boolean;
  /** give up beyond this distance */
  maxM?: number;
}

export interface ShortestPath {
  nodes: number[];
  dedges: number[];
  metres: number;
}

const degree = (g: RoadGraph, v: number) => g.adjStart[v + 1] - g.adjStart[v];

/**
 * Shortest path by distance over directed edges from any source to any target. U-turns on the
 * same street are only allowed at dead ends, as for the buses. Used for counterfactual questions
 * ("how long would this leg be if…"), never to route buses.
 */
export function shortestPath(g: RoadGraph, sources: number[], targets: number[], o: ShortestOptions = {}): ShortestPath | null {
  if (!sources.length || !targets.length) return null;
  let w = works.get(g);
  if (!w || w.cap < g.m * 2) works.set(g, (w = new Work(g.m * 2)));
  w.reset();
  const goal = new Set(targets);
  for (const s of sources) if (goal.has(s)) return { nodes: [s], dedges: [], metres: 0 };
  const maxM = o.maxM ?? Infinity;
  const ok = (de: number) => o.ignoreOneway || !isContraflow(g, de);
  for (const s of sources) {
    for (let k = g.adjStart[s]; k < g.adjStart[s + 1]; k++) {
      const e = g.adjEdge[k];
      const de = g.ea[e] === s ? e * 2 : e * 2 + 1;
      if (!ok(de)) continue;
      if (o.prevEdge !== undefined && o.prevEdge >= 0 && sources.length === 1 && (o.prevEdge >> 1) === e && degree(g, s) > 1) continue;
      const d = g.len[e];
      if (d < w.get(de)) {
        w.set(de, d, -1);
        w.push(d, de);
      }
    }
  }
  let found = -1;
  while (w.size) {
    const de = w.pop();
    const d = w.get(de);
    if (w.topK > d + 1e-6) continue; // stale heap entry
    if (d > maxM) break;
    const v = head(g, de);
    if (goal.has(v)) {
      found = de;
      break;
    }
    for (let k = g.adjStart[v]; k < g.adjStart[v + 1]; k++) {
      const e = g.adjEdge[k];
      if (e === de >> 1 && degree(g, v) > 1) continue;
      const out = g.ea[e] === v ? e * 2 : e * 2 + 1;
      if (!ok(out)) continue;
      const nd = d + g.len[e];
      if (nd < w.get(out) && nd <= maxM) {
        w.set(out, nd, de);
        w.push(nd, out);
      }
    }
  }
  if (found < 0) return null;
  const dedges: number[] = [];
  for (let de = found; de !== -1; de = w.prev[de]) dedges.push(de);
  dedges.reverse();
  const first = dedges[0];
  const nodes = [(first & 1) === 0 ? g.ea[first >> 1] : g.eb[first >> 1]];
  for (const de of dedges) nodes.push(head(g, de));
  return { nodes, dedges, metres: w.get(found) };
}

// ───────────────────────────────────────────── helpers

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export function compass(dx: number, dy: number): string {
  const a = (Math.atan2(dx, dy) * 180) / Math.PI;
  return COMPASS[((Math.round(a / 45) % 8) + 8) % 8];
}

export function fmtM(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

const nodeLL = (g: RoadGraph, v: number): LngLat => [g.lng[v], g.lat[v]];

/** Group consecutive contraflow edges of a path into named streets, given in the permitted direction. */
function blockingStreets(g: RoadGraph, geo: Geo, dedges: number[]): BlockingStreet[] {
  const runs: number[][] = [];
  let cur: number[] | null = null;
  for (const de of dedges) {
    if (isContraflow(g, de)) {
      if (!cur) runs.push((cur = []));
      cur.push(de);
    } else cur = null;
  }
  const out: BlockingStreet[] = [];
  for (const run of runs) {
    // permitted direction is the reverse of the counterfactual traversal
    const nodes = [head(g, run[run.length - 1])];
    for (let k = run.length - 1; k >= 0; k--) nodes.push((run[k] & 1) === 0 ? g.ea[run[k] >> 1] : g.eb[run[k] >> 1]);
    // nodes now: end of traversal … start of traversal = permitted a → b order
    const coords = nodes.map((v) => nodeLL(g, v));
    let metres = 0;
    for (const de of run) metres += g.len[de >> 1];
    const a = nodes[0], b = nodes[nodes.length - 1];
    const mid = coords[Math.floor(coords.length / 2)];
    const name = geo.streetNear(mid, 30) ?? CLASS_LABELS[g.cls[run[0] >> 1]] ?? 'a one-way street';
    const prev = out.find((s) => s.name === name);
    if (prev && distanceM(prev.coords[prev.coords.length - 1], coords[0]) < 40) {
      prev.coords.push(...coords.slice(1));
      prev.metres += metres;
      continue;
    }
    out.push({ name, coords, allowed: compass(g.x[b] - g.x[a], g.y[b] - g.y[a]), metres });
  }
  return out.filter((s) => s.metres >= 8);
}

/** Direction a halt forces the bus to leave in, if every street at it is one-way out of it. */
function forcedDirection(g: RoadGraph, v: number, out: boolean): string | null {
  let dir: string | null = null;
  for (let k = g.adjStart[v]; k < g.adjStart[v + 1]; k++) {
    const e = g.adjEdge[k];
    if (!(g.flags[e] & EDGE_ONEWAY)) return null;
    const leaves = g.ea[e] === v;
    if (leaves === out) {
      const a = g.ea[e], b = g.eb[e];
      dir = compass(g.x[b] - g.x[a], g.y[b] - g.y[a]);
    }
  }
  return dir;
}

/** Dead ends close to the straight line between two points (possible missing links). */
function deadEndsNear(region: Region, a: LngLat, b: LngLat): LngLat[] {
  const g = region.graph;
  const [ax, ay] = [(a[0] - g.origin[0]) * g.kx, (a[1] - g.origin[1]) * g.ky];
  const [bx, by] = [(b[0] - g.origin[0]) * g.kx, (b[1] - g.origin[1]) * g.ky];
  const L = Math.hypot(bx - ax, by - ay) || 1;
  const corridor = Math.max(50, Math.min(120, L * 0.2));
  const idx = region.index;
  const out: { ll: LngLat; d: number }[] = [];
  const b0 = region.bounds;
  const x0 = Math.floor((Math.min(ax, bx) - corridor) / idx.cell), x1 = Math.floor((Math.max(ax, bx) + corridor) / idx.cell);
  const y0 = Math.floor((Math.min(ay, by) - corridor) / idx.cell), y1 = Math.floor((Math.max(ay, by) + corridor) / idx.cell);
  for (let cx = x0; cx <= x1; cx++)
    for (let cy = y0; cy <= y1; cy++)
      for (const v of idx.nodes.get(cx * 73856093 + cy * 19349663) ?? []) {
        if (degree(g, v) !== 1) continue;
        const e = g.adjEdge[g.adjStart[v]];
        if (g.cls[e] === RoadClass.service) continue;
        const t = Math.max(0, Math.min(1, ((g.x[v] - ax) * (bx - ax) + (g.y[v] - ay) * (by - ay)) / (L * L)));
        const d = Math.hypot(ax + t * (bx - ax) - g.x[v], ay + t * (by - ay) - g.y[v]);
        if (d > corridor || t <= 0.05 || t >= 0.95) continue;
        // tile-clipping artefacts at the edge of the mapped area are not gaps
        if (g.lng[v] < b0.w + 0.002 || g.lng[v] > b0.e - 0.002 || g.lat[v] < b0.s + 0.0015 || g.lat[v] > b0.n - 0.0015) continue;
        out.push({ ll: nodeLL(g, v), d });
      }
  return out.sort((p, q) => p.d - q.d).slice(0, 4).map((p) => p.ll);
}

/** What lies on the straight line between two points: a motorway, a bridge, or land without streets. */
function barrierBetween(region: Region, a: LngLat, b: LngLat): string | null {
  const g = region.graph, d = region.demand;
  const [ax, ay] = [(a[0] - g.origin[0]) * g.kx, (a[1] - g.origin[1]) * g.ky];
  const [bx, by] = [(b[0] - g.origin[0]) * g.kx, (b[1] - g.origin[1]) * g.ky];
  const L = Math.hypot(bx - ax, by - ay);
  // land without any streets along the line (water, rail corridors, parks, closed sites)
  let run = 0, longest = 0;
  const step = 15;
  for (let s = 0; s <= L; s += step) {
    const x = ax + ((bx - ax) * s) / (L || 1), y = ay + ((by - ay) * s) / (L || 1);
    const i = Math.floor((x - d.x0) / d.cell), j = Math.floor((y - d.y0) / d.cell);
    const roads = i >= 0 && j >= 0 && i < d.w && j < d.h ? d.roads[j * d.w + i] : 0;
    run = roads < 1 ? run + step : 0;
    longest = Math.max(longest, run);
  }
  // motorways, bridges and tunnels crossing the line without a junction
  const idx = region.index;
  let motorway = false, bridge = false;
  const cross = (px: number, py: number, qx: number, qy: number) => {
    const d1 = (qx - px) * (ay - py) - (qy - py) * (ax - px), d2 = (qx - px) * (by - py) - (qy - py) * (bx - px);
    const d3 = (bx - ax) * (py - ay) - (by - ay) * (px - ax), d4 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
    return d1 * d2 < 0 && d3 * d4 < 0;
  };
  const seen = new Set<number>();
  for (let s = 0; s <= L; s += idx.cell / 2) {
    const x = ax + ((bx - ax) * s) / (L || 1), y = ay + ((by - ay) * s) / (L || 1);
    for (const e of idx.edges.get(Math.floor(x / idx.cell) * 73856093 + Math.floor(y / idx.cell) * 19349663) ?? []) {
      if (seen.has(e)) continue;
      seen.add(e);
      const big = g.cls[e] === RoadClass.motorway, raised = (g.flags[e] & (EDGE_BRIDGE | EDGE_TUNNEL)) !== 0;
      if (!big && !raised) continue;
      if (cross(g.x[g.ea[e]], g.y[g.ea[e]], g.x[g.eb[e]], g.y[g.eb[e]])) {
        if (big) motorway = true;
        else bridge = true;
      }
    }
  }
  if (longest >= 120) return `about ${fmtM(longest)} with no streets at all (water, rail, a park or a closed site)`;
  if (motorway) return 'a motorway with no junction between the stops';
  if (bridge) return 'a bridge or tunnel that passes without a junction';
  return null;
}

// ───────────────────────────────────────────── pattern diagnostics

/** What buildPatterns knows about a routed pattern. */
export interface PatternContext {
  state: GameState;
  region: Region;
  geo: Geo;
  route: Route;
  pat: number;
  stops: Id[];
  path: Path;
  /** node index in path of each stop */
  stopIdx: number[];
  stopNodes: number[];
  /** candidate halts of each stop */
  halts: number[][];
  contraflowLegs: number[];
  /** legs with no drivable connection (index of the leg) */
  unreachable: { leg: number; text: string }[];
  /** detour legs found by the warning rule, with the warning text */
  detours: { leg: number; text: string }[];
  contraflowText: string | null;
  /** node where the previous pattern ended (the bus repositions from there), or -1 */
  prevEnd: number;
}

const much = (alt: number | null, cur: number) => alt !== null && alt < cur - Math.max(180, cur * 0.25);

/**
 * What the bus would really drive if it used the stop's other halt (a divided road): the same
 * pattern routed by buildPatterns with that halt forced, so the answer matches the router. At a
 * return terminus the drive from where the outbound trip ended counts too.
 */
function otherHalt(c: PatternContext, i: number): { metres: number; current: number; nodes: number[] } | null {
  const id = c.stops[i], s = c.state.stops[id];
  const alt = c.halts[i].find((h) => h !== c.stopNodes[i]);
  if (!s || alt === undefined) return null;
  const st = { ...c.state, stops: { ...c.state.stops, [id]: { ...s, node: alt, alt: -1 } } };
  const p = buildPatterns(st, c.region, c.geo, c.route, { diagnostics: false })[c.pat];
  if (!p?.valid || p.contraflowLegs.length) return null;
  let metres = p.path.length, current = c.path.length;
  if (c.pat > 0 && i === 0 && c.prevEnd >= 0) {
    const g = c.region.graph;
    const reach = (v: number) => (v === c.prevEnd ? 0 : route(g, c.prevEnd, v)?.metres ?? Infinity);
    metres += reach(p.stopNodes[0]);
    current += reach(c.stopNodes[0]);
  }
  return { metres, current, nodes: Array.from(p.path.nodes.subarray(p.stopIdx[i], p.stopIdx[i + 1] + 1)) };
}

/** Counterfactual routing for one leg: which rule makes it long. */
export function analyseLeg(c: PatternContext, i: number): { measure: Measure; cause: LegCause } {
  const g = c.region.graph;
  const a = c.state.stops[c.stops[i]], b = c.state.stops[c.stops[i + 1]];
  const i0 = c.stopIdx[i], i1 = c.stopIdx[i + 1];
  const roadM = c.path.cum[i1] - c.path.cum[i0];
  const directM = distanceM(a.lngLat, b.lngLat);
  const measure: Measure = { directM, roadM, extraM: Math.max(0, roadM - directM), ratio: directM > 0 ? roadM / directM : 1 };
  const from = c.stopNodes[i];
  const prevEdge = i0 > 0 ? c.path.dedges[i0 - 1] : -1;
  const targets = c.halts[i + 1];
  const bound = roadM + 60;
  const legal = shortestPath(g, [from], targets, { prevEdge, maxM: bound });
  const turnFree = prevEdge >= 0 ? shortestPath(g, [from], targets, { maxM: bound }) : legal;
  const other = otherHalt(c, i);
  const onewayFree = shortestPath(g, [from], targets, { prevEdge, ignoreOneway: true, maxM: bound });
  const unrestricted = shortestPath(g, c.halts[i], targets, { ignoreOneway: true, maxM: Math.max(bound, directM * 4 + 400) });
  const cause: LegCause = {
    kind: 'none',
    legalM: legal?.metres ?? null,
    turnFreeM: turnFree?.metres ?? null,
    otherHaltM: other ? roadM - (other.current - other.metres) : null,
    onewayFreeM: onewayFree?.metres ?? null,
    unrestrictedM: unrestricted?.metres ?? null,
    blocking: [],
    counterfactual: null,
    gaps: [],
    barrier: null,
    sharpTurns: 0,
    minorM: 0,
  };
  const legEdges = Array.from(c.path.dedges.subarray(i0, i1));
  const hasVia = (c.route.via[`${c.pat === 0 ? 'o' : 'r'}:${i}`]?.length ?? 0) > 0;
  if (legEdges.some((de) => isContraflow(g, de))) {
    cause.kind = 'contraflow';
    cause.blocking = blockingStreets(g, c.geo, legEdges);
  } else if (hasVia && much(cause.legalM, roadM)) {
    cause.kind = 'waypoints';
    cause.counterfactual = legal!.nodes;
  } else if (other && other.current - other.metres >= Math.max(180, roadM * 0.25)) {
    cause.kind = 'wrong-side';
    cause.counterfactual = other.nodes;
  } else if (much(cause.legalM, roadM)) {
    cause.kind = 'route-choice';
    cause.counterfactual = legal!.nodes;
    // why the router does not take it: hairpin turns and minor streets cost buses time
    for (let k = 1; k < legal!.dedges.length; k++) if (turnAngle(g, legal!.dedges[k - 1], legal!.dedges[k]) >= 2.4) cause.sharpTurns++;
    for (const de of legal!.dedges) if (g.cls[de >> 1] >= RoadClass.minor && g.cls[de >> 1] !== RoadClass.busway) cause.minorM += g.len[de >> 1];
  } else if (prevEdge >= 0 && much(cause.turnFreeM, roadM)) {
    cause.kind = 'no-uturn';
    cause.counterfactual = turnFree!.nodes;
  } else if (much(cause.onewayFreeM, roadM)) {
    cause.kind = 'oneway';
    cause.counterfactual = onewayFree!.nodes;
    cause.blocking = blockingStreets(g, c.geo, onewayFree!.dedges);
  } else if (much(cause.unrestrictedM, roadM)) {
    // both rules together: it needs to turn round *and* use a one-way street the wrong way
    cause.kind = 'oneway';
    cause.counterfactual = unrestricted!.nodes;
    cause.blocking = blockingStreets(g, c.geo, unrestricted!.dedges);
  } else {
    cause.gaps = deadEndsNear(c.region, a.lngLat, b.lngLat);
    cause.barrier = barrierBetween(c.region, a.lngLat, b.lngLat);
    cause.kind = cause.gaps.length && !cause.barrier ? 'data-gap' : 'geography';
    if (unrestricted) cause.counterfactual = unrestricted.nodes;
  }
  return { measure, cause };
}

function explainDetour(c: PatternContext, i: number, m: Measure, cause: LegCause): string {
  const g = c.region.graph;
  const A = c.state.stops[c.stops[i]].name, B = c.state.stops[c.stops[i + 1]].name;
  const streets = cause.blocking.slice(0, 3).map((s) => `${s.name} (one-way ${s.allowed})`);
  const list = streets.length > 1 ? `${streets.slice(0, -1).join(', ')} and ${streets[streets.length - 1]}` : streets[0] ?? '';
  const leaves = forcedDirection(g, c.stopNodes[i], true);
  const arrives = forcedDirection(g, c.stopNodes[i + 1], false);
  switch (cause.kind) {
    case 'oneway': {
      const parts = [`The short way is blocked by one-way traffic: ${list || 'one-way streets'}.`];
      if (leaves && c.halts[i].length === 1) parts.push(`${A} is on a one-way street, so buses leave it heading ${leaves}.`);
      else if (arrives && c.halts[i + 1].length === 1) parts.push(`${B} is on a one-way street that buses can only enter heading ${arrives}.`);
      parts.push(`Ignoring one-way rules the leg would be ${fmtM(cause.onewayFreeM ?? cause.unrestrictedM ?? 0)}; the shortest legal way is ${fmtM(cause.legalM ?? m.roadM)}.`);
      return parts.join(' ');
    }
    case 'no-uturn':
      return `Buses do not turn round at intermediate stops. ${B} lies behind the bus as it leaves ${A}, so it has to drive round the block. Turning round there would make the leg ${fmtM(cause.turnFreeM ?? 0)}.`;
    case 'wrong-side':
      return `${A} has a halt on each side of a divided road and buses use the one that points away from ${B}, because it is faster by main roads. Using the other side would make this direction ${fmtM(m.roadM - (cause.otherHaltM ?? m.roadM))} shorter.`;
    case 'route-choice': {
      const why = [cause.sharpTurns ? `${cause.sharpTurns} hairpin turn${cause.sharpTurns > 1 ? 's' : ''}` : '', cause.minorM >= 100 ? `${fmtM(cause.minorM)} of narrow side streets` : ''].filter(Boolean).join(' and ');
      return `A shorter legal way exists (${fmtM(cause.legalM ?? 0)}${why ? `, with ${why}` : ''}), but buses are routed along faster main roads. A waypoint on the shorter streets would force it.`;
    }
    case 'waypoints':
      return `The leg is forced along your waypoints. Without them the shortest legal way is ${fmtM(cause.legalM ?? 0)}.`;
    case 'data-gap':
      return `Even ignoring one-way rules the shortest road connection is ${fmtM(cause.unrestrictedM ?? m.roadM)}. Roads end close to the direct line (marked on the map): if a street really links them, it is missing from the OpenStreetMap data.`;
    case 'geography':
      return `Even ignoring one-way rules the shortest road connection is ${fmtM(cause.unrestrictedM ?? m.roadM)}${cause.barrier ? `: the direct line crosses ${cause.barrier}` : ''}. The route is genuinely the shortest by road.`;
    case 'contraflow':
      return `There is no legal way in the map data, so the bus drives against ${list || 'a one-way street'}. This is probably a gap in the map data (a missing turn or a mis-tagged one-way).`;
    default:
      return '';
  }
}

const CAUSE_FIXES: Record<CauseKind, FixKind[]> = {
  oneway: ['other-stop', 'move-stop', 'return-route', 'remove-stop'],
  'no-uturn': ['other-stop', 'move-stop', 'remove-stop', 'return-route'],
  'wrong-side': ['move-stop', 'other-stop'],
  'route-choice': ['waypoint', 'move-stop'],
  waypoints: ['waypoint'],
  'data-gap': ['other-stop', 'move-stop', 'remove-stop'],
  geography: ['other-stop', 'remove-stop'],
  contraflow: ['move-stop', 'other-stop', 'waypoint'],
  unreachable: ['other-stop', 'move-stop', 'remove-stop'],
  none: [],
};

export const CAUSE_LABEL: Record<CauseKind, string> = {
  oneway: 'One-way streets',
  'no-uturn': 'No turning at a stop',
  'wrong-side': 'Halt on the far side',
  'route-choice': 'Faster roads chosen',
  waypoints: 'Your waypoints',
  'data-gap': 'Possible map data gap',
  geography: 'No shorter road',
  contraflow: 'Against a one-way street',
  unreachable: 'No road connection',
  none: '',
};

/** Build the structured diagnostics of one pattern (called from buildPatterns). */
export function patternDiagnostics(c: PatternContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const base = { route: c.route.id, pat: c.pat };
  for (const u of c.unreachable) {
    out.push({
      ...base, id: `no-connection:${c.pat}:${u.leg}`, kind: 'no-connection', severity: 'bad', leg: u.leg, stops: [c.stops[u.leg], c.stops[u.leg + 1]].filter(Boolean),
      span: null, measure: null, cause: null, title: 'No drivable connection', text: u.text,
      explanation: 'The router found no road path between these stops in the map data. Pick another stop or move one of them.', fixes: CAUSE_FIXES.unreachable,
    });
  }
  for (const leg of c.contraflowLegs) {
    if (c.stopIdx[leg + 1] === undefined) continue;
    const { measure, cause } = analyseLeg(c, leg);
    out.push({
      ...base, id: `contraflow:${c.pat}:${leg}`, kind: 'contraflow', severity: 'info', leg, stops: [c.stops[leg], c.stops[leg + 1]],
      span: [c.stopIdx[leg], c.stopIdx[leg + 1]], measure, cause: { ...cause, kind: 'contraflow' },
      title: `${c.state.stops[c.stops[leg]]?.name} → ${c.state.stops[c.stops[leg + 1]]?.name}`, text: c.contraflowText ?? '',
      explanation: explainDetour(c, leg, measure, { ...cause, kind: 'contraflow' }), fixes: CAUSE_FIXES.contraflow,
    });
  }
  for (const d of c.detours) {
    if (c.contraflowLegs.includes(d.leg)) continue;
    const { measure, cause } = analyseLeg(c, d.leg);
    out.push({
      ...base, id: `detour:${c.pat}:${d.leg}`, kind: 'detour', severity: 'warn', leg: d.leg, stops: [c.stops[d.leg], c.stops[d.leg + 1]],
      span: [c.stopIdx[d.leg], c.stopIdx[d.leg + 1]], measure, cause,
      title: `${c.state.stops[c.stops[d.leg]].name} → ${c.state.stops[c.stops[d.leg + 1]].name}`, text: d.text,
      explanation: explainDetour(c, d.leg, measure, cause), fixes: CAUSE_FIXES[cause.kind],
    });
  }
  return out;
}

// ───────────────────────────────────────────── line diagnostics

/** All diagnostics of a committed line: its patterns' plus line-level checks. */
export function lineDiagnostics(game: Game, routeId: Id): Diagnostic[] {
  const r = game.state.routes[routeId];
  if (!r) return [];
  const out = (game.patterns.get(routeId) ?? []).flatMap((p) => p.diagnostics ?? []);
  const req = game.requirement(routeId);
  const assigned = r.vehicles.length;
  if (req && req.peak > assigned && !r.suspended) {
    out.push({
      id: 'insufficient-buses', kind: 'insufficient-buses', severity: 'warn', route: routeId, pat: null, leg: null, stops: [], span: null, measure: null, cause: null,
      title: 'Not enough buses for the timetable',
      text: `Line ${r.number} needs ${req.peak} bus${req.peak > 1 ? 'es' : ''} at ${req.peakLabel} for this timetable. ${assigned ? `Only ${assigned} ${assigned > 1 ? 'are' : 'is'} assigned` : 'None are assigned'}, so departures will be missed.`,
      explanation: 'Assign more buses or run a less frequent timetable.', fixes: ['timetable', 'assign-buses'],
    });
  }
  return out;
}

// ───────────────────────────────────────────── catchment

/** Residents and jobs within walking distance of any of the points (each grid cell counted once). */
export function catchmentOf(region: Region, points: LngLat[]): { residents: number; jobs: number } {
  const d = region.demand, g = region.graph;
  const R = STOP_RULES.catchmentM;
  const cells = new Set<number>();
  for (const p of points) {
    const x = (p[0] - g.origin[0]) * g.kx, y = (p[1] - g.origin[1]) * g.ky;
    const i0 = Math.max(0, Math.floor((x - R - d.x0) / d.cell)), i1 = Math.min(d.w - 1, Math.floor((x + R - d.x0) / d.cell));
    const j0 = Math.max(0, Math.floor((y - R - d.y0) / d.cell)), j1 = Math.min(d.h - 1, Math.floor((y + R - d.y0) / d.cell));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const cx = d.x0 + (i + 0.5) * d.cell, cy = d.y0 + (j + 0.5) * d.cell;
        if ((cx - x) ** 2 + (cy - y) ** 2 <= R * R) cells.add(j * d.w + i);
      }
  }
  let residents = 0, jobs = 0;
  for (const k of cells) {
    residents += d.residents[k];
    jobs += d.jobs[k];
  }
  return { residents: Math.round(residents / 50) * 50, jobs: Math.round(jobs / 50) * 50 };
}

// ───────────────────────────────────────────── fixes

/** The parts of a line a fix can change (a committed line or the draft). */
export interface LineShape {
  /** committed line being checked or edited; null for a new draft line */
  id: Id | null;
  number: string;
  colour: string;
  kind: RouteKind;
  stops: Id[];
  returnStops: Id[] | null;
  via: Record<string, LngLat[]>;
}

/** A stop at a hypothetical position (moved, or a new one built at a stop spot). */
export interface StopPlacement {
  lngLat: LngLat;
  node: number;
  alt: number;
  zone: string;
  name: string;
}

export interface FixPlan {
  id: string;
  kind: FixKind;
  title: string;
  /** the line after the fix */
  shape: LineShape;
  /** existing stops moved to new positions (this affects every line using them) */
  moves: Record<Id, StopPlacement>;
  /** new stops to build, keyed by a temporary id used in `shape` */
  builds: Record<Id, StopPlacement>;
  /** the stop the plan changes (for highlighting), and where */
  focus: { stop: Id; at: LngLat } | null;
  /** total length of all patterns after the fix (metres) */
  totalM: number;
  /** metres saved over all patterns */
  savedM: number;
}

export const NEW_STOP_PREFIX = 'new:';

function syntheticRoute(game: Game, s: LineShape): Route {
  const base = s.id ? game.state.routes[s.id] : undefined;
  return {
    ...(base ?? { id: 'preview', name: '', timetable: undefined as unknown as Route['timetable'], vehicles: [], created: 0, suspended: false }),
    id: s.id ?? 'preview', number: s.number, colour: s.colour, kind: s.kind, stops: s.stops, returnStops: s.kind === 'linear' && s.returnStops && s.returnStops.length >= 2 ? s.returnStops : null, via: s.via,
  } as Route;
}

function overrideStops(game: Game, moves: Record<Id, StopPlacement>, builds: Record<Id, StopPlacement>): Record<Id, Stop> {
  const out: Record<Id, Stop> = {};
  for (const [id, p] of Object.entries(moves)) {
    const s = game.state.stops[id];
    if (s) out[id] = { ...s, node: p.node, alt: p.alt, lngLat: p.lngLat, zone: p.zone };
  }
  for (const [id, p] of Object.entries(builds)) out[id] = { id, name: p.name, node: p.node, alt: p.alt, lngLat: p.lngLat, zone: p.zone, built: game.t };
  return out;
}

/** Route the line as it would be after a change (patterns only; cheap enough for screening). */
export function routeShape(game: Game, s: LineShape, moves: Record<Id, StopPlacement> = {}, builds: Record<Id, StopPlacement> = {}): Pattern[] {
  const extra = overrideStops(game, moves, builds);
  const st = Object.keys(extra).length ? { ...game.state, stops: { ...game.state.stops, ...extra } } : game.state;
  return s.stops.length >= 2 ? buildPatterns(st, game.region, game.geo, syntheticRoute(game, s)) : [];
}

const totalLength = (ps: Pattern[]) => ps.reduce((a, p) => a + (p.valid ? p.path.length : Infinity), 0);

/** Sequence of a pattern in a shape (pattern 1 of a linear line: custom return or outbound reversed). */
export function seqOf(s: LineShape, pat: number): Id[] {
  if (pat === 0) return s.stops;
  return s.kind === 'linear' && s.returnStops && s.returnStops.length >= 2 ? s.returnStops : [...s.stops].reverse();
}

/** Drop the waypoints of the legs touching position `j` of a direction (they belonged to the old geometry). */
function dropVia(via: Record<string, LngLat[]>, dir: 'o' | 'r', j: number, shift: number): Record<string, LngLat[]> {
  const out: Record<string, LngLat[]> = {};
  for (const [k, v] of Object.entries(via)) {
    const [d, n] = k.split(':');
    const i = Number(n);
    if (d !== dir) out[k] = v;
    else if (i === j || i === j - 1) continue;
    else out[`${d}:${i > j ? i + shift : i}`] = v;
  }
  return out;
}

/** Replace (or with `by` null, remove) a stop everywhere in the line. */
function replaceEverywhere(s: LineShape, x: Id, by: Id | null): LineShape {
  let via = s.via;
  const edit = (seq: Id[], dir: 'o' | 'r') => {
    const j = seq.indexOf(x);
    if (j < 0) return seq;
    via = dropVia(via, dir, j, by ? 0 : -1);
    return by ? seq.map((id) => (id === x ? by : id)) : seq.filter((id) => id !== x);
  };
  const stops = edit(s.stops, 'o');
  let returnStops = s.returnStops;
  if (s.kind === 'linear' && returnStops) returnStops = edit(returnStops, 'r');
  else if (s.kind === 'linear') {
    // the implicit return also loses the waypoints next to the stop
    const back = [...s.stops].reverse();
    const j = back.indexOf(x);
    if (j >= 0) via = dropVia(via, 'r', j, by ? 0 : -1);
  }
  return { ...s, stops, returnStops, via };
}

/** Change a stop in one direction only (a separate return route). */
function replaceInDirection(s: LineShape, pat: number, x: Id, by: Id | null): LineShape | null {
  if (s.kind !== 'linear') return null;
  const seq = seqOf(s, pat);
  const j = seq.indexOf(x);
  if (j < 0) return null;
  const next = by ? seq.map((id) => (id === x ? by : id)) : seq.filter((id) => id !== x);
  if (next.length < 2 || new Set(next).size !== next.length) return null;
  const dir = pat === 0 ? 'o' : 'r';
  const via = dropVia(s.via, dir, j, by ? 0 : -1);
  if (pat === 0) return { ...s, stops: next, returnStops: seqOf(s, 1).slice(), via };
  return { ...s, returnStops: next, via };
}

function placementAt(game: Game, at: LngLat, ignore?: Id): StopPlacement | null {
  const c = checkStop(game.state, game.region, game.geo, at, ignore);
  if (!c.ok) return null;
  return { lngLat: c.lngLat, node: c.node, alt: c.alt, zone: c.zone, name: c.name };
}

/** Candidate positions for a stop: stop spots and points along nearby streets, all valid placements. */
function nearbyPositions(game: Game, stop: Id, radius: number, limit: number): StopPlacement[] {
  const s = game.state.stops[stop];
  if (!s) return [];
  const g = game.region.graph;
  const [x, y] = game.geo.xy(s.lngLat);
  const seen = new Set<number>([s.node]);
  const out: { p: StopPlacement; d: number }[] = [];
  const consider = (ll: LngLat) => {
    const d = distanceM(ll, s.lngLat);
    if (d > radius || d < 25) return;
    const p = placementAt(game, ll, stop);
    if (!p || seen.has(p.node)) return;
    seen.add(p.node);
    out.push({ p, d });
  };
  for (const sp of stopSpots(game.region)) if (Math.abs(sp.lngLat[0] - s.lngLat[0]) < 0.006 && Math.abs(sp.lngLat[1] - s.lngLat[1]) < 0.005) consider(sp.lngLat);
  // points along the streets around the stop, ~40 m apart
  const idx = game.region.index;
  const r = Math.ceil(radius / idx.cell);
  const cx = Math.floor(x / idx.cell), cy = Math.floor(y / idx.cell);
  const grid = new Set<string>();
  for (let dx = -r; dx <= r; dx++)
    for (let dy = -r; dy <= r; dy++)
      for (const v of idx.nodes.get((cx + dx) * 73856093 + (cy + dy) * 19349663) ?? []) {
        const k = `${Math.floor(g.x[v] / 40)},${Math.floor(g.y[v] / 40)}`;
        if (grid.has(k)) continue;
        grid.add(k);
        consider([g.lng[v], g.lat[v]]);
      }
  return out.sort((a, b) => a.d - b.d).slice(0, limit).map((o) => o.p);
}

/** Existing stops and free stop spots that could replace a stop. */
function replacements(game: Game, stop: Id, exclude: Set<Id>, radius: number): { id: Id | null; p: StopPlacement }[] {
  const s = game.state.stops[stop];
  if (!s) return [];
  const out: { id: Id | null; p: StopPlacement; d: number }[] = [];
  for (const o of Object.values(game.state.stops)) {
    if (o.id === stop || exclude.has(o.id)) continue;
    const d = distanceM(o.lngLat, s.lngLat);
    if (d <= radius) out.push({ id: o.id, p: { lngLat: o.lngLat, node: o.node, alt: o.alt ?? -1, zone: o.zone, name: o.name }, d });
  }
  for (const sp of stopSpots(game.region)) {
    const d = distanceM(sp.lngLat, s.lngLat);
    if (d > radius || d < STOP_RULES.minSpacingM) continue;
    const p = placementAt(game, sp.lngLat);
    if (p) out.push({ id: null, p: sp.name ? { ...p, name: sp.name } : p, d });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, 14);
}

/**
 * Suggest fixes for a diagnostic by routing changed versions of the line on the road graph.
 * Only plans that genuinely shorten the line are returned, best first; an empty list means the
 * graph has nothing better nearby.
 */
export function suggestFixes(game: Game, shape: LineShape, d: Diagnostic, opts: { maxPlans?: number } = {}): FixPlan[] {
  if (d.pat === null || d.leg === null || d.stops.length < 2) return [];
  const before = routeShape(game, shape);
  const beforeM = totalLength(before);
  const extra = d.measure?.extraM ?? 300;
  const minGain = Math.max(150, extra * 0.25);
  const plans: FixPlan[] = [];
  let n = 0;
  const consider = (kind: FixKind, title: string, s: LineShape, moves: Record<Id, StopPlacement>, builds: Record<Id, StopPlacement>, focus: FixPlan['focus']) => {
    const ps = routeShape(game, s, moves, builds);
    if (!ps.length || ps.some((p) => !p.valid || p.contraflowLegs.length > (before[p.index]?.contraflowLegs.length ?? 0))) return;
    const totalM = totalLength(ps);
    if (beforeM - totalM < minGain) return;
    plans.push({ id: `${kind}:${++n}`, kind, title, shape: s, moves, builds, focus, totalM, savedM: beforeM - totalM });
  };
  const [from, to] = d.stops;
  const seq = seqOf(shape, d.pat);
  const inLine = new Set([...shape.stops, ...(shape.returnStops ?? [])]);
  const name = (id: Id) => game.state.stops[id]?.name ?? 'the stop';
  const fixes = new Set(d.fixes);
  // endpoints that may change: a terminus of a two-stop line can only be moved or replaced
  for (const x of [from, to]) {
    if (!game.state.stops[x]) continue;
    if (fixes.has('move-stop')) {
      for (const p of nearbyPositions(game, x, 260, 26)) {
        const street = game.geo.streetNear(p.lngLat, 30);
        consider('move-stop', `Move ${name(x)} ${fmtM(distanceM(p.lngLat, game.state.stops[x].lngLat))}${street ? ` to ${street}` : ''}`, shape, { [x]: p }, {}, { stop: x, at: p.lngLat });
      }
    }
    if (fixes.has('other-stop') || fixes.has('return-route')) {
      let k = 0;
      for (const c of replacements(game, x, inLine, 420)) {
        const id = c.id ?? `${NEW_STOP_PREFIX}${++k}`;
        const builds = c.id ? {} : { [id]: c.p };
        const label = c.id ? `Use ${c.p.name} instead of ${name(x)}` : `New stop ${c.p.name ? `"${c.p.name}"` : 'nearby'} instead of ${name(x)}`;
        if (fixes.has('other-stop')) consider('other-stop', label, replaceEverywhere(shape, x, id), {}, builds, { stop: id, at: c.p.lngLat });
        if (fixes.has('return-route') && shape.kind === 'linear') {
          const s = replaceInDirection(shape, d.pat, x, id);
          if (s) consider('return-route', `${d.pat === 0 ? 'Outbound' : 'Return'} only: ${c.id ? `use ${c.p.name}` : 'a new stop nearby'} instead of ${name(x)}`, s, {}, builds, { stop: id, at: c.p.lngLat });
        }
      }
      if (fixes.has('return-route') && shape.kind === 'linear') {
        const s = replaceInDirection(shape, d.pat, x, null);
        if (s) consider('return-route', `Skip ${name(x)} ${d.pat === 0 ? 'outbound' : 'on the way back'} only`, s, {}, {}, null);
      }
    }
    if (fixes.has('remove-stop')) {
      const s = replaceEverywhere(shape, x, null);
      const min = shape.kind === 'loop' ? 3 : 2;
      if (s.stops.length >= min && seq.includes(x)) consider('remove-stop', `Remove ${name(x)} from the line`, s, {}, {}, null);
    }
  }
  if (fixes.has('waypoint') && d.cause?.counterfactual && d.cause.kind !== 'oneway' && d.cause.kind !== 'geography' && d.cause.kind !== 'data-gap') {
    const g = game.region.graph;
    const nodes = d.cause.counterfactual;
    const mid = nodes[Math.floor(nodes.length / 2)];
    const key = `${d.pat === 0 ? 'o' : 'r'}:${d.leg}`;
    const at: LngLat = [g.lng[mid], g.lat[mid]];
    const street = game.geo.streetNear(at, 30);
    consider('waypoint', `Force the leg along ${street ?? 'the shorter streets'}`, { ...shape, via: { ...shape.via, [key]: [at] } }, {}, {}, null);
  }
  // best per kind first, then the rest by saving; removing a stop loses coverage, so it comes last
  const rank = (p: FixPlan) => p.savedM - (p.kind === 'remove-stop' ? 1e6 : 0);
  plans.sort((a, b) => rank(b) - rank(a));
  const best: FixPlan[] = [];
  const kinds = new Set<FixKind>();
  for (const p of plans) if (!kinds.has(p.kind)) {
    kinds.add(p.kind);
    best.push(p);
  }
  for (const p of plans) if (!best.includes(p) && best.length < (opts.maxPlans ?? 4)) best.push(p);
  return best.slice(0, opts.maxPlans ?? 4).sort((a, b) => rank(b) - rank(a));
}

// ───────────────────────────────────────────── before / after

export interface LineStats {
  /** length of each pattern (metres) */
  lengths: number[];
  totalM: number;
  /** driving time at the given hour, both directions, minutes */
  minutes: number;
  residents: number;
  jobs: number;
  stops: number;
  valid: boolean;
  warnings: number;
}

export function lineStats(game: Game, s: LineShape, moves: Record<Id, StopPlacement> = {}, builds: Record<Id, StopPlacement> = {}, t = game.t): LineStats & { patterns: Pattern[] } {
  const extra = overrideStops(game, moves, builds);
  const pv = game.previewRoute({ number: s.number, colour: s.colour, kind: s.kind, stops: s.stops, returnStops: s.kind === 'linear' ? s.returnStops : null, via: s.via }, s.id ?? undefined, Object.keys(extra).length ? { stops: extra } : {});
  const weekend = game.isWeekend(t) ? 1 : 0;
  const hour = Math.floor((t % 86400) / 3600);
  const ids = [...new Set([...s.stops, ...(s.returnStops ?? [])])];
  const pts = ids.map((id) => extra[id]?.lngLat ?? game.state.stops[id]?.lngLat).filter(Boolean) as LngLat[];
  const c = catchmentOf(game.region, pts);
  const valid = pv.patterns.length > 0 && pv.patterns.every((p) => p.valid);
  return {
    patterns: pv.patterns,
    lengths: pv.patterns.map((p) => (p.valid ? p.path.length : 0)),
    totalM: valid ? pv.patterns.reduce((a, p) => a + p.path.length, 0) : 0,
    minutes: pv.profiles.reduce((a, pr) => a + (pr.total[weekend]?.[hour] ?? 0), 0) / 60,
    residents: c.residents,
    jobs: c.jobs,
    stops: ids.length,
    valid,
    warnings: pv.patterns.reduce((a, p) => a + (p.diagnostics?.filter((x) => x.kind === 'detour' || x.kind === 'contraflow').length ?? 0), 0),
  };
}

/** Plain-language trade-offs of a plan, from the before/after numbers. */
export function tradeoffs(game: Game, plan: FixPlan, before: LineStats, after: LineStats): string[] {
  const out: string[] = [];
  const dm = after.totalM - before.totalM;
  const dt = after.minutes - before.minutes;
  if (dm < 0) out.push(`${fmtM(-dm)} shorter per round trip${dt < -0.5 ? `, about ${Math.round(-dt)} min faster` : ''}.`);
  else if (dm > 0) out.push(`${fmtM(dm)} longer per round trip.`);
  const lost = before.residents + before.jobs - (after.residents + after.jobs);
  if (lost > 50) out.push(`About ${lost.toLocaleString()} fewer residents and jobs within walking distance.`);
  else if (lost < -50) out.push(`About ${(-lost).toLocaleString()} more residents and jobs within walking distance.`);
  else out.push('Walking catchment stays about the same.');
  for (const id of Object.keys(plan.moves)) {
    const others = game.routesUsing(id).filter((r) => r.id !== plan.shape.id);
    out.push(others.length ? `Moving ${game.state.stops[id]?.name} also changes line${others.length > 1 ? 's' : ''} ${others.map((r) => r.number).join(', ')}.` : `${game.state.stops[id]?.name} is used by no other line.`);
  }
  const builds = Object.keys(plan.builds).length;
  if (builds) out.push(`Builds ${builds > 1 ? `${builds} new stops` : 'a new stop'} for ${game.money(ECON.stopCost * builds)}.`);
  if (after.warnings < before.warnings) out.push(after.warnings ? `${after.warnings} other detour warning${after.warnings > 1 ? 's' : ''} remain.` : 'No detour warnings remain.');
  else if (after.warnings > before.warnings) out.push('Creates a new detour elsewhere on the line.');
  return out;
}

// ───────────────────────────────────────────── map geometry

export interface LegGeometry {
  /** current road path of the leg */
  leg: LngLat[];
  /** straight line between the two stops (a visual reference, never a drivable suggestion) */
  direct: [LngLat, LngLat] | null;
  /** blocking one-way streets, in their permitted direction */
  blocking: LngLat[][];
  gaps: LngLat[];
  stops: { id: Id; at: LngLat; label: 'A' | 'B' }[];
  /** points the camera should frame */
  frame: LngLat[];
}

/** What the map shows for a diagnostic (pure data; drawn by src/map/diagnosticsLayer.ts). */
export function legGeometry(g: RoadGraph, state: GameState, d: Diagnostic, p: Pattern | undefined): LegGeometry {
  const A = state.stops[d.stops[0]], B = state.stops[d.stops[1]];
  const leg: LngLat[] = [];
  if (p?.valid && d.span) for (let i = d.span[0]; i <= d.span[1]; i++) leg.push(nodeLL(g, p.path.nodes[i]));
  const blocking = (d.cause?.blocking ?? []).map((b) => b.coords);
  const stops: LegGeometry['stops'] = [];
  if (A) stops.push({ id: A.id, at: A.lngLat, label: 'A' });
  if (B) stops.push({ id: B.id, at: B.lngLat, label: 'B' });
  const frame: LngLat[] = [...stops.map((s) => s.at), ...leg.filter((_, i) => i % 3 === 0), ...blocking.flat()];
  return { leg, direct: A && B ? [A.lngLat, B.lngLat] : null, blocking, gaps: d.cause?.gaps ?? [], stops, frame };
}

// ───────────────────────────────────────────── committing a fix

/** Where a fix's new line shape goes: a committed line (updateRoute) or the line editor's draft. */
export interface ShapeTarget {
  apply(s: LineShape): string | null;
  /** back to the shape before apply() */
  revert(): string | null;
  /** apply again after revert() */
  reapply(): string | null;
}

const routeDef = (s: LineShape) => ({ kind: s.kind, stops: s.stops, returnStops: s.kind === 'linear' && s.returnStops && s.returnStops.length >= 2 ? s.returnStops : null, via: s.via });
export const sameShape = (a: LineShape, b: LineShape) => JSON.stringify(routeDef(a)) === JSON.stringify(routeDef(b));

export function routeTarget(game: Game, id: Id, base: LineShape): ShapeTarget {
  let after: LineShape | null = null;
  const put = (s: LineShape) => {
    const r = game.updateRoute(id, routeDef(s));
    return r.ok ? null : r.error;
  };
  return {
    apply: (s) => {
      after = s;
      return put(s);
    },
    revert: () => put(base),
    reapply: () => (after ? put(after) : null),
  };
}

export interface AppliedFix {
  title: string;
  /** temporary ids of built stops → real stop ids */
  placed: Record<Id, Id>;
  undo(): string | null;
  redo(): string | null;
}

/**
 * Commit a plan with the game's own commands: build stops, move stops (every line using a moved
 * stop follows it), then change the line. Everything is rolled back if a step fails. Undo restores
 * the line and the stop positions; stops built for the fix stay (construction is not refunded),
 * and redo reuses them.
 */
export function applyFix(game: Game, base: LineShape, plan: FixPlan, target: ShapeTarget): AppliedFix | string {
  const placed: Record<Id, Id> = {};
  const movedFrom: Record<Id, LngLat> = {};
  const rollback = (error: string) => {
    for (const [id, from] of Object.entries(movedFrom)) game.moveStop(id, from);
    for (const id of Object.values(placed)) game.removeStop(id);
    return error;
  };
  for (const [tmp, p] of Object.entries(plan.builds)) {
    const r = game.placeStop(p.lngLat, p.name || undefined);
    if (!r.ok) return rollback(r.error);
    placed[tmp] = r.value;
  }
  for (const [id, p] of Object.entries(plan.moves)) {
    const from = game.state.stops[id]?.lngLat;
    if (!from) return rollback('That stop no longer exists.');
    const r = game.moveStop(id, p.lngLat);
    if (!r.ok) return rollback(r.error);
    movedFrom[id] = from;
  }
  const sub = (ids: Id[]) => ids.map((x) => placed[x] ?? x);
  const after: LineShape = { ...plan.shape, stops: sub(plan.shape.stops), returnStops: plan.shape.returnStops ? sub(plan.shape.returnStops) : null };
  const changed = !sameShape(base, after);
  if (changed) {
    const err = target.apply(after);
    if (err) return rollback(err);
  }
  const movedTo = Object.fromEntries(Object.entries(plan.moves).map(([id, p]) => [id, p.lngLat]));
  const moveAll = (to: Record<Id, LngLat>) => {
    for (const [id, at] of Object.entries(to)) {
      const r = game.moveStop(id, at);
      if (!r.ok) return r.error;
    }
    return null;
  };
  return {
    title: plan.title,
    placed,
    undo: () => (changed ? target.revert() : null) ?? moveAll(movedFrom),
    redo: () => moveAll(movedTo) ?? (changed ? target.reapply() : null),
  };
}
