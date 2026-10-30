// Statistics, passenger satisfaction, reputation, territory licensing and objectives.

import type { Game } from './engine.ts';
import type { DayStats, GameState, HourStats, Id, Notification, PaxGroup, RouteHour } from './types.ts';
import { DAY, ECON, HOUR, MODELS } from './content.ts';
import { dayTotals, post } from './finance.ts';
import { distanceM, type LngLat } from './world/graph.ts';
import type { Zone } from './world/region.ts';
import { recJourney, recMissed, recTripDone } from './analytics/record.ts';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export const SAT_COMPONENTS = ['Waiting time', 'Journey time', 'Space on board', 'Reliability', 'Fares'] as const;

// ───────────────────────────────────────────── stats

function newHour(h: number): HourStats {
  return { h, boardings: 0, trips: 0, abandoned: 0, satSum: 0, satN: 0, comp: [0, 0, 0, 0, 0], waitSum: 0, deps: 0, ontime: 0, missed: 0, loadSum: 0, loadN: 0 };
}

export function hourStats(state: GameState): HourStats {
  const h = Math.floor(state.clock.t / HOUR);
  const hs = state.stats.hours;
  let last = hs[hs.length - 1];
  if (!last || last.h !== h) {
    last = newHour(h);
    hs.push(last);
    while (hs.length > 50) hs.shift();
  }
  return last;
}

export function routeHour(state: GameState, route: Id): RouteHour {
  const h = Math.floor(state.clock.t / HOUR);
  const list = (state.stats.routeHours[route] ??= []);
  let last = list[list.length - 1];
  if (!last || last.h !== h) {
    last = { h, boardings: 0, deps: 0, ontime: 0, missed: 0, loadSum: 0, loadN: 0, satSum: 0, satN: 0 };
    list.push(last);
    while (list.length > 50) list.shift();
  }
  return last;
}

/** Score a finished (or abandoned) journey and add it to the statistics. */
/** `stranded`: no bus home at their return time (scored like giving up, counted separately). */
export function recordTrip(game: Game, g: PaxGroup, completed: boolean, stranded = false) {
  const state = game.state;
  const t = state.clock.t;
  const sc = scoreJourney(state, g, completed, t);
  const hs = hourStats(state);
  if (completed) {
    hs.trips += g.n;
    state.stats.total.trips += g.n;
    game.counters.completed += g.n;
  } else {
    hs.abandoned += g.n;
    state.stats.total.abandoned += g.n;
    game.counters.lost += g.n;
  }
  hs.satSum += sc.overall * g.n;
  hs.satN += g.n;
  for (let i = 0; i < 5; i++) hs.comp[i] += sc.comp[i] * g.n;
  hs.waitSum += (g.w / 60) * g.n;
  recJourney(state, g, completed, sc, stranded);
  const route = g.fr ?? g.legs[0]?.r;
  if (route && state.routes[route]) {
    const rh = routeHour(state, route);
    rh.satSum += sc.overall * g.n;
    rh.satN += g.n;
  }
}

export function scoreJourney(state: GameState, g: PaxGroup, completed: boolean, t: number) {
  const waitMin = g.w / 60;
  const wait = clamp01(1 - (waitMin - 2) / 16);
  const o = state.stops[g.o], d = state.stops[g.d];
  const dist = o && d ? distanceM(o.lngLat, d.lngLat) : 2000;
  // compared with a door-to-door car or taxi trip of the same distance
  const ref = (dist / 1000 / 20) * 60 + 5;
  const T = (t - g.t0) / 60;
  const journey = clamp01(1.3 - 0.5 * (T / ref));
  const lf = g.r > 0 ? g.cr / g.r : 0;
  const crowd = clamp01(1 - (lf - 0.5) / 0.6);
  const boards = Math.max(1, g.leg + 1);
  const rel = clamp01(1 - (g.dl / 60 / boards - 1) / 7);
  const price = clamp01(1.25 - (0.45 * state.company.fare) / ECON.referenceFare);
  const transfers = g.legs.length - 1;
  if (!completed) return { overall: 0.04, comp: [0, 0, g.r > 0 ? crowd : 0.5, rel, price] as [number, number, number, number, number] };
  const overall = clamp01(0.3 * wait + 0.25 * journey + 0.15 * crowd + 0.15 * rel + 0.15 * price - 0.07 * transfers);
  return { overall, comp: [wait, journey, crowd, rel, price] as [number, number, number, number, number] };
}

export function recordDeparture(state: GameState, route: Id, delaySec: number) {
  const hs = hourStats(state);
  const rh = routeHour(state, route);
  const ok = delaySec >= -60 && delaySec <= 180;
  hs.deps++;
  rh.deps++;
  if (ok) {
    hs.ontime++;
    rh.ontime++;
  }
  recTripDone(state, route, ok);
}

export function recordMissed(state: GameState, route: Id) {
  hourStats(state).missed++;
  routeHour(state, route).missed++;
  recMissed(state, route);
}

export function recordLoad(state: GameState, route: Id, lf: number) {
  const hs = hourStats(state);
  const rh = routeHour(state, route);
  hs.loadSum += lf;
  hs.loadN++;
  rh.loadSum += lf;
  rh.loadN++;
}

export function recordBoardings(state: GameState, route: Id, n: number) {
  hourStats(state).boardings += n;
  routeHour(state, route).boardings += n;
}

export interface Window {
  trips: number;
  abandoned: number;
  boardings: number;
  satisfaction: number | null;
  comp: number[];
  avgWait: number;
  deps: number;
  ontime: number | null;
  missed: number;
  load: number | null;
}

/** Aggregate the last `hours` complete-or-current hours. */
export function window(state: GameState, hours = 24): Window {
  const h0 = Math.floor(state.clock.t / HOUR) - hours + 1;
  const w: Window = { trips: 0, abandoned: 0, boardings: 0, satisfaction: null, comp: [0, 0, 0, 0, 0], avgWait: 0, deps: 0, ontime: null, missed: 0, load: null };
  let satSum = 0, satN = 0, ontime = 0, loadSum = 0, loadN = 0, waitSum = 0;
  for (const h of state.stats.hours) {
    if (h.h < h0) continue;
    w.trips += h.trips;
    w.abandoned += h.abandoned;
    w.boardings += h.boardings;
    satSum += h.satSum;
    satN += h.satN;
    for (let i = 0; i < 5; i++) w.comp[i] += h.comp[i];
    waitSum += h.waitSum;
    w.deps += h.deps;
    ontime += h.ontime;
    w.missed += h.missed;
    loadSum += h.loadSum;
    loadN += h.loadN;
  }
  if (satN) {
    w.satisfaction = satSum / satN;
    w.comp = w.comp.map((c) => c / satN);
    w.avgWait = waitSum / satN;
  }
  if (w.deps + w.missed) w.ontime = ontime / (w.deps + w.missed);
  if (loadN) w.load = loadSum / loadN;
  return w;
}

export function routeWindow(state: GameState, route: Id, hours = 24, end = Math.floor(state.clock.t / HOUR) + 1) {
  const h0 = end - hours;
  let boardings = 0, deps = 0, ontime = 0, missed = 0, loadSum = 0, loadN = 0, satSum = 0, satN = 0;
  for (const h of state.stats.routeHours[route] ?? []) {
    if (h.h < h0 || h.h >= end) continue;
    boardings += h.boardings;
    deps += h.deps;
    ontime += h.ontime;
    missed += h.missed;
    loadSum += h.loadSum;
    loadN += h.loadN;
    satSum += h.satSum;
    satN += h.satN;
  }
  return {
    boardings,
    deps,
    missed,
    ontime: deps + missed ? ontime / (deps + missed) : null,
    load: loadN ? loadSum / loadN : null,
    satisfaction: satN ? satSum / satN : null,
  };
}

/** Revenue and cost of a route over the last n complete days (+ today so far). */
export function routeMoney(state: GameState, route: Id, days = 1) {
  const today = Math.floor(state.clock.t / DAY);
  let rev = 0, cost = 0;
  for (let d = today - days; d <= today; d++) {
    const r = state.finance.routeDaily[d]?.[route];
    if (r) {
      rev += r.rev;
      cost += r.cost;
    }
  }
  return { rev, cost, profit: rev - cost };
}

// ───────────────────────────────────────────── notifications

export function notify(game: Game, tone: Notification['tone'], title: string, body?: string, ref?: Notification['ref']) {
  const state = game.state;
  const n: Notification = { id: ++state.counters.notification, t: state.clock.t, tone, title };
  if (body) n.body = body;
  if (ref) n.ref = ref;
  state.notifications.push(n);
  while (state.notifications.length > 80) state.notifications.shift();
  game.emit('notify', n);
}

// ───────────────────────────────────────────── day end

/** Close the books for the day that just ended: stats row, reputation, solvency. */
export function closeDay(game: Game, day: number) {
  const state = game.state;
  const w = window(state, 24);
  const tot = dayTotals(state, day);
  const row: DayStats = {
    day,
    trips: w.trips,
    boardings: w.boardings,
    abandoned: w.abandoned,
    satisfaction: w.satisfaction ?? 0,
    ontime: w.ontime ?? 0,
    revenue: tot.income,
    costs: -tot.operating,
    reputation: state.company.reputation,
    balance: state.finance.balance,
  };
  state.stats.days.push(row);
  while (state.stats.days.length > 120) state.stats.days.shift();

  // reputation drifts towards what passengers experienced; more riders = faster
  const c = state.company;
  const before = c.reputation;
  if (w.trips + w.abandoned >= 30 && w.satisfaction !== null) {
    const target = w.satisfaction * 100;
    const k = Math.min(0.12, 0.03 + (w.trips + w.abandoned) / 40000);
    c.reputation += (target - c.reputation) * k;
  }
  c.reputation -= Math.min(4, w.missed * 0.04);
  c.reputation = Math.max(0, Math.min(100, c.reputation));
  row.reputation = c.reputation;
  const delta = c.reputation - before;
  if (Math.abs(delta) >= 1) {
    notify(game, delta > 0 ? 'good' : 'warn', `Reputation ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta).toFixed(1)} points`, delta > 0 ? 'Passengers are happy with your service.' : explainSatisfaction(w));
  }

  // solvency
  const bal = state.finance.balance;
  if (bal < 0) {
    c.redDays++;
    if (bal < ECON.overdraftLimit || c.redDays > ECON.graceDays) {
      if (c.status !== 'insolvent') {
        c.status = 'insolvent';
        notify(game, 'bad', 'Your company is insolvent', 'The bank has frozen your overdraft. Restructure the company or declare bankruptcy.');
        game.emit('insolvent', null);
      }
    } else {
      c.status = 'warning';
      notify(game, 'warn', `Overdrawn for ${c.redDays} day${c.redDays > 1 ? 's' : ''}`, `Return to a positive balance within ${ECON.graceDays - c.redDays + 1} days to avoid insolvency.`);
    }
  } else if (c.status !== 'bankrupt') {
    c.redDays = 0;
    c.status = 'ok';
  }
}

function explainSatisfaction(w: Window): string {
  const worst = w.comp.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)[0];
  const hints = [
    'Passengers are waiting too long. Run buses more often.',
    'Journeys take too long. Look for faster streets or fewer detours.',
    'Buses are overcrowded. Add buses or larger vehicles.',
    'Buses are running late. Allow more time or avoid congested streets.',
    'Passengers think fares are too high.',
  ];
  return hints[worst.i];
}

// ───────────────────────────────────────────── territory

/** a new company starts with its home area plus the areas around it: about this much land (km²) */
export const START_AREA_KM2 = 15;

/** an area's land in km² (water does not count) */
export const landOf = (z: Zone) => z.landKm2 ?? z.areaKm2;

/**
 * The areas a company starts with: the chosen home area, then a compact block of the land
 * areas around it (nearest to the block's middle, busiest first), until about START_AREA_KM2.
 */
export function startingZones(zones: readonly Zone[], homeId: string): string[] {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const home = byId.get(homeId);
  if (!home) return [homeId];
  const out = [home];
  let area = landOf(home);
  while (area < START_AREA_KM2 - 1) {
    const mid: LngLat = [out.reduce((a, z) => a + z.seed[0], 0) / out.length, out.reduce((a, z) => a + z.seed[1], 0) / out.length];
    let best: Zone | null = null, bd = Infinity, ba = -1;
    for (const o of out)
      for (const n of o.neighbours) {
        const z = byId.get(n);
        if (!z || z.water || out.includes(z)) continue;
        const d = Math.round(distanceM(z.seed, mid) / 100);
        const a = z.residents + z.jobs;
        if (d < bd || (d === bd && a > ba)) {
          bd = d;
          ba = a;
          best = z;
        }
      }
    if (!best || area + landOf(best) > START_AREA_KM2 + 4) break;
    out.push(best);
    area += landOf(best);
  }
  return out.map((z) => z.id);
}

/** licences bought since founding (the starting areas are free) */
export function licencesBought(state: GameState): number {
  return Math.max(0, state.territory.owned.length - (state.territory.start?.length ?? 1));
}

export interface LicenceInfo {
  zone: Zone;
  owned: boolean;
  adjacent: boolean;
  cost: number;
  repRequired: number;
  canBuy: boolean;
  blockers: string[];
}

export function licenceInfo(game: Game, zoneId: string): LicenceInfo | null {
  const zone = game.geo.zone(zoneId);
  if (!zone) return null;
  const state = game.state;
  const owned = state.territory.owned.includes(zoneId);
  const bought = licencesBought(state);
  const adjacent = state.territory.owned.some((id) => zone.neighbours.includes(id));
  const cost = Math.round(((18_000 + 0.25 * (zone.residents + zone.jobs)) * (1 + 0.12 * bought)) / 1000) * 1000;
  const repRequired = Math.min(88, 34 + 6 * bought);
  const blockers: string[] = [];
  if (!owned) {
    if (zone.water) blockers.push('Open water: there is nothing to license here.');
    else if (!adjacent) blockers.push('Must border an area you already operate in.');
    if (state.company.reputation < repRequired) blockers.push(`Needs reputation ${repRequired} (you have ${Math.floor(state.company.reputation)}).`);
    if (state.finance.balance < cost) blockers.push('Not enough funds.');
    if (state.company.status === 'insolvent' || state.company.status === 'bankrupt') blockers.push('Not available while insolvent.');
  }
  return { zone, owned, adjacent, cost, repRequired, canBuy: !owned && blockers.length === 0, blockers };
}

// ───────────────────────────────────────────── objectives

export interface ObjectiveDef {
  id: string;
  title: string;
  description: string;
  reward: { cash?: number; rep?: number; label?: string };
  /** progress 0..1 */
  check: (game: Game) => number;
}

const hasRouteWith = (game: Game) => Object.values(game.state.routes).filter((r) => !r.suspended && r.vehicles.length > 0);

export const OBJECTIVES: ObjectiveDef[] = [
  {
    id: 'first-line',
    title: 'Open your first line',
    description: 'Create a line with at least three stops and give it a bus.',
    reward: { rep: 2 },
    check: (g) => (hasRouteWith(g).some((r) => r.stops.length >= 3) ? 1 : 0),
  },
  {
    id: 'pax-100',
    title: 'First hundred passengers',
    description: 'Carry 100 passengers to their destinations.',
    reward: { cash: 10_000, label: 'Start-up grant' },
    check: (g) => g.state.stats.total.trips / 100,
  },
  {
    id: 'pax-day-1000',
    title: 'A busy day',
    description: 'Carry 1,000 passengers in a single day.',
    reward: { cash: 25_000, rep: 3, label: 'City mobility award' },
    check: (g) => Math.max(window(g.state, 24).trips, ...g.state.stats.days.map((d) => d.trips)) / 1000,
  },
  {
    id: 'sat-75',
    title: 'Happy passengers',
    description: 'Reach 75% satisfaction over a day with at least 300 journeys.',
    reward: { rep: 5 },
    check: (g) => {
      const best = g.state.stats.days.filter((d) => d.trips >= 300).reduce((m, d) => Math.max(m, d.satisfaction), 0);
      return best / 0.75;
    },
  },
  {
    id: 'profitable-3',
    title: 'Three profitable lines',
    description: 'Have three lines that each made a profit yesterday.',
    reward: { cash: 40_000, label: 'Investor bonus' },
    check: (g) => {
      const y = Math.floor(g.state.clock.t / DAY) - 1;
      const day = g.state.finance.routeDaily[y] ?? {};
      return Object.entries(day).filter(([id, v]) => g.state.routes[id] && v.rev > v.cost).length / 3;
    },
  },
  {
    id: 'serve-university',
    title: 'Campus connection',
    description: 'Serve a university or college (stop within 350 m) on a line carrying 300 riders a day.',
    reward: { cash: 15_000, rep: 2, label: 'Student travel contract' },
    check: (g) => servesKind(g, ['university'], 350, 300),
  },
  {
    id: 'serve-hospital',
    title: 'Health access',
    description: 'Serve a hospital (stop within 300 m) on a line carrying 300 riders a day.',
    reward: { cash: 15_000, rep: 2, label: 'Health board contract' },
    check: (g) => servesKind(g, ['hospital'], 300, 300),
  },
  {
    id: 'peak-reliable',
    title: 'Rush-hour reliability',
    description: 'Keep 85% of departures on time over a day with at least 60 departures.',
    reward: { rep: 4 },
    check: (g) => {
      const w = window(g.state, 24);
      return w.deps >= 60 && w.ontime !== null ? w.ontime / 0.85 : (w.deps / 60) * 0.5;
    },
  },
  {
    id: 'expand-1',
    title: 'Room to grow',
    description: 'License a new operating area next to yours.',
    reward: { rep: 2 },
    check: (g) => licencesBought(g.state),
  },
  {
    id: 'zones-3',
    title: 'Across the city',
    description: 'Run lines that serve stops in three different areas.',
    reward: { cash: 30_000, label: 'Municipal network grant' },
    check: (g) => {
      const zones = new Set<string>();
      for (const r of hasRouteWith(g)) for (const id of r.stops) if (g.state.stops[id]) zones.add(g.state.stops[id].zone);
      return zones.size / 3;
    },
  },
  {
    id: 'fleet-10',
    title: 'A proper fleet',
    description: 'Own ten buses.',
    reward: { rep: 2 },
    check: (g) => Object.keys(g.state.vehicles).length / 10,
  },
  {
    id: 'daily-5000',
    title: 'Mass transit',
    description: 'Carry 5,000 passengers in one day. Unlocks the Artic 18.',
    reward: { cash: 80_000, rep: 4, label: 'Transport authority award' },
    check: (g) => Math.max(window(g.state, 24).trips, ...g.state.stats.days.map((d) => d.trips)) / 5000,
  },
];

/** Progress towards serving a kind of destination on a line with real ridership (0..1). */
function servesKind(game: Game, kinds: string[], within: number, riders: number): number {
  let best = 0;
  for (const r of hasRouteWith(game)) {
    const near = r.stops.some((id) => {
      const s = game.state.stops[id];
      return s && game.geo.poisNear(s.lngLat, within).some((q) => kinds.includes(q.p.kind));
    });
    if (!near) continue;
    best = Math.max(best, 0.2 + 0.8 * Math.min(1, routeWindow(game.state, r.id, 24).boardings / riders));
  }
  return best;
}

/** Re-evaluate objectives; grant rewards exactly once. */
export function checkObjectives(game: Game) {
  const state = game.state;
  for (const def of OBJECTIVES) {
    const st = (state.objectives[def.id] ??= { done: false, progress: 0 });
    if (st.done) continue;
    const p = Math.max(0, Math.min(1, def.check(game)));
    st.progress = p;
    if (p >= 1) {
      st.done = true;
      st.day = Math.floor(state.clock.t / DAY);
      if (def.reward.cash) post(state, { amt: def.reward.cash, cat: 'grant', memo: `${def.reward.label ?? 'Award'}: ${def.title}`, ref: def.id });
      if (def.reward.rep) {
        state.company.reputation = Math.min(100, state.company.reputation + def.reward.rep);
        game.demand.slot = -1; // re-rate demand with the new reputation
      }
      const parts = [def.reward.cash ? game.money(def.reward.cash) : '', def.reward.rep ? `+${def.reward.rep} reputation` : ''].filter(Boolean).join(' · ');
      notify(game, 'good', `Objective complete: ${def.title}`, parts || undefined);
      game.emit('objective', def.id);
    }
  }
}

export function unlockedModels(state: GameState): Set<string> {
  const out = new Set<string>();
  for (const m of MODELS) {
    if (state.company.reputation >= m.unlockRep || (m.unlockObjective && state.objectives[m.unlockObjective]?.done)) out.add(m.id);
  }
  return out;
}
