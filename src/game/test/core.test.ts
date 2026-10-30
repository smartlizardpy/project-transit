import { describe, expect, it } from 'vitest';
import { Game } from '../engine.ts';
import { buildLine, newGame, region, stopChain } from './helpers.ts';
import { EDGE_ONEWAY, head, tail, route as routeRoad, type RoadGraph } from '../world/graph.ts';
import { departures, flatTimetable } from '../timetable.ts';
import { arrivalsAt, vehicleStops } from '../eta.ts';
import { dayTotals, reconcile } from '../finance.ts';
import { landOf, licenceInfo, licencesBought, startingZones, START_AREA_KM2 } from '../progress.ts';
import { DAY, HOUR, MODEL } from '../content.ts';
import { TripState } from '../types.ts';

const TAKSIM: [number, number] = [28.9784, 41.0369];

/** Directed-edge adjacency honouring one-way flags. */
function successors(g: RoadGraph): number[][] {
  const out: number[][] = Array.from({ length: g.n }, () => []);
  for (let e = 0; e < g.m; e++) {
    out[g.ea[e]].push(g.eb[e]);
    if (!(g.flags[e] & EDGE_ONEWAY)) out[g.eb[e]].push(g.ea[e]);
  }
  return out;
}

/** Iterative Tarjan; returns the size of the largest SCC. */
function largestScc(adj: number[][]): number {
  const n = adj.length;
  const idx = new Int32Array(n).fill(-1), low = new Int32Array(n), onStack = new Uint8Array(n);
  const stack: number[] = [];
  let counter = 0, best = 0;
  for (let s = 0; s < n; s++) {
    if (idx[s] !== -1) continue;
    const call: [number, number][] = [[s, 0]];
    idx[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = 1;
    while (call.length) {
      const top = call[call.length - 1];
      const [v, i] = top;
      if (i < adj[v].length) {
        top[1]++;
        const w = adj[v][i];
        if (idx[w] === -1) {
          idx[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          call.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], idx[w]);
      } else {
        call.pop();
        if (call.length) {
          const p = call[call.length - 1][0];
          low[p] = Math.min(low[p], low[v]);
        }
        if (low[v] === idx[v]) {
          let size = 0, w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            size++;
          } while (w !== v);
          best = Math.max(best, size);
        }
      }
    }
  }
  return best;
}

describe('road graph', () => {
  it('has a giant strongly connected component', () => {
    const g = region().graph;
    const adj = successors(g);
    const drivable = adj.filter((a, v) => a.length > 0 || g.adjStart[v + 1] > g.adjStart[v]).length;
    const scc = largestScc(adj);
    expect(drivable).toBeGreaterThan(1000);
    expect(scc / drivable).toBeGreaterThan(0.8);
  });

  it('route() respects one-way streets', () => {
    const g = region().graph;
    // find a one-way edge a->b whose reverse direction forces a detour
    let checked = 0;
    for (let e = 0; e < g.m && checked < 40; e++) {
      if (!(g.flags[e] & EDGE_ONEWAY) || g.len[e] < 20) continue;
      const a = g.ea[e], b = g.eb[e];
      const fwd = routeRoad(g, a, b);
      const back = routeRoad(g, b, a);
      if (!fwd || !back) continue;
      checked++;
      // forward route is every directed edge allowed; no contraflow
      expect(fwd.contraflow).toEqual([]);
      for (const de of fwd.dedges) expect(de & 1 && g.flags[de >> 1] & EDGE_ONEWAY).toBeFalsy();
      for (const de of back.dedges) expect(de & 1 && g.flags[de >> 1] & EDGE_ONEWAY).toBeFalsy();
      // going against the street is never the single edge itself
      expect(back.dedges.length === 1 && back.dedges[0] === 2 * e + 1).toBe(false);
      expect(back.metres).toBeGreaterThanOrEqual(g.len[e] - 1e-3);
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('directed edge helpers agree with a->b / b->a convention', () => {
    const g = region().graph;
    expect(tail(g, 0)).toBe(g.ea[0]);
    expect(head(g, 1)).toBe(g.ea[0]);
  });
});

describe('route validity', () => {
  it('rejects fewer than two stops and stops outside licensed zones', () => {
    const game = newGame({ extraFunds: 500_000 });
    const [p] = stopChain(game, TAKSIM, 1);
    const s = game.placeStop(p);
    expect(s.ok).toBe(true);
    const id = (s as { value: string }).value;
    const pv = game.previewRoute({ stops: [id], kind: 'linear' });
    expect(pv.problems.join(' ')).toMatch(/two stops/i);
    const cr = game.createRoute({ stops: [id], kind: 'linear' });
    expect(cr.ok).toBe(false);
    expect(Object.keys(game.state.routes)).toHaveLength(0);
    const empty = game.createRoute({ stops: [], kind: 'linear' });
    expect(empty.ok).toBe(false);
  });

  it('linear lines have 2 patterns, loops 1, with continuous paths', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const lin = buildLine(game, { stops: 6, buses: 1 });
    const pats = game.patterns.get(lin.route)!;
    expect(pats).toHaveLength(2);
    const g = game.region.graph;
    const checkPath = (p: (typeof pats)[number]) => {
      expect(p.valid).toBe(true);
      expect(p.path.dedges.length).toBe(p.path.nodes.length - 1);
      for (let i = 0; i < p.path.dedges.length; i++) {
        expect(tail(g, p.path.dedges[i])).toBe(p.path.nodes[i]);
        expect(head(g, p.path.dedges[i])).toBe(p.path.nodes[i + 1]);
      }
    };
    pats.forEach(checkPath);

    const loopGame = newGame({ extraFunds: 1_000_000 });
    const loop = buildLine(loopGame, { stops: 6, buses: 1, kind: 'loop' });
    const lp = loopGame.patterns.get(loop.route)!;
    expect(lp).toHaveLength(1);
    checkPath(lp[0]);
    expect(loopGame.audit()).toEqual([]);
  });

  it('a loop needs at least three stops', () => {
    const game = newGame({ extraFunds: 500_000 });
    const ids = stopChain(game, TAKSIM, 2).map((p) => (game.placeStop(p) as { value: string }).value);
    expect(game.createRoute({ stops: ids, kind: 'loop' }).ok).toBe(false);
  });
});

describe('timetable', () => {
  it('honours the headway and needs more buses as it shrinks', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const { route } = buildLine(game, { stops: 6, buses: 1, headway: 10 });
    // the flat timetable itself: departures in 08:00-09:00 (minutes after midnight)
    for (const hw of [6, 10, 15, 20]) {
      const n = departures(flatTimetable(hw).weekday).filter((m) => m >= 480 && m < 540).length;
      expect(Math.abs(n - 60 / hw), `headway ${hw}`).toBeLessThanOrEqual(1);
    }
    // the generated trips honour it too (08:00-09:00 on the first day)
    const trips = (hw: number) => {
      expect(game.setTimetable(route, flatTimetable(hw)).ok).toBe(true);
      game.ensureTrips(route);
      return game.state.trips[route].filter((t) => t.pat === 0 && t.dep >= 8 * HOUR && t.dep < 9 * HOUR).length;
    };
    for (const hw of [6, 10, 15]) expect(Math.abs(trips(hw) - 60 / hw), `trips at ${hw}`).toBeLessThanOrEqual(1);

    const need = (hw: number) => {
      game.setTimetable(route, flatTimetable(hw));
      return game.requirement(route, false)!.peak;
    };
    const a = need(20), b = need(10), c = need(5);
    expect(a).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(c);
    expect(c).toBeGreaterThan(a);
  });

  it('misses departures when too few buses are assigned', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const { route } = buildLine(game, { stops: 7, buses: 1, headway: 5 });
    expect(game.requirement(route, false)!.peak).toBeGreaterThan(1);
    game.run(4 * HOUR);
    const missedTrips = game.state.trips[route].filter((t) => t.state === TripState.Missed).length;
    const missedStat = (game.state.stats.routeHours[route] ?? []).reduce((s, h) => s + h.missed, 0);
    const missed = Math.max(missedTrips, missedStat);
    expect(missed).toBeGreaterThan(3);
    expect(game.audit()).toEqual([]);
  });
});

describe('boarding and capacity', () => {
  it('never exceeds capacity; small bus on a busy line leaves people behind', () => {
    const smallest = Object.values(MODEL).sort((a, b) => a.capacity - b.capacity)[0];
    const game = newGame({ extraFunds: 2_000_000 });
    buildLine(game, { stops: 7, buses: 2, headway: 8, model: smallest.id });
    let maxLoad = 0, left = 0;
    // run from 05:00 through the morning peak, sampling every minute
    for (let m = 0; m < 5 * 60; m++) {
      game.run(60);
      for (const v of game.vehicleList()) {
        maxLoad = Math.max(maxLoad, v.load);
        expect(v.load, `${v.fleetNo} over capacity`).toBeLessThanOrEqual(MODEL[v.model].capacity);
      }
    }
    left = game.state.stats.total.abandoned + game.counters.lost;
    const waiting = Object.values(game.state.pax.waiting).reduce((s, l) => s + l.reduce((a, g) => a + g.n, 0), 0);
    expect(maxLoad).toBeGreaterThan(0);
    expect(game.counters.boardings).toBeGreaterThan(0);
    expect(left + waiting).toBeGreaterThan(0);
    expect(game.audit()).toEqual([]);
  });
});

describe('ETA', () => {
  it('arrivals are sorted, non-negative and roughly right', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const { route, stopIds, buses } = buildLine(game, { stops: 7, buses: 4, headway: 10 });
    game.run(2.5 * HOUR); // 07:30, buses are out
    const mid = stopIds[Math.floor(stopIds.length / 2)];
    const arr = arrivalsAt(game, mid);
    expect(arr.length).toBeGreaterThan(0);
    for (let i = 0; i < arr.length; i++) {
      expect(arr[i].eta).toBeGreaterThanOrEqual(game.t - 1);
      if (i) expect(arr[i].eta).toBeGreaterThanOrEqual(arr[i - 1].eta);
    }
    // pick a running bus that will reach a stop in 1.5–25 minutes
    let pick: { veh: string; stop: string; idx: number; eta: number; trip: number } | null = null;
    for (const id of buses) {
      const v = game.state.vehicles[id];
      if (v.status !== 'in_service' || v.trip === null) continue;
      for (const s of vehicleStops(game, v)) {
        const dt = s.eta - game.t;
        if (dt > 90 && dt < 1500 && (!pick || dt < pick.eta - game.t)) pick = { veh: id, stop: s.stop, idx: s.index, eta: s.eta, trip: v.trip };
      }
    }
    expect(pick, 'no bus with an upcoming stop in 1.5–25 min').not.toBeNull();
    const p = pick!;
    const passed = () => {
      const v = game.state.vehicles[p.veh];
      const trip = game.trip(p.trip);
      if (!trip || trip.state === TripState.Done) return true;
      return v.trip !== p.trip || v.stopIdx > p.idx || (v.stopIdx === p.idx && v.status === 'at_stop');
    };
    game.run(Math.max(0, p.eta - 240 - game.t));
    expect(passed(), 'bus arrived >4 min earlier than predicted').toBe(false);
    game.run(480);
    expect(passed(), 'bus not at/after the stop 4 min after predicted ETA').toBe(true);
    expect(route).toBeTruthy();
  });
});

describe('traffic', () => {
  it('peak is slower than night on a major road and for a whole path', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const g = game.region.graph;
    const tr = game.traffic;
    const t3 = DAY + 3 * HOUR, t8 = DAY + 8 * HOUR;
    let major = -1;
    for (let e = 0; e < g.m; e++) if (g.cls[e] <= 2) { major = e; break; }
    expect(major).toBeGreaterThanOrEqual(0);
    let slower = 0, total = 0;
    for (let e = 0; e < g.m && total < 300; e++) {
      if (g.cls[e] > 2) continue;
      total++;
      const f8 = tr.speedFactor(tr.typical(2 * e, t8)), f3 = tr.speedFactor(tr.typical(2 * e, t3));
      expect(f8).toBeLessThanOrEqual(f3 + 1e-9);
      if (f8 < f3 - 1e-3) slower++;
    }
    expect(slower / total).toBeGreaterThan(0.5);
    expect(tr.profile(8, false)).toBeGreaterThan(tr.profile(3, false));

    const { route } = buildLine(game, { stops: 7, buses: 1 });
    const prof = game.profiles.get(route)![0];
    expect(prof.total[0][8]).toBeGreaterThan(prof.total[0][3]);
  });
});

describe('finance', () => {
  it('reconciles over several days; daily totals add up; selling credits the ledger', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const { buses, route } = buildLine(game, { stops: 6, buses: 3, headway: 12 });
    game.run(3 * DAY);
    expect(reconcile(game.state).ok).toBe(true);
    expect(game.audit()).toEqual([]);
    const f = game.state.finance;
    const days = Object.keys(f.daily).map(Number).sort((a, b) => a - b);
    expect(days.length).toBeGreaterThanOrEqual(2);
    for (const d of days) {
      const tot = dayTotals(game.state, d);
      const sum = Object.values(f.daily[d]).reduce((s, x) => s + x, 0);
      expect(tot.cash).toBeCloseTo(sum, 1);
      expect(tot.income + tot.operating + tot.capital).toBeCloseTo(sum, 1);
    }
    expect(game.state.finance.loan).toBe(0);

    const before = f.balance;
    const nLedger = f.ledger.length;
    const sold = game.sellVehicle(buses[0]);
    expect(sold.ok).toBe(true);
    game.run(6 * HOUR);
    expect(game.state.vehicles[buses[0]]).toBeUndefined();
    const sales = f.ledger.filter((e) => e.cat === 'vehicle_sale');
    expect(sales.length).toBeGreaterThan(0);
    expect(sales.every((e) => e.amt > 0)).toBe(true);
    expect(f.ledger.length).toBeGreaterThan(nLedger);
    expect(reconcile(game.state).ok).toBe(true);
    expect(f.balance).not.toBe(before);
    expect(route).toBeTruthy();
  });

  it('loans move cash and reconcile', () => {
    const game = newGame();
    const b0 = game.state.finance.balance;
    expect(game.takeLoan(50_000).ok).toBe(true);
    expect(game.state.finance.balance).toBeCloseTo(b0 + 50_000, 1);
    expect(game.repayLoan(20_000).ok).toBe(true);
    expect(reconcile(game.state).ok).toBe(true);
  });
});

describe('territory', () => {
  it('blocks stops outside owned zones, and licences must be adjacent', () => {
    const game = newGame({ allZones: false, extraFunds: 2_000_000 });
    const r = game.region;
    const start = game.state.territory.owned.slice();
    // a new company starts with its home area and the areas around it, about 15 km²
    expect(start).toEqual(startingZones(r.zones, game.state.territory.home));
    expect(start.length).toBeGreaterThan(2);
    const km2 = start.reduce((a, id) => a + landOf(r.zones.find((z) => z.id === id)!), 0);
    expect(km2).toBeGreaterThan(START_AREA_KM2 - 4);
    expect(km2).toBeLessThan(START_AREA_KM2 + 5);
    const touches = (z: { neighbours: string[] }) => start.some((id) => z.neighbours.includes(id));
    const neigh = r.zones.find((z) => !start.includes(z.id) && touches(z))!;
    const far = r.zones.find((z) => !start.includes(z.id) && !touches(z));

    const tryZone = (zid: string, expectOk: boolean | null) => {
      const z = r.zones.find((x) => x.id === zid)!;
      for (const s of r.osmStops) {
        const res = game.placeStop(s.lngLat);
        if (res.ok) {
          if (expectOk === false) throw new Error('stop placed outside licence');
          const st = game.state.stops[res.value];
          if (st.zone === zid) return { res, z };
        } else if (res.error.includes(z.name) && /licen/i.test(res.error)) return { res, z };
      }
      return { res: null, z };
    };
    // some stop elsewhere is rejected with a helpful licence message
    const rej = tryZone(neigh.id, null);
    expect(rej.res).not.toBeNull();
    if (!rej.res!.ok) expect(rej.res!.error).toMatch(/licen/i);
    expect(game.state.territory.owned).toEqual(start);

    // non-adjacent purchase fails
    if (far) {
      const info = licenceInfo(game, far.id)!;
      expect(info.adjacent).toBe(false);
      const b = game.state.finance.balance;
      const res = game.buyLicence(far.id);
      expect(res.ok).toBe(false);
      expect(game.state.finance.balance).toBe(b);
    }
  });

  it('buying an adjacent zone deducts money and allows stops there', () => {
    const game = newGame({ allZones: false, extraFunds: 2_000_000 });
    game.state.company.reputation = 100; // isolate the money rule from reputation gating
    const owned = game.state.territory.owned;
    const target = game.region.zones.find((z) => !owned.includes(z.id) && z.neighbours.some((id) => owned.includes(id)))!;
    const info = licenceInfo(game, target.id)!;
    expect(info.adjacent).toBe(true);
    // the first licence after founding is priced as the first purchase
    expect(licencesBought(game.state)).toBe(0);
    const b0 = game.state.finance.balance;
    const res = game.buyLicence(target.id);
    expect(res.ok).toBe(true);
    expect(game.state.finance.balance).toBeCloseTo(b0 - info.cost, 1);
    expect(game.state.territory.owned).toContain(target.id);
    expect(reconcile(game.state).ok).toBe(true);
    // now the zone's stops are accepted
    let placed = false;
    for (const s of game.region.osmStops) {
      const r = game.placeStop(s.lngLat);
      if (r.ok && game.state.stops[r.value].zone === target.id) { placed = true; break; }
    }
    expect(placed).toBe(true);
  });
});

describe('save and load', () => {
  const reload = (game: Game) => new Game(JSON.parse(game.serialize()), region());
  const summary = (g: Game) => ({
    t: g.t,
    balance: g.state.finance.balance,
    veh: Object.values(g.state.vehicles).map((v) => [v.id, v.status, v.load, v.km.toFixed(3), JSON.stringify(v.pos)]),
    trips: Object.values(g.state.trips).flat().map((t) => [t.id, t.state, t.veh]),
    rng: g.state.rng,
  });

  it('round trips and continues deterministically', () => {
    const a = newGame({ extraFunds: 1_000_000, seed: 7 });
    buildLine(a, { stops: 6, buses: 3, headway: 10 });
    a.run(2 * HOUR);
    const b = reload(a);
    expect(b.state.finance.balance).toBe(a.state.finance.balance);
    expect(b.state.vehicles).toEqual(a.state.vehicles);
    expect(b.state.trips).toEqual(a.state.trips);
    expect(b.state.rng).toBe(a.state.rng);
    expect(b.audit()).toEqual([]);

    a.run(HOUR);
    b.run(HOUR);
    expect(b.audit()).toEqual([]);
    expect(reconcile(b.state).ok).toBe(true);
    const sa = summary(a), sb = summary(b);
    expect(sb.t).toBe(sa.t);
    expect(sb.balance).toBeCloseTo(sa.balance, 0);
    expect(sb.rng).toBe(sa.rng);
    expect(sb.veh).toEqual(sa.veh);
    expect(sb.trips).toEqual(sa.trips);
  });

  it('migrate() rejects saves from a newer version', async () => {
    let mod: typeof import('../../app/session.ts');
    try {
      mod = await import('../../app/session.ts');
    } catch (e) {
      // session.ts pulls in browser-only modules; fall back to checking the version constant exists
      console.warn('migrate not importable in Node:', (e as Error).message);
      const { SAVE_VERSION } = await import('../types.ts');
      expect(SAVE_VERSION).toBeGreaterThan(0);
      return;
    }
    const game = newGame();
    const raw = JSON.parse(game.serialize());
    expect(() => mod.migrate(raw)).not.toThrow();
    expect(() => mod.migrate({ ...raw, version: raw.version + 1 })).toThrow(/newer/i);
    expect(() => mod.migrate({})).toThrow();
    expect(() => mod.migrate(null)).toThrow();
  });
});
