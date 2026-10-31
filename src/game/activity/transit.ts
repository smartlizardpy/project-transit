// The city's existing metro, tram, rail, funicular and ferry as a travel choice
// (docs/city-activity-engine-plan.md, sections 7.5 and 7.6).
//
// A journey by existing transit is a walk to a station, a wait set by the mode, the ride along
// the network (TransitNet, built from the map's tracks), any changes, and a walk at the end.
// Service levels are game settings, labelled "assumed": nothing here comes from a timetable.
// It competes with your buses, and since phase 7 it also combines with them: a bus to a stop
// near a station, a walk across, and on by train (`toZone`).

import { NO_WEATHER, type WeatherEffect } from './conditions.ts';
import type { TransitNet } from '../world/region.ts';
import type { TransitMode } from '../world/places.ts';
import type { ActivityZones } from './zones.ts';
import type { TourMatrix } from './od.ts';
import { CHOICE, type TravellerType } from './params.ts';

/** Assumed service by mode: average speed including stops (km/h) and the wait at the peak (minutes). */
export const TRANSIT_SERVICE: Partial<Record<TransitMode, { kmh: number; wait: number }>> = {
  metro: { kmh: 32, wait: 4 },
  tram: { kmh: 18, wait: 6 },
  rail: { kmh: 45, wait: 8 },
  ferry: { kmh: 20, wait: 12 },
  funicular: { kmh: 15, wait: 5 },
  cable: { kmh: 12, wait: 6 },
};
/** Hours the network runs: journeys starting from 06:00 to before midnight (assumed). */
export const TRANSIT_HOURS = { from: 6, to: 24 };
/** Off-peak waits are longer than at the peak. */
const OFF_PEAK = 1.5;
const PEAK = new Set([7, 8, 9, 16, 17, 18, 19]);
/** Longest walk to a station, metres in a straight line (people walk further to rail than to a bus). */
const ACCESS_M = 800;
/** Stations this close count as one interchange on foot (Karaköy tram and pier, for example). */
const WALK_CHANGE_M = 320;
/** A ferry "crossing" shorter than this joins piers side by side (one pier mapped twice): people walk it. */
export const MIN_FERRY_M = 300;
/** Generalised minutes used to pick the best path through the network (commuter weights). */
const PICK = { wait: 1.6, change: 13, walk: 1.2 };

/** Wait multiplier for the hour, or 0 when the network does not run. */
export function transitWaitFactor(hour: number): number {
  if (hour < TRANSIT_HOURS.from || hour >= TRANSIT_HOURS.to) return 0;
  return PEAK.has(hour) ? 1 : OFF_PEAK;
}

/** Per tour-matrix entry: the best journey by existing transit between the two zones (Infinity: none). */
export interface TransitSkim {
  /** walking minutes (both ends and any walk between stations), riding minutes, waits at the peak (minutes) and changes */
  walk: Float32Array;
  ivt: Float32Array;
  wait: Float32Array;
  changes: Uint8Array;
  /** the modes used, as a bit set over MODE_BITS (for the place card and the panel) */
  modes: Uint8Array;
  /** entries with a journey */
  count: number;
  /** the best journey between any two zones (events: from an attendee's zone to the venue's), cached */
  between: (i: number, j: number) => Path | null;
  /** the best journey from boarding at station `s` to zone `j` (walk at the far end only), cached */
  toZone: (s: number, j: number) => Path | null;
  /** closed links (rail disruptions) this skim was built without */
  closed: string;
}

export const MODE_BITS: TransitMode[] = ['metro', 'tram', 'rail', 'ferry', 'funicular', 'cable'];

export interface Path { ivt: number; wait: number; changes: number; walk: number; modes: number }

/** A small binary min-heap of (cost, state). */
class Heap {
  private c: number[] = [];
  private v: number[] = [];
  get size() {
    return this.c.length;
  }
  push(c: number, v: number) {
    const { c: C, v: V } = this;
    let i = C.length;
    C.push(c);
    V.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (C[p] <= C[i]) break;
      [C[p], C[i]] = [C[i], C[p]];
      [V[p], V[i]] = [V[i], V[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const { c: C, v: V } = this;
    const top: [number, number] = [C[0], V[0]];
    const lc = C.pop()!, lv = V.pop()!;
    if (C.length) {
      C[0] = lc;
      V[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < C.length && C[l] < C[m]) m = l;
        if (r < C.length && C[r] < C[m]) m = r;
        if (m === i) break;
        [C[m], C[i]] = [C[i], C[m]];
        [V[m], V[i]] = [V[i], V[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Best paths between all pairs of stations (a station and the mode you are on are the state). */
function stationPaths(net: TransitNet, closed: Set<number>): Path[][] {
  const S = net.stations.length;
  const ok = (m: TransitMode) => !!net.modes[m]?.ok && !!TRANSIT_SERVICE[m];
  // edges by (station, mode) state
  type Edge = { to: number; m: TransitMode; min: number };
  const adj: Edge[][] = Array.from({ length: S }, () => []);
  const walks: { to: number; min: number }[][] = Array.from({ length: S }, () => []);
  for (const [li, l] of net.links.entries()) {
    if (!ok(l.mode) || closed.has(li)) continue;
    if (l.mode === 'ferry' && l.m < MIN_FERRY_M) {
      const min = (l.m * CHOICE.detour) / CHOICE.walkSpeed;
      walks[l.a].push({ to: l.b, min });
      walks[l.b].push({ to: l.a, min });
      continue;
    }
    const min = (l.m / 1000 / TRANSIT_SERVICE[l.mode]!.kmh) * 60;
    adj[l.a].push({ to: l.b, m: l.mode, min });
    adj[l.b].push({ to: l.a, m: l.mode, min });
  }
  // walking changes between nearby stations
  for (let a = 0; a < S; a++)
    for (let b = a + 1; b < S; b++) {
      const d = Math.hypot(net.stations[a].x - net.stations[b].x, net.stations[a].y - net.stations[b].y);
      if (d > WALK_CHANGE_M) continue;
      const min = (d * CHOICE.detour) / CHOICE.walkSpeed;
      walks[a].push({ to: b, min });
      walks[b].push({ to: a, min });
    }
  const modeIdx = (m: TransitMode) => MODE_BITS.indexOf(m);
  const M = MODE_BITS.length;
  const out: Path[][] = [];
  for (let s = 0; s < S; s++) {
    // Dijkstra over states station × mode (-1 = on foot, before boarding or between stations)
    const N = S * (M + 1);
    const cost = new Float64Array(N).fill(Infinity);
    const path: (Path | null)[] = new Array(N).fill(null);
    const done = new Uint8Array(N);
    const st = (station: number, mi: number) => station * (M + 1) + mi + 1;
    const heap = new Heap();
    cost[st(s, -1)] = 0;
    path[st(s, -1)] = { ivt: 0, wait: 0, changes: 0, walk: 0, modes: 0 };
    heap.push(0, st(s, -1));
    while (heap.size) {
      const [best, u] = heap.pop();
      if (done[u] || best > cost[u]) continue;
      done[u] = 1;
      const station = Math.floor(u / (M + 1)), mi = (u % (M + 1)) - 1;
      const p = path[u]!;
      const relax = (v: number, c: number, q: Path) => {
        if (c < cost[v] - 1e-9) {
          cost[v] = c;
          path[v] = q;
          heap.push(c, v);
        }
      };
      for (const e of adj[station]) {
        const ei = modeIdx(e.m);
        if (ei === mi) {
          relax(st(e.to, ei), best + e.min, { ...p, ivt: p.ivt + e.min });
        } else {
          // boarding (from foot) or changing mode: a wait, and a change after the first boarding
          const w = TRANSIT_SERVICE[e.m]!.wait;
          const ch = p.modes ? 1 : 0;
          relax(st(e.to, ei), best + e.min + PICK.wait * w + PICK.change * ch, { ivt: p.ivt + e.min, wait: p.wait + w, changes: p.changes + ch, walk: p.walk, modes: p.modes | (1 << ei) });
        }
      }
      // walk to a nearby station (after riding: a change on foot)
      for (const w of walks[station]) relax(st(w.to, -1), best + PICK.walk * w.min, { ...p, walk: p.walk + w.min });
    }
    const row: Path[] = [];
    for (let t = 0; t < S; t++) {
      let b: Path | null = null, bc = Infinity;
      for (let mi = -1; mi < M; mi++) {
        const i = st(t, mi);
        if (path[i]?.modes && cost[i] < bc) (bc = cost[i]), (b = path[i]);
      }
      row.push(b ?? { ivt: Infinity, wait: 0, changes: 0, walk: 0, modes: 0 });
    }
    out.push(row);
  }
  return out;
}

/** Skims every tour-matrix entry by existing transit (an empty skim without a network); `closed`: links out of service. */
export function buildTransitSkim(net: TransitNet | undefined, zs: ActivityZones, m: TourMatrix, closed: number[] = []): TransitSkim {
  const E = m.tours.length;
  const skim: TransitSkim = {
    walk: new Float32Array(E).fill(Infinity), ivt: new Float32Array(E).fill(Infinity), wait: new Float32Array(E), changes: new Uint8Array(E), modes: new Uint8Array(E), count: 0,
    between: () => null, toZone: () => null, closed: closed.join(','),
  };
  if (!net || net.stations.length < 2 || !net.links.length) return skim;
  const paths = stationPaths(net, new Set(closed));
  const walkMin = (d: number) => (d * CHOICE.detour) / CHOICE.walkSpeed;
  // stations within a walk of each zone's centre (or a place's entrance)
  const access = zs.list.map((z) => {
    if (z.kind === 'beyond') return [];
    const out: { s: number; w: number }[] = [];
    net.stations.forEach((st, s) => {
      const d = Math.hypot(st.x - z.x, st.y - z.y);
      if (d <= ACCESS_M) out.push({ s, w: Math.max(3, walkMin(d)) });
    });
    return out;
  });
  const Z = zs.list.length;
  const pairs = new Map<number, Path | null>();
  const between = (i: number, j: number): Path | null => {
    if (i === j) return null;
    const key = i * Z + j;
    let r = pairs.get(key);
    if (r !== undefined) return r;
    let bc = Infinity;
    r = null;
    for (const a of access[i] ?? [])
      for (const b of access[j] ?? []) {
        if (a.s === b.s) continue;
        const p = paths[a.s][b.s];
        if (!Number.isFinite(p.ivt)) continue;
        const w = a.w + b.w + p.walk;
        const c = PICK.walk * w + p.ivt + PICK.wait * p.wait + PICK.change * p.changes;
        if (c < bc) (bc = c), (r = { ...p, walk: w });
      }
    pairs.set(key, r);
    return r;
  };
  skim.between = between;
  const fromStation: (Path | null | undefined)[] = new Array(net.stations.length * Z);
  skim.toZone = (st: number, j: number): Path | null => {
    const key = st * Z + j;
    let r = fromStation[key];
    if (r !== undefined) return r;
    let bc = Infinity;
    r = null;
    for (const b of access[j] ?? []) {
      if (b.s === st) continue;
      const p = paths[st]?.[b.s];
      if (!p || !Number.isFinite(p.ivt)) continue;
      const w = b.w + p.walk;
      const c = PICK.walk * w + p.ivt + PICK.wait * p.wait + PICK.change * p.changes;
      if (c < bc) (bc = c), (r = { ...p, walk: w });
    }
    fromStation[key] = r;
    return r;
  };
  for (let e = 0; e < E; e++) {
    const p = between(m.o[e], m.d[e]);
    if (!p) continue;
    skim.walk[e] = p.walk;
    skim.ivt[e] = p.ivt;
    skim.wait[e] = p.wait;
    skim.changes[e] = p.changes;
    skim.modes[e] = p.modes;
    skim.count++;
  }
  return skim;
}

/** Generalised minutes of one leg by existing transit along a path at an hour's wait factor (Infinity: none). */
export function transitPathLeg(p: Path | null, ty: TravellerType, waitFactor: number, wx: WeatherEffect = NO_WEATHER): number {
  if (!p || !(waitFactor > 0) || !Number.isFinite(p.ivt)) return Infinity;
  return ty.walk * p.walk * wx.walk + p.ivt + ty.wait * p.wait * waitFactor * wx.wait + ty.change * p.changes + CHOICE.transitConst;
}

/** Generalised minutes of one leg by existing transit for entry `e` at an hour's wait factor (Infinity: none). */
export function transitLeg(skim: TransitSkim, e: number, ty: TravellerType, waitFactor: number, wx: WeatherEffect = NO_WEATHER): number {
  const ivt = skim.ivt[e];
  if (!(waitFactor > 0) || !Number.isFinite(ivt)) return Infinity;
  return ty.walk * skim.walk[e] * wx.walk + ivt + ty.wait * skim.wait[e] * waitFactor * wx.wait + ty.change * skim.changes[e] + CHOICE.transitConst;
}
