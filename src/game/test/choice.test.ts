// Phase 7 of the City Activity Engine: nested choice, the trust constant in place of the cap on
// your network's share, and walking changes between nearby stops.
import { describe, expect, it } from 'vitest';
import { buildLine, newGame, stopsAlong } from './helpers.ts';
import { modeShares } from '../activity/model.ts';
import { CHOICE, NESTS, trustMinutes } from '../activity/params.ts';
import { computeItineraries, type PatternService } from '../passengers.ts';
import { checkStop } from '../network.ts';
import { distanceM, type LngLat } from '../world/graph.ts';
import { DAY, HOUR } from '../content.ts';
import type { Pattern } from '../network.ts';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('nested choice', () => {
  it('shares add up to one, and with every nest at 1 it is the plain logit', () => {
    const c = [30, 40, 25, 35, 28, 32];
    expect(sum(modeShares(c[0], c[1], c[2], c[3], c[4], c[5]))).toBeCloseTo(1, 9);
    expect(sum(modeShares(30, Infinity, Infinity, 35, 28, Infinity))).toBeCloseTo(1, 9);
    const keep = { ...NESTS };
    try {
      Object.assign(NESTS, { transport: 1, active: 1, private: 1 });
      const s = modeShares(c[0], c[1], c[2], c[3], c[4], c[5]);
      const e = c.map((x) => Math.exp(-x / CHOICE.scale));
      e.forEach((x, i) => expect(s[i]).toBeCloseTo(x / sum(e), 9));
    } finally {
      Object.assign(NESTS, keep);
    }
  });

  it('a better bus line draws more, in proportion, from the metro than from cars', () => {
    const before = modeShares(40, 45, 30, 38, 32, 31);
    const after = modeShares(40, 45, 30, 38, 27, 31);
    expect(after[4]).toBeGreaterThan(before[4]);
    const lostTransit = 1 - after[5] / before[5];
    const lostCar = 1 - after[2] / before[2];
    const lostWalk = 1 - after[0] / before[0];
    expect(lostTransit).toBeGreaterThan(lostCar * 1.5);
    // within the other nests, cars and walking lose the same share (they are not nested with buses)
    expect(lostWalk).toBeCloseTo(lostCar, 6);
  });
});

describe('trust instead of the cap', () => {
  it('is worth a few minutes, less as reputation rises', () => {
    expect(trustMinutes(0)).toBe(CHOICE.trust.at0);
    expect(trustMinutes(100)).toBe(CHOICE.trust.at100);
    expect(trustMinutes(30)).toBeGreaterThan(trustMinutes(70));
    expect(trustMinutes(-5)).toBe(trustMinutes(0));
    expect(CHOICE.trust.at0).toBeLessThan(10);
  });

  it('the same line carries more riders when the company is better trusted', () => {
    const riders = (rep: number) => {
      const game = newGame({ seed: 5, allZones: true });
      const { route } = buildLine(game, { to: [28.9935, 41.067], buses: 4, headway: 8 });
      game.state.company.reputation = rep;
      // hold reputation still: only the trust constant differs between the two runs
      game.run(DAY + 6 * HOUR - game.t);
      game.state.company.reputation = rep;
      game.run(12 * HOUR);
      return sum(game.state.analytics.today.routes[route].b);
    };
    const low = riders(20), high = riders(90);
    expect(high).toBeGreaterThan(low * 1.15);
  }, 120_000);
});

describe('walking changes between nearby stops', () => {
  const svc = (route: string, stops: string[], idx: number[], tmin: number[], headway = 10): PatternService => ({
    pattern: { route, index: 0, stops } as unknown as Pattern,
    sIdx: idx,
    tmin,
    headway,
    available: true,
  });

  it('finds a change by walking to a stop nearby, and costs the walk', () => {
    // served stops: 0 a1, 1 a2, 2 a3 (line A); 3 b1 (near a2), 4 b2 (line B)
    const A = svc('A', ['a1', 'a2', 'a3'], [0, 1, 2], [0, 5, 10]);
    const B = svc('B', ['b1', 'b2'], [3, 4], [0, 8]);
    const none = computeItineraries(5, [A, B]);
    expect(none.get(0 * 5 + 4)).toBeUndefined();
    const walk = [[], [{ s: 3, min: 2.5 }], [], [{ s: 1, min: 2.5 }], []];
    const it = computeItineraries(5, [A, B], walk).get(0 * 5 + 4)!;
    expect(it.transfers).toBe(1);
    expect(it.walk).toBe(2.5);
    expect(it.legs).toEqual([{ r: 'A', p: 0, a: 'a2' }, { r: 'B', p: 0, a: 'b2', b: 'b1' }]);
    // 1.8 × 5 wait + 5 ride, 6 for the change, 1.5 × 2.5 walking, 1.8 × 5 wait + 8 ride
    expect(it.gt).toBeCloseTo(14 + 6 + 3.75 + 17, 6);
  });

  it('in the simulation people walk to the other stop, can board only once they have walked it, and ride on', () => {
    const game = newGame({ seed: 3, allZones: true, extraFunds: 2_000_000 });
    const a = buildLine(game, { to: [28.9935, 41.067], buses: 6, headway: 8 });
    // line B starts near one of line A's middle stops, on another street, and does not call at A's stops
    const G = game.region.graph;
    const mid = game.state.stops[a.stopIds[2]].lngLat;
    let start: LngLat | null = null;
    for (let v = 0; v < G.n && !start; v++) {
      const ll: LngLat = [G.lng[v], G.lat[v]];
      const d = distanceM(ll, mid);
      if (d < 140 || d > 260) continue;
      if (a.stopIds.some((s) => distanceM(game.state.stops[s].lngLat, ll) < 140)) continue;
      if (checkStop(game.state, game.region, game.geo, ll).ok) start = ll;
    }
    expect(start).not.toBeNull();
    const far: LngLat = [start![0] - 0.02, start![1] - 0.006];
    const bStops = [start!, ...stopsAlong(game, start!, far).filter((p) => distanceM(p, start!) > 300)].slice(0, 6);
    const ids = bStops.map((p) => game.placeStop(p)).filter((r) => r.ok).map((r) => (r as { value: string }).value);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const b = game.createRoute({ stops: ids, kind: 'linear', timetable: { weekday: { bands: [{ from: 300, to: 1380, headway: 8 }] }, weekend: { bands: [{ from: 300, to: 1380, headway: 8 }] }, layover: 3 } });
    expect(b.ok).toBe(true);
    expect(game.expandDepot(a.depot).ok).toBe(true);
    for (let i = 0; i < 4; i++) {
      const bus = game.buyVehicle('city12', a.depot);
      expect(bus.ok).toBe(true);
      if (bus.ok) game.assignVehicle(bus.value, (b as { value: string }).value);
    }
    game.run(DAY + 8 * HOUR - game.t);
    // some itinerary changes from line A to line B by walking
    const dm = game.demand;
    dm.refresh(game, game.t);
    const walking = [...dm.itin.values()].filter((x) => x.legs[1]?.b);
    expect(walking.length, `${dm.stops.length} stops, links ${JSON.stringify(dm.walk)}`).toBeGreaterThan(0);
    // the model sends some of its demand that way
    let viaWalk = 0;
    for (let n = 0; n < dm.pairs.length; n++) if (dm.itin.get(dm.pairs[n])?.legs[1]?.b) viaWalk += dm.rate[n];
    expect(viaWalk).toBeGreaterThan(0);
    // follow five travellers on one of these journeys through the simulation
    const S = dm.stops.length;
    const [pair, it] = [...dm.itin.entries()].find(([, x]) => x.legs[1]?.b && x.legs[0].r === a.route)!;
    const origin = dm.stops[Math.floor(pair / S)], dest = dm.stops[pair % S];
    const change = it.legs[1].b!;
    const t0 = game.t;
    (game.state.pax.waiting[origin] ??= []).push({ n: 5, o: origin, d: dest, legs: it.legs, leg: 0, t0, tl: t0, w: 0, r: 0, cr: 0, dl: 0, fr: null, k: 0, pu: 0 });
    game.counters.generated += 5; // as the generator counts the people it creates (engine audit)
    const ours = (g: { o: string; d: string; t0: number }) => g.o === origin && g.d === dest && g.t0 === t0;
    let walkingSeen = false, boardedB = false, done = false;
    for (let m = 0; m < 4 * 60 && !done; m++) {
      game.run(60);
      const t = game.t;
      const waitingAtChange = (game.state.pax.waiting[change] ?? []).filter(ours);
      if (waitingAtChange.some((g) => g.tl > t)) walkingSeen = true;
      const riding = Object.values(game.state.pax.onboard).flat().filter(ours);
      if (riding.some((g) => g.leg === 1)) boardedB = true;
      const anywhere = riding.length + Object.values(game.state.pax.waiting).flat().filter(ours).length;
      if (boardedB && anywhere === 0) done = true;
    }
    expect(walkingSeen, 'waited at the other stop only after walking there').toBe(true);
    expect(boardedB, 'rode on line B').toBe(true);
    expect(done, 'finished the journey').toBe(true);
    expect(game.audit()).toEqual([]);
  }, 180_000);
});
