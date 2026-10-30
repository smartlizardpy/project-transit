// Where tours go (docs/city-activity-engine-plan.md, section 7.2): a gravity model per tour
// kind between activity zones. Work and education are doubly constrained (productions and
// attractions both match after a few balancing rounds); the other kinds are singly constrained.
// Only the top destinations of each origin are kept (95% of its tours, at most 60; all of them
// when there are at most 8).
// Airport arrivals mirror departures, so travellers come back to the areas they left from.

import { KINDS, KIND, KIND_COUNT } from './params.ts';
import type { ActivityZones } from './zones.ts';

export interface TourMatrix {
  /** entries sorted by origin, then kind, then destination */
  o: Int32Array;
  d: Int32Array;
  k: Uint8Array;
  /** tours a weekday (all modes) */
  tours: Float32Array;
  /** straight-line distance between the zones (inside a zone: its typical trip), metres */
  dist: Float32Array;
  /** first entry of each origin zone, length Z + 1 */
  start: Int32Array;
}

const KEEP_SHARE = 0.95;
const KEEP_MAX = 60;
const KEEP_ALL = 8;
const BALANCE_ROUNDS = 5;

export function zoneDistance(zs: ActivityZones, i: number, j: number): number {
  const a = zs.list[i], b = zs.list[j];
  return i === j ? a.inner : Math.max(Math.hypot(a.x - b.x, a.y - b.y), (a.inner + b.inner) / 4);
}

export function distributeTours(zs: ActivityZones): TourMatrix {
  const Z = zs.list.length, K = KIND_COUNT;
  const rows: { o: number; d: number; k: number; t: number; dist: number }[] = [];
  const dist = new Float32Array(Z * Z);
  for (let i = 0; i < Z; i++) for (let j = 0; j < Z; j++) dist[i * Z + j] = zoneDistance(zs, i, j);
  const fly: { o: number; d: number; t: number }[] = [];
  for (let k = 0; k < K; k++) {
    const kind = KINDS[k];
    if (kind.toHome) continue; // arrivals mirror departures, below
    const P = new Float64Array(Z), A = new Float64Array(Z);
    let sumP = 0, sumA = 0;
    for (let z = 0; z < Z; z++) {
      P[z] = zs.prod[z * K + k];
      A[z] = zs.attr[z * K + k];
      sumP += P[z];
      sumA += A[z];
    }
    if (!(sumP > 0) || !(sumA > 0)) continue;
    const dests: number[] = [];
    for (let j = 0; j < Z; j++) if (A[j] > 0) dests.push(j);
    const origins: number[] = [];
    for (let i = 0; i < Z; i++) if (P[i] > 0) origins.push(i);
    // f(d) once per origin and destination
    const F = new Float64Array(origins.length * dests.length);
    origins.forEach((i, oi) => dests.forEach((j, dj) => (F[oi * dests.length + dj] = Math.exp(-dist[i * Z + j] / kind.decay))));
    // balancing factors on the destination side (all 1 for singly constrained kinds)
    const B = new Float64Array(dests.length).fill(1);
    const target = dests.map((j) => (A[j] / sumA) * sumP);
    const rounds = kind.doubly ? BALANCE_ROUNDS : 1;
    const T = new Float64Array(origins.length * dests.length);
    for (let round = 0; round < rounds; round++) {
      const got = new Float64Array(dests.length);
      origins.forEach((i, oi) => {
        let den = 0;
        for (let dj = 0; dj < dests.length; dj++) den += B[dj] * A[dests[dj]] * F[oi * dests.length + dj];
        if (!(den > 0)) return;
        for (let dj = 0; dj < dests.length; dj++) {
          const v = (P[i] * B[dj] * A[dests[dj]] * F[oi * dests.length + dj]) / den;
          T[oi * dests.length + dj] = v;
          got[dj] += v;
        }
      });
      if (round < rounds - 1) for (let dj = 0; dj < dests.length; dj++) if (got[dj] > 0) B[dj] *= Math.min(20, Math.max(0.05, target[dj] / got[dj]));
    }
    // keep the top destinations of each origin, scaled back up to the origin's tours
    origins.forEach((i, oi) => {
      const list: { j: number; v: number }[] = [];
      for (let dj = 0; dj < dests.length; dj++) {
        const v = T[oi * dests.length + dj];
        if (v > 0) list.push({ j: dests[dj], v });
      }
      list.sort((a, b) => b.v - a.v || a.j - b.j);
      const total = list.reduce((s, x) => s + x.v, 0);
      let acc = 0, n = 0;
      // a short list (airports, for example) is kept whole, so small destinations still get their share
      while (n < list.length && n < KEEP_MAX && (list.length <= KEEP_ALL || acc < KEEP_SHARE * total)) acc += list[n++].v;
      const scale = acc > 0 ? total / acc : 0;
      for (let q = 0; q < n; q++) {
        const t = list[q].v * scale;
        if (t < 1e-3) continue;
        rows.push({ o: i, d: list[q].j, k, t, dist: dist[i * Z + list[q].j] });
        if (k === KIND.fly) fly.push({ o: i, d: list[q].j, t });
      }
    });
  }
  for (const f of fly) rows.push({ o: f.d, d: f.o, k: KIND.landed, t: f.t, dist: dist[f.d * Z + f.o] });
  rows.sort((a, b) => a.o - b.o || a.k - b.k || a.d - b.d);
  const m: TourMatrix = {
    o: Int32Array.from(rows, (r) => r.o),
    d: Int32Array.from(rows, (r) => r.d),
    k: Uint8Array.from(rows, (r) => r.k),
    tours: Float32Array.from(rows, (r) => r.t),
    dist: Float32Array.from(rows, (r) => r.dist),
    start: new Int32Array(Z + 1),
  };
  let e = 0;
  for (let z = 0; z <= Z; z++) {
    while (e < rows.length && rows[e].o < z) e++;
    m.start[z] = e;
  }
  return m;
}

/** Total tours a weekday by kind (for tests and the progress document). */
export function toursByKind(m: TourMatrix): number[] {
  const out = new Array<number>(KIND_COUNT).fill(0);
  for (let e = 0; e < m.tours.length; e++) out[m.k[e]] += m.tours[e];
  return out;
}
