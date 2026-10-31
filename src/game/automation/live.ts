// Live game data as plain records for automation nodes (and expressions). Every field is read
// from the simulation at the moment the node runs. Percentages are 0–100, times in minutes.

import type { Game } from '../engine.ts';
import type { Id, Vehicle } from '../types.ts';
import type { Value } from './types.ts';
import { DAY, HOUR, MODEL } from '../content.ts';
import { hhmm, serviceDayOf, weekdayOf } from '../time.ts';
import { routeWindow } from '../progress.ts';
import { STATUS_LABEL, extraOption } from '../vehicles.ts';
import { companyLevel } from '../control.ts';
import { dayTotals } from '../finance.ts';
import { weekdayName } from '../analytics/query.ts';
import { busesAvailable, busesNeededNow, gaveUpLastHour, satisfactionToday } from './watch.ts';
import { linePeakFields } from './peaks.ts';

export type Rec = { [k: string]: Value };

const r1 = (x: number) => Math.round(x * 10) / 10;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** Passengers waiting for each line right now (by the line of their next leg). */
function waitingByLine(game: Game): Map<Id, number> {
  const out = new Map<Id, number>();
  for (const list of Object.values(game.state.pax.waiting)) for (const g of list) {
    const r = g.legs[g.leg]?.r;
    if (r) out.set(r, (out.get(r) ?? 0) + g.n);
  }
  return out;
}

/** Live data cache for one automation run (the game does not change while a run reads it). */
export class LiveData {
  private wait: Map<Id, number> | null = null;
  readonly game: Game;
  constructor(game: Game) {
    this.game = game;
  }

  waitingFor(route: Id) {
    return (this.wait ??= waitingByLine(this.game)).get(route) ?? 0;
  }

  line(id: Id): Rec | null {
    const game = this.game, s = game.state;
    const r = s.routes[id];
    if (!r) return null;
    const buses = r.vehicles.map((v) => s.vehicles[v]).filter(Boolean);
    const running = buses.filter((v) => (v.status === 'in_service' || v.status === 'at_stop') && v.pos.kind === 'pattern' && v.pos.route === id);
    const occ = running.length ? sum(running.map((v) => (v.sp ?? v.load) / MODEL[v.model].capacity)) / running.length : 0;
    const delay = running.length ? sum(running.map((v) => Math.max(0, v.delay))) / running.length / 60 : 0;
    const w = routeWindow(s, id, 3);
    const req = game.requirement(id);
    const today = s.analytics.today.routes[id];
    const plan = game.dayPlan(id, serviceDayOf(game.t));
    return {
      kind: 'line', id, number: r.number, name: r.name || `Line ${r.number}`, colour: r.colour,
      buses: buses.length, needed: req?.peak ?? 0, running: running.length,
      capacity: buses.length ? Math.round(buses.reduce((a, v) => a + (MODEL[v.model]?.capacity ?? 0), 0) / buses.length) : null,
      occupancy: r1(occ * 100), waiting: this.waitingFor(id), delay: r1(delay),
      headway: game.headwayAt(id, 0, game.t), suspended: r.suspended,
      onTime3h: w.ontime === null ? null : r1(w.ontime * 100), load3h: w.load === null ? null : r1(w.load * 100),
      boardingsToday: today ? sum(today.b) : 0, tripsToday: today ? sum(today.d) : 0, missedToday: today ? sum(today.m) : 0,
      plan: plan.planId ? plan.name : null, plans: (r.timetable.plans ?? []).filter((p) => p.enabled).map((p) => p.name),
      holidayPlan: (r.timetable.plans ?? []).some((p) => p.enabled && p.when.kind === 'school_holidays'),
      congestion: this.congestion(id),
      neededNow: busesNeededNow(game, id), working: busesAvailable(game, id),
      short: r.suspended ? 0 : Math.max(0, busesNeededNow(game, id) - busesAvailable(game, id)),
      ...linePeakFields(game, id),
    };
  }

  /** Average simulated congestion along the line now, 0–100. */
  private congestion(id: Id): number | null {
    const pats = this.game.patterns.get(id);
    const p = pats?.find((x) => x.valid);
    if (!p) return null;
    const tr = this.game.traffic;
    let s = 0, n = 0;
    for (let i = 0; i < p.path.dedges.length; i += 3) {
      s += tr.congestion(p.path.dedges[i], this.game.t);
      n++;
    }
    return n ? r1((s / n) * 100) : null;
  }

  stop(id: Id): Rec | null {
    const s = this.game.state;
    const st = s.stops[id];
    if (!st) return null;
    let waiting = 0, oldest = 0;
    for (const g of s.pax.waiting[id] ?? []) {
      waiting += g.n;
      oldest = Math.max(oldest, (s.clock.t - g.tl) / 60);
    }
    const today = s.analytics.today.stops[id];
    const lines = Object.values(s.routes).filter((r) => r.stops.includes(id) || r.returnStops?.includes(id)).map((r) => r.number);
    return {
      kind: 'stop', id, name: st.name, area: this.game.geo.zone(st.zone)?.name ?? null, areaId: st.zone, waiting, longestWait: r1(oldest), lines,
      boardingsToday: today ? sum(today.b) : 0, gaveUpToday: today ? sum(today.g) : 0,
      avgWaitToday: today && today.wn ? r1(today.ws / today.wn) : null,
      gaveUpHour: gaveUpLastHour(this.game, id), leftBehindToday: today ? today.lb : 0,
    };
  }

  bus(v: Vehicle): Rec {
    const s = this.game.state;
    const m = MODEL[v.model];
    const r = v.route ? s.routes[v.route] : null;
    const free = extraOption(this.game, v, s.depots[v.depot]?.node ?? 0, this.game.t) !== null;
    return {
      kind: 'vehicle', id: v.id, fleetNo: v.fleetNo, model: m.name, capacity: m.capacity,
      line: v.route, lineNumber: r?.number ?? null, status: v.status, statusLabel: STATUS_LABEL[v.status],
      load: v.load, occupancy: r1(((v.sp ?? v.load) / m.capacity) * 100), condition: Math.round(v.condition * 100),
      delay: r1(Math.max(0, v.delay) / 60), depot: v.depot, depotName: s.depots[v.depot]?.name ?? null,
      spare: v.route === null, free, carrying: v.load > 0,
    };
  }

  busById(id: Id): Rec | null {
    const v = this.game.state.vehicles[id];
    return v ? this.bus(v) : null;
  }

  company(): Rec {
    const s = this.game.state;
    const day = Math.floor(this.game.t / DAY);
    const tot = dayTotals(s, day);
    const lv = companyLevel(s.company.reputation);
    return {
      kind: 'company', balance: Math.round(s.finance.balance), reputation: r1(s.company.reputation), level: lv.level,
      fare: s.company.fare, resultToday: Math.round(tot.result), buses: Object.keys(s.vehicles).length, lines: Object.keys(s.routes).length,
      satisfactionToday: satisfactionToday(this.game), spareBuses: Object.values(s.vehicles).filter((v) => v.route === null && !v.sell).length,
    };
  }

  time(): Rec {
    const t = this.game.t;
    const wd = weekdayOf(this.game.state.clock.startWeekday, t);
    return { kind: 'time', t, time: hhmm(t), hour: Math.floor((t % DAY) / HOUR), minute: Math.floor((t % HOUR) / 60), weekday: weekdayName(wd), weekend: wd >= 5, day: Math.floor(t / DAY) + 1 };
  }
}
