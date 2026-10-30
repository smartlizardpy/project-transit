// The game engine: owns the state, advances the fixed-step simulation clock independently of
// rendering, runs the minute/hour/day systems and exposes every player action as a validated
// command. UI code reads state and calls commands; it never mutates state directly.

import type { Region } from './world/region.ts';
import { Geo } from './world/geo.ts';
import { SimulatedTraffic } from './world/traffic.ts';
import { route as routeLeg, type LngLat } from './world/graph.ts';
import { buildPatterns, checkDepot, checkStop, type Pattern } from './network.ts';
import type { Path } from './paths.ts';
import { DemandModel, abandonAndReplan, generatePassengers, offloadAll, paxTotals, type PatternService, type StopEvent } from './passengers.ts';
import { bandAt, buildRunProfile, defaultTimetable, generateTrips, normaliseBands, requirement, scheduleAt, type Requirement, type RunProfile } from './timetable.ts';
import { abortService, detachFromPattern, dispatch, minuteVehicles, sendToDepot, startDeadhead, tickVehicle, vehicleNode, vehicleXY } from './vehicles.ts';
import { compactLedger, emptyFinance, flushHour, post, reconcile } from './finance.ts';
import { checkObjectives, closeDay, licenceInfo, notify, routeWindow, unlockedModels } from './progress.ts';
import { currencyFor, formatMoney, type Currency } from './currency.ts';
import { DAY, DT, ECON, HOUR, LINE_COLOURS, MODEL, SERVICE, SPEEDS, STARTING_REPUTATION } from './content.ts';
import { SAVE_VERSION, TripState, type GameState, type Id, type Route, type RouteKind, type Stop, type Timetable, type Trip, type Vehicle } from './types.ts';
import { hhmm, serviceDayOf, serviceDayWeekend, weekdayOf } from './time.ts';

export type Result<T = undefined> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

export interface Pose {
  x: number;
  y: number;
  heading: number;
}

export interface NewGameOptions {
  region: Region;
  company: { name: string; colour: string; logo: number };
  homeZone: string;
  startWeekday?: number;
  startHour?: number;
  seed?: number;
}

export function newGameState(o: NewGameOptions): GameState {
  const state: GameState = {
    version: SAVE_VERSION,
    meta: { id: `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, created: Date.now(), saved: 0, playSeconds: 0 },
    region: { ...o.region.spec, fingerprint: o.region.fingerprint },
    company: { name: o.company.name.trim() || 'City Transit', colour: o.company.colour, logo: o.company.logo, founded: 0, reputation: STARTING_REPUTATION, fare: ECON.referenceFare, status: 'ok', redDays: 0 },
    clock: { t: (o.startHour ?? 5) * HOUR, startWeekday: o.startWeekday ?? 0 },
    rng: (o.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0,
    stops: {},
    routes: {},
    depots: {},
    vehicles: {},
    trips: {},
    tripDay: {},
    pax: { waiting: {}, onboard: {}, acc: {} },
    finance: emptyFinance(ECON.startingFunds),
    stats: { hours: [], routeHours: {}, days: [], total: { trips: 0, boardings: 0, abandoned: 0 } },
    territory: { owned: [o.homeZone], home: o.homeZone },
    objectives: {},
    notifications: [],
    counters: { stop: 0, route: 0, vehicle: 0, depot: 0, ledger: 0, trip: 0, notification: 0 },
    settings: { autoService: true, serviceBelow: SERVICE.defaultBelow },
    onboarding: { active: true, step: 0, flags: {} },
  };
  post(state, { amt: ECON.startingFunds, cat: 'equity', memo: `Founding capital, ${state.company.name}` });
  return state;
}

type Listener = (payload: unknown) => void;

export class Game {
  readonly geo: Geo;
  readonly traffic: SimulatedTraffic;
  readonly trafficIntensity: number;
  readonly demand = new DemandModel();
  readonly currency: Currency;
  /** derived per-route data */
  readonly patterns = new Map<Id, Pattern[]>();
  readonly profiles = new Map<Id, RunProfile[]>();
  /** runtime caches (not saved) */
  readonly vpaths = new Map<Id, Path>();
  readonly segHint = new Map<Id, number>();
  readonly missNotice = new Map<Id, number>();
  private readonly tripIndex = new Map<number, Trip>();
  private readonly travelCache = new Map<string, number>();
  private vlist: Vehicle[] | null = null;
  private quality = new Map<Id, { load: number; ontime: number }>();
  private prevPose = new Map<Id, Pose & { key: string }>();
  private listeners = new Map<string, Set<Listener>>();
  /** passenger accounting since this session started */
  readonly counters = { generated: 0, boardings: 0, completed: 0, lost: 0 };
  /** recent stop events for subtle UI feedback */
  readonly recentStops: { t: number; stop: Id; veh: Id; board: number; alight: number }[] = [];
  /** index into SPEEDS */
  speed = 0;
  private acc = 0;
  /** bumps on every structural change (network, fleet, company) */
  rev = 0;
  ticks = 0;

  constructor(
    public state: GameState,
    readonly region: Region,
  ) {
    this.geo = new Geo(region);
    this.traffic = new SimulatedTraffic(region.graph, region.demand, state.clock.startWeekday);
    this.trafficIntensity = this.traffic.intensity;
    this.currency = currencyFor(state.region.country);
    if (state.region.fingerprint !== region.fingerprint) this.resnap();
    this.reconcileTerritory();
    for (const r of Object.values(state.routes)) this.rebuildDerived(r.id);
    this.reindexTrips();
    const pax = paxTotals(state);
    this.counters.generated = pax.waiting + pax.onboard;
    this.refreshQuality();
  }

  // ───────────────────────────────────────── events

  on(event: string, fn: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(event: string, payload: unknown) {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }

  emitStop(stop: Id, veh: Id, ev: StopEvent) {
    if (!ev.board && !ev.alight) return;
    this.recentStops.push({ t: this.state.clock.t, stop, veh, board: ev.board, alight: ev.alight });
    if (this.recentStops.length > 200) this.recentStops.splice(0, this.recentStops.length - 200);
  }

  private changed() {
    this.rev++;
    this.vlist = null;
    this.demand.dirty = true;
    this.emit('changed', this.rev);
  }

  // ───────────────────────────────────────── clock

  get t() {
    return this.state.clock.t;
  }

  get halted() {
    return this.state.company.status === 'bankrupt';
  }

  setSpeed(i: number) {
    this.speed = Math.max(0, Math.min(SPEEDS.length - 1, i));
    if (this.halted) this.speed = 0;
    this.emit('speed', this.speed);
  }

  /** Advance by real seconds at the current speed; returns ticks run. */
  advance(realDt: number): number {
    const rate = SPEEDS[this.speed];
    if (!rate || this.halted) return 0;
    this.state.meta.playSeconds += realDt;
    this.acc += Math.min(realDt, 0.25) * rate;
    let n = Math.floor(this.acc / DT);
    if (n > 4000) {
      n = 4000;
      this.acc = n * DT;
    }
    for (let i = 0; i < n; i++) {
      if (i === n - 1) this.snapshotPoses();
      this.tick();
    }
    this.acc -= n * DT;
    return n;
  }

  /** Interpolation factor between the last two ticks, for rendering. */
  get alpha() {
    return Math.max(0, Math.min(1, this.acc / DT));
  }

  /** Run whole seconds immediately (tests, fast-forward). */
  run(seconds: number) {
    for (let i = 0; i < seconds; i += DT) this.tick();
  }

  tick() {
    const s = this.state;
    s.clock.t += DT;
    this.ticks++;
    for (const v of this.vehicleList()) tickVehicle(this, v, DT);
    const t = s.clock.t;
    if (t % 60 === 0) this.minute();
    if (t % HOUR === 0) this.hour();
    if (t % DAY === 0) this.day();
  }

  private minute() {
    const t = this.t;
    for (const r of Object.values(this.state.routes)) this.ensureTrips(r.id);
    dispatch(this);
    if (this.demand.dirty || this.demand.slot !== Math.floor(t / HOUR)) this.demand.refresh(this, t);
    generatePassengers(this);
    abandonAndReplan(this);
    minuteVehicles(this);
    if (t % 600 === 0) checkObjectives(this);
    if (t % 1800 === 0) this.pruneTrips();
    this.emit('minute', t);
  }

  private hour() {
    const t = this.t;
    flushHour(this.state, t - 1, `${hhmm(t - HOUR)}–${hhmm(t)}`);
    this.refreshQuality();
    if (Math.floor((t % DAY) / HOUR) === 4) compactLedger(this.state);
    this.emit('hour', t);
  }

  private day() {
    const t = this.t;
    const ended = t / DAY - 1;
    closeDay(this, ended);
    const c = this.state.company;
    if (c.status === 'insolvent' && c.redDays > ECON.graceDays + 7) this.bankrupt('The company stayed insolvent for too long and has been wound up.');
    this.dailyCosts();
    this.emit('day', ended);
  }

  private dailyCosts() {
    const s = this.state;
    const byRoute = new Map<string, number>();
    for (const v of Object.values(s.vehicles)) byRoute.set(v.route ?? '', (byRoute.get(v.route ?? '') ?? 0) + 1);
    for (const [route, n] of byRoute) {
      const r = route ? s.routes[route] : undefined;
      post(s, { amt: -n * ECON.fleetFixedPerDay, cat: 'fleet_fixed', memo: `Insurance & licensing, ${n} bus${n > 1 ? 'es' : ''}${r ? `, line ${r.number}` : ''}`, route: r ? route : undefined });
    }
    for (const d of Object.values(s.depots)) post(s, { amt: -(ECON.depotUpkeepPerDay + (d.level - 1) * ECON.depotExpandUpkeep), cat: 'depot', memo: `Running costs, ${d.name}`, ref: d.id });
    const nStops = Object.keys(s.stops).length;
    if (nStops) post(s, { amt: -nStops * ECON.stopUpkeepPerDay, cat: 'stops', memo: `Upkeep of ${nStops} stops` });
    if (s.finance.balance < 0) post(s, { amt: s.finance.balance * ECON.overdraftRatePerDay, cat: 'interest', memo: 'Overdraft interest' });
    if (s.finance.loan > 0) post(s, { amt: -s.finance.loan * ECON.loanRatePerDay, cat: 'interest', memo: 'Loan interest' });
  }

  private bankrupt(reason: string) {
    this.state.company.status = 'bankrupt';
    this.speed = 0;
    notify(this, 'bad', 'Bankrupt', reason);
    this.emit('bankrupt', reason);
  }

  // ───────────────────────────────────────── helpers

  random(): number {
    // mulberry32 on the saved seed, so a loaded game continues deterministically
    let x = (this.state.rng = (this.state.rng + 0x6d2b79f5) >>> 0);
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  }

  money(base: number, opts?: Parameters<typeof formatMoney>[2]) {
    return formatMoney(this.currency, base, opts);
  }

  isWeekend(t: number) {
    return weekdayOf(this.state.clock.startWeekday, t) >= 5;
  }

  vehicleList(): Vehicle[] {
    return (this.vlist ??= Object.values(this.state.vehicles));
  }

  pattern(route: Id, pat: number): Pattern | undefined {
    return this.patterns.get(route)?.[pat];
  }

  trip(id: number): Trip | undefined {
    return this.tripIndex.get(id);
  }

  /** Free-flow deadhead time between two nodes with a margin for traffic, seconds (cached). */
  travelSeconds(from: number, to: number): number {
    if (from === to || from < 0 || to < 0) return 0;
    const key = `${from}>${to}`;
    let s = this.travelCache.get(key);
    if (s === undefined) {
      const leg = routeLeg(this.region.graph, from, to) ?? routeLeg(this.region.graph, from, to, { lenient: true });
      s = leg ? leg.seconds * 1.35 + 30 : 3600;
      if (this.travelCache.size > 4000) this.travelCache.clear();
      this.travelCache.set(key, s);
    }
    return s;
  }

  /** Scheduled cumulative seconds per stop for a trip departing at `dep`. */
  schedule(route: Id, pat: number, dep: number): Float32Array | null {
    const prof = this.profiles.get(route)?.[pat];
    if (!prof) return null;
    const sd = serviceDayOf(dep);
    return scheduleAt(prof, serviceDayWeekend(this.state.clock.startWeekday, sd), (dep - sd * DAY) / 60);
  }

  headwayAt(route: Id, _pat: number, t: number): number | null {
    const r = this.state.routes[route];
    if (!r) return null;
    const sd = serviceDayOf(t);
    const plan = serviceDayWeekend(this.state.clock.startWeekday, sd) ? r.timetable.weekend : r.timetable.weekday;
    return bandAt(plan, (t - sd * DAY) / 60)?.headway ?? null;
  }

  requirement(route: Id, weekend = this.isWeekend(this.t)): Requirement | null {
    const r = this.state.routes[route];
    const prof = this.profiles.get(route);
    if (!r || !prof) return null;
    return requirement(r, prof, weekend);
  }

  /** Services currently offered to passengers (for itinerary planning). */
  patternServices(t: number, index: Map<Id, number>): PatternService[] {
    const out: PatternService[] = [];
    for (const r of Object.values(this.state.routes)) {
      if (r.suspended || !r.vehicles.length) continue;
      for (const p of this.patterns.get(r.id) ?? []) {
        if (!p.valid) continue;
        const headway = this.headwayAt(r.id, p.index, t) ?? this.headwayAt(r.id, p.index, t + 1800);
        const sch = this.schedule(r.id, p.index, t);
        out.push({
          pattern: p,
          sIdx: p.stops.map((id) => index.get(id) ?? -1),
          tmin: Array.from(sch ?? new Float32Array(p.stops.length), (x) => x / 60),
          headway: headway ?? 60,
          available: headway !== null,
        });
      }
    }
    return out;
  }

  routeQuality() {
    return this.quality;
  }

  private refreshQuality() {
    this.quality = new Map();
    for (const r of Object.values(this.state.routes)) {
      const w = routeWindow(this.state, r.id, 3);
      this.quality.set(r.id, { load: w.load ?? 0.5, ontime: w.ontime ?? 1 });
    }
  }

  // ───────────────────────────────────────── poses for rendering

  private poseKey(v: Vehicle) {
    const p = v.pos;
    return p.kind === 'pattern' ? `${p.route}/${p.pat}` : p.kind === 'path' ? `p${p.nodes[0]}>${p.nodes[p.nodes.length - 1]}` : 'd';
  }

  private snapshotPoses() {
    for (const v of this.vehicleList()) {
      const xy = vehicleXY(this, v);
      if (xy) this.prevPose.set(v.id, { ...xy, key: this.poseKey(v) });
      else this.prevPose.delete(v.id);
    }
  }

  /** Interpolated pose of a vehicle between the last two simulation ticks. */
  pose(v: Vehicle): Pose | null {
    const cur = vehicleXY(this, v);
    if (!cur) return null;
    const prev = this.prevPose.get(v.id);
    if (!prev || prev.key !== this.poseKey(v) || this.speed === 0) return cur;
    const a = this.alpha;
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) > 60) return cur;
    let dh = cur.heading - prev.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    return { x: prev.x + (cur.x - prev.x) * a, y: prev.y + (cur.y - prev.y) * a, heading: prev.heading + dh * a };
  }

  // ───────────────────────────────────────── trips

  private reindexTrips() {
    this.tripIndex.clear();
    for (const list of Object.values(this.state.trips)) for (const t of list) this.tripIndex.set(t.id, t);
  }

  private profileDays() {
    // the first weekday (Tue) and weekend day (Sat) after the start, for typical traffic
    let wd = 0, we = 0;
    for (let d = 0; d < 7; d++) {
      const w = weekdayOf(this.state.clock.startWeekday, d * DAY);
      if (w === 1) wd = d;
      if (w === 5) we = d;
    }
    return { wd, we };
  }

  private rebuildDerived(id: Id) {
    const r = this.state.routes[id];
    if (!r) {
      this.patterns.delete(id);
      this.profiles.delete(id);
      return;
    }
    const pats = buildPatterns(this.state, this.region, this.geo, r);
    this.patterns.set(id, pats);
    const { wd, we } = this.profileDays();
    this.profiles.set(id, pats.map((p) => buildRunProfile(this.region.graph, p, this.traffic, wd, we)));
  }

  ensureTrips(id: Id) {
    const r = this.state.routes[id];
    if (!r) return;
    const t = this.t;
    const sdNow = serviceDayOf(t);
    const have = this.state.tripDay[id] ?? sdNow - 1;
    if (have >= sdNow + 1) return;
    const list = (this.state.trips[id] ??= []);
    const taken = new Set(list.filter((x) => x.state !== TripState.Planned).map((x) => `${x.pat}@${x.dep}`));
    const pats = this.patterns.get(id) ?? [];
    for (let sd = have + 1; sd <= sdNow + 1; sd++) {
      const gen = generateTrips(r, pats, sd, serviceDayWeekend(this.state.clock.startWeekday, sd), () => ++this.state.counters.trip, t);
      for (const x of gen) {
        if (taken.has(`${x.pat}@${x.dep}`)) continue;
        list.push(x);
        this.tripIndex.set(x.id, x);
      }
    }
    list.sort((a, b) => a.dep - b.dep || a.pat - b.pat);
    this.state.tripDay[id] = sdNow + 1;
  }

  private pruneTrips() {
    const t = this.t;
    for (const [id, list] of Object.entries(this.state.trips)) {
      this.state.trips[id] = list.filter((x) => {
        const old = (x.state === TripState.Done || x.state === TripState.Missed) && x.dep < t - 3 * HOUR;
        if (old) this.tripIndex.delete(x.id);
        return !old;
      });
    }
  }

  /** Drop future unassigned trips and regenerate them from the current timetable. */
  private regenerateTrips(id: Id) {
    const list = this.state.trips[id] ?? [];
    const t = this.t;
    this.state.trips[id] = list.filter((x) => {
      const drop = x.state === TripState.Planned && x.dep > t;
      if (drop) this.tripIndex.delete(x.id);
      return !drop;
    });
    this.state.tripDay[id] = serviceDayOf(t) - 1;
    this.ensureTrips(id);
  }

  /**
   * Change a line's shape safely: buses on it are detached at their exact road position, the
   * change is applied, then they drive to the new start (or the depot) and trips are rebuilt.
   */
  private reshapeRoute(id: Id, apply: () => void) {
    const s = this.state;
    const affected = this.vehicleList().filter((v) => v.route === id || (v.pos.kind === 'pattern' && v.pos.route === id) || v.target?.route === id);
    for (const v of affected) if (v.pos.kind === 'pattern' && v.pos.route === id) detachBus(this, v);
    for (const trip of s.trips[id] ?? []) this.tripIndex.delete(trip.id);
    delete s.trips[id];
    delete s.tripDay[id];
    apply();
    this.rebuildDerived(id);
    const r = s.routes[id];
    const pats = this.patterns.get(id);
    const start = r && pats?.[0]?.valid ? pats[0].path.nodes[0] : undefined;
    for (const v of affected) {
      if (v.trip !== null && !this.tripIndex.has(v.trip)) v.trip = null;
      if (v.next !== null && !this.tripIndex.has(v.next)) v.next = null;
      v.target = undefined;
      if (v.status === 'preparing') {
        v.status = 'parked';
        v.since = this.t;
        v.pos = { kind: 'depot' };
      } else if (v.status === 'to_route' || v.status === 'layover' || v.status === 'in_service' || v.status === 'at_stop') {
        if (r && !r.suspended && v.route === id && start !== undefined) {
          v.target = { route: id, pat: 0 };
          startDeadhead(this, v, start, 'route');
        } else sendToDepot(this, v);
      }
    }
    if (r) this.ensureTrips(id);
  }

  // ───────────────────────────────────────── re-snapping after map data changes

  private resnap() {
    const s = this.state;
    for (const st of Object.values(s.stops)) {
      const c = checkStop({ ...s, stops: {} }, this.region, this.geo, st.lngLat);
      if (c.node >= 0) {
        st.node = c.node;
        st.alt = c.alt;
        st.lngLat = c.lngLat;
      }
    }
    for (const d of Object.values(s.depots)) {
      const c = checkDepot({ ...s, depots: {} }, this.region, this.geo, d.lngLat);
      if (c.node >= 0) d.node = c.node;
    }
    let moved = 0;
    for (const v of Object.values(s.vehicles)) {
      if (v.pos.kind !== 'depot') moved++;
      v.pos = { kind: 'depot' };
      v.status = v.status === 'maintenance' ? 'maintenance' : 'parked';
      v.trip = null;
      v.next = null;
      v.load = 0;
    }
    s.pax.onboard = {};
    s.trips = {};
    s.tripDay = {};
    s.region.fingerprint = this.region.fingerprint;
    if (moved) notify(this, 'info', 'Map data was updated', 'Street data for this city changed since your last save. Stops were re-attached to the nearest street and buses returned to their depots.');
  }

  /**
   * Operating areas are generated from map data, so a newer version of the game (or changed source
   * data) can redraw them. Keep every area where the company has stops or depots, and the rest of
   * the licences that still exist.
   */
  private reconcileTerritory() {
    const t = this.state.territory;
    const valid = new Set(this.region.zones.map((z) => z.id));
    for (const st of Object.values(this.state.stops)) if (!valid.has(st.zone)) st.zone = this.geo.zoneAt(st.lngLat).id;
    for (const d of Object.values(this.state.depots)) if (!valid.has(d.zone)) d.zone = this.geo.zoneAt(d.lngLat).id;
    if (t.owned.every((id) => valid.has(id)) && valid.has(t.home)) return;
    const owned = new Set(t.owned.filter((id) => valid.has(id)));
    for (const st of Object.values(this.state.stops)) owned.add(st.zone);
    for (const d of Object.values(this.state.depots)) owned.add(d.zone);
    if (!valid.has(t.home)) t.home = Object.values(this.state.depots)[0]?.zone ?? [...owned][0] ?? this.region.zones[0].id;
    owned.add(t.home);
    t.owned = [...owned];
    notify(this, 'info', 'Operating areas were redrawn', 'Area boundaries changed since your last save. You keep every area where you have stops or depots.');
  }

  // ═════════════════════════════════════════ commands

  private requireActive(): string | null {
    const st = this.state.company.status;
    if (st === 'bankrupt') return 'The company is bankrupt.';
    return null;
  }

  private affordable(cost: number): string | null {
    const c = this.state.company;
    if (c.status === 'insolvent') return 'Your company is insolvent. Sell assets or raise funds before investing.';
    if (this.state.finance.balance < cost) return `Not enough funds. This costs ${this.money(cost)}; you have ${this.money(this.state.finance.balance)}.`;
    return null;
  }

  // ── stops

  placeStop(at: LngLat, name?: string): Result<Id> {
    const err = this.requireActive() ?? this.affordable(ECON.stopCost);
    if (err) return fail(err);
    const c = checkStop(this.state, this.region, this.geo, at);
    if (!c.ok) return fail(c.reason ?? 'A stop cannot be placed here.');
    const id = `s${++this.state.counters.stop}`;
    const stop: Stop = { id, name: (name ?? c.name).trim() || c.name, node: c.node, alt: c.alt, lngLat: c.lngLat, zone: c.zone, built: this.t };
    this.state.stops[id] = stop;
    post(this.state, { amt: -ECON.stopCost, cat: 'construction', memo: `New stop: ${stop.name}`, ref: id });
    this.changed();
    return ok(id);
  }

  renameStop(id: Id, name: string): Result {
    const s = this.state.stops[id];
    if (!s) return fail('That stop no longer exists.');
    const n = name.trim();
    if (!n) return fail('A stop needs a name.');
    if (n.length > 48) return fail('That name is too long.');
    s.name = n;
    this.changed();
    return ok(undefined);
  }

  moveStop(id: Id, at: LngLat): Result {
    const s = this.state.stops[id];
    if (!s) return fail('That stop no longer exists.');
    const c = checkStop(this.state, this.region, this.geo, at, id);
    if (!c.ok) return fail(c.reason ?? 'The stop cannot be moved here.');
    s.node = c.node;
    s.alt = c.alt;
    s.lngLat = c.lngLat;
    s.zone = c.zone;
    for (const r of this.routesUsing(id)) this.reshapeRoute(r.id, () => {});
    this.changed();
    return ok(undefined);
  }

  routesUsing(stop: Id): Route[] {
    return Object.values(this.state.routes).filter((r) => r.stops.includes(stop) || r.returnStops?.includes(stop));
  }

  removeStop(id: Id): Result {
    const s = this.state.stops[id];
    if (!s) return fail('That stop no longer exists.');
    const used = this.routesUsing(id);
    if (used.length) return fail(`${s.name} is served by line ${used.map((r) => r.number).join(', ')}. Remove it from ${used.length > 1 ? 'those lines' : 'the line'} first.`);
    // waiting passengers go home
    const waiting = this.state.pax.waiting[id];
    if (waiting) {
      delete this.state.pax.waiting[id];
      for (const g of waiting) this.counters.lost += g.n;
    }
    delete this.state.stops[id];
    this.changed();
    return ok(undefined);
  }

  // ── lines

  nextRouteNumber(): string {
    const used = new Set(Object.values(this.state.routes).map((r) => r.number));
    for (let n = 1; ; n++) if (!used.has(String(n))) return String(n);
  }

  nextRouteColour(): string {
    const used = new Set(Object.values(this.state.routes).map((r) => r.colour));
    return LINE_COLOURS.find((c) => !used.has(c)) ?? LINE_COLOURS[Object.keys(this.state.routes).length % LINE_COLOURS.length];
  }

  /** Validate a line definition without changing anything (used by the editor preview). */
  /** Validate and route a line without changing the game. Pass `editing` when previewing changes to an existing line. */
  previewRoute(def: RouteDef, editing?: Id): { patterns: Pattern[]; profiles: RunProfile[]; problems: string[]; warnings: string[] } {
    const base = editing ? this.state.routes[editing] : undefined;
    const r = this.routeFromDef(base ? base.id : 'preview', def, base);
    const problems = this.routeProblems(r);
    const patterns = r.stops.length >= 2 ? buildPatterns(this.state, this.region, this.geo, r) : [];
    for (const p of patterns) problems.push(...p.problems);
    const warnings = [...new Set(patterns.flatMap((p) => p.warnings))];
    const { wd, we } = this.profileDays();
    const profiles = patterns.length && patterns.every((p) => p.valid) ? patterns.map((p) => buildRunProfile(this.region.graph, p, this.traffic, wd, we)) : [];
    return { patterns, profiles, problems: [...new Set(problems)], warnings };
  }

  private routeFromDef(id: Id, d: RouteDef, base?: Route): Route {
    return {
      id,
      number: (d.number ?? base?.number ?? this.nextRouteNumber()).trim().slice(0, 4) || this.nextRouteNumber(),
      name: (d.name ?? base?.name ?? '').trim().slice(0, 60),
      colour: d.colour ?? base?.colour ?? this.nextRouteColour(),
      kind: d.kind ?? base?.kind ?? 'linear',
      stops: d.stops ?? base?.stops ?? [],
      returnStops: d.returnStops !== undefined ? d.returnStops : base?.returnStops ?? null,
      via: d.via ?? base?.via ?? {},
      timetable: d.timetable ?? base?.timetable ?? defaultTimetable(),
      vehicles: base?.vehicles ?? [],
      created: base?.created ?? this.t,
      suspended: d.suspended ?? base?.suspended ?? false,
    };
  }

  private routeProblems(r: Route): string[] {
    const out: string[] = [];
    if (r.stops.length < 2) out.push('A line needs at least two stops.');
    if (r.kind === 'loop' && r.stops.length < 3) out.push('A loop needs at least three stops.');
    for (const id of [...r.stops, ...(r.returnStops ?? [])]) if (!this.state.stops[id]) out.push('A stop on this line no longer exists.');
    for (let i = 0; i + 1 < r.stops.length; i++) if (r.stops[i] === r.stops[i + 1]) out.push('The same stop appears twice in a row.');
    if (new Set(r.stops).size !== r.stops.length) out.push('Each stop can only appear once per direction.');
    const dup = Object.values(this.state.routes).find((x) => x.id !== r.id && x.number === r.number);
    if (dup) out.push(`Line number ${r.number} is already in use.`);
    return out;
  }

  createRoute(def: RouteDef): Result<Id> {
    const err = this.requireActive() ?? this.affordable(ECON.routeFee);
    if (err) return fail(err);
    const id = `r${this.state.counters.route + 1}`;
    const r = this.routeFromDef(id, def);
    const problems = this.routeProblems(r);
    if (problems.length) return fail(problems[0]);
    const pats = buildPatterns(this.state, this.region, this.geo, r);
    const bad = pats.find((p) => !p.valid);
    if (bad) return fail(bad.problems[0] ?? 'This line cannot be driven.');
    this.state.counters.route++;
    this.state.routes[id] = r;
    this.rebuildDerived(id);
    post(this.state, { amt: -ECON.routeFee, cat: 'licence', memo: `Line ${r.number} registration`, route: id });
    this.ensureTrips(id);
    this.changed();
    return ok(id);
  }

  updateRoute(id: Id, def: RouteDef): Result {
    const old = this.state.routes[id];
    if (!old) return fail('That line no longer exists.');
    const r = this.routeFromDef(id, def, old);
    const problems = this.routeProblems(r);
    if (problems.length) return fail(problems[0]);
    const geometry = JSON.stringify([old.kind, old.stops, old.returnStops, old.via]) !== JSON.stringify([r.kind, r.stops, r.returnStops, r.via]);
    if (geometry) {
      const pats = buildPatterns(this.state, this.region, this.geo, r);
      const bad = pats.find((p) => !p.valid);
      if (bad) return fail(bad.problems[0] ?? 'This line cannot be driven.');
    }
    const ttChanged = JSON.stringify(old.timetable) !== JSON.stringify(r.timetable);
    if (geometry) this.reshapeRoute(id, () => (this.state.routes[id] = r));
    else {
      this.state.routes[id] = r;
      if (ttChanged) this.regenerateTrips(id);
    }
    if (r.suspended !== old.suspended && r.suspended) for (const v of this.vehicleList()) if (v.route === id && v.status === 'layover' && v.trip === null) sendToDepot(this, v);
    this.changed();
    return ok(undefined);
  }

  setTimetable(id: Id, tt: Timetable): Result {
    const clean: Timetable = {
      weekday: { bands: normaliseBands(tt.weekday.bands) },
      weekend: { bands: normaliseBands(tt.weekend.bands) },
      layover: Math.max(1, Math.min(30, Math.round(tt.layover))),
    };
    return this.updateRoute(id, { timetable: clean });
  }

  deleteRoute(id: Id): Result {
    const r = this.state.routes[id];
    if (!r) return fail('That line no longer exists.');
    this.reshapeRoute(id, () => {
      for (const v of this.vehicleList()) if (v.route === id) v.route = null;
      delete this.state.routes[id];
      delete this.state.stats.routeHours[id];
    });
    this.changed();
    return ok(undefined);
  }

  // ── depots

  buildDepot(at: LngLat, name?: string): Result<Id> {
    const err = this.requireActive() ?? this.affordable(ECON.depotCost);
    if (err) return fail(err);
    const c = checkDepot(this.state, this.region, this.geo, at);
    if (!c.ok) return fail(c.reason ?? 'A depot cannot be built here.');
    const id = `d${++this.state.counters.depot}`;
    const zone = this.geo.zone(c.zone);
    const nm = (name ?? `${this.geo.streetNear(c.lngLat, 80) ?? zone?.name ?? 'City'} Depot`).trim();
    this.state.depots[id] = { id, name: nm, node: c.node, lngLat: c.lngLat, zone: c.zone, capacity: ECON.depotCapacity, level: 1, built: this.t };
    post(this.state, { amt: -ECON.depotCost, cat: 'construction', memo: `New depot: ${nm}`, ref: id });
    this.changed();
    return ok(id);
  }

  expandDepot(id: Id): Result {
    const d = this.state.depots[id];
    if (!d) return fail('That depot no longer exists.');
    if (d.level >= 4) return fail('This depot cannot be expanded further.');
    const err = this.requireActive() ?? this.affordable(ECON.depotExpandCost);
    if (err) return fail(err);
    d.level++;
    d.capacity += ECON.depotExpandCapacity;
    post(this.state, { amt: -ECON.depotExpandCost, cat: 'construction', memo: `Expansion of ${d.name}`, ref: id });
    this.changed();
    return ok(undefined);
  }

  depotUse(id: Id) {
    return Object.values(this.state.vehicles).filter((v) => v.depot === id).length;
  }

  // ── fleet

  buyVehicle(modelId: string, depotId: Id): Result<Id> {
    const m = MODEL[modelId];
    if (!m) return fail('Unknown vehicle model.');
    if (!unlockedModels(this.state).has(modelId)) return fail(`The ${m.name} needs reputation ${m.unlockRep}${m.unlockObjective ? ' or the "Mass transit" objective' : ''}.`);
    const d = this.state.depots[depotId];
    if (!d) return fail('Build a depot first: buses need somewhere to park.');
    if (this.depotUse(depotId) >= d.capacity) return fail(`${d.name} is full (${d.capacity} buses). Expand it or build another depot.`);
    const err = this.requireActive() ?? this.affordable(m.price);
    if (err) return fail(err);
    const n = ++this.state.counters.vehicle;
    const id = `v${n}`;
    const v: Vehicle = {
      id,
      fleetNo: String(100 + n),
      model: modelId,
      depot: depotId,
      route: null,
      status: 'parked',
      since: this.t,
      condition: 1,
      km: 0,
      bought: this.t,
      price: m.price,
      pos: { kind: 'depot' },
      v: 0,
      stopIdx: 0,
      trip: null,
      next: null,
      until: 0,
      load: 0,
      delay: 0,
      withdraw: false,
      wantsService: false,
    };
    this.state.vehicles[id] = v;
    post(this.state, { amt: -m.price, cat: 'vehicle_purchase', memo: `${m.name} #${v.fleetNo}`, veh: id });
    this.changed();
    return ok(id);
  }

  resaleValue(v: Vehicle): number {
    const ageDays = (this.t - v.bought) / DAY;
    return Math.round(v.price * ECON.resaleNew * (0.55 + 0.45 * v.condition) * Math.max(0.3, 1 - ageDays * 0.004));
  }

  assignVehicle(id: Id, route: Id | null): Result {
    const v = this.state.vehicles[id];
    if (!v) return fail('That bus no longer exists.');
    if (route && !this.state.routes[route]) return fail('That line no longer exists.');
    if (v.sell) return fail('This bus is being sold.');
    if (v.route === route) return ok(undefined);
    if (v.route) {
      const old = this.state.routes[v.route];
      if (old) old.vehicles = old.vehicles.filter((x) => x !== id);
    }
    v.route = route;
    if (route) this.state.routes[route].vehicles.push(id);
    // drop reserved work on the old line; the current trip (if any) is completed first
    if (v.next !== null) {
      const t = this.trip(v.next);
      if (t && t.state === TripState.Assigned) {
        t.state = TripState.Planned;
        t.veh = null;
      }
      v.next = null;
    }
    if (v.status === 'preparing' || ((v.status === 'layover' || v.status === 'to_route') && (!v.trip || this.trip(v.trip)?.state !== TripState.Running))) {
      if (v.trip !== null) {
        const t = this.trip(v.trip);
        if (t && t.state === TripState.Assigned) {
          t.state = TripState.Planned;
          t.veh = null;
        }
        v.trip = null;
      }
      if (v.status === 'preparing') {
        v.status = 'parked';
        v.pos = { kind: 'depot' };
      } else sendToDepot(this, v);
    }
    this.changed();
    return ok(undefined);
  }

  /** Sell now if parked, otherwise once the bus is back at the depot. */
  sellVehicle(id: Id): Result<'sold' | 'returning'> {
    const v = this.state.vehicles[id];
    if (!v) return fail('That bus no longer exists.');
    if (v.status === 'parked' && v.pos.kind === 'depot') {
      this.sellNow(id);
      return ok('sold');
    }
    if (v.status === 'maintenance') return fail('Wait until maintenance is finished.');
    v.sell = true;
    if (v.status === 'layover' && v.trip === null) sendToDepot(this, v);
    this.changed();
    return ok('returning');
  }

  sellNow(id: Id) {
    const v = this.state.vehicles[id];
    if (!v) return;
    const value = this.resaleValue(v);
    if (v.route) {
      const r = this.state.routes[v.route];
      if (r) r.vehicles = r.vehicles.filter((x) => x !== id);
    }
    if (this.state.pax.onboard[id]) abortService(this, v);
    post(this.state, { amt: value, cat: 'vehicle_sale', memo: `Sold ${MODEL[v.model].name} #${v.fleetNo}`, veh: id });
    delete this.state.vehicles[id];
    this.vpaths.delete(id);
    this.prevPose.delete(id);
    this.changed();
  }

  cancelSale(id: Id): Result {
    const v = this.state.vehicles[id];
    if (!v) return fail('That bus no longer exists.');
    v.sell = false;
    this.changed();
    return ok(undefined);
  }

  /** Send for maintenance: immediately if parked, otherwise after its current trip. */
  serviceVehicle(id: Id): Result {
    const v = this.state.vehicles[id];
    if (!v) return fail('That bus no longer exists.');
    if (v.status === 'maintenance') return fail('Already in maintenance.');
    if (v.condition > 0.985) return fail('This bus does not need maintenance.');
    v.wantsService = true;
    if (v.status === 'parked') {
      const m = MODEL[v.model];
      const cost = Math.round(v.price * m.serviceCost * (1 - v.condition) + 150);
      if (this.state.finance.balance < cost) {
        v.wantsService = false;
        return fail(`Not enough funds for maintenance (${this.money(cost)}).`);
      }
    } else if (v.status === 'layover' && v.trip === null) sendToDepot(this, v);
    this.changed();
    return ok(undefined);
  }

  maintenanceQuote(v: Vehicle) {
    const m = MODEL[v.model];
    const points = Math.max(0, (1 - v.condition) * 100);
    return { cost: Math.round(v.price * m.serviceCost * (1 - v.condition) + 150), minutes: Math.max(SERVICE.minMinutes, points * SERVICE.minutesPerPoint) };
  }

  // ── company

  setFare(fare: number): Result {
    if (!Number.isFinite(fare)) return fail('Invalid fare.');
    this.state.company.fare = Math.round(Math.max(ECON.fareMin, Math.min(ECON.fareMax, fare)) * 20) / 20;
    this.demand.slot = -1;
    this.changed();
    return ok(undefined);
  }

  setCompany(patch: Partial<Pick<GameState['company'], 'name' | 'colour' | 'logo'>>): Result {
    if (patch.name !== undefined && !patch.name.trim()) return fail('Your company needs a name.');
    Object.assign(this.state.company, patch);
    this.changed();
    return ok(undefined);
  }

  setSettings(patch: Partial<GameState['settings']>) {
    Object.assign(this.state.settings, patch);
    this.changed();
  }

  takeLoan(amount: number): Result {
    const err = this.requireActive();
    if (err) return fail(err);
    if (this.state.company.status === 'insolvent') return fail('The bank will not lend to an insolvent company.');
    const a = Math.round(amount / 1000) * 1000;
    if (a <= 0) return fail('Choose an amount.');
    if (this.state.finance.loan + a > ECON.loanMax) return fail(`The bank lends at most ${this.money(ECON.loanMax)} in total.`);
    this.state.finance.loan += a;
    post(this.state, { amt: a, cat: 'loan', memo: 'Bank loan drawn' });
    this.changed();
    return ok(undefined);
  }

  repayLoan(amount: number): Result {
    const a = Math.min(Math.round(amount / 1000) * 1000, this.state.finance.loan);
    if (a <= 0) return fail('Nothing to repay.');
    if (this.state.finance.balance < a) return fail('Not enough funds to repay that much.');
    this.state.finance.loan -= a;
    post(this.state, { amt: -a, cat: 'repayment', memo: 'Loan repayment' });
    this.changed();
    return ok(undefined);
  }

  buyLicence(zoneId: string): Result {
    const err = this.requireActive();
    if (err) return fail(err);
    const info = licenceInfo(this, zoneId);
    if (!info) return fail('Unknown area.');
    if (info.owned) return fail(`You already operate in ${info.zone.name}.`);
    if (!info.canBuy) return fail(info.blockers[0]);
    this.state.territory.owned.push(zoneId);
    post(this.state, { amt: -info.cost, cat: 'licence', memo: `Operating licence: ${info.zone.name}`, ref: zoneId });
    notify(this, 'good', `Licence granted: ${info.zone.name}`, 'You can now build stops and depots in this area.', { kind: 'zone', id: zoneId });
    checkObjectives(this);
    this.changed();
    return ok(undefined);
  }

  declareBankruptcy() {
    this.bankrupt('You closed the company.');
  }

  // ───────────────────────────────────────── save

  serialize(): string {
    this.state.meta.saved = Date.now();
    return JSON.stringify(this.state);
  }

  /** Internal consistency checks; returns problems found (empty = healthy). */
  audit(): string[] {
    const out: string[] = [];
    const rec = reconcile(this.state);
    if (!rec.ok) out.push(`Ledger total ${rec.ledgerTotal} does not match balance ${rec.balance}.`);
    for (const v of Object.values(this.state.vehicles)) {
      const onboard = (this.state.pax.onboard[v.id] ?? []).reduce((s, g) => s + g.n, 0);
      if (onboard !== v.load) out.push(`${v.fleetNo}: load ${v.load} but ${onboard} passengers on board.`);
      if (v.load > MODEL[v.model].capacity) out.push(`${v.fleetNo}: over capacity (${v.load}).`);
      if (v.route && !this.state.routes[v.route]?.vehicles.includes(v.id)) out.push(`${v.fleetNo}: route link broken.`);
      if (!Number.isFinite(v.pos.kind === 'depot' ? 0 : v.pos.s)) out.push(`${v.fleetNo}: invalid position.`);
    }
    for (const list of Object.values(this.state.pax.waiting)) for (const g of list) if (!(g.n > 0)) out.push('Empty passenger group waiting.');
    const pax = paxTotals(this.state);
    const balance = this.counters.generated - pax.waiting - pax.onboard - this.counters.completed - this.counters.lost;
    if (balance !== 0) out.push(`Passenger count drift: ${balance}.`);
    return out;
  }

  /** Current node a vehicle is at/heading to (for UI). */
  vehicleNode(v: Vehicle) {
    return vehicleNode(this, v);
  }
}

export interface RouteDef {
  number?: string;
  name?: string;
  colour?: string;
  kind?: RouteKind;
  stops?: Id[];
  returnStops?: Id[] | null;
  via?: Record<string, LngLat[]>;
  timetable?: Timetable;
  suspended?: boolean;
}

/**
 * Take a bus off a line that is about to change: passengers get off at the next stop and find
 * another way, its trips are released, and its position becomes a plain road position so it can
 * drive on from exactly where it is. The caller must then send it somewhere (new start or depot).
 */
function detachBus(game: Game, v: Vehicle) {
  const p = v.pos.kind === 'pattern' ? game.pattern(v.pos.route, v.pos.pat) : null;
  if (v.load > 0 || game.state.pax.onboard[v.id]) {
    const stop = p ? p.stops[Math.min(v.stopIdx, p.stops.length - 1)] : null;
    offloadAll(game, v, stop && game.state.stops[stop] ? stop : null);
  }
  if (v.trip !== null) {
    const t = game.trip(v.trip);
    if (t && (t.state === TripState.Running || t.state === TripState.Assigned)) t.state = TripState.Missed;
    v.trip = null;
  }
  if (v.next !== null) {
    const t = game.trip(v.next);
    if (t && t.state === TripState.Assigned) {
      t.state = TripState.Planned;
      t.veh = null;
    }
    v.next = null;
  }
  detachFromPattern(game, v, 'route');
  v.target = undefined;
}
