// Drivable road graph: building, spatial queries and routing.
// Pure TypeScript (no DOM): runs in the region worker, the main thread and Node tests.
//
// Coordinates are kept twice: lng/lat for rendering and local metres (x east, y north,
// equirectangular around the region origin) for all simulation maths.

export type LngLat = [number, number];

export const RoadClass = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, minor: 5, service: 6, busway: 7,
} as const;
export const CLASS_NAMES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'busway'] as const;
export const CLASS_LABELS = ['Motorway', 'Trunk road', 'Main road', 'Secondary road', 'Local road', 'Residential street', 'Service road', 'Bus lane'];

/** Free-flow bus speed per class, km/h. Urban buses rarely reach legal limits. */
export const FREE_KMH = [62, 52, 42, 38, 33, 26, 14, 40];
/** Route-choice preference multiplier on travel time (buses prefer main roads). */
const PREF = [1.08, 1.0, 1.0, 1.0, 1.06, 1.3, 3, 0.9];
/** Classes where a stop may be placed. */
export const STOP_CLASSES = new Set<number>([1, 2, 3, 4, 5, 7]);

export const EDGE_ONEWAY = 1; // a -> b only
export const EDGE_BRIDGE = 2;
export const EDGE_TUNNEL = 4;

export interface RoadGraph {
  origin: LngLat;
  /** metres per degree of longitude / latitude at the origin */
  kx: number;
  ky: number;
  n: number;
  lng: Float64Array;
  lat: Float64Array;
  x: Float64Array;
  y: Float64Array;
  m: number;
  ea: Int32Array;
  eb: Int32Array;
  len: Float32Array;
  cls: Uint8Array;
  flags: Uint8Array;
  /** CSR incidence lists: edges touching node v are adjEdge[adjStart[v] .. adjStart[v+1]) */
  adjStart: Int32Array;
  adjEdge: Int32Array;
}

export interface Segment {
  coords: LngLat[];
  cls: number;
  /** 1 = drawn direction only, -1 = reverse only, 0 = both */
  oneway: number;
  /** 0 ground, >0 bridge levels, <0 tunnel levels */
  level: number;
  bridge?: boolean;
  tunnel?: boolean;
}

export function projector(origin: LngLat) {
  const kx = 111320 * Math.cos((origin[1] * Math.PI) / 180);
  const ky = 110574;
  return {
    kx,
    ky,
    toXY: (lng: number, lat: number): [number, number] => [(lng - origin[0]) * kx, (lat - origin[1]) * ky],
    toLngLat: (x: number, y: number): LngLat => [origin[0] + x / kx, origin[1] + y / ky],
  };
}

export function distanceM(a: LngLat, b: LngLat): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 110574);
}

// ─────────────────────────────────────────────────────────────── building

interface Building {
  lng: number[];
  lat: number[];
  level: number[];
  ea: number[];
  eb: number[];
  cls: number[];
  flags: number[];
}

/**
 * Build a routable graph from road segments.
 *
 * Vertices merge by position *and level*, so a bridge passing over a street never becomes a
 * junction with it. Dangling bridge/tunnel ends then join the ground road at the same spot,
 * dangling ends left by tile clipping are re-attached to nearby edges on the same level, long
 * edges are split so stops can be placed anywhere along a street, and only the largest
 * connected network is kept.
 */
export function buildGraph(segs: Segment[], origin: LngLat, opts: { densifyM?: number; snapM?: number } = {}): RoadGraph {
  const densifyM = opts.densifyM ?? 32;
  const snapM = opts.snapM ?? 4;
  const P = projector(origin);
  const b: Building = { lng: [], lat: [], level: [], ea: [], eb: [], cls: [], flags: [] };
  const index = new Map<string, number>();
  const coordKey = (p: LngLat) => `${Math.round(p[0] * 2e5)},${Math.round(p[1] * 2e5)}`;
  const nodeOf = (p: LngLat, level: number) => {
    const k = `${coordKey(p)}|${level}`;
    let id = index.get(k);
    if (id === undefined) {
      id = b.lng.length;
      b.lng.push(p[0]);
      b.lat.push(p[1]);
      b.level.push(level);
      index.set(k, id);
    }
    return id;
  };
  const seen = new Set<string>();
  for (const s of segs) {
    const level = s.level | 0;
    const flagsBase = (s.bridge ? EDGE_BRIDGE : 0) | (s.tunnel ? EDGE_TUNNEL : 0);
    for (let i = 0; i < s.coords.length - 1; i++) {
      let a = nodeOf(s.coords[i], level);
      let c = nodeOf(s.coords[i + 1], level);
      if (a === c) continue;
      let flags = flagsBase;
      if (s.oneway === 1) flags |= EDGE_ONEWAY;
      else if (s.oneway === -1) {
        [a, c] = [c, a];
        flags |= EDGE_ONEWAY;
      }
      const ek = a < c ? `${a}-${c}` : `${c}-${a}`;
      if (seen.has(ek)) continue;
      seen.add(ek);
      b.ea.push(a);
      b.eb.push(c);
      b.cls.push(s.cls);
      b.flags.push(flags);
    }
  }
  joinLevelEnds(b, coordKey);
  snapDangles(b, P, snapM);
  densify(b, P, densifyM);
  return finalise(keepLargestComponent(b), origin);
}

function degrees(b: Building): Int32Array {
  const d = new Int32Array(b.lng.length);
  for (let e = 0; e < b.ea.length; e++) {
    d[b.ea[e]]++;
    d[b.eb[e]]++;
  }
  return d;
}

/** Bridge and tunnel ends that touch a road on another level at the same position connect to it. */
function joinLevelEnds(b: Building, coordKey: (p: LngLat) => string) {
  const deg = degrees(b);
  const byPos = new Map<string, number[]>();
  for (let v = 0; v < b.lng.length; v++) {
    const k = coordKey([b.lng[v], b.lat[v]]);
    const l = byPos.get(k);
    if (l) l.push(v);
    else byPos.set(k, [v]);
  }
  const remap = new Int32Array(b.lng.length);
  for (let v = 0; v < remap.length; v++) remap[v] = v;
  for (const group of byPos.values()) {
    if (group.length < 2) continue;
    const ground = group.find((v) => b.level[v] === 0) ?? group[0];
    for (const v of group) {
      if (v === ground) continue;
      // only a dangling end joins; an interior vertex of a bridge stays separate
      if (deg[v] === 1 || deg[ground] === 1) remap[v] = ground;
    }
  }
  for (let e = 0; e < b.ea.length; e++) {
    b.ea[e] = remap[b.ea[e]];
    b.eb[e] = remap[b.eb[e]];
  }
}

/** Re-connect T-junctions whose junction vertex was lost to tile clipping or simplification. */
function snapDangles(b: Building, P: ReturnType<typeof projector>, maxM: number) {
  const deg = degrees(b);
  const cell = 40;
  const xy = (v: number) => P.toXY(b.lng[v], b.lat[v]);
  const grid = new Map<string, number[]>();
  const edgeCount = b.ea.length;
  for (let e = 0; e < edgeCount; e++) {
    const [ax, ay] = xy(b.ea[e]);
    const [bx, by] = xy(b.eb[e]);
    for (let cx = Math.floor(Math.min(ax, bx) / cell); cx <= Math.floor(Math.max(ax, bx) / cell); cx++)
      for (let cy = Math.floor(Math.min(ay, by) / cell); cy <= Math.floor(Math.max(ay, by) / cell); cy++) {
        const k = `${cx},${cy}`;
        const l = grid.get(k);
        if (l) l.push(e);
        else grid.set(k, [e]);
      }
  }
  const n = b.lng.length;
  for (let v = 0; v < n; v++) {
    if (deg[v] !== 1) continue;
    const [px, py] = xy(v);
    let best = -1, bestD = maxM, bestT = 0;
    const cands = grid.get(`${Math.floor(px / cell)},${Math.floor(py / cell)}`) ?? [];
    for (const e of cands) {
      const a = b.ea[e], c = b.eb[e];
      if (a === v || c === v) continue;
      if (b.level[a] !== b.level[v] && b.level[c] !== b.level[v]) continue;
      const [ax, ay] = xy(a);
      const [cx, cy] = xy(c);
      const dx = cx - ax, dy = cy - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1e-9)));
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (d < bestD) {
        bestD = d;
        best = e;
        bestT = t;
      }
    }
    if (best < 0) continue;
    const a = b.ea[best], c = b.eb[best];
    if (bestT < 0.04 || bestT > 0.96) {
      const target = bestT < 0.5 ? a : c;
      b.ea.push(v);
      b.eb.push(target);
      b.cls.push(b.cls[best]);
      b.flags.push(b.flags[best] & ~EDGE_ONEWAY);
      deg[target]++;
    } else {
      const mid = b.lng.length;
      b.lng.push(b.lng[a] + bestT * (b.lng[c] - b.lng[a]));
      b.lat.push(b.lat[a] + bestT * (b.lat[c] - b.lat[a]));
      b.level.push(b.level[a]);
      b.eb[best] = mid;
      b.ea.push(mid);
      b.eb.push(c);
      b.cls.push(b.cls[best]);
      b.flags.push(b.flags[best]);
      b.ea.push(v);
      b.eb.push(mid);
      b.cls.push(b.cls[best]);
      b.flags.push(b.flags[best] & ~EDGE_ONEWAY);
    }
    deg[v]++;
  }
}

/** Split long edges so that stops and vehicles have a vertex every `maxM` metres. */
function densify(b: Building, P: ReturnType<typeof projector>, maxM: number) {
  const m = b.ea.length;
  for (let e = 0; e < m; e++) {
    const a = b.ea[e], c = b.eb[e];
    const [ax, ay] = P.toXY(b.lng[a], b.lat[a]);
    const [cx, cy] = P.toXY(b.lng[c], b.lat[c]);
    const L = Math.hypot(cx - ax, cy - ay);
    const parts = Math.ceil(L / maxM);
    if (parts <= 1) continue;
    let prev = a;
    for (let k = 1; k < parts; k++) {
      const t = k / parts;
      const id = b.lng.length;
      b.lng.push(b.lng[a] + t * (b.lng[c] - b.lng[a]));
      b.lat.push(b.lat[a] + t * (b.lat[c] - b.lat[a]));
      b.level.push(b.level[a]);
      if (k === 1) b.eb[e] = id;
      else {
        b.ea.push(prev);
        b.eb.push(id);
        b.cls.push(b.cls[e]);
        b.flags.push(b.flags[e]);
      }
      prev = id;
    }
    b.ea.push(prev);
    b.eb.push(c);
    b.cls.push(b.cls[e]);
    b.flags.push(b.flags[e]);
  }
}

function keepLargestComponent(b: Building): Building {
  const n = b.lng.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < b.ea.length; e++) {
    adj[b.ea[e]].push(b.eb[e]);
    adj[b.eb[e]].push(b.ea[e]);
  }
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
      for (const w of adj[v]) if (comp[w] < 0) {
        comp[w] = c;
        stack.push(w);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = c;
    }
    c++;
  }
  const remap = new Int32Array(n).fill(-1);
  const out: Building = { lng: [], lat: [], level: [], ea: [], eb: [], cls: [], flags: [] };
  for (let v = 0; v < n; v++)
    if (comp[v] === best) {
      remap[v] = out.lng.length;
      out.lng.push(b.lng[v]);
      out.lat.push(b.lat[v]);
      out.level.push(b.level[v]);
    }
  for (let e = 0; e < b.ea.length; e++) {
    const a = remap[b.ea[e]], c = remap[b.eb[e]];
    if (a < 0 || c < 0) continue;
    out.ea.push(a);
    out.eb.push(c);
    out.cls.push(b.cls[e]);
    out.flags.push(b.flags[e]);
  }
  return out;
}

function finalise(b: Building, origin: LngLat): RoadGraph {
  const P = projector(origin);
  const n = b.lng.length, m = b.ea.length;
  const g: RoadGraph = {
    origin,
    kx: P.kx,
    ky: P.ky,
    n,
    lng: new Float64Array(b.lng),
    lat: new Float64Array(b.lat),
    x: new Float64Array(n),
    y: new Float64Array(n),
    m,
    ea: new Int32Array(b.ea),
    eb: new Int32Array(b.eb),
    len: new Float32Array(m),
    cls: new Uint8Array(b.cls),
    flags: new Uint8Array(b.flags),
    adjStart: new Int32Array(n + 1),
    adjEdge: new Int32Array(m * 2),
  };
  for (let v = 0; v < n; v++) {
    const [x, y] = P.toXY(g.lng[v], g.lat[v]);
    g.x[v] = x;
    g.y[v] = y;
  }
  for (let e = 0; e < m; e++) g.len[e] = Math.max(0.1, Math.hypot(g.x[g.eb[e]] - g.x[g.ea[e]], g.y[g.eb[e]] - g.y[g.ea[e]]));
  rebuildAdjacency(g);
  return g;
}

export function rebuildAdjacency(g: RoadGraph) {
  const deg = new Int32Array(g.n);
  for (let e = 0; e < g.m; e++) {
    deg[g.ea[e]]++;
    deg[g.eb[e]]++;
  }
  g.adjStart = new Int32Array(g.n + 1);
  for (let v = 0; v < g.n; v++) g.adjStart[v + 1] = g.adjStart[v] + deg[v];
  g.adjEdge = new Int32Array(g.adjStart[g.n]);
  const fill = g.adjStart.slice(0, g.n);
  for (let e = 0; e < g.m; e++) {
    g.adjEdge[fill[g.ea[e]]++] = e;
    g.adjEdge[fill[g.eb[e]]++] = e;
  }
}

/** Revive a graph that crossed a worker boundary or came from JSON. */
export function reviveGraph(raw: RoadGraph): RoadGraph {
  return raw;
}

// ─────────────────────────────────────────────────────────────── directed edges

/** Directed edge id: 2e = a→b, 2e+1 = b→a. */
export const tail = (g: RoadGraph, de: number) => ((de & 1) === 0 ? g.ea[de >> 1] : g.eb[de >> 1]);
export const head = (g: RoadGraph, de: number) => ((de & 1) === 0 ? g.eb[de >> 1] : g.ea[de >> 1]);
export const isContraflow = (g: RoadGraph, de: number) => (de & 1) === 1 && (g.flags[de >> 1] & EDGE_ONEWAY) !== 0;

export function freeSpeed(g: RoadGraph, e: number): number {
  return FREE_KMH[g.cls[e]] / 3.6;
}

/** Turn angle in radians (0 = straight on, π = U-turn) between two consecutive directed edges. */
export function turnAngle(g: RoadGraph, deIn: number, deOut: number): number {
  const a = tail(g, deIn), b = head(g, deIn), c = head(g, deOut);
  const ux = g.x[b] - g.x[a], uy = g.y[b] - g.y[a];
  const vx = g.x[c] - g.x[b], vy = g.y[c] - g.y[b];
  const lu = Math.hypot(ux, uy) || 1, lv = Math.hypot(vx, vy) || 1;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
  return Math.acos(cos);
}

function turnPenalty(g: RoadGraph, deIn: number, deOut: number): number {
  if ((deIn >> 1) === (deOut >> 1)) {
    // U-turn on the same street: only cheap at a dead end
    const v = head(g, deIn);
    return g.adjStart[v + 1] - g.adjStart[v] <= 1 ? 25 : 240;
  }
  const a = turnAngle(g, deIn, deOut);
  if (a < 0.5) return 0;
  if (a < 1.3) return 4;
  if (a < 2.4) return 9;
  return 60;
}

// ─────────────────────────────────────────────────────────────── spatial index

export interface SpatialIndex {
  cell: number;
  nodes: Map<number, number[]>;
  edges: Map<number, number[]>;
}

const cellKey = (cx: number, cy: number) => cx * 73856093 + cy * 19349663;

export function buildIndex(g: RoadGraph, cell = 60): SpatialIndex {
  const nodes = new Map<number, number[]>();
  const edges = new Map<number, number[]>();
  for (let v = 0; v < g.n; v++) {
    const k = cellKey(Math.floor(g.x[v] / cell), Math.floor(g.y[v] / cell));
    const l = nodes.get(k);
    if (l) l.push(v);
    else nodes.set(k, [v]);
  }
  for (let e = 0; e < g.m; e++) {
    const a = g.ea[e], b = g.eb[e];
    for (let cx = Math.floor(Math.min(g.x[a], g.x[b]) / cell); cx <= Math.floor(Math.max(g.x[a], g.x[b]) / cell); cx++)
      for (let cy = Math.floor(Math.min(g.y[a], g.y[b]) / cell); cy <= Math.floor(Math.max(g.y[a], g.y[b]) / cell); cy++) {
        const k = cellKey(cx, cy);
        const l = edges.get(k);
        if (l) l.push(e);
        else edges.set(k, [e]);
      }
  }
  return { cell, nodes, edges };
}

export interface EdgeHit {
  edge: number;
  t: number;
  d: number;
  x: number;
  y: number;
}

/** Nearest edge to a local point within `maxM`, optionally filtered. */
export function nearestEdge(g: RoadGraph, idx: SpatialIndex, x: number, y: number, maxM: number, filter?: (e: number) => boolean): EdgeHit | null {
  const r = Math.ceil(maxM / idx.cell);
  const cx = Math.floor(x / idx.cell), cy = Math.floor(y / idx.cell);
  let best: EdgeHit | null = null;
  let bestD = maxM;
  const seen = new Set<number>();
  for (let dx = -r; dx <= r; dx++)
    for (let dy = -r; dy <= r; dy++)
      for (const e of idx.edges.get(cellKey(cx + dx, cy + dy)) ?? []) {
        if (seen.has(e)) continue;
        seen.add(e);
        if (filter && !filter(e)) continue;
        const a = g.ea[e], b = g.eb[e];
        const ex = g.x[b] - g.x[a], ey = g.y[b] - g.y[a];
        const t = Math.max(0, Math.min(1, ((x - g.x[a]) * ex + (y - g.y[a]) * ey) / (ex * ex + ey * ey || 1e-9)));
        const px = g.x[a] + t * ex, py = g.y[a] + t * ey;
        const d = Math.hypot(px - x, py - y);
        if (d < bestD) {
          bestD = d;
          best = { edge: e, t, d, x: px, y: py };
        }
      }
  return best;
}

/** Nearest node within `maxM`, optionally filtered. */
export function nearestNode(g: RoadGraph, idx: SpatialIndex, x: number, y: number, maxM: number, filter?: (v: number) => boolean): number {
  const r = Math.ceil(maxM / idx.cell);
  const cx = Math.floor(x / idx.cell), cy = Math.floor(y / idx.cell);
  let best = -1, bestD = maxM;
  for (let dx = -r; dx <= r; dx++)
    for (let dy = -r; dy <= r; dy++)
      for (const v of idx.nodes.get(cellKey(cx + dx, cy + dy)) ?? []) {
        if (filter && !filter(v)) continue;
        const d = Math.hypot(g.x[v] - x, g.y[v] - y);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
  return best;
}

/** True if any edge at node v has one of the given classes. */
export function nodeHasClass(g: RoadGraph, v: number, classes: Set<number>): boolean {
  for (let k = g.adjStart[v]; k < g.adjStart[v + 1]; k++) if (classes.has(g.cls[g.adjEdge[k]])) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────── routing

export interface RoutedLeg {
  /** node ids from start to end inclusive */
  nodes: number[];
  /** directed edges traversed (nodes.length - 1) */
  dedges: number[];
  /** free-flow travel time estimate, seconds (without preference weights) */
  seconds: number;
  metres: number;
  /** directed edges that run against a one-way restriction (lenient mode only) */
  contraflow: number[];
}

class Workspace {
  dist: Float64Array;
  prev: Int32Array;
  stamp: Int32Array;
  cur = 0;
  heapK: Float64Array;
  heapV: Int32Array;
  size = 0;
  constructor(public cap: number) {
    this.dist = new Float64Array(cap);
    this.prev = new Int32Array(cap);
    this.stamp = new Int32Array(cap);
    this.heapK = new Float64Array(cap * 2 + 16);
    this.heapV = new Int32Array(cap * 2 + 16);
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
    if (this.size >= this.heapK.length) {
      const nk = new Float64Array(this.heapK.length * 2), nv = new Int32Array(this.heapV.length * 2);
      nk.set(this.heapK);
      nv.set(this.heapV);
      this.heapK = nk;
      this.heapV = nv;
    }
    let i = this.size++;
    const K = this.heapK, V = this.heapV;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= k) break;
      K[i] = K[p];
      V[i] = V[p];
      i = p;
    }
    K[i] = k;
    V[i] = v;
  }
  /** pops the min; returns value, key in this.topK */
  topK = 0;
  pop(): number {
    const K = this.heapK, V = this.heapV;
    const v = V[0];
    this.topK = K[0];
    const n = --this.size;
    if (n > 0) {
      const lk = K[n], lv = V[n];
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= lk) break;
        K[i] = K[c];
        V[i] = V[c];
        i = c;
      }
      K[i] = lk;
      V[i] = lv;
    }
    return v;
  }
}

const workspaces = new WeakMap<RoadGraph, Workspace>();
function workspace(g: RoadGraph) {
  let w = workspaces.get(g);
  if (!w || w.cap < g.m * 2) {
    w = new Workspace(g.m * 2);
    workspaces.set(g, w);
  }
  return w;
}

export interface RouteOptions {
  /** directed edge the vehicle arrives on (avoids U-turns at the start node) */
  prevEdge?: number;
  /** allow travelling against one-way restrictions at a high cost */
  lenient?: boolean;
  /** custom edge filter (e.g. forbid service roads) */
  allowEdge?: (e: number) => boolean;
  /** stop searching beyond this cost (seconds) */
  maxCost?: number;
}

/**
 * Time-based A* over directed edges with turn penalties, so routes prefer main roads,
 * avoid needless U-turns and can carry the arrival direction from one leg into the next.
 */
export function route(g: RoadGraph, from: number, to: number, opts: RouteOptions = {}): RoutedLeg | null {
  if (from < 0 || to < 0) return null;
  if (from === to) return { nodes: [from], dedges: [], seconds: 0, metres: 0, contraflow: [] };
  const ws = workspace(g);
  ws.reset();
  const vmax = 62 / 3.6 / 0.9;
  const tx = g.x[to], ty = g.y[to];
  const h = (v: number) => Math.hypot(g.x[v] - tx, g.y[v] - ty) / vmax;
  const cost = (de: number) => {
    const e = de >> 1;
    let c = (g.len[e] / (FREE_KMH[g.cls[e]] / 3.6)) * PREF[g.cls[e]];
    if (isContraflow(g, de)) c = c * 8 + 90;
    return c;
  };
  const allowed = (de: number) => {
    if (opts.allowEdge && !opts.allowEdge(de >> 1)) return false;
    if (!opts.lenient && isContraflow(g, de)) return false;
    return true;
  };
  for (let k = g.adjStart[from]; k < g.adjStart[from + 1]; k++) {
    const e = g.adjEdge[k];
    const de = g.ea[e] === from ? e * 2 : e * 2 + 1;
    if (!allowed(de)) continue;
    let c = cost(de);
    if (opts.prevEdge !== undefined && opts.prevEdge >= 0) c += turnPenalty(g, opts.prevEdge, de);
    if (c < ws.get(de)) {
      ws.set(de, c, -1);
      ws.push(c + h(head(g, de)), de);
    }
  }
  let found = -1;
  const maxCost = opts.maxCost ?? Infinity;
  while (ws.size) {
    const de = ws.pop();
    const d = ws.get(de);
    if (ws.topK - h(head(g, de)) > d + 1e-6) continue;
    if (d > maxCost) break;
    const v = head(g, de);
    if (v === to) {
      found = de;
      break;
    }
    for (let k = g.adjStart[v]; k < g.adjStart[v + 1]; k++) {
      const e = g.adjEdge[k];
      const out = g.ea[e] === v ? e * 2 : e * 2 + 1;
      if (!allowed(out)) continue;
      const nd = d + cost(out) + turnPenalty(g, de, out);
      if (nd < ws.get(out)) {
        ws.set(out, nd, de);
        ws.push(nd + h(head(g, out)), out);
      }
    }
  }
  if (found < 0) return null;
  const dedges: number[] = [];
  for (let de = found; de !== -1; de = ws.prev[de]) dedges.push(de);
  dedges.reverse();
  const nodes = [from];
  let seconds = 0, metres = 0;
  const contraflow: number[] = [];
  for (const de of dedges) {
    nodes.push(head(g, de));
    const e = de >> 1;
    metres += g.len[e];
    seconds += g.len[e] / freeSpeed(g, e);
    if (isContraflow(g, de)) contraflow.push(de);
  }
  return { nodes, dedges, seconds, metres, contraflow };
}

/** Strict routing first; lenient (one-way violations allowed, flagged) only if strict fails. */
export function routeWithFallback(g: RoadGraph, from: number, to: number, opts: RouteOptions = {}): RoutedLeg | null {
  return route(g, from, to, { ...opts, lenient: false }) ?? route(g, from, to, { ...opts, lenient: true });
}

/** Directed edge between two adjacent nodes (prefers the legal direction). */
export function edgeBetween(g: RoadGraph, a: number, b: number): number {
  let fallback = -1;
  for (let k = g.adjStart[a]; k < g.adjStart[a + 1]; k++) {
    const e = g.adjEdge[k];
    if (g.ea[e] === a && g.eb[e] === b) return e * 2;
    if (g.eb[e] === a && g.ea[e] === b) fallback = e * 2 + 1;
  }
  return fallback;
}
