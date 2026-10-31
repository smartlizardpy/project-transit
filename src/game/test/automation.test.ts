// Automation Studio engine: validation, the sandboxed expressions, execution on game time,
// modes, safety rules and save/load. Workflows act only through the shared command layer.
import { describe, expect, it } from 'vitest';
import { Game } from '../engine.ts';
import { buildLine, crowdedLine, newGame, region } from './helpers.ts';
import { DAY, ECON, HOUR } from '../content.ts';
import { TripState } from '../types.ts';
import { evaluate, checkExpr, compile, ExprError } from '../expr.ts';
import { defaultConfig } from '../automation/registry.ts';
import { validateWorkflow, connectionProblem } from '../automation/validate.ts';
import { fromTemplate } from '../automation/templates.ts';
import type { Value, WfEdge, WfNode, Workflow } from '../automation/types.ts';

/** Build a workflow graph by hand, as the editor would. */
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

function make(game: Game, name: string, g: ReturnType<typeof graph>, patch: Omit<Partial<Workflow>, 'limits'> & { limits?: Partial<Workflow['limits']> } = {}) {
  const r = game.createWorkflow({ name, nodes: g.nodes, edges: g.edges });
  if (!r.ok) throw new Error(r.error);
  const u = game.updateWorkflow(r.value, { enabled: true, mode: 'automatic', ...patch });
  if (!u.ok) throw new Error(u.error);
  return game.state.automation.workflows[r.value];
}

const runsOf = (game: Game, wf: string) => game.state.automation.runs.filter((r) => r.wf === wf && !r.test);

describe('expressions are sandboxed', () => {
  it('calculates and reads fields', () => {
    const value = (src: string, vars: Parameters<typeof evaluate>[1]) => {
      const r = evaluate(src, vars);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    expect(value('round(a / b * 100, 1)', { a: 2, b: 3 })).toBe(66.7);
    expect(value('line.occupancy > 80 and not line.suspended', { line: { occupancy: 86, suspended: false } })).toBe(true);
    expect(value('avg(pluck(lines, "occupancy"))', { lines: [{ occupancy: 40 }, { occupancy: 60 }] })).toBe(50);
    expect(value('a / 0', { a: 1 })).toBeNull();
  });
  it('cannot reach JavaScript internals or run forever', () => {
    const refused = (src: string, vars = {}) => {
      const r = evaluate(src, vars);
      return r.ok ? `allowed: ${JSON.stringify(r.value)}` : r.error;
    };
    expect(refused('a.constructor', { a: { x: 1 } })).toMatch(/not available/);
    expect(refused('a.__proto__', { a: {} })).toMatch(/not available/);
    expect(refused('constructor("return 1")')).toMatch(/not available|Unknown|no function/i);
    expect(refused('alert(1)')).not.toMatch(/^allowed/);
    expect(refused('a; b', { a: 1, b: 2 })).not.toMatch(/^allowed/);
    expect(refused('x'.repeat(3000))).toMatch(/at most 2000 characters/);
    expect(() => compile('a +')).toThrow(ExprError);
    expect(checkExpr('item.waiting > 10', ['item']).ok).toBe(true);
    expect(checkExpr('window.location', ['item']).ok).toBe(false);
  });
});

describe('workflow validation', () => {
  const game = newGame({ seed: 4 });
  const line = buildLine(game, { buses: 1, stops: 5 });
  it('explains what is missing', () => {
    const g = graph(game);
    const cmp = g.node('logic.compare');
    g.node('action.dispatch', { line: line.route });
    const wf = { ...game.state.automation.workflows[game.createWorkflow({ name: 'x', nodes: g.nodes, edges: g.edges }).ok ? `wf${game.state.automation.counters.workflow}` : ''] };
    const v = validateWorkflow(wf as Workflow, game.state);
    expect(v.ok).toBe(false);
    const text = v.issues.map((i) => i.message).join(' | ');
    expect(text).toMatch(/Add a trigger/);
    expect(text).toMatch(/Compare: connect “Value”/);
    expect(v.issues.find((i) => i.message.includes('Compare'))?.node).toBe(cmp);
  });
  it('refuses wrong types and loops', () => {
    const g = graph(game);
    const t = g.node('trigger.every');
    const lines = g.node('data.lines');
    const cmp = g.node('logic.compare');
    const ex = g.node('math.expr');
    const id = game.createWorkflow({ name: 'y', nodes: g.nodes, edges: g.edges });
    if (!id.ok) throw new Error(id.error);
    const wf = game.state.automation.workflows[id.value];
    expect(connectionProblem(wf, { from: t, out: 'event', to: cmp, in: 'a' })).toMatch(/cannot go into/);
    expect(connectionProblem(wf, { from: lines, out: 'lines', to: ex, in: 'a' })).toBeNull();
    wf.edges.push({ id: 'k1', from: ex, out: 'value', to: cmp, in: 'a' });
    expect(connectionProblem(wf, { from: cmp, out: 'result', to: ex, in: 'b' })).toMatch(/loop/);
  });
});

describe('scenario 3: every 15 min → line occupancy → threshold → free bus → extra departure', () => {
  // An established company (reputation 85, lowest fare) with small buses on a busy corridor, so
  // the morning peak genuinely fills them (see crowdedLine).
  const game = newGame({ seed: 21, extraFunds: 1_000_000, allZones: true });
  game.state.company.reputation = 85;
  game.setFare(ECON.fareMin);
  const line = crowdedLine(game);
  const spare = game.buyVehicle('mini8', line.depot);
  if (!spare.ok) throw new Error(spare.error);
  const created = fromTemplate(game, 'crowding');
  if (!created.ok) throw new Error(created.error);
  const wf = game.state.automation.workflows[created.value];
  const typeOf = (id: string) => wf.nodes.find((n) => n.id === id)?.type;

  it('the template is a real graph of library nodes, created in Observe mode and switched off', () => {
    expect(wf.mode).toBe('observe');
    expect(wf.enabled).toBe(false);
    expect(wf.nodes.map((n) => n.type)).toEqual(['trigger.every', 'data.line', 'logic.compare', 'logic.if', 'data.findBus', 'action.dispatch']);
    expect(wf.nodes.find((n) => n.type === 'logic.compare')!.config.b).toBe(80);
    expect(game.validateWorkflow(wf.id)!.ok).toBe(true);
  });

  it('runs every 15 game minutes and does nothing while the line is below 80%, saying why', () => {
    game.updateWorkflow(wf.id, { enabled: true, mode: 'automatic' });
    game.run(HOUR + 20 * 60); // 05:00 → 06:20: the trigger runs from 06:00
    const runs = runsOf(game, wf.id);
    expect(runs.map((r) => r.t % DAY / 60)).toEqual([360, 375]); // 06:00, 06:15
    const quiet = runs.find((r) => !r.actions.length)!;
    expect(quiet.trace!.find((t) => typeOf(t.node) === 'logic.compare')!.note).toMatch(/ > 80 → false$/);
    expect(quiet.trace!.find((t) => typeOf(t.node) === 'action.dispatch')!.status).toBe('inactive');
    expect(Object.values(game.state.trips).flat().some((t) => t.extra === wf.id)).toBe(false);
  });

  it('dispatches a free bus as soon as the line is above 80%, and the extra trip really runs', () => {
    let run = runsOf(game, wf.id).find((r) => r.actions.length);
    for (let i = 0; i < 16 && !run; i++) {
      game.run(15 * 60);
      run = runsOf(game, wf.id).find((r) => r.actions.length);
    }
    expect(run).toBeTruthy();
    const cmp = run!.trace!.find((t) => typeOf(t.node) === 'logic.compare')!;
    expect(cmp.outputs!.result).toBe(true);
    expect(Number(cmp.inputs!.a)).toBeGreaterThan(80);
    expect(cmp.note).toMatch(/ > 80 → true$/);
    expect(run!.trace!.find((t) => typeOf(t.node) === 'data.findBus')!.outputs!.found).toBe(true);
    expect(run!.actions[0].outcome).toBe('executed');
    expect(run!.actions[0].effect).toMatch(/extra/i);
    const extras = Object.values(game.state.trips).flat().filter((t) => t.extra === wf.id);
    expect(extras.length).toBe(1);
    const trip = extras[0];
    const bus = Object.values(game.state.vehicles).find((v) => v.trip === trip.id)!;
    expect(bus.id).toBe(spare.value); // the line's own buses are busy, so the spare goes
    const boardedBefore = game.state.analytics.today.veh[bus.id]?.b ?? 0;
    for (let i = 0; i < 150 && game.trip(trip.id)?.state !== TripState.Done; i++) game.run(60);
    expect(game.trip(trip.id)?.state).toBe(TripState.Done);
    expect((game.state.analytics.today.veh[bus.id]?.b ?? 0) - boardedBefore).toBeGreaterThan(0);
    expect(game.audit()).toEqual([]);
  });

  it('the cooldown stops it sending another extra on the same line within 30 minutes', () => {
    const at = Object.values(game.state.trips).flat().find((t) => t.extra === wf.id)!;
    void at;
    const withAction = runsOf(game, wf.id).filter((r) => r.actions.length);
    const first = withAction[0];
    for (const r of withAction.slice(1)) {
      if (r.t - first.t < 30 * 60) expect(r.actions[0].outcome).toBe('cooldown');
    }
    const executed = withAction.filter((r) => r.actions[0].outcome === 'executed');
    for (let i = 1; i < executed.length; i++) expect(executed[i].t - executed[i - 1].t).toBeGreaterThanOrEqual(30 * 60);
  });
});

describe('modes: observe, suggest, automatic, and big changes', () => {
  const game = newGame({ seed: 8, extraFunds: 500_000 });
  const line = buildLine(game, { buses: 2, stops: 6, headway: 12 });
  game.buyVehicle('city12', line.depot); // a spare bus, so an extra departure is possible
  game.run(2 * HOUR);

  function headwayWorkflow(mode: Workflow['mode'], allowHighImpact = false) {
    const g = graph(game);
    g.node('trigger.manual');
    g.node('action.headway', { line: line.route, minutes: 8 });
    return make(game, `headway ${mode}`, g, { mode, allowHighImpact });
  }

  it('Observe records what it would do and changes nothing', () => {
    const wf = headwayWorkflow('observe');
    const tt = JSON.stringify(game.state.routes[line.route].timetable);
    const r = game.runWorkflowNow(wf.id, { test: false });
    expect(r.ok && r.value.actions[0].outcome).toBe('observed');
    expect(r.ok && r.value.actions[0].effect).toMatch(/every 8 min/);
    expect(JSON.stringify(game.state.routes[line.route].timetable)).toBe(tt);
  });

  it('a big change in Automatic mode waits for approval unless allowed', () => {
    const wf = headwayWorkflow('automatic');
    const tt = JSON.stringify(game.state.routes[line.route].timetable);
    const r = game.runWorkflowNow(wf.id, { test: false });
    expect(r.ok && r.value.actions[0].outcome).toBe('proposed');
    expect(JSON.stringify(game.state.routes[line.route].timetable)).toBe(tt);
    const p = game.state.automation.proposals.find((x) => x.wf === wf.id && x.status === 'open')!;
    expect(p.detail).toMatch(/every 8 min/);
    // running it again does not pile up the same suggestion
    const again = game.runWorkflowNow(wf.id, { test: false });
    expect(again.ok && again.value.actions[0].outcome).toBe('duplicate');
    const ok = game.approveProposal(p.id);
    expect(ok.ok).toBe(true);
    expect(JSON.stringify(game.state.routes[line.route].timetable)).not.toBe(tt);
    expect(p.status).toBe('approved');
  });

  it('a test run never changes the game or the workflow memory', () => {
    const g = graph(game);
    const t = g.node('trigger.manual');
    const c = g.node('state.counter', { key: 'n' });
    g.link(t, 'event', c, 'value');
    const d = g.node('action.dispatch', { line: line.route });
    g.link(c, 'count', d, 'when');
    const wf = make(game, 'test run', g);
    const before = JSON.stringify({ ...game.state, meta: null, automation: null });
    const r = game.runWorkflowNow(wf.id, { test: true });
    expect(r.ok && r.value.test).toBe(true);
    expect(r.ok && r.value.actions[0].outcome).toBe('observed');
    expect(JSON.stringify({ ...game.state, meta: null, automation: null })).toBe(before);
    expect(game.state.automation.memory[wf.id] ?? {}).toEqual({});
  });
});

describe('scenario 5: two workflows that contradict each other', () => {
  const game = newGame({ seed: 5, extraFunds: 1_000_000 });
  const a = buildLine(game, { buses: 1, stops: 5 });
  const b = buildLine(game, { from: [28.9745, 41.0255], buses: 1, stops: 5 });
  const x = game.buyVehicle('city12', a.depot);
  if (!x.ok) throw new Error(x.error);
  const bus = x.value;
  game.run(HOUR);

  function mover(name: string, route: string) {
    const g = graph(game);
    const t = g.node('trigger.every', { minutes: 15 });
    const bn = g.node('data.bus', { bus });
    const mv = g.node('action.assign', { line: route });
    g.link(bn, 'bus', mv, 'bus');
    void t;
    return make(game, name, g);
  }
  const toA = mover('Bus to line A', a.route);
  const toB = mover('Bus to line B', b.route);

  it('gives one consistent result, reports the conflict and does not flip-flop', () => {
    game.run(3 * HOUR);
    expect(game.state.vehicles[bus].route).toBe(a.route); // the first workflow in the list acted
    const aRuns = runsOf(game, toA.id), bRuns = runsOf(game, toB.id);
    expect(aRuns[0].actions[0].outcome).toBe('executed');
    expect(aRuns.slice(1).every((r) => r.actions.every((x) => x.outcome !== 'executed'))).toBe(true);
    expect(bRuns.length).toBeGreaterThanOrEqual(10);
    expect(bRuns.every((r) => r.actions[0].outcome === 'conflict')).toBe(true);
    expect(bRuns[0].actions[0].reason).toMatch(/“Bus to line A” changed this at \d\d:\d\d/);
    const warn = game.state.notifications.filter((n) => n.title === 'Two automations disagree');
    expect(warn.length).toBeGreaterThanOrEqual(1);
    expect(warn.length).toBeLessThanOrEqual(4); // at most one an hour
    // the bus was moved once by automation, never back and forth
    const moves = game.state.analytics.assignments.filter((e) => e.v === bus && e.src !== 'player');
    expect(moves.length).toBe(1);
  });

  it('a reload in the middle of the disagreement continues identically', () => {
    const copy = new Game(JSON.parse(game.serialize()), region());
    game.run(2 * HOUR);
    copy.run(2 * HOUR);
    expect(JSON.stringify(copy.state.automation)).toBe(JSON.stringify(game.state.automation));
    expect(JSON.stringify(copy.state.notifications)).toBe(JSON.stringify(game.state.notifications));
  });

  it('automations do not undo a change the player made by hand', () => {
    expect(game.assignVehicle(bus, b.route).ok).toBe(true);
    game.run(HOUR);
    expect(game.state.vehicles[bus].route).toBe(b.route);
    const last = runsOf(game, toA.id).at(-1)!;
    expect(last.actions[0].outcome).toBe('conflict');
    expect(last.actions[0].reason).toMatch(/You changed this by hand/);
  });
});

describe('the same action by two workflows', () => {
  it('counts as already done for a short while only, so later extra departures still run', () => {
    const game = newGame({ seed: 21, extraFunds: 1_000_000 });
    const line = buildLine(game, { buses: 2, stops: 8, headway: 15 });
    for (let i = 0; i < 3; i++) game.buyVehicle('city12', line.depot);
    game.run(2 * HOUR);
    const extra = (name: string) => {
      const g = graph(game);
      g.node('trigger.manual');
      g.node('action.dispatch', { line: line.route });
      return make(game, name, g);
    };
    const a = extra('Extra A'), b = extra('Extra B');
    const first = game.runWorkflowNow(a.id, { test: false });
    expect(first.ok && first.value.actions[0].outcome).toBe('executed');
    const soon = game.runWorkflowNow(b.id, { test: false });
    expect(soon.ok && soon.value.actions[0].outcome).toBe('duplicate');
    expect(soon.ok && soon.value.actions[0].reason).toMatch(/“Extra A” already did this/);
    game.run(HOUR);
    const later = game.runWorkflowNow(b.id, { test: false });
    expect(later.ok && later.value.actions[0].outcome).toBe('executed');
  });
});

describe('scenario 4 through a workflow: moving a bus with passengers on board', () => {
  const game = newGame({ seed: 11, extraFunds: 1_000_000 });
  const a = buildLine(game, { buses: 2, stops: 7, headway: 10 });
  const b = buildLine(game, { from: [28.9745, 41.0255], buses: 1, stops: 5 });
  game.run(3 * HOUR);
  it('defers until the trip ends, keeps the passengers and records it', () => {
    let busy = Object.values(game.state.vehicles).find((v) => v.route === a.route && v.load > 0);
    for (let i = 0; i < 360 && !busy; i++) {
      game.run(30);
      busy = Object.values(game.state.vehicles).find((v) => v.route === a.route && v.load > 0);
    }
    expect(busy).toBeTruthy();
    const g = graph(game);
    g.node('trigger.manual');
    const bn = g.node('data.bus', { bus: busy!.id });
    const mv = g.node('action.assign', { line: b.route });
    g.link(bn, 'bus', mv, 'bus');
    const wf = make(game, 'move loaded', g);
    const load = busy!.load, trip = busy!.trip;
    const r = game.runWorkflowNow(wf.id, { test: false });
    expect(r.ok).toBe(true);
    const act = r.ok ? r.value.actions[0] : null;
    expect(act?.outcome).toBe('deferred');
    expect(act?.effect ?? '').toMatch(/finishes|passengers/i);
    expect(busy!.trip).toBe(trip);
    expect(busy!.load).toBe(load);
    expect(game.audit()).toEqual([]);
  });
});

describe('safety rules', () => {
  const game = newGame({ seed: 6, extraFunds: 500_000 });
  buildLine(game, { buses: 1, stops: 5 });
  game.run(HOUR);

  it('limits runs per hour', () => {
    const g = graph(game);
    const t = g.node('trigger.every', { minutes: 5 });
    const r = g.node('action.report', { text: 'tick' });
    g.link(t, 'event', r, 'value');
    const wf = make(game, 'chatty', g, { limits: { runsPerHour: 4 } });
    game.run(2 * HOUR);
    const runs = runsOf(game, wf.id);
    const ok = runs.filter((x) => x.status === 'ok').length;
    expect(ok).toBeLessThanOrEqual(8 + 1);
    expect(runs.some((x) => x.status === 'limit' && /More than 4 runs this hour/.test(x.error ?? ''))).toBe(true);
    game.updateWorkflow(wf.id, { enabled: false });
  });

  it('switches a workflow off after repeated failures and tells the player', () => {
    const doomed = buildLine(game, { from: [28.9745, 41.0255], buses: 0, stops: 4 });
    const g = graph(game);
    const t = g.node('trigger.every', { minutes: 5 });
    const l = g.node('data.line', { line: doomed.route });
    const s = g.node('state.set', { key: 'occ' });
    g.link(l, 'occupancy', s, 'value');
    void t;
    const wf = make(game, 'fragile', g);
    expect(game.deleteRoute(doomed.route).ok).toBe(true);
    game.run(40 * 60);
    expect(wf.enabled).toBe(false);
    expect(wf.stopped).toMatch(/Switched off after 5 failed runs/);
    expect(game.state.notifications.some((n) => n.title === 'Automation “fragile” was switched off')).toBe(true);
  });

  it('stops runaway work inside a run', () => {
    const g = graph(game);
    g.node('trigger.manual');
    const stops = g.node('data.stops');
    let prev = stops;
    for (let i = 0; i < 60; i++) {
      const m = g.node('math.map', { expr: 'item.waiting + 1' });
      g.link(prev, prev === stops ? 'stops' : 'list', m, 'list');
      prev = m;
    }
    for (let i = 0; i < 300; i++) game.placeStop([28.95 + (i % 20) * 0.004, 41.0 + Math.floor(i / 20) * 0.003]);
    const wf = make(game, 'heavy', g);
    const r = game.runWorkflowNow(wf.id, { test: false });
    expect(r.ok && r.value.status).toBe('limit');
    expect(r.ok && r.value.error).toMatch(/Stopped: the run did more than/);
  });
});

describe('simulation events and save/load', () => {
  it('event triggers run from the simulation, and a reload continues identically', () => {
    const game = newGame({ seed: 13, extraFunds: 500_000 });
    const line = buildLine(game, { buses: 3, stops: 7, headway: 10 });
    game.run(2 * HOUR);
    const g = graph(game);
    const t = g.node('trigger.arrive', { line: line.route });
    const c = g.node('state.counter', { key: 'arrivals', daily: false });
    g.link(t, 'event', c, 'value');
    const s = g.node('state.set', { key: 'lastBus' });
    const f = g.node('math.field', { field: 'fleetNo' });
    g.link(t, 'bus', f, 'record');
    g.link(f, 'value', s, 'value');
    const late = g.node('trigger.late', { minutes: 1 });
    const n = g.node('action.notify', { title: '{event.fleetNo} late' });
    g.link(late, 'event', n, 'value');
    const wf = make(game, 'events', g, { limits: { runsPerHour: 120 } });
    game.run(HOUR);
    const mem = game.state.automation.memory[wf.id];
    const count = (mem['#arrivals'] as { n: number }).n;
    expect(count).toBeGreaterThan(5);
    expect(typeof mem.lastBus).toBe('string');
    // every arrival on the line is counted once
    const arrivals = runsOf(game, wf.id).filter((r) => r.trigger === t);
    expect(arrivals.every((r) => r.status === 'ok')).toBe(true);
    expect(arrivals.length).toBe(count);

    const copy = new Game(JSON.parse(game.serialize()), region());
    game.run(3 * HOUR);
    copy.run(3 * HOUR);
    expect(JSON.stringify(copy.state.automation)).toBe(JSON.stringify(game.state.automation));
    expect(JSON.stringify(copy.state.vehicles)).toBe(JSON.stringify(game.state.vehicles));
    expect(copy.state.automation.workflows[wf.id].name).toBe('events');
  });

  it('the end-of-day trigger gets the real figures of the day', () => {
    const game = newGame({ seed: 3, extraFunds: 500_000 });
    buildLine(game, { buses: 2, stops: 6 });
    const g = graph(game);
    const t = g.node('trigger.day');
    const r = g.node('action.report', { text: 'Day {value.dayNumber}: {value.journeys} journeys, {value.boardings} boardings' });
    g.link(t, 'summary', r, 'value');
    const wf = make(game, 'daily', g);
    game.run(DAY);
    const run = runsOf(game, wf.id).at(-1)!;
    const rec = game.state.analytics.days.at(-1)!;
    const boardings = Object.values(rec.routes).reduce((n, x) => n + x.b.reduce((a, b) => a + b, 0), 0);
    expect(run.report?.[0]).toBe(`Day 1: ${rec.net.j.reduce((a, b) => a + b, 0)} journeys, ${boardings} boardings`);
  });
});

describe('Simulation Lab', () => {
  it('compares the company with and without a workflow on copies, leaving the live game untouched', async () => {
    const game = newGame({ seed: 21, extraFunds: 1_000_000, allZones: true });
    game.state.company.reputation = 85;
    game.setFare(ECON.fareMin);
    const line = crowdedLine(game);
    game.buyVehicle('mini8', line.depot);
    game.buyVehicle('mini8', line.depot);
    game.run(HOUR);
    const created = fromTemplate(game, 'crowding');
    if (!created.ok) throw new Error(created.error);
    const before = JSON.stringify({ ...game.state, meta: null });
    const { runLab } = await import('../automation/lab.ts');
    const res = await runLab(game, created.value, { hours: 4, mode: 'automatic', approveSuggestions: false, allowHighImpact: false });
    expect(res).not.toBeNull();
    expect(JSON.stringify({ ...game.state, meta: null })).toBe(before);
    expect(res!.runs).toBe(16); // every 15 min from 06:00 to 10:00
    expect(res!.extras).toBeGreaterThan(0);
    expect(res!.outcomes.executed).toBe(res!.extras);
    // the copy with the workflow ran more trips: the extra departures
    expect(res!.variant.trips).toBeGreaterThan(res!.baseline.trips);
    expect(res!.baseline.boardings).toBeGreaterThan(0);
    // fares minus costs over the window, measured from the copies' balances
    expect(Number.isFinite(res!.variant.result)).toBe(true);
  });
});
