// Drivable road graph built from OpenMapTiles road geometry.
// Pure TypeScript with no DOM / React dependencies: used by the bake script and the
// in-game route editor alike.

export const CLASS_INDEX: Record<string, number> = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, minor: 5, service: 6, busway: 7,
};
const CLASS_NAMES = Object.keys(CLASS_INDEX);
// Route-choice cost multipliers: buses prefer main roads.
const CLASS_COST = [1.0, 1.0, 1.0, 1.06, 1.15, 1.55, 3.2, 0.9];

export interface RoadGraph {
  /** [lng, lat] interleaved */
  nodes: number[];
  /** [a, b, classIndex, oneway(0|1 meaning a->b only)] interleaved */
  edges: number[];
}

export interface RoutedPath {
  path: [number, number][];
  nodes: number[];
  cumulative: number[];
  stopDistances: number[];
}

const M_PER_DEG = 111320;

export function distanceM(a: [number, number], b: [number, number]): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((b[0] - a[0]) * M_PER_DEG * k, (b[1] - a[1]) * M_PER_DEG);
}

export function buildGraph(segs: { coords: [number, number][]; cls: string; oneway: number }[]): RoadGraph {
  const nodes: number[] = [];
  const index = new Map<string, number>();
  const edges: number[] = [];
  const seen = new Set<string>();
  const key = (p: [number, number]) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const nodeOf = (p: [number, number]) => {
    const k = key(p);
    let id = index.get(k);
    if (id === undefined) {
      id = nodes.length / 2;
      nodes.push(p[0], p[1]);
      index.set(k, id);
    }
    return id;
  };
  for (const s of segs) {
    const cls = CLASS_INDEX[s.cls];
    for (let i = 0; i < s.coords.length - 1; i++) {
      let a = nodeOf(s.coords[i]);
      let b = nodeOf(s.coords[i + 1]);
      if (a === b) continue;
      let oneway = 0;
      if (s.oneway === 1) oneway = 1;
      else if (s.oneway === -1) { [a, b] = [b, a]; oneway = 1; }
      const ek = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(ek)) continue;
      seen.add(ek);
      edges.push(a, b, cls, oneway);
    }
  }
  const g = { nodes, edges };
  snapDangles(g, 3.5);
  return keepLargestComponent(g);
}

/** Re-connect T-junctions whose junction vertex was lost to tile simplification. */
function snapDangles(g: RoadGraph, maxM: number) {
  const n = g.nodes.length / 2;
  const degree = new Int32Array(n);
  for (let e = 0; e < g.edges.length; e += 4) { degree[g.edges[e]]++; degree[g.edges[e + 1]]++; }
  const cell = 0.0003;
  const grid = new Map<string, number[]>();
  const ek = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (let e = 0; e < g.edges.length; e += 4) {
    const a = g.edges[e], b = g.edges[e + 1];
    const x0 = Math.min(g.nodes[a * 2], g.nodes[b * 2]), x1 = Math.max(g.nodes[a * 2], g.nodes[b * 2]);
    const y0 = Math.min(g.nodes[a * 2 + 1], g.nodes[b * 2 + 1]), y1 = Math.max(g.nodes[a * 2 + 1], g.nodes[b * 2 + 1]);
    for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
      for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
        const k = `${cx},${cy}`;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(e);
      }
  }
  const kLat = Math.cos((g.nodes[1] * Math.PI) / 180);
  for (let v = 0; v < n; v++) {
    if (degree[v] !== 1) continue;
    const px = g.nodes[v * 2], py = g.nodes[v * 2 + 1];
    let best = -1, bestD = maxM, bestT = 0;
    const cands = grid.get(ek(px, py)) ?? [];
    for (const e of cands) {
      const a = g.edges[e], b = g.edges[e + 1];
      if (a === v || b === v) continue;
      const ax = g.nodes[a * 2], ay = g.nodes[a * 2 + 1], bx = g.nodes[b * 2], by = g.nodes[b * 2 + 1];
      const dx = (bx - ax) * kLat, dy = by - ay;
      const t = Math.max(0, Math.min(1, (((px - ax) * kLat) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1e-18)));
      const d = Math.hypot((ax + t * (bx - ax) - px) * kLat, ay + t * (by - ay) - py) * M_PER_DEG;
      if (d < bestD) { bestD = d; best = e; bestT = t; }
    }
    if (best < 0) continue;
    const a = g.edges[best], b = g.edges[best + 1], cls = g.edges[best + 2], ow = g.edges[best + 3];
    if (bestT < 0.02 || bestT > 0.98) {
      const target = bestT < 0.5 ? a : b;
      g.edges.push(v, target, cls, 0);
    } else {
      const mid = g.nodes.length / 2;
      g.nodes.push(g.nodes[a * 2] + bestT * (g.nodes[b * 2] - g.nodes[a * 2]), g.nodes[a * 2 + 1] + bestT * (g.nodes[b * 2 + 1] - g.nodes[a * 2 + 1]));
      g.edges[best + 1] = mid;
      g.edges.push(mid, b, cls, ow);
      g.edges.push(v, mid, cls, 0);
    }
    degree[v]++;
  }
}

function keepLargestComponent(g: RoadGraph): RoadGraph {
  const n = g.nodes.length / 2;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < g.edges.length; e += 4) { adj[g.edges[e]].push(g.edges[e + 1]); adj[g.edges[e + 1]].push(g.edges[e]); }
  const comp = new Int32Array(n).fill(-1);
  let best = -1, bestSize = 0, c = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || adj[s].length === 0) continue;
    const stack = [s];
    comp[s] = c;
    let size = 0;
    while (stack.length) {
      const v = stack.pop()!;
      size++;
      for (const w of adj[v]) if (comp[w] < 0) { comp[w] = c; stack.push(w); }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }
  const remap = new Int32Array(n).fill(-1);
  const nodes: number[] = [];
  for (let v = 0; v < n; v++) if (comp[v] === best) { remap[v] = nodes.length / 2; nodes.push(g.nodes[v * 2], g.nodes[v * 2 + 1]); }
  const edges: number[] = [];
  for (let e = 0; e < g.edges.length; e += 4) {
    const a = remap[g.edges[e]], b = remap[g.edges[e + 1]];
    if (a >= 0 && b >= 0) edges.push(a, b, g.edges[e + 2], g.edges[e + 3]);
  }
  return { nodes, edges };
}

// ------------------------------------------------------------ queries

interface Adjacency { to: Int32Array; cost: Float32Array; start: Int32Array }
const adjCache = new WeakMap<RoadGraph, { strict: Adjacency; loose: Adjacency }>();

function adjacency(g: RoadGraph, respectOneway: boolean): Adjacency {
  let c = adjCache.get(g);
  if (!c) {
    const build = (strict: boolean): Adjacency => {
      const n = g.nodes.length / 2;
      const lists: [number, number][][] = Array.from({ length: n }, () => []);
      for (let e = 0; e < g.edges.length; e += 4) {
        const a = g.edges[e], b = g.edges[e + 1], cls = g.edges[e + 2], ow = g.edges[e + 3];
        const len = distanceM([g.nodes[a * 2], g.nodes[a * 2 + 1]], [g.nodes[b * 2], g.nodes[b * 2 + 1]]);
        const cost = len * (CLASS_COST[cls] ?? 2);
        lists[a].push([b, cost]);
        // One-way rules are a strong preference, not a wall: OSM data cut at tile edges and
        // simplified junctions otherwise force absurd detours. Wrong-way travel costs 4x + 80 m.
        if (!strict || !ow) lists[b].push([a, cost]);
        else lists[b].push([a, cost * 4 + 80]);
      }
      const start = new Int32Array(n + 1);
      for (let i = 0; i < n; i++) start[i + 1] = start[i] + lists[i].length;
      const to = new Int32Array(start[n]);
      const cost = new Float32Array(start[n]);
      for (let i = 0; i < n; i++) lists[i].forEach(([t, w], k) => { to[start[i] + k] = t; cost[start[i] + k] = w; });
      return { to, cost, start };
    };
    c = { strict: build(true), loose: build(false) };
    adjCache.set(g, c);
  }
  return respectOneway ? c.strict : c.loose;
}

export function nearestNode(g: RoadGraph, at: [number, number], classes?: string[]): number {
  const allowed = classes ? new Set(classes.map((c) => CLASS_INDEX[c])) : null;
  let ok: Uint8Array | null = null;
  if (allowed) {
    ok = new Uint8Array(g.nodes.length / 2);
    for (let e = 0; e < g.edges.length; e += 4) if (allowed.has(g.edges[e + 2])) { ok[g.edges[e]] = 1; ok[g.edges[e + 1]] = 1; }
  }
  let best = -1, bestD = Infinity;
  const k = Math.cos((at[1] * Math.PI) / 180);
  for (let i = 0; i < g.nodes.length / 2; i++) {
    if (ok && !ok[i]) continue;
    const d = ((g.nodes[i * 2] - at[0]) * k) ** 2 + (g.nodes[i * 2 + 1] - at[1]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function nodeLngLat(g: RoadGraph, i: number): [number, number] {
  return [g.nodes[i * 2], g.nodes[i * 2 + 1]];
}

/** Dijkstra shortest path; returns node ids from `from` to `to` inclusive, or null. */
export function shortestPath(g: RoadGraph, from: number, to: number, respectOneway = true): number[] | null {
  if (from === to) return [from];
  const adj = adjacency(g, respectOneway);
  const n = g.nodes.length / 2;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap: [number, number][] = [];
  const push = (d: number, v: number) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  dist[from] = 0;
  push(0, from);
  while (heap.length) {
    const [d, v] = pop();
    if (d > dist[v]) continue;
    if (v === to) break;
    for (let k = adj.start[v]; k < adj.start[v + 1]; k++) {
      const w = adj.to[k];
      const nd = d + adj.cost[k];
      if (nd < dist[w]) { dist[w] = nd; prev[w] = v; push(nd, w); }
    }
  }
  if (!Number.isFinite(dist[to])) return null;
  const path: number[] = [];
  for (let v = to; v !== -1; v = prev[v]) path.push(v);
  return path.reverse();
}

/** Route through an ordered sequence of nodes (stops + via points), optionally closing the loop. */
export function routeThrough(g: RoadGraph, sequence: { node: number; stopIndex: number | null }[], loop: boolean): RoutedPath | null {
  const order = loop ? [...sequence, sequence[0]] : sequence;
  const nodes: number[] = [];
  const stopDistances: number[] = [];
  const cumulative: number[] = [];
  let total = 0;
  const pushNode = (v: number) => {
    if (nodes.length) total += distanceM(nodeLngLat(g, nodes[nodes.length - 1]), nodeLngLat(g, v));
    nodes.push(v);
    cumulative.push(total);
  };
  pushNode(order[0].node);
  if (order[0].stopIndex !== null) stopDistances[order[0].stopIndex] = 0;
  for (let i = 1; i < order.length; i++) {
    const seg = shortestPath(g, order[i - 1].node, order[i].node, true) ?? shortestPath(g, order[i - 1].node, order[i].node, false);
    if (!seg) return null;
    for (let k = 1; k < seg.length; k++) pushNode(seg[k]);
    const si = order[i].stopIndex;
    if (si !== null && !(loop && i === order.length - 1)) stopDistances[si] = total;
  }
  return { path: nodes.map((v) => nodeLngLat(g, v)), nodes, cumulative, stopDistances };
}

export function className(i: number): string {
  return CLASS_NAMES[i] ?? 'minor';
}
