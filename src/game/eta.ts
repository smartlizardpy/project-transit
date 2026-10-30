// Arrival predictions for stop boards and vehicle panels, derived from the live simulation:
// the bus's position along its path, the current simulated traffic on the streets ahead,
// expected dwell at stops in between, and (for trips not yet started) the timetable plus the
// state of the bus assigned to it.

import type { Game } from './engine.ts';
import type { Pattern } from './network.ts';
import { freeSpeed } from './world/graph.ts';
import { segmentAt } from './paths.ts';
import { MODEL } from './content.ts';
import { TripState, type Id, type Trip, type Vehicle } from './types.ts';
import { waitingAt } from './passengers.ts';
import { SCHEDULE_DWELL } from './timetable.ts';
import { PREP } from './vehicles.ts';

export interface Arrival {
  route: Id;
  pat: number;
  trip: number;
  /** vehicle running or assigned to the trip, if any */
  veh: Id | null;
  /** predicted arrival (or departure at the first stop), absolute game seconds */
  eta: number;
  /** timetabled time at this stop */
  sched: number;
  /** headsign: the last stop of the pattern */
  towards: string;
  status: 'boarding' | 'approaching' | 'scheduled' | 'unassigned';
  /** predicted minutes late (+) or early (−) */
  delayMin: number;
  /** the trip ends at this stop */
  terminates: boolean;
  /** passengers on board now (running trips only) */
  load: number | null;
  capacity: number | null;
}

/** Seconds to drive from s0 to s1 along a pattern at current traffic, plus stops in between. */
export function driveSeconds(game: Game, p: Pattern, v: Vehicle | null, s0: number, s1: number, fromIdx: number, toIdx: number): number {
  const g = game.region.graph;
  const path = p.path;
  if (s1 <= s0) return 0;
  const speedK = v ? MODEL[v.model].speed : 1;
  const now = game.t;
  const road = game.traffic.conditions(now);
  let t = 0;
  let i = segmentAt(path, s0);
  let s = s0;
  while (s < s1 && i < path.dedges.length) {
    const end = Math.min(s1, path.cum[i + 1]);
    const de = path.dedges[i];
    const sf = game.traffic.speedFactor(game.traffic.congestion(de, now)) * road;
    const vmax = Math.max(2, Math.min(freeSpeed(g, de >> 1) * speedK * sf, path.vmax[i + 1] < 99 ? path.vmax[i + 1] * 1.6 : 99));
    t += (end - s) / vmax;
    s = end;
    i++;
  }
  // corners and acceleration cost roughly 12%, each intermediate stop ~10 s braking + dwell
  let stops = 0;
  for (let k = fromIdx; k < toIdx; k++) {
    const id = p.stops[k];
    if (waitingAt(game.state, id) > 0) stops++;
  }
  return t * 1.12 + stops * (10 + SCHEDULE_DWELL * 0.7);
}

function towards(game: Game, p: Pattern): string {
  return game.state.stops[p.stops[p.stops.length - 1]]?.name ?? '';
}

/** When will the vehicle be ready to start `trip` at the first stop? */
function readyFor(game: Game, v: Vehicle, trip: Trip): number {
  const now = game.t;
  if (v.trip === trip.id) {
    if (v.status === 'layover' || v.status === 'at_stop' || v.status === 'in_service') return now;
    if (v.status === 'preparing') return v.until + game.travelSeconds(game.state.depots[v.depot]?.node ?? -1, game.pattern(trip.route, trip.pat)?.path.nodes[0] ?? -1);
    if (v.status === 'to_route' && v.pos.kind === 'path') {
      const remaining = v.pos.nodes.length > 1 ? game.travelSeconds(game.vehicleNode(v).node, v.pos.nodes[v.pos.nodes.length - 1]) : 0;
      return now + remaining;
    }
    return now + PREP;
  }
  if (v.next === trip.id && v.trip !== null) {
    const cur = game.trip(v.trip);
    const p = cur ? game.pattern(cur.route, cur.pat) : undefined;
    if (cur && p && v.pos.kind === 'pattern') {
      const last = p.stops.length - 1;
      const end = now + driveSeconds(game, p, v, v.pos.s, p.stopS[last], v.stopIdx, last);
      const layover = Math.min(90, (game.state.routes[cur.route]?.timetable.layover ?? 4) * 60);
      return end + layover;
    }
  }
  return now;
}

/** Upcoming arrivals at a stop, soonest first. */
export function arrivalsAt(game: Game, stop: Id, limit = 8, horizon = 3 * 3600): Arrival[] {
  const now = game.t;
  const out: Arrival[] = [];
  for (const r of Object.values(game.state.routes)) {
    const pats = game.patterns.get(r.id);
    if (!pats) continue;
    for (const p of pats) {
      if (!p.valid) continue;
      // positions of this stop in the pattern (a loop has its terminus twice)
      const idxs: number[] = [];
      p.stops.forEach((id, j) => id === stop && idxs.push(j));
      if (!idxs.length) continue;
      const isLoop = p.stops[0] === p.stops[p.stops.length - 1];
      const trips = game.state.trips[r.id] ?? [];
      for (const trip of trips) {
        if (trip.pat !== p.index) continue;
        if (trip.state === TripState.Done || trip.state === TripState.Missed) continue;
        if (trip.dep > now + horizon) break;
        const sch = game.schedule(r.id, p.index, trip.dep);
        if (!sch) continue;
        const v = trip.veh ? game.state.vehicles[trip.veh] : null;
        for (const j of idxs) {
          // at a loop terminus show departures, not the arrival that ends the previous lap
          if (isLoop && j === p.stops.length - 1) continue;
          const sched = trip.dep + (j === 0 ? 0 : sch[j]);
          let eta = sched;
          // future trips get a bus from the dispatcher shortly before departure
          const noBus = !v && (r.vehicles.length === 0 || trip.dep < now + 60);
          let status: Arrival['status'] = noBus ? 'unassigned' : 'scheduled';
          let load: number | null = null;
          if (trip.state === TripState.Running && v && v.trip === trip.id && v.pos.kind === 'pattern' && v.pos.route === r.id && v.pos.pat === p.index) {
            if (v.stopIdx > j || (v.stopIdx === j && v.status === 'in_service' && j === 0)) continue; // already left
            if (v.status === 'at_stop' && v.stopIdx === j) {
              eta = Math.max(now, v.until);
              status = 'boarding';
            } else {
              const drive = driveSeconds(game, p, v, v.pos.s, p.stopS[j], v.stopIdx, j);
              const dwell = v.status === 'at_stop' ? Math.max(0, v.until - now) : 0;
              eta = Math.max(now + dwell + drive, sched - 90);
              status = 'approaching';
            }
            load = v.load;
          } else if (v) {
            const ready = readyFor(game, v, trip);
            const depart = Math.max(trip.dep, ready);
            eta = depart + (j === 0 ? 0 : sch[j]);
            if (j === 0 && v.trip === trip.id && v.status === 'at_stop') status = 'boarding';
          }
          if (eta < now - 30) continue;
          out.push({
            route: r.id,
            pat: p.index,
            trip: trip.id,
            veh: v?.id ?? null,
            eta,
            sched,
            towards: towards(game, p),
            status,
            delayMin: Math.round((eta - sched) / 60),
            terminates: j === p.stops.length - 1,
            load,
            capacity: v ? MODEL[v.model].capacity : null,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.eta - b.eta).slice(0, limit);
}

export interface StopEta {
  stop: Id;
  index: number;
  eta: number;
  sched: number;
}

/** The vehicle's remaining stops on its current trip with predicted times. */
export function vehicleStops(game: Game, v: Vehicle): StopEta[] {
  if (v.trip === null || v.pos.kind !== 'pattern') return [];
  const trip = game.trip(v.trip);
  const p = game.pattern(v.pos.route, v.pos.pat);
  if (!trip || !p) return [];
  const sch = game.schedule(trip.route, trip.pat, trip.dep);
  const now = game.t;
  const out: StopEta[] = [];
  const dwell = v.status === 'at_stop' ? Math.max(0, v.until - now) : 0;
  const start = trip.state === TripState.Running ? v.stopIdx : 0;
  for (let j = start; j < p.stops.length; j++) {
    const sched = trip.dep + (j === 0 ? 0 : sch ? sch[j] : 0);
    let eta: number;
    if (trip.state !== TripState.Running) eta = Math.max(trip.dep, now) + (j === 0 ? 0 : sch ? sch[j] : 0);
    else if (j === v.stopIdx && v.status === 'at_stop') eta = now;
    else eta = Math.max(now + dwell + driveSeconds(game, p, v, v.pos.s, p.stopS[j], v.stopIdx, j), sched - 90);
    out.push({ stop: p.stops[j], index: j, eta, sched });
  }
  return out;
}
