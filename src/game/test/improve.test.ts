// Improve service: the plan uses the player's own tools, fits timetables to the buses, and its
// test plays copies of the company without touching the real one.
import { describe, expect, it } from 'vitest';
import { newGame, buildLine, crowdedLine } from './helpers.ts';
import { applyPlan, diagnose, planService, testPlan } from '../optimise.ts';
import { flatTimetable } from '../timetable.ts';
import { DAY } from '../content.ts';

/** A company like the owner's: a busy line on two small buses, a loop with buses it does not use, two spares. */
function company(extraFunds = 1_000_000) {
  const game = newGame({ extraFunds, seed: 21 });
  const busy = crowdedLine(game);
  const loop = buildLine(game, { from: [28.985, 41.03], stops: 7, buses: 3, headway: 20, kind: 'loop', model: 'mini8' });
  const depot = busy.depot;
  const spares = [game.buyVehicle('mini8', depot), game.buyVehicle('mini8', depot)].map((r) => (r.ok ? r.value : ''));
  game.run(DAY + 3 * 3600); // a full day of history, then 08:00
  return { game, busy, loop, spares };
}

describe('improve service', () => {
  it('puts spare and idle buses to work where people wait, using only the player’s tools', () => {
    const { game, busy, loop, spares } = company();
    const d = diagnose(game);
    expect(d.lines.map((l) => l.route).sort()).toEqual([busy.route, loop.route].sort());
    const plan = planService(game);
    const steps = plan.steps;
    expect(steps.length).toBeGreaterThan(0);
    // the busy line gets both spares, and a bus the loop does not need
    const more = steps.find((s) => s.id === `buses:${busy.route}`);
    expect(more, JSON.stringify(steps.map((s) => s.title))).toBeTruthy();
    const moves = more!.changes.flatMap((c) => (c.kind === 'move' ? [c] : []));
    expect(spares.every((v) => moves.some((m) => m.vehicle === v && m.from === null))).toBe(true);
    expect(moves.filter((m) => m.from === loop.route)).toHaveLength(1);
    // ...and a timetable that uses them: more often than every 20 min somewhere
    const tt = more!.changes.find((c) => c.kind === 'timetable');
    expect(tt && tt.kind === 'timetable' && tt.after.weekday.bands.some((b) => b.headway < 20)).toBe(true);
    // the loop gives up only a bus it does not use: no part of its day runs less often
    const loopTt = steps.flatMap((s) => s.changes).find((c) => c.kind === 'timetable' && c.route === loop.route);
    if (loopTt && loopTt.kind === 'timetable') {
      for (const k of ['weekday', 'weekend'] as const) loopTt.after[k].bands.forEach((b, i) => expect(b.headway).toBeLessThanOrEqual(loopTt.before[k].bands[i].headway));
    }
    // no headway shorter than four minutes, and every timetable is one the line's buses can keep
    for (const s of steps) for (const c of s.changes) if (c.kind === 'timetable') {
      for (const b of [...c.after.weekday.bands, ...c.after.weekend.bands]) expect(b.headway).toBeGreaterThanOrEqual(4);
    }
    // planning changes nothing
    expect(game.state.routes[busy.route].vehicles).toHaveLength(2);
  });

  it('applies the plan, keeps the books clean, and undoes it', () => {
    const { game, busy, loop } = company();
    const plan = planService(game);
    const before = { busy: structuredClone(game.state.routes[busy.route].timetable), loop: structuredClone(game.state.routes[loop.route].timetable) };
    const on = plan.steps.filter((s) => s.on).map((s) => s.id);
    const res = applyPlan(game, plan, on);
    expect(res.problems).toEqual([]);
    expect(res.done.length).toBeGreaterThan(0);
    expect(game.state.routes[busy.route].vehicles.length).toBeGreaterThan(2);
    // every line can keep its timetable once the buses moving over have finished their trips
    const coming = (r: string) => Object.values(game.state.vehicles).filter((v) => v.handover?.route === r).length;
    const leaving = (r: string) => game.state.routes[r].vehicles.filter((id) => game.state.vehicles[id].handover).length;
    for (const r of [busy.route, loop.route]) expect(game.requirement(r)!.peak).toBeLessThanOrEqual(game.state.routes[r].vehicles.length + coming(r) - leaving(r));
    game.run(6 * 3600);
    expect(game.audit()).toEqual([]);
    // a second go at the same plan is refused: the company has changed
    const again = applyPlan(game, plan, on);
    expect(again.done).toEqual([]);
    expect(again.problems.length).toBeGreaterThan(0);
    expect(res.undo()).toEqual([]);
    expect(game.state.routes[busy.route].timetable.weekday).toEqual(before.busy.weekday);
    expect(game.state.routes[loop.route].timetable.weekday).toEqual(before.loop.weekday);
  });

  it('fits a timetable its buses cannot keep, instead of missing departures', () => {
    const game = newGame({ extraFunds: 200_000 });
    const { route } = buildLine(game, { stops: 8, buses: 1, headway: 20 });
    game.setTimetable(route, flatTimetable(5));
    game.run(DAY + 3 * 3600);
    const need = game.requirement(route)!.peak;
    expect(need).toBeGreaterThan(1);
    const plan = planService(game);
    const step = plan.steps.find((s) => s.lines.includes(route));
    expect(step, JSON.stringify(plan.steps.map((s) => s.title))).toBeTruthy();
    applyPlan(game, plan, [step!.id]);
    expect(game.requirement(route)!.peak).toBeLessThanOrEqual(game.state.routes[route].vehicles.length);
  });

  it('buys buses only with money to spare', () => {
    const rich = newGame({ extraFunds: 2_000_000, seed: 21 });
    crowdedLine(rich);
    rich.run(DAY + 3 * 3600);
    const p1 = planService(rich);
    const buys = p1.steps.flatMap((s) => s.changes).filter((c) => c.kind === 'buy');
    expect(buys.length, JSON.stringify(p1.steps.map((s) => s.title))).toBeGreaterThan(0);
    const cost = p1.steps.reduce((p, s) => p + s.cost, 0);
    expect(rich.state.finance.balance - cost).toBeGreaterThanOrEqual(60_000);

    const poor = newGame({ seed: 21 });
    crowdedLine(poor);
    poor.run(DAY + 3 * 3600);
    poor.state.finance.balance = 70_000; // a bus would leave less than the reserve
    const p2 = planService(poor);
    expect(p2.steps.flatMap((s) => s.changes).filter((c) => c.kind === 'buy')).toEqual([]);
  });

  it('tests the plan on copies: shorter waits, the real company untouched', async () => {
    const { game, busy } = company();
    const plan = planService(game);
    const json = JSON.stringify(game.state);
    const ids = plan.steps.filter((s) => s.on).map((s) => s.id);
    const res = (await testPlan(game, plan, ids, 24))!;
    expect(JSON.stringify(game.state)).toBe(json);
    expect(res.problems).toEqual([]);
    const a = res.baseline, b = res.variant;
    console.log('IMPROVE', JSON.stringify({ wait: [a.avgWait, b.avgWait], sat: [a.satisfaction, b.satisfaction], waitScore: [a.waitScore, b.waitScore], journey: [a.journeyScore, b.journeyScore], journeys: [a.journeys, b.journeys], abandoned: [a.abandoned, b.abandoned], operating: [a.operating, b.operating], lines: res.lines }));
    expect(b.avgWait!).toBeLessThan(a.avgWait!);
    expect(b.waitScore!).toBeGreaterThan(a.waitScore!);
    expect(b.satisfaction!).toBeGreaterThanOrEqual(a.satisfaction! - 1);
    const line = res.lines.find((l) => l.route === busy.route)!;
    expect(line.after.wait!).toBeLessThan(line.before.wait!);
  });
});
