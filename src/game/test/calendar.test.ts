// City Activity Engine, phase 0: the game calendar (seasons and weeks, never real dates), the
// fixed city seed, save version 3, and the determinism harness later phases build on.
import { describe, expect, it } from 'vitest';
import { calendarDay, calendarFrom, newCalendar, seasonWeekLabel, yearSeasonLabel, YEAR_WEEKS } from '../calendar.ts';
import { upgradeState } from '../upgrade.ts';
import { SAVE_VERSION, type GameState } from '../types.ts';
import { DAY, HOUR } from '../content.ts';
import { buildLine, newGame } from './helpers.ts';
import { expectIdenticalRuns, expectReloadContinuity, reload } from './determinism.ts';

describe('game calendar', () => {
  const cal = newCalendar(0);
  const at = (day: number) => calendarDay(cal, 0, day);

  it('starts in week 1 of autumn and has four seasons of three weeks', () => {
    expect(YEAR_WEEKS).toBe(12);
    expect(at(0)).toMatchObject({ year: 1, week: 1, season: 'autumn', seasonWeek: 1, dayOfYear: 0, weekday: 0 });
    expect(at(20)).toMatchObject({ week: 3, season: 'autumn', seasonWeek: 3, weekday: 6 });
    expect(at(21)).toMatchObject({ week: 4, season: 'winter', seasonWeek: 1, weekday: 0 });
    expect(at(48)).toMatchObject({ week: 7, season: 'spring', seasonWeek: 1 });
    expect(at(83)).toMatchObject({ year: 1, week: 12, season: 'summer', seasonWeek: 3 });
    expect(at(84)).toMatchObject({ year: 2, week: 1, season: 'autumn', seasonWeek: 1 });
    expect(at(84 * 3 + 30).year).toBe(4);
  });

  it('labels seasons and weeks, never dates or months', () => {
    expect(seasonWeekLabel(at(9))).toBe('Autumn, week 2');
    expect(yearSeasonLabel(at(84 + 50))).toBe('Year 2 · Spring');
    const months = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|20\d\d/i;
    for (let d = 0; d < 84; d += 7) expect(seasonWeekLabel(at(d)) + yearSeasonLabel(at(d))).not.toMatch(months);
  });

  it('keeps weeks aligned to Mondays when a company starts mid-week', () => {
    const thu = newCalendar(3);
    expect(calendarDay(thu, 3, 0)).toMatchObject({ week: 1, weekday: 3 });
    expect(calendarDay(thu, 3, 3)).toMatchObject({ week: 1, weekday: 6 });
    expect(calendarDay(thu, 3, 4)).toMatchObject({ week: 2, weekday: 0 });
  });

  it('starts an upgraded save in week 1 of autumn, from the Monday of that week', () => {
    const c = calendarFrom(0, 37); // day 37 is a Wednesday
    expect(calendarDay(c, 0, 37)).toMatchObject({ year: 1, week: 1, season: 'autumn', weekday: 2 });
    expect(calendarDay(c, 0, 35)).toMatchObject({ year: 1, week: 1, dayOfYear: 0 });
    expect(calendarDay(c, 0, 42)).toMatchObject({ week: 2 });
  });

  it('is what the game reports for the current time', () => {
    const game = newGame({ seed: 3 });
    expect(game.calendarAt()).toMatchObject({ year: 1, week: 1, season: 'autumn' });
    expect(game.calendarAt(22 * DAY).season).toBe('winter');
  });
});

describe('city seed and save version 3', () => {
  it('gives new games a fixed city seed from the game seed', () => {
    const a = newGame({ seed: 11 }), b = newGame({ seed: 11 }), c = newGame({ seed: 12 });
    expect(a.state.world.seed).toBe(b.state.world.seed);
    expect(a.state.world.seed).not.toBe(c.state.world.seed);
    expect(a.state.version).toBe(SAVE_VERSION);
    expect(SAVE_VERSION).toBe(3);
  });

  it('never changes the city seed while the shared random stream advances', () => {
    const game = newGame({ seed: 5, extraFunds: 1_000_000 });
    buildLine(game, { stops: 5, buses: 2 });
    game.state.settings.autoService = false;
    for (const v of Object.values(game.state.vehicles)) v.condition = 0.2; // worn buses draw breakdown chances
    const seed = game.state.world.seed, rng = game.state.rng;
    game.run(6 * HOUR);
    expect(game.state.rng).not.toBe(rng);
    expect(game.state.world.seed).toBe(seed);
  });

  it('upgrades a version 2 save with a calendar and a stable seed, idempotently', () => {
    const game = newGame({ seed: 8 });
    game.run(38 * DAY - game.t + 10 * HOUR); // a Thursday morning, day 38
    const v2 = JSON.parse(game.serialize()) as GameState;
    delete (v2 as Partial<GameState>).world;
    v2.version = 2;
    const once = upgradeState(structuredClone(v2));
    const again = upgradeState(structuredClone(v2));
    expect(once.version).toBe(3);
    expect(once.world).toEqual(again.world);
    expect(upgradeState(structuredClone(once)).world).toEqual(once.world);
    expect(calendarDay(once.world.calendar, once.clock.startWeekday, 38)).toMatchObject({ year: 1, week: 1, season: 'autumn', weekday: 3 });
  });
});

describe('determinism harness', () => {
  const make = () => {
    const g = newGame({ seed: 21, extraFunds: 1_000_000 });
    buildLine(g, { stops: 6, buses: 3, headway: 10 });
    return g;
  };

  it('two games built the same way run identically', () => {
    expectIdenticalRuns(make, 5 * HOUR);
  });

  it('a game reloaded mid-day continues identically, calendar and seed included', () => {
    const game = make();
    game.run(9 * HOUR + 17 * 60);
    const copy = expectReloadContinuity(game, 6 * HOUR);
    expect(copy.state.world).toEqual(game.state.world);
    expect(reload(copy).calendarAt()).toEqual(game.calendarAt());
  });
});
