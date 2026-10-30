// City Activity Engine, phase 3: places come alive (docs/city-activity-engine-plan.md, section 17).
// Calendar rules, place profiles, space on board, and the city's existing transit as a choice.
import { describe, expect, it } from 'vitest';
import { buildLine, newGame, region } from './helpers.ts';
import { referenceLine } from './calibration.ts';
import { DAY, HOUR, MODEL } from '../content.ts';
import { Game } from '../engine.ts';
import { calendarDay, calendarPattern, dayType, type DayType } from '../calendar.ts';
import { dayTiming, marketDayOf, PROFILE, profileOf } from '../activity/profiles.ts';
import { KIND, KIND_COUNT, TYPE } from '../activity/params.ts';
import { buildActivityZones } from '../activity/zones.ts';
import { distributeTours } from '../activity/od.ts';
import { transitWaitFactor } from '../activity/transit.ts';
import { estimatedDemand } from '../analytics/query.ts';
import { occupied, serveStop } from '../passengers.ts';
import { dwellTime } from '../vehicles.ts';
import type { CityPlace } from '../world/places.ts';
import type { LngLat } from '../world/graph.ts';
import type { PaxGroup } from '../types.ts';

/** The day type of a weekday in a week of a 12-week year (Monday = 0). */
const on = (week: number, weekday: number, country = 'TR', yearWeeks = 12): DayType =>
  dayType(calendarDay({ yearWeeks, epochDay: 0 }, 0, (week - 1) * 7 + weekday), calendarPattern(country));

describe('the calendar: terms, exams, holidays and shop rules (typical pattern)', () => {
  it('follows the default 12-week layout', () => {
    expect(on(1, 0)).toMatchObject({ school: true, uni: 'teaching', holiday: false, weekend: false });
    expect(on(5, 1)).toMatchObject({ school: false, schoolHolidays: true, festive: true });
    expect(on(6, 2)).toMatchObject({ school: true, uni: 'exams' });
    expect(on(9, 2).uni).toBe('exams');
    expect(on(7, 0).school).toBe(false); // a short break early in spring
    expect(on(7, 2).school).toBe(true);
    for (const w of [10, 11, 12]) expect(on(w, 2)).toMatchObject({ school: false, schoolHolidays: true, uni: 'break' });
    expect(on(1, 5)).toMatchObject({ weekend: true, school: false, schoolHolidays: false });
  });

  it('public holidays and shop rules differ by country', () => {
    expect(on(2, 2, 'TR')).toMatchObject({ holiday: true, school: false, schoolHolidays: false });
    expect(on(2, 2, 'GB').holiday).toBe(false);
    expect(on(1, 6, 'DE').shops).toBeLessThan(0.1); // Sunday closing
    expect(on(1, 6, 'TR').shops).toBe(1);
    expect(on(1, 2, 'DE').shops).toBe(1);
  });

  it('scales to a longer year: a holiday falls once, in the first week of its template week', () => {
    // template week 2 of 12 is weeks 3–4 of 24
    expect(on(3, 2, 'TR', 24).holiday).toBe(true);
    expect(on(4, 2, 'TR', 24).holiday).toBe(false);
    expect(on(19, 2, 'TR', 24).uni).toBe('break');
  });
});

describe('place profiles', () => {
  const term = dayTiming(on(2, 3, 'GB'));
  const exams = dayTiming(on(6, 3, 'GB'));
  const brk = dayTiming(on(11, 3, 'GB'));
  const K = KIND_COUNT;
  const curve = (t: ReturnType<typeof dayTiming>, p: number, k: number) => Array.from(t.share.subarray((p * K + k) * 24, (p * K + k + 1) * 24));
  const peaks = (c: number[]) => c.filter((v, h) => v > 0.01 && v > (c[h - 1] ?? 0) && v >= (c[h + 1] ?? 0)).length;
  const spread = (c: number[]) => {
    const mean = c.reduce((s, v, h) => s + v * (h + 0.5), 0);
    return Math.sqrt(c.reduce((s, v, h) => s + v * (h + 0.5 - mean) ** 2, 0));
  };

  it('university: the break is at most 30% of term; exam weeks are lower and more spread', () => {
    const u = PROFILE.university * K + KIND.university;
    expect(brk.factor[u]).toBeLessThanOrEqual(0.3 * term.factor[u]);
    expect(exams.factor[u]).toBeLessThan(term.factor[u]);
    expect(spread(curve(exams, PROFILE.university, KIND.university))).toBeGreaterThan(spread(curve(term, PROFILE.university, KIND.university)));
    expect(Math.max(...curve(exams, PROFILE.university, KIND.university))).toBeLessThan(Math.max(...curve(term, PROFILE.university, KIND.university)));
  });

  it('shift workers change at different hours at a hospital, an airport and elsewhere; hospitals and airports work every day', () => {
    const top = (p: number) => {
      const c = curve(term, p, KIND.shift);
      return [0, 1, 2].map((i) => [i * 8, i * 8 + 8]).map(([a, b]) => a + c.slice(a, b).indexOf(Math.max(...c.slice(a, b))));
    };
    // they set off about 35 minutes before the change
    expect(top(PROFILE.city)).toEqual([5, 13, 21]);
    expect(top(PROFILE.hospital)).toEqual([6, 14, 22]);
    expect(top(PROFILE.airport1)).toEqual([4, 12, 20]);
    const sunday = dayTiming(on(2, 6, 'GB'));
    expect(sunday.factor[PROFILE.hospital * K + KIND.shift]).toBe(1);
    expect(sunday.factor[PROFILE.city * K + KIND.shift]).toBeLessThan(0.6);
    // hospital visitors at the weekend, in the afternoon and evening
    const visits = curve(sunday, PROFILE.hospital, KIND.health);
    expect(visits.slice(14, 20).reduce((a, b) => a + b, 0)).toBeGreaterThan(0.6);
  });

  it('airport travellers come in waves from early morning, unlike the staff; a hub has more waves than a small airport', () => {
    const fly = curve(term, PROFILE.airport1, KIND.fly);
    const staff = curve(term, PROFILE.airport1, KIND.shift);
    // at the airport by 05:00: they set off from 03:00
    expect(fly[3] + fly[4]).toBeGreaterThan(0.05);
    expect(peaks(fly)).toBeGreaterThanOrEqual(5);
    expect(peaks(curve(term, PROFILE.airport3, KIND.fly))).toBeLessThanOrEqual(3);
    const diff = fly.reduce((s, v, h) => s + Math.abs(v - staff[h]), 0);
    expect(diff).toBeGreaterThan(0.6);
  });

  it('a street market is busiest on its market day and shut on Sundays; malls and shops follow the Sunday rule', () => {
    const market: CityPlace = {
      id: 'test:market', name: 'Market', category: 'market', lngLat: [0, 0], areaM2: 0, floorM2: 0,
      scale: { value: 1, unit: 'm2', tier: 3, measured: false, source: 'test' }, sources: [], location: 'estimated', confidence: 0.5, reachable: true, distanceKm: 0,
    };
    const p = profileOf(market);
    const d = marketDayOf(market);
    expect(p).toBe(PROFILE[`market${d}`]);
    const f = (wd: number) => dayTiming(on(2, wd, 'GB')).factor[p * K + KIND.shopping];
    for (let wd = 0; wd < 6; wd++) if (wd !== d) expect(f(d)).toBeGreaterThan(1.5 * f(wd));
    expect(f(6)).toBeLessThan(0.3);
    const sun = (country: string) => dayTiming(on(2, 6, country)).factor[PROFILE.mall * K + KIND.shopping];
    expect(sun('DE')).toBeLessThan(0.2 * sun('TR'));
  });

  it('festive shopping in the winter holiday week', () => {
    const s = PROFILE.city * K + KIND.shopping;
    expect(dayTiming(on(5, 2, 'GB')).factor[s]).toBeGreaterThan(dayTiming(on(4, 2, 'GB')).factor[s]);
  });
});

describe('places in the model', () => {
  it('a residential campus draws fewer students from elsewhere than a commuter campus of the same size', () => {
    const game = newGame({ seed: 2 });
    const r = game.region;
    const g = r.demand;
    const campus = (id: string, at: LngLat): CityPlace => {
      const [x, y] = game.geo.P.toXY(at[0], at[1]);
      const ring = [[-150, -150], [150, -150], [150, 150], [-150, 150]].map(([dx, dy]) => game.geo.P.toLngLat(x + dx, y + dy));
      return {
        id, name: id, category: 'university', lngLat: at, ring, areaM2: 90000, floorM2: 0,
        scale: { value: 8000, unit: 'students', tier: 2, measured: true, source: 'test' }, sources: ['test'], location: 'measured', confidence: 1, reachable: true, distanceKm: 0,
      };
    };
    const a = campus('test:residential', [28.955, 41.012]);
    const b = campus('test:commuter', [28.975, 41.012]);
    // student housing inside A's outline, none inside B's
    const residents = Float32Array.from(g.residents);
    const cellsOf = (p: CityPlace) => {
      const [x, y] = game.geo.P.toXY(p.lngLat[0], p.lngLat[1]);
      const out: number[] = [];
      for (let cy = 0; cy < g.h; cy++)
        for (let cx = 0; cx < g.w; cx++) {
          const px = g.x0 + (cx + 0.5) * g.cell, py = g.y0 + (cy + 0.5) * g.cell;
          if (Math.abs(px - x) < 150 && Math.abs(py - y) < 150) out.push(cy * g.w + cx);
        }
      return out;
    };
    const ca = cellsOf(a), cb = cellsOf(b);
    for (const k of ca) residents[k] = 8000 / ca.length;
    for (const k of cb) residents[k] = 0;
    const region2 = { ...r, demand: { ...g, residents }, cityPlaces: [...(r.cityPlaces ?? []), a, b] };
    const zs = buildActivityZones({ region: region2, toXY: game.geo.P.toXY, toLngLat: game.geo.P.toLngLat, owned: game.state.territory.owned, season: 'autumn' });
    const m = distributeTours(zs);
    const arriving = (id: string) => {
      const z = zs.list.findIndex((x) => x.id === `p:${id}`);
      let n = 0;
      for (let e = 0; e < m.tours.length; e++) if (m.k[e] === KIND.university && m.d[e] === z && m.o[e] !== z) n += m.tours[e];
      return n;
    };
    expect(arriving(b.id)).toBeGreaterThan(0);
    expect(arriving(a.id)).toBeLessThan(0.7 * arriving(b.id));
  });
});

/** People of a traveller type seen waiting or on board, by the hour their journey started (each group once). */
function travellersByHour(game: Game, type: number, hours: number): number[] {
  const seen = new Set<PaxGroup>();
  const out = new Array<number>(24).fill(0);
  for (let m = 0; m < hours * 60; m++) {
    game.run(60);
    for (const list of [...Object.values(game.state.pax.waiting), ...Object.values(game.state.pax.onboard)])
      for (const g of list)
        if (g.k === type && !seen.has(g)) {
          seen.add(g);
          out[Math.floor((g.t0 % DAY) / HOUR)] += g.n;
        }
  }
  return out;
}

describe('school days and holidays in the simulation', () => {
  it('pupils travel at school times on a school day, and hardly at all in the holidays', { timeout: 120_000 }, () => {
    // day 1 is a Tuesday in week 1 (term); the same day in week 5 is a school holiday
    const make = (weeksAhead: number) => {
      const { game } = referenceLine(8, 4);
      game.state.world.calendar.epochDay -= weeksAhead * 7;
      game.run(DAY - game.t);
      return game;
    };
    const term = make(0);
    expect(term.dayTypeAt().school).toBe(true);
    const pupils = travellersByHour(term, TYPE.pupil, 24);
    const all = pupils.reduce((a, b) => a + b, 0);
    // 07:00–08:30 and 15:00–16:30 (hours 7 and 15, and half of 8 and 16)
    const inWindows = pupils[7] + pupils[8] / 2 + pupils[15] + pupils[16] / 2;
    expect(all).toBeGreaterThan(20);
    expect(inWindows / all).toBeGreaterThanOrEqual(0.6);

    const holiday = make(4);
    expect(holiday.dayTypeAt()).toMatchObject({ school: false, schoolHolidays: true });
    const off = travellersByHour(holiday, TYPE.pupil, 24).reduce((a, b) => a + b, 0);
    expect(off).toBeLessThanOrEqual(0.05 * all);
  });
});

describe('space on board and boarding time by traveller type', () => {
  it('a bus takes fewer air travellers than commuters, and they take longer to board', () => {
    const board = (type: number) => {
      const game = newGame({ seed: 3, extraFunds: 1_000_000 });
      const line = buildLine(game, { stops: 4, buses: 1, model: 'city12' });
      const p = game.pattern(line.route, 0)!;
      const v = game.state.vehicles[line.buses[0]];
      v.load = 0;
      v.sp = 0;
      game.state.pax.onboard[v.id] = [];
      const t = game.t;
      const g: PaxGroup = { n: 200, o: p.stops[0], d: p.stops[2], legs: [{ r: line.route, p: p.index, a: p.stops[2] }], leg: 0, t0: t, tl: t, w: 0, r: 0, cr: 0, dl: 0, fr: null, k: type, pu: type === TYPE.air ? KIND.fly : KIND.work };
      game.state.pax.waiting[p.stops[0]] = [g];
      const ev = serveStop(game, v, p, 0);
      return { ev, v, cap: MODEL[v.model].capacity };
    };
    const air = board(TYPE.air), com = board(TYPE.commuter);
    expect(com.ev.board).toBe(com.cap);
    expect(air.ev.board).toBe(Math.floor(air.cap / 1.6));
    expect(occupied(air.v)).toBeLessThanOrEqual(air.cap);
    expect(occupied(air.v)).toBeGreaterThan(air.cap - 1.6);
    // the same number of people boarding: luggage makes the stop longer
    const n = 30;
    expect(dwellTime(air.v, n, 0, n * 2)).toBeGreaterThan(dwellTime(com.v, n, 0, 0));
  });
});

describe('existing transit as a choice', () => {
  it('runs from 06:00 to midnight, with longer waits off-peak', () => {
    expect(transitWaitFactor(3)).toBe(0);
    expect(transitWaitFactor(8)).toBe(1);
    expect(transitWaitFactor(13)).toBeGreaterThan(1);
    expect(transitWaitFactor(23)).toBeGreaterThan(0);
  });

  it('carries a share of the city’s trips, mostly instead of taxis and cars; without it those trips go back to them', { timeout: 120_000 }, () => {
    const withNet = referenceLine(8, 4).game;
    withNet.run(8 * HOUR - withNet.t);
    const a = estimatedDemand(withNet, { level: 'zone' });
    const modes = (e: typeof a) => {
      const m = [0, 0, 0, 0, 0, 0];
      for (const f of e.flows) f.modes.forEach((v, i) => (m[i] += v));
      return m;
    };
    const ma = modes(a);
    const tripsA = ma.reduce((x, y) => x + y, 0);
    expect(ma[5] / tripsA).toBeGreaterThan(0.05);

    const r = region();
    expect(r.transit?.links.length).toBeGreaterThan(20);
    const bare = new Game(structuredClone(withNet.state), { ...r, transit: undefined });
    const b = estimatedDemand(bare, { level: 'zone' });
    const mb = modes(b);
    const tripsB = mb.reduce((x, y) => x + y, 0);
    expect(mb[5]).toBe(0);
    // taxi and car shares fall when transit is there
    expect(ma[3] / tripsA).toBeLessThan(mb[3] / tripsB);
    expect(ma[2] / tripsA).toBeLessThan(mb[2] / tripsB);
  });
});
