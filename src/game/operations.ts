// Control-room operations: holding a bus at a stop, moving one departure, turning a bus back
// early (a short turn), temporary detours, and route changes for the player to review. Each has
// a plan (a dry run with a plain-language explanation) and a commit; the command layer
// (commands.ts) uses both for the player and for automations. Everything acts through the
// vehicle simulation: buses drive every metre, nobody is charged twice, stops stay where they are.

import type { Game, Result, RouteDef } from './engine.ts';
import type { Pattern } from './network.ts';
import { buildPatterns } from './network.ts';
import { route as routeLeg, freeSpeed, type LngLat } from './world/graph.ts';
import { DAY, ECON, HOUR } from './content.ts';
import { TripState, type Detour, type Id, type Route, type Trip } from './types.ts';
import { hhmm } from './time.ts';
import { tripSchedule } from './vehicles.ts';
import { notify } from './progress.ts';
import { requirement, type RunProfile } from './timetable.ts';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });
const stopName = (game: Game, id: Id | undefined) => (id && game.state.stops[id]?.name) || 'a removed stop';
const towards = (game: Game, p: Pattern) => stopName(game, p.stops[p.stops.length - 1]);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A change with its sign: +1.2, −0.8 (a true minus sign), 0. */
const signed = (x: number, digits = 0) => {
  const v = Number(x.toFixed(digits));
  return v > 0 ? `+${v.toFixed(digits)}` : v < 0 ? `−${(-v).toFixed(digits)}` : (0).toFixed(digits);
};

export const HOLD_MAX = 10;
export const ADJUST_MAX = 15;
export const DETOUR_MAX_MIN = 6 * 60;

// ───────────────────────────────────────────── holding a bus

export interface HoldPlan {
  trip: number;
  stop: Id;
  index: number;
  text: string;
}

/**
 * Hold a bus at a stop on its current trip (or the trip it is about to start) for 1–10 minutes
 * after its normal stop. It keeps its doors open for anyone who turns up. Used to even out
 * bunched buses or to wait for people changing from a late bus.
 */
export function holdPlan(game: Game, id: Id, minutes: number, stop: Id | null): Result<HoldPlan> {
  const v = game.state.vehicles[id];
  if (!v) return fail('That bus no longer exists.');
  const m = Math.round(minutes);
  if (!(m >= 1 && m <= HOLD_MAX)) return fail(`A hold is between 1 and ${HOLD_MAX} minutes.`);
  const trip = v.trip !== null ? game.trip(v.trip) : undefined;
  if (!trip || !['in_service', 'at_stop', 'layover', 'to_route', 'preparing'].includes(v.status)) return fail(`${v.fleetNo} is not running a trip.`);
  const p = game.pattern(trip.route, trip.pat);
  if (!p) return fail(`${v.fleetNo} is not running a trip.`);
  const running = trip.state === TripState.Running;
  const from = running ? v.stopIdx : trip.from ?? 0;
  const last = p.stops.length - 1;
  let idx = from;
  if (stop) {
    idx = p.stops.indexOf(stop, from);
    if (idx < 0) return fail(`${stopName(game, stop)} is not ahead of ${v.fleetNo} on this trip.`);
    if (idx >= last) return fail(`The trip ends at ${stopName(game, stop)}: there is nothing to hold for.`);
  } else if (idx >= last) return fail(`${v.fleetNo} is about to finish its trip.`);
  const where = stopName(game, p.stops[idx]);
  const here = running && v.status === 'at_stop' && v.stopIdx === idx;
  const line = game.state.routes[trip.route]?.number ?? '?';
  const text = `${v.fleetNo} (line ${line}, towards ${towards(game, p)}) waits ${m} min at ${where}${here ? ', where it is now,' : ''} after its normal stop, with its doors open, then carries on about ${m} min later. The gap to the bus ahead grows and the bus behind closes up.`;
  return ok({ trip: trip.id, stop: p.stops[idx], index: idx, text });
}

export function holdVehicle(game: Game, id: Id, minutes: number, stop: Id | null, src: string): Result<HoldPlan> {
  const plan = holdPlan(game, id, minutes, stop);
  if (!plan.ok) return plan;
  game.state.vehicles[id].hold = { stop: plan.value.stop, min: Math.round(minutes), trip: plan.value.trip, src, set: game.t };
  return plan;
}

// ───────────────────────────────────────────── moving one departure

/** A line's departures that have not left yet, within `hours` (soonest first). */
export function upcomingTrips(game: Game, route: Id, hours = 3): Trip[] {
  const now = game.t;
  return (game.state.trips[route] ?? []).filter((x) => (x.state === TripState.Planned || x.state === TripState.Assigned) && x.dep > now && x.dep <= now + hours * HOUR);
}

export interface AdjustPlan {
  dep: number;
  text: string;
}

/**
 * Move one timetable departure earlier or later, by up to 15 minutes from its timetable time,
 * without changing the rest of the timetable. A timetable change puts it back.
 */
export function adjustPlan(game: Game, route: Id, tripId: number, minutes: number): Result<AdjustPlan> {
  const s = game.state;
  const r = s.routes[route];
  if (!r) return fail('That line no longer exists.');
  const trip = game.trip(tripId);
  if (!trip || trip.route !== route) return fail('That departure is no longer in the timetable.');
  if (trip.extra) return fail('That is an extra departure: cancel it and schedule another instead.');
  if (trip.state !== TripState.Planned && trip.state !== TripState.Assigned) return fail(`The ${hhmm(trip.dep)} departure has already left.`);
  const v = trip.veh ? s.vehicles[trip.veh] : null;
  if (v && v.trip === trip.id && v.status === 'at_stop') return fail(`${v.fleetNo} is already boarding for the ${hhmm(trip.dep)} departure.`);
  const m = Math.round(minutes);
  if (m === 0) return fail('Moving it by 0 minutes changes nothing.');
  const base = trip.adj?.from ?? trip.dep;
  const target = trip.dep + m * 60;
  if (Math.abs(target - base) > ADJUST_MAX * 60) return fail(`A departure can move at most ${ADJUST_MAX} minutes from its timetable time (${hhmm(base)}).`);
  const now = game.t;
  if (target < now + 5 * 60) return fail(`A departure can only be moved to 5 minutes from now or later (the earliest is ${hhmm(now + 5 * 60)}).`);
  const same = (s.trips[route] ?? []).filter((x) => x !== trip && x.pat === trip.pat && x.state !== TripState.Missed);
  if (same.some((x) => Math.abs(x.dep - target) < 60)) return fail(`Another departure in that direction leaves at ${hhmm(target)}.`);
  // earlier: the bus given this departure must be back in time
  if (m < 0 && v && v.next === trip.id && v.trip !== null) {
    const cur = game.trip(v.trip);
    const sch = cur ? tripSchedule(game, cur) : null;
    if (cur && sch) {
      const back = cur.dep + sch[sch.length - 1] + Math.max(0, v.delay) + r.timetable.layover * 60;
      if (back > target + 60) return fail(`${v.fleetNo}, which runs it, is only back at about ${hhmm(back)}. Move it by less, or later.`);
    }
  }
  const before = same.filter((x) => x.dep < target).at(-1);
  const after = same.find((x) => x.dep > target);
  const p = game.pattern(route, trip.pat);
  const gaps = [before ? `${Math.round((target - before.dep) / 60)} min after the one before` : '', after ? `${Math.round((after.dep - target) / 60)} min before the next` : ''].filter(Boolean).join(', ');
  const text = `Line ${r.number}’s ${hhmm(trip.dep)} departure${p ? ` towards ${towards(game, p)}` : ''} leaves at ${hhmm(target)} instead (${m > 0 ? '+' : ''}${m} min)${gaps ? `: ${gaps}` : ''}. The rest of the timetable stays as it is; a timetable change puts it back.`;
  return ok({ dep: target, text });
}

export function adjustDeparture(game: Game, route: Id, tripId: number, minutes: number, src: string): Result<AdjustPlan> {
  const plan = adjustPlan(game, route, tripId, minutes);
  if (!plan.ok) return plan;
  const trip = game.trip(tripId)!;
  trip.adj ??= { from: trip.dep, src };
  trip.dep = plan.value.dep;
  if (trip.dep === trip.adj.from) delete trip.adj;
  game.state.trips[route]?.sort((a, b) => a.dep - b.dep || a.pat - b.pat);
  return plan;
}

// ───────────────────────────────────────────── short turns

export interface TurnPlan {
  at: number;
  riders: number;
  text: string;
}

/**
 * Turn a bus back before the end of its line: it ends its trip at a stop ahead, everyone going
 * further gets off there for the next bus, and it runs back in the other direction from that stop
 * (as an extra trip that starts part-way). The standard way to get a late bus back on time or to
 * fill a gap in the other direction. Lines that go both ways only.
 */
export function turnPlan(game: Game, id: Id, stop: Id): Result<TurnPlan> {
  const s = game.state;
  const v = s.vehicles[id];
  if (!v) return fail('That bus no longer exists.');
  const trip = v.trip !== null ? game.trip(v.trip) : undefined;
  if (!trip || trip.state !== TripState.Running || (v.status !== 'in_service' && v.status !== 'at_stop') || v.pos.kind !== 'pattern') return fail(`${v.fleetNo} is not on a trip with passengers right now.`);
  const r = s.routes[trip.route];
  if (!r) return fail('That line no longer exists.');
  if (r.kind === 'loop') return fail(`Line ${r.number} is a loop: there is no other direction to turn into.`);
  const p = game.pattern(trip.route, trip.pat);
  const opp = game.pattern(trip.route, 1 - trip.pat);
  if (!p || !opp?.valid) return fail(`Line ${r.number} has no other direction to turn into.`);
  const k = p.stops.indexOf(stop, v.stopIdx);
  const last = p.stops.length - 1;
  if (k < 0) return fail(`${stopName(game, stop)} is not ahead of ${v.fleetNo} on this trip.`);
  if (k >= last) return fail(`The trip ends at ${stopName(game, stop)} anyway.`);
  const j = opp.stops.indexOf(stop);
  if (j < 0 || j >= opp.stops.length - 1) return fail(`Buses going the other way do not call at ${stopName(game, stop)}, so ${v.fleetNo} cannot turn back there.`);
  let riders = 0;
  for (const g of s.pax.onboard[v.id] ?? []) if (p.stops.indexOf(g.legs[g.leg].a, k + 1) > k) riders += g.n;
  const skipped = last - k;
  const text = `${v.fleetNo} ends its trip at ${stopName(game, stop)} instead of ${towards(game, p)}, then runs back towards ${towards(game, opp)} from there. ${riders ? `${plural(riders, 'person', 'people')} on board going further get off there and take the next bus (they have already paid).` : 'Nobody on board is going further.'} The ${plural(skipped, 'stop')} after it wait for the next bus.`;
  return ok({ at: k, riders, text });
}

export function shortTurn(game: Game, id: Id, stop: Id, src: string): Result<TurnPlan> {
  const plan = turnPlan(game, id, stop);
  if (!plan.ok) return plan;
  const v = game.state.vehicles[id];
  v.turn = { trip: v.trip!, at: plan.value.at, src };
  // already standing at that stop: turn back as soon as it is done there
  if (v.status === 'at_stop' && v.stopIdx === plan.value.at) v.until = Math.min(v.until, game.t);
  return plan;
}

// ───────────────────────────────────────────── temporary detours

export type DetourLeg = Pick<Detour, 'route' | 'pat' | 'leg' | 'key' | 'via' | 'prev' | 'why' | 'extra'>;

export interface DetourPlan {
  legs: DetourLeg[];
  /** stretches that cannot avoid the area, and why */
  skipped: string[];
  until: number;
  text: string;
}

const legKey = (r: Route, pat: number, leg: number) => `${r.kind === 'loop' || pat === 0 ? 'o' : 'r'}:${leg}`;

/** Free-flow driving seconds along a pattern's path from path index a to b. */
function pathSeconds(game: Game, p: Pattern, a: number, b: number) {
  const g = game.region.graph;
  let secs = 0;
  for (let i = a; i < b; i++) secs += g.len[p.path.dedges[i] >> 1] / freeSpeed(g, p.path.dedges[i] >> 1);
  return secs;
}

/**
 * Drive round an area for a while: every stretch of the line between two stops that passes
 * within `radius` metres of `at` takes the quickest other road between the same two stops.
 * Stops stay the same (a stop inside the area cannot be avoided, so its stretches are left as
 * they are). Used around a busy event, a traffic jam or a closure.
 */
export function detourPlan(game: Game, route: Id, at: LngLat, radius: number, minutes: number): Result<DetourPlan> {
  const s = game.state;
  const r = s.routes[route];
  if (!r) return fail('That line no longer exists.');
  if (r.suspended) return fail(`Line ${r.number} is suspended.`);
  const mins = Math.round(minutes);
  if (!(mins >= 15 && mins <= DETOUR_MAX_MIN)) return fail(`A detour lasts between 15 minutes and ${DETOUR_MAX_MIN / 60} hours.`);
  const rad = Math.round(radius);
  if (!(rad >= 100 && rad <= 800)) return fail('The area to avoid must be between 100 and 800 m across from its centre.');
  const g = game.region.graph;
  const [cx, cy] = game.geo.xy(at);
  const inside = (n: number) => Math.hypot(g.x[n] - cx, g.y[n] - cy) <= rad;
  const pats = (game.patterns.get(route) ?? []).filter((p) => p.valid);
  const old = game.patterns.get(route) ?? [];
  const busy = new Set((s.detours ?? []).filter((d) => d.route === route).map((d) => d.key));
  const enters = (p: Pattern, i: number) => p.path.nodes.slice(p.stopIdx[i] + 1, p.stopIdx[i + 1]).some(inside);
  const label = (p: Pattern, i: number) => `${stopName(game, p.stops[i])} and ${stopName(game, p.stops[i + 1])}`;
  /**
   * The quickest road between the two halts of stretch i of `p` that keeps out of the area, as
   * `pins` waypoints spread along it (more pins hold the bus to it more tightly); or why there is none.
   */
  const altFor = (p: Pattern, i: number, pins = 2): DetourLeg | string => {
    const a = p.stopIdx[i];
    const A = p.stopNodes[i], B = p.stopNodes[i + 1];
    const key = legKey(r, p.index, i);
    if (busy.has(key)) return `between ${label(p, i)} it is already on a detour`;
    if (inside(A) || inside(B)) return `${stopName(game, inside(A) ? p.stops[i] : p.stops[i + 1])} is inside the area, so buses still go there`;
    const opts = { prevEdge: a > 0 ? p.path.dedges[a - 1] : undefined, allowEdge: (e: number) => !inside(g.ea[e]) && !inside(g.eb[e]) };
    const alt = routeLeg(g, A, B, opts) ?? routeLeg(g, A, B, { ...opts, lenient: true });
    if (!alt) return `no other road links ${label(p, i)}`;
    // compared with the line's usual road on that stretch
    const base = old[p.index] ?? p;
    const usual = pathSeconds(game, base, base.stopIdx[i], base.stopIdx[i + 1]);
    if (alt.seconds > usual * 3 + 300) return `the only way round between ${label(p, i)} takes ${Math.round((alt.seconds - usual) / 60)} min longer`;
    // waypoints spread evenly along the way round pin the bus to that road
    const cum: number[] = [0];
    for (const de of alt.dedges) cum.push(cum[cum.length - 1] + g.len[de >> 1]);
    const total = cum[cum.length - 1];
    const via: LngLat[] = [];
    for (let q = 1; q <= pins; q++) {
      const f = q / (pins + 1);
      const k = Math.max(1, Math.min(alt.nodes.length - 2, cum.findIndex((c) => c >= total * f)));
      const n = alt.nodes[k];
      const ll = game.geo.P.toLngLat(g.x[n], g.y[n]);
      const pt: LngLat = [Math.round(ll[0] * 1e6) / 1e6, Math.round(ll[1] * 1e6) / 1e6];
      if (!via.some((x) => x[0] === pt[0] && x[1] === pt[1])) via.push(pt);
    }
    return { route, pat: p.index, leg: i, key, via, prev: r.via[key] ?? null, why: '', extra: Math.max(0, Math.round(alt.seconds - usual)) };
  };
  const legs: DetourLeg[] = [];
  const skipped: string[] = [];
  let near = false;
  for (const p of pats) {
    for (let i = 0; i + 1 < p.stops.length; i++) {
      if (!p.path.nodes.slice(p.stopIdx[i], p.stopIdx[i + 1] + 1).some(inside)) continue;
      near = true;
      const x = altFor(p, i);
      if (typeof x === 'string') skipped.push(x);
      else legs.push(x);
    }
  }
  if (!near) return fail(`Line ${r.number} does not pass within ${rad} m of there.`);
  // check the whole line with the detours: it must still be drivable and call at the same stops.
  // A stop next to a changed stretch may now be served from the other side of the road (people
  // wait by stop, not by kerb), which can change the stretch after it too: that one gets a way
  // round as well. A changed stretch that still runs into the area is left as it was.
  let verified = false;
  const pins = new Map<string, number>();
  const gaveUp = new Set<string>();
  for (let round = 0; round < 8 && legs.length; round++) {
    const via = { ...r.via };
    for (const l of legs) via[l.key] = l.via;
    const built = buildPatterns(s, game.region, game.geo, { ...r, via });
    if (!samePatterns(old, built)) return fail(`Line ${r.number} could not be driven that way round.`);
    let again = false;
    for (const p of built) {
      for (let i = 0; i + 1 < p.stops.length; i++) {
        const key = legKey(r, p.index, i);
        const mine = legs.find((l) => l.key === key);
        if (!enters(p, i)) continue;
        if (mine) {
          // the bus cut back into the area between two waypoints, or the halts moved: route it
          // again between this pattern's halts with more waypoints, or give that stretch up
          const n = Math.min(12, (pins.get(key) ?? 2) * 2);
          pins.set(key, n);
          const x = n <= 8 ? altFor(p, i, n) : 'gave up';
          legs.splice(legs.indexOf(mine), 1);
          if (typeof x !== 'string') legs.push(x);
          else {
            gaveUp.add(key);
            skipped.push(`between ${label(p, i)} the way round still passes through the area`);
          }
          again = true;
        } else if (!enters(old[p.index], i)) {
          const x = gaveUp.has(key) ? 'gave up' : altFor(p, i, pins.get(key) ?? 2);
          if (typeof x === 'string') return fail(`Driving round there would take line ${r.number} through the area between ${label(p, i)}.`);
          legs.push(x);
          again = true;
        }
      }
    }
    if (!again) {
      verified = true;
      break;
    }
  }
  if (legs.length && !verified) return fail(`No way round that area keeps line ${r.number} on the same stops.`);
  if (!legs.length) return fail(`No detour is possible for line ${r.number}: ${skipped[0] ?? 'no other road'}.`);
  const until = Math.round((game.t + mins * 60) / 60) * 60;
  const describe = (l: DetourLeg) => {
    const p = pats.find((x) => x.index === l.pat)!;
    return `between ${stopName(game, p.stops[l.leg])} and ${stopName(game, p.stops[l.leg + 1])}${pats.length > 1 ? ` (towards ${towards(game, p)})` : ''}`;
  };
  const worst = Math.max(...pats.map((p) => legs.filter((l) => l.pat === p.index).reduce((n, l) => n + l.extra, 0)));
  const text = `Line ${r.number} drives round the area until ${hhmm(until)}${Math.floor(until / DAY) !== Math.floor(game.t / DAY) ? ' tomorrow' : ''} ${legs.map(describe).join('; ')}. It adds about ${Math.max(1, Math.round(worst / 60))} min a trip at free-flow speed; the stops stay the same. A bus already on a changed stretch finishes it first.${skipped.length ? ` Not changed: ${skipped.join('; ')}.` : ''}`;
  return ok({ legs, skipped, until, text });
}

export function startDetour(game: Game, route: Id, at: LngLat, radius: number, minutes: number, src: string, why = ''): Result<DetourPlan> {
  const plan = detourPlan(game, route, at, radius, minutes);
  if (!plan.ok) return plan;
  const s = game.state;
  const list = (s.detours ??= []);
  for (const l of plan.value.legs) list.push({ ...l, why, id: (s.counters.detour = (s.counters.detour ?? 0) + 1), from: game.t, until: plan.value.until, src, state: 'start' });
  detourClock(game);
  return plan;
}

/** End a line's detours now (each stretch switches back once no bus is on it). */
export function endDetours(game: Game, route: Id): Result<number> {
  const list = game.state.detours ?? [];
  const mine = list.filter((d) => d.route === route);
  if (!mine.length) return fail('That line is not on a detour.');
  for (const d of mine) {
    if (d.state === 'start') list.splice(list.indexOf(d), 1);
    else d.state = 'end';
  }
  detourClock(game);
  return ok(mine.length);
}

export const detoursOf = (game: Game, route: Id) => (game.state.detours ?? []).filter((d) => d.route === route);

/** Rebuilt patterns that still run the same directions through the same stops. */
function samePatterns(old: Pattern[], built: Pattern[]) {
  return built.length === old.length && built.every((p, i) => p.valid && p.stops.length === old[i].stops.length && p.stops.every((x, k) => x === old[i].stops[k]));
}

/** No bus is driving this stretch right now (one standing at a stop is fine). */
function legClear(game: Game, d: Detour) {
  for (const v of game.vehicleList()) if (v.pos.kind === 'pattern' && v.pos.route === d.route && v.pos.pat === d.pat && v.status === 'in_service' && v.stopIdx === d.leg + 1) return false;
  return true;
}

/**
 * Give one stretch of a line new waypoints (or its own back) and move the buses on the line onto
 * the rebuilt path at the same place: same stop, or the same share of the way between two stops.
 * Fails (and changes nothing) if the line would no longer run through the same stops.
 */
function swapVia(game: Game, id: Id, key: string, via: LngLat[] | null): boolean {
  const s = game.state;
  const r = s.routes[id];
  const old = game.patterns.get(id);
  if (!r || !old) return false;
  const nv = { ...r.via };
  if (via?.length) nv[key] = via;
  else delete nv[key];
  const cand: Route = { ...r, via: nv };
  const built = buildPatterns(s, game.region, game.geo, cand);
  if (!samePatterns(old, built)) return false;
  s.routes[id] = cand;
  game.rebuildLine(id);
  const now = game.patterns.get(id)!;
  for (const v of game.vehicleList()) {
    if (v.pos.kind !== 'pattern' || v.pos.route !== id) continue;
    const po = old[v.pos.pat], pn = now[v.pos.pat];
    if (!po || !pn) continue;
    const i = Math.min(v.stopIdx, pn.stops.length - 1);
    if (v.status === 'in_service' && i > 0) {
      const a = po.stopS[i - 1], b = po.stopS[i];
      const f = b > a ? Math.max(0, Math.min(1, (v.pos.s - a) / (b - a))) : 0;
      v.pos.s = pn.stopS[i - 1] + f * (pn.stopS[i] - pn.stopS[i - 1]);
    } else v.pos.s = v.pos.s <= 0.01 ? 0 : pn.stopS[i];
    game.segHint.delete(v.id);
  }
  return true;
}

/** Each game minute: start detours whose stretch is clear, and end those that are due. */
export function detourClock(game: Game) {
  const list = game.state.detours;
  if (!list?.length) return;
  const now = game.t;
  const ended = new Set<Id>();
  for (const d of [...list]) {
    const r = game.state.routes[d.route];
    const drop = () => list.splice(list.indexOf(d), 1);
    if (!r) {
      drop();
      continue;
    }
    if (d.state === 'start') {
      if (now >= d.until) {
        drop();
        continue;
      }
      if (!legClear(game, d)) continue;
      if (swapVia(game, d.route, d.key, d.via)) d.state = 'on';
      else {
        drop();
        notify(game, 'warn', `Detour on line ${r.number} could not start`, 'The map or the line changed, so the way round no longer works. The line keeps its usual route.', { kind: 'route', id: r.id });
      }
      continue;
    }
    if (d.state === 'on' && now >= d.until) d.state = 'end';
    if (d.state === 'end' && legClear(game, d)) {
      // its own waypoints back; if even that cannot be rebuilt the line keeps the detour's
      // waypoints rather than stranding buses (it is still a valid way between the same stops)
      swapVia(game, d.route, d.key, d.prev);
      drop();
      ended.add(d.route);
    }
  }
  for (const id of ended) {
    const r = game.state.routes[id];
    if (r && !list.some((d) => d.route === id)) notify(game, 'info', `Line ${r.number} is back on its usual route`, 'The temporary detour has ended.', { kind: 'route', id });
  }
}

// ───────────────────────────────────────────── route changes for the player to review

export type RouteChange = { op: 'add_stop'; route: Id; stop: Id } | { op: 'remove_stop'; route: Id; stop: Id } | { op: 'new_line'; stops: Id[] };

export interface ChangePlan {
  route: Id | null;
  def: RouteDef;
  cost: number;
  text: string;
}

const pathKm = (pats: Pattern[]) => pats.reduce((n, p) => n + p.path.length, 0) / 1000;
/** Minutes of running per trip (average of the directions) at midday on a weekday. */
const tripMinutes = (profiles: RunProfile[]) => (profiles.length ? profiles.reduce((n, p) => n + (p.total[0][12] ?? 0) / 60, 0) / profiles.length : 0);

/** Waypoints when stop `k` is inserted into the outward stops (shift > 0) or removed (shift < 0). */
function shiftVia(r: Route, k: number, shift: 1 | -1): Record<string, LngLat[]> {
  const out: Record<string, LngLat[]> = {};
  const n = r.stops.length;
  const move = (d: 'o' | 'r', i: number, split: number, v: LngLat[]) => {
    // insertion splits leg `split`; removal merges legs `split` and `split + 1`
    if (shift > 0) {
      if (i < split) out[`${d}:${i}`] = v;
      else if (i > split) out[`${d}:${i + 1}`] = v;
    } else if (i < split) out[`${d}:${i}`] = v;
    else if (i > split + 1) out[`${d}:${i - 1}`] = v;
  };
  for (const [key, v] of Object.entries(r.via)) {
    const [d, si] = key.split(':');
    const i = Number(si);
    if (d === 'o') move('o', i, k - 1, v);
    else if (r.returnStops) out[key] = v; // a return of its own is left as it is
    else move('r', i, shift > 0 ? n - 1 - k : n - 2 - k, v);
  }
  return out;
}

/**
 * Plan a change to the network for the player to review: add a stop to a line (where it adds the
 * least distance), take a stop off a line, or a new line through a list of stops. Automations
 * can only suggest these; the player approves each one.
 */
export function routeChangePlan(game: Game, ch: RouteChange): Result<ChangePlan> {
  const s = game.state;
  if (ch.op === 'new_line') {
    const stops = ch.stops.filter((x, i, a) => a.indexOf(x) === i);
    if (stops.length < 2) return fail('A new line needs at least two different stops.');
    if (stops.length > 30) return fail('A new line can have at most 30 stops.');
    const gone = stops.find((x) => !s.stops[x]);
    if (gone) return fail('A stop on the proposed line no longer exists.');
    const def: RouteDef = { stops, kind: 'linear' };
    const pv = game.previewRoute(def);
    if (pv.problems.length || !pv.patterns.every((p) => p.valid)) return fail(`That line cannot be driven: ${pv.problems[0] ?? 'no road links the stops'}.`);
    const mins = Math.round(tripMinutes(pv.profiles));
    const text = `A new line from ${stopName(game, stops[0])} to ${stopName(game, stops[stops.length - 1])} with ${stops.length} stops: ${pathKm(pv.patterns).toFixed(1)} km both ways, about ${mins} min each way. It is registered for ${game.money(ECON.routeFee)} and runs once you give it buses.${pv.warnings.length ? ` Note: ${pv.warnings[0]}` : ''}`;
    return ok({ route: null, def, cost: ECON.routeFee, text });
  }
  const r = s.routes[ch.route];
  if (!r) return fail('That line no longer exists.');
  if (!s.stops[ch.stop]) return fail('That stop no longer exists.');
  const dt = detoursOf(game, r.id)[0];
  if (dt) return fail(`Line ${r.number} is on a temporary detour until ${hhmm(dt.until)}: its route can change once the detour has ended.`);
  const now = game.patterns.get(r.id) ?? [];
  const profNow = game.profiles.get(r.id) ?? [];
  const needNow = game.requirement(r.id)?.peak ?? 0;
  const consequence = (route: Route, profiles: RunProfile[]) => {
    const need = profiles.length ? requirement(route, profiles, false).peak : 0;
    return need === needNow ? `It still needs ${plural(need, 'bus', 'buses')} at the busiest time.` : `At the busiest time it would need ${plural(need, 'bus', 'buses')} (now ${needNow}).`;
  };
  if (ch.op === 'remove_stop') {
    const k = r.stops.indexOf(ch.stop);
    if (k < 0) return fail(`Line ${r.number} does not call at ${stopName(game, ch.stop)}.`);
    if (r.stops.length <= (r.kind === 'loop' ? 3 : 2)) return fail(`Line ${r.number} needs the stops it has.`);
    const stops = r.stops.filter((x) => x !== ch.stop);
    const returnStops = r.returnStops ? r.returnStops.filter((x) => x !== ch.stop) : null;
    const def: RouteDef = { stops, returnStops, via: shiftVia(r, k, -1) };
    const pv = game.previewRoute(def, r.id);
    if (pv.problems.length || !pv.patterns.every((p) => p.valid)) return fail(`Without ${stopName(game, ch.stop)} the line cannot be driven: ${pv.problems[0] ?? 'no road'}.`);
    const dm = tripMinutes(pv.profiles) - tripMinutes(profNow);
    const text = `Line ${r.number} stops calling at ${stopName(game, ch.stop)}: ${signed(pathKm(pv.patterns) - pathKm(now), 1)} km${now.length > 1 ? ' over both directions' : ''} and about ${signed(dm)} min a trip. ${consequence({ ...r, ...def } as Route, pv.profiles)} People who use that stop walk to the next one or find another way.`;
    return ok({ route: r.id, def, cost: 0, text });
  }
  // add_stop: try every position and keep the one that adds the least distance
  if (r.stops.includes(ch.stop) || r.returnStops?.includes(ch.stop)) return fail(`Line ${r.number} already calls at ${stopName(game, ch.stop)}.`);
  if (r.stops.length >= 40) return fail(`Line ${r.number} already has 40 stops.`);
  let best: { def: RouteDef; km: number; pv: ReturnType<Game['previewRoute']>; k: number } | null = null;
  for (let k = r.kind === 'loop' ? 1 : 0; k <= r.stops.length; k++) {
    const stops = [...r.stops.slice(0, k), ch.stop, ...r.stops.slice(k)];
    const def: RouteDef = { stops, via: shiftVia(r, k, 1) };
    const pv = game.previewRoute(def, r.id);
    if (pv.problems.length || !pv.patterns.length || !pv.patterns.every((p) => p.valid)) continue;
    const km = pathKm(pv.patterns);
    if (!best || km < best.km - 1e-6) best = { def, km, pv, k };
  }
  if (!best) return fail(`Line ${r.number} cannot be driven with ${stopName(game, ch.stop)} added.`);
  const k = best.k, stops = best.def.stops!;
  const where = k === 0 ? `as its new first stop, before ${stopName(game, stops[1])}` : k === stops.length - 1 ? `as its new last stop, after ${stopName(game, stops[k - 1])}` : `between ${stopName(game, stops[k - 1])} and ${stopName(game, stops[k + 1])}`;
  const dm = tripMinutes(best.pv.profiles) - tripMinutes(profNow);
  const text = `Line ${r.number} also calls at ${stopName(game, ch.stop)}, ${where}${r.returnStops ? ' (outward only: its return has stops of its own)' : ''}: ${signed(best.km - pathKm(now), 1)} km${now.length > 1 ? ' over both directions' : ''} and about ${signed(dm)} min a trip. ${consequence({ ...r, ...best.def } as Route, best.pv.profiles)}`;
  return ok({ route: r.id, def: best.def, cost: 0, text });
}

export function applyRouteChange(game: Game, ch: RouteChange): Result<string> {
  const plan = routeChangePlan(game, ch);
  if (!plan.ok) return plan;
  if (plan.value.route) {
    const r = game.updateRoute(plan.value.route, plan.value.def);
    return r.ok ? ok(plan.value.text) : r;
  }
  const r = game.createRoute(plan.value.def);
  return r.ok ? ok(`Line ${game.state.routes[r.value].number} registered. Give it buses to start it running.`) : r;
}
