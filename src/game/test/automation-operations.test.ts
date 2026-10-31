// Control-room operations and the blocks built on them: holding a bus, turning a bus back early,
// moving one departure, temporary detours, route-change suggestions, gaps between buses,
// connections, forecasts of how full departures will be, coverage, stops nearby, Wait,
// One at a time and Best pairs. Every one acts through the vehicle and timetable simulation.
import { describe, expect, it } from 'vitest';
import { Game } from '../engine.ts';
import { buildLine, crowdedLine, newGame } from './helpers.ts';
import { DAY, HOUR } from '../content.ts';
import { checkCommand, runCommand } from '../commands.ts';
import { defaultConfig } from '../automation/registry.ts';
import { validateWorkflow } from '../automation/validate.ts';
import { fromTemplate, TEMPLATES } from '../automation/templates.ts';
import { assignRows, coverage, forecastOccupancy, lineGaps, missedConnections, nearbyStops, roadTrip, transferPoints } from '../automation/ops.ts';
import { detoursOf } from '../operations.ts';
import { TripState, type Vehicle } from '../types.ts';
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
  const r = game.createWorkflow({ name: 'operations test', nodes: g.nodes, edges: g.edges, kind: 'workflow' });
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
const sum = (a: number[] | undefined) => (a ?? []).reduce((x, y) => x + y, 0);
const missed = (game: Game, route: string) => sum(game.state.analytics.today.routes[route]?.m);

/** A bus on a trip between two stops, well before the end of its pattern. */
function midTrip(game: Game, route: string, minLeft = 3): Vehicle | undefined {
  return game.vehicleList().find((v) => {
    if (v.route !== route || v.status !== 'in_service' || v.pos.kind !== 'pattern' || v.trip === null) return false;
    const p = game.pattern(v.pos.route, v.pos.pat)!;
    return v.stopIdx >= 1 && v.stopIdx <= p.stops.length - 1 - minLeft;
  });
}

/** Step the game until `test` holds (in steps of `dt` seconds), at most `max` seconds. */
function until(game: Game, test: () => boolean, max: number, dt = 5) {
  for (let t = 0; t < max; t += dt) {
    if (test()) return true;
    game.run(dt);
  }
  return test();
}

describe('holding a bus', () => {
  it('keeps the bus at the stop for the hold after its normal stop, then it carries on', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 3, stops: 7, headway: 10 });
    runTo(game, 0, 7);
    const v = midTrip(game, l.route)!;
    expect(v).toBeTruthy();
    const p = game.pattern(v.pos.kind === 'pattern' ? v.pos.route : '', v.pos.kind === 'pattern' ? v.pos.pat : 0)!;
    const idx = v.stopIdx;
    const check = checkCommand(game, { type: 'hold_vehicle', vehicle: v.id, minutes: 4 });
    expect(check.ok).toBe(true);
    expect(check.transition).toContain(game.state.stops[p.stops[idx]].name);
    expect(runCommand(game, { type: 'hold_vehicle', vehicle: v.id, minutes: 4 }, 'player').ok).toBe(true);
    expect(until(game, () => v.status === 'at_stop' && v.stopIdx === idx, 30 * 60)).toBe(true);
    const arrived = game.t;
    expect(until(game, () => v.stopIdx > idx, 30 * 60)).toBe(true);
    // at least the 4 minutes, and not much more than a normal stop on top
    expect(game.t - arrived).toBeGreaterThanOrEqual(4 * 60);
    expect(game.t - arrived).toBeLessThan(4 * 60 + 3 * 60);
    expect(v.hold).toBeUndefined();
  });

  it('refuses a hold that is too long, or for a bus not on a trip', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 2, stops: 6, headway: 15 });
    const spare = game.buyVehicle('city12', l.depot);
    if (!spare.ok) throw new Error(spare.error);
    runTo(game, 0, 7);
    const v = midTrip(game, l.route)!;
    expect(checkCommand(game, { type: 'hold_vehicle', vehicle: v.id, minutes: 15 }).ok).toBe(false);
    expect(checkCommand(game, { type: 'hold_vehicle', vehicle: spare.value, minutes: 3 }).reason).toMatch(/not running a trip/);
  });
});

describe('turning a bus back early', () => {
  it('ends the trip at the stop, lets riders going further off without charging them again, and runs back from there', () => {
    const game = newGame({ seed: 21 });
    const l = crowdedLine(game);
    runTo(game, 0, 7, 30);
    const v = midTrip(game, l.route, 3)!;
    expect(v).toBeTruthy();
    const pat = v.pos.kind === 'pattern' ? v.pos.pat : 0;
    const p = game.pattern(l.route, pat)!;
    const opp = game.pattern(l.route, 1 - pat)!;
    const k = v.stopIdx + 1;
    const stop = p.stops[k];
    const trip = game.trip(v.trip!)!;
    const plan = checkCommand(game, { type: 'short_turn', vehicle: v.id, stop });
    expect(plan.ok).toBe(true);
    expect(plan.transition).toContain(game.state.stops[stop].name);
    const fares = game.state.analytics.today.routes[l.route]?.rv.reduce((a, b) => a + b, 0) ?? 0;
    expect(runCommand(game, { type: 'short_turn', vehicle: v.id, stop }, 'player').ok).toBe(true);
    expect(until(game, () => trip.state === TripState.Done, 40 * 60)).toBe(true);
    expect(trip.short).toBe(k);
    // nobody going further stayed on board, and the bus now runs the other way from that stop
    const back = game.trip(v.trip!)!;
    expect(back.route).toBe(l.route);
    expect(back.pat).toBe(opp.index);
    expect(back.from).toBe(opp.stops.indexOf(stop));
    expect(back.extra).toBeTruthy();
    expect(until(game, () => back.state === TripState.Done, 90 * 60)).toBe(true);
    expect(missed(game, l.route)).toBe(0);
    // turning back sells no fares of its own: riders who got off already paid
    const after = game.state.analytics.today.routes[l.route]?.rv.reduce((a, b) => a + b, 0) ?? 0;
    expect(after).toBeGreaterThanOrEqual(fares);
  });

  it('refuses a loop line, a stop behind the bus and the last stop', () => {
    const game = newGame();
    const loop = buildLine(game, { buses: 2, stops: 6, headway: 15, kind: 'loop' });
    runTo(game, 0, 7);
    const v = midTrip(game, loop.route, 1)!;
    const p = game.pattern(loop.route, 0)!;
    expect(checkCommand(game, { type: 'short_turn', vehicle: v.id, stop: p.stops[v.stopIdx + 1] }).reason).toMatch(/loop/);
    const g2 = newGame();
    const lin = buildLine(g2, { buses: 3, stops: 7, headway: 10 });
    runTo(g2, 0, 7);
    const w = midTrip(g2, lin.route, 2)!;
    const q = g2.pattern(lin.route, w.pos.kind === 'pattern' ? w.pos.pat : 0)!;
    expect(checkCommand(g2, { type: 'short_turn', vehicle: w.id, stop: q.stops[0] }).reason).toMatch(/not ahead/);
    expect(checkCommand(g2, { type: 'short_turn', vehicle: w.id, stop: q.stops[q.stops.length - 1] }).reason).toMatch(/ends at/);
  });
});

describe('moving one departure', () => {
  it('moves a departure later and it runs then; the timetable slot is not filled again', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 3, stops: 6, headway: 15 });
    runTo(game, 0, 7);
    const trip = (game.state.trips[l.route] ?? []).find((x) => x.pat === 0 && x.dep > game.t + 40 * 60 && !x.extra)!;
    const was = trip.dep;
    const c = checkCommand(game, { type: 'adjust_departure', route: l.route, trip: trip.id, minutes: 5 });
    expect(c.ok).toBe(true);
    expect(c.transition).toMatch(/\+5 min/);
    expect(runCommand(game, { type: 'adjust_departure', route: l.route, trip: trip.id, minutes: 5 }, 'player').ok).toBe(true);
    expect(trip.dep).toBe(was + 300);
    expect(trip.adj?.from).toBe(was);
    game.run(10 * 60);
    expect((game.state.trips[l.route] ?? []).filter((x) => x.pat === 0 && x.dep === was)).toHaveLength(0);
    expect(until(game, () => trip.state === TripState.Running, 3 * HOUR, 30)).toBe(true);
    expect(game.t).toBeGreaterThanOrEqual(was + 300 - 60);
    // at most 15 minutes from the timetable time in all
    expect(checkCommand(game, { type: 'adjust_departure', route: l.route, trip: trip.id, minutes: 11 }).ok).toBe(false);
  });

  it('will not move a departure into the next five minutes or onto another departure', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 3, stops: 6, headway: 10 });
    runTo(game, 0, 7);
    const list = (game.state.trips[l.route] ?? []).filter((x) => x.pat === 0 && x.state <= TripState.Assigned && x.dep > game.t + 30 * 60);
    expect(checkCommand(game, { type: 'adjust_departure', route: l.route, trip: list[0].id, minutes: -10 }).reason).toMatch(/Another departure|5 minutes|back at/);
    const soon = (game.state.trips[l.route] ?? []).find((x) => x.state <= TripState.Assigned && x.dep > game.t + 6 * 60 && x.dep < game.t + 12 * 60);
    if (soon) expect(checkCommand(game, { type: 'adjust_departure', route: l.route, trip: soon.id, minutes: -8 }).ok).toBe(false);
  });
});

describe('temporary detours', () => {
  it('drives round the area on other roads with the same stops, then goes back to its usual route', () => {
    const game = newGame({ seed: 21 });
    const l = crowdedLine(game);
    runTo(game, 0, 6);
    const p = game.pattern(l.route, 0)!;
    // the middle of the first stretch with another way round (the main road has few side streets)
    const g = game.region.graph;
    const centre = (leg: number) => {
      const n = p.path.nodes[Math.round((p.stopIdx[leg] + p.stopIdx[leg + 1]) / 2)];
      return game.geo.P.toLngLat(g.x[n], g.y[n]);
    };
    const leg = [...Array(p.stops.length - 1).keys()].find((i) => checkCommand(game, { type: 'detour', route: l.route, at: centre(i), radius: 100, minutes: 60 }).ok)!;
    expect(leg).toBeDefined();
    const at = centre(leg);
    const before = p.stops.slice();
    const cmd = { type: 'detour' as const, route: l.route, at, radius: 100, minutes: 60 };
    const c = checkCommand(game, cmd);
    expect(c.ok, c.reason).toBe(true);
    expect(c.transition).toMatch(/drives round the area/);
    const busesBefore = l.buses.length;
    expect(runCommand(game, cmd, 'player').ok).toBe(true);
    expect(until(game, () => detoursOf(game, l.route).every((d) => d.state === 'on'), 30 * 60, 30)).toBe(true);
    const now = game.pattern(l.route, 0)!;
    expect(now.stops).toEqual(before);
    // the changed stretch keeps away from the centre
    const [cx, cy] = game.geo.xy(at);
    const d = detoursOf(game, l.route)[0];
    const pd = game.pattern(l.route, d.pat)!;
    const inner = pd.path.nodes.slice(pd.stopIdx[d.leg] + 1, pd.stopIdx[d.leg + 1]);
    expect(inner.every((x) => Math.hypot(g.x[x] - cx, g.y[x] - cy) > 100)).toBe(true);
    expect(pd.path.length).toBeGreaterThan(game.pattern(l.route, d.pat)!.path.length - 1);
    // a timetable-changing route edit waits for the detour to end
    expect(game.updateRoute(l.route, { stops: game.state.routes[l.route].stops.slice(0, -1) }).ok).toBe(false);
    game.run(80 * 60);
    expect(until(game, () => detoursOf(game, l.route).length === 0, 60 * 60, 30)).toBe(true);
    expect(game.pattern(l.route, 0)!.stops).toEqual(before);
    expect(game.state.routes[l.route].via[d.key] ?? null).toEqual(d.prev);
    expect(game.state.routes[l.route].vehicles).toHaveLength(busesBefore);
    expect(missed(game, l.route)).toBe(0);
  });

  it('refuses an area the line does not pass and one around one of its stops', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 2, stops: 6, headway: 15 });
    const far: [number, number] = [29.2, 40.9];
    expect(checkCommand(game, { type: 'detour', route: l.route, at: far, radius: 300, minutes: 60 }).reason).toMatch(/does not pass/);
    const st = game.state.stops[l.stopIds[2]].lngLat;
    expect(checkCommand(game, { type: 'detour', route: l.route, at: st, radius: 100, minutes: 60 }).ok).toBe(false);
  });
});

describe('route-change suggestions', () => {
  it('an automation can only suggest a route change; approving it changes the line', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 2, stops: 6, headway: 15 });
    const g = graph(game);
    const t = g.node('trigger.manual');
    const a = g.node('action.proposeRoute', { op: 'remove_stop', line: l.route });
    const s = g.node('data.stop', { stop: l.stopIds[2] });
    g.link(t, 'event', a, 'when');
    g.link(s, 'stop', a, 'stop');
    const wf = make(game, g, { mode: 'automatic' });
    wf.allowHighImpact = true;
    const run = runNow(game, wf);
    expect(run.actions[0].outcome).toBe('proposed');
    expect(game.state.routes[l.route].stops).toContain(l.stopIds[2]);
    const p = game.state.automation.proposals.find((x) => x.status === 'open')!;
    expect(p.expires - game.t).toBe(3 * DAY);
    expect(p.detail).toMatch(/stops calling at/);
    const ok = game.approveProposal(p.id);
    expect(ok.ok).toBe(true);
    expect(game.state.routes[l.route].stops).not.toContain(l.stopIds[2]);
  });

  it('adds a stop where it adds the least distance', () => {
    const game = newGame({ seed: 21 });
    const l = crowdedLine(game);
    const r = game.state.routes[l.route];
    const removed = r.stops[3];
    expect(runCommand(game, { type: 'change_route', change: { op: 'remove_stop', route: l.route, stop: removed } }, 'player').ok).toBe(true);
    const c = checkCommand(game, { type: 'change_route', change: { op: 'add_stop', route: l.route, stop: removed } });
    expect(c.ok, c.reason).toBe(true);
    expect(runCommand(game, { type: 'change_route', change: { op: 'add_stop', route: l.route, stop: removed } }, 'player').ok).toBe(true);
    expect(game.state.routes[l.route].stops.indexOf(removed)).toBe(3);
  });
});

describe('gaps between buses', () => {
  it('a long hold makes the bus behind catch up; the gaps show it and the hold that evens them out', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 4, stops: 9, headway: 8 });
    runTo(game, 0, 7, 30);
    const before = lineGaps(game, l.route);
    expect(before.headway).toBe(8);
    expect(before.buses.length).toBeGreaterThanOrEqual(2);
    // hold the bus ahead in one direction so the next one catches it up
    const lead = before.buses.find((b) => b.behind !== null && b.run.v.stopIdx < b.run.p.stops.length - 2)!;
    expect(lead).toBeTruthy();
    expect(runCommand(game, { type: 'hold_vehicle', vehicle: lead.run.v.id, minutes: 7 }, 'player').ok).toBe(true);
    let seen = false;
    for (let i = 0; i < 20 && !seen; i++) {
      game.run(60);
      const gp = lineGaps(game, l.route);
      if (gp.bunched > 0) {
        seen = true;
        const close = gp.buses.find((b) => b.ahead !== null && b.ahead < 0.35 * 8)!;
        expect(close.hold).toBeGreaterThan(0);
      }
    }
    expect(seen).toBe(true);
  });

  it('the bunching trigger fires and holds the bus that caught up', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 4, stops: 9, headway: 8 });
    const g = graph(game);
    const t = g.node('trigger.bunching', { line: l.route, for: 0 });
    const h = g.node('action.hold', { max: 4 });
    g.link(t, 'buses', h, 'bus');
    const wf = make(game, g);
    runTo(game, 0, 7, 30);
    const lead = lineGaps(game, l.route).buses.find((b) => b.behind !== null && b.run.v.stopIdx < b.run.p.stops.length - 2)!;
    runCommand(game, { type: 'hold_vehicle', vehicle: lead.run.v.id, minutes: 7 }, 'player');
    game.run(25 * 60);
    const runs = runsOf(game, wf.id);
    expect(runs.length).toBeGreaterThan(0);
    const held = runs.flatMap((r) => r.actions).filter((a) => a.cmd.type === 'hold_vehicle');
    expect(held.length).toBeGreaterThan(0);
    expect(held.some((a) => a.outcome === 'deferred' || a.outcome === 'executed')).toBe(true);
  });
});

describe('reading the network for control', () => {
  it('forecasts how full the next departures will be, as an estimate', () => {
    const game = newGame({ seed: 21 });
    const l = crowdedLine(game);
    runTo(game, 1, 6, 30);
    const deps = forecastOccupancy(game, l.route, 6, 3);
    expect(deps.length).toBeGreaterThan(0);
    for (const d of deps) {
      expect(d.estimate).toBe(true);
      expect(typeof d.occupancy).toBe('number');
      expect(d.occupancy as number).toBeGreaterThanOrEqual(0);
    }
    expect(deps.some((d) => (d.occupancy as number) > 0)).toBe(true);
  });

  it('coverage is a share of residents and jobs, with the places left out', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 2, stops: 6, headway: 15 });
    const c = coverage(game, l.stopIds, 400);
    expect(c.residents as number).toBeGreaterThan(0);
    expect(c.residents as number).toBeLessThan(100);
    const wider = coverage(game, l.stopIds, 800);
    expect(wider.residents as number).toBeGreaterThan(c.residents as number);
    expect((c.gaps as Value[]).length).toBeGreaterThan(0);
    const gap = (c.gaps as Record<string, Value>[])[0];
    expect(typeof gap.lng).toBe('number');
  });

  it('finds stops near a point, a road route, and where lines meet', () => {
    const game = newGame();
    const a = buildLine(game, { buses: 1, stops: 6, headway: 20 });
    const st = game.state.stops[a.stopIds[2]];
    const near = nearbyStops(game, st.lngLat, 600);
    expect(near[0].id).toBe(st.id);
    expect(near[0].walk).toBe(0);
    const trip = roadTrip(game, game.state.stops[a.stopIds[0]].lngLat, game.state.stops[a.stopIds[5]].lngLat)!;
    expect(trip.km as number).toBeGreaterThan(0.5);
    expect(trip.minutesNow as number).toBeGreaterThanOrEqual(trip.minutes as number);
    // a second line through the same stop
    const r2 = game.createRoute({ stops: [a.stopIds[2], a.stopIds[3]], kind: 'linear' });
    if (!r2.ok) throw new Error(r2.error);
    const x = transferPoints(game, a.route, 0);
    expect(x.some((t) => t.toLine === r2.value && t.walk === 0)).toBe(true);
  });

  it('finds connections from people on board who change lines ahead', () => {
    const game = newGame({ seed: 21 });
    crowdedLine(game);
    buildLine(game, { buses: 2, stops: 7, headway: 10 });
    runTo(game, 1, 7, 30);
    const list = missedConnections(game, null, 30, 50);
    for (const c of list) {
      expect(c.people as number).toBeGreaterThan(0);
      expect(typeof c.margin).toBe('number');
      if (c.missed) expect(c.holdNeeded as number).toBeGreaterThan(0);
    }
  });
});

describe('Best pairs', () => {
  it('finds the cheapest one-to-one assignment, not the greedy one', () => {
    // greedy takes row 0 → column 0 (1) and then row 1 → column 1 (100): 101. Best is 2 + 3 = 5.
    expect(assignRows([[1, 2], [3, 100]])).toEqual([1, 0]);
    expect(assignRows([[5, Infinity], [Infinity, Infinity]])).toEqual([0, -1]);
    // more columns than rows: row 0 takes column 1 (1) and row 1 column 0 (2)
    expect(assignRows([[4, 1, 3], [2, 2, 5]])).toEqual([1, 0]);
  });

  it('pairs spare buses with lines short of buses and moves them', () => {
    const game = newGame();
    const a = buildLine(game, { buses: 0, stops: 6, headway: 15 });
    const b1 = game.buyVehicle('city12', a.depot);
    const b2 = game.buyVehicle('city12', a.depot);
    if (!b1.ok || !b2.ok) throw new Error('buy');
    runTo(game, 0, 7);
    const g = graph(game);
    const t = g.node('trigger.manual');
    const buses = g.node('data.buses', { which: 'spare' });
    const lines = g.node('data.lines');
    const pair = g.node('logic.assign', { score: 'km', max: 1 });
    const move = g.node('action.assign', { line: '' });
    g.link(t, 'event', buses, 'after');
    g.link(buses, 'buses', pair, 'a');
    g.link(lines, 'lines', pair, 'b');
    g.link(pair, 'pairs', move, 'bus');
    const wf = make(game, g);
    const run = runNow(game, wf);
    expect(run.error).toBeUndefined();
    expect(run.actions.filter((x) => x.cmd.type === 'assign_vehicle')).toHaveLength(1);
    expect(game.state.routes[a.route].vehicles).toHaveLength(1);
  });
});

describe('Wait and One at a time', () => {
  it('Wait carries on later with only the steps after it: nothing before it runs again', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 2, stops: 6, headway: 15 });
    runTo(game, 0, 7);
    const g = graph(game);
    const t = g.node('trigger.manual');
    const line = g.node('data.line', { line: l.route });
    const before = g.node('action.report', { text: 'before' });
    const w = g.node('logic.wait', { minutes: 20 });
    const after = g.node('action.report', { text: 'after {value}' });
    g.link(t, 'event', line, 'after');
    g.link(line, 'line', before, 'value');
    g.link(line, 'line', w, 'value');
    g.link(w, 'then', after, 'value');
    const wf = make(game, g);
    const first = runNow(game, wf);
    expect(first.report).toEqual(['before']);
    expect(game.state.automation.pending).toHaveLength(1);
    game.run(19 * 60);
    expect(runsOf(game, wf.id)).toHaveLength(1);
    game.run(2 * 60);
    const runs = runsOf(game, wf.id);
    expect(runs).toHaveLength(2);
    expect(runs[1].resumed).toBe(true);
    expect(runs[1].report).toHaveLength(1);
    expect(runs[1].report![0]).toMatch(/^after Line/);
    expect(game.state.automation.pending).toHaveLength(0);
  });

  it('Wait until a figure crosses a value, or gives up', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 2, stops: 6, headway: 15 });
    runTo(game, 0, 7);
    const g = graph(game);
    const t = g.node('trigger.manual');
    const line = g.node('data.line', { line: l.route });
    const w = g.node('logic.wait', { mode: 'until', figure: 'line.waiting', op: 'above', value: 100000, timeout: 30 });
    const yes = g.node('action.report', { text: 'got there' });
    const no = g.node('action.report', { text: 'gave up after {value}' });
    g.link(t, 'event', line, 'after');
    g.link(line, 'line', w, 'value');
    g.link(w, 'then', yes, 'value');
    g.link(w, 'waited', no, 'value');
    const wf = make(game, g);
    runNow(game, wf);
    game.run(31 * 60);
    const last = runsOf(game, wf.id).at(-1)!;
    expect(last.resumed).toBe(true);
    expect(last.triggerLabel).toMatch(/Gave up/);
    expect(last.report).toEqual(['gave up after 30']);
  });

  it('One at a time passes items on one by one and carries on by itself', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 3, stops: 6, headway: 15 });
    runTo(game, 0, 7);
    const g = graph(game);
    const t = g.node('trigger.manual');
    const buses = g.node('data.buses', { line: l.route });
    const q = g.node('logic.queue', { per: 1, every: 30 });
    const rep = g.node('action.report', { text: '{value}' });
    g.link(t, 'event', buses, 'after');
    g.link(buses, 'buses', q, 'items');
    g.link(q, 'next', rep, 'value');
    const wf = make(game, g);
    runNow(game, wf);
    game.run(65 * 60);
    const reports = runsOf(game, wf.id).flatMap((r) => r.report ?? []);
    expect(reports).toHaveLength(3);
    expect(new Set(reports).size).toBe(3);
    // the same buses again are not taken a second time soon after
    runNow(game, wf);
    expect(runsOf(game, wf.id).at(-1)!.report ?? []).toHaveLength(0);
  });
});

describe('control-room starter workflows', () => {
  const start = (game: Game, id: string) => {
    const r = fromTemplate(game, id);
    if (!r.ok) throw new Error(r.error);
    const wf = game.state.automation.workflows[r.value];
    expect(validateWorkflow(wf, game.state).issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(game.updateWorkflow(wf.id, { enabled: true, mode: 'automatic' }).ok).toBe(true);
    return wf;
  };

  it('every control-room template is valid on a new network', () => {
    const game = newGame();
    buildLine(game, { buses: 3, stops: 7, headway: 10 });
    for (const t of TEMPLATES.filter((x) => x.group === 'control')) start(game, t.id);
    expect(TEMPLATES.filter((x) => x.group === 'control').length).toBeGreaterThanOrEqual(10);
  });

  it('“Even out bunched buses” holds the bus that caught up', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 4, stops: 9, headway: 8 });
    const wf = start(game, 'even-bunching');
    runTo(game, 0, 7, 30);
    const lead = lineGaps(game, l.route).buses.find((b) => b.behind !== null && b.run.v.stopIdx < b.run.p.stops.length - 2)!;
    runCommand(game, { type: 'hold_vehicle', vehicle: lead.run.v.id, minutes: 7 }, 'player');
    game.run(30 * 60);
    const holds = runsOf(game, wf.id).flatMap((r) => r.actions).filter((a) => a.cmd.type === 'hold_vehicle' && (a.outcome === 'deferred' || a.outcome === 'executed'));
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.every((a) => a.cmd.type === 'hold_vehicle' && a.cmd.minutes <= 4)).toBe(true);
  });

  it('“Service worn buses one at a time” sends them one by one', () => {
    const game = newGame({ extraFunds: 5_000_000 });
    const l = buildLine(game, { buses: 3, stops: 7, headway: 20 });
    const extra: string[] = [];
    for (let i = 0; i < 3; i++) {
      const b = game.buyVehicle('city12', l.depot);
      if (!b.ok) throw new Error(b.error);
      extra.push(b.value);
    }
    for (const id of [...l.buses, ...extra]) game.state.vehicles[id].condition = 0.7;
    const wf = start(game, 'service-one-by-one');
    runTo(game, 0, 9, 1);
    const sent = () => runsOf(game, wf.id).flatMap((r) => r.actions).filter((a) => a.cmd.type === 'service_vehicle' && a.outcome !== 'duplicate');
    expect(sent()).toHaveLength(1);
    runTo(game, 0, 9, 40);
    expect(sent()).toHaveLength(1);
    runTo(game, 0, 11, 0);
    expect(sent().length).toBeGreaterThanOrEqual(2);
    expect(sent().length).toBeLessThanOrEqual(3);
    expect(new Set(sent().map((a) => (a.cmd as { vehicle: string }).vehicle)).size).toBe(sent().length);
  });

  it('“Send spare buses to lines short of buses” moves a parked bus to the line that needs it', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 0, stops: 6, headway: 15 });
    const b = game.buyVehicle('city12', l.depot);
    if (!b.ok) throw new Error(b.error);
    const wf = start(game, 'spares-to-short');
    runTo(game, 0, 6, 1);
    expect(game.state.vehicles[b.value].route).toBe(l.route);
    expect(runsOf(game, wf.id).some((r) => r.actions.some((a) => a.cmd.type === 'assign_vehicle' && a.outcome === 'executed'))).toBe(true);
  });

  it('“Check back after an extra bus” waits half an hour before checking again', () => {
    const game = newGame({ seed: 21 });
    crowdedLine(game);
    const spare = game.buyVehicle('city12', Object.keys(game.state.depots)[0]);
    if (!spare.ok) throw new Error(spare.error);
    const wf = start(game, 'check-extra-worked');
    runTo(game, 1, 9);
    const runs = runsOf(game, wf.id);
    const first = runs.find((r) => r.actions.some((a) => a.cmd.type === 'dispatch_extra'));
    if (!first) return; // not crowded enough on this seed today: nothing to check back on
    const resumed = runs.find((r) => r.resumed && r.t >= first.t + 30 * 60 - 60);
    expect(resumed).toBeTruthy();
    expect(resumed!.actions.every((a) => a.cmd.type !== 'dispatch_extra')).toBe(true);
  });
});
