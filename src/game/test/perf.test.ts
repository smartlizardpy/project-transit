// Performance guard rail: a big network (10 lines, ~70 buses over many zones) must simulate far faster than
// the fastest game speed demands.
import { describe, expect, it } from 'vitest';
import { newGame, stopsAlong } from './helpers.ts';
import { flatTimetable, sustainableHeadway } from '../timetable.ts';
import { arrivalsAt } from '../eta.ts';
import { distanceM, type LngLat } from '../world/graph.ts';
import { SPEEDS } from '../content.ts';

const BUDGET_MS_PER_REAL_SECOND = 120;
const SPEED = SPEEDS[SPEEDS.length - 1];

describe('performance', () => {
  it('a 10-line / 70-bus network at the 08:00 peak keeps up with the fastest speed', () => {
    const game = newGame({ allZones: true, extraFunds: 20_000_000, seed: 3 });
    const zones = game.region.zones.slice().sort((a, b) => b.residents + b.jobs - (a.residents + a.jobs));
    const depots: string[] = [];
    const centres = zones.slice(0, 12).map((z) => z.centroid as LngLat);
    // depots: one per ~8 buses, spread over the busiest zones
    for (const c of centres) {
      if (depots.length >= 5) break;
      for (const off of [0, 0.002, -0.002, 0.004]) {
        const d = game.buildDepot([c[0] + off, c[1] + off / 2]);
        if (d.ok) { depots.push(d.value); game.expandDepot(d.value); game.expandDepot(d.value); break; }
      }
    }
    expect(depots.length).toBeGreaterThanOrEqual(3);

    // lines: connect pairs of the busiest zone centroids, 8-12 stops each
    const lines: string[] = [];
    let buses = 0;
    const pairs: [LngLat, LngLat][] = [];
    for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) {
      const d = distanceM(centres[i], centres[j]);
      if (d > 2500 && d < 7000) pairs.push([centres[i], centres[j]]);
    }
    for (const [a, b] of pairs) {
      if (lines.length >= 10) break;
      const pts = stopsAlong(game, a, b, 450).slice(0, 12);
      const stops = pts.map((p) => game.placeStop(p)).filter((r) => r.ok).map((r) => (r as { value: string }).value);
      if (stops.length < 5) continue;
      const r = game.createRoute({ stops, kind: 'linear', timetable: flatTimetable(12) });
      if (!r.ok) continue;
      const mine: string[] = [];
      for (let k = 0; k < 7 && buses < 75; k++) {
        const depot = depots[(lines.length + k) % depots.length];
        const v = game.buyVehicle('city12', depot);
        if (!v.ok) continue;
        game.assignVehicle(v.value, r.value);
        mine.push(v.value);
        buses++;
      }
      if (mine.length) game.setTimetable(r.value, flatTimetable(sustainableHeadway(game.profiles.get(r.value)!, 4, mine.length)));
      lines.push(r.value);
    }
    expect(lines.length).toBeGreaterThanOrEqual(8);
    expect(buses).toBeGreaterThanOrEqual(60);

    // warm up to 08:00 on a weekday-start (game starts 05:00 on day 0), then measure 2 peak hours
    game.run(3 * 3600);
    const t0 = performance.now();
    game.run(2 * 3600);
    const msPerHour = (performance.now() - t0) / 2;
    const perRealSecond = (msPerHour * SPEED) / 3600;

    const s0 = performance.now();
    const json = game.serialize();
    const serMs = performance.now() - s0;

    // busiest stop = the one served by most lines
    const use = new Map<string, number>();
    for (const r of Object.values(game.state.routes)) for (const s of r.stops) use.set(s, (use.get(s) ?? 0) + 1);
    const stop = [...use.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const a0 = performance.now();
    for (let i = 0; i < 20; i++) arrivalsAt(game, stop);
    const arrMs = (performance.now() - a0) / 20;

    const onboard = Object.values(game.state.vehicles).reduce((n, v) => n + v.load, 0);
    console.log(
      `PERF lines=${lines.length} buses=${buses} stops=${Object.keys(game.state.stops).length} zones=${game.state.territory.owned.length} riders on board=${onboard}\n` +
        `PERF ms/game-hour=${msPerHour.toFixed(1)} -> ${perRealSecond.toFixed(1)} ms per real second at ${SPEED}x (budget ${BUDGET_MS_PER_REAL_SECOND})\n` +
        `PERF serialize=${serMs.toFixed(1)} ms, json=${(json.length / 1e6).toFixed(2)} MB, arrivalsAt=${arrMs.toFixed(2)} ms`,
    );
    expect(game.audit()).toEqual([]);
    expect(perRealSecond).toBeLessThan(BUDGET_MS_PER_REAL_SECOND);
    expect(serMs).toBeLessThan(500);
    expect(arrMs).toBeLessThan(25);
  });
});
