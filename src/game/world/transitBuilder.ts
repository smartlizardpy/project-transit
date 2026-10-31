// The city's existing rail, metro, tram, funicular and ferry network as links between stations,
// built from the map's track lines and the Place Registry (docs/city-activity-engine-plan.md, 7.6).
// Pure and deterministic: it runs in the region worker and in Node tests.
//
// Method, per mode: merge the track pieces into one vertex graph (pieces are clipped at tile
// edges, so ends within 2 m share a vertex and loose ends within 15 m are joined), snap each
// station onto the nearest track segment, then walk outwards from every station and stop at the
// first other station on each branch. Those are its neighbours, so no line identities are needed.
import type { CityPlace, TransitMode } from './places.ts';
import type { RawLine } from './placeBuilder.ts';
import type { TransitNet } from './region.ts';

export interface TransitInputs {
  lines: RawLine[];
  places: CityPlace[];
  toXY: (lng: number, lat: number) => [number, number];
}

const MODES: TransitMode[] = ['rail', 'metro', 'tram', 'funicular', 'cable', 'ferry'];
const NAME: Record<string, string> = { rail: 'train', metro: 'metro', tram: 'tram', funicular: 'funicular', cable: 'cable car', ferry: 'ferry' };

/** which track pieces belong to which mode */
const TRACK: Record<TransitMode, (l: RawLine) => boolean> = {
  rail: (l) => l.cls === 'rail' && (l.sub === 'rail' || l.sub === 'narrow_gauge' || l.sub === 'light_rail'),
  funicular: (l) => l.cls === 'rail' && l.sub === 'funicular',
  metro: (l) => l.cls === 'transit' && (l.sub === 'subway' || l.sub === 'monorail'),
  tram: (l) => l.cls === 'transit' && l.sub === 'tram',
  ferry: (l) => l.cls === 'ferry' || l.cls === 'ferry_route',
  cable: () => false, // the tiles have no cable car lines
  bus: () => false,
};
/** how far a station may sit from its track, metres */
const SNAP_M: Record<TransitMode, number> = { rail: 150, metro: 150, tram: 80, funicular: 120, cable: 120, ferry: 300, bus: 0 };
/** longest believable link, metres (rail also has the "no station in between" exception, see below) */
const CAP_M: Record<TransitMode, number> = { rail: 12000, metro: 5000, tram: 5000, funicular: 5000, cable: 5000, ferry: 15000, bus: 0 };
/** how far the walk goes from a station before giving up (rail goes further, for the exception) */
const WALK_M: Record<TransitMode, number> = { rail: 40000, metro: 5000, tram: 5000, funicular: 5000, cable: 5000, ferry: 15000, bus: 0 };

const MERGE_M = 2;
const JOIN_M = 15;
const MIN_SNAPPED_SHARE = 0.4;
const PARALLEL_M = 50; // a second track this much further away still counts (double track)
const K = 200003; // grid key multiplier

// A small binary min-heap of distance and node pairs.
class Heap {
  d: number[] = [];
  n: number[] = [];
  get size() { return this.d.length; }
  push(dist: number, node: number) {
    let i = this.d.length;
    this.d.push(dist);
    this.n.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.d[p] <= dist) break;
      this.d[i] = this.d[p];
      this.n[i] = this.n[p];
      i = p;
    }
    this.d[i] = dist;
    this.n[i] = node;
  }
  pop(): [number, number] {
    const top: [number, number] = [this.d[0], this.n[0]];
    const ld = this.d.pop()!;
    const ln = this.n.pop()!;
    const len = this.d.length;
    if (len > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= len) break;
        if (c + 1 < len && this.d[c + 1] < this.d[c]) c++;
        if (this.d[c] >= ld) break;
        this.d[i] = this.d[c];
        this.n[i] = this.n[c];
        i = c;
      }
      this.d[i] = ld;
      this.n[i] = ln;
    }
    return top;
  }
}

interface Candidate { x: number; y: number; access: [number, number][] }

interface ModeResult {
  /** stations that snapped onto the track, and how many were tried */
  snapped: Set<number>;
  of: number;
  links: { a: number; b: number; m: number }[];
}

/** Builds one mode's track graph and returns the links between its stations (indices into `stations`). */
function buildMode(mode: TransitMode, lines: RawLine[], stations: Candidate[], members: number[]): ModeResult {
  const res: ModeResult = { snapped: new Set(), of: members.length, links: [] };
  // vertices and track segments
  const vx: number[] = [];
  const vy: number[] = [];
  const vkey = new Map<number, number>();
  const ea: number[] = [];
  const eb: number[] = [];
  const el: number[] = [];
  const vertex = (x: number, y: number) => {
    const k = Math.round(x / MERGE_M) * K + Math.round(y / MERGE_M);
    let v = vkey.get(k);
    if (v === undefined) {
      v = vx.length;
      vx.push(x);
      vy.push(y);
      vkey.set(k, v);
    }
    return v;
  };
  for (const l of lines) {
    let prev = -1;
    for (let i = 0; i < l.pts.length; i += 2) {
      const v = vertex(l.pts[i], l.pts[i + 1]);
      if (prev >= 0 && v !== prev) {
        ea.push(prev);
        eb.push(v);
        el.push(Math.hypot(vx[v] - vx[prev], vy[v] - vy[prev]));
      }
      prev = v;
    }
  }
  if (ea.length === 0) return res;
  const nV = vx.length;

  // join loose ends that nearly touch another vertex
  const deg = new Uint16Array(nV);
  for (let e = 0; e < ea.length; e++) { deg[ea[e]]++; deg[eb[e]]++; }
  const vgrid = new Map<number, number[]>();
  for (let v = 0; v < nV; v++) {
    const k = Math.floor(vx[v] / JOIN_M) * K + Math.floor(vy[v] / JOIN_M);
    const a = vgrid.get(k);
    if (a) a.push(v); else vgrid.set(k, [v]);
  }
  const touching = new Set<number>();
  for (let e = 0; e < ea.length; e++) { touching.add(ea[e] * nV + eb[e]); touching.add(eb[e] * nV + ea[e]); }
  for (let v = 0; v < nV; v++) {
    if (deg[v] !== 1) continue;
    const cx = Math.floor(vx[v] / JOIN_M), cy = Math.floor(vy[v] / JOIN_M);
    let best = -1, bd = JOIN_M;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const u of vgrid.get((cx + dx) * K + cy + dy) ?? []) {
          if (u === v || touching.has(v * nV + u)) continue;
          const d = Math.hypot(vx[u] - vx[v], vy[u] - vy[v]);
          if (d < bd) { bd = d; best = u; }
        }
    if (best >= 0) { ea.push(v); eb.push(best); el.push(bd); }
  }

  // a grid of segments, for snapping
  const cell = Math.max(SNAP_M[mode], 100);
  const sgrid = new Map<number, number[]>();
  for (let e = 0; e < ea.length; e++) {
    const x0 = Math.min(vx[ea[e]], vx[eb[e]]), x1 = Math.max(vx[ea[e]], vx[eb[e]]);
    const y0 = Math.min(vy[ea[e]], vy[eb[e]]), y1 = Math.max(vy[ea[e]], vy[eb[e]]);
    for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
      for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
        const k = cx * K + cy;
        const a = sgrid.get(k);
        if (a) a.push(e); else sgrid.set(k, [e]);
      }
  }
  // Double-track lines are often mapped as two separate ways, and a station sits near both. So a
  // station snaps to the nearest segment of every connected piece of track within reach, not just
  // the nearest one; otherwise its neighbour walk could run along the other way and miss it.
  const parent = Array.from({ length: nV }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (let e = 0; e < ea.length; e++) parent[find(ea[e])] = find(eb[e]);
  const near = (px: number, py: number, out: Map<number, { e: number; t: number; d: number }>) => {
    const cx = Math.floor(px / cell), cy = Math.floor(py / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const e of sgrid.get((cx + dx) * K + cy + dy) ?? []) {
          const ax = vx[ea[e]], ay = vy[ea[e]];
          const sx = vx[eb[e]] - ax, sy = vy[eb[e]] - ay;
          const l2 = sx * sx + sy * sy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * sx + (py - ay) * sy) / l2)) : 0;
          const d = Math.hypot(px - (ax + t * sx), py - (ay + t * sy));
          if (d > SNAP_M[mode]) continue;
          const c = find(ea[e]);
          const old = out.get(c);
          if (!old || d < old.d || (d === old.d && e < old.e)) out.set(c, { e, t, d });
        }
  };

  // snap stations: each becomes a node on its segment, which is split there
  const snaps: { st: number; e: number; t: number }[] = [];
  const snappedStations = new Set<number>();
  for (const st of members) {
    const s = stations[st];
    const found = new Map<number, { e: number; t: number; d: number }>();
    near(s.x, s.y, found);
    if (mode === 'metro') for (const a of s.access) near(a[0], a[1], found);
    let min = Infinity;
    for (const c of found.values()) min = Math.min(min, c.d);
    for (const [, c] of [...found].sort((p, q) => p[0] - q[0]))
      if (c.d <= min + PARALLEL_M) {
        snaps.push({ st, e: c.e, t: c.t });
        snappedStations.add(st);
      }
  }
  res.snapped = snappedStations;
  if (snappedStations.size < 2) return res;

  const nodes = nV + snaps.length;
  const adj: number[][] = Array.from({ length: nodes }, () => []);
  const adjLen: number[][] = Array.from({ length: nodes }, () => []);
  const link = (a: number, b: number, m: number) => {
    adj[a].push(b); adjLen[a].push(m);
    adj[b].push(a); adjLen[b].push(m);
  };
  const byEdge = new Map<number, number[]>();
  snaps.forEach((s, i) => {
    const a = byEdge.get(s.e);
    if (a) a.push(i); else byEdge.set(s.e, [i]);
  });
  for (let e = 0; e < ea.length; e++) {
    const on = byEdge.get(e);
    if (!on) { link(ea[e], eb[e], el[e]); continue; }
    // stations on one segment are chained in order, so none can be skipped
    on.sort((p, q) => snaps[p].t - snaps[q].t || p - q);
    let prev = ea[e], prevT = 0;
    for (const i of on) {
      link(prev, nV + i, (snaps[i].t - prevT) * el[e]);
      prev = nV + i;
      prevT = snaps[i].t;
    }
    link(prev, eb[e], (1 - prevT) * el[e]);
  }

  // walk from each station, stopping at the next station on every branch
  const limit = WALK_M[mode];
  const dist = new Float64Array(nodes);
  const best = new Map<number, number>(); // pair key -> shortest metres
  for (let i = 0; i < snaps.length; i++) {
    dist.fill(Infinity);
    const heap = new Heap();
    dist[nV + i] = 0;
    heap.push(0, nV + i);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist[u]) continue;
      if (u >= nV && u !== nV + i) {
        const j = u - nV;
        const a = Math.min(snaps[i].st, snaps[j].st), b = Math.max(snaps[i].st, snaps[j].st);
        if (a !== b) {
          const k = a * stations.length + b;
          const old = best.get(k);
          if (old === undefined || d < old) best.set(k, d);
        }
        continue; // do not walk past a station
      }
      const nb = adj[u], nl = adjLen[u];
      for (let k = 0; k < nb.length; k++) {
        const nd = d + nl[k];
        if (nd < dist[nb[k]] && nd <= limit) {
          dist[nb[k]] = nd;
          heap.push(nd, nb[k]);
        }
      }
    }
  }
  for (const [k, d] of best) res.links.push({ a: Math.floor(k / stations.length), b: k % stations.length, m: Math.round(d) });
  res.links.sort((p, q) => p.a - q.a || p.b - q.b);
  return res;
}

export function buildTransit(inp: TransitInputs): TransitNet {
  // the candidate stations: every place with a non-bus mode
  const places: CityPlace[] = [];
  const stations: Candidate[] = [];
  const perMode = new Map<TransitMode, number[]>();
  for (const p of inp.places) {
    if (p.category === 'bus_station' || p.category === 'airport') continue;
    const modes = (p.modes ?? []).filter((m) => m !== 'bus');
    if (modes.length === 0) continue;
    const [x, y] = inp.toXY(p.lngLat[0], p.lngLat[1]);
    const idx = stations.length;
    places.push(p);
    stations.push({ x, y, access: (p.access ?? []).map((a) => inp.toXY(a[0], a[1])) });
    for (const m of modes) {
      const a = perMode.get(m);
      if (a) a.push(idx); else perMode.set(m, [idx]);
    }
  }

  const net: TransitNet = { stations: [], links: [], modes: {} };
  const keep = new Map<number, Set<TransitMode>>(); // station -> modes that have working links
  const kept: { a: number; b: number; m: number; mode: TransitMode }[] = [];
  for (const mode of MODES) {
    const members = perMode.get(mode);
    if (!members) continue;
    let lines = inp.lines.filter((l) => !l.service && TRACK[mode](l));
    // ferry routes are separate graphs: a hairball of crossing routes would link every pier to every other.
    // The named routes are the real services; the plain 'ferry' ways duplicate them (used only if there are none).
    const groups: RawLine[][] = [lines];
    if (mode === 'ferry') {
      if (lines.some((l) => l.cls === 'ferry_route')) lines = lines.filter((l) => l.cls === 'ferry_route');
      const byId = new Map<number, RawLine[]>();
      for (const l of lines) {
        const a = byId.get(l.id);
        if (a) a.push(l); else byId.set(l.id, [l]);
      }
      groups.length = 0;
      for (const id of [...byId.keys()].sort((p, q) => p - q)) groups.push(byId.get(id)!);
    }
    const r: ModeResult = { snapped: new Set(), of: members.length, links: [] };
    const shortest = new Map<number, { a: number; b: number; m: number }>();
    for (const g of groups) {
      const one = buildMode(mode, g, stations, members);
      for (const s of one.snapped) r.snapped.add(s);
      for (const l of one.links) {
        const k = l.a * stations.length + l.b;
        const old = shortest.get(k);
        if (!old || l.m < old.m) shortest.set(k, l);
      }
    }
    r.links = [...shortest.values()].sort((p, q) => p.a - q.a || p.b - q.b);
    let links = r.links.filter((l) => l.m <= CAP_M[mode]);
    if (mode === 'rail') {
      // a rail link over 12 km stays only when neither end has a shorter link (no station in between)
      const short = new Set<number>();
      for (const l of links) { short.add(l.a); short.add(l.b); }
      links = links.concat(r.links.filter((l) => l.m > CAP_M.rail && !short.has(l.a) && !short.has(l.b)));
    }
    const used = new Set<number>();
    for (const l of links) { used.add(l.a); used.add(l.b); }
    const label = NAME[mode];
    let reason: string | undefined;
    if (lines.length === 0) reason = `The map has no ${label} track here.`;
    else if (r.snapped.size < 2) reason = `Fewer than two ${label} stations sit on mapped ${label} track.`;
    else if (r.snapped.size / r.of < MIN_SNAPPED_SHARE) reason = `Only ${r.snapped.size} of ${r.of} ${label} stations could be matched to mapped track.`;
    else if (links.length === 0) reason = `The ${label} track on the map does not connect any stations.`;
    if (reason) {
      net.modes[mode] = { ok: false, stations: 0, links: 0, reason };
      continue;
    }
    net.modes[mode] = { ok: true, stations: used.size, links: links.length };
    for (const s of used) {
      const set = keep.get(s);
      if (set) set.add(mode); else keep.set(s, new Set([mode]));
    }
    for (const l of links) kept.push({ a: l.a, b: l.b, m: l.m, mode });
  }

  // number the stations that are left in registry order, so the result is stable
  const newIdx = new Map<number, number>();
  for (const s of [...keep.keys()].sort((p, q) => p - q)) {
    const set = keep.get(s)!;
    newIdx.set(s, net.stations.length);
    net.stations.push({
      place: places[s].id,
      name: places[s].name,
      x: Math.round(stations[s].x * 10) / 10,
      y: Math.round(stations[s].y * 10) / 10,
      modes: (places[s].modes ?? []).filter((m) => set.has(m)),
    });
  }
  for (const l of kept) {
    const a = newIdx.get(l.a)!, b = newIdx.get(l.b)!;
    net.links.push({ a: Math.min(a, b), b: Math.max(a, b), m: l.m, mode: l.mode });
  }
  net.links.sort((p, q) => p.a - q.a || p.b - q.b || (p.mode < q.mode ? -1 : p.mode > q.mode ? 1 : 0));
  return net;
}
