import { describe, expect, it } from 'vitest';
import { buildLine, newGame } from './test/helpers.ts';
import { reconcile } from './finance.ts';
import { paxTotals } from './passengers.ts';
import { TripState } from './types.ts';
import { vehicleXY } from './vehicles.ts';
import { nearestEdge } from './world/graph.ts';

describe('a working bus line on real Istanbul streets', () => {
  it('operates a timetabled service end to end', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const t0 = performance.now();
    const { route, buses, stopIds } = buildLine(game, { stops: 7, buses: 4, headway: 10 });
    const r = game.state.routes[route];
    const pats = game.patterns.get(route)!;
    const req = game.requirement(route, false)!;
    console.log(
      `line: ${stopIds.length} stops, ${pats.map((p) => `${(p.path.length / 1000).toFixed(2)} km`).join(' / ')},`,
      `run ${pats.map((_, i) => Math.round(game.profiles.get(route)![i].total[0][8] / 60)).join('/')} min @08,`,
      `needs ${req.peak} buses, built in ${Math.round(performance.now() - t0)} ms`,
    );
    expect(pats.every((p) => p.valid)).toBe(true);

    // every vertex of every pattern is on the road graph
    const g = game.region.graph;
    for (const p of pats) for (let i = 1; i < p.path.nodes.length; i++) expect(p.path.dedges[i - 1]).toBeGreaterThanOrEqual(0);

    const t1 = performance.now();
    game.run(4 * 3600); // 05:00 → 09:00
    const ms = performance.now() - t1;
    const statuses = buses.map((id) => game.state.vehicles[id].status);
    const trips = game.state.trips[route];
    const done = trips.filter((x) => x.state === TripState.Done).length;
    const missed = trips.filter((x) => x.state === TripState.Missed).length;
    const pax = paxTotals(game.state);
    console.log(`4 h simulated in ${Math.round(ms)} ms; statuses ${statuses.join(',')}; trips done ${done}, missed ${missed}`);
    console.log(`passengers: generated ${game.counters.generated}, waiting ${pax.waiting}, on board ${pax.onboard}, completed ${game.counters.completed}, lost ${game.counters.lost}, boardings ${game.counters.boardings}`);
    console.log(`balance ${Math.round(game.state.finance.balance)}; ledger ${game.state.finance.ledger.length} entries`);
    console.log(game.state.finance.ledger.slice(-8).map((e) => `${e.cat} ${e.amt} ${e.memo}`).join('\n'));

    expect(done).toBeGreaterThan(10);
    // a 7-stop line in the first hours of the morning; destinations compete across the whole
    // map, so this is a floor that shows journeys complete, not a ridership target
    expect(game.counters.completed).toBeGreaterThan(25);
    expect(game.audit()).toEqual([]);
    expect(reconcile(game.state).ok).toBe(true);

    // buses on the road are on a road
    for (const id of buses) {
      const v = game.state.vehicles[id];
      const xy = vehicleXY(game, v);
      if (!xy) continue;
      const hit = nearestEdge(g, game.region.index, xy.x, xy.y, 3);
      expect(hit, `${v.fleetNo} off-road`).not.toBeNull();
    }
    expect(r.vehicles.length).toBe(4);
  });
});
