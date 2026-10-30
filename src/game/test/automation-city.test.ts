// Automation for the weather, the calendar and events (docs/city-activity-engine-plan.md,
// section 12): triggers, data nodes, switching a service plan, and the starter workflows.
import { describe, expect, it } from 'vitest';
import { Game } from '../engine.ts';
import { buildLine, newGame, region, stopsAlong } from './helpers.ts';
import { DAY, HOUR } from '../content.ts';
import { defaultConfig } from '../automation/registry.ts';
import { validateWorkflow } from '../automation/validate.ts';
import { TEMPLATES, fromTemplate } from '../automation/templates.ts';
import { WEATHER_LABEL } from '../weather.ts';
import type { GameEvent } from '../events.ts';
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

function make(game: Game, name: string, g: ReturnType<typeof graph>, patch: Partial<Pick<Workflow, 'mode' | 'allowHighImpact'>> = {}) {
  const r = game.createWorkflow({ name, nodes: g.nodes, edges: g.edges });
  if (!r.ok) throw new Error(r.error);
  const u = game.updateWorkflow(r.value, { enabled: true, mode: 'automatic', ...patch });
  if (!u.ok) throw new Error(u.error);
  expect(validateWorkflow(game.state.automation.workflows[r.value], game.state).issues.filter((i) => i.level === "error").map((i) => i.message)).toEqual([]);
  return game.state.automation.workflows[r.value];
}

const runsOf = (game: Game, wf: string) => game.state.automation.runs.filter((r) => r.wf === wf && !r.test);

function withEvents(g: Game, events: GameEvent[]) {
  const e = g.state.world.events!;
  e.list = events.map((x) => ({ ...x }));
  e.through = 100000;
  (g as unknown as { eventNext: number }).eventNext = 0; // the event clock looks at the new list next minute
}

describe('starter workflows for events and the weather', () => {
  it('every template builds from library nodes and validates', () => {
    const game = newGame({ extraFunds: 500_000 });
    buildLine(game, { buses: 2, stops: 6 });
    for (const t of TEMPLATES) {
      const r = fromTemplate(game, t.id);
      expect(r.ok, t.id).toBe(true);
      if (!r.ok) continue;
      const wf = game.state.automation.workflows[r.value];
      expect(validateWorkflow(wf, game.state).issues.filter((i) => i.level === "error").map((i) => i.message), t.id).toEqual([]);
    }
  });
});

describe('weather triggers', () => {
  it('the forecast trigger runs at 18:00 with tomorrow’s forecast, and only for the weather it asks for', () => {
    const game = newGame();
    const g = graph(game);
    const t = g.node('trigger.forecast', { when: 'any' });
    const n = g.node('action.report', { text: '{value.label}, {value.high}' });
    g.link(t, 'forecast', n, 'value');
    const wf = make(game, 'forecast', g);
    const g2 = graph(game);
    g2.node('trigger.forecast', { when: 'storm' });
    const storm = make(game, 'storm only', g2);
    game.run(18 * HOUR + 120 - game.t);
    const runs = runsOf(game, wf.id);
    expect(runs.length).toBe(1);
    expect(runs[0].t % DAY).toBe(18 * HOUR + 60);
    const f = game.weatherDay(1)!.forecast!;
    expect(runs[0].report?.[0]).toBe(`${WEATHER_LABEL[f.kind]}, ${f.hi}`);
    expect(runsOf(game, storm.id).length).toBe(f.kind === 'heavy' || f.kind === 'snow' ? 1 : 0);
  });

  it('the weather trigger runs when rain starts and when it stops, within its hours', () => {
    const game = newGame();
    const w = game.weatherDay(0)!;
    // a day with rain from 09:00 to 12:00
    w.actual = { ...w.actual, kind: 'rain', mm: Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 12 ? 2 : 0)) };
    const g = graph(game);
    g.node('trigger.weather', { when: 'rain' });
    const starts = make(game, 'rain starts', g);
    const g2 = graph(game);
    g2.node('trigger.weather', { when: 'dry' });
    const stops = make(game, 'rain stops', g2);
    const g3 = graph(game);
    g3.node('trigger.weather', { when: 'rain', from: 13, to: 20 });
    const later = make(game, 'afternoon only', g3);
    game.run(14 * HOUR - game.t);
    expect(runsOf(game, starts.id).map((r) => Math.floor((r.t % DAY) / HOUR))).toEqual([9]);
    expect(runsOf(game, stops.id).map((r) => Math.floor((r.t % DAY) / HOUR))).toEqual([12]);
    expect(runsOf(game, later.id).length).toBe(0);
    expect(runsOf(game, starts.id)[0].triggerLabel).toBe('Rain from 09:00');
  });
});

describe('event triggers', () => {
  const stadiumSetup = () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const p = (game.region.cityPlaces ?? []).find((x) => x.name === 'Tüpraş Stadyumu')!;
    const pts = stopsAlong(game, [28.9925, 41.067], p.lngLat).slice(4);
    const d = game.buildDepot([28.9885, 41.0455]);
    if (!d.ok) throw new Error(d.error);
    const stops = pts.map((x) => game.placeStop(x)).filter((r) => r.ok).map((r) => (r as { value: string }).value);
    const r = game.createRoute({ stops, timetable: { weekday: { bands: [{ from: 300, to: 1500, headway: 10 }] }, weekend: { bands: [{ from: 300, to: 1500, headway: 10 }] }, layover: 3 } });
    if (!r.ok) throw new Error(r.error);
    for (let i = 0; i < 6; i++) {
      const b = game.buyVehicle('city12', d.value);
      if (b.ok) game.assignVehicle(b.value, r.value);
    }
    const start = DAY + 19 * HOUR;
    const ev: GameEvent = { id: 'm1', kind: 'football', place: p.id, venue: p.name, at: p.lngLat, title: `Football match at ${p.name}`, start, end: start + 115 * 60, people: 30000, ann: DAY + 9 * HOUR };
    // the same evening, a match at a stadium more than 1.5 km from every stop of the line
    const stopXY = stops.map((id) => game.geo.xy(game.state.stops[id].lngLat));
    const gap = (ll: [number, number]) => { const [x, y] = game.geo.xy(ll); return Math.min(...stopXY.map(([sx, sy]) => Math.hypot(sx - x, sy - y))); };
    const far = (game.region.cityPlaces ?? []).filter((x) => x.category === 'stadium' && x.reachable && gap(x.lngLat) > 1500)[0];
    expect(far).toBeTruthy();
    const away: GameEvent = { ...ev, id: 'm2', place: far.id, venue: far.name, at: far.lngLat, title: `Football match at ${far.name}`, start: start + 30 * 60, end: start + 145 * 60, people: 20000 };
    withEvents(game, [ev, away]);
    return { game, route: r.value, ev, away };
  };

  it('announced, before the start and at the end: once each, with the lines near the venue', { timeout: 120000 }, () => {
    const { game, route, ev, away } = stadiumSetup();
    const g = graph(game);
    const a = g.node('trigger.eventAnnounced', { kinds: 'football', people: 5000 });
    const ra = g.node('action.report', { text: '{value.title}: {value.people}' });
    g.link(a, 'details', ra, 'value');
    const s = g.node('trigger.eventStart', { minutes: 60, kinds: 'crowds', people: 3000, line: route });
    const ds = g.node('action.dispatch');
    g.link(s, 'lines', ds, 'line');
    const e = g.node('trigger.eventEnd', { minutes: -10, kinds: 'crowds', people: 3000 });
    const de = g.node('action.dispatch');
    g.link(e, 'lines', de, 'line');
    const small = g.node('trigger.eventStart', { minutes: 60, kinds: 'crowds', people: 50000 });
    const rs = g.node('action.report', { text: 'never' });
    g.link(small, 'event', rs, 'value');
    const wf = make(game, 'match day', g, { limits: { runsPerHour: 120 } } as never);
    game.run(2 * DAY + 2 * HOUR - game.t);
    const runs = runsOf(game, wf.id);
    const at = (node: string) => runs.filter((r) => r.trigger === node).map((r) => r.t);
    expect(at(a)).toEqual([ev.ann, away.ann]);
    expect(runs.find((r) => r.trigger === a)!.report).toEqual([`${ev.title}: 30000`]);
    // the start trigger is set to the line near the stadium; the end trigger hears both matches
    expect(at(s)).toEqual([ev.start - HOUR]);
    expect(at(e)).toEqual([ev.end - 10 * 60, away.end - 10 * 60]);
    // far from every line: the run is fine and asks for nothing
    const farRun = runs.filter((r) => r.trigger === e)[1];
    expect(farRun.status).toBe('ok');
    expect(farRun.actions).toEqual([]);
    expect(at(small)).toEqual([]);
    // the extra departures were asked for on the line near the stadium
    for (const node of [s, e]) {
      const run = runs.find((r) => r.trigger === node)!;
      expect(run.actions.length).toBe(1);
      expect(run.actions[0].cmd).toMatchObject({ type: 'dispatch_extra', route });
    }
    // a reload carries on identically (no trigger fires twice)
    const copy = new Game(JSON.parse(game.serialize()), region());
    game.run(DAY);
    copy.run(DAY);
    expect(JSON.stringify(copy.state.automation)).toBe(JSON.stringify(game.state.automation));
  });
});

describe('the calendar, data nodes and service plans', () => {
  it('the calendar trigger runs on the first day of a kind', () => {
    const game = newGame();
    const g = graph(game);
    g.node('trigger.calendar', { day: 'weekend', time: '06:00', first: true });
    const first = make(game, 'weekend starts', g);
    const g2 = graph(game);
    g2.node('trigger.calendar', { day: 'weekend', time: '06:00', first: false });
    const every = make(game, 'every weekend day', g2);
    game.run(7 * DAY + 7 * HOUR - game.t);
    const days = (id: string) => runsOf(game, id).map((r) => Math.floor(r.t / DAY));
    // day 0 is a Monday
    expect(days(first.id)).toEqual([5]);
    expect(days(every.id)).toEqual([5, 6]);
  });

  it('data nodes read the weather, the calendar and coming events', () => {
    const game = newGame();
    game.run(19 * HOUR - game.t);
    const g = graph(game);
    const t = g.node('trigger.manual');
    const w = g.node('data.weather');
    const c = g.node('data.calendar');
    const ev = g.node('data.events', { hours: '240', kinds: 'any' });
    for (const n of [w, c, ev]) g.link(t, 'event', n, 'after');
    const rw = g.node('action.report', { text: '{value.label}' });
    g.link(w, 'tomorrow', rw, 'value');
    const rc = g.node('action.report', { text: '{value.season} {value.seasonWeek}' });
    g.link(c, 'calendar', rc, 'value');
    const re = g.node('action.report', { text: '{value} events' });
    g.link(ev, 'count', re, 'value');
    const wf = make(game, 'read', g);
    const run = game.runWorkflowNow(wf.id, { test: false });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const f = game.weatherDay(1)!.forecast!;
    const coming = game.upcomingEvents().filter((x) => x.start <= game.t + 240 * HOUR).length;
    expect(run.value.report).toEqual([WEATHER_LABEL[f.kind], 'Autumn 1', `${coming} events`]);
  });

  it('switches a manual service plan on a line, as a big change that needs permission', () => {
    const game = newGame({ extraFunds: 500_000 });
    const line = buildLine(game, { buses: 3, stops: 7, headway: 12 });
    const r = game.state.routes[line.route];
    const rain = { id: 'p1', name: 'Rain', enabled: true, when: { kind: 'manual' as const, on: false }, weekday: { bands: [{ from: 300, to: 1500, headway: 6 }] }, weekend: { bands: [{ from: 300, to: 1500, headway: 6 }] } };
    expect(game.setServicePlans(line.route, [rain]).ok).toBe(true);
    game.run(HOUR);
    const g = graph(game);
    const t = g.node('trigger.manual');
    const on = g.node('action.servicePlan', { line: line.route, plan: 'rain', on: 'on' });
    g.link(t, 'event', on, 'when');
    const careful = make(game, 'careful', g);
    const run1 = game.runWorkflowNow(careful.id, { test: false });
    expect(run1.ok && run1.value.actions[0].outcome).toBe('proposed');
    expect(game.dayPlan(line.route, 0).planId).toBeNull();
    const g2 = graph(game);
    const t2 = g2.node('trigger.manual');
    const on2 = g2.node('action.servicePlan', { line: line.route, plan: 'Rain', on: 'on' });
    g2.link(t2, 'event', on2, 'when');
    const allowed = make(game, 'allowed', g2, { allowHighImpact: true });
    const run2 = game.runWorkflowNow(allowed.id, { test: false });
    expect(run2.ok && run2.value.actions[0].outcome).toBe('executed');
    expect(game.dayPlan(line.route, 0).planId).toBe('p1');
    expect(game.headwayAt(line.route, 0, game.t + HOUR)).toBe(6);
    // a plan that does not exist is refused with the reason
    const g3 = graph(game);
    const t3 = g3.node('trigger.manual');
    const bad = g3.node('action.servicePlan', { line: line.route, plan: 'Snow', on: 'on' });
    g3.link(t3, 'event', bad, 'when');
    const wf3 = make(game, 'bad', g3, { allowHighImpact: true });
    const run3 = game.runWorkflowNow(wf3.id, { test: false });
    expect(run3.ok && run3.value.actions[0].outcome).toBe('rejected');
    expect(run3.ok && run3.value.actions[0].reason).toMatch(/no service plan called "Snow"/);
    expect(r.number).toBeTruthy();
  });
});
