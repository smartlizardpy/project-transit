// Vehicle operations: dispatching buses to timetabled trips, driving them along the road
// network, serving stops, layovers, deadhead runs to and from the depot, wear, maintenance
// and breakdowns. Buses only ever move along road paths; they never jump between places.

import type { Game } from './engine.ts';
import type { Pattern } from './network.ts';
import { buildPath, edgeSpeedFn, pointAt, segmentAt, step, type Path } from './paths.ts';
import { ECON, MODEL, SERVICE } from './content.ts';
import { TripState, type Id, type Trip, type Vehicle } from './types.ts';
import { accrueCost, post } from './finance.ts';
import { notify, recordBoardings, recordDeparture, recordLoad, recordMissed } from './progress.ts';
import { recDepart, recMaintenance, recRun, recVehicleMinute } from './analytics/record.ts';
import { departWanted, simEvent } from './automation/events.ts';
import { occupied, offloadAll, serveStop, stopNeeded } from './passengers.ts';
import { edgeBetween, routeWithFallback } from './world/graph.ts';
import { hhmm } from './time.ts';

/** Time to get a parked bus and its driver ready, seconds. */
export const PREP = 6 * 60;
/** Idle buses with no work go back to the depot after this long, seconds. */
const IDLE_TIMEOUT = 20 * 60;
/** How far ahead the dispatcher plans, seconds. */
const LOOKAHEAD = 75 * 60;
const DECEL = 1.3;

export const STATUS_LABEL: Record<Vehicle['status'], string> = {
  parked: 'Parked',
  preparing: 'Preparing',
  to_route: 'Travelling to route',
  in_service: 'In service',
  at_stop: 'Stopped for boarding',
  layover: 'Waiting at terminus',
  to_depot: 'Returning to depot',
  maintenance: 'Under maintenance',
  broken: 'Broken down',
};

/** Staffed statuses pay a driver. */
const STAFFED = new Set<Vehicle['status']>(['preparing', 'to_route', 'in_service', 'at_stop', 'layover', 'to_depot', 'broken']);
const MOVING = new Set<Vehicle['status']>(['to_route', 'in_service', 'to_depot']);

export function kinematics(v: Vehicle) {
  const m = MODEL[v.model];
  return { accel: m.accel, decel: DECEL, speed: m.speed };
}

// ───────────────────────────────────────────── positions

/** Path the vehicle is currently moving along, or null when it is in the depot. */
export function vehiclePath(game: Game, v: Vehicle): Path | null {
  const pos = v.pos;
  if (pos.kind === 'pattern') return game.pattern(pos.route, pos.pat)?.path ?? null;
  if (pos.kind === 'path') {
    let p = game.vpaths.get(v.id);
    if (!p || p.nodes.length !== pos.nodes.length || p.nodes[0] !== pos.nodes[0] || p.nodes[p.nodes.length - 1] !== pos.nodes[pos.nodes.length - 1]) {
      const g = game.region.graph;
      const de: number[] = [];
      for (let i = 0; i + 1 < pos.nodes.length; i++) de.push(edgeBetween(g, pos.nodes[i], pos.nodes[i + 1]));
      p = buildPath(g, pos.nodes, de);
      game.vpaths.set(v.id, p);
    }
    return p;
  }
  return null;
}

/** Road node the vehicle is at or heading towards, and the edge it arrived on. */
export function vehicleNode(game: Game, v: Vehicle): { node: number; prevEdge: number; seg: number } {
  const p = vehiclePath(game, v);
  if (!p || v.pos.kind === 'depot') {
    const d = game.state.depots[v.depot];
    return { node: d?.node ?? 0, prevEdge: -1, seg: 0 };
  }
  const s = v.pos.s;
  if (s >= p.length - 0.5) return { node: p.nodes[p.nodes.length - 1], prevEdge: p.dedges[p.dedges.length - 1] ?? -1, seg: p.nodes.length - 1 };
  if (s <= 0.01) return { node: p.nodes[0], prevEdge: -1, seg: 0 };
  const i = segmentAt(p, s);
  return { node: p.nodes[i + 1], prevEdge: p.dedges[i] ?? -1, seg: i };
}

/** World position (local metres) and heading of a vehicle. */
export function vehicleXY(game: Game, v: Vehicle): { x: number; y: number; heading: number } | null {
  const p = vehiclePath(game, v);
  if (!p || v.pos.kind === 'depot') return null;
  const s = v.pos.s;
  const a = pointAt(p, s);
  const b = pointAt(p, Math.min(p.length, s + 6), a.i);
  const c = s + 6 > p.length ? pointAt(p, Math.max(0, s - 6), a.i) : null;
  const heading = c ? Math.atan2(a.y - c.y, a.x - c.x) : Math.atan2(b.y - a.y, b.x - a.x);
  return { x: a.x, y: a.y, heading };
}

// ───────────────────────────────────────────── trips

export function tripSchedule(game: Game, trip: Trip): Float32Array | null {
  return game.schedule(trip.route, trip.pat, trip.dep);
}

function patternStartNode(game: Game, route: Id, pat: number): number {
  const p = game.pattern(route, pat);
  return p?.valid ? p.path.nodes[0] : -1;
}

function patternEndNode(game: Game, route: Id, pat: number): number {
  const p = game.pattern(route, pat);
  return p?.valid ? p.path.nodes[p.path.nodes.length - 1] : -1;
}

function release(game: Game, id: number | null) {
  if (id === null) return;
  const t = game.trip(id);
  if (t && t.state === TripState.Assigned) {
    t.state = TripState.Planned;
    t.veh = null;
  }
}

/** Should this bus stop taking work (withdrawn, being sold, needs service, reassigned)? */
function leaving(v: Vehicle, route: Id | null) {
  return v.withdraw || v.sell || v.wantsService || v.route === null || (route !== null && v.route !== route);
}

// ───────────────────────────────────────────── dispatch

type Candidate = { v: Vehicle; ready: number; kind: 'depot' | 'idle' | 'running' };

function candidate(game: Game, v: Vehicle, startNode: number, now: number): Candidate | null {
  if (leaving(v, v.route) || v.handover) return null;
  const st = v.status;
  if (st === 'parked' && v.pos.kind === 'depot') {
    const d = game.state.depots[v.depot];
    if (!d) return null;
    return { v, ready: now + PREP + game.travelSeconds(d.node, startNode), kind: 'depot' };
  }
  if (st === 'layover' && v.trip === null) {
    const { node } = vehicleNode(game, v);
    return { v, ready: Math.max(now, v.until) + game.travelSeconds(node, startNode), kind: 'idle' };
  }
  if (v.trip !== null && v.next === null && ['in_service', 'at_stop', 'layover', 'preparing', 'to_route'].includes(st)) {
    const trip = game.trip(v.trip);
    if (!trip || trip.route !== v.route) return null;
    const sch = tripSchedule(game, trip);
    if (!sch) return null;
    const lateBy = st === 'preparing' || st === 'to_route' ? Math.max(0, v.until - trip.dep) : Math.max(0, v.delay);
    const end = trip.dep + sch[sch.length - 1] + lateBy;
    const layover = (game.state.routes[trip.route]?.timetable.layover ?? 4) * 60;
    return { v, ready: end + layover + game.travelSeconds(patternEndNode(game, trip.route, trip.pat), startNode), kind: 'running' };
  }
  return null;
}

export function lateTolerance(headwayMin: number | null): number {
  const h = headwayMin ?? 15;
  return Math.max(4, Math.min(15, h * 0.6)) * 60;
}

/** Give every upcoming trip a bus: one already on the line, an idle one, or one from the depot. */
export function dispatch(game: Game) {
  const state = game.state;
  const now = state.clock.t;
  for (const r of Object.values(state.routes)) {
    const trips = state.trips[r.id];
    if (!trips?.length) continue;
    const fleet = r.vehicles.map((id) => state.vehicles[id]).filter((v): v is Vehicle => !!v && v.route === r.id);
    for (const trip of trips) {
      if (trip.state !== TripState.Planned) continue;
      if (trip.dep > now + LOOKAHEAD) break;
      const tol = lateTolerance(game.headwayAt(r.id, trip.pat, trip.dep));
      const startNode = patternStartNode(game, r.id, trip.pat);
      if (r.suspended || startNode < 0) {
        if (now > trip.dep + tol) trip.state = TripState.Missed;
        continue;
      }
      let onLine: Candidate | null = null, depot: Candidate | null = null;
      for (const v of fleet) {
        const c = candidate(game, v, startNode, now);
        if (!c) continue;
        if (c.kind === 'depot') {
          if (!depot || c.ready < depot.ready) depot = c;
        } else if (!onLine || c.ready < onLine.ready) onLine = c;
      }
      let pick: Candidate | null = null;
      if (onLine && onLine.ready <= trip.dep + 60) pick = onLine;
      else if (depot && depot.ready + 180 >= trip.dep && (!onLine || depot.ready <= onLine.ready)) pick = depot;
      else if (onLine && onLine.ready <= trip.dep + tol && (!depot || onLine.ready < depot.ready)) pick = onLine;
      else if (depot && depot.ready + 180 >= trip.dep) pick = depot;
      if (pick) assign(game, pick, trip, startNode);
      else if (now > trip.dep + tol) missTrip(game, trip, onLine || depot ? 'late' : 'none');
    }
  }
}

function assign(game: Game, c: Candidate, trip: Trip, startNode: number) {
  const v = c.v;
  const now = game.state.clock.t;
  trip.state = TripState.Assigned;
  trip.veh = v.id;
  if (c.kind === 'running') {
    v.next = trip.id;
    return;
  }
  v.trip = trip.id;
  v.target = { route: trip.route, pat: trip.pat };
  if (c.kind === 'depot') {
    setStatus(v, 'preparing', now);
    v.until = now + PREP;
    return;
  }
  // idle at a terminus
  const here = vehicleNode(game, v);
  if (here.node === startNode) {
    v.pos = { kind: 'pattern', route: trip.route, pat: trip.pat, s: 0 };
    v.stopIdx = 0;
  } else {
    startDeadhead(game, v, startNode, 'route');
  }
}

// ───────────────────────────────────────────── extra departures

export interface ExtraOption {
  v: Vehicle;
  /** when the bus could be at the first stop, ready to leave */
  ready: number;
  from: 'depot' | 'terminus';
  /** seconds of empty running to the first stop */
  deadhead: number;
}

/**
 * Could this bus run an extra trip starting at `startNode`? Only buses with nothing to do can:
 * parked at the depot (and not due for service or being sold), or waiting at a terminus with
 * no trip. A bus carrying passengers is never taken off its trip.
 */
export function extraOption(game: Game, v: Vehicle, startNode: number, now: number): ExtraOption | null {
  if (v.sell || v.withdraw || v.wantsService || v.trip !== null || v.next !== null) return null;
  if (v.status === 'parked' && v.pos.kind === 'depot') {
    const d = game.state.depots[v.depot];
    if (!d) return null;
    const dh = game.travelSeconds(d.node, startNode);
    return { v, ready: now + PREP + dh, from: 'depot', deadhead: dh };
  }
  if (v.status === 'layover' && v.load === 0) {
    const { node } = vehicleNode(game, v);
    const dh = game.travelSeconds(node, startNode);
    return { v, ready: Math.max(now, v.until) + dh, from: 'terminus', deadhead: dh };
  }
  return null;
}

/** Give `trip` (already in the trip list) to the bus of `opt`: it prepares or drives to the start. */
export function startExtra(game: Game, opt: ExtraOption, trip: Trip, startNode: number) {
  assign(game, { v: opt.v, ready: opt.ready, kind: opt.from === 'depot' ? 'depot' : 'idle' }, trip, startNode);
}


// ───────────────────────────────────────────── moving between depots

/**
 * Make `depotId` the bus's home depot. A parked bus drives there now (an empty run on the
 * road, like any trip to a depot); a bus that is out at work goes there the next time it
 * returns. Callers check that the move is allowed (see Game.moveToDepot).
 */
export function transferDepot(game: Game, v: Vehicle, depotId: Id): 'driving' | 'later' {
  const now = game.state.clock.t;
  const from = game.state.depots[v.depot];
  const to = game.state.depots[depotId];
  if (v.status === 'parked' && v.pos.kind === 'depot') {
    const fromNode = from?.node ?? to.node;
    v.depot = depotId;
    if (fromNode === to.node) return 'driving';
    const leg = routeWithFallback(game.region.graph, fromNode, to.node, {});
    v.pos = { kind: 'path', nodes: leg ? leg.nodes : [fromNode], s: 0, to: 'depot' };
    game.vpaths.delete(v.id);
    setStatus(v, 'to_depot', now);
    return 'driving';
  }
  v.depot = depotId;
  if (v.status === 'to_depot') {
    startDeadhead(game, v, to.node, 'depot');
    return 'driving';
  }
  return 'later';
}

function missTrip(game: Game, trip: Trip, why: 'late' | 'none') {
  trip.state = TripState.Missed;
  recordMissed(game.state, trip.route);
  const r = game.state.routes[trip.route];
  if (!r) return;
  simEvent(game, 'missed', { line: r.id, lineNumber: r.number, dep: hhmm(trip.dep), trip: trip.id, reason: why });
  const last = game.missNotice.get(r.id) ?? -Infinity;
  if (game.state.clock.t - last > 2 * 3600) {
    game.missNotice.set(r.id, game.state.clock.t);
    const req = game.requirement(r.id);
    const have = r.vehicles.length;
    const body =
      req && req.peak > have
        ? `Line ${r.number} needs ${req.peak} buses for its timetable (${req.peakLabel}) but only ${have} ${have === 1 ? 'is' : 'are'} assigned.`
        : why === 'late'
          ? `Buses were running too late to make this departure. Allow more layover time, run less often at peak, or add a bus.`
          : `No bus was free. Buses may be broken down, in maintenance or being sold.`;
    notify(game, 'warn', `Line ${r.number} missed the ${hhmm(trip.dep)} departure`, body, { kind: 'route', id: r.id });
  }
}

// ───────────────────────────────────────────── movement

function setStatus(v: Vehicle, s: Vehicle['status'], now: number) {
  if (v.status !== s) {
    v.status = s;
    v.since = now;
  }
}

/** Send a vehicle along the road network from where it is to `toNode`. */
export function startDeadhead(game: Game, v: Vehicle, toNode: number, to: 'route' | 'depot') {
  const g = game.region.graph;
  const now = game.state.clock.t;
  const p = vehiclePath(game, v);
  let nodes: number[];
  let s0 = 0;
  let from: number, prevEdge = -1;
  if (!p || v.pos.kind === 'depot') {
    from = game.state.depots[v.depot]?.node ?? toNode;
  } else {
    const s = v.pos.s;
    if (s >= p.length - 0.5 || s <= 0.01) {
      // a bus standing at the end of its path (e.g. at a terminus) may turn round
      from = vehicleNode(game, v).node;
    } else {
      // mid-segment: keep the current segment so the bus continues smoothly
      const i = segmentAt(p, s);
      from = p.nodes[i + 1];
      prevEdge = p.dedges[i];
      s0 = s - p.cum[i];
      const leg = routeWithFallback(g, from, toNode, { prevEdge });
      nodes = leg ? [p.nodes[i], ...leg.nodes] : [p.nodes[i], from];
      v.pos = { kind: 'path', nodes, s: s0, to };
      game.vpaths.delete(v.id);
      setStatus(v, to === 'route' ? 'to_route' : 'to_depot', now);
      return;
    }
  }
  const leg = from === toNode ? null : routeWithFallback(g, from, toNode, { prevEdge });
  nodes = leg ? leg.nodes : [from];
  v.pos = { kind: 'path', nodes, s: 0, to };
  game.vpaths.delete(v.id);
  setStatus(v, to === 'route' ? 'to_route' : 'to_depot', now);
}

/**
 * Re-express a vehicle's position on a line as a short standalone road path, so it keeps its
 * exact place on the street even if the line is edited or deleted underneath it.
 */
export function detachFromPattern(game: Game, v: Vehicle, to: 'route' | 'depot' = 'depot') {
  if (v.pos.kind !== 'pattern') return;
  const p = vehiclePath(game, v);
  if (!p || p.nodes.length < 2) return;
  const s = Math.max(0, Math.min(p.length, v.pos.s));
  const i = Math.min(segmentAt(p, s), p.nodes.length - 2);
  v.pos = { kind: 'path', nodes: [p.nodes[i], p.nodes[i + 1]], s: s - p.cum[i], to };
  game.vpaths.delete(v.id);
}

export function sendToDepot(game: Game, v: Vehicle) {
  const d = game.state.depots[v.depot];
  if (!d) return;
  release(game, v.next);
  v.next = null;
  if (v.trip !== null) {
    const t = game.trip(v.trip);
    if (t && t.state === TripState.Assigned) release(game, v.trip);
    v.trip = null;
  }
  v.target = undefined;
  if (v.pos.kind === 'depot') {
    arriveDepot(game, v);
    return;
  }
  startDeadhead(game, v, d.node, 'depot');
}

function arriveDepot(game: Game, v: Vehicle) {
  const now = game.state.clock.t;
  v.pos = { kind: 'depot' };
  v.v = 0;
  v.trip = null;
  v.target = undefined;
  game.vpaths.delete(v.id);
  setStatus(v, 'parked', now);
  if (v.sell) {
    game.sellNow(v.id);
    return;
  }
  v.withdraw = false;
  if (v.wantsService || v.condition < game.state.settings.serviceBelow) startMaintenance(game, v);
}

export function startMaintenance(game: Game, v: Vehicle) {
  const m = MODEL[v.model];
  const now = game.state.clock.t;
  const points = Math.max(0, (1 - v.condition) * 100);
  const cost = Math.round(v.price * m.serviceCost * (1 - v.condition) + 150);
  post(game.state, { amt: -cost, cat: 'maintenance', memo: `Service for ${v.fleetNo} (${Math.round(v.condition * 100)}% condition)`, veh: v.id, route: v.route ?? undefined });
  recMaintenance(game.state, v, cost);
  setStatus(v, 'maintenance', now);
  v.until = now + Math.max(SERVICE.minMinutes, points * SERVICE.minutesPerPoint) * 60;
  v.wantsService = false;
}

function speedFor(game: Game, p: Path, v: Vehicle) {
  const traffic = game.traffic;
  const now = game.state.clock.t;
  const road = traffic.conditions(now);
  return edgeSpeedFn(game.region.graph, p, (de) => traffic.speedFactor(traffic.congestion(de, now)) * road, kinematics(v));
}

function move(game: Game, v: Vehicle, p: Path, stopAt: number, dt: number): boolean {
  const pos = v.pos as { s: number };
  const before = pos.s;
  const r = step(p, pos.s, v.v, dt, stopAt, kinematics(v), speedFor(game, p, v), game.segHint.get(v.id) ?? 0);
  game.segHint.set(v.id, r.seg);
  pos.s = r.s;
  v.v = r.v;
  const ds = Math.max(0, r.s - before);
  if (ds > 0) {
    const m = MODEL[v.model];
    const km = ds / 1000;
    v.km += km;
    v.condition = Math.max(0, v.condition - m.wearPerKm * km);
    accrueCost(game.state, 'fuel', v.route ?? v.target?.route ?? '', km * m.energyPerKm * (m.electric ? ECON.electricPrice : ECON.fuelPrice));
  }
  return r.arrived;
}

/** Dwell time for a stop event, seconds (`extra`: more seconds to board with luggage or bags). */
export function dwellTime(v: Vehicle, board: number, alight: number, extra = 0): number {
  const m = MODEL[v.model];
  const boardDoors = m.doors >= 3 ? 2 : 1;
  const alightDoors = Math.max(1, m.doors - 1);
  const crowd = occupied(v) / m.capacity > 0.8 ? 1.3 : 1;
  return Math.round(10 + Math.max((board * 2.4 + extra) / boardDoors, (alight * 1.5) / alightDoors) * crowd);
}

function decideDistance(v: Vehicle) {
  return (v.v * v.v) / (2 * DECEL) + 25;
}

/** Advance one vehicle by dt seconds. */
export function tickVehicle(game: Game, v: Vehicle, dt: number) {
  const now = game.state.clock.t;
  switch (v.status) {
    case 'parked':
      return;
    case 'maintenance':
      if (now >= v.until) {
        v.condition = 1;
        setStatus(v, 'parked', now);
        notify(game, 'info', `${v.fleetNo} is back from maintenance`, undefined, { kind: 'vehicle', id: v.id });
      }
      return;
    case 'preparing':
      if (now >= v.until) {
        const trip = v.trip !== null ? game.trip(v.trip) : null;
        const node = trip ? patternStartNode(game, trip.route, trip.pat) : -1;
        if (!trip || node < 0) return sendToDepot(game, v);
        startDeadhead(game, v, node, 'route');
      }
      return;
    case 'broken':
      if (now >= v.until) {
        v.condition = Math.min(1, v.condition + 0.08);
        v.wantsService = true;
        sendToDepot(game, v);
      }
      return;
    case 'to_route':
    case 'to_depot': {
      const p = vehiclePath(game, v);
      if (!p || v.pos.kind !== 'path') return;
      if (p.length < 0.5 || move(game, v, p, p.length, dt)) {
        if (v.pos.to === 'depot') return arriveDepot(game, v);
        return arriveTerminus(game, v);
      }
      return;
    }
    case 'layover': {
      if (v.pos.kind !== 'pattern') return;
      if (v.trip === null) return;
      const trip = game.trip(v.trip);
      if (!trip) {
        v.trip = null;
        return;
      }
      // open the doors shortly before departure
      if (now >= trip.dep - 45 && now >= v.until) beginTrip(game, v, trip);
      return;
    }
    case 'at_stop': {
      if (now < v.until) return;
      if (v.pos.kind !== 'pattern') return;
      const p = game.pattern(v.pos.route, v.pos.pat);
      const trip = v.trip !== null ? game.trip(v.trip) : null;
      if (!p || !trip) return abortService(game, v);
      departStop(game, v, p, trip);
      return;
    }
    case 'in_service': {
      if (v.pos.kind !== 'pattern') return;
      const p = game.pattern(v.pos.route, v.pos.pat);
      const trip = v.trip !== null ? game.trip(v.trip) : null;
      if (!p || !trip) return abortService(game, v);
      const last = p.stops.length - 1;
      // skip stops nobody needs once close enough for the driver to see
      while (v.stopIdx < last && p.stopS[v.stopIdx] - v.pos.s <= decideDistance(v) && !stopNeeded(game, v, p, v.stopIdx)) {
        const sch = tripSchedule(game, trip);
        if (sch) v.delay = now - (trip.dep + sch[v.stopIdx]);
        v.stopIdx++;
      }
      if (move(game, v, p.path, p.stopS[v.stopIdx], dt)) arriveStop(game, v, p, trip);
      return;
    }
  }
}

function arriveTerminus(game: Game, v: Vehicle) {
  const now = game.state.clock.t;
  const trip = v.trip !== null ? game.trip(v.trip) : null;
  const target = trip ? { route: trip.route, pat: trip.pat } : v.target;
  v.v = 0;
  game.vpaths.delete(v.id);
  if (!target || !game.pattern(target.route, target.pat)) return sendToDepot(game, v);
  v.pos = { kind: 'pattern', route: target.route, pat: target.pat, s: 0 };
  v.stopIdx = 0;
  setStatus(v, 'layover', now);
  v.until = now;
}

function beginTrip(game: Game, v: Vehicle, trip: Trip) {
  const p = game.pattern(trip.route, trip.pat);
  if (!p || !p.valid) {
    trip.state = TripState.Missed;
    v.trip = null;
    return;
  }
  trip.state = TripState.Running;
  trip.veh = v.id;
  v.pos = { kind: 'pattern', route: trip.route, pat: trip.pat, s: 0 };
  v.stopIdx = 0;
  v.delay = 0;
  arriveStop(game, v, p, trip);
}

function arriveStop(game: Game, v: Vehicle, p: Pattern, trip: Trip) {
  const now = game.state.clock.t;
  v.v = 0;
  const sch = tripSchedule(game, trip);
  if (sch && v.stopIdx > 0) v.delay = now - (trip.dep + sch[v.stopIdx]);
  // measured run time since the last stop departure (stops nobody needed are passed through)
  const seg = v.seg;
  if (seg && v.stopIdx > 0 && seg.trip === trip.id && seg.i < v.stopIdx) {
    const scheduled = sch ? sch[v.stopIdx] - (seg.i === 0 ? 0 : sch[seg.i] + 22) : 0;
    recRun(game.state, p, seg.i, v.stopIdx, now - seg.t, scheduled);
  }
  delete v.seg;
  const ev = serveStop(game, v, p, v.stopIdx);
  if (ev.board) recordBoardings(game.state, p.route, ev.board);
  const dwell = v.stopIdx === p.stops.length - 1 ? 8 + ev.alight * 0.8 : dwellTime(v, ev.board, ev.alight, ev.extra);
  setStatus(v, 'at_stop', now);
  v.until = now + dwell;
  if (v.stopIdx === 0) v.until = Math.max(v.until, trip.dep);
  game.emitStop(p.stops[v.stopIdx], v.id, ev);
  if (ev.leftBehind && game.autoWants.has('leftBehind')) {
    const stop = p.stops[v.stopIdx];
    simEvent(game, 'leftBehind', { vehicle: v.id, fleetNo: v.fleetNo, line: p.route, lineNumber: game.state.routes[p.route]?.number ?? '', stop, stopName: game.state.stops[stop]?.name ?? '', leftBehind: ev.leftBehind, occupancy: Math.round((occupied(v) / MODEL[v.model].capacity) * 100), trip: trip.id });
  }
  if (game.autoWants.has('arrive')) {
    const stop = p.stops[v.stopIdx];
    simEvent(game, 'arrive', { vehicle: v.id, fleetNo: v.fleetNo, line: p.route, lineNumber: game.state.routes[p.route]?.number ?? '', stop, stopName: game.state.stops[stop]?.name ?? '', load: v.load, occupancy: Math.round((occupied(v) / MODEL[v.model].capacity) * 100), delay: Math.round(Math.max(0, v.delay) / 6) / 10, boarded: ev.board, alighted: ev.alight, leftBehind: ev.leftBehind, trip: trip.id });
  }
}

function departStop(game: Game, v: Vehicle, p: Pattern, trip: Trip) {
  const now = game.state.clock.t;
  const last = p.stops.length - 1;
  const sch = tripSchedule(game, trip);
  if (v.stopIdx >= last) return finishTrip(game, v, p, trip);
  if (sch) {
    // scheduled departure = arrival + average dwell (first stop: the departure time itself)
    const schedDep = trip.dep + (v.stopIdx === 0 ? 0 : sch[v.stopIdx] + 22);
    const early = schedDep - now;
    if (early > 90 && v.stopIdx > 0) {
      // running early: wait at the stop to keep to the timetable (and let more people board)
      v.until = now + Math.min(early - 20, 300);
      const ev = serveStop(game, v, p, v.stopIdx);
      if (ev.board) recordBoardings(game.state, p.route, ev.board);
      return;
    }
    v.delay = now - schedDep;
    if (v.stopIdx === 0) trip.startDelay = v.delay;
  }
  recordLoad(game.state, p.route, occupied(v) / MODEL[v.model].capacity);
  recDepart(game.state, p, v.stopIdx, v, MODEL[v.model].capacity, sch ? v.delay : 0);
  v.seg = { trip: trip.id, i: v.stopIdx, t: now };
  if (game.autoWants.has('depart')) {
    const occupancy = Math.round((occupied(v) / MODEL[v.model].capacity) * 100);
    const delay = sch ? Math.round(Math.max(0, v.delay) / 6) / 10 : 0;
    if (departWanted(game, delay, occupancy)) {
      const stop = p.stops[v.stopIdx];
      simEvent(game, 'depart', { vehicle: v.id, fleetNo: v.fleetNo, line: p.route, lineNumber: game.state.routes[p.route]?.number ?? '', stop, stopName: game.state.stops[stop]?.name ?? '', load: v.load, occupancy, delay, trip: trip.id });
    }
  }
  v.stopIdx++;
  setStatus(v, 'in_service', now);
}

function finishTrip(game: Game, v: Vehicle, p: Pattern, trip: Trip) {
  const now = game.state.clock.t;
  trip.state = TripState.Done;
  trip.endDelay = v.delay;
  const worst = Math.max(trip.startDelay ?? 0, v.delay);
  recordDeparture(game.state, trip.route, worst);
  v.trip = null;
  // anyone still on board (should be nobody) gets off here
  if (v.load > 0) offloadAll(game, v, p.stops[p.stops.length - 1]);
  if (leaving(v, trip.route)) {
    release(game, v.next);
    v.next = null;
    return sendToDepot(game, v);
  }
  const layover = (game.state.routes[trip.route]?.timetable.layover ?? 4) * 60;
  v.until = now + Math.min(layover, 90);
  setStatus(v, 'layover', now);
  if (v.next !== null) {
    const next = game.trip(v.next);
    v.next = null;
    if (next && next.state === TripState.Assigned && next.veh === v.id) {
      v.trip = next.id;
      v.target = { route: next.route, pat: next.pat };
      const startNode = patternStartNode(game, next.route, next.pat);
      if (startNode === vehicleNode(game, v).node) {
        v.pos = { kind: 'pattern', route: next.route, pat: next.pat, s: 0 };
        v.stopIdx = 0;
      } else startDeadhead(game, v, startNode, 'route');
    }
  }
}

/** The line changed or vanished under a running bus: drop the trip, keep passengers safe. */
export function abortService(game: Game, v: Vehicle) {
  const p = v.pos.kind === 'pattern' ? game.pattern(v.pos.route, v.pos.pat) : null;
  const stop = p ? p.stops[Math.min(v.stopIdx, p.stops.length - 1)] : null;
  if (v.load > 0) offloadAll(game, v, stop && game.state.stops[stop] ? stop : null);
  if (v.trip !== null) {
    const t = game.trip(v.trip);
    if (t && (t.state === TripState.Running || t.state === TripState.Assigned)) t.state = TripState.Missed;
  }
  v.trip = null;
  release(game, v.next);
  v.next = null;
  sendToDepot(game, v);
}

/** Per-minute checks: driver hours, breakdowns, auto-service, idle buses. */
export function minuteVehicles(game: Game) {
  const state = game.state;
  const now = state.clock.t;
  const wage = ECON.driverPerHour / 60;
  for (const v of game.vehicleList()) {
    recVehicleMinute(state, v);
    if (STAFFED.has(v.status)) accrueCost(state, 'driver', v.route ?? v.target?.route ?? '', wage);
    if (MOVING.has(v.status) && v.condition < SERVICE.breakdownBelow) {
      const m = MODEL[v.model];
      const p = (SERVICE.breakdownBelow - v.condition) * 0.012 * (2 - m.reliability);
      if (game.random() < p) breakDown(game, v);
    }
    if (state.settings.autoService && v.condition < state.settings.serviceBelow && !v.wantsService && v.status !== 'maintenance') v.wantsService = true;
      if (v.handover && v.trip === null && v.next === null && v.status !== 'maintenance' && v.status !== 'broken') handOver(game, v);
    else if (v.status === 'layover' && v.trip === null) {
      if (leaving(v, v.pos.kind === 'pattern' ? v.pos.route : null) || now - v.since > IDLE_TIMEOUT) sendToDepot(game, v);
    }
    if (v.status === 'parked' && v.wantsService) startMaintenance(game, v);
  }
}

/** A bus that has run the trips it was given moves on: to its new line, or parked as a spare. */
function handOver(game: Game, v: Vehicle) {
  const h = v.handover!;
  delete v.handover;
  const route = h.route && game.state.routes[h.route] ? h.route : null;
  if (v.route === route) return;
  game.assignVehicle(v.id, route, h.src);
}

/** When a bus will have finished the trips it already has (absolute seconds), or null if it has none. */
export function workEnds(game: Game, v: Vehicle): number | null {
  const id = v.next ?? v.trip;
  if (id === null) return null;
  const trip = game.trip(id);
  if (!trip) return null;
  const sch = tripSchedule(game, trip);
  if (!sch) return null;
  return trip.dep + sch[sch.length - 1] + Math.max(0, v.delay);
}

function breakDown(game: Game, v: Vehicle) {
  const now = game.state.clock.t;
  const p = v.pos.kind === 'pattern' ? game.pattern(v.pos.route, v.pos.pat) : null;
  if (p && v.status === 'in_service') {
    const stop = p.stops[Math.min(v.stopIdx, p.stops.length - 1)];
    if (v.load > 0) offloadAll(game, v, stop);
    if (v.trip !== null) {
      const t = game.trip(v.trip);
      if (t) {
        t.state = TripState.Missed;
        recordMissed(game.state, t.route);
      }
    }
    v.trip = null;
  }
  release(game, v.next);
  v.next = null;
  v.v = 0;
  detachFromPattern(game, v);
  setStatus(v, 'broken', now);
  v.until = now + 40 * 60;
  simEvent(game, 'breakdown', { vehicle: v.id, fleetNo: v.fleetNo, line: v.route, lineNumber: v.route ? game.state.routes[v.route]?.number ?? '' : '', condition: Math.round(v.condition * 100) });
  const r = v.route ? game.state.routes[v.route] : null;
  notify(game, 'bad', `${v.fleetNo} has broken down`, `${r ? `Line ${r.number}: p` : 'P'}assengers were asked to wait for the next bus. Condition was ${Math.round(v.condition * 100)}%. Regular maintenance prevents breakdowns.`, { kind: 'vehicle', id: v.id });
}
