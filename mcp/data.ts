// Read-only views of a saved game, for AI agents (served by the MCP server in server.ts).
// Every figure is computed from the save with the game's own helpers. Money is shown in the
// city's display currency, the same as in the game.
import type { GameState, Id, Route } from '../src/game/types.ts';
import { TripState } from '../src/game/types.ts';
import { DAY, MODEL } from '../src/game/content.ts';
import { OBJECTIVES, SAT_COMPONENTS, licencesBought, routeMoney, routeWindow, window } from '../src/game/progress.ts';
import { CATEGORY_LABEL, dayTotals, reconcile } from '../src/game/finance.ts';
import { currencyFor } from '../src/game/currency.ts';
import { STATUS_LABEL } from '../src/game/vehicles.ts';
import { WEEKDAYS_LONG, hhmm, secondOfDay, serviceDayOf, serviceDayWeekend, weekdayOf } from '../src/game/time.ts';
import { SERVICE_MIN, bandAt } from '../src/game/timetable.ts';
import { ZONE_Z, zoneTile } from '../src/game/world/zoneTiles.ts';
import { tileCenterLat } from '../src/geo/tiles.ts';

const pct = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100));
const r1 = (v: number) => Math.round(v * 10) / 10;

function moneyOf(s: GameState) {
  const c = currencyFor(s.region.country);
  return { code: c.code, m: (base: number) => Math.round(base * c.factor), fine: (base: number) => Math.round(base * c.factor * 100) / 100 };
}

const dayNo = (t: number) => Math.floor(t / DAY) + 1;

function gameTime(s: GameState) {
  const t = s.clock.t;
  return { day: dayNo(t), weekday: WEEKDAYS_LONG[weekdayOf(s.clock.startWeekday, t)], time: hhmm(t) };
}

const waitingAt = (s: GameState, stop: Id) => (s.pax.waiting[stop] ?? []).reduce((n, g) => n + g.n, 0);
const stopName = (s: GameState, id: Id) => s.stops[id]?.name ?? id;

/** The headway running now on a line (minutes), or null outside service hours. */
function headwayNow(s: GameState, r: Route): number | null {
  const t = s.clock.t;
  const sd = serviceDayOf(t);
  const plan = serviceDayWeekend(s.clock.startWeekday, sd) ? r.timetable.weekend : r.timetable.weekday;
  let minute = secondOfDay(t) / 60;
  if (minute < SERVICE_MIN) minute += 1440;
  return bandAt(plan, minute)?.headway ?? null;
}

/** Find a line by id ("r1"), number ("1") or name, ignoring case. */
export function findLine(s: GameState, key: string): Route | null {
  const k = key.trim().toLowerCase();
  const all = Object.values(s.routes);
  return all.find((r) => r.id.toLowerCase() === k) ?? all.find((r) => r.number.toLowerCase() === k) ?? all.find((r) => r.name.toLowerCase() === k) ?? all.find((r) => r.name.toLowerCase().includes(k)) ?? null;
}

function moneyDay(s: GameState, day: number) {
  const { m } = moneyOf(s);
  const d = dayTotals(s, day);
  return { fares: m(s.finance.daily[day]?.fares ?? 0), operatingIncome: m(d.income), operatingCosts: m(d.operating), operatingResult: m(d.result), investment: m(d.capital), cashChange: m(d.cash) };
}

export function overview(s: GameState, savedAt?: number) {
  const { code, m, fine } = moneyOf(s);
  const w = window(s, 24);
  const buses = Object.values(s.vehicles);
  const byStatus: Record<string, number> = {};
  for (const v of buses) byStatus[STATUS_LABEL[v.status]] = (byStatus[STATUS_LABEL[v.status]] ?? 0) + 1;
  const today = Math.floor(s.clock.t / DAY);
  const done = Object.values(s.objectives).filter((o) => o.done).length;
  return {
    note: 'A snapshot from the last save, not the live game.',
    company: s.company.name,
    city: [s.region.city, s.region.area].filter(Boolean).join(', '),
    country: s.region.country ?? null,
    currency: code,
    savedAt: savedAt ? new Date(savedAt).toISOString() : new Date(s.meta.saved).toISOString(),
    gameTime: gameTime(s),
    status: s.company.status,
    reputation: r1(s.company.reputation),
    fare: fine(s.company.fare),
    balance: m(s.finance.balance),
    loan: m(s.finance.loan),
    last24h: {
      journeysCompleted: w.trips,
      boardings: w.boardings,
      gaveUpWaiting: w.abandoned,
      satisfactionPct: pct(w.satisfaction),
      // 100 = passengers are fully happy with this part of the journey
      satisfactionBreakdownPct: Object.fromEntries(SAT_COMPONENTS.map((c, i) => [c, w.satisfaction == null ? null : pct(w.comp[i])])),
      averageWaitMin: w.satisfaction == null ? null : r1(w.avgWait),
      departures: w.deps,
      missedDepartures: w.missed,
      onTimePct: pct(w.ontime),
      averageLoadPct: pct(w.load),
    },
    network: { lines: Object.keys(s.routes).length, stops: Object.keys(s.stops).length, depots: Object.keys(s.depots).length, buses: buses.length, busesByStatus: byStatus },
    territory: { mapSquaresOwned: s.territory.owned.length, licencesBought: licencesBought(s) },
    moneyToday: moneyDay(s, today),
    moneyYesterday: today > 0 ? moneyDay(s, today - 1) : null,
    objectives: `${done} of ${OBJECTIVES.length} done`,
    unreadNotifications: s.notifications.filter((n) => !n.read).length,
  };
}

export function lines(s: GameState) {
  const { m } = moneyOf(s);
  return Object.values(s.routes).map((r) => {
    const w = routeWindow(s, r.id, 24);
    const today = routeMoney(s, r.id, 0);
    const twoDays = routeMoney(s, r.id, 1);
    return {
      id: r.id,
      number: r.number,
      name: r.name || `Line ${r.number}`,
      kind: r.kind === 'loop' ? 'loop' : 'two-way',
      suspended: r.suspended,
      stops: r.stops.length,
      from: stopName(s, r.stops[0]),
      to: stopName(s, r.kind === 'loop' ? r.stops[0] : r.stops[r.stops.length - 1]),
      buses: r.vehicles.length,
      headwayNowMin: headwayNow(s, r),
      last24h: { boardings: w.boardings, departures: w.deps, missed: w.missed, onTimePct: pct(w.ontime), averageLoadPct: pct(w.load), satisfactionPct: pct(w.satisfaction) },
      profitToday: m(today.profit),
      profitTodayAndYesterday: m(twoDays.profit),
      waitingNow: r.stops.reduce((n, id) => n + waitingAt(s, id), 0),
    };
  });
}

export function lineDetails(s: GameState, r: Route) {
  const { m } = moneyOf(s);
  const today = Math.floor(s.clock.t / DAY);
  const trips = s.trips[r.id] ?? [];
  const tripCount = (st: number) => trips.filter((t) => t.state === st).length;
  const history = [];
  for (let d = Math.max(0, today - 6); d <= today; d++) {
    const x = s.finance.routeDaily[d]?.[r.id];
    if (x) history.push({ day: d + 1, revenue: m(x.rev), costs: m(x.cost), profit: m(x.rev - x.cost) });
  }
  const bands = (p: Route['timetable']['weekday']) => p.bands.map((b) => ({ from: hhmmMin(b.from), to: hhmmMin(b.to), everyMin: b.headway }));
  return {
    ...lines(s).find((l) => l.id === r.id),
    outboundStops: r.stops.map((id) => ({ id, name: stopName(s, id), waiting: waitingAt(s, id) })),
    returnStops: r.kind === 'loop' ? null : (r.returnStops ?? [...r.stops].reverse()).map((id) => ({ id, name: stopName(s, id) })),
    timetable: { weekday: bands(r.timetable.weekday), weekend: bands(r.timetable.weekend), layoverMin: r.timetable.layover },
    vehicles: r.vehicles.map((id) => {
      const v = s.vehicles[id];
      return v ? { fleetNo: v.fleetNo, status: STATUS_LABEL[v.status], onBoard: v.load, capacity: MODEL[v.model]?.capacity ?? null, delayMin: r1(v.delay / 60) } : { id };
    }),
    tripsInPlan: { planned: tripCount(TripState.Planned) + tripCount(TripState.Assigned), running: tripCount(TripState.Running), done: tripCount(TripState.Done), missed: tripCount(TripState.Missed) },
    moneyByDay: history,
  };
}

function hhmmMin(min: number) {
  const x = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(Math.round(x % 60)).padStart(2, '0')}`;
}

export function buses(s: GameState) {
  const { m } = moneyOf(s);
  return Object.values(s.vehicles).map((v) => {
    const model = MODEL[v.model];
    return {
      fleetNo: v.fleetNo,
      model: model?.name ?? v.model,
      capacity: model?.capacity ?? null,
      status: STATUS_LABEL[v.status],
      line: v.route ? (s.routes[v.route]?.number ?? v.route) : null,
      depot: s.depots[v.depot]?.name ?? v.depot,
      conditionPct: pct(v.condition),
      km: Math.round(v.km),
      onBoard: v.load,
      delayMin: r1(v.delay / 60),
      ageDays: r1((s.clock.t - v.bought) / DAY),
      boughtFor: m(v.price),
      leavingService: v.withdraw || !!v.sell,
    };
  });
}

export function stops(s: GameState) {
  const servedBy = new Map<Id, string[]>();
  for (const r of Object.values(s.routes))
    for (const id of new Set([...r.stops, ...(r.returnStops ?? [])])) servedBy.set(id, [...(servedBy.get(id) ?? []), r.number]);
  return Object.values(s.stops)
    .map((st) => ({ id: st.id, name: st.name, lines: servedBy.get(st.id) ?? [], waiting: waitingAt(s, st.id), area: st.zone, lngLat: st.lngLat.map((v) => Math.round(v * 1e5) / 1e5) }))
    .sort((a, b) => b.waiting - a.waiting);
}

export function finances(s: GameState, days = 7) {
  const { code, m } = moneyOf(s);
  const today = Math.floor(s.clock.t / DAY);
  const byDay = [];
  for (let d = Math.max(0, today - days + 1); d <= today; d++) {
    const cats = s.finance.daily[d] ?? {};
    byDay.push({
      day: d + 1,
      ...moneyDay(s, d),
      byCategory: Object.fromEntries(Object.entries(cats).filter(([, v]) => v).map(([c, v]) => [CATEGORY_LABEL[c as keyof typeof CATEGORY_LABEL] ?? c, m(v as number)])),
    });
  }
  const rec = reconcile(s);
  return {
    currency: code,
    balance: m(s.finance.balance),
    loan: m(s.finance.loan),
    booksBalance: rec.ok,
    byDay,
    recentEntries: s.finance.ledger.slice(-25).reverse().map((e) => ({ day: dayNo(e.t), time: hhmm(e.t), amount: m(e.amt), category: CATEGORY_LABEL[e.cat] ?? e.cat, memo: e.memo })),
  };
}

export function history(s: GameState) {
  const { m } = moneyOf(s);
  return s.stats.days.map((d) => ({
    day: d.day + 1,
    journeysCompleted: d.trips,
    boardings: d.boardings,
    gaveUpWaiting: d.abandoned,
    satisfactionPct: pct(d.satisfaction),
    onTimePct: pct(d.ontime),
    revenue: m(d.revenue),
    costs: m(d.costs),
    reputation: r1(d.reputation),
    balance: m(d.balance),
  }));
}

export function objectives(s: GameState) {
  const { m } = moneyOf(s);
  return OBJECTIVES.map((o) => {
    const st = s.objectives[o.id];
    const reward = [o.reward.cash ? `${m(o.reward.cash).toLocaleString('en-GB')} ${moneyOf(s).code}` : null, o.reward.rep ? `+${o.reward.rep} reputation` : null, o.reward.label ?? null].filter(Boolean).join(', ');
    return { id: o.id, title: o.title, description: o.description, done: !!st?.done, completedOnDay: st?.day != null ? st.day + 1 : null, progressPct: pct(st?.progress ?? 0), reward };
  });
}

export function notifications(s: GameState, limit = 20, unreadOnly = false) {
  return s.notifications
    .filter((n) => !unreadOnly || !n.read)
    .slice(-limit)
    .reverse()
    .map((n) => ({ day: dayNo(n.t), time: hhmm(n.t), tone: n.tone, title: n.title, body: n.body ?? null, read: !!n.read }));
}

/** Operating areas are map squares (z14 tiles, about 2 km across). */
export function territory(s: GameState) {
  const stopsIn = new Map<string, string[]>();
  for (const st of Object.values(s.stops)) stopsIn.set(st.zone, [...(stopsIn.get(st.zone) ?? []), st.name]);
  const depotsIn = new Map<string, string[]>();
  for (const d of Object.values(s.depots)) depotsIn.set(d.zone, [...(depotsIn.get(d.zone) ?? []), d.name]);
  const start = new Set(s.territory.start ?? [s.territory.home]);
  return {
    home: s.territory.home,
    licencesBought: licencesBought(s),
    squares: s.territory.owned.map((id) => {
      const t = zoneTile(id);
      const centre = t ? [Math.round(((t[0] + 0.5) / 2 ** ZONE_Z * 360 - 180) * 1e5) / 1e5, Math.round(tileCenterLat(ZONE_Z, t[1]) * 1e5) / 1e5] : null;
      return { id, centreLngLat: centre, home: id === s.territory.home, startingArea: start.has(id), stops: stopsIn.get(id) ?? [], depots: depotsIn.get(id) ?? [] };
    }),
  };
}

/** Raw access for anything the other views leave out: a JSON pointer such as /routes/r1/timetable. */
export function query(s: GameState, pointer: string, maxChars = 20_000) {
  let v: unknown = s;
  const parts = pointer.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const p of parts) {
    if (p === '') continue;
    if (v == null || typeof v !== 'object') return { error: `Nothing at ${pointer}` };
    v = (v as Record<string, unknown>)[p];
  }
  if (v === undefined) return { error: `Nothing at ${pointer}` };
  if (v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length > maxChars) return { keys: Object.keys(v), note: 'Too large to show in full; ask for one of these keys.' };
  const text = JSON.stringify(v);
  return text.length > maxChars ? { truncated: true, json: text.slice(0, maxChars) } : { value: v };
}
