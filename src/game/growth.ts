// The map grows as a company expands: the region is rebuilt from more map tiles (same centre,
// so local coordinates do not change) and the running game moves onto it. Road-graph nodes
// are numbered afresh in the new graph, so stops, depots and buses on the road are re-attached
// to the same street points.
import type { GameState } from './types.ts';
import { TripState } from './types.ts';
import { edgeBetween, nearestNode, route } from './world/graph.ts';
import type { Region } from './world/region.ts';

/**
 * Re-point a game state (a copy, e.g. from serialize()) from `from` to `to`. Returns how many
 * buses had to be sent back to their depot because their road could not be matched.
 */
export function moveToRegion(state: GameState, from: Region, to: Region): number {
  const g = to.graph, f = from.graph;
  // same rounding as buildGraph's vertex merge (about 0.5 m)
  const key = (lng: number, lat: number) => `${Math.round(lng * 2e5)},${Math.round(lat * 2e5)}`;
  const at = new Map<string, number>();
  for (let v = 0; v < g.n; v++) {
    const k = key(g.lng[v], g.lat[v]);
    if (!at.has(k)) at.set(k, v);
  }
  const map = (v: number, fallbackM = 8): number => {
    if (v < 0 || v >= f.n) return -1;
    return at.get(key(f.lng[v], f.lat[v])) ?? nearestNode(g, to.index, f.x[v], f.y[v], fallbackM);
  };

  for (const st of Object.values(state.stops)) {
    const n = map(st.node, 40);
    if (n >= 0) st.node = n;
    if (st.alt !== undefined && st.alt >= 0) st.alt = map(st.alt, 40);
  }
  for (const d of Object.values(state.depots)) {
    const n = map(d.node, 40);
    if (n >= 0) d.node = n;
  }
  let lost = 0;
  for (const v of Object.values(state.vehicles)) {
    if (v.pos.kind !== 'path') continue; // depot and line positions do not use node numbers
    // the same street points; where two are no longer directly joined, drive between them
    const nodes = v.pos.nodes.map((n) => map(n));
    let path: number[] | null = nodes.every((n) => n >= 0) ? [nodes[0]] : null;
    for (let i = 1; path && i < nodes.length; i++) {
      const a = path[path.length - 1], b = nodes[i];
      if (a === b) continue;
      if (edgeBetween(g, a, b) >= 0) path.push(b);
      else {
        const leg = route(g, a, b);
        if (leg) path.push(...leg.nodes.slice(1));
        else path = null;
      }
    }
    if (path && path.length > 1) {
      v.pos.nodes = path;
      continue;
    }
    // an empty bus on its way to or from a line: send it home, and free its next trip
    lost++;
    for (const list of Object.values(state.trips))
      for (const t of list) if (t.veh === v.id && t.state === TripState.Assigned) {
        t.veh = null;
        t.state = TripState.Planned;
      }
    v.pos = { kind: 'depot' };
    v.status = v.status === 'maintenance' ? 'maintenance' : 'parked';
    v.trip = null;
    v.next = null;
    v.load = 0;
    v.sp = 0;
    delete state.pax.onboard[v.id];
  }
  state.region = { ...to.spec, fingerprint: to.fingerprint };
  return lost;
}
