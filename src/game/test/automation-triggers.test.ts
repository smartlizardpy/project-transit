// Trigger timing and the new triggers: "for at least", hours and days, "at most once every",
// Watch a figure, a line short of buses, people left behind, people giving up, the end of the
// week, the live status the editor shows, and the starter workflows built on them.
import { describe, expect, it } from 'vitest';
import { Game } from '../engine.ts';
import { buildLine, crowdedLine, newGame, region } from './helpers.ts';
import { DAY, HOUR } from '../content.ts';
import { defaultConfig, triggerLabel } from '../automation/registry.ts';
import { validateWorkflow } from '../automation/validate.ts';
import { TEMPLATES, TEMPLATE_GROUPS, fromTemplate } from '../automation/templates.ts';
import { busesNeededNow, shortOf, triggerStatus } from '../automation/watch.ts';
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

function make(game: Game, g: ReturnType<typeof graph>, patch: Partial<Pick<Workflow, 'mode' | 'enabled'>> = {}) {
  const r = game.createWorkflow({ name: 'trigger test', nodes: g.nodes, edges: g.edges });
  if (!r.ok) throw new Error(r.error);
  const wf = game.state.automation.workflows[r.value];
  expect(validateWorkflow(wf, game.state).issues.filter((i) => i.level === 'error').map((i) => i.message)).toEqual([]);
  const u = game.updateWorkflow(r.value, { enabled: true, mode: 'automatic', ...patch });
  if (!u.ok) throw new Error(u.error);
  return wf;
}

const runsOf = (game: Game, wf: string) => game.state.automation.runs.filter((r) => r.wf === wf && !r.test);
/** Run the game to `h` o'clock on day `d` (game day 0 starts at 05:00). */
const runTo = (game: Game, d: number, h: number) => game.run(d * DAY + h * HOUR - game.t);
const setBalance = (game: Game, x: number) => { game.state.finance.balance = x; };

/** A workflow that only watches the balance (no actions), for timing tests. */
function balanceWatch(game: Game, config: Record<string, Value>) {
  const g = graph(game);
  const t = g.node('trigger.watch', { figure: 'company.balance', op: 'below', value: 100_000, ...config });
  const r = g.node('action.report', { text: '{event.reading}' });
  g.link(t, 'value', r, 'value');
  return { wf: make(game, g), node: t };
}

describe('for at least', () => {
  it('waits for the condition to hold, ignores a shorter spike, and fires once until it clears', () => {
    const game = newGame();
    buildLine(game, { buses: 2, stops: 6, headway: 15 });
    runTo(game, 0, 9);
    setBalance(game, 500_000);
    const { wf, node } = balanceWatch(game, { for: 10 });
    const n = wf.nodes.find((x) => x.id === node)!;

    // a five-minute dip: nothing
    setBalance(game, 50_000);
    game.run(5 * 60);
    expect(triggerStatus(game, wf, n).state).toBe('building');
    expect(triggerStatus(game, wf, n).text).toMatch(/Building up: [45] of 10 min/);
    setBalance(game, 500_000);
    game.run(15 * 60);
    expect(runsOf(game, wf.id)).toHaveLength(0);
    expect(triggerStatus(game, wf, n).state).toBe('waiting');

    // a lasting dip: fires after ten minutes, once
    setBalance(game, 50_000);
    game.run(9 * 60);
    expect(runsOf(game, wf.id)).toHaveLength(0);
    game.run(2 * 60);
    expect(runsOf(game, wf.id)).toHaveLength(1);
    game.run(30 * 60);
    expect(runsOf(game, wf.id)).toHaveLength(1);
    expect(triggerStatus(game, wf, n).state).toBe('fired');

    // back up only a little (inside the tenth margin): still waits; clearly back: re-arms
    setBalance(game, 105_000);
    game.run(2 * 60);
    setBalance(game, 50_000);
    game.run(15 * 60);
    expect(runsOf(game, wf.id)).toHaveLength(1);
    setBalance(game, 300_000);
    game.run(2 * 60);
    setBalance(game, 50_000);
    game.run(11 * 60);
    expect(runsOf(game, wf.id)).toHaveLength(2);
  });

  it('starts again when the workflow is switched off, and a reload carries on the same', () => {
    const game = newGame();
    buildLine(game, { buses: 2, stops: 6, headway: 15 });
    runTo(game, 0, 9);
    const { wf } = balanceWatch(game, { for: 20 });
    setBalance(game, 50_000);
    game.run(15 * 60);
    game.updateWorkflow(wf.id, { enabled: false });
    game.updateWorkflow(wf.id, { enabled: true });
    game.run(15 * 60);
    expect(runsOf(game, wf.id)).toHaveLength(0); // the count started again
    // reload mid-way: both copies fire at the same minute
    const copy = new Game(JSON.parse(game.serialize()), region());
    for (const g of [game, copy]) g.run(6 * 60);
    expect(runsOf(game, wf.id).map((r) => r.t)).toEqual(runsOf(copy, wf.id).map((r) => r.t));
    expect(runsOf(game, wf.id)).toHaveLength(1);
  });

  it('keeps an old workflow without timing settings working as before (fires straight away)', () => {
    const game = newGame();
    buildLine(game, { buses: 2, stops: 6, headway: 15 });
    runTo(game, 0, 9);
    const g = graph(game);
    const t = g.node('trigger.balance', { amount: 100_000 });
    g.nodes[0].config = { amount: 100_000 }; // as saved before trigger timing
    const r = g.node('action.report', { text: 'low' });
    g.link(t, 'company', r, 'value');
    const wf = make(game, g);
    setBalance(game, 50_000);
    game.run(2 * 60);
    expect(runsOf(game, wf.id)).toHaveLength(1);
  });
});

describe('hours, days and repeat limits', () => {
  it('only builds up and fires within its hours', () => {
    const game = newGame();
    buildLine(game, { buses: 2, stops: 6, headway: 15 });
    runTo(game, 0, 6);
    const { wf } = balanceWatch(game, { for: 0, from: 7, to: 9 });
    setBalance(game, 50_000);
    game.run(50 * 60);
    expect(runsOf(game, wf.id)).toHaveLength(0);
    game.run(15 * 60);
    expect(runsOf(game, wf.id)).toHaveLength(1);
    expect(Math.floor((runsOf(game, wf.id)[0].t % DAY) / HOUR)).toBe(7);
  });

  it('skips weekdays for a weekend-only trigger', () => {
    const game = newGame();
    buildLine(game, { buses: 2, stops: 6, headway: 15 });
    runTo(game, 0, 9); // day 0 is a Monday
    const g = graph(game);
    const t = g.node('trigger.every', { minutes: 30, days: 'weekend' });
    const r = g.node('action.report', { text: 'tick' });
    g.link(t, 'event', r, 'value');
    const wf = make(game, g);
    game.run(3 * HOUR);
    expect(runsOf(game, wf.id)).toHaveLength(0);
    expect(triggerLabel(game, wf.nodes[0])).toBe('Every 30 minutes · weekends');
  });

  it('runs an event trigger at most once every N minutes for each stop', () => {
    const game = newGame();
    const line = buildLine(game, { buses: 4, stops: 6, headway: 8 });
    runTo(game, 0, 8);
    const g = graph(game);
    const t = g.node('trigger.arrive', { line: line.route, repeat: 30 });
    const r = g.node('action.report', { text: '{event.stopName}' });
    g.link(t, 'stop', r, 'value');
    const wf = make(game, g);
    game.run(HOUR);
    const runs = runsOf(game, wf.id);
    expect(runs.length).toBeGreaterThan(3);
    const byStop = new Map<string, number[]>();
    for (const x of runs) { const k = x.report?.[0] ?? ''; byStop.set(k, [...(byStop.get(k) ?? []), x.t]); }
    for (const [stop, ts] of byStop) {
      expect(ts.length, stop).toBeLessThanOrEqual(2);
      for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1], stop).toBeGreaterThanOrEqual(30 * 60);
    }
    expect(triggerLabel(game, wf.nodes[0])).toContain('at most every 30 min');
  });
});

describe('watch a figure', () => {
  it('watches each bus and hands the bus on: a worn bus goes for maintenance between the peaks', () => {
    const game = newGame();
    const line = buildLine(game, { buses: 3, stops: 6, headway: 10 });
    runTo(game, 0, 8);
    const id = fromTemplate(game, 'maintenance-off-peak');
    if (!id.ok) throw new Error(id.error);
    game.updateWorkflow(id.value, { enabled: true, mode: 'automatic' });
    const worn = game.state.vehicles[line.buses[1]];
    worn.condition = 0.76; // above the game's own automatic-service level (70%)
    game.run(50 * 60); // still before 09:00
    expect(runsOf(game, id.value)).toHaveLength(0);
    game.run(15 * 60);
    const runs = runsOf(game, id.value);
    expect(runs).toHaveLength(1);
    expect(runs[0].triggerLabel).toContain(`Bus ${worn.fleetNo}`);
    expect(runs[0].actions[0]?.outcome).toMatch(/executed|deferred/);
    expect(worn.wantsService || worn.status === 'maintenance').toBe(true);
  });

  it('reads line, stop and company figures for its label and status', () => {
    const game = newGame({ extraFunds: 9_000_000 });
    buildLine(game, { buses: 3, stops: 6, headway: 10 });
    runTo(game, 0, 9);
    const g = graph(game);
    g.node('trigger.watch', { figure: 'line.onTime3h', op: 'below', value: 75, for: 30, from: 7, to: 21 });
    const wf = make(game, g);
    expect(triggerLabel(game, wf.nodes[0])).toBe('Trips on time, last 3 hours (any line) below 75% · for 30+ min, 07:00–21:00');
    // one line: "Now …"; with several, the worst one is named
    expect(triggerStatus(game, wf, wf.nodes[0]).text).toMatch(/^Now \d+(\.\d)?%, fires below 75% · /);
    buildLine(game, { from: [28.99, 41.05], buses: 2, stops: 5, headway: 12 });
    expect(triggerStatus(game, wf, wf.nodes[0]).text).toMatch(/^Line \d+ (\d+(\.\d)?%|no figure yet), fires below 75% · /);
  });
});

describe('new triggers', () => {
  it('a line short of buses: fires once, names the shortfall, and again only after it was covered', () => {
    const game = newGame({ extraFunds: 9_000_000 });
    const line = buildLine(game, { buses: 7, stops: 8, headway: 12 }); // needs 6 (a 65-minute round trip)
    runTo(game, 0, 8);
    expect(busesNeededNow(game, line.route)).toBeGreaterThan(1);
    expect(shortOf(game, line.route)).toBe(0);
    const id = fromTemplate(game, 'short-of-buses');
    if (!id.ok) throw new Error(id.error);
    game.updateWorkflow(id.value, { enabled: true });
    game.run(10 * 60);
    expect(runsOf(game, id.value)).toHaveLength(0);
    for (const b of line.buses.slice(1)) game.assignVehicle(b, null);
    expect(shortOf(game, line.route)).toBeGreaterThan(0);
    game.run(30 * 60);
    const runs = runsOf(game, id.value);
    expect(runs).toHaveLength(1);
    const note = game.state.notifications.find((x) => x.title.startsWith(`Line ${game.state.routes[line.route].number} is short of buses`));
    expect(note?.body).toContain('has 1, so departures will be missed');
    for (const b of line.buses.slice(1)) game.assignVehicle(b, line.route);
    game.run(10 * 60);
    expect(shortOf(game, line.route)).toBe(0);
    for (const b of line.buses.slice(1)) game.assignVehicle(b, null);
    game.run(10 * 60);
    expect(runsOf(game, id.value)).toHaveLength(2);
  });

  it('people left behind by a full bus', () => {
    const game = newGame({ seed: 21 });
    crowdedLine(game);
    const g = graph(game);
    const t = g.node('trigger.leftBehind', { people: 1, repeat: 0 });
    const r = g.node('action.report', { text: '{event.leftBehind} at {event.stopName}' });
    g.link(t, 'stop', r, 'value');
    const wf = make(game, g);
    runTo(game, 1, 10);
    const runs = runsOf(game, wf.id);
    const seen = game.state.analytics.days.find((d) => d.day === 1) ?? game.state.analytics.today;
    const left = Object.values(game.state.analytics.today.stops).reduce((a, s) => a + s.lb, 0) + Object.values(seen.stops).reduce((a, s) => a + s.lb, 0);
    expect(left).toBeGreaterThan(0);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].report?.[0]).toMatch(/^\d+ at /);
  });

  it('people giving up at a stop, counted over the last hour', () => {
    const game = newGame();
    const line = buildLine(game, { buses: 2, stops: 6, headway: 15 });
    runTo(game, 0, 10);
    const id = fromTemplate(game, 'gave-up-alert');
    if (!id.ok) throw new Error(id.error);
    game.updateWorkflow(id.value, { enabled: true });
    const stop = line.stopIds[2];
    const h = Math.floor((game.t % DAY) / HOUR);
    game.state.analytics.today.stops[stop].g[h] += 10;
    game.run(2 * 60);
    const runs = runsOf(game, id.value);
    expect(runs).toHaveLength(1);
    expect(runs[0].triggerLabel).toContain(game.state.stops[stop].name);
    expect(game.state.notifications.some((x) => x.title.includes(`gave up waiting at ${game.state.stops[stop].name}`))).toBe(true);
  });

  it('the end of the week, once, with the week’s figures', () => {
    const game = newGame();
    buildLine(game, { buses: 3, stops: 7, headway: 10 });
    const id = fromTemplate(game, 'weekly-report');
    if (!id.ok) throw new Error(id.error);
    game.updateWorkflow(id.value, { enabled: true });
    runTo(game, 7, 1);
    const runs = runsOf(game, id.value);
    expect(runs).toHaveLength(1);
    expect(runs[0].report?.[0]).toMatch(/^Week 1: \d+ journeys \(the first week recorded\), satisfaction [\d.]+%, fares \d+/);
    expect(game.state.notifications.some((x) => x.title === 'Week 1 in numbers')).toBe(true);
  });
});

describe('starter workflows', () => {
  it('every template has a group, validates and test-runs without failing', () => {
    const game = newGame({ extraFunds: 900_000 });
    buildLine(game, { buses: 4, stops: 8, headway: 8 });
    buildLine(game, { from: [28.99, 41.05], buses: 3, stops: 7, headway: 10 });
    runTo(game, 0, 9);
    const groups = new Set(TEMPLATE_GROUPS.map((g) => g.id));
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(28);
    for (const t of TEMPLATES) {
      expect(groups.has(t.group), t.id).toBe(true);
      const r = fromTemplate(game, t.id);
      expect(r.ok, t.id).toBe(true);
      if (!r.ok) continue;
      const wf = game.state.automation.workflows[r.value];
      expect(validateWorkflow(wf, game.state).issues.filter((i) => i.level === 'error').map((i) => `${t.id}: ${i.message}`)).toEqual([]);
      const run = game.runWorkflowNow(r.value, { test: true });
      expect(run.ok && run.value.status, t.id).not.toBe('error');
    }
  });

  it('the morning briefing says the weather, events and lines short of buses', () => {
    const game = newGame();
    buildLine(game, { buses: 2, stops: 6, headway: 10 });
    const id = fromTemplate(game, 'morning-briefing');
    if (!id.ok) throw new Error(id.error);
    game.updateWorkflow(id.value, { enabled: true });
    runTo(game, 1, 6.05);
    const note = game.state.notifications.find((x) => x.title === 'Good morning');
    expect(note?.body).toMatch(/^[A-Z][^,]*, -?\d+ °C\. \d+ events? in the next day\. \d+ lines? short of buses\.$/);
  });

  it('moves a bus from a quiet line to a busy one only when the quiet line can spare it', () => {
    const game = newGame({ seed: 21, extraFunds: 900_000 });
    // an established company (as in scenario 3): its busy line fills above 80% in the evening
    game.state.company.reputation = 60;
    const busy = crowdedLine(game);
    const quiet = buildLine(game, { from: [28.95, 41.02], buses: 4, stops: 5, headway: 30 });
    const id = fromTemplate(game, 'rebalance');
    if (!id.ok) throw new Error(id.error);
    game.updateWorkflow(id.value, { enabled: true, mode: 'automatic' });
    runTo(game, 1, 10);
    const moved = game.state.automation.runs.filter((r) => r.wf === id.value).flatMap((r) => r.actions).filter((a) => a.outcome === 'executed' || a.outcome === 'deferred');
    expect(moved.length).toBeGreaterThan(0);
    for (const a of moved) expect(a.cmd).toMatchObject({ type: 'assign_vehicle', route: busy.route });
    // never below what the quiet line's timetable needs at the time
    expect(game.state.routes[quiet.route].vehicles.length).toBeGreaterThanOrEqual(1);
  });
});
