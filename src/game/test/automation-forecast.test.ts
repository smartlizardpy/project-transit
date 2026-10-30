// The demand forecast, places and unserved-trips blocks, and the three starter workflows that use
// them (docs/city-activity-engine-plan.md, section 12). Forecasts are estimates: these tests check
// they track what then happens, count only what the player can know, and change nothing.
import { describe, expect, it } from 'vitest';
import { Game } from '../engine.ts';
import { buildLine, newGame, region, stopsAlong } from './helpers.ts';
import { DAY, HOUR } from '../content.ts';
import { defaultConfig } from '../automation/registry.ts';
import { validateWorkflow } from '../automation/validate.ts';
import { TEMPLATES, fromTemplate } from '../automation/templates.ts';
import { demandForecast, placeRec, placesOf } from '../automation/city.ts';
import type { GameEvent } from '../events.ts';
import type { Rec } from '../automation/live.ts';
import type { Value, WfEdge, WfNode } from '../automation/types.ts';

const STADIUM = 'Tüpraş Stadyumu';
const sum = (a: number[] | undefined) => (a ?? []).reduce((x, y) => x + y, 0);

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

function runOnce(game: Game, g: ReturnType<typeof graph>) {
  const r = game.createWorkflow({ name: 'read', nodes: g.nodes, edges: g.edges });
  if (!r.ok) throw new Error(r.error);
  expect(validateWorkflow(game.state.automation.workflows[r.value], game.state).issues.filter((i) => i.level === 'error').map((i) => i.message)).toEqual([]);
  const run = game.runWorkflowNow(r.value, { test: false });
  if (!run.ok) throw new Error(run.error);
  return run.value;
}

function twoLines(extra = 900_000) {
  const g = newGame({ extraFunds: extra });
  buildLine(g, { buses: 4, stops: 8, headway: 8 });
  buildLine(g, { from: [28.99, 41.05], buses: 3, stops: 7, headway: 10 });
  return g;
}

describe('demand forecast', () => {
  it('tracks the boardings that follow within a third, line by line', () => {
    const g = twoLines();
    g.run(DAY + 9 * HOUR - g.t);
    const f = demandForecast(g, 3)!;
    expect(f.hours.map((h) => h.time)).toEqual(['09:00', '10:00', '11:00']);
    const before = Object.fromEntries(Object.keys(g.state.routes).map((id) => [id, sum(g.state.analytics.today.routes[id]?.b)]));
    g.run(3 * HOUR);
    for (const l of f.lines) {
      const seen = sum(g.state.analytics.today.routes[l.id as string]?.b) - before[l.id as string];
      expect(seen).toBeGreaterThan(30);
      expect(Math.abs((l.riders as number) - seen) / seen, `line ${l.number}: forecast ${l.riders}, then ${seen}`).toBeLessThan(0.34);
      expect((l.hours as Rec[]).length).toBe(3);
      expect(l.estimate).toBe(true);
    }
  });

  it('changes nothing the simulation uses', () => {
    const a = twoLines(), b = twoLines();
    for (const g of [a, b]) g.run(DAY + 8.5 * HOUR - g.t);
    // a rail closure makes the model switch transit skims: the forecast must put them back
    for (let i = 0; i < 3; i++) demandForecast(a, 6);
    a.demand.forecastLines(a, a.t + 2 * HOUR, 4);
    for (const g of [a, b]) g.run(4 * HOUR);
    expect(a.counters.generated).toBe(b.counters.generated);
    expect(JSON.stringify(a.state.pax)).toBe(JSON.stringify(b.state.pax));
    expect(JSON.stringify(a.state.analytics.today)).toBe(JSON.stringify(b.state.analytics.today));
  });

  it('counts an event only once it is announced, and stops at midnight', () => {
    const g = newGame({ extraFunds: 900_000 });
    const p = (g.region.cityPlaces ?? []).find((x) => x.name === STADIUM)!;
    const pts = stopsAlong(g, [28.9925, 41.067], p.lngLat).slice(4);
    const d = g.buildDepot([28.9885, 41.0455]);
    if (!d.ok) throw new Error(d.error);
    const stops = pts.map((x) => g.placeStop(x)).filter((r) => r.ok).map((r) => (r as { value: string }).value);
    const r = g.createRoute({ stops, timetable: { weekday: { bands: [{ from: 300, to: 1500, headway: 6 }] }, weekend: { bands: [{ from: 300, to: 1500, headway: 6 }] }, layover: 3 } });
    if (!r.ok) throw new Error(r.error);
    for (let i = 0; i < 6; i++) { const v = g.buyVehicle('city12', d.value); if (v.ok) g.assignVehicle(v.value, r.value); }
    g.run(DAY + 16 * HOUR - g.t);
    const start = DAY + 19 * HOUR;
    const ev: GameEvent = { id: 'm1', kind: 'football', place: p.id, venue: p.name, at: p.lngLat, title: `Football match at ${p.name}`, start, end: start + 115 * 60, people: 30000, ann: g.t + HOUR };
    const e = g.state.world.events!;
    e.list = [ev];
    e.through = 100000;
    const hidden = demandForecast(g, 6)!;
    e.list[0] = { ...ev, ann: g.t - HOUR, announced: 1 };
    g.rev++; // a new announcement: the cached forecast is stale
    const known = demandForecast(g, 6)!;
    expect(known.total).toBeGreaterThan(hidden.total * 1.3);
    expect(known.hours.map((h) => h.time)).toEqual(['16:00', '17:00', '18:00', '19:00', '20:00', '21:00']);
    g.run(5 * HOUR); // 21:00: six hours would run past midnight
    const late = demandForecast(g, 6)!;
    expect(late.hours.length).toBe(3);
    expect(late.clipped).toBe(true);
  });

  it('the block reports an estimate and its busiest line', () => {
    const g = twoLines();
    g.run(DAY + 8 * HOUR - g.t);
    const w = graph(g);
    const t = w.node('trigger.manual');
    const f = w.node('data.demandForecast', { hours: '3' });
    w.link(t, 'event', f, 'after');
    const rep = w.node('action.report', { text: 'top {value.label} {value.busiestHour}' });
    w.link(f, 'busiest', rep, 'value');
    const run = runOnce(g, w);
    expect(run.status).toBe('ok');
    expect(run.trace?.find((s) => s.node === f)?.note).toMatch(/^Estimate: about [\d,]+ boardings on your network in the next 3 hours, busiest Line \d+ at \d\d:00/);
    expect(run.report?.[0]).toMatch(/^top Line \d+ \d\d:00$/);
  });
});

describe('places and unserved trips', () => {
  it('lists places of a kind with your nearest stop and the lines there', () => {
    const g = twoLines();
    g.run(HOUR);
    const line = Object.keys(g.state.routes)[0];
    const near = placesOf(g, 'any', line, 20);
    expect(near.length).toBeGreaterThan(0);
    const recs = near.map((p) => placeRec(g, p));
    const served = recs.find((r) => r.served);
    expect(served, 'a place within a short walk of the line').toBeTruthy();
    expect(served!.lines).toContain(line);
    expect((served!.walk as number) <= 400).toBe(true);
    for (const r of recs) expect(r.estimate).toBe(true);
    // sizes: largest tier first
    const tiers = near.map((p) => p.scale.tier);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
  });

  it('the airport boost does nothing while no line stops at the airport; unserved trips name a connection', () => {
    const g = twoLines();
    g.run(DAY + 5 * HOUR - g.t);
    const airport = placesOf(g, 'airport', undefined, 1)[0];
    expect(airport).toBeTruthy();
    expect(placeRec(g, airport).lines).toEqual([]);
    const made = fromTemplate(g, 'airport-early');
    if (!made.ok) throw new Error(made.error);
    const run = g.runWorkflowNow(made.value, { test: false });
    expect(run.ok && run.value.status).toBe('ok');
    if (run.ok) expect(run.value.actions).toEqual([]);

    const w = graph(g);
    const t = w.node('trigger.manual');
    const u = w.node('data.unserved', { limit: 3 });
    w.link(t, 'event', u, 'after');
    const rep = w.node('action.report', { text: '{value.label}' });
    w.link(u, 'first', rep, 'value');
    const res = runOnce(g, w);
    expect(res.trace?.find((s) => s.node === u)?.note).toMatch(/^Estimate: about [\d,]+ trips a day between your areas that your network does not link; the busiest is .+ → .+ \(about [\d,]+\)\.$/);
    const [from, to] = res.report![0].split(' → ');
    expect(from && to && from !== to).toBe(true);
  });
});

describe('the school holidays check', () => {
  it('counts the lines without a school-holiday plan and says so', () => {
    const g = twoLines();
    const [a] = Object.keys(g.state.routes);
    const plan = { id: 'p1', name: 'School holidays', enabled: true, when: { kind: 'school_holidays' as const }, weekday: { bands: [{ from: 360, to: 1380, headway: 12 }] }, weekend: { bands: [{ from: 360, to: 1380, headway: 15 }] } };
    expect(g.setServicePlans(a, [plan]).ok).toBe(true);
    g.run(HOUR);
    const made = fromTemplate(g, 'school-holidays');
    if (!made.ok) throw new Error(made.error);
    const run = g.runWorkflowNow(made.value, { test: false });
    expect(run.ok && run.value.status).toBe('ok');
    const n = g.state.notifications.at(-1)!;
    expect(n.title).toBe('School holidays from today');
    expect(n.body).toMatch(/^1 of your lines run their term-time timetable/);
  });

  it('every new template validates on a fresh company', () => {
    const g = newGame();
    for (const id of ['school-holidays', 'airport-early', 'unserved-corridors', 'busy-hour-ahead']) {
      expect(TEMPLATES.some((t) => t.id === id)).toBe(true);
      const made = fromTemplate(g, id);
      expect(made.ok, id).toBe(true);
      if (made.ok) expect(validateWorkflow(g.state.automation.workflows[made.value], g.state).issues.filter((i) => i.level === 'error')).toEqual([]);
    }
    void region;
  });
});
