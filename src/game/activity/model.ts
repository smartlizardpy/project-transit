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
import { CHOICE, KIND, KINDS, KIND_COUNT, STAY_HOME, TRAVELLERS, crowding, type Curve, type TravellerType } from './params.ts';
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
}

export interface ChoiceContext {
  S: number;
  itin: Map<number, Itinerary>;
  dist: Float32Array;
  fare: number;
  /** reputation cap on your network's share (kept until phase 7) */
  smax: number;
  traffic: number;
  quality: Map<Id, { load: number; ontime: number }>;
  /** this hour's weather (none: a mild dry hour) */
  wx?: WeatherEffect;
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

/** Multinomial logit share of the first option among all (generalised minutes, lower is better). */
function logitFirst(lam: number, first: number, ...rest: number[]): number {
  let m = first;
  for (const r of rest) if (r < m) m = r;
  if (!Number.isFinite(m)) return 0;
  const e0 = Number.isFinite(first) ? Math.exp(-(first - m) / lam) : 0;
  let s = e0;
  for (const r of rest) if (Number.isFinite(r)) s += Math.exp(-(r - m) / lam);
  return s > 0 ? e0 / s : 0;
}

/** Whole-tour generalised minutes of the modes other than your network. */
interface TourModes { walk: number; bike: number; car: number; taxi: number; transit: number }

/** Writes the shares of walk, bike, car, taxi, your network and existing transit into `out` (with and without a car). */
function sharesInto(out: Float64Array, net: number, o: TourModes, carShare: number, lam: number) {
  out.fill(0);
  addShares(out, net, o.walk, o.bike, o.car, o.taxi, o.transit, carShare, lam);
  addShares(out, net, o.walk, o.bike, Infinity, o.taxi, o.transit, 1 - carShare, lam);
}

function addShares(out: Float64Array, net: number, walk: number, bike: number, car: number, taxi: number, transit: number, wt: number, lam: number) {
  if (!(wt > 0)) return;
  const m = Math.min(walk, bike, car, taxi, net, transit);
  if (!Number.isFinite(m)) return;
  const e = (x: number) => (Number.isFinite(x) ? Math.exp(-(x - m) / lam) : 0);
  const ew = e(walk), eb = e(bike), ec = e(car), et = e(taxi), en = e(net), ex = e(transit);
  const sum = ew + eb + ec + et + en + ex;
  out[0] += (wt * ew) / sum;
  out[1] += (wt * eb) / sum;
  out[2] += (wt * ec) / sum;
  out[3] += (wt * et) / sum;
  out[4] += (wt * en) / sum;
  out[5] += (wt * ex) / sum;
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
    const skims = new Map<number, Skim | null>();
    const skim = (a: number, b: number): Skim | null => {
      const key = a * S + b;
      let sk = skims.get(key);
      if (sk !== undefined) return sk;
      sk = null;
      let best = Infinity;
      const as = [{ s: a, extra: 0 }, ...(this.near[a] ?? [])], bs = [{ s: b, extra: 0 }, ...(this.near[b] ?? [])];
      for (const x of as)
        for (const y of bs) {
          if (x.s === y.s || dist[x.s * S + y.s] < MIN_TRIP_M) continue;
          const it = itin.get(x.s * S + y.s);
          if (!it) continue;
          const c = it.gt + 1.5 * (x.extra + y.extra);
          if (c < best) {
            best = c;
            sk = { pair: x.s * S + y.s, it, extra: x.extra + y.extra, ivt: 0, rel: 0, routes: [], rkey: '' };
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
      }
      skims.set(key, sk);
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
    const wayHome = (sk: Skim, k: number, ret?: number[], rkey = '') => {
      const key = `${sk.rkey}|${k}|${rkey}`;
      let v = home.get(key);
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
        home.set(key, v);
      }
      return v;
    };
    const fareMin = (ctx.fare - ECON.referenceFare) / 0.15;
    // the weather: walking to the stop and waiting weigh more (the way home is taken to be the same)
    const wx = ctx.wx ?? NO_WEATHER;
    /** null: no itinerary between the two stops (or their neighbours) this hour */
    /** `ret`, `rkey`: when people come home, by hour from now (events), and a key for it */
    return (sa: number, sb: number, k: number, ty: TravellerType, wa: number, wb: number, strandedLeg: number, ret?: number[], rkey?: string) => {
      const sk = skim(sa, sb);
      if (!sk) return null;
      const it = sk.it;
      const base = ty.walk * wx.walk * (wa + wb + sk.extra) + sk.ivt + ty.change * it.transfers + ty.fare * fareMin + ty.rel * sk.rel + CHOICE.networkConst;
      const out = base + ty.wait * wx.wait * it.wait;
      if (KINDS[k].oneWay) return { pair: sk.pair, out, tour: out, avail: 1 };
      const h = wayHome(sk, k, ret, rkey);
      return { pair: sk.pair, out, tour: out + h.avail * (base + ty.wait * wx.wait * h.wait) + (1 - h.avail) * strandedLeg, avail: h.avail };
    };
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
    const out = new Map<number, { r: number; mix: Float64Array }>();
    for (const i of this.reach) {
      const gi = this.access[i];
      for (let e = m.start[i]; e < m.start[i + 1]; e++) {
        const j = m.d[e];
        const gj = this.access[j];
        if (!gj?.length) continue;
        const k = m.k[e];
        const kind = KINDS[k];
        // timing and volume follow the profile of the activity end (the airport for arrivals)
        const act = kind.toHome ? i : j;
        const pk = zs.profile[act] * K + k;
        let th = m.tours[e] * day.factor[pk] * day.share[pk * 24 + hour] * tripFactor(wx, k, zs.park[act], zs.beach[act], zs.profile[act] === PROFILE.mall);
        // delayed flights: arrivals held back, then bunched (flight disruptions)
        if (kind.toHome && flights.size) th *= flights.get(zs.list[i].place ?? '') ?? 1;
        if (!(th > 1e-4)) continue;
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
        for (const a of gi) {
          // origin side: homes for tours from home, activity for tours from work, hotels or stations
          const sa = hs * a.sp + (1 - hs) * a.sa;
          if (!(sa > 0)) continue;
          const wa = a.sp + a.sa > 0 ? (hs * a.sp * a.wp + (1 - hs) * a.sa * a.wa) / (hs * a.sp + (1 - hs) * a.sa) : 0;
          for (const b of gj) {
            const sb = kind.toHome ? b.sp : b.sa;
            if (!(sb > 0)) continue;
            const c = cost(a.s, b.s, k, ty, wa, kind.toHome ? b.wp : b.wa, strandedLeg);
            if (!c) continue;
            const withCar = logitFirst(lam, c.tour, mult * others.walk, mult * others.bike, mult * others.car, mult * others.taxi, tr);
            const noCar = logitFirst(lam, c.tour, mult * others.walk, mult * others.bike, mult * others.taxi, tr);
            const p = ctx.smax * (carShare * withCar + (1 - carShare) * noCar);
            if (!(p > 0)) continue;
            const made = kind.optional ? (1 - STAY_HOME * (1 - p)) / (1 - STAY_HOME) : 1;
            const r = (th * sa * sb * p * made) / 60;
            let o = out.get(c.pair);
            if (!o) out.set(c.pair, (o = { r: 0, mix: new Float64Array(K) }));
            o.r += r;
            o.mix[k] += r;
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
            const withCar = logitFirst(lam, c.tour, 2 * others.walk, 2 * others.bike, 2 * others.car, 2 * others.taxi, tr);
            const noCar = logitFirst(lam, c.tour, 2 * others.walk, 2 * others.bike, 2 * others.taxi, tr);
            const p = ctx.smax * (carShare * withCar + (1 - carShare) * noCar);
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
    const smax = hours[0]?.smax ?? 0;
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
    const qh = new Float64Array(MODES.length), s = new Float64Array(MODES.length);
    for (let i = 0; i < Z; i++) {
      for (let e = m.start[i]; e < m.start[i + 1]; e++) {
        const j = m.d[e];
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
            add(i, j, y, daily * qg[g][y]);
            if (!kind.oneWay) add(j, i, y, daily * qg[g][y]);
          }
        }
        if (!reach[i] || !reach[j]) continue;
        // then, hour by hour, the people who live or go near your stops reconsider
        const hs = zs.homeShare[i * K + k];
        for (let h = 0; h < 24; h++) {
          const cost = costs[h];
          const th = base * day.share[pk * 24 + h] * tripFactor(wxH[h], k, park, beach, mall === 1);
          if (!cost || !(th > 1e-5)) continue;
          const g = groupOf[h];
          // the baseline's transit time is at the busiest hour; this hour's may differ
          const tourH: TourModes = { ...tg[g], transit: trAt(h, wxH[h]) };
          sharesInto(qh, Infinity, tourH, carShare, lam);
          for (const a of this.access[i]) {
            const sa = hs * a.sp + (1 - hs) * a.sa;
            if (!(sa > 0)) continue;
            const wa = (hs * a.sp * a.wp + (1 - hs) * a.sa * a.wa) / (hs * a.sp + (1 - hs) * a.sa);
            for (const b of this.access[j]) {
              const sb = kind.toHome ? b.sp : b.sa;
              if (!(sb > 0)) continue;
              const c = cost(a.s, b.s, k, ty, wa, kind.toHome ? b.wp : b.wa, strandedLeg);
              if (!c) continue;
              served.add(i * Z + j);
              if (!kind.oneWay && c.avail > 0) served.add(j * Z + i);
              sharesInto(s, c.tour, tourH, carShare, lam);
              const p = smax * s[4];
              const w = th * sa * sb;
              const n = w * (kind.optional ? (1 - STAY_HOME * (1 - p)) / (1 - STAY_HOME) : 1);
              for (const x of OTHER) {
                // the network's capped-off share goes back to the other modes (as they would be this hour)
                const v = n * (s[x] + (1 - smax) * s[4] * qh[x]) - w * qg[g][x];
                add(i, j, x, v);
                // a stranded traveller comes home by taxi
                if (!kind.oneWay) add(j, i, x, x === 3 ? v + n * p * (1 - c.avail) : v);
              }
              add(i, j, 4, n * p);
              if (!kind.oneWay) add(j, i, 4, n * p * c.avail);
            }
          }
        }
      }
    }
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
