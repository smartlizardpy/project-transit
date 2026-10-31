// The City Activity Engine's travel choice (docs/city-activity-engine-plan.md, sections 7.1, 7.3–7.8).
//
// Each game hour, for every pair of activity zones that both reach your stops on foot, and for
// every tour kind starting this hour: the tour's choice of how to travel (walk, bike, car, taxi or
// your network), made once for the whole round trip from the outbound journey and the expected
// journey home. A tour whose way home has no bus running scores your network badly, so few take
// your bus to a late night out when the last bus has gone.
//
// The output is a per-minute rate per (boarding stop, alighting stop) with its mix of tour kinds,
// which feeds the existing passenger generator. Returns are not generated here: groups that
// arrive join the away pool (passengers.ts) and come back at their return time.

import type { Game } from '../engine.ts';
import type { Id, Leg } from '../types.ts';
import type { Itinerary } from '../passengers.ts';
import { ECON } from '../content.ts';
import { Grid } from '../world/places.ts';
import { buildActivityZones, zonesKey, type ActivityZones } from './zones.ts';
import { distributeTours, type TourMatrix } from './od.ts';
import { CHOICE, KIND, KINDS, KIND_COUNT, NESTS, STAY_HOME, TRAVELLERS, crowding, type Curve, type TravellerType } from './params.ts';
import { EVENT, EVENT_TEMPLATES, arriveShare, returnShareFrom, type GameEvent } from '../events.ts';
import { dayTiming, PROFILE, type DayTiming } from './profiles.ts';
import { buildTransitSkim, transitLeg, transitPathLeg, transitWaitFactor, type TransitSkim } from './transit.ts';
import { NO_WEATHER, tripFactor, type WeatherEffect } from './conditions.ts';

/** a zone's walk to one of your stops */
export interface AccessGroup {
  /** served-stop index */
  s: number;
  /** share of the zone's homes and of its activity nearest this stop, and their mean walk (minutes) */
  sp: number;
  wp: number;
  sa: number;
  wa: number;
}

/** Your network between two stops this hour, with walking on to a neighbouring stop if that is better. */
interface Skim {
  /** boarding and alighting served-stop indices, pair key */
  pair: number;
  it: Itinerary;
  /** extra walking minutes to reach the neighbouring stops */
  extra: number;
  /** crowding-weighted in-vehicle minutes and the reliability penalty, minutes */
  ivt: number;
  rel: number;
  /** the lines used, for checking the way home */
  routes: Id[];
  rkey: string;
  /** a number for `rkey` within one hour's costs (for caching the way home) */
  rid: number;
}

export interface ChoiceContext {
  S: number;
  itin: Map<number, Itinerary>;
  dist: Float32Array;
  fare: number;
  /** awareness and trust: minutes added to each journey leg on your network (trustMinutes) */
  trust: number;
  traffic: number;
  quality: Map<Id, { load: number; ontime: number }>;
  /** this hour's weather (none: a mild dry hour) */
  wx?: WeatherEffect;
  /** forecasts only: count events announced by this time, not those the player cannot know of yet */
  announcedBy?: number;
}

export interface RateOut {
  pairs: Int32Array;
  rate: Float32Array;
  /** per pair, the share of each tour kind (pairs × KIND_COUNT) */
  mix: Float32Array;
}

/** An event's attendees: origin zones with their share of the attendance (homes or stations), the venue's zone and point, and your stops near it. */
export interface EventSetup {
  origins: { z: number; w: number; home: boolean }[];
  zone: number;
  x: number;
  y: number;
  stops: { s: number; w: number; share: number }[];
}

const NEAR_STOP_M = 450;
/** Your stops this close (straight line) to a station are where people change to existing transit on foot. */
const FEED_M = 300;
/** A stop of yours near a station: its index in `feeds`, the stop, the station and the walk between them (minutes). */
interface Feed { id: number; x: number; st: number; w: number }
/** Stops near a station tried per stop: the ones your network reaches quickest. */
const FEED_TRY = 2;
/** Commuter minutes by which a change to the train may lose to the train all the way and still be offered. */
const FEED_DOMINATED = 15;
const NONE: AccessGroup[] = [];
const NO_NEAR: { s: number; extra: number }[] = [];
/** One pass with no stop at the destination end (only the change to existing transit is possible). */
const NO_STOP: (AccessGroup | null)[] = [null];
const MIN_TRIP_M = 380;
const HORIZON = 36;

const erf = (x: number) => {
  // Abramowitz and Stegun 7.1.26
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
};
const cdf = (c: Curve, x: number) => {
  let w = 0, v = 0;
  for (const [wt, mu, sd] of c) {
    w += wt;
    v += wt * 0.5 * (1 + erf((x - mu) / (sd * Math.SQRT2)));
  }
  return w ? v / w : 0;
};

/**
 * When the way home is needed: the share of returns in each hour after a tour starts in the
 * middle of an hour (about 25 minutes of travel, then the time at the activity).
 */
const RETURN_SHARE: number[][] = KINDS.map((k) => {
  const out = new Array<number>(HORIZON).fill(0);
  if (k.oneWay) return out;
  const lag = 0.5 + 0.4;
  for (let off = 0; off < HORIZON; off++) out[off] = Math.max(0, cdf(k.stay, off + 1 - lag) - cdf(k.stay, off - lag));
  const sum = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((v) => v / sum);
});

/** Share of a round trip's returns falling 0, 1, 2… hours after the hour it set off, by tour kind (empty for one-way kinds). */
export const returnShareByHour = (k: number): readonly number[] => RETURN_SHARE[k];

/** Share of a tour's returns that fall while existing transit runs, by kind and starting hour. */
const TRANSIT_HOME: Float64Array[] = KINDS.map((k, ki) => {
  const out = new Float64Array(24);
  if (k.oneWay) return out.fill(1);
  for (let h = 0; h < 24; h++) {
    let v = 0;
    for (let off = 0; off < HORIZON; off++) if (transitWaitFactor((h + off) % 24) > 0) v += RETURN_SHARE[ki][off];
    out[h] = v;
  }
  return out;
});

/** A whole tour by existing transit: out, and home again if it still runs (otherwise stranded). */
function transitTour(leg: number, k: number, hour: number, strandedLeg: number): number {
  if (!Number.isFinite(leg)) return Infinity;
  if (KINDS[k].oneWay) return leg;
  const a = TRANSIT_HOME[k][hour];
  return leg + a * leg + (1 - a) * strandedLeg;
}

const expWait = (h: number) => (h <= 12 ? h / 2 : 4 + h / 8);

/** Car time in minutes: the city formula used for timetables, with faster roads beyond 5 km (`road`: weather's speed factor). */
export function carMinutes(d: number, traffic: number, road = 1): number {
  return 9 + (Math.min(d, 5000) / 330 + Math.max(0, d - 5000) / 700 + traffic * (Math.min(d, 8000) / 450)) / road;
}

/** Generalised minutes of the modes other than your network for one journey leg. */
export function otherModes(d: number, ty: TravellerType, traffic: number, parking: number, wx: WeatherEffect = NO_WEATHER) {
  const walk = d <= CHOICE.walkMaxM ? ((d * CHOICE.detour) / CHOICE.walkSpeed) * ty.walkMode * wx.walk : Infinity;
  const bike = ty.bike > 0 && d <= CHOICE.bikeMaxM ? ((d * CHOICE.detour) / CHOICE.bikeSpeed) * wx.bikeRide + CHOICE.bikeConst * ty.bike + wx.bike : Infinity;
  const carT = carMinutes(d, traffic, wx.road);
  const car = ty.car > 0 ? carT + parking : Infinity;
  const taxi = carT - 4 + CHOICE.taxiWait + wx.taxiWait + ((CHOICE.taxiBase + (CHOICE.taxiPerKm * d) / 1000) * ty.taxi) / CHOICE.valueOfTime;
  return { walk, bike, car, taxi };
}

/**
 * Nested logit shares of the modes (generalised minutes, lower is better; Infinity: not
 * available), in MODES order: walk, bike, car, taxi, your network, existing transit, and when
 * `out` has a seventh place, your network to a station and on by existing transit (`feed`). The
 * nests are NESTS: active (walk, bike), private (car, taxi) and public transport (the rest).
 * Each mode's weight within its nest uses the nest's scale; each nest's weight is its inclusive
 * value, so with every nest scale at 1 this is the plain multinomial logit.
 */
function nestedInto(out: Float64Array, walk: number, bike: number, car: number, taxi: number, net: number, transit: number, wt: number, lam: number, feed = Infinity) {
  const m = Math.min(walk, bike, car, taxi, net, transit, feed);
  if (!Number.isFinite(m)) return;
  const la = lam * NESTS.active, lp = lam * NESTS.private, lt = lam * NESTS.transport;
  const e = (x: number, l: number) => (Number.isFinite(x) ? Math.exp(-(x - m) / l) : 0);
  const ew = e(walk, la), eb = e(bike, la), ec = e(car, lp), et = e(taxi, lp), en = e(net, lt), ex = e(transit, lt), ef = e(feed, lt);
  const sa = ew + eb, sp = ec + et, st = en + ex + ef;
  const na = sa > 0 ? sa ** NESTS.active : 0, np = sp > 0 ? sp ** NESTS.private : 0, nt = st > 0 ? st ** NESTS.transport : 0;
  const all = na + np + nt;
  if (!(all > 0)) return;
  const fa = sa > 0 ? (wt * na) / all / sa : 0, fp = sp > 0 ? (wt * np) / all / sp : 0, ft = st > 0 ? (wt * nt) / all / st : 0;
  out[0] += fa * ew;
  out[1] += fa * eb;
  out[2] += fp * ec;
  out[3] += fp * et;
  out[4] += ft * en;
  out[5] += ft * ex;
  if (out.length > 6) out[6] += ft * ef;
}

/** The six mode shares for these generalised minutes (MODES order), with the car available. For tests and the docs. */
export function modeShares(walk: number, bike: number, car: number, taxi: number, net: number, transit: number, lam = CHOICE.scale): number[] {
  const out = new Float64Array(6);
  nestedInto(out, walk, bike, car, taxi, net, transit, 1, lam);
  return [...out];
}

/**
 * The parts of the nested choice that do not depend on your network, for one kind of trip:
 * the reference minutes, the transport nest's scale, existing transit's weight in that nest, the
 * weights of the active and private nests (`na`; `npCar` with a car, `npNoCar` without) and each
 * mode's part of its nest (walk `fw`, bike `fb`; car `fcCar` and taxi `ftCar` with a car, taxi
 * alone without), with `withCar`/`noCar` the two nests together. Filled by `othersInto`.
 */
interface Others {
  ok: boolean; m: number; lt: number; ex: number; withCar: number; noCar: number;
  na: number; npCar: number; npNoCar: number; fw: number; fb: number; fcCar: number; ftCar: number;
}
const newOthers = (): Others => ({ ok: false, m: 0, lt: 1, ex: 0, withCar: 0, noCar: 0, na: 0, npCar: 0, npNoCar: 0, fw: 0, fb: 0, fcCar: 0, ftCar: 0 });
function othersInto(o: Others, lam: number, walk: number, bike: number, car: number, taxi: number, transit: number) {
  const m = Math.min(walk, bike, car, taxi, transit);
  o.ok = Number.isFinite(m);
  if (!o.ok) return o;
  const la = lam * NESTS.active, lp = lam * NESTS.private;
  o.m = m;
  o.lt = lam * NESTS.transport;
  const e = (x: number, l: number) => (Number.isFinite(x) ? Math.exp(-(x - m) / l) : 0);
  const ew = e(walk, la), eb = e(bike, la);
  const sa = ew + eb;
  o.na = sa > 0 ? sa ** NESTS.active : 0;
  o.fw = sa > 0 ? ew / sa : 0;
  o.fb = sa > 0 ? eb / sa : 0;
  const ec = e(car, lp), et = e(taxi, lp);
  const sp = ec + et;
  o.npCar = sp > 0 ? sp ** NESTS.private : 0;
  o.fcCar = sp > 0 ? ec / sp : 0;
  o.ftCar = sp > 0 ? et / sp : 0;
  o.npNoCar = et > 0 ? et ** NESTS.private : 0;
  o.withCar = o.na + o.npCar;
  o.noCar = o.na + o.npNoCar;
  o.ex = e(transit, o.lt);
  return o;
}

/**
 * All the shares (MODES order, then the change to the train in the seventh place) over people
 * with and without a car: the same as sharesInto, from `othersInto` and the transport-nest
 * weights of your network (`en`) and of the change to the train (`ef`), both from ptWeight.
 */
function sharesFrom(out: Float64Array, o: Others, en: number, ef: number, carShare: number) {
  out.fill(0);
  if (!o.ok) return;
  const st = en + o.ex + ef;
  const nt = st > 0 ? st ** NESTS.transport : 0;
  const part = (w: number, np: number, fc: number, ft: number) => {
    const all = o.na + np + nt;
    if (!(w > 0) || !(all > 0)) return;
    const a = (w * o.na) / all, p = (w * np) / all, t = st > 0 ? (w * nt) / all / st : 0;
    out[0] += a * o.fw;
    out[1] += a * o.fb;
    out[2] += p * fc;
    out[3] += p * ft;
    out[4] += t * en;
    out[5] += t * o.ex;
    out[6] += t * ef;
  };
  part(carShare, o.npCar, o.fcCar, o.ftCar);
  part(1 - carShare, o.npNoCar, 0, 1);
}
const pt = { net: 0, feed: 0 };
/** The weight in the transport nest of generalised minutes `x` (Infinity: 0), given `othersInto`. */
const ptWeight = (o: Others, x: number) => (o.ok && Number.isFinite(x) ? Math.exp(-(x - o.m) / o.lt) : 0);
/**
 * Shares of your network alone and of your network then existing transit, over people with and
 * without a car (`carShare`), given the other modes (`othersInto`) and the change to the train's
 * weight (`ef`, from ptWeight). The same nested logit as nestedInto, with only the terms that
 * change from stop to stop worked out; reused, read at once.
 */
function ptShares(o: Others, net: number, ef: number, carShare: number) {
  pt.net = pt.feed = 0;
  if (!o.ok) return pt;
  const en = Number.isFinite(net) ? Math.exp(-(net - o.m) / o.lt) : 0;
  const st = en + o.ex + ef;
  if (!(st > 0) || !(en + ef > 0)) return pt;
  const nt = st ** NESTS.transport;
  const nest = carShare * (nt / (o.withCar + nt)) + (1 - carShare) * (nt / (o.noCar + nt));
  pt.net = (nest * en) / st;
  pt.feed = (nest * ef) / st;
  return pt;
}

const one = new Float64Array(7);
/** Shares (nested logit, as in nestedInto) of your network alone [4] and your network then existing transit [6]; reused, read at once. */
function networkShares(lam: number, net: number, feed: number, walk: number, bike: number, car: number, taxi: number, transit: number): Float64Array {
  one.fill(0);
  nestedInto(one, walk, bike, car, taxi, net, transit, 1, lam, feed);
  return one;
}

/** Whole-tour generalised minutes of the modes other than your network. */
interface TourModes { walk: number; bike: number; car: number; taxi: number; transit: number }

/** Writes the shares of walk, bike, car, taxi, your network and existing transit into `out` (with and without a car). */
function sharesInto(out: Float64Array, net: number, o: TourModes, carShare: number, lam: number, feed = Infinity) {
  out.fill(0);
  if (carShare > 0) nestedInto(out, o.walk, o.bike, o.car, o.taxi, net, o.transit, carShare, lam, feed);
  if (carShare < 1) nestedInto(out, o.walk, o.bike, Infinity, o.taxi, net, o.transit, 1 - carShare, lam, feed);
}

/** The modes of the estimate, in its column order ('transit': the city's metro, tram, rail and ferries). */
export const MODES = ['walk', 'bike', 'car', 'taxi', 'network', 'transit'] as const;
/** Mode indices other than your network. */
const OTHER = [0, 1, 2, 3, 5];

export interface DayEstimate {
  /** zone count: pair keys are i * Z + j */
  Z: number;
  /** per zone pair: trips that day by mode, in MODES order */
  trips: Map<number, Float64Array>;
  /** zone pairs your network links at some hour of the day */
  served: Set<number>;
}

export class ActivityModel {
  zones: ActivityZones | null = null;
  tours: TourMatrix | null = null;
  /** per zone, its walks to your stops (for the stops of the last rebuild) */
  access: AccessGroup[][] = [];
  /** per served stop: neighbouring served stops within a short walk, with the extra minutes */
  near: { s: number; extra: number }[][] = [];
  /** zones that reach at least one stop, in index order */
  reach: number[] = [];
  /** the city's existing transit between the zones of each tour-matrix entry (with any closed links) */
  transit: TransitSkim | null = null;
  /** the skim with every link open (kept while a disruption lasts) */
  private transitOpen: TransitSkim | null = null;
  private day: { n: number; timing: DayTiming } | null = null;
  /** your stops within FEED_M of a station of the city's transit: the stop, the station and the walk between (minutes) */
  feeds: Feed[] = [];
  /** your stops' positions and a grid over them (from the last rebuild), for walks to venues */
  private stopXY: [number, number][] = [];
  private stopGrid = new Grid<number>(300);
  /** per event: where its attendees come from and the stops near its venue (cleared on rebuilds) */
  private eventCache = new Map<string, EventSetup>();

  /** Volumes and start times for the game day containing `t` (calendar and place profiles). */
  timing(game: Game, t: number): DayTiming {
    const n = Math.floor(t / 86400);
    if (this.day?.n !== n) this.day = { n, timing: dayTiming(game.dayTypeAt(t)) };
    return this.day.timing;
  }

  private inputs(game: Game) {
    return {
      region: game.region,
      toXY: game.geo.P.toXY,
      toLngLat: game.geo.P.toLngLat,
      owned: game.state.territory.owned,
      season: game.calendarAt().season,
    };
  }

  /** The map, territory or season changed since the zones were built. */
  stale(game: Game): boolean {
    return !this.zones || this.zones.key !== zonesKey(this.inputs(game));
  }

  /** Zones and tours for this map, territory and season (rebuilt only when they change). */
  ensureZones(game: Game): ActivityZones {
    const inp = this.inputs(game);
    const key = zonesKey(inp);
    if (!this.zones || this.zones.key !== key) {
      this.zones = buildActivityZones(inp);
      this.tours = distributeTours(this.zones);
      this.transit = this.transitOpen = buildTransitSkim(game.region.transit, this.zones, this.tours);
      this.access = [];
      this.eventCache.clear();
    }
    return this.zones;
  }

  /** The city's transit with the links closed by disruptions at `t` (rebuilt only when that set changes). */
  private ensureTransit(game: Game, t: number) {
    const closed = game.closedTransitLinks(t);
    const key = closed.join(',');
    if (this.transit?.closed === key) return;
    this.transit = key ? buildTransitSkim(game.region.transit, this.zones!, this.tours!, closed) : this.transitOpen;
  }

  /** Walks from each zone to the served stops (when stops, lines or territory change). */
  rebuildAccess(game: Game, xy: [number, number][]) {
    const zs = this.ensureZones(game);
    const g = game.region.demand;
    const R = CHOICE.accessM / CHOICE.detour;
    const grid = new Grid<number>(300);
    xy.forEach(([x, y], s) => grid.add(x, y, s));
    this.stopXY = xy;
    this.stopGrid = grid;
    this.eventCache.clear();
    this.feeds = [];
    (game.region.transit?.stations ?? []).forEach((st, i) => {
      for (const x of grid.near(st.x, st.y, FEED_M)) {
        const d = Math.hypot(xy[x][0] - st.x, xy[x][1] - st.y);
        if (d <= FEED_M) this.feeds.push({ id: this.feeds.length, x, st: i, w: Math.max(1, (d * CHOICE.detour) / CHOICE.walkSpeed) });
      }
    });
    const nearest = (x: number, y: number): { s: number; d: number } | null => {
      let best = -1, bd = Infinity;
      for (const s of grid.near(x, y, R)) {
        const d = Math.hypot(xy[s][0] - x, xy[s][1] - y);
        if (d <= R && (d < bd || (d === bd && s < best))) {
          bd = d;
          best = s;
        }
      }
      return best >= 0 ? { s: best, d: bd } : null;
    };
    const Z = zs.list.length;
    const groups = Array.from({ length: Z }, () => new Map<number, AccessGroup>());
    const totP = new Float64Array(Z), totA = new Float64Array(Z);
    const walkMin = (d: number) => (d * CHOICE.detour) / CHOICE.walkSpeed;
    const N = g.w * g.h;
    for (let k = 0; k < N; k++) {
      const hz = zs.homeOf[k], az = zs.actOf[k];
      if (hz < 0 && az < 0) continue;
      const wp = zs.homeW[k], wa = zs.actW[k];
      if (hz >= 0) totP[hz] += wp;
      const placeCell = az >= 0 && zs.list[az].kind === 'place';
      if (az >= 0 && !placeCell) totA[az] += wa;
      if (!(wp > 0) && !(wa > 0)) continue;
      const x = g.x0 + ((k % g.w) + 0.5) * g.cell, y = g.y0 + (Math.floor(k / g.w) + 0.5) * g.cell;
      const n = nearest(x, y);
      if (!n) continue;
      const w = walkMin(n.d);
      const add = (z: number, isHome: boolean, weight: number) => {
        let a = groups[z].get(n.s);
        if (!a) groups[z].set(n.s, (a = { s: n.s, sp: 0, wp: 0, sa: 0, wa: 0 }));
        if (isHome) {
          a.sp += weight;
          a.wp += weight * w;
        } else {
          a.sa += weight;
          a.wa += weight * w;
        }
      };
      if (hz >= 0 && wp > 0) add(hz, true, wp);
      if (az >= 0 && !placeCell && wa > 0) add(az, false, wa);
    }
    // places: from their entrance (or another way in)
    for (let z = 0; z < Z; z++) {
      const zone = zs.list[z];
      if (zone.kind !== 'place') continue;
      const place = zone.place ? game.geo.places.byId.get(zone.place) : undefined;
      const pts: [number, number][] = [[zone.x, zone.y], ...(place?.access ?? []).map((ll) => game.geo.xy(ll))];
      let best: { s: number; d: number } | null = null;
      for (const [x, y] of pts) {
        const n = nearest(x, y);
        if (n && (!best || n.d < best.d)) best = n;
      }
      totA[z] = 1;
      if (best) groups[z].set(best.s, { s: best.s, sp: 0, wp: 0, sa: 1, wa: walkMin(best.d) });
    }
    this.access = groups.map((m, z) => {
      const list = [...m.values()].map((a) => ({
        s: a.s,
        sp: totP[z] > 0 ? a.sp / totP[z] : 0,
        wp: a.sp > 0 ? a.wp / a.sp : 0,
        sa: totA[z] > 0 ? a.sa / totA[z] : 0,
        wa: a.sa > 0 ? a.wa / a.sa : 0,
      }));
      list.sort((a, b) => b.sp + b.sa - (a.sp + a.sa) || a.s - b.s);
      return list.slice(0, 4);
    });
    this.reach = [];
    for (let z = 0; z < Z; z++) if (this.access[z].length) this.reach.push(z);
    // neighbouring stops a short walk away
    this.near = xy.map(([x, y], s) => {
      const out: { s: number; extra: number }[] = [];
      for (const t of grid.near(x, y, NEAR_STOP_M)) {
        if (t === s) continue;
        const d = Math.hypot(xy[t][0] - x, xy[t][1] - y);
        if (d <= NEAR_STOP_M) out.push({ s: t, extra: 0.6 * walkMin(d) });
      }
      out.sort((a, b) => a.extra - b.extra || a.s - b.s);
      return out.slice(0, 4);
    });
  }

  /**
   * Your network's generalised minutes for a tour that starts in the hour from `t0`, between two
   * served stops: the outbound journey and the whole tour (with the expected way home). Shared by
   * the hourly rates and the daily estimate.
   */
  private networkCost(game: Game, t0: number, ctx: ChoiceContext) {
    const { S, itin, dist } = ctx;
    // per stop pair (an array while that stays small)
    const flat = S <= 400;
    const skimArr: (Skim | null | undefined)[] = flat ? new Array(S * S) : [];
    const skimMap = new Map<number, Skim | null>();
    const skim = (a: number, b: number): Skim | null => {
      const key = a * S + b;
      let sk = flat ? skimArr[key] : skimMap.get(key);
      if (sk !== undefined) return sk;
      sk = null;
      let best = Infinity;
      // the two stops, or a neighbour of either a short walk away
      const na = this.near[a] ?? NO_NEAR, nb = this.near[b] ?? NO_NEAR;
      for (let ia = -1; ia < na.length; ia++) {
        const xs = ia < 0 ? a : na[ia].s, xe = ia < 0 ? 0 : na[ia].extra;
        for (let ib = -1; ib < nb.length; ib++) {
          const ys = ib < 0 ? b : nb[ib].s, ye = ib < 0 ? 0 : nb[ib].extra;
          if (xs === ys || dist[xs * S + ys] < MIN_TRIP_M) continue;
          const it = itin.get(xs * S + ys);
          if (!it) continue;
          const c = it.gt + 1.5 * (xe + ye);
          if (c < best) {
            best = c;
            sk = { pair: xs * S + ys, it, extra: xe + ye, ivt: 0, rel: 0, routes: [], rkey: '', rid: 0 };
          }
        }
      }
      if (sk) {
        let load = 0, rel = 0;
        const routes = new Set<Id>();
        for (const leg of sk.it.legs) {
          routes.add(leg.r);
          const q = ctx.quality.get(leg.r);
          load += crowding(q?.load ?? 0.5);
          rel += Math.max(0, 0.9 - (q?.ontime ?? 1)) * 18;
        }
        sk.ivt = sk.it.ivt * (load / Math.max(1, sk.it.legs.length));
        sk.rel = rel;
        sk.routes = [...routes].sort();
        sk.rkey = sk.routes.join(',');
        let rid = rids.get(sk.rkey);
        if (rid === undefined) rids.set(sk.rkey, (rid = rids.size));
        sk.rid = rid;
      }
      if (flat) skimArr[key] = sk;
      else skimMap.set(key, sk);
      return sk;
    };
    // the way home: headways per line for the coming hours
    const hw = new Map<Id, (number | null)[]>();
    const headways = (r: Id) => {
      let a = hw.get(r);
      if (!a) {
        a = Array.from({ length: HORIZON }, (_, off) => game.headwayAt(r, 0, t0 + (off + 0.5) * 3600));
        hw.set(r, a);
      }
      return a;
    };
    const home = new Map<string, { avail: number; wait: number }>();
    const homeK: ({ avail: number; wait: number } | undefined)[] = [];
    const rids = new Map<string, number>();
    const wayHome = (sk: Skim, k: number, ret?: number[], rkey = '') => {
      // the usual return times by kind: a numeric key; an event's own return times: by name
      const key = ret ? `${sk.rkey}|${k}|${rkey}` : null;
      let v = key ? home.get(key) : homeK[sk.rid * KIND_COUNT + k];
      if (!v) {
        let avail = 0, wait = 0;
        const share = ret ?? RETURN_SHARE[k];
        const lines = sk.routes.map(headways);
        for (let off = 0; off < HORIZON; off++) {
          if (!share[off]) continue;
          let ok = true, w = 0;
          for (const l of lines) {
            const h = l[off];
            if (h === null) {
              ok = false;
              break;
            }
            w += expWait(h);
          }
          if (!ok) continue;
          avail += share[off];
          wait += share[off] * w;
        }
        v = { avail, wait: avail > 0 ? wait / avail : 0 };
        if (key) home.set(key, v);
        else homeK[sk.rid * KIND_COUNT + k] = v;
      }
      return v;
    };
    const fareMin = (ctx.fare - ECON.referenceFare) / 0.15;
    // the weather: walking to the stop and waiting weigh more (the way home is taken to be the same)
    const wx = ctx.wx ?? NO_WEATHER;
    // one result, filled on each call: read it before the next call (or copy it)
    const res = { pair: 0, out: 0, tour: 0, avail: 1 };
    /** null: no itinerary between the two stops (or their neighbours) this hour */
    /** `ret`, `rkey`: when people come home, by hour from now (events), and a key for it */
    return (sa: number, sb: number, k: number, ty: TravellerType, wa: number, wb: number, strandedLeg: number, ret?: number[], rkey?: string) => {
      const sk = skim(sa, sb);
      if (!sk) return null;
      const it = sk.it;
      const base = ty.walk * wx.walk * (wa + wb + sk.extra + (it.walk ?? 0)) + sk.ivt + ty.change * it.transfers + ty.fare * fareMin + ty.rel * sk.rel + ctx.trust;
      const out = base + ty.wait * wx.wait * it.wait;
      res.pair = sk.pair;
      res.out = out;
      if (KINDS[k].oneWay) {
        res.tour = out;
        res.avail = 1;
        return res;
      }
      const h = wayHome(sk, k, ret, rkey);
      res.tour = out + h.avail * (base + ty.wait * wx.wait * h.wait) + (1 - h.avail) * strandedLeg;
      res.avail = h.avail;
      return res;
    };
  }

  /** `rates` for a forecast: afterwards the rail closures the simulation is using are put back. */
  forecastRates(game: Game, t0: number, ctx: ChoiceContext): RateOut {
    this.ensureZones(game);
    const keep = this.transit;
    try {
      return this.rates(game, t0, ctx);
    } finally {
      this.transit = keep;
    }
  }

  /**
   * For an hour's itineraries. `from(a)`: the (at most FEED_TRY) stops near a station that served
   * stop `a` reaches quickest by your network, with the walk to the station. `best(a, j)`: of those,
   * where the change to the city's transit gets to zone `j` quickest (commuter weights), or null.
   * Both cached for the hour.
   */
  private feeder(ctx: ChoiceContext) {
    const fromCache = new Map<number, Feed[]>();
    const Z = this.zones!.list.length;
    /** per (stop, zone): the feed's id + 1, 0 for none, -1 not worked out yet; and its commuter minutes */
    const cache = new Int32Array(ctx.S * Z).fill(-1);
    const minutes = new Float32Array(ctx.S * Z);
    const tr = this.transit!;
    const from = (a: number) => {
      let list = fromCache.get(a);
      if (list) return list;
      const scored: { f: Feed; c: number }[] = [];
      for (const f of this.feeds) {
        if (f.x === a) continue;
        const it = ctx.itin.get(a * ctx.S + f.x);
        if (it) scored.push({ f, c: it.gt + 1.5 * f.w });
      }
      scored.sort((x, y) => x.c - y.c || x.f.x - y.f.x || x.f.st - y.f.st);
      list = scored.slice(0, FEED_TRY).map((x) => x.f);
      fromCache.set(a, list);
      return list;
    };
    const best = (a: number, j: number): Feed | null => {
      const key = a * Z + j;
      const v = cache[key];
      if (v >= 0) return v ? this.feeds[v - 1] : null;
      let hit: Feed | null = null;
      let bc = Infinity;
      for (const f of from(a)) {
        const p = tr.toZone(f.st, j);
        if (!p) continue;
        const c = ctx.itin.get(a * ctx.S + f.x)!.gt + 1.5 * f.w + 1.2 * p.walk + p.ivt + 1.6 * p.wait + 13 * p.changes;
        if (c < bc) (bc = c), (hit = f);
      }
      cache[key] = hit ? hit.id + 1 : 0;
      minutes[key] = bc;
      return hit;
    };
    // A change to the train is offered only where it is not clearly worse than the train all the
    // way (FEED_DOMINATED commuter minutes more, a share well under 1%): mostly not near stations.
    // `worth(i, j)`: for some stop near zone i, a change to the train that reaches zone j and is
    // worth offering (the last zone pair asked is kept: tour entries come by origin, then destination).
    let lastI = -1, lastJ = -1, last = false;
    const worth = (i: number, j: number) => {
      if (i === lastI && j === lastJ) return last;
      lastI = i;
      lastJ = j;
      let bestFeed = Infinity;
      for (const a of this.access[i]) if (best(a.s, j)) bestFeed = Math.min(bestFeed, minutes[a.s * Z + j] + 1.2 * Math.min(a.wp, a.wa));
      const p = Number.isFinite(bestFeed) ? tr.between(i, j) : null;
      const direct = p ? 1.2 * p.walk + p.ivt + 1.6 * p.wait + 13 * p.changes : Infinity;
      last = bestFeed < direct + FEED_DOMINATED;
      return last;
    };
    return { from, best, worth };
  }

  /** Per-minute rates on your network for the hour starting at `t0`. */
  rates(game: Game, t0: number, ctx: ChoiceContext): RateOut {
    const zs = this.ensureZones(game);
    this.ensureTransit(game, t0);
    const m = this.tours!;
    const flights = game.flightFactors(t0);
    const day = this.timing(game, t0);
    const hour = Math.floor(((t0 % 86400) + 86400) % 86400 / 3600);
    const wf = transitWaitFactor(hour);
    const K = KIND_COUNT;
    const wx = ctx.wx ?? NO_WEATHER;
    const cost = this.networkCost(game, t0, ctx);
    const feeder = this.feeds.length ? this.feeder(ctx) : null;
    const feedOf = new Int8Array(zs.list.length).fill(-1);
    /** whether some stop near zone i reaches a stop near a station */
    const feedAt = (i: number) => {
      if (feedOf[i] < 0) feedOf[i] = feeder && this.access[i].some((a) => feeder.from(a.s).length > 0) ? 1 : 0;
      return feedOf[i] === 1;
    };
    const out = new Map<number, { r: number; mix: Float64Array }>();
    const put = (pair: number, k: number, r: number) => {
      let o = out.get(pair);
      if (!o) out.set(pair, (o = { r: 0, mix: new Float64Array(K) }));
      o.r += r;
      o.mix[k] += r;
    };
    const oth = newOthers();
    // per zone: the bus part of a change to the train, by origin stop (its place in the zone's
    // list), stop near a station and kind; `busAt` holds the zone + 1 where filled (-1: none)
    const F = Math.max(1, this.feeds.length);
    const busAt = new Int32Array(4 * F * K), busPair = new Int32Array(4 * F * K), busTour = new Float64Array(4 * F * K), busAvail = new Float64Array(4 * F * K);
    for (const i of this.reach) {
      const gi = this.access[i];
      for (let e = m.start[i]; e < m.start[i + 1]; e++) {
        const j = m.d[e];
        const k = m.k[e];
        const kind = KINDS[k];
        // your network, and your network to a station then on by train (not for trips that start at the activity end)
        const gj = this.access[j] ?? NONE;
        const feedable = !kind.toHome && wf > 0 && feedAt(i);
        if (!gj.length && !feedable) continue;
        // timing and volume follow the profile of the activity end (the airport for arrivals)
        const act = kind.toHome ? i : j;
        const pk = zs.profile[act] * K + k;
        let th = m.tours[e] * day.factor[pk] * day.share[pk * 24 + hour] * tripFactor(wx, k, zs.park[act], zs.beach[act], zs.profile[act] === PROFILE.mall);
        // delayed flights: arrivals held back, then bunched (flight disruptions)
        if (kind.toHome && flights.size) th *= flights.get(zs.list[i].place ?? '') ?? 1;
        if (!(th > 1e-4)) continue;
        const feeds = feedable && feeder!.worth(i, j);
        if (!gj.length && !feeds) continue;
        const ty = TRAVELLERS[kind.type];
        const d = m.dist[e];
        const zi = zs.list[i], zj = zs.list[j];
        const others = otherModes(d, ty, ctx.traffic, zj.parking, wx);
        const carShare = Math.min(1, (kind.toHome ? zj.car : zi.car) * ty.car);
        const hs = zs.homeShare[i * K + k];
        const lam = kind.oneWay ? CHOICE.scale : 2 * CHOICE.scale;
        const mult = kind.oneWay ? 1 : 2;
        const strandedLeg = others.taxi + CHOICE.stranded;
        const tr = transitTour(transitLeg(this.transit!, e, ty, wf, wx), k, hour, strandedLeg);
        othersInto(oth, lam, mult * others.walk, mult * others.bike, carShare > 0 ? mult * others.car : Infinity, mult * others.taxi, tr);
        for (let ai = 0; ai < gi.length; ai++) {
          const a = gi[ai];
          // origin side: homes for tours from home, activity for tours from work, hotels or stations
          const sa = hs * a.sp + (1 - hs) * a.sa;
          if (!(sa > 0)) continue;
          const wa = a.sp + a.sa > 0 ? (hs * a.sp * a.wp + (1 - hs) * a.sa * a.wa) / (hs * a.sp + (1 - hs) * a.sa) : 0;
          const f = feeds ? feeder!.best(a.s, j) : null;
          // the bus part (the same for every destination from here: kept for this zone), then the
          // change to the train (each way on a round trip) and the train
          let fPair = -1, feedTour = Infinity;
          if (f) {
            const key = (ai * F + f.id) * K + k;
            if (busAt[key] !== i + 1) {
              const c = cost(a.s, f.x, k, ty, wa, f.w, 0);
              busAt[key] = i + 1;
              busPair[key] = c ? c.pair : -1;
              busTour[key] = c ? c.tour : Infinity;
              busAvail[key] = c ? c.avail : 0;
            }
            fPair = busPair[key];
            if (fPair >= 0) feedTour = busTour[key] + (1 - busAvail[key]) * strandedLeg + mult * ty.change + transitTour(transitPathLeg(this.transit!.toZone(f.st, j), ty, wf, wx), k, hour, strandedLeg);
          }
          if (!gj.length && !Number.isFinite(feedTour)) continue;
          const ef = ptWeight(oth, feedTour);
          for (const b of gj.length ? gj : NO_STOP) {
            const sb = !b ? 1 : kind.toHome ? b.sp : b.sa;
            if (!(sb > 0)) continue;
            const c = b ? cost(a.s, b.s, k, ty, wa, kind.toHome ? b.wp : b.wa, strandedLeg) : null;
            if (!c && !Number.isFinite(feedTour)) continue;
            const x = ptShares(oth, c ? c.tour : Infinity, ef, carShare);
            const p = x.net, pf = x.feed;
            if (!(p + pf > 0)) continue;
            const made = kind.optional ? (1 - STAY_HOME * (1 - p - pf)) / (1 - STAY_HOME) : 1;
            if (c && p > 0) put(c.pair, k, (th * sa * sb * p * made) / 60);
            if (fPair >= 0 && pf > 0) put(fPair, k, (th * sa * sb * pf * made) / 60);
          }
        }
      }
    }
    this.eventRates(game, t0, ctx, cost, out);
    const keys = [...out.keys()].sort((x, y) => x - y);
    const res: RateOut = { pairs: Int32Array.from(keys), rate: new Float32Array(keys.length), mix: new Float32Array(keys.length * K) };
    keys.forEach((key, n) => {
      const o = out.get(key)!;
      res.rate[n] = o.r;
      for (let k = 0; k < K; k++) res.mix[n * K + k] = o.r > 0 ? o.mix[k] / o.r : 0;
    });
    return res;
  }

  /**
   * Event attendees setting off in the hour from `t0` (events.ts): from homes on the map (long
   * distance decay) and from stations and piers, to the stops near the venue. Their way home is
   * scored at the event's end, so a match ending after the last bus sends people to taxis.
   * Parking near the venue is scarce and taxis hard to find, so capacity you provide wins riders.
   * No money comes with an event: only those who board pay their fare.
   */
  private eventRates(game: Game, t0: number, ctx: ChoiceContext, cost: ReturnType<ActivityModel['networkCost']>, out: Map<number, { r: number; mix: Float64Array }>) {
    const zs = this.zones!;
    const hour = Math.floor(((t0 % 86400) + 86400) % 86400 / 3600);
    const wf = transitWaitFactor(hour);
    const wx = ctx.wx ?? NO_WEATHER;
    const k = KIND.event;
    const kind = KINDS[k];
    const ty = TRAVELLERS[kind.type];
    const lam = 2 * CHOICE.scale;
    for (const ev of game.crowdEventsSettingOff(t0, t0 + 3600)) {
      if (ctx.announcedBy !== undefined && ev.ann > ctx.announcedBy) continue;
      const share = arriveShare(ev, t0, t0 + 3600);
      if (!(share > 1e-4)) continue;
      const set = this.eventSetup(game, ev);
      if (!set.stops.length) continue;
      const tpl = EVENT_TEMPLATES[ev.kind];
      const total = ev.people * share * wx.trips[k];
      const ret = returnShareFrom(ev, t0, HORIZON);
      let transitHome = 0;
      for (let off = 0; off < HORIZON; off++) if (transitWaitFactor((hour + off) % 24) > 0) transitHome += ret[off];
      const zv = zs.list[set.zone];
      for (const o of set.origins) {
        const gi = this.access[o.z];
        if (!gi?.length) continue;
        const th = total * o.w;
        if (!(th > 1e-4)) continue;
        const zi = zs.list[o.z];
        const d = Math.max(zi.inner / 2, Math.hypot(zi.x - set.x, zi.y - set.y));
        const others = otherModes(d, ty, ctx.traffic, zv.parking + tpl.parking, wx);
        others.taxi += tpl.taxiWait;
        const carShare = o.home ? Math.min(1, zi.car * ty.car) : 0;
        const strandedLeg = others.taxi + CHOICE.stranded;
        const leg = transitPathLeg(this.transit!.between(o.z, set.zone), ty, wf, wx);
        const tr = Number.isFinite(leg) ? leg + transitHome * leg + (1 - transitHome) * strandedLeg : Infinity;
        for (const a of gi) {
          const sa = o.home ? a.sp : a.sa;
          if (!(sa > 0)) continue;
          const wa = o.home ? a.wp : a.wa;
          for (const b of set.stops) {
            const c = cost(a.s, b.s, k, ty, wa, b.w, strandedLeg, ret, ev.id);
            if (!c) continue;
            const withCar = carShare > 0 ? networkShares(lam, c.tour, Infinity, 2 * others.walk, 2 * others.bike, 2 * others.car, 2 * others.taxi, tr)[4] : 0;
            const noCar = carShare < 1 ? networkShares(lam, c.tour, Infinity, 2 * others.walk, 2 * others.bike, Infinity, 2 * others.taxi, tr)[4] : 0;
            const p = carShare * withCar + (1 - carShare) * noCar;
            if (!(p > 0)) continue;
            const r = (th * sa * b.share * p) / 60;
            let x = out.get(c.pair);
            if (!x) out.set(c.pair, (x = { r: 0, mix: new Float64Array(KIND_COUNT) }));
            x.r += r;
            x.mix[k] += r;
          }
        }
      }
    }
  }

  /** Where an event's attendees come from, the venue's zone, and your stops within a walk of it (cached per event). */
  eventSetup(game: Game, ev: GameEvent): EventSetup {
    const hit = this.eventCache.get(ev.id);
    if (hit) return hit;
    const zs = this.ensureZones(game);
    const place = game.geo.places.byId.get(ev.place);
    const [x, y] = game.geo.xy(place?.lngLat ?? ev.at);
    // the venue's zone: its own place zone, else the zone of its cell, else the nearest
    let zone = zs.list.findIndex((z) => z.kind === 'place' && z.place === ev.place);
    if (zone < 0) {
      const g = game.region.demand;
      const cx = Math.floor((x - g.x0) / g.cell), cy = Math.floor((y - g.y0) / g.cell);
      const cell = cx >= 0 && cy >= 0 && cx < g.w && cy < g.h ? cy * g.w + cx : -1;
      zone = cell >= 0 ? (zs.actOf[cell] >= 0 ? zs.actOf[cell] : zs.homeOf[cell]) : -1;
    }
    if (zone < 0) {
      let bd = Infinity;
      zs.list.forEach((z, i) => {
        const d = Math.hypot(z.x - x, z.y - y);
        if (z.kind !== 'beyond' && d < bd) (bd = d), (zone = i);
      });
    }
    // origins: homes with a long decay, and stations and piers near the venue
    const origins: EventSetup['origins'] = [];
    const K = KIND_COUNT;
    let sumH = 0, sumG = 0;
    const gate = new Set(['rail_station', 'metro_station', 'ferry_pier', 'bus_station']);
    const hw: number[] = [], gw: number[] = [];
    zs.list.forEach((z, i) => {
      const d = Math.hypot(z.x - x, z.y - y);
      hw[i] = z.kind !== 'place' && z.residents > 0 ? z.residents * Math.exp(-d / EVENT.decay) : 0;
      let prod = 0;
      if (z.kind === 'place' && z.place && gate.has(game.geo.places.byId.get(z.place)?.category ?? '')) for (let kk = 0; kk < K; kk++) prod += zs.prod[i * K + kk];
      gw[i] = prod > 0 ? prod * Math.exp(-d / EVENT.gatewayDecay) : 0;
      sumH += hw[i];
      sumG += gw[i];
    });
    zs.list.forEach((_, i) => {
      if (hw[i] > 0 && sumH > 0) origins.push({ z: i, w: (EVENT.local * hw[i]) / sumH, home: true });
      if (gw[i] > 0 && sumG > 0) origins.push({ z: i, w: (EVENT.gateway * gw[i]) / sumG, home: false });
    });
    // your stops within a walk of the venue's entrance (or another way in), nearest first
    const pts: [number, number][] = [[x, y], ...(place?.access ?? []).map((ll) => game.geo.xy(ll))];
    const R = EVENT.walkM / CHOICE.detour;
    const best = new Map<number, number>();
    for (const [px, py] of pts)
      for (const s of this.stopGrid.near(px, py, R)) {
        const d = Math.hypot(this.stopXY[s][0] - px, this.stopXY[s][1] - py);
        if (d <= R && d < (best.get(s) ?? Infinity)) best.set(s, d);
      }
    const near = [...best.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, 3);
    const ws = near.map(([, d]) => Math.exp(-((d * CHOICE.detour) / CHOICE.walkSpeed) / 3));
    const wsum = ws.reduce((a, b) => a + b, 0) || 1;
    const set: EventSetup = { zone, x, y, origins, stops: near.map(([s, d], i) => ({ s, w: (d * CHOICE.detour) / CHOICE.walkSpeed, share: ws[i] / wsum })) };
    this.eventCache.set(ev.id, set);
    return set;
  }

  /**
   * Modelled trips for one whole day between activity zones, by mode (walk, bike, car, taxi, your
   * network): what everyone does, not only your passengers. `hours[h]` is the choice context for
   * the hour starting at `day0 + h` hours (an empty itinerary map when no line runs). Only pairs
   * with an end where `inScope` holds are counted. Other modes use the traffic of each tour kind's
   * busiest starting hour; your network is scored hour by hour, as the simulation does.
   */
  estimate(game: Game, day0: number, hours: ChoiceContext[], inScope: (z: number) => boolean): DayEstimate {
    const zs = this.ensureZones(game);
    this.ensureTransit(game, game.t);
    const m = this.tours!;
    const Z = zs.list.length, K = KIND_COUNT;
    const day = this.timing(game, day0 + 12 * 3600);
    const trips = new Map<number, Float64Array>();
    const served = new Set<number>();
    const add = (i: number, j: number, x: number, v: number) => {
      if (!v) return;
      const key = i * Z + j;
      let a = trips.get(key);
      if (!a) trips.set(key, (a = new Float64Array(MODES.length)));
      a[x] += v;
    };
    const costs = hours.map((ctx, h) => (ctx.itin.size ? this.networkCost(game, day0 + h * 3600, ctx) : null));
    const feeders = hours.map((ctx) => (ctx.itin.size && this.feeds.length ? this.feeder(ctx) : null));
    const reach = new Uint8Array(Z);
    for (const z of this.reach) reach[z] = 1;
    // each profile and kind's busiest starting hour
    const peak = new Int8Array(day.factor.length);
    for (let pk = 0; pk < peak.length; pk++) {
      let best = 0;
      for (let h = 1; h < 24; h++) if (day.share[pk * 24 + h] > day.share[pk * 24 + best]) best = h;
      peak[pk] = best;
    }
    // the weather: hours with the same effect on walking, cycling, roads and waiting form a group;
    // per group, profile-kind and mall flag, the day's share of tours (with the weather's trip
    // making), split into the part for every zone and the parts that scale with its parks and beaches
    const wxH = hours.map((c) => c?.wx ?? NO_WEATHER);
    while (wxH.length < 24) wxH.push(NO_WEATHER);
    const groups: { wx: WeatherEffect; hours: number[] }[] = [];
    const groupOf = new Int8Array(24);
    {
      const byKey = new Map<string, number>();
      for (let h = 0; h < 24; h++) {
        const e = wxH[h];
        const key = `${e.walk}|${e.wait}|${e.bikeRide}|${e.bike}|${e.road}|${e.taxiWait}`;
        let g = byKey.get(key);
        if (g === undefined) byKey.set(key, (g = groups.push({ wx: e, hours: [] }) - 1));
        groups[g].hours.push(h);
        groupOf[h] = g;
      }
    }
    const G = groups.length, PK = day.factor.length;
    const gA = new Float64Array(G * PK * 2), gP = new Float64Array(G * PK * 2), gB = new Float64Array(G * PK * 2);
    for (let g = 0; g < G; g++)
      for (let pk = 0; pk < PK; pk++) {
        const attr = KINDS[pk % K].attr;
        const outdoor = attr === 'visit' || attr === 'leisure', indoor = attr === 'shopping' || attr === 'leisure';
        for (const h of groups[g].hours) {
          const sh = day.share[pk * 24 + h];
          if (!sh) continue;
          const e = wxH[h];
          for (let mall = 0; mall < 2; mall++) {
            const v = sh * e.trips[pk % K] * (mall && indoor ? e.mall : 1);
            const x = (g * PK + pk) * 2 + mall;
            gA[x] += v;
            if (outdoor) {
              gP[x] += v * (e.park - 1);
              gB[x] += v * (e.beach - 1);
            }
          }
        }
      }
    const qg = Array.from({ length: G }, () => new Float64Array(MODES.length));
    const tg: TourModes[] = Array.from({ length: G }, () => ({ walk: 0, bike: 0, car: 0, taxi: 0, transit: 0 }));
    // the seventh place: your network to a station, then on by existing transit (counted with your network)
    const s = new Float64Array(MODES.length + 1);
    const oth = newOthers();
    // per origin zone: the bus part of a change to the train by hour, origin stop (its place in the
    // zone's list), stop near a station and kind; `busAt` holds the zone + 1 where filled
    const F = Math.max(1, this.feeds.length);
    const busAt = new Int32Array(24 * 4 * F * K), busTour = new Float64Array(24 * 4 * F * K), busAvail = new Float64Array(24 * 4 * F * K);
    // the zone pair being summed (tour entries come by origin, then destination): trips each way
    // by mode and whether your network links it, written to `trips` and `served` once per pair
    let pi = -1, pj = -1, linkIJ = false, linkJI = false;
    const ij = new Float64Array(MODES.length), ji = new Float64Array(MODES.length);
    const flush = () => {
      if (pi < 0) return;
      for (let x = 0; x < MODES.length; x++) {
        add(pi, pj, x, ij[x]);
        add(pj, pi, x, ji[x]);
      }
      if (linkIJ) served.add(pi * Z + pj);
      if (linkJI) served.add(pj * Z + pi);
      ij.fill(0);
      ji.fill(0);
      linkIJ = linkJI = false;
      pi = -1;
    };
    for (let i = 0; i < Z; i++) {
      for (let e = m.start[i]; e < m.start[i + 1]; e++) {
        const j = m.d[e];
        if (i !== pi || j !== pj) {
          flush();
          pi = i;
          pj = j;
        }
        if (!inScope(i) && !inScope(j)) continue;
        const k = m.k[e];
        const kind = KINDS[k];
        const act = kind.toHome ? i : j;
        const pk = zs.profile[act] * K + k;
        const base = m.tours[e] * day.factor[pk];
        if (!(base > 1e-4)) continue;
        const mall = zs.profile[act] === PROFILE.mall ? 1 : 0;
        const park = zs.park[act], beach = zs.beach[act];
        const ty = TRAVELLERS[kind.type];
        const zi = zs.list[i], zj = zs.list[j];
        const ph = peak[pk];
        const mult = kind.oneWay ? 1 : 2;
        const carShare = Math.min(1, (kind.toHome ? zj.car : zi.car) * ty.car);
        const lam = kind.oneWay ? CHOICE.scale : 2 * CHOICE.scale;
        const strandedLeg = otherModes(m.dist[e], ty, hours[ph]?.traffic ?? 0, zj.parking).taxi + CHOICE.stranded;
        const trAt = (h: number, wx: WeatherEffect) => transitTour(transitLeg(this.transit!, e, ty, transitWaitFactor(h), wx), k, h, strandedLeg);
        // everyone, as if your network did not exist: each weather group at the kind's busiest hour's traffic
        for (let g = 0; g < G; g++) {
          const o = otherModes(m.dist[e], ty, hours[ph]?.traffic ?? 0, zj.parking, groups[g].wx);
          const t = tg[g];
          t.walk = mult * o.walk;
          t.bike = mult * o.bike;
          t.car = mult * o.car;
          t.taxi = mult * o.taxi;
          t.transit = trAt(ph, groups[g].wx);
          sharesInto(qg[g], Infinity, t, carShare, lam);
          const x = (g * PK + pk) * 2 + mall;
          const daily = base * (gA[x] + park * gP[x] + beach * gB[x]);
          if (!(daily > 1e-6)) continue;
          for (const y of OTHER) {
            ij[y] += daily * qg[g][y];
            if (!kind.oneWay) ji[y] += daily * qg[g][y];
          }
        }
        if (!reach[i]) continue;
        const gj = reach[j] ? this.access[j] : NONE;
        const feedable = !kind.toHome && this.feeds.length > 0;
        if (!gj.length && !feedable) continue;
        // then, hour by hour, the people who live or go near your stops reconsider
        const hs = zs.homeShare[i * K + k];
        for (let h = 0; h < 24; h++) {
          const cost = costs[h];
          const th = base * day.share[pk * 24 + h] * tripFactor(wxH[h], k, park, beach, mall === 1);
          if (!cost || !(th > 1e-5)) continue;
          const twf = transitWaitFactor(h);
          // the same changes to the train as the simulation offers that hour (rates)
          const fd = feedable && twf > 0 ? feeders[h] : null;
          const feedsH = !!fd && fd.worth(i, j);
          if (!gj.length && !feedsH) continue;
          const g = groupOf[h];
          // the baseline's transit time is at the busiest hour; this hour's may differ
          const t = tg[g];
          othersInto(oth, lam, t.walk, t.bike, carShare > 0 ? t.car : Infinity, t.taxi, trAt(h, wxH[h]));
          for (let ai = 0; ai < this.access[i].length; ai++) {
            const a = this.access[i][ai];
            const sa = hs * a.sp + (1 - hs) * a.sa;
            if (!(sa > 0)) continue;
            const wa = (hs * a.sp * a.wp + (1 - hs) * a.sa * a.wa) / (hs * a.sp + (1 - hs) * a.sa);
            const f = feedsH ? fd!.best(a.s, j) : null;
            // the bus part (kept for this zone and hour), then the change and the train
            let fAvail = 0, feedTour = Infinity;
            if (f) {
              const key = ((h * 4 + ai) * F + f.id) * K + k;
              if (busAt[key] !== i + 1) {
                const c = cost(a.s, f.x, k, ty, wa, f.w, 0);
                busAt[key] = i + 1;
                busTour[key] = c ? c.tour : Infinity;
                busAvail[key] = c ? c.avail : 0;
              }
              if (Number.isFinite(busTour[key])) {
                fAvail = busAvail[key];
                feedTour = busTour[key] + (1 - fAvail) * strandedLeg + mult * ty.change + transitTour(transitPathLeg(this.transit!.toZone(f.st, j), ty, twf, wxH[h]), k, h, strandedLeg);
              }
            }
            if (!gj.length && !Number.isFinite(feedTour)) continue;
            const ef = ptWeight(oth, feedTour);
            for (const b of gj.length ? gj : NO_STOP) {
              const sb = !b ? 1 : kind.toHome ? b.sp : b.sa;
              if (!(sb > 0)) continue;
              const c = b ? cost(a.s, b.s, k, ty, wa, kind.toHome ? b.wp : b.wa, strandedLeg) : null;
              if (!c && !Number.isFinite(feedTour)) continue;
              if (c) {
                linkIJ = true;
                if (!kind.oneWay && c.avail > 0) linkJI = true;
              }
              sharesFrom(s, oth, c ? ptWeight(oth, c.tour) : 0, ef, carShare);
              const p = s[4] + s[6];
              // coming home: by bus, or by train then bus, as far as each runs then
              const home = (c ? s[4] * c.avail : 0) + s[6] * fAvail;
              const w = th * sa * sb;
              const n = w * (kind.optional ? (1 - STAY_HOME * (1 - p)) / (1 - STAY_HOME) : 1);
              for (const x of OTHER) {
                const v = n * s[x] - w * qg[g][x];
                ij[x] += v;
                // a stranded traveller comes home by taxi
                if (!kind.oneWay) ji[x] += x === 3 ? v + n * (p - home) : v;
              }
              ij[4] += n * p;
              if (!kind.oneWay) ji[4] += n * home;
            }
          }
        }
      }
    }
    flush();
    return { Z, trips, served };
  }

  /** The way home for a group that arrived: the itinerary legs a return would use (for tests). */
  static legsKey(legs: Leg[]): string {
    return legs.map((l) => l.r).join(',');
  }
}

/** Tour kind → when people come home, as minutes after arrival, for `n` people (systematic sample from `u`). */
export function returnMinutes(k: number, n: number, u: number): number[] {
  const stay = KINDS[k].stay;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const q = (i + u) / n;
    // invert the stay distribution by bisection (hours, at least 15 minutes)
    let lo = 0, hi = 24;
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      if (cdf(stay, mid) < q) lo = mid;
      else hi = mid;
    }
    out.push(Math.max(15, Math.round(((lo + hi) / 2) * 60)));
  }
  return out;
}
