// City Activity Engine, phase 2: journeys and choice (docs/city-activity-engine-plan.md, section 17).
import { describe, expect, it } from 'vitest';
import { buildLine, newGame } from './helpers.ts';
import { referenceLine } from './calibration.ts';
import { expectIdenticalRuns, expectReloadContinuity } from './determinism.ts';
import { DAY, HOUR } from '../content.ts';
import { flatTimetable } from '../timetable.ts';
import { awayTotal } from '../passengers.ts';
import { estimatedDemand, placeTravel } from '../analytics/query.ts';
import { _cellAttraction, buildActivityZones } from '../activity/zones.ts';
import { distributeTours } from '../activity/od.ts';
import { KIND } from '../activity/params.ts';
import { distanceM, type LngLat } from '../world/graph.ts';
import type { CityPlace } from '../world/places.ts';
import type { DemandGrid } from '../world/region.ts';
import type { Game } from '../engine.ts';
import type { PaxGroup } from '../types.ts';

const groups = (game: Game): PaxGroup[] => [...Object.values(game.state.pax.waiting).flat(), ...Object.values(game.state.pax.onboard).flat()];

describe('origin–destination consistency', () => {
  it('accounts for every traveller over two days, and returns never exceed outbound arrivals', () => {
    const { game } = referenceLine(8, 4);
    let mostAway = 0;
    for (let h = 0; h < 48; h += 3) {
      game.run(3 * HOUR);
      // generated = completed + given up or stranded + waiting or on board; away = sent away − returned
      expect(game.audit()).toEqual([]);
      mostAway = Math.max(mostAway, awayTotal(game.state));
      for (const g of groups(game)) {
        expect(game.state.stops[g.o], `origin ${g.o}`).toBeTruthy();
        expect(game.state.stops[g.d], `destination ${g.d}`).toBeTruthy();
        expect(g.o).not.toBe(g.d);
      }
    }
    const c = game.counters;
    expect(mostAway).toBeGreaterThan(100);
    expect(c.returned).toBeGreaterThan(0);
    expect(c.returned).toBeLessThanOrEqual(c.away);
    // only completed journeys send people away, and only round trips do
    expect(c.away).toBeLessThanOrEqual(c.completed);
  }, 180_000);
});

describe('directional demand', () => {
  it('a line from homes to jobs fills towards the jobs in the morning and back in the evening', () => {
    // Haseki and Fındıkzade (mostly homes) → Beyazıt and the Grand Bazaar (mostly jobs)
    const homes: LngLat = [28.9393, 41.0268], jobs: LngLat = [28.9598, 41.0141];
    const game = newGame({ seed: 5, extraFunds: 1_000_000 });
    const line = buildLine(game, { from: homes, to: jobs, buses: 4, headway: 10 });
    expect(line.stopIds.length).toBeGreaterThanOrEqual(6);
    game.run(2 * DAY - game.t + 5 * HOUR); // through day 1, a weekday
    expect(game.isWeekend(DAY + 12 * HOUR)).toBe(false);
    const d = game.state.analytics.days.find((x) => x.day === 1)!;
    const half = Math.floor(line.stopIds.length / 2);
    const homeEnd = line.stopIds.slice(0, half), jobEnd = line.stopIds.slice(-half);
    const boardings = (ids: string[], h0: number, h1: number) => ids.reduce((a, id) => a + (d.stops[id]?.b ?? []).slice(h0, h1).reduce((x, y) => x + y, 0), 0);
    // 06:00–10:00: from the homes; 16:00–20:00: from the jobs (returns spread over more hours)
    expect(boardings(homeEnd, 6, 10)).toBeGreaterThanOrEqual(2 * boardings(jobEnd, 6, 10));
    expect(boardings(jobEnd, 16, 20)).toBeGreaterThanOrEqual(1.4 * boardings(homeEnd, 16, 20));
  }, 180_000);
});

describe('choice', () => {
  it('a more frequent line wins riders from walking and cars, with a bounded rise in trips', () => {
    const { game, route } = referenceLine(8, 4);
    game.run(DAY - game.t + 3 * HOUR); // day 1, 03:00, before the first bus
    const before = estimatedDemand(game, { level: 'zone' });
    for (let i = 0; i < 4; i++) {
      const b = game.buyVehicle('city12', Object.keys(game.state.depots)[0]);
      if (b.ok) game.assignVehicle(b.value, route);
    }
    game.setTimetable(route, flatTimetable(6));
    const after = estimatedDemand(game, { level: 'zone' });
    const key = (f: { o: string; d: string }) => `${f.o}>${f.d}`;
    const was = new Map(before.flows.map((f) => [key(f), f]));
    let net0 = 0, net1 = 0, walk0 = 0, walk1 = 0, car0 = 0, car1 = 0, all0 = 0, all1 = 0;
    for (const f of after.flows) {
      const b = was.get(key(f));
      if (!b?.served) continue;
      net0 += b.modes[4]; net1 += f.modes[4];
      walk0 += b.modes[0]; walk1 += f.modes[0];
      car0 += b.modes[2]; car1 += f.modes[2];
      all0 += b.trips; all1 += f.trips;
    }
    expect(net1).toBeGreaterThan(net0 * 1.1);
    expect(walk1).toBeLessThan(walk0);
    expect(car1).toBeLessThan(car0);
    // optional trips rise a little (people go out more), never by more than 15%
    expect(all1).toBeGreaterThanOrEqual(all0);
    expect(all1).toBeLessThanOrEqual(all0 * 1.15);
  }, 120_000);
});

describe('unserved demand', () => {
  it('a large shopping centre with no stops has estimated trips, almost none by your network, and reading them makes no passengers or fares', () => {
    const make = () => referenceLine(8, 4).game;
    const game = make(), plain = make();
    const mall = [...game.geo.places.byId.values()].find((p) => p.category === 'mall' && /Cevahir/.test(p.name))!;
    expect(mall).toBeTruthy();
    expect(Object.values(game.state.stops).every((s) => distanceM(s.lngLat, mall.lngLat) > 1000)).toBe(true);
    for (let h = 0; h < 4; h++) {
      game.run(3 * HOUR);
      plain.run(3 * HOUR);
      const t = placeTravel(game, mall.id)!;
      expect(t.trips).toBeGreaterThan(100);
      // only by a change to the metro at a stop near a station (Cevahir is beside one)
      expect(t.modes[4]).toBeLessThan(0.01 * t.trips);
      expect(t.served).toBe(false);
      const un = estimatedDemand(game, { level: 'place', view: 'unserved' });
      expect(un.flows.some((f) => (f.o === `p:${mall.id}` || f.d === `p:${mall.id}`) && f.trips > 0 && f.noStop > 0)).toBe(true);
    }
    // reading the estimate created no groups and no fares: the game is the one that never read it
    expect(JSON.stringify(game.state.pax)).toBe(JSON.stringify(plain.state.pax));
    expect(game.state.finance.balance).toBe(plain.state.finance.balance);
  }, 180_000);

  it('the airports beyond the map show trips from your areas, none of them by your network', () => {
    const { game } = referenceLine(8, 4);
    game.run(4 * HOUR);
    for (const id of ['iata:IST', 'iata:SAW']) {
      const t = placeTravel(game, id)!;
      expect(t, id).toBeTruthy();
      expect(t.trips).toBeGreaterThan(10);
      expect(t.modes[4]).toBe(0);
    }
    const un = estimatedDemand(game, { level: 'place', view: 'unserved', destination: 'p:iata:IST' });
    expect(un.total.trips).toBeGreaterThan(5);
    expect(un.flows.every((f) => f.modes[4] === 0)).toBe(true);
  }, 120_000);
});

describe('places and the activity budget', () => {
  it('a 40 million passenger airport draws at least 30 times the air travellers of a 0.5 million one', () => {
    const game = newGame({ seed: 1 });
    const at = (dx: number): LngLat => [28.99 + dx, 41.05];
    const airport = (id: string, pax: number, lngLat: LngLat): CityPlace => ({
      id, name: id, category: 'airport', lngLat, areaM2: 0, floorM2: 0,
      scale: { value: pax, unit: 'pax_year', tier: pax > 1e7 ? 1 : 4, measured: true, source: 'test' },
      sources: ['test'], location: 'measured', confidence: 1, reachable: true, distanceKm: 0,
    });
    const region = { ...game.region, cityPlaces: [...(game.region.cityPlaces ?? []), airport('test:big', 40e6, at(0)), airport('test:small', 0.5e6, at(0.004))] };
    const zs = buildActivityZones({ region, toXY: game.geo.P.toXY, toLngLat: game.geo.P.toLngLat, owned: game.state.territory.owned, season: 'autumn' });
    const m = distributeTours(zs);
    const travellers = (id: string) => {
      const z = zs.list.findIndex((x) => x.id === `p:${id}`);
      let n = 0;
      for (let e = 0; e < m.tours.length; e++) if ((m.k[e] === KIND.fly && m.d[e] === z) || (m.k[e] === KIND.landed && m.o[e] === z)) n += m.tours[e];
      return n;
    };
    expect(travellers('test:small')).toBeGreaterThan(0);
    expect(travellers('test:big')).toBeGreaterThanOrEqual(30 * travellers('test:small'));
  });

  it('a block with 500 restaurants changes the kind of trips, not their total beyond the floor space; no POIs still works', () => {
    const cell = (pois: { shopping: number; leisure: number }, work = 2000, residents = 800): DemandGrid =>
      ({ residents: [residents], jobs: [work], work: [work], shopping: [pois.shopping], leisure: [pois.leisure], services: [0], education: [0], health: [0] }) as unknown as DemandGrid;
    const total = (a: Record<string, number>) => a.shopping + a.leisure + a.errand + a.night + a.visit;
    const few = _cellAttraction(cell({ shopping: 5, leisure: 5 }), 0, 0, false);
    const many = _cellAttraction(cell({ shopping: 5, leisure: 500 }), 0, 0, false);
    const none = _cellAttraction(cell({ shopping: 0, leisure: 0 }), 0, 0, false);
    const empty = _cellAttraction(cell({ shopping: 0, leisure: 0 }, 0, 0), 0, 0, false);
    // the floor space caps the visits; the residents add a little of their own
    const cap = 2000 * 10 * 1.5 + 800 * 0.3;
    expect(total(many)).toBeLessThanOrEqual(cap);
    expect(many.leisure / total(many)).toBeGreaterThan(few.leisure / total(few));
    for (const a of [few, many, none, empty]) for (const v of Object.values(a)) expect(Number.isFinite(v) && v >= 0).toBe(true);
    expect(none.work).toBe(2000);
    expect(total(empty)).toBe(0);
  });
});

describe('determinism with the away pool', () => {
  it('two runs agree, and a reload while people are at work carries on identically', () => {
    const make = () => {
      const g = newGame({ seed: 4, extraFunds: 1_000_000 });
      buildLine(g, { buses: 3, stops: 8 });
      return g;
    };
    const game = expectIdenticalRuns(make, 6 * HOUR); // 05:00 → 11:00
    expect(awayTotal(game.state)).toBeGreaterThan(0);
    const copy = expectReloadContinuity(game, 9 * HOUR); // through the evening returns
    expect(copy.audit()).toEqual([]);
  }, 180_000);
});

describe('size and speed', () => {
  it('the new analytics add at most 30% to a day record, and the away pool stays small', () => {
    const { game } = referenceLine(8, 4);
    game.run(DAY - game.t + 12 * HOUR); // day 1, 12:00
    const away = JSON.stringify(game.state.pax.away).length;
    expect(away).toBeLessThan(40_000);
    game.run(DAY);
    const d = game.state.analytics.days.find((x) => x.day === 1)!;
    const full = JSON.stringify(d).length;
    const bare = JSON.stringify(d, (k, v) => (['k', 'jk', 'sk', 'lk', 'sd', 'odk'].includes(k) ? undefined : v)).length;
    expect(full).toBeLessThanOrEqual(bare * 1.3);
  }, 120_000);
});

