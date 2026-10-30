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
import { CHOICE, KINDS, KIND_COUNT, STAY_HOME, TRAVELLERS, crowding, type Curve, type TravellerType } from './params.ts';
import { dayTiming, type DayTiming } from './profiles.ts';
import { buildTransitSkim, transitLeg, transitWaitFactor, type TransitSkim } from './transit.ts';

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
}

export interface RateOut {
  pairs: Int32Array;
  rate: Float32Array;
  /** per pair, the share of each tour kind (pairs × KIND_COUNT) */
  mix: Float32Array;
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

/** Car time in minutes: the city formula used for timetables, with faster roads beyond 5 km. */
export function carMinutes(d: number, traffic: number): number {
  return 9 + Math.min(d, 5000) / 330 + Math.max(0, d - 5000) / 700 + traffic * (Math.min(d, 8000) / 450);
}

/** Generalised minutes of the modes other than your network for one journey leg. */
export function otherModes(d: number, ty: TravellerType, traffic: number, parking: number) {
  const walk = d <= CHOICE.walkMaxM ? ((d * CHOICE.detour) / CHOICE.walkSpeed) * ty.walkMode : Infinity;
  const bike = ty.bike > 0 && d <= CHOICE.bikeMaxM ? (d * CHOICE.detour) / CHOICE.bikeSpeed + CHOICE.bikeConst * ty.bike : Infinity;
  const carT = carMinutes(d, traffic);
  const car = ty.car > 0 ? carT + parking : Infinity;
  const taxi = carT - 4 + CHOICE.taxiWait + ((CHOICE.taxiBase + (CHOICE.taxiPerKm * d) / 1000) * ty.taxi) / CHOICE.valueOfTime;
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
  /** the city's existing transit between the zones of each tour-matrix entry */
  transit: TransitSkim | null = null;
  private day: { n: number; timing: DayTiming } | null = null;

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
      this.transit = buildTransitSkim(game.region.transit, this.zones, this.tours);
      this.access = [];
    }
    return this.zones;
  }

  /** Walks from each zone to the served stops (when stops, lines or territory change). */
  rebuildAccess(game: Game, xy: [number, number][]) {
    const zs = this.ensureZones(game);
    const g = game.region.demand;
    const R = CHOICE.accessM / CHOICE.detour;
    const grid = new Grid<number>(300);
    xy.forEach(([x, y], s) => grid.add(x, y, s));
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
    const wayHome = (sk: Skim, k: number) => {
      const key = `${sk.rkey}|${k}`;
      let v = home.get(key);
      if (!v) {
        let avail = 0, wait = 0;
        const share = RETURN_SHARE[k];
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
    /** null: no itinerary between the two stops (or their neighbours) this hour */
    return (sa: number, sb: number, k: number, ty: TravellerType, wa: number, wb: number, strandedLeg: number) => {
      const sk = skim(sa, sb);
      if (!sk) return null;
      const it = sk.it;
      const base = ty.walk * (wa + wb + sk.extra) + sk.ivt + ty.change * it.transfers + ty.fare * fareMin + ty.rel * sk.rel + CHOICE.networkConst;
      const out = base + ty.wait * it.wait;
      if (KINDS[k].oneWay) return { pair: sk.pair, out, tour: out, avail: 1 };
      const h = wayHome(sk, k);
      return { pair: sk.pair, out, tour: out + h.avail * (base + ty.wait * h.wait) + (1 - h.avail) * strandedLeg, avail: h.avail };
    };
  }

  /** Per-minute rates on your network for the hour starting at `t0`. */
  rates(game: Game, t0: number, ctx: ChoiceContext): RateOut {
    const zs = this.ensureZones(game);
    const m = this.tours!;
    const day = this.timing(game, t0);
    const hour = Math.floor(((t0 % 86400) + 86400) % 86400 / 3600);
    const wf = transitWaitFactor(hour);
    const K = KIND_COUNT;
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
        const pk = zs.profile[kind.toHome ? i : j] * K + k;
        const th = m.tours[e] * day.factor[pk] * day.share[pk * 24 + hour];
        if (!(th > 1e-4)) continue;
        const ty = TRAVELLERS[kind.type];
        const d = m.dist[e];
        const zi = zs.list[i], zj = zs.list[j];
        const others = otherModes(d, ty, ctx.traffic, zj.parking);
        const carShare = Math.min(1, (kind.toHome ? zj.car : zi.car) * ty.car);
        const hs = zs.homeShare[i * K + k];
        const lam = kind.oneWay ? CHOICE.scale : 2 * CHOICE.scale;
        const mult = kind.oneWay ? 1 : 2;
        const strandedLeg = others.taxi + CHOICE.stranded;
        const tr = transitTour(transitLeg(this.transit!, e, ty, wf), k, hour, strandedLeg);
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
   * Modelled trips for one whole day between activity zones, by mode (walk, bike, car, taxi, your
   * network): what everyone does, not only your passengers. `hours[h]` is the choice context for
   * the hour starting at `day0 + h` hours (an empty itinerary map when no line runs). Only pairs
   * with an end where `inScope` holds are counted. Other modes use the traffic of each tour kind's
   * busiest starting hour; your network is scored hour by hour, as the simulation does.
   */
  estimate(game: Game, day0: number, hours: ChoiceContext[], inScope: (z: number) => boolean): DayEstimate {
    const zs = this.ensureZones(game);
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
    const q = new Float64Array(MODES.length), qh = new Float64Array(MODES.length), s = new Float64Array(MODES.length);
    for (let i = 0; i < Z; i++) {
      for (let e = m.start[i]; e < m.start[i + 1]; e++) {
        const j = m.d[e];
        if (!inScope(i) && !inScope(j)) continue;
        const k = m.k[e];
        const kind = KINDS[k];
        const pk = zs.profile[kind.toHome ? i : j] * K + k;
        const daily = m.tours[e] * day.factor[pk];
        if (!(daily > 1e-4)) continue;
        const ty = TRAVELLERS[kind.type];
        const zi = zs.list[i], zj = zs.list[j];
        const ph = peak[pk];
        const o = otherModes(m.dist[e], ty, hours[ph]?.traffic ?? 0, zj.parking);
        const mult = kind.oneWay ? 1 : 2;
        const strandedLeg = o.taxi + CHOICE.stranded;
        const trLeg = transitLeg(this.transit!, e, ty, 1);
        const trAt = (h: number) => transitTour(trLeg + (transitWaitFactor(h) > 0 ? ty.wait * this.transit!.wait[e] * (transitWaitFactor(h) - 1) : Infinity), k, h, strandedLeg);
        const tourO: TourModes = { walk: mult * o.walk, bike: mult * o.bike, car: mult * o.car, taxi: mult * o.taxi, transit: trAt(ph) };
        const carShare = Math.min(1, (kind.toHome ? zj.car : zi.car) * ty.car);
        const lam = kind.oneWay ? CHOICE.scale : 2 * CHOICE.scale;
        sharesInto(q, Infinity, tourO, carShare, lam);
        // everyone, as if your network did not exist
        for (const x of OTHER) {
          add(i, j, x, daily * q[x]);
          if (!kind.oneWay) add(j, i, x, daily * q[x]);
        }
        if (!reach[i] || !reach[j]) continue;
        // then, hour by hour, the people who live or go near your stops reconsider
        const hs = zs.homeShare[i * K + k];
        for (let h = 0; h < 24; h++) {
          const cost = costs[h];
          const th = daily * day.share[pk * 24 + h];
          if (!cost || !(th > 1e-5)) continue;
          // the baseline's transit time is at the busiest hour; this hour's may differ
          const tourH: TourModes = { ...tourO, transit: trAt(h) };
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
                const v = n * (s[x] + (1 - smax) * s[4] * qh[x]) - w * q[x];
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
