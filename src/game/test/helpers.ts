import { Game, newGameState } from '../engine.ts';
import { prepareRegion } from '../world/geo.ts';
import { distanceM, nearestNode, route, type LngLat } from '../world/graph.ts';
import { checkStop } from '../network.ts';
import type { Region } from '../world/region.ts';
import { flatTimetable } from '../timetable.ts';
import { istanbulRegion } from './fixtures.ts';
import { post } from '../finance.ts';

let cached: Region | null = null;
export function region(): Region {
  return (cached ??= prepareRegion(istanbulRegion()));
}

/** A new company that owns every zone (tests focus on operations, not licensing). */
export function newGame(opts: { allZones?: boolean; seed?: number; extraFunds?: number } = {}): Game {
  const r = region();
  const home = r.zones.slice().sort((a, b) => b.residents + b.jobs - (a.residents + a.jobs))[0].id;
  const state = newGameState({ region: r, company: { name: 'Test Transit', colour: '#e0573e', logo: 0 }, homeZone: home, seed: opts.seed ?? 42, startHour: 5 });
  if (opts.allZones !== false) state.territory.owned = r.zones.map((z) => z.id);
  if (opts.extraFunds) post(state, { amt: opts.extraFunds, cat: 'grant', memo: 'Test funding' });
  return new Game(state, r);
}

/** Pick a chain of real bus-stop locations (OSM) roughly `spacing` apart, starting near `from`. */
export function stopChain(game: Game, from: LngLat, count: number, spacing = 350): LngLat[] {
  const cands = game.region.osmStops.map((s) => s.lngLat);
  const out: LngLat[] = [];
  let cur = from;
  const used = new Set<number>();
  while (out.length < count) {
    let best = -1, bd = Infinity;
    cands.forEach((c, i) => {
      if (used.has(i)) return;
      const d = distanceM(cur, c);
      if (d < spacing * 0.8 || out.some((o) => distanceM(o, c) < spacing * 0.8)) return;
      const score = Math.abs(d - spacing);
      if (score < bd) {
        bd = score;
        best = i;
      }
    });
    if (best < 0) break;
    used.add(best);
    out.push(cands[best]);
    cur = cands[best];
  }
  return out;
}

/** Stop positions every ~`spacing` metres along the fastest road route between two points. */
export function stopsAlong(game: Game, from: LngLat, to: LngLat, spacing = 420): LngLat[] {
  const g = game.region.graph;
  const [ax, ay] = game.geo.xy(from), [bx, by] = game.geo.xy(to);
  const a = nearestNode(g, game.region.index, ax, ay, 200), b = nearestNode(g, game.region.index, bx, by, 200);
  const leg = route(g, a, b);
  if (!leg) return [];
  const out: LngLat[] = [];
  let acc = spacing;
  for (let i = 0; i < leg.nodes.length; i++) {
    if (i > 0) acc += g.len[leg.dedges[i - 1] >> 1];
    if (acc < spacing) continue;
    const v = leg.nodes[i];
    const ll: LngLat = [g.lng[v], g.lat[v]];
    if (checkStop(game.state, game.region, game.geo, ll).ok && out.every((o) => distanceM(o, ll) > spacing * 0.7)) {
      out.push(ll);
      acc = 0;
    }
  }
  return out;
}

/** Build a working line: depot, stops, line, buses. Returns ids. */
export function buildLine(game: Game, opts: { from?: LngLat; to?: LngLat; stops?: number; buses?: number; headway?: number; model?: string; kind?: 'linear' | 'loop' } = {}) {
  const from = opts.from ?? [28.9784, 41.0369]; // Taksim area
  const pts = opts.to ? stopsAlong(game, from, opts.to) : stopChain(game, from, opts.stops ?? 7);
  const stopIds: string[] = [];
  for (const p of pts) {
    const r = game.placeStop(p);
    if (r.ok) stopIds.push(r.value);
  }
  let depot = Object.keys(game.state.depots)[0];
  if (!depot) {
    const d = game.buildDepot([from[0] + 0.002, from[1] + 0.001]);
    if (!d.ok) throw new Error(d.error);
    depot = d.value;
  }
  const route = game.createRoute({ stops: stopIds, kind: opts.kind ?? 'linear', timetable: flatTimetable(opts.headway ?? 10) });
  if (!route.ok) throw new Error(route.error);
  const buses: string[] = [];
  for (let i = 0; i < (opts.buses ?? 3); i++) {
    const b = game.buyVehicle(opts.model ?? 'city12', depot);
    if (!b.ok) throw new Error(b.error);
    game.assignVehicle(b.value, route.value);
    buses.push(b.value);
  }
  return { stopIds, depot, route: route.value, buses };
}
