// Blocks for building your own strategies: Schedule extra departure (and the engine's scheduled
// extras), Compare with a normal day, Passenger journeys, Group by, Join lists and dotted field
// names, and the starter workflows built on them.
import { describe, expect, it } from 'vitest';
import { Game } from '../engine.ts';
import { buildLine, crowdedLine, newGame, region } from './helpers.ts';
import { DAY, HOUR, MODEL } from '../content.ts';
import { checkCommand, runCommand } from '../commands.ts';
import { defaultConfig } from '../automation/registry.ts';
import { validateWorkflow } from '../automation/validate.ts';
import { fromTemplate, TEMPLATES } from '../automation/templates.ts';
import { compareBaseline, baselineText } from '../automation/baseline.ts';
import { TripState, type Timetable } from '../types.ts';
import type { DayRecord, RouteDay, StopDay } from '../analytics/types.ts';
import type { Value, WfEdge, WfNode, Workflow } from '../automation/types.ts';

function graph(game: Game) {
  const nodes: WfNode[] = [];
  const edges: WfEdge[] = [];
  const node = (type: string, config: Record<string, Value> = {}) => {
    const n: WfNode = { id: game.newNodeId(), type, x: nodes.length * 240, y: 0, config: { ...defaultConfig(type), ...config } };
    nodes.push(n);
    return n.id;
  };
  const link = (from: string, out: string, to: string, inp: string) => edges.push({ id: `e${edges.length}`, from, out, to, in: inp });
  return { nodes, edges, node, link };
}

function make(game: Game, g: ReturnType<typeof graph>, patch: Partial<Pick<Workflow, 'mode' | 'enabled'>> = {}, name = 'programming test') {
  const r = game.createWorkflow({ name, nodes: g.nodes, edges: g.edges, kind: 'workflow' });
  if (!r.ok) throw new Error(r.error);
  const wf = game.state.automation.workflows[r.value];
  expect(validateWorkflow(wf, game.state).issues.filter((i) => i.level === 'error').map((i) => i.message)).toEqual([]);
  const u = game.updateWorkflow(r.value, { enabled: true, mode: 'automatic', ...patch });
  if (!u.ok) throw new Error(u.error);
  return wf;
}

const runsOf = (game: Game, wf: string) => game.state.automation.runs.filter((r) => r.wf === wf && !r.test);
const runTo = (game: Game, d: number, h: number, m = 0) => game.run(d * DAY + h * HOUR + m * 60 - game.t);
const runNow = (game: Game, wf: Workflow) => {
  const r = game.runWorkflowNow(wf.id, { test: false });
  if (!r.ok) throw new Error(r.error);
  return runsOf(game, wf.id).at(-1)!;
};
/** The value a node passed on in the last run, by output port. */
const outOf = (game: Game, wf: Workflow, nodeId: string, port: string) => runsOf(game, wf.id).at(-1)!.trace?.find((x) => x.node === nodeId)?.outputs?.[port];
const noteOf = (game: Game, wf: Workflow, nodeId: string) => runsOf(game, wf.id).at(-1)!.trace?.find((x) => x.node === nodeId)?.note ?? '';
const sum = (a: number[] | undefined) => (a ?? []).reduce((x, y) => x + y, 0);
const missed = (game: Game, route: string) => sum(game.state.analytics.today.routes[route]?.m);
const flat = (headway: number): Timetable => ({ weekday: { bands: [{ from: 300, to: 1380, headway }] }, weekend: { bands: [{ from: 300, to: 1380, headway }] }, layover: 4 });

describe('scheduled extra departures', () => {
  it('runs at the set time with the bus asked for, keeps through a timetable change and a save, and goes back to the depot', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 2, stops: 6, headway: 20 });
    const spare = game.buyVehicle('city12', l.depot);
    if (!spare.ok) throw new Error(spare.error);
    runTo(game, 0, 6);
    const at = 6 * HOUR + 40 * 60;
    const check = checkCommand(game, { type: 'schedule_extra', route: l.route, at, vehicle: spare.value });
    expect(check.ok).toBe(true);
    // 06:40 is also a timetable departure, so the extra leaves a minute later
    expect(check.transition).toMatch(/at 06:41 \(06:40 is already a departure\)/);
    expect(check.cost).toBeGreaterThan(0);
    const r = runCommand(game, { type: 'schedule_extra', route: l.route, at, vehicle: spare.value }, 'player');
    expect(r.ok).toBe(true);
    expect(game.scheduledExtras(l.route).map((x) => [x.dep, x.ask])).toEqual([[at + 60, at]]);
    // asking again for the same time changes nothing
    expect(checkCommand(game, { type: 'schedule_extra', route: l.route, at }).noop).toBe(true);
    // a timetable change rebuilds the timetable's trips but keeps the extra
    expect(game.setTimetable(l.route, flat(30)).ok).toBe(true);
    expect(game.requirement(l.route)!.peak).toBeLessThanOrEqual(2);
    expect(game.scheduledExtras(l.route)).toHaveLength(1);
    // saved and loaded
    const copy = new Game(JSON.parse(game.serialize()), region());
    expect(copy.scheduledExtras(l.route)[0]).toMatchObject({ dep: at + 60, ask: at, want: spare.value, extra: 'player' });

    const before = missed(game, l.route);
    runTo(game, 0, 6, 38);
    const trip = game.state.trips[l.route].find((x) => x.extra && x.ask === at)!;
    expect(trip.state).toBe(TripState.Assigned);
    expect(trip.veh).toBe(spare.value);
    runTo(game, 0, 6, 42);
    expect(trip.state).toBe(TripState.Running);
    runTo(game, 0, 8);
    expect([TripState.Done, TripState.Running]).toContain(trip.state);
    expect(missed(game, l.route)).toBe(before);
    expect(game.state.vehicles[spare.value].route).toBeNull();
  });

  it('only uses a free bus: with none, it is dropped and you are told, and it is not a missed departure', () => {
    const game = newGame();
    // two buses every 8 minutes: both are always busy with the timetable
    const l = buildLine(game, { buses: 2, stops: 6, headway: 8 });
    runTo(game, 0, 6);
    const missedTimetable = () => game.state.trips[l.route].filter((x) => !x.extra && x.state === TripState.Missed).length;
    const base = missedTimetable();
    const at = 6 * HOUR + 30 * 60;
    expect(runCommand(game, { type: 'schedule_extra', route: l.route, at }, 'player').ok).toBe(true);
    const trip = game.state.trips[l.route].find((x) => x.extra)!;
    const recorded = missed(game, l.route);
    runTo(game, 0, 7);
    expect(trip.state).toBe(TripState.Missed);
    expect(trip.veh).toBeNull();
    // the dropped extra is not counted as missed
    expect(missed(game, l.route) - recorded).toBe(missedTimetable() - base);
    expect(game.state.notifications.some((n) => /Extra departure at 06:30 on line \d+ dropped/.test(n.title))).toBe(true);
    // and the timetable lost nothing to it: the same game without the extra misses exactly the same
    const twin = newGame();
    const l2 = buildLine(twin, { buses: 2, stops: 6, headway: 8 });
    runTo(twin, 0, 7);
    const timetableMissed = (g: Game, route: string) => g.state.trips[route].filter((x) => !x.extra && x.state === TripState.Missed).map((x) => x.dep);
    expect(timetableMissed(game, l.route)).toEqual(timetableMissed(twin, l2.route));
    expect(missed(game, l.route)).toBe(missed(twin, l2.route));
  });

  it('checks notice and range, and two workflows can schedule different times on one line', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 2, stops: 6, headway: 20 });
    runTo(game, 0, 6);
    expect(checkCommand(game, { type: 'schedule_extra', route: l.route, at: game.t + 5 * 60 }).reason).toMatch(/10 minutes’ notice/);
    expect(checkCommand(game, { type: 'schedule_extra', route: l.route, at: game.t + DAY + HOUR }).reason).toMatch(/24 hours ahead/);
    const wfAt = (time: string, name: string) => {
      const g = graph(game);
      const t = g.node('trigger.manual');
      const x = g.node('action.scheduleExtra', { line: l.route, mode: 'at', time });
      g.link(t, 'event', x, 'when');
      return make(game, g, {}, name);
    };
    const a = wfAt('07:00', 'A'), b = wfAt('07:30', 'B');
    expect(runNow(game, a).actions.map((x) => x.outcome)).toEqual(['executed']);
    expect(runNow(game, b).actions.map((x) => x.outcome)).toEqual(['executed']);
    expect(game.scheduledExtras(l.route).map((x) => x.ask ?? x.dep)).toEqual([7 * HOUR, 7.5 * HOUR]);
    // running A again: already scheduled
    expect(runNow(game, a).actions.map((x) => x.outcome)).toEqual(['duplicate']);
  });

  it('takes a time as text, minutes, or a peak, moved by the shift; a cancelled one is not scheduled again', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 3, stops: 6, headway: 20 });
    // every 30 min, every 10 in a 07:30–09:00 peak: the extras below do not land on a departure
    const tt: Timetable = { weekday: { bands: [{ from: 300, to: 450, headway: 30 }, { from: 450, to: 540, headway: 10 }, { from: 540, to: 1380, headway: 30 }] }, weekend: { bands: [{ from: 300, to: 1380, headway: 30 }] }, layover: 4 };
    expect(game.setTimetable(l.route, tt).ok).toBe(true);
    runTo(game, 0, 6);
    const g = graph(game);
    const t = g.node('trigger.manual');
    const at = g.node('math.expr', { expr: 'a' });
    const x = g.node('action.scheduleExtra', { line: l.route, shift: -7 });
    g.link(t, 'event', x, 'when');
    g.link(at, 'value', x, 'at');
    const wf = make(game, g);
    const setAt = (expr: string) => { wf.nodes.find((n) => n.id === at)!.config.expr = expr; };
    setAt("'08:00'");
    runNow(game, wf);
    setAt('45');
    runNow(game, wf);
    // a peak: its start
    const gp = graph(game);
    const tp = gp.node('trigger.manual');
    const peaks = gp.node('data.peaks', { source: 'timetable' });
    const xp = gp.node('action.scheduleExtra', { line: l.route, shift: -3 });
    gp.link(tp, 'event', peaks, 'after');
    gp.link(peaks, 'busiest', xp, 'at');
    const wfp = make(game, gp, {}, 'peak');
    expect(runNow(game, wfp).actions.at(-1)?.outcome).toBe('executed');
    const deps = () => game.scheduledExtras(l.route).map((x) => x.ask ?? x.dep).sort((a, b) => a - b);
    expect(deps()).toEqual([6 * HOUR + 38 * 60, 7 * HOUR + 27 * 60, 7 * HOUR + 53 * 60]);
    // a time already past today means tomorrow
    setAt("'05:00'");
    runNow(game, wf);
    expect(deps().at(-1)).toBe(DAY + 4 * HOUR + 53 * 60);
    // not a time
    setAt("'soon'");
    expect(runNow(game, wf).error).toMatch(/not a time like 17:30/);
    // the player cancels 07:53: the workflow does not put it back
    const trip = game.scheduledExtras(l.route).find((x) => (x.ask ?? x.dep) === 7 * HOUR + 53 * 60)!;
    expect(game.cancelExtra(l.route, trip.id).ok).toBe(true);
    setAt("'08:00'");
    const again = runNow(game, wf).actions.at(-1)!;
    expect(again.outcome).toBe('conflict');
    expect(again.reason).toMatch(/by hand.*cancelled it/);
  });
});

/** A recorded day with `b` boardings at hour 17 on one line and stop. */
function fakeDay(day: number, route: string, stop: string, b: number): DayRecord {
  const hrs = () => new Array(24).fill(0);
  const rd = { b: hrs(), d: hrs(), o: hrs(), m: hrs(), dp: hrs(), lf: hrs(), dl: hrs(), pk: hrs(), ck: hrs(), rv: hrs(), vm: hrs(), lb: 0, cr: 0, g: 0, ws: 0, wn: 0, ss: 0, sn: 0, x: 0 } as unknown as RouteDay;
  const sd = { b: hrs(), a: hrs(), g: hrs(), w: hrs(), ws: 0, wn: 0, wx: 0, x: 0, lb: 0, rv: 0, bl: {} } as StopDay;
  rd.b[17] = b;
  rd.dp[17] = 10;
  rd.lf[17] = b / 20;
  sd.b[17] = b;
  return { day, net: { j: hrs(), ab: hrs(), ss: 0, sn: 0, comp: [0, 0, 0, 0, 0], jt: 0, wt: 0, xf: 0 }, stops: { [stop]: sd }, routes: { [route]: rd }, veh: {}, od: {} };
}

describe('compare with a normal day', () => {
  it('compares the last hour with the same hour on the same weekday, the same kind of day, or last week', () => {
    // day 14 is a Monday (day 0 is a Monday); 18:05, so the last full hour is 17:00–18:00
    const today = fakeDay(14, 'r1', 's1', 150);
    const days = [fakeDay(0, 'r1', 's1', 80), fakeDay(7, 'r1', 's1', 120), fakeDay(12, 'r1', 's1', 400), fakeDay(13, 'r1', 's1', 300), fakeDay(11, 'r1', 's1', 90)];
    const game = { t: 14 * DAY + 18 * HOUR + 5 * 60, state: { clock: { startWeekday: 0 }, analytics: { today, days } }, money: (v: number) => `£${v}` } as unknown as Game;
    const mon = compareBaseline(game, 'stop.boardings', 's1', 'hour', 'weekday');
    expect(mon).toMatchObject({ value: 150, normal: 100, change: 50, days: 2, hours: '17:00–18:00', against: 'Monday' });
    expect(baselineText(game, 'stop.boardings', 'Taksim', mon)).toBe('Taksim: 150 boardings 17:00–18:00, 50% more than a normal Monday (100 boardings on average over 2 days)');
    // weekdays only: Saturday 12 and Sunday 13 are left out
    expect(compareBaseline(game, 'stop.boardings', 's1', 'hour', 'kind')).toMatchObject({ normal: 96.7, days: 3 });
    // every day of the last week (days 7 to 13)
    expect(compareBaseline(game, 'stop.boardings', 's1', 'hour', 'week')).toMatchObject({ normal: 227.5, days: 4 });
    // a ratio: how full the buses were (load factor sum ÷ departures)
    expect(compareBaseline(game, 'line.load', 'r1', 'hour', 'weekday')).toMatchObject({ value: 75, normal: 50, change: 50 });
    // nothing recorded to compare with yet
    const fresh = { ...game, state: { ...game.state, analytics: { today, days: [] } } } as unknown as Game;
    const none = compareBaseline(fresh, 'stop.boardings', 's1', 'hour', 'weekday');
    expect(none).toMatchObject({ value: 150, normal: null, change: null });
    expect(none.why).toMatch(/No Monday recorded yet/);
  });

  it('as a block: every line or stop, most unusual first, standing for the line', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 2, stops: 6, headway: 20 });
    runTo(game, 0, 9, 5);
    const g = graph(game);
    const t = g.node('trigger.manual');
    const b = g.node('data.baseline', { measure: 'line.boardings', window: '3h', compare: 'kind' });
    g.link(t, 'event', b, 'after');
    const wf = make(game, g);
    runNow(game, wf);
    const results = outOf(game, wf, b, 'results') as Record<string, Value>[];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'line', id: l.route, normal: null, change: null, hours: '06:00–09:00' });
    expect(results[0].now).toBeGreaterThan(0);
    expect(noteOf(game, wf, b)).toMatch(/No weekday recorded yet to compare with/);
    // a stop figure with a line connected is a mistake the block explains
    const g2 = graph(game);
    const t2 = g2.node('trigger.manual');
    const ln = g2.node('data.line', { line: l.route });
    const b2 = g2.node('data.baseline', { measure: 'stop.waiting' });
    g2.link(t2, 'event', ln, 'after');
    g2.link(ln, 'line', b2, 'item');
    const wf2 = make(game, g2, {}, 'wrong');
    const run = runNow(game, wf2);
    expect(run.error ?? '').toMatch(/for stops: connect a stop/);
  });
});

describe('passenger journeys', () => {
  it('lists recorded journeys between areas and stops, a day on average, narrowed to a stop', () => {
    const game = newGame({ seed: 21 });
    crowdedLine(game);
    runTo(game, 0, 10);
    const g = graph(game);
    const t = g.node('trigger.manual');
    const zones = g.node('data.journeys', { level: 'zone', days: '0', dayType: 'all' });
    const stops = g.node('data.journeys', { level: 'stop', days: '0', dayType: 'all', limit: 3 });
    g.link(t, 'event', zones, 'after');
    g.link(t, 'event', stops, 'after');
    const wf = make(game, g);
    runNow(game, wf);
    const flows = outOf(game, wf, stops, 'flows') as Record<string, Value>[];
    expect(flows.length).toBeGreaterThan(0);
    expect(flows.length).toBeLessThanOrEqual(3);
    const f = flows[0];
    expect(f).toMatchObject({ kind: 'flow' });
    expect(f.label).toBe(`${f.from} → ${f.to}`);
    expect(f.within).toBe(false);
    expect(f.journeys).toBeGreaterThan(0);
    expect(Array.isArray(f.lines) && (f.lines as Value[]).length).toBeGreaterThan(0);
    // busiest first; the total is every matching journey, not only the ones listed
    const all = (outOf(game, wf, zones, 'flows') as Record<string, Value>[]).map((x) => Number(x.journeys));
    expect([...all].sort((a, b) => b - a)).toEqual(all);
    expect(Number(outOf(game, wf, stops, 'total'))).toBeGreaterThanOrEqual(flows.reduce((a, x) => a + Number(x.journeys), 0) - 0.5);
    expect(noteOf(game, wf, zones)).toMatch(/^Today so far: about [\d,.]+ journeys a day, by area/);
    // between areas, a trip inside one area is labelled as such
    for (const z of outOf(game, wf, zones, 'flows') as Record<string, Value>[]) expect(z.label).toBe(z.within ? `Within ${z.from}` : `${z.from} → ${z.to}`);
    // from one stop: only journeys starting there
    const origins = outOf(game, wf, stops, 'origins') as Record<string, Value>[];
    expect(origins[0]).toMatchObject({ kind: 'stop' });
    const g2 = graph(game);
    const t2 = g2.node('trigger.manual');
    const from = g2.node('data.journeys', { level: 'stop', days: '0', dayType: 'all', from: String(origins[0].id) });
    g2.link(t2, 'event', from, 'after');
    const wf2 = make(game, g2, {}, 'from one stop');
    runNow(game, wf2);
    const mine = outOf(game, wf2, from, 'flows') as Record<string, Value>[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.fromId === origins[0].id)).toBe(true);
  });
});

describe('group by and join lists', () => {
  it('groups buses by line, standing for the line, and joins two lists on a field (with dotted names)', () => {
    const game = newGame({ extraFunds: 5_000_000 });
    const a = buildLine(game, { buses: 3, stops: 5, headway: 20 });
    const b = buildLine(game, { buses: 1, stops: 5, headway: 30, from: [28.99, 41.045] });
    const spare = game.buyVehicle('city12', a.depot);
    if (!spare.ok) throw new Error(spare.error);
    runTo(game, 0, 6);
    const g = graph(game);
    const t = g.node('trigger.manual');
    const buses = g.node('data.buses');
    const grp = g.node('logic.groupBy', { field: 'line', op: 'avg', of: 'capacity' });
    const lines = g.node('data.lines');
    const join = g.node('logic.join', { fieldA: 'key', fieldB: 'id', as: 'info', keep: 'all' });
    const sort = g.node('logic.sort', { field: 'info.buses', order: 'desc' });
    const pick = g.node('logic.pick', { field: 'info.buses', order: 'asc' });
    const field = g.node('math.field', { field: 'info.number' });
    g.link(t, 'event', buses, 'after');
    g.link(t, 'event', lines, 'after');
    g.link(buses, 'buses', grp, 'list');
    g.link(grp, 'groups', join, 'a');
    g.link(lines, 'lines', join, 'b');
    g.link(join, 'list', sort, 'list');
    g.link(join, 'list', pick, 'list');
    g.link(pick, 'item', field, 'record');
    const wf = make(game, g);
    runNow(game, wf);
    const groups = outOf(game, wf, grp, 'groups') as Record<string, Value>[];
    expect(groups.map((x) => [x.name, x.count])).toEqual([['Line ' + game.state.routes[a.route].number, 3], ['Line ' + game.state.routes[b.route].number, 1], ['None', 1]].sort((x, y) => Number(y[1]) - Number(x[1])));
    expect(groups[0]).toMatchObject({ kind: 'group', line: a.route, value: MODEL.city12.capacity });
    // the spare bus has no line: its group has no match but is kept (keep: all)
    const joined = outOf(game, wf, join, 'list') as Record<string, Value>[];
    expect(joined).toHaveLength(3);
    expect(joined.find((x) => x.name === 'None')!.info).toBeNull();
    expect(noteOf(game, wf, join)).toMatch(/2 of 3 matched on key = id\. 1 without a match kept/);
    expect((outOf(game, wf, sort, 'list') as Record<string, Value>[])[0].line).toBe(a.route);
    expect(outOf(game, wf, field, 'value')).toBe(game.state.routes[b.route].number);
  });
});

describe('starter workflows', () => {
  it('a test run of the busy-hour workflow uses a labelled example when no line has peak hours', () => {
    const game = newGame();
    buildLine(game, { buses: 2, stops: 6, headway: 20 });
    runTo(game, 0, 9, 10);
    const r = fromTemplate(game, 'peak-extra');
    if (!r.ok) throw new Error(r.error);
    const run = game.runWorkflowNow(r.value, { test: true });
    if (!run.ok) throw new Error(run.error);
    expect(run.value.status).toBe('ok');
    expect(run.value.trace?.[0].note).toMatch(/^No line has peak hours today, so this test uses an example\. Line \S+’s peak 11:00–13:00 is coming/);
    // a test changes nothing: the action says what it would have done
    expect(run.value.actions.map((a) => [a.outcome, a.summary])).toEqual([['observed', expect.stringMatching(/^Extra departure at 11:0\d on line /)]]);
    expect(game.scheduledExtras(Object.keys(game.state.routes)[0])).toHaveLength(0);
  });


  it('build without errors, and the predictive one schedules an extra on a line its forecast says will be too full', () => {
    const ids = ['peak-extra', 'unusual-stops', 'unusual-line-extra', 'forecast-extra', 'journeys-report', 'free-by-depot'];
    expect(ids.every((id) => TEMPLATES.some((t) => t.id === id))).toBe(true);
    const game = newGame({ seed: 21 });
    const l = crowdedLine(game);
    runTo(game, 0, 5, 30);
    for (const id of ids) {
      const r = fromTemplate(game, id);
      if (!r.ok) throw new Error(r.error);
      const wf = game.state.automation.workflows[r.value];
      expect(validateWorkflow(wf, game.state).issues.filter((i) => i.level === 'error').map((i) => `${id}: ${i.message}`)).toEqual([]);
    }
    const wf = Object.values(game.state.automation.workflows).find((w) => w.name === 'Predictive extra departures')!;
    expect(game.updateWorkflow(wf.id, { enabled: true, mode: 'automatic' }).ok).toBe(true);
    const run = runNow(game, wf);
    const full = wf.nodes.find((n) => n.type === 'math.map')!;
    const rows = outOf(game, wf, full.id, 'list') as Record<string, Value>[];
    const mine = rows.find((x) => x.id === l.route)!;
    expect(mine.now).toMatchObject({ kind: 'line', id: l.route });
    // the formula on the card, worked by hand
    const per = Number(mine.busiestPerDeparture), cap = Number((mine.now as Record<string, Value>).capacity);
    expect(mine.value).toBe(Math.round((per / cap) * 100));
    const act = run.actions.at(-1);
    if (Number(mine.value) >= 90) {
      expect(act).toMatchObject({ outcome: 'executed', cmd: { type: 'schedule_extra', route: l.route } });
      const at = (act!.cmd as { at: number }).at;
      expect(at - game.t).toBe(Math.max(15, Number(mine.busiestIn) + 10) * 60);
    } else expect(act).toBeUndefined();
  });
});
