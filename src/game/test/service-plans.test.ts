// City Activity Engine phase 5: service plans (plan section 9.1). One function decides the
// day's plan for a line, and trips, headways and fleet needs all follow it.
import { describe, expect, it } from 'vitest';
import { referenceLine } from './calibration.ts';
import { expectReloadContinuity } from './determinism.ts';
import { DAY, HOUR } from '../content.ts';
import { TripState, type ServicePlan } from '../types.ts';
import type { Game } from '../engine.ts';
import { serviceDayOf } from '../time.ts';

const flat = (headway: number) => ({ bands: [{ from: 360, to: 1380, headway }] });
const plan = (id: string, when: ServicePlan['when'], headway = 30, enabled = true): ServicePlan => ({ id, name: id, enabled, when, weekday: flat(headway), weekend: flat(headway) });

/** First day of the 12-week year matching `ok`. */
function findDay(_game: Game, ok: (d: number) => boolean): number {
  for (let d = 0; d < 84; d++) if (ok(d)) return d;
  throw new Error('no such day');
}
const holidayDay = (g: Game) => findDay(g, (d) => g.dayTypeAt(d * DAY + DAY / 2).schoolHolidays);
const termDay = (g: Game) => findDay(g, (d) => g.dayTypeAt(d * DAY + DAY / 2).school);
const setup = () => referenceLine(4, 3);
const noon = (d: number) => d * DAY + 12 * HOUR;
const plannedOn = (g: Game, route: string, sd: number) =>
  (g.state.trips[route] ?? []).filter((x) => serviceDayOf(x.dep) === sd).map((x) => x.dep);

describe('service plans', () => {
  it('a school-holiday plan applies only in school-holiday weeks', () => {
    const { game, route } = setup();
    expect(game.setServicePlans(route, [plan('hol', { kind: 'school_holidays' })]).ok).toBe(true);
    for (let d = 0; d < 84; d++) {
      const dt = game.dayTypeAt(d * DAY + DAY / 2);
      expect(game.dayPlan(route, d).planId, `day ${d}`).toBe(dt.schoolHolidays ? 'hol' : null);
    }
    expect(game.dayPlan(route, holidayDay(game))).toMatchObject({ name: 'hol', weekend: false });
  });

  it('trips, headwayAt and requirement follow the plan', () => {
    const { game, route } = setup();
    const hol = holidayDay(game), term = termDay(game);
    const normal = game.headwayAt(route, 0, noon(term))!;
    game.setServicePlans(route, [plan('hol', { kind: 'school_holidays' }, 30)]);
    expect(game.headwayAt(route, 0, noon(hol))).toBe(30);
    expect(game.headwayAt(route, 0, noon(term))).toBe(normal);
    // generate that day's trips with the clock just before it
    game.state.clock.t = hol * DAY + 5 * HOUR;
    game.setServicePlans(route, [plan('hol', { kind: 'school_holidays' }, 30), plan('x', { kind: 'manual', on: false })]);
    const deps = [...new Set(plannedOn(game, route, hol))].sort((a, b) => a - b);
    expect(deps.length).toBeGreaterThan(2);
    expect(deps[1] - deps[0]).toBe(30 * 60);
    expect(game.requirement(route)!.bands[0].band.headway).toBe(30);
  });

  it('a manual plan switches on and off', () => {
    const { game, route } = setup();
    game.setServicePlans(route, [plan('man', { kind: 'manual', on: false }, 40)]);
    const sd = serviceDayOf(game.t);
    expect(game.dayPlan(route, sd).planId).toBeNull();
    expect(game.switchServicePlan(route, 'man', true).ok).toBe(true);
    expect(game.dayPlan(route, sd).planId).toBe('man');
    expect(game.headwayAt(route, 0, noon(sd))).toBe(40);
    expect(game.switchServicePlan(route, 'man', false).ok).toBe(true);
    expect(game.dayPlan(route, sd).planId).toBeNull();
    expect(game.switchServicePlan(route, 'nope', true).ok).toBe(false);
    game.setServicePlans(route, [plan('s', { kind: 'season', season: 'summer' })]);
    expect(game.switchServicePlan(route, 's', true).ok).toBe(false);
  });

  it('the first enabled plan that holds wins, and a disabled plan never applies', () => {
    const { game, route } = setup();
    game.setServicePlans(route, [plan('off', { kind: 'manual', on: true }, 50, false), plan('a', { kind: 'manual', on: true }, 40), plan('b', { kind: 'manual', on: true }, 20)]);
    expect(game.dayPlan(route, 0).planId).toBe('a');
    game.setServicePlans(route, [plan('off', { kind: 'manual', on: true }, 50, false)]);
    expect(game.dayPlan(route, 0).planId).toBeNull();
    expect(game.headwayAt(route, 0, noon(0))).not.toBe(50);
  });

  it('rejects bad plans and tidies bands', () => {
    const { game, route } = setup();
    const bad = plan('a', { kind: 'manual', on: true });
    bad.weekday = { bands: [{ from: NaN, to: 600, headway: 10 }] };
    expect(game.setServicePlans(route, [bad]).ok).toBe(false);
    expect(game.setServicePlans(route, [plan('a', { kind: 'manual', on: true }), plan('a', { kind: 'manual', on: true })]).ok).toBe(false);
    expect(game.setServicePlans(route, Array.from({ length: 9 }, (_, i) => plan(`p${i}`, { kind: 'manual', on: false }))).ok).toBe(false);
    expect(game.setServicePlans(route, Array.from({ length: 8 }, (_, i) => plan(`p${i}`, { kind: 'manual', on: false }))).ok).toBe(true);
    const messy = plan('m', { kind: 'manual', on: false });
    messy.weekday = { bands: [{ from: 600, to: 700, headway: 1 }, { from: 360, to: 480, headway: 500 }] };
    game.setServicePlans(route, [messy]);
    expect(game.state.routes[route].timetable.plans![0].weekday.bands).toEqual([{ from: 360, to: 480, headway: 120 }, { from: 600, to: 700, headway: 2 }]);
  });

  it('a normal timetable change keeps the plans', () => {
    const { game, route } = setup();
    game.setServicePlans(route, [plan('a', { kind: 'manual', on: false })]);
    const tt = game.state.routes[route].timetable;
    game.setTimetable(route, { weekday: tt.weekday, weekend: tt.weekend, layover: 5 });
    expect(game.state.routes[route].timetable.plans).toHaveLength(1);
    game.setServicePlans(route, []);
    expect(game.state.routes[route].timetable.plans).toBeUndefined();
  });

  it('changing plans keeps trips that have already run or started', () => {
    const { game, route } = setup();
    game.run(2 * HOUR);
    const started = (game.state.trips[route] ?? []).filter((x) => x.state !== TripState.Planned).map((x) => x.id);
    expect(started.length).toBeGreaterThan(0);
    game.setServicePlans(route, [plan('man', { kind: 'manual', on: true }, 45)]);
    const ids = new Set((game.state.trips[route] ?? []).map((x) => x.id));
    for (const id of started) expect(ids.has(id)).toBe(true);
    expect((game.state.trips[route] ?? []).some((x) => x.state === TripState.Planned && x.dep > game.t)).toBe(true);
  });

  it('a reloaded game carries on identically mid-day', () => {
    const { game, route } = setup();
    game.setServicePlans(route, [plan('man', { kind: 'manual', on: true }, 25)]);
    game.run(3 * HOUR);
    expectReloadContinuity(game, HOUR);
  });
});
