// Passenger demand and journeys.
//
// Demand is an ESTIMATE built from OpenStreetMap land use (see regionBuilder): residents and
// activities around each served stop feed a gravity model by trip purpose. Every hour the game
// works out the best itinerary between every pair of served stops (direct or one transfer)
// from the actual timetable and simulated run times, and a mode-choice model turns service
// quality into ridership. Passengers then travel as aggregated groups with real origins,
// destinations and legs, so counts stay consistent from generation to arrival.

import type { Game } from './engine.ts';
import type { Pattern } from './network.ts';
import type { GameState, Id, Leg, PaxGroup, Vehicle } from './types.ts';
import { ECON, MODEL, STOP_RULES } from './content.ts';
import { accrueFare } from './finance.ts';
import { recordTrip } from './progress.ts';
import { recAlight, recBoard, recFare, recGaveUp, recLeftBehind } from './analytics/record.ts';
import { hourOfDay } from './time.ts';
import { ActivityModel, returnMinutes, returnShareByHour, type ChoiceContext, type DayEstimate } from './activity/model.ts';
import { KIND, KINDS, KIND_COUNT, TRAVELLERS } from './activity/params.ts';
import { eventReturnMinutes } from './events.ts';
import { hashString, unit } from './hash.ts';

export const PURPOSES = ['work', 'education', 'shopping', 'leisure', 'other'] as const;
/**
 * Outbound trips per resident per day, by purpose (return trips are modelled separately).
 * With returns this is about 2.7 trips per person per day by all modes, typical for a city.
 */
const RATE = [0.5, 0.19, 0.27, 0.25, 0.15];
/** distance decay length per purpose, metres */
const DECAY = [3600, 2600, 1800, 2600, 3000];
/** non-home-based trip makers per job, and visitors per unit of shopping/leisure attraction */
const NHB_PER_JOB = 0.3;
const VISITORS = 0.12;
/** minimum stop-to-stop distance for a bus trip (shorter journeys are walked) */
const MIN_TRIP_M = 380;

const gauss = (x: number, mu: number, s: number) => Math.exp(-((x - mu) ** 2) / (2 * s * s));

function norm(a: number[]) {
  const s = a.reduce((x, y) => x + y, 0) || 1;
  return a.map((v) => v / s);
}

function shape(f: (h: number) => number) {
  return norm(Array.from({ length: 24 }, (_, h) => f(h + 0.5)));
}

/** [purpose][hour] share of daily outbound and return trips. */
const PROFILE = {
  weekday: {
    out: [
      shape((h) => gauss(h, 7.9, 1.0) + 0.12 * gauss(h, 13, 3)),
      shape((h) => gauss(h, 7.7, 0.7) + 0.25 * gauss(h, 13, 1.5)),
      shape((h) => gauss(h, 11.5, 2.2) + 0.7 * gauss(h, 17.5, 1.8)),
      shape((h) => 0.4 * gauss(h, 12, 2.5) + gauss(h, 19.5, 2)),
      shape((h) => gauss(h, 10.5, 2.4) + 0.4 * gauss(h, 15, 2)),
    ],
    back: [
      shape((h) => gauss(h, 17.9, 1.3) + 0.12 * gauss(h, 14, 3)),
      shape((h) => gauss(h, 15.3, 1.2) + 0.4 * gauss(h, 13, 1.2)),
      shape((h) => gauss(h, 13.5, 2.2) + 0.8 * gauss(h, 19, 1.7)),
      shape((h) => 0.4 * gauss(h, 15, 2.5) + gauss(h, 22.3, 1.6)),
      shape((h) => gauss(h, 13, 2.4) + 0.4 * gauss(h, 17, 2)),
    ],
  },
  weekend: {
    out: [
      shape((h) => gauss(h, 9.5, 1.8)),
      shape((h) => gauss(h, 10, 2)),
      shape((h) => gauss(h, 12.5, 2.6)),
      shape((h) => gauss(h, 13, 3) + 0.8 * gauss(h, 20, 2)),
      shape((h) => gauss(h, 12, 3)),
    ],
    back: [
      shape((h) => gauss(h, 16.5, 2.2)),
      shape((h) => gauss(h, 15, 2)),
      shape((h) => gauss(h, 16.5, 2.6)),
      shape((h) => gauss(h, 18, 3) + gauss(h, 23, 1.6)),
      shape((h) => gauss(h, 16, 3)),
    ],
  },
};
/** weekend volume relative to weekdays, per purpose */
const WEEKEND_SCALE = [0.32, 0.05, 1.35, 1.4, 0.7];

/** One hour of a line forecast: expected boardings per line, and journeys (`total`, of which `home` are on the way back). */
export interface LineForecastHour {
  t: number;
  /** share of the hour still ahead (the current hour) */
  part: number;
  lines: Map<Id, number>;
  total: number;
  home: number;
}

export interface Itinerary {
  /** generalised time, minutes */
  gt: number;
  legs: Leg[];
  alt: Leg[];
  ivt: number;
  wait: number;
  transfers: number;
}

export interface PatternService {
  pattern: Pattern;
  /** stop index → served-stop index */
  sIdx: number[];
  /** cumulative scheduled minutes from the first stop (incl. dwell) */
  tmin: number[];
  headway: number;
  available: boolean;
}

/** The most of a journey's travellers your network can win at this reputation (kept until phase 7). */
const networkCap = (reputation: number) => 0.6 * (0.7 + 0.6 * (reputation / 100));

/** registry categories that count as transport hubs */
const STATION_CATEGORIES = new Set(['airport', 'rail_station', 'metro_station', 'ferry_pier', 'tram_stop', 'bus_station', 'cable_car']);

/**
 * Which demand model runs. 'activity' is the City Activity Engine (docs/city-activity-engine-plan.md);
 * 'legacy' is the earlier gravity model between stops, kept only so calibration can compare the two
 * while the engine is developed. The switch is removed before release.
 */
export type DemandEngine = 'activity' | 'legacy';
let ENGINE: DemandEngine = 'activity';
export function setDemandEngine(e: DemandEngine) {
  ENGINE = e;
}

export class DemandModel {
  readonly engine: DemandEngine = ENGINE;
  /** served stops in index order */
  stops: Id[] = [];
  index = new Map<Id, number>();
  prod = new Float64Array(0);
  attr: Float64Array[] = [];
  /** straight-line distance between served stops, metres */
  dist = new Float32Array(0);
  /** base daily outbound trips per pair per purpose, pair-major (earlier model) */
  base = new Float32Array(0);
  private legacyPairs: Int32Array = new Int32Array(0);
  /** pairs with demand this hour (o*S+d) */
  pairs: Int32Array = new Int32Array(0);
  /** itineraries for the current slot */
  itin = new Map<number, Itinerary>();
  /** per-minute generation rate per pair index in `pairs`, for the current slot */
  rate: Float32Array = new Float32Array(0);
  /** per pair, the share of each tour kind (activity engine; null for the earlier model) */
  kmix: Float32Array | null = null;
  /** potential trips per stop per day (both directions), for UI (earlier model) */
  stopPotential = new Map<Id, number>();
  /** stations and piers of the Place Registry within reach of each served stop */
  hubs = new Map<Id, { id: string; name: string; category: string; tier: number }[]>();
  /** the City Activity Engine: zones, tours and travel choice */
  readonly activity = new ActivityModel();
  slot = -1;
  services: PatternService[] = [];
  dirty = true;

  /** Recompute what depends on the served stops (when stops, lines or territory change). */
  rebuild(game: Game) {
    const { state } = game;
    const served = new Set<Id>();
    for (const r of Object.values(state.routes)) if (!r.suspended) for (const id of r.stops) served.add(id);
    for (const r of Object.values(state.routes)) if (!r.suspended && r.returnStops) for (const id of r.returnStops) served.add(id);
    this.stops = [...served].filter((id) => state.stops[id]).sort();
    this.index = new Map(this.stops.map((id, i) => [id, i]));
    const S = this.stops.length;
    const xy = this.stops.map((id) => game.geo.xy(state.stops[id].lngLat));
    this.dist = new Float32Array(S * S);
    for (let o = 0; o < S; o++) for (let d = 0; d < S; d++) if (o !== d) this.dist[o * S + d] = Math.hypot(xy[o][0] - xy[d][0], xy[o][1] - xy[d][1]);
    // stations and piers each stop serves (shown on stop cards; their travellers are modelled as gateways)
    this.hubs.clear();
    for (const id of this.stops) {
      const list = game.geo.places
        .near(state.stops[id].lngLat, 320, (p) => STATION_CATEGORIES.has(p.category) && p.scale.tier <= 4)
        .map((q) => ({ id: q.place.id, name: q.place.name, category: q.place.category, tier: q.place.scale.tier }));
      if (list.length) this.hubs.set(id, list);
    }
    if (this.engine === 'legacy') this.rebuildLegacy(game, xy);
    else this.activity.rebuildAccess(game, xy);
    this.dirty = false;
    this.slot = -1;
  }

  /** Recompute itineraries and generation rates for the hour containing t. */
  refresh(game: Game, t: number) {
    if (this.dirty || (this.engine === 'activity' && this.activity.stale(game))) this.rebuild(game);
    this.slot = Math.floor(t / 3600);
    this.services = game.patternServices(t, this.index);
    this.itin = computeItineraries(this.stops.length, this.services);
    if (this.engine === 'legacy') {
      this.kmix = null;
      this.refreshLegacy(game, t);
      return;
    }
    const out = this.activity.rates(game, t, {
      S: this.stops.length,
      itin: this.itin,
      dist: this.dist,
      fare: game.state.company.fare,
      smax: networkCap(game.state.company.reputation),
      traffic: game.traffic.profile(hourOfDay(t), game.isWeekend(t)) * (game.trafficIntensity ?? 1),
      quality: game.routeQuality(),
      wx: game.weatherEffectAt(t),
    });
    this.pairs = out.pairs;
    this.rate = out.rate;
    this.kmix = out.mix;
  }

  /**
   * Modelled trips today between activity zones by mode, for Network Control's estimated demand.
   * Each hour uses the lines running then. Reading it changes nothing the simulation uses.
   */
  estimateDay(game: Game, inScope: (z: number) => boolean): DayEstimate | null {
    if (this.engine !== 'activity') return null;
    if (this.dirty || this.activity.stale(game)) this.rebuild(game);
    const S = this.stops.length;
    const day0 = Math.floor(game.t / 86400) * 86400;
    const weekend = game.isWeekend(day0 + 12 * 3600);
    const quality = game.routeQuality();
    const hours: ChoiceContext[] = Array.from({ length: 24 }, (_, h) => ({
      S,
      itin: S ? computeItineraries(S, game.patternServices(day0 + h * 3600, this.index)) : new Map(),
      dist: this.dist,
      fare: game.state.company.fare,
      smax: networkCap(game.state.company.reputation),
      traffic: game.traffic.profile(h, weekend) * (game.trafficIntensity ?? 1),
      quality,
      wx: game.weatherEffectAt(day0 + h * 3600),
    }));
    return this.activity.estimate(game, day0, hours, inScope);
  }

  /**
   * Expected boardings per line for each whole hour from the one containing `t` up to `hours` hours
   * (not past midnight): the model's rates for the lines running then, today's weather (which the
   * player sees hour by hour) and announced events, plus people already out who are due home then
   * and the expected returns of trips that set off inside the window. The current hour counts only
   * what is left of it. An estimate for automation; reading it changes nothing the simulation uses.
   */
  forecastLines(game: Game, t: number, hours: number): LineForecastHour[] | null {
    if (this.engine !== 'activity') return null;
    if (this.dirty || this.activity.stale(game)) this.rebuild(game);
    const S = this.stops.length;
    const h0 = Math.floor(t / 3600) * 3600;
    const end = Math.min(h0 + hours * 3600, (Math.floor(t / 86400) + 1) * 86400);
    const quality = game.routeQuality();
    const out: LineForecastHour[] = [];
    const away = Object.entries(game.state.pax.away);
    const H = Math.max(0, Math.ceil((end - h0) / 3600));
    /** per hour, returns expected from trips that set off earlier in the window, by stop pair */
    const back: Map<number, number>[] = Array.from({ length: H }, () => new Map());
    const add = (lines: Map<Id, number>, legs: Leg[] | undefined, v: number) => {
      if (!legs?.length || !(v > 0)) return false;
      for (const leg of legs) lines.set(leg.r, (lines.get(leg.r) ?? 0) + v);
      return true;
    };
    for (let i = 0; i < H; i++) {
      const at = h0 + i * 3600;
      const part = i === 0 ? 1 - (t - h0) / 3600 : 1;
      const lines = new Map<Id, number>();
      let started = 0, home = 0;
      if (S) {
        const itin = computeItineraries(S, game.patternServices(at, this.index));
        // people out now who are due home this hour, from where they got off
        const m0 = Math.floor(Math.max(t, at) / 60), m1 = Math.floor((at + 3600) / 60);
        for (const [key, arr] of away) {
          let n = 0;
          for (let x = 0; x < arr.length && arr[x] < m1; x += 2) if (arr[x] >= m0) n += arr[x + 1];
          if (!n) continue;
          const [from, to] = key.split('>');
          const o = this.index.get(from), d = this.index.get(to);
          if (o !== undefined && d !== undefined && add(lines, itin.get(o * S + d)?.legs, n)) home += n;
        }
        const r = this.activity.forecastRates(game, at, {
          S, itin, dist: this.dist,
          fare: game.state.company.fare,
          smax: networkCap(game.state.company.reputation),
          traffic: game.traffic.profile(hourOfDay(at), game.isWeekend(at)) * (game.trafficIntensity ?? 1),
          quality,
          wx: game.weatherEffectAt(at),
          announcedBy: t,
        });
        for (let n = 0; n < r.pairs.length; n++) {
          const pair = r.pairs[n];
          const v = r.rate[n] * 60 * part;
          if (!add(lines, itin.get(pair)?.legs, v)) continue;
          started += v;
          // and their way home later in the window (the itinerary of that hour, the other way)
          const rev = (pair % S) * S + Math.floor(pair / S);
          for (let k = 0; k < KIND_COUNT; k++) {
            const mk = r.mix[n * KIND_COUNT + k];
            if (!(mk > 0) || KINDS[k].oneWay) continue;
            const share = returnShareByHour(k);
            for (let off = 0; i + off < H && off < share.length; off++) if (share[off] > 0) back[i + off].set(rev, (back[i + off].get(rev) ?? 0) + v * mk * share[off]);
          }
        }
        for (const [pair, v] of back[i]) if (add(lines, itin.get(pair)?.legs, v)) home += v;
      }
      out.push({ t: at, part, lines, total: started + home, home });
    }
    return out;
  }

  /** The earlier model: catchments and a gravity matrix between served stops (development switch only). */
  private rebuildLegacy(game: Game, xy: [number, number][]) {
    const { state, region } = game;
    const S = this.stops.length;
    const g = region.demand;
    const R = STOP_RULES.catchmentM;
    // catchment weights per cell, shared between stops that cover the same cell
    const cellStops = new Map<number, { s: number; w: number }[]>();
    xy.forEach(([x, y], s) => {
      const c0x = Math.floor((x - R - g.x0) / g.cell), c1x = Math.floor((x + R - g.x0) / g.cell);
      const c0y = Math.floor((y - R - g.y0) / g.cell), c1y = Math.floor((y + R - g.y0) / g.cell);
      for (let cy = Math.max(0, c0y); cy <= Math.min(g.h - 1, c1y); cy++)
        for (let cx = Math.max(0, c0x); cx <= Math.min(g.w - 1, c1x); cx++) {
          const d = Math.hypot(g.x0 + (cx + 0.5) * g.cell - x, g.y0 + (cy + 0.5) * g.cell - y);
          if (d > R) continue;
          const w = Math.pow(1 - d / R, 0.7) + 0.05;
          const k = cy * g.w + cx;
          const l = cellStops.get(k);
          if (l) l.push({ s, w });
          else cellStops.set(k, [{ s, w }]);
        }
    });
    this.prod = new Float64Array(S);
    this.attr = PURPOSES.map(() => new Float64Array(S));
    const attrCell = (p: number, k: number) => (p === 0 ? g.jobs[k] : p === 1 ? g.education[k] : p === 2 ? g.shopping[k] : p === 3 ? g.leisure[k] + g.residents[k] * 0.04 : g.other[k]);
    for (const [k, list] of cellStops) {
      const total = list.reduce((a, b) => a + b.w, 0);
      for (const { s, w } of list) {
        // share of the cell that walks to this stop; the uncovered remainder walks elsewhere
        const share = (w / total) * Math.min(1, total);
        // home-based trips from residents, plus trips made from workplaces (lunch, business,
        // errands) and by visitors to shops and attractions
        this.prod[s] += (g.residents[k] + g.jobs[k] * NHB_PER_JOB + (g.shopping[k] + g.leisure[k]) * VISITORS) * share;
        for (let p = 0; p < PURPOSES.length; p++) this.attr[p][s] += attrCell(p, k) * share;
      }
    }
    // transport hubs: people arriving by train, metro, tram or ferry continue by bus, and
    // people head for the hub to travel on. Both scale with the hub's size.
    this.stops.forEach((id, s) => {
      let w = 0;
      for (const q of game.geo.poisNear(state.stops[id].lngLat, 320)) {
        if (q.p.kind !== 'station' && q.p.kind !== 'ferry') continue;
        w += q.p.weight * (1 - q.d / 450);
      }
      if (w > 0) {
        this.prod[s] += w * 1.4;
        for (let p = 0; p < PURPOSES.length; p++) this.attr[p][s] += w * (p === 4 ? 0.9 : 0.25);
      }
    });
    // destination competition: all activity in the region, distance-weighted
    const den = PURPOSES.map(() => new Float64Array(S));
    for (let cy = 0; cy < g.h; cy++)
      for (let cx = 0; cx < g.w; cx++) {
        const k = cy * g.w + cx;
        const a = [attrCell(0, k), attrCell(1, k), attrCell(2, k), attrCell(3, k), attrCell(4, k)];
        if (!a[0] && !a[1] && !a[2] && !a[3] && !a[4]) continue;
        const px = g.x0 + (cx + 0.5) * g.cell, py = g.y0 + (cy + 0.5) * g.cell;
        for (let s = 0; s < S; s++) {
          const d = Math.hypot(px - xy[s][0], py - xy[s][1]);
          for (let p = 0; p < 5; p++) if (a[p]) den[p][s] += a[p] * Math.exp(-d / DECAY[p]);
        }
      }
    this.base = new Float32Array(S * S * 5);
    const pairs: number[] = [];
    this.stopPotential.clear();
    for (let o = 0; o < S; o++)
      for (let d = 0; d < S; d++) {
        if (o === d) continue;
        const dist = this.dist[o * S + d];
        if (dist < MIN_TRIP_M) continue;
        let any = false;
        for (let p = 0; p < 5; p++) {
          const v = den[p][o] > 0 ? (this.prod[o] * RATE[p] * this.attr[p][d] * Math.exp(-dist / DECAY[p])) / den[p][o] : 0;
          this.base[(o * S + d) * 5 + p] = v;
          if (v > 1e-4) any = true;
        }
        if (any) pairs.push(o * S + d);
      }
    // keep pairs where either direction has potential
    const set = new Set(pairs);
    for (const k of [...set]) {
      const o = Math.floor(k / S), d = k % S;
      set.add(d * S + o);
    }
    this.legacyPairs = Int32Array.from([...set].sort((a, b) => a - b));
    for (const k of this.legacyPairs) {
      const o = Math.floor(k / S), d = k % S;
      let v = 0;
      for (let p = 0; p < 5; p++) v += this.base[k * 5 + p] + this.base[(d * S + o) * 5 + p];
      this.stopPotential.set(this.stops[o], (this.stopPotential.get(this.stops[o]) ?? 0) + v);
    }
  }


  /** The earlier model's hourly rates (development switch only). */
  private refreshLegacy(game: Game, t: number) {
    const S = this.stops.length;
    const weekend = game.isWeekend(t);
    const hour = Math.floor(hourOfDay(t));
    const fare = game.state.company.fare;
    const smax = networkCap(game.state.company.reputation);
    // share of travellers with a car or taxi as their alternative; the rest would walk
    const pCar = Math.max(0.25, Math.min(0.6, 0.62 - 0.3 * (game.trafficIntensity ?? 1)));
    const traffic = game.traffic.profile(hourOfDay(t), weekend) * (game.trafficIntensity ?? 1);
    const prof = weekend ? PROFILE.weekend : PROFILE.weekday;
    const quality = game.routeQuality();
    this.pairs = this.legacyPairs;
    this.rate = new Float32Array(this.pairs.length);
    for (let i = 0; i < this.pairs.length; i++) {
      const k = this.pairs[i];
      const it = this.itin.get(k);
      if (!it) continue;
      const o = Math.floor(k / S), d = k % S;
      const rev = d * S + o;
      let daily = 0;
      for (let p = 0; p < 5; p++) {
        const sc = weekend ? WEEKEND_SCALE[p] : 1;
        daily += (this.base[k * 5 + p] * prof.out[p][hour] + this.base[rev * 5 + p] * prof.back[p][hour]) * sc;
      }
      if (daily <= 0) continue;
      const dist = this.dist[k];
      // generalised time of the bus journey (minutes) including fare, crowding and reliability
      let gt = it.gt + (fare - ECON.referenceFare) / 0.15 + 3.5; // + walking to and from stops
      for (const leg of it.legs) {
        const q = quality.get(leg.r);
        if (!q) continue;
        gt += Math.max(0, q.load - 0.75) * 30 + Math.max(0, 0.9 - q.ontime) * 18;
      }
      // the best alternative: walking, or other modes that also suffer from traffic
      const walk = (dist * 1.25) / 75;
      const car = 9 + dist / 330 + traffic * (dist / 450);
      const logit = (alt: number) => 1 / (1 + Math.exp((gt - alt) / 5.5));
      const share = smax * (pCar * logit(Math.min(walk, car)) + (1 - pCar) * logit(walk));
      this.rate[i] = (daily * share) / 60;
    }
  }

  potentialFor(stop: Id): number {
    return this.stopPotential.get(stop) ?? 0;
  }
}

/**
 * Best itinerary between every pair of served stops, allowing one transfer.
 * Generalised time = 1.8 × expected wait + in-vehicle time + 6 min per transfer.
 */
export function computeItineraries(S: number, services: PatternService[]): Map<number, Itinerary> {
  const best = new Map<number, Itinerary>();
  const expWait = (h: number) => (h <= 12 ? h / 2 : 4 + h / 8);
  // stop → services that call there (with positions)
  const at: { svc: number; pos: number }[][] = Array.from({ length: S }, () => []);
  services.forEach((sv, si) => {
    if (!sv.available) return;
    sv.sIdx.forEach((s, pos) => {
      if (s >= 0 && pos < sv.sIdx.length - 1) at[s].push({ svc: si, pos });
    });
  });
  const firstLeg = new Float64Array(S);
  const firstVia: ({ svc: number; pos: number; to: number } | null)[] = new Array(S);
  for (let o = 0; o < S; o++) {
    if (!at[o].length) continue;
    firstLeg.fill(Infinity);
    firstVia.fill(null);
    const direct: { d: number; gt: number; leg: Leg; ivt: number; wait: number }[] = [];
    for (const { svc, pos } of at[o]) {
      const sv = services[svc];
      const w = expWait(sv.headway);
      for (let j = pos + 1; j < sv.sIdx.length; j++) {
        const d = sv.sIdx[j];
        if (d < 0 || d === o) continue;
        const ivt = sv.tmin[j] - sv.tmin[pos];
        const gt = 1.8 * w + ivt;
        direct.push({ d, gt, ivt, wait: w, leg: { r: sv.pattern.route, p: sv.pattern.index, a: sv.pattern.stops[j] } });
        if (gt < firstLeg[d]) {
          firstLeg[d] = gt;
          firstVia[d] = { svc, pos, to: j };
        }
      }
    }
    // direct itineraries with common-line alternatives
    const byDest = new Map<number, typeof direct>();
    for (const x of direct) {
      const l = byDest.get(x.d);
      if (l) l.push(x);
      else byDest.set(x.d, [x]);
    }
    for (const [d, list] of byDest) {
      list.sort((a, b) => a.gt - b.gt);
      const b0 = list[0];
      const alt = list.slice(1).filter((x) => x.gt <= b0.gt + 4 && (x.leg.r !== b0.leg.r || x.leg.p !== b0.leg.p)).map((x) => x.leg);
      best.set(o * S + d, { gt: b0.gt, legs: [b0.leg], alt, ivt: b0.ivt, wait: b0.wait, transfers: 0 });
    }
    // one transfer
    for (let x = 0; x < S; x++) {
      const via = firstVia[x];
      if (!via) continue;
      const g1 = firstLeg[x];
      const sv1 = services[via.svc];
      for (const { svc, pos } of at[x]) {
        if (svc === via.svc) continue;
        const sv = services[svc];
        if (sv.pattern.route === sv1.pattern.route && sv.pattern.index === sv1.pattern.index) continue;
        const w = expWait(sv.headway);
        for (let j = pos + 1; j < sv.sIdx.length; j++) {
          const d = sv.sIdx[j];
          if (d < 0 || d === o || d === x) continue;
          const ivt2 = sv.tmin[j] - sv.tmin[pos];
          const gt = g1 + 6 + 1.8 * w + ivt2;
          const cur = best.get(o * S + d);
          if (cur && cur.gt <= gt) continue;
          const ivt1 = sv1.tmin[via.to] - sv1.tmin[via.pos];
          best.set(o * S + d, {
            gt,
            legs: [
              { r: sv1.pattern.route, p: sv1.pattern.index, a: sv1.pattern.stops[via.to] },
              { r: sv.pattern.route, p: sv.pattern.index, a: sv.pattern.stops[j] },
            ],
            alt: [],
            ivt: ivt1 + ivt2,
            wait: expWait(sv1.headway) + w,
            transfers: 1,
          });
        }
      }
    }
  }
  return best;
}

// ───────────────────────────────────────────── generation & waiting

const BUCKET = 6 * 60;

/** Groups merge only with travellers of the same type, tour kind and direction. */
const sameKind = (x: PaxGroup, g: PaxGroup) => x.k === g.k && x.pu === g.pu && !x.ret === !g.ret;

function addWaiting(state: GameState, stop: Id, g: PaxGroup) {
  const list = (state.pax.waiting[stop] ??= []);
  const key = legKey(g);
  for (const x of list) {
    if (x.d === g.d && legKey(x) === key && x.leg === g.leg && Math.abs(x.tl - g.tl) < BUCKET && x.fr === g.fr && sameKind(x, g)) {
      mergeInto(x, g);
      return;
    }
  }
  list.push(g);
}

const legKey = (g: PaxGroup) => g.legs.map((l) => `${l.r}/${l.p}/${l.a}`).join('|');

function mergeInto(x: PaxGroup, g: PaxGroup) {
  const n = x.n + g.n;
  const avg = (a: number, b: number) => (a * x.n + b * g.n) / n;
  x.t0 = avg(x.t0, g.t0);
  x.tl = avg(x.tl, g.tl);
  x.w = avg(x.w, g.w);
  x.r = avg(x.r, g.r);
  x.cr = avg(x.cr, g.cr);
  x.dl = avg(x.dl, g.dl);
  x.n = n;
}

function split(g: PaxGroup, n: number): PaxGroup {
  const part: PaxGroup = { ...g, legs: g.legs, n };
  g.n -= n;
  return part;
}

/** Generate this minute's new passengers at every served stop, and bring travellers home. */
export function generatePassengers(game: Game) {
  releaseReturns(game);
  const dm = game.demand;
  const state = game.state;
  const S = dm.stops.length;
  const t = state.clock.t;
  const acc = state.pax.acc;
  const mix = dm.kmix;
  for (let i = 0; i < dm.pairs.length; i++) {
    const r = dm.rate[i];
    if (!r) continue;
    const k = dm.pairs[i];
    const o = dm.stops[Math.floor(k / S)], d = dm.stops[k % S];
    const key = `${o}>${d}`;
    let a = (acc[key] ?? 0) + r;
    if (a >= 1) {
      const n = Math.floor(a);
      a -= n;
      const it = dm.itin.get(k);
      if (it) {
        const base = { o, d, legs: it.legs, leg: 0, alt: it.alt.length ? it.alt : undefined, t0: t, tl: t, w: 0, r: 0, cr: 0, dl: 0, fr: null };
        if (!mix) addWaiting(state, o, { n, ...base });
        else {
          // split the people by tour kind: a systematic sample from a stateless hash, so the
          // shares match the model on average and a reloaded game makes the same split
          const u = unit(hashString(key), t);
          let given = 0, cum = 0;
          for (let q = 0; q < KIND_COUNT && given < n; q++) {
            cum += mix[i * KIND_COUNT + q];
            const upto = q === KIND_COUNT - 1 ? n : Math.min(n, Math.floor(n * cum + u));
            const c = upto - given;
            given = upto;
            if (c > 0) addWaiting(state, o, { n: c, ...base, k: KINDS[q].type, pu: q });
          }
        }
        game.counters.generated += n;
      }
    }
    acc[key] = a;
  }
}

// ───────────────────────────────────────────── the away pool: linked returns (plan 7.3)

/**
 * A group finished the outbound journey of a round trip: it is away (at work, school, the shops…)
 * and will want to travel home from where it got off, at times drawn from its tour kind's length
 * of stay. Saved as `pax.away["from>to>kind"] = [minute, people, minute, people, …]`.
 */
function goAway(game: Game, g: PaxGroup) {
  if (g.pu === undefined || g.ret) return;
  const kind = KINDS[g.pu];
  if (!kind || kind.oneWay) return;
  const t = game.state.clock.t;
  const now = Math.floor(t / 60);
  const u = unit(hashString(`${g.o}>${g.d}`), t, g.pu);
  // event attendees head home when the event ends (or when they have had enough of a festival)
  const ev = g.pu === KIND.event ? game.eventFor(g.d, t) : null;
  const mins = ev ? eventReturnMinutes(ev, t, g.n, u) : returnMinutes(g.pu, g.n, u);
  const key = `${g.d}>${g.o}>${g.pu}`;
  const arr = (game.state.pax.away[key] ??= []);
  game.counters.away += mins.length;
  for (const m of mins) {
    const at = now + m;
    let i = 0;
    while (i < arr.length && arr[i] < at) i += 2;
    if (i < arr.length && arr[i] === at) arr[i + 1]++;
    else arr.splice(i, 0, at, 1);
  }
}

/** Travellers whose time to go home has come appear at the stop they got off at, heading back. */
function releaseReturns(game: Game) {
  const state = game.state;
  const away = state.pax.away;
  const t = state.clock.t;
  const now = Math.floor(t / 60);
  const dm = game.demand;
  const S = dm.stops.length;
  for (const key of Object.keys(away)) {
    const arr = away[key];
    let n = 0, i = 0;
    while (i < arr.length && arr[i] <= now) {
      n += arr[i + 1];
      i += 2;
    }
    if (!n) continue;
    arr.splice(0, i);
    if (!arr.length) delete away[key];
    const [from, to, pk] = key.split('>');
    const pu = Number(pk);
    const g: PaxGroup = { n, o: from, d: to, legs: [], leg: 0, t0: t, tl: t, w: 0, r: 0, cr: 0, dl: 0, fr: null, k: KINDS[pu]?.type, pu, ret: 1 };
    game.counters.generated += n;
    game.counters.returned += n;
    const o = dm.index.get(from), d = dm.index.get(to);
    const it = o !== undefined && d !== undefined && state.stops[from] ? dm.itin.get(o * S + d) : undefined;
    if (it) {
      g.legs = it.legs;
      g.alt = it.alt.length ? it.alt : undefined;
      addWaiting(state, from, g);
    } else {
      // no bus home at this hour (or the stop or line has gone): stranded
      recordTrip(game, g, false, true);
    }
  }
}

/** People away from home, waiting for their return time (for checks and the interface). */
export function awayTotal(state: GameState): number {
  let n = 0;
  for (const arr of Object.values(state.pax.away)) for (let i = 1; i < arr.length; i += 2) n += arr[i];
  return n;
}

/** A journey ended at its destination: record it, and start the time away for a round trip. */
function arrive(game: Game, g: PaxGroup) {
  recordTrip(game, g, true);
  goAway(game, g);
}

/** Patience before a waiting passenger gives up, seconds. */
function patience(game: Game, g: PaxGroup): number {
  const leg = g.legs[g.leg];
  const h = game.headwayAt(leg.r, leg.p, game.state.clock.t) ?? 30;
  return Math.max(20, Math.min(70, 1.3 * h + 8)) * 60 * (g.k !== undefined ? TRAVELLERS[g.k]?.patience ?? 1 : 1);
}

/** Remove passengers who have waited too long, and replan those whose line changed. */
export function abandonAndReplan(game: Game) {
  const state = game.state;
  const t = state.clock.t;
  for (const [stop, list] of Object.entries(state.pax.waiting)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (!legStillValid(game, g, stop)) {
        list.splice(i, 1);
        replan(game, g, stop);
        continue;
      }
      if (t - g.tl > patience(game, g)) {
        list.splice(i, 1);
        g.w += t - g.tl;
        recGaveUp(state, stop, g.legs[g.leg]?.r, g.n);
        recordTrip(game, g, false);
      }
    }
    if (!list.length) delete state.pax.waiting[stop];
  }
}

function legStillValid(game: Game, g: PaxGroup, stop: Id): boolean {
  const leg = g.legs[g.leg];
  const p = game.pattern(leg.r, leg.p);
  if (!p || !p.valid || game.state.routes[leg.r]?.suspended) return false;
  const i = p.stops.indexOf(stop);
  return i >= 0 && p.stops.indexOf(leg.a, i + 1) > i;
}

/** Find a new itinerary from `stop` to the group's destination, or end the journey. */
function replan(game: Game, g: PaxGroup, stop: Id) {
  const dm = game.demand;
  const o = dm.index.get(stop), d = dm.index.get(g.d);
  if (stop === g.d) return arrive(game, g);
  if (o !== undefined && d !== undefined) {
    const S = dm.stops.length;
    if (dm.dist[o * S + d] < MIN_TRIP_M) return arrive(game, g); // walks the rest
    const it = dm.itin.get(o * S + d);
    if (it) {
      g.legs = it.legs;
      g.leg = 0;
      g.alt = g.fr ? undefined : it.alt.length ? it.alt : undefined;
      g.tl = game.state.clock.t;
      addWaiting(game.state, stop, g);
      return;
    }
  }
  recordTrip(game, g, false);
}

// ───────────────────────────────────────────── at a stop

export interface StopEvent {
  alight: number;
  board: number;
  /** extra boarding seconds for luggage and bags (traveller types) */
  extra?: number;
  /** passengers who wanted this bus but did not fit */
  leftBehind: number;
}

/** Space a group takes on board, per person (a commuter is 1; air travellers with luggage 1.6). */
export function spaceOf(g: PaxGroup): number {
  return g.k === undefined ? 1 : (TRAVELLERS[g.k]?.space ?? 1);
}

/** Space taken on a bus, in commuter places. */
export function occupied(v: Vehicle): number {
  return v.sp ?? v.load;
}

/** Would anyone get off or on at this stop? (Buses skip stops nobody needs.) */
export function stopNeeded(game: Game, v: Vehicle, p: Pattern, idx: number): boolean {
  const stop = p.stops[idx];
  if (idx === 0 || idx === p.stops.length - 1) return true;
  for (const g of game.state.pax.onboard[v.id] ?? []) if (g.legs[g.leg].a === stop) return true;
  if (occupied(v) >= MODEL[v.model].capacity - 0.5) return false;
  for (const g of game.state.pax.waiting[stop] ?? []) if (wantsThisBus(g, p, idx)) return true;
  return false;
}

function wantsThisBus(g: PaxGroup, p: Pattern, idx: number): Leg | null {
  const options = g.leg === 0 && g.alt ? [g.legs[0], ...g.alt] : [g.legs[g.leg]];
  for (const l of options) {
    if (l.r !== p.route || l.p !== p.index) continue;
    if (p.stops.indexOf(l.a, idx + 1) > idx) return l;
  }
  return null;
}

/** Alight, transfer and board at stop `idx` of pattern `p`. */
export function serveStop(game: Game, v: Vehicle, p: Pattern, idx: number): StopEvent {
  const state = game.state;
  const t = state.clock.t;
  const stop = p.stops[idx];
  const cap = MODEL[v.model].capacity;
  const last = idx === p.stops.length - 1;
  const ev: StopEvent = { alight: 0, board: 0, leftBehind: 0 };
  const onboard = (state.pax.onboard[v.id] ??= []);
  const lfNow = occupied(v) / cap;
  // 1. alight
  for (let i = onboard.length - 1; i >= 0; i--) {
    const g = onboard[i];
    const leg = g.legs[g.leg];
    if (leg.a !== stop && !last) continue;
    onboard.splice(i, 1);
    ev.alight += g.n;
    g.r += t - g.tl;
    g.cr += (((g.lb ?? lfNow) + lfNow) / 2) * (t - g.tl);
    if (leg.a !== stop) {
      // end of the line but not their stop (line changed under them): find another way
      replan(game, g, stop);
    } else if (g.leg + 1 < g.legs.length) {
      g.leg++;
      g.tl = t;
      addWaiting(state, stop, g);
    } else {
      arrive(game, g);
    }
  }
  if (ev.alight) recAlight(state, stop, ev.alight);
  v.load = onboard.reduce((s, g) => s + g.n, 0);
  v.sp = onboard.reduce((s, g) => s + g.n * spaceOf(g), 0);
  // 2. board (not at the end of a trip)
  if (!last) {
    const waiting = state.pax.waiting[stop] ?? [];
    const cands = waiting.filter((g) => wantsThisBus(g, p, idx)).sort((a, b) => a.tl - b.tl);
    // room in commuter places: a traveller with luggage takes more than one
    let room = cap - v.sp;
    const headway = game.headwayAt(p.route, p.index, t) ?? 10;
    const lbk: number[] = [];
    for (const g of cands) {
      const space = spaceOf(g);
      const fits = Math.floor(room / space + 1e-9);
      if (fits <= 0) {
        ev.leftBehind += g.n;
        if (g.k !== undefined) lbk[g.k] = (lbk[g.k] ?? 0) + g.n;
        continue;
      }
      const take = Math.min(g.n, fits);
      const part = take === g.n ? g : split(g, take);
      if (part === g) waiting.splice(waiting.indexOf(g), 1);
      const chosen = wantsThisBus(part, p, idx)!;
      if (part.leg === 0) {
        part.legs = [chosen, ...part.legs.slice(1)];
        part.alt = undefined;
      }
      // with long headways people time their arrival to the timetable, but still arrive early
      let waited = t - part.tl;
      if (headway > 12) waited = Math.min(waited, 240 + 12 * headway + Math.max(0, v.delay));
      part.w += Math.max(0, waited);
      part.dl += Math.abs(v.delay);
      recBoard(state, stop, p.route, v, take, waited, part.leg > 0, part.k, p);
      if (!part.fr) {
        part.fr = p.route;
        const amt = state.company.fare * part.n;
        accrueFare(state, p.route, amt, part.n);
        recFare(state, stop, p.route, v, amt);
      }
      part.tl = t;
      part.lb = (v.sp + take * space) / cap;
      // merge with an identical group already on board
      const same = onboard.find((x) => x.d === part.d && x.leg === part.leg && legKey(x) === legKey(part) && x.fr === part.fr && sameKind(x, part));
      if (same) mergeInto(same, part);
      else onboard.push(part);
      room -= take * space;
      v.load += take;
      v.sp += take * space;
      ev.board += take;
      if (part.k !== undefined) ev.extra = (ev.extra ?? 0) + take * (TRAVELLERS[part.k]?.board ?? 0);
    }
    if (!waiting.length) delete state.pax.waiting[stop];
    if (ev.leftBehind) recLeftBehind(state, stop, p.route, ev.leftBehind, lbk);
  }
  game.counters.boardings += ev.board;
  return ev;
}

/** Everyone off (breakdown, withdrawal): passengers wait at this stop for another bus. */
export function offloadAll(game: Game, v: Vehicle, stop: Id | null) {
  const onboard = game.state.pax.onboard[v.id] ?? [];
  const t = game.state.clock.t;
  for (const g of onboard) {
    g.r += t - g.tl;
    if (stop) replan(game, g, stop);
    else recordTrip(game, g, false);
  }
  delete game.state.pax.onboard[v.id];
  v.load = 0;
  v.sp = 0;
}

export function waitingAt(state: GameState, stop: Id): number {
  let n = 0;
  for (const g of state.pax.waiting[stop] ?? []) n += g.n;
  return n;
}

/** Total passengers waiting, on board, and for checks. */
export function paxTotals(state: GameState) {
  let waiting = 0, onboard = 0;
  for (const l of Object.values(state.pax.waiting)) for (const g of l) waiting += g.n;
  for (const l of Object.values(state.pax.onboard)) for (const g of l) onboard += g.n;
  return { waiting, onboard };
}
