// Route-construction logic: snapping clicks to the road graph and routing between stops.
import graphData from '../data/istanbul/graph.json';
import { distanceM, nodeLngLat, routeThrough, shortestPath, type RoadGraph } from './roadGraph.ts';

export const GRAPH = graphData as RoadGraph;

const CELL = 0.0012; // ~100 m
let grid: Map<string, number[]> | null = null;

function index() {
  if (grid) return grid;
  grid = new Map();
  const ok = new Uint8Array(GRAPH.nodes.length / 2);
  for (let e = 0; e < GRAPH.edges.length; e += 4) {
    if (GRAPH.edges[e + 2] === 6) continue; // no service roads for buses
    ok[GRAPH.edges[e]] = 1;
    ok[GRAPH.edges[e + 1]] = 1;
  }
  for (let i = 0; i < ok.length; i++) {
    if (!ok[i]) continue;
    const k = `${Math.floor(GRAPH.nodes[i * 2] / CELL)},${Math.floor(GRAPH.nodes[i * 2 + 1] / CELL)}`;
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(i);
  }
  return grid;
}

/** Nearest drivable graph node within `maxM` metres, or null. */
export function snap(lngLat: [number, number], maxM = 70): { node: number; lngLat: [number, number]; d: number } | null {
  const g = index();
  const cx = Math.floor(lngLat[0] / CELL), cy = Math.floor(lngLat[1] / CELL);
  let best = -1, bestD = maxM;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (const i of g.get(`${cx + dx},${cy + dy}`) ?? []) {
        const d = distanceM(lngLat, nodeLngLat(GRAPH, i));
        if (d < bestD) { bestD = d; best = i; }
      }
  return best < 0 ? null : { node: best, lngLat: nodeLngLat(GRAPH, best), d: bestD };
}

export function inPlayArea(lngLat: [number, number]): boolean {
  return lngLat[0] > 28.952 && lngLat[0] < 29.002 && lngLat[1] > 41.006 && lngLat[1] < 41.042;
}

export function legPath(a: number, b: number): [number, number][] | null {
  const p = shortestPath(GRAPH, a, b, true) ?? shortestPath(GRAPH, a, b, false);
  return p ? p.map((n) => nodeLngLat(GRAPH, n)) : null;
}

/** Full loop through the drafted stops (returns to the first stop). */
export function draftLoop(nodes: number[]) {
  if (nodes.length < 2) return null;
  const r = routeThrough(GRAPH, nodes.map((node, i) => ({ node, stopIndex: i })), true);
  if (!r) return null;
  const openLen = r.stopDistances[nodes.length - 1];
  return { path: r.path, stopDistances: r.stopDistances, length: r.cumulative[r.cumulative.length - 1], openLength: openLen };
}
