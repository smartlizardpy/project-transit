// Transport network: stops, depots and line patterns routed over the road graph.

import { STOP_CLASSES, EDGE_BRIDGE, EDGE_ONEWAY, EDGE_TUNNEL, nearestEdge, nearestNode, routeWithFallback, distanceM, type LngLat, type RoadGraph } from './world/graph.ts';
import type { SpatialIndex } from './world/graph.ts';
import type { Region } from './world/region.ts';
import type { Geo } from './world/geo.ts';
import { buildPath, type Path } from './paths.ts';
import type { GameState, Id, Route } from './types.ts';
import { STOP_RULES } from './content.ts';

// ───────────────────────────────────────────── placement

export interface PlacementCheck {
  ok: boolean;
  reason?: string;
  node: number;
  lngLat: LngLat;
  zone: string;
  name: string;
  /** an existing stop within the spacing rule */
  clash?: Id;
  /** road the stop sits on */
  road?: string;
  /** opposite-carriageway halt on a divided road, or -1 */
  alt: number;
}

const CLASS_REASON: Record<number, string> = {
  0: 'Buses cannot stop on a motorway.',
  6: 'Service roads and car parks cannot take a bus stop.',
};

/** Validate a stop at a clicked position; returns the snapped road position and a suggested name. */
export function checkStop(state: GameState, region: Region, geo: Geo, at: LngLat, ignore?: Id): PlacementCheck {
  const g = region.graph;
  const [x, y] = geo.xy(at);
  const base = { ok: false, node: -1, lngLat: at, zone: '', name: '', alt: -1 };
  if (!geo.inBounds(at, 80)) return { ...base, reason: 'This spot is outside the mapped game area.' };
  const any = nearestEdge(g, region.index, x, y, STOP_RULES.snapM);
  if (!any) return { ...base, reason: 'Stops must be placed on a street. There is no drivable road here.' };
  const hit = nearestEdge(g, region.index, x, y, STOP_RULES.snapM, (e) => STOP_CLASSES.has(g.cls[e]) && !(g.flags[e] & (EDGE_BRIDGE | EDGE_TUNNEL)));
  if (!hit) {
    const e = any.edge;
    if (g.flags[e] & EDGE_BRIDGE) return { ...base, reason: 'Stops cannot be placed on a bridge.' };
    if (g.flags[e] & EDGE_TUNNEL) return { ...base, reason: 'Stops cannot be placed in a tunnel.' };
    return { ...base, reason: CLASS_REASON[g.cls[e]] ?? 'Buses cannot stop on this road.' };
  }
  // the nearer vertex of the snapped edge (edges are at most ~32 m long)
  const a = g.ea[hit.edge], b = g.eb[hit.edge];
  const node = hit.t < 0.5 ? a : b;
  const lngLat: LngLat = [g.lng[node], g.lat[node]];
  const zone = geo.zoneAt(lngLat);
  const alt = pairedHalt(g, region.index, node, hit.edge);
  const res: PlacementCheck = { ok: true, node, lngLat, zone: zone.id, name: suggestStopName(state, geo, lngLat), road: geo.streetNear(lngLat) ?? undefined, alt };
  if (!state.territory.owned.includes(zone.id)) return { ...res, ok: false, reason: `${zone.name} is outside your licensed area. Buses may drive through, but you need a licence to open stops there.` };
  for (const s of Object.values(state.stops)) {
    if (s.id === ignore) continue;
    const d = distanceM(s.lngLat, lngLat);
    if (d < STOP_RULES.minSpacingM) return { ...res, ok: false, clash: s.id, reason: `Too close to ${s.name} (${Math.round(d)} m). Stops need at least ${STOP_RULES.minSpacingM} m between them.` };
  }
  return res;
}

/**
 * On a divided road (two one-way carriageways) a stop needs a halt on each side. Find the
 * nearest point on an antiparallel one-way carriageway within 45 m.
 */
export function pairedHalt(g: RoadGraph, idx: SpatialIndex, node: number, edge: number): number {
  if (!(g.flags[edge] & EDGE_ONEWAY)) return -1;
  const dx = g.x[g.eb[edge]] - g.x[g.ea[edge]], dy = g.y[g.eb[edge]] - g.y[g.ea[edge]];
  const L = Math.hypot(dx, dy) || 1;
  const hit = nearestEdge(g, idx, g.x[node], g.y[node], 45, (e) => {
    if (e === edge || !(g.flags[e] & EDGE_ONEWAY) || !STOP_CLASSES.has(g.cls[e]) || g.flags[e] & (EDGE_BRIDGE | EDGE_TUNNEL)) return false;
    if (g.ea[e] === node || g.eb[e] === node) return false;
    const ex = g.x[g.eb[e]] - g.x[g.ea[e]], ey = g.y[g.eb[e]] - g.y[g.ea[e]];
    return (dx * ex + dy * ey) / (L * (Math.hypot(ex, ey) || 1)) < -0.6;
  });
  if (!hit) return -1;
  return hit.t < 0.5 ? g.ea[hit.edge] : g.eb[hit.edge];
}

/** Candidate halt nodes for a stop (its main node and the opposite carriageway, if any). */
export function stopHalts(state: GameState, id: Id): number[] {
  const s = state.stops[id];
  if (!s) return [];
  return s.alt !== undefined && s.alt >= 0 && s.alt !== s.node ? [s.node, s.alt] : [s.node];
}

export function suggestStopName(state: GameState, geo: Geo, at: LngLat): string {
  const taken = new Set(Object.values(state.stops).map((s) => s.name));
  const unique = (n: string) => {
    if (!taken.has(n)) return n;
    for (let k = 2; k < 50; k++) if (!taken.has(`${n} ${k}`)) return `${n} ${k}`;
    return n;
  };
  const osm = geo.osmStopNear(at, 70);
  if (osm) return unique(osm);
  const poi = geo.poisNear(at, 110).find((q) => q.p.weight >= 100);
  if (poi) return unique(poi.p.name);
  const street = geo.streetNear(at, 45);
  if (street) return unique(street);
  return unique(geo.zoneAt(at).name);
}

export interface DepotCheck {
  ok: boolean;
  reason?: string;
  node: number;
  lngLat: LngLat;
  zone: string;
}

export function checkDepot(state: GameState, region: Region, geo: Geo, at: LngLat): DepotCheck {
  const g = region.graph;
  const [x, y] = geo.xy(at);
  const base = { ok: false, node: -1, lngLat: at, zone: '' };
  if (!geo.inBounds(at, 120)) return { ...base, reason: 'This spot is outside the mapped game area.' };
  const hit = nearestEdge(g, region.index, x, y, 60, (e) => g.cls[e] !== 0 && !(g.flags[e] & (EDGE_BRIDGE | EDGE_TUNNEL)));
  if (!hit) return { ...base, reason: 'A depot needs road access. Pick a spot next to a street.' };
  const node = hit.t < 0.5 ? g.ea[hit.edge] : g.eb[hit.edge];
  const lngLat: LngLat = [g.lng[node], g.lat[node]];
  const zone = geo.zoneAt(lngLat);
  if (!state.territory.owned.includes(zone.id)) return { ...base, node, lngLat, zone: zone.id, reason: `${zone.name} is outside your licensed area.` };
  for (const d of Object.values(state.depots))
    if (distanceM(d.lngLat, lngLat) < 150) return { ...base, node, lngLat, zone: zone.id, reason: `Too close to ${d.name}.` };
  return { ok: true, node, lngLat, zone: zone.id };
}

// ───────────────────────────────────────────── patterns

export interface Pattern {
  route: Id;
  index: number;
  /** stop ids in visiting order (a loop ends at its first stop again) */
  stops: Id[];
  path: Path;
  /** distance along the path of each stop */
  stopS: number[];
  /** road node used as the halt for each stop */
  stopNodes: number[];
  valid: boolean;
  /** blocking problems (the line cannot run) */
  problems: string[];
  /** non-blocking advice, e.g. long one-way detours between two stops */
  warnings: string[];
  /** legs that had to drive against one-way restrictions */
  contraflowLegs: number[];
}

/** Stop sequence for each pattern of a route. */
export function patternStops(r: Route): Id[][] {
  if (r.stops.length < 2) return [];
  if (r.kind === 'loop') return [[...r.stops, r.stops[0]]];
  const back = r.returnStops && r.returnStops.length >= 2 ? r.returnStops : [...r.stops].reverse();
  return [r.stops, back];
}

function viaNodes(region: Region, geo: Geo, pts: LngLat[] | undefined): number[] {
  if (!pts) return [];
  const out: number[] = [];
  for (const p of pts) {
    const [x, y] = geo.xy(p);
    const v = nearestNode(region.graph, region.index, x, y, 80);
    if (v >= 0) out.push(v);
  }
  return out;
}

/**
 * Route every pattern of a line along the road network. Consecutive legs carry the arrival
 * direction forward, so buses do not make U-turns at stops, and at stops on divided roads the
 * halt on the correct side of the road is chosen for the direction of travel.
 */
export function buildPatterns(state: GameState, region: Region, geo: Geo, r: Route): Pattern[] {
  const g = region.graph;
  const seqs = patternStops(r);
  const out: Pattern[] = [];
  let prevEnd = -1, prevEdge = -1;
  seqs.forEach((stops, pi) => {
    const nodes: number[] = [];
    const dedges: number[] = [];
    const stopS: number[] = [];
    const stopNodes: number[] = [];
    const problems: string[] = [];
    const contraflowLegs: number[] = [];
    let contraflow = 0;
    let valid = stops.every((id) => stopHalts(state, id).length > 0);
    if (!valid) problems.push('A stop on this line no longer exists.');
    const name = (id: Id) => state.stops[id]?.name ?? 'a removed stop';
    /** route from `from` through the leg's waypoints to the best halt of `stop` */
    const leg = (from: number, pe: number, i: number) => {
      const key = `${pi === 0 ? 'o' : 'r'}:${i}`;
      const vias = viaNodes(region, geo, r.via[key]);
      let cur = from, curEdge = pe;
      const lnodes: number[] = [], ledges: number[] = [];
      let secs = 0, metres = 0, contra = 0;
      for (const v of vias) {
        const l = routeWithFallback(g, cur, v, { prevEdge: curEdge });
        if (!l) return null;
        lnodes.push(...l.nodes.slice(1));
        ledges.push(...l.dedges);
        secs += l.seconds;
        metres += l.metres;
        contra += l.contraflow.length;
        cur = v;
        if (l.dedges.length) curEdge = l.dedges[l.dedges.length - 1];
      }
      let best: { node: number; l: NonNullable<ReturnType<typeof routeWithFallback>> } | null = null;
      for (const h of stopHalts(state, stops[i + 1])) {
        const l = routeWithFallback(g, cur, h, { prevEdge: curEdge });
        if (!l) continue;
        const cost = l.seconds + l.contraflow.length * 600;
        if (!best || cost < best.l.seconds + best.l.contraflow.length * 600) best = { node: h, l };
      }
      if (!best) return null;
      return {
        node: best.node,
        nodes: [...lnodes, ...best.l.nodes.slice(1)],
        dedges: [...ledges, ...best.l.dedges],
        seconds: secs + best.l.seconds,
        metres: metres + best.l.metres,
        contra: contra + best.l.contraflow.length,
      };
    };
    if (valid) {
      // choose the starting halt that makes the first leg (plus any repositioning) cheapest
      let start = -1, first: ReturnType<typeof leg> = null, bestCost = Infinity;
      for (const h of stopHalts(state, stops[0])) {
        let pre = 0;
        if (pi > 0 && prevEnd >= 0 && h !== prevEnd) {
          const reposition = routeWithFallback(g, prevEnd, h, { prevEdge });
          pre = reposition ? reposition.seconds : Infinity;
        }
        const l = leg(h, pi > 0 && h === prevEnd ? prevEdge : -1, 0);
        if (!l) continue;
        const cost = pre + l.seconds + l.contra * 600;
        if (cost < bestCost) {
          bestCost = cost;
          start = h;
          first = l;
        }
      }
      if (!first) {
        valid = false;
        problems.push(`No drivable connection from ${name(stops[0])} to ${name(stops[1])}.`);
      } else {
        nodes.push(start);
        stopNodes.push(start);
        stopS.push(0);
        let cur = first;
        for (let i = 0; ; i++) {
          nodes.push(...cur.nodes);
          dedges.push(...cur.dedges);
          stopNodes.push(cur.node);
          stopS.push(-1);
          if (cur.contra) {
            contraflow += cur.contra;
            contraflowLegs.push(i);
          }
          if (i + 2 >= stops.length) break;
          const next = leg(cur.node, dedges.length ? dedges[dedges.length - 1] : -1, i + 1);
          if (!next) {
            valid = false;
            problems.push(`No drivable connection from ${name(stops[i + 1])} to ${name(stops[i + 2])}.`);
            break;
          }
          cur = next;
        }
      }
    }
    const path = buildPath(g, valid ? nodes : [stopHalts(state, stops[0])[0] ?? 0], valid ? dedges : [], contraflow);
    if (valid) {
      // distance of each stop along the path, walking forward so repeated nodes resolve in order
      let k = 0;
      for (let i = 0; i < stopNodes.length; i++) {
        if (i === 0) {
          stopS[0] = 0;
          continue;
        }
        k++;
        while (k < path.nodes.length && path.nodes[k] !== stopNodes[i]) k++;
        stopS[i] = k < path.nodes.length ? path.cum[k] : path.length;
      }
      stopS[stopS.length - 1] = path.length;
      prevEnd = stopNodes[stopNodes.length - 1];
      prevEdge = dedges.length ? dedges[dedges.length - 1] : -1;
    }
    const warnings: string[] = [];
    if (contraflowLegs.length) warnings.push('Part of this line runs against a one-way street (probably a gap in the map data).');
    if (valid) {
      for (let i = 0; i + 1 < stops.length; i++) {
        const a = state.stops[stops[i]], b = state.stops[stops[i + 1]];
        const road = stopS[i + 1] - stopS[i];
        const straight = distanceM(a.lngLat, b.lngLat);
        if (road > 700 && road > straight * 2.3)
          warnings.push(`${a.name} → ${b.name}: one-way streets force a ${(road / 1000).toFixed(1)} km detour for ${Math.round(straight)} m. Consider a different stop or a separate return route.`);
      }
    }
    out.push({ route: r.id, index: pi, stops, path, stopS, stopNodes, valid, problems, warnings, contraflowLegs });
  });
  return out;
}

/** Path between two nodes for deadhead runs (depot ↔ terminus); service roads allowed. */
export function deadheadNodes(g: RoadGraph, from: number, to: number, prevEdge = -1): { nodes: number[]; dedges: number[] } | null {
  const leg = routeWithFallback(g, from, to, { prevEdge });
  return leg ? { nodes: leg.nodes, dedges: leg.dedges } : null;
}
