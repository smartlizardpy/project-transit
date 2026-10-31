// Peak hours in automation: timetable and riders peaks, the "Peak hours start or end" trigger,
// buses to borrow from spares and from lines that peak at another time, parking buses a line no
// longer needs, comparing two lines' peaks, Pick the highest or lowest, For each item, and the
// starter workflows built on them.
import { describe, expect, it } from 'vitest';
import { Game } from '../engine.ts';
import { buildLine, crowdedLine, newGame, region } from './helpers.ts';
import { DAY, HOUR } from '../content.ts';
import { defaultConfig, triggerLabel } from '../automation/registry.ts';
import { validateWorkflow } from '../automation/validate.ts';
import { fromTemplate } from '../automation/templates.ts';
import { triggerStatus, busesAvailable } from '../automation/watch.ts';
import { busesNotNeeded, canSpare, needOver, needSteps, nowMinute, ridersPeaks, timetablePeaks } from '../automation/peaks.ts';
import { LiveData } from '../automation/live.ts';
import type { Value, WfEdge, WfNode, Workflow } from '../automation/types.ts';
import type { Timetable } from '../types.ts';

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

function make(game: Game, g: ReturnType<typeof graph>, patch: Partial<Pick<Workflow, 'mode' | 'enabled' | 'kind'>> = {}, name = 'peak test') {
  const r = game.createWorkflow({ name, nodes: g.nodes, edges: g.edges, kind: patch.kind ?? 'workflow' });
  if (!r.ok) throw new Error(r.error);
  const wf = game.state.automation.workflows[r.value];
  expect(validateWorkflow(wf, game.state).issues.filter((i) => i.level === 'error').map((i) => i.message)).toEqual([]);
  if (wf.kind === 'workflow') {
    const u = game.updateWorkflow(r.value, { enabled: true, mode: 'automatic', ...patch });
    if (!u.ok) throw new Error(u.error);
  }
  return wf;
}

const runsOf = (game: Game, wf: string) => game.state.automation.runs.filter((r) => r.wf === wf && !r.test);
const runTo = (game: Game, d: number, h: number, m = 0) => game.run(d * DAY + h * HOUR + m * 60 - game.t);
const lastNote = (game: Game, wf: string, type: string) => {
  const run = runsOf(game, wf).at(-1)!;
  const n = game.state.automation.workflows[wf].nodes.find((x) => x.type === type)!;
  return run.trace?.find((x) => x.node === n.id)?.note ?? '';
};

/** Every 20 minutes, every 8 in the morning (07–09) and evening (16–18) peaks, on weekdays. */
const twoPeaks = (): Timetable => ({
  weekday: { bands: [{ from: 360, to: 420, headway: 20 }, { from: 420, to: 540, headway: 8 }, { from: 540, to: 960, headway: 20 }, { from: 960, to: 1080, headway: 8 }, { from: 1080, to: 1380, headway: 20 }] },
  weekend: { bands: [{ from: 420, to: 1380, headway: 30 }] },
  layover: 4,
});
/** Every 30 minutes, every 8 around midday (11–14). */
const middayPeak = (): Timetable => ({
  weekday: { bands: [{ from: 360, to: 660, headway: 30 }, { from: 660, to: 840, headway: 8 }, { from: 840, to: 1380, headway: 30 }] },
  weekend: { bands: [{ from: 420, to: 1380, headway: 30 }] },
  layover: 4,
});

function peakLine(game: Game, buses: number, tt: Timetable, from?: [number, number]) {
  const l = buildLine(game, { buses, stops: 6, headway: 20, from });
  const r = game.setTimetable(l.route, tt);
  if (!r.ok) throw new Error(r.error);
  return l;
}

describe('peak hours', () => {
  it('finds a line’s timetable peaks and puts them on its record', () => {
    const game = newGame();
    const l = peakLine(game, 3, twoPeaks());
    runTo(game, 0, 6);
    const peaks = timetablePeaks(game, l.route);
    expect(peaks.map((p) => [p.from, p.to])).toEqual([[420, 540], [960, 1080]]);
    const steps = needSteps(game, l.route);
    expect(peaks[0].need).toBe(needOver(steps, 420, 540));
    expect(peaks[0].need).toBeGreaterThan(needOver(steps, 360, 420));
    const rec = new LiveData(game).line(l.route)!;
    expect(rec.peakHours).toBe('07:00–09:00 and 16:00–18:00');
    expect(rec.nextPeak).toBe('07:00');
    expect(rec.nextPeakIn).toBe(60);
    expect(rec.inPeak).toBe(false);
    expect(rec.neededMax).toBe(Math.max(...peaks.map((p) => p.need)));
    runTo(game, 0, 8);
    expect(new LiveData(game).line(l.route)!.inPeak).toBe(true);
    // a timetable that runs the same all day has no peak
    const flat = buildLine(game, { buses: 1, stops: 5, headway: 15, from: [28.985, 41.03] });
    expect(timetablePeaks(game, flat.route)).toEqual([]);
  });

  it('reads peaks from many timetable shapes', () => {
    const game = newGame();
    const l = buildLine(game, { buses: 1, stops: 5, headway: 15 });
    runTo(game, 0, 6);
    // feed needs straight in: [from, to, buses needed] per band
    const shape = (needs: [number, number, number][]) => {
      game.run(60); // a new minute: the cache starts again
      (game as unknown as { requirement: () => unknown }).requirement = () => ({ peak: 0, peakLabel: '', bands: needs.map(([from, to, need]) => ({ band: { from, to, headway: 10 }, need, cycle: 0 })) });
      return timetablePeaks(game, l.route).map((p) => `${p.from / 60}-${p.to / 60}:${p.need}`).join(' ');
    };
    expect(shape([[360, 420, 1], [420, 540, 2], [540, 960, 1], [960, 1080, 3], [1080, 1380, 1]])).toBe('7-9:2 16-18:3'); // a small morning peak still counts
    expect(shape([[360, 420, 1], [420, 480, 2], [480, 540, 3], [540, 1380, 1]])).toBe('7-9:3'); // a shoulder halfway up joins it
    expect(shape([[360, 600, 2], [600, 840, 3], [840, 1380, 2]])).toBe('10-14:3');
    expect(shape([[360, 420, 3], [420, 1380, 1]])).toBe('6-7:3');
    expect(shape([[360, 1380, 3]])).toBe(''); // the same all day
    expect(shape([[360, 420, 2], [420, 1380, 3]])).toBe(''); // most of the day is the normal level, not a peak
  });

  it('finds the busiest hours from riders recorded on earlier days', () => {
    const game = newGame({ seed: 21 });
    const l = crowdedLine(game);
    expect(ridersPeaks(game, l.route)).toEqual([]); // nothing recorded yet
    runTo(game, 1, 5);
    const p = ridersPeaks(game, l.route);
    expect(p.length).toBeGreaterThan(0);
    // the morning rush on this corridor (measured 06:30–09:00)
    expect(p.some((x) => x.from >= 360 && x.from <= 540)).toBe(true);
    expect(p[0].riders).toBeGreaterThan(0);
    // the Peak hours node says it in words
    const g = graph(game);
    const t = g.node('trigger.manual');
    const pk = g.node('data.peaks', { source: 'riders' });
    const rep = g.node('action.report', { text: '{value}' });
    g.link(t, 'event', pk, 'after');
    g.link(pk, 'summary', rep, 'value');
    const wf = make(game, g);
    game.runWorkflowNow(wf.id, { test: false });
    expect(lastNote(game, wf.id, 'data.peaks')).toMatch(/^Line \d+: \d\d:00–\d\d:00.*From 1 recorded (weekdays|days)\./);
  });
});

describe('Peak hours start or end', () => {
  it('fires once per line and peak, a set time before it starts, with the buses it is short', () => {
    const game = newGame();
    const l = peakLine(game, 2, twoPeaks());
    runTo(game, 0, 5, 30);
    const g = graph(game);
    const t = g.node('trigger.peak', { at: 'start', minutes: 30 });
    const r = g.node('action.report', { text: 'Line {event.lineNumber} {event.period}: short {event.buses}' });
    g.link(t, 'peak', r, 'value');
    const wf = make(game, g);
    const n = wf.nodes.find((x) => x.id === t)!;
    expect(triggerLabel(game, n)).toBe('30 min before a line’s peak starts');
    expect(triggerStatus(game, wf, n).text).toMatch(/^Next 06:30: line \d+, peak 07:00–09:00 · not fired yet/);
    runTo(game, 0, 6, 29);
    expect(runsOf(game, wf.id)).toHaveLength(0);
    runTo(game, 0, 6, 31);
    expect(runsOf(game, wf.id)).toHaveLength(1);
    const need = timetablePeaks(game, l.route)[0].need;
    expect(runsOf(game, wf.id)[0].triggerLabel).toMatch(/peak 07:00–09:00 is coming/);
    expect(lastNote(game, wf.id, 'trigger.peak')).toBe(`Line ${game.state.routes[l.route].number}’s peak 07:00–09:00 is coming: it needs ${need} buses and has 2 working, ${need - 2} short.`);
    runTo(game, 0, 15, 0);
    expect(runsOf(game, wf.id)).toHaveLength(1);
    runTo(game, 0, 15, 31);
    expect(runsOf(game, wf.id)).toHaveLength(2);
    expect(triggerStatus(game, wf, n).text).toMatch(/^No peak left today/);
  });

  it('fires after the peak ends, and only on its days', () => {
    const game = newGame();
    peakLine(game, 2, twoPeaks());
    const g = graph(game);
    const t = g.node('trigger.peak', { at: 'end', minutes: 10, days: 'weekend' });
    g.node('action.report', { text: 'x' });
    g.link(t, 'event', g.nodes[1].id, 'value');
    const wf = make(game, g);
    expect(triggerLabel(game, wf.nodes[0])).toBe('10 min after a line’s peak ends · weekends');
    runTo(game, 0, 18, 30);
    expect(runsOf(game, wf.id)).toHaveLength(0); // day 0 is a Monday
    game.updateWorkflow(wf.id, { nodes: wf.nodes.map((x) => (x.id === t ? { ...x, config: { ...x.config, days: 'all' } } : x)) });
    runTo(game, 1, 9, 15);
    expect(runsOf(game, wf.id)).toHaveLength(1);
    expect(runsOf(game, wf.id)[0].triggerLabel).toMatch(/peak 07:00–09:00 ended/);
  });
});

describe('sharing buses between lines', () => {
  it('brings in a parked spare, then buses another line can do without, before the peak', () => {
    const game = newGame({ extraFunds: 9_000_000 });
    const a = peakLine(game, 2, twoPeaks());
    const b = buildLine(game, { buses: 4, stops: 5, headway: 30, from: [28.985, 41.03] });
    const spare = game.buyVehicle('city12', a.depot);
    if (!spare.ok) throw new Error(spare.error);
    runTo(game, 0, 6);
    const needA = timetablePeaks(game, a.route)[0].need;
    const bSpare = canSpare(game, b.route, 540);
    expect(needA - 2).toBeGreaterThanOrEqual(2);
    expect(bSpare).toBeGreaterThanOrEqual(1);

    const id = fromTemplate(game, 'peak-bring-in');
    if (!id.ok) throw new Error(id.error);
    game.updateWorkflow(id.value, { enabled: true, mode: 'automatic' });
    runTo(game, 0, 6, 5);
    const run = runsOf(game, id.value)[0];
    expect(run).toBeTruthy();
    // moved now (the spare), or once its trips on line B are done
    const moved = run.actions.filter((x) => x.outcome === 'executed' || x.outcome === 'deferred');
    expect(moved.length).toBe(Math.min(needA - 2, 1 + bSpare));
    expect(game.state.vehicles[spare.value].route).toBe(a.route);
    expect(lastNote(game, id.value, 'data.borrow')).toMatch(/\(spare\).*from line \d+.*could join line \d+ until 09:00 \(the end of its peak 07:00–09:00\)\./);
    // by the peak line A has them all; line B kept what its timetable needs and missed nothing
    runTo(game, 0, 7, 30);
    expect(game.state.routes[a.route].vehicles).toHaveLength(2 + moved.length);
    expect(busesAvailable(game, b.route)).toBeGreaterThanOrEqual(needOver(needSteps(game, b.route), nowMinute(game), 540));
    expect((game.state.analytics.today.routes[b.route]?.m ?? []).reduce((x, y) => x + y, 0)).toBe(0);
  });

  it('parks the buses a line no longer needs after its peak, never one it still needs', () => {
    const game = newGame({ extraFunds: 9_000_000 });
    const a = peakLine(game, 2, twoPeaks());
    runTo(game, 0, 6);
    const needA = timetablePeaks(game, a.route)[0].need;
    for (let i = 2; i < needA; i++) {
      const v = game.buyVehicle('city12', a.depot);
      if (!v.ok) throw new Error(v.error);
      game.assignVehicle(v.value, a.route);
    }
    const id = fromTemplate(game, 'peak-park');
    if (!id.ok) throw new Error(id.error);
    game.updateWorkflow(id.value, { enabled: true, mode: 'automatic' });
    runTo(game, 0, 9, 11);
    const run = runsOf(game, id.value)[0];
    expect(run).toBeTruthy();
    // parked now, or once its current trip ends
    const parked = run.actions.filter((x) => x.outcome === 'executed' || x.outcome === 'deferred');
    const after = timetablePeaks(game, a.route)[0].need;
    const quiet = needOver(needSteps(game, a.route), nowMinute(game), nowMinute(game) + 60);
    expect(parked.length).toBe(after - quiet);
    const missed = () => (game.state.analytics.today.routes[a.route]?.m ?? []).reduce((x, y) => x + y, 0);
    const before = missed();
    runTo(game, 0, 11);
    expect(Object.values(game.state.vehicles).filter((v) => v.route === null && v.status === 'parked')).toHaveLength(parked.length);
    // what stays covers the timetable: no departure missed afterwards
    expect(busesAvailable(game, a.route)).toBe(quiet);
    expect(busesNotNeeded(game, a.route)).toHaveLength(0);
    expect(missed()).toBe(before);
  });

  it('compares two lines’ peaks', () => {
    const game = newGame({ extraFunds: 9_000_000 });
    const a = peakLine(game, 2, twoPeaks());
    const b = peakLine(game, 4, middayPeak(), [28.985, 41.03]);
    const c = peakLine(game, 2, twoPeaks(), [28.97, 41.045]);
    runTo(game, 0, 6);
    const cmp = (x: string, y: string) => {
      const g = graph(game);
      const t = g.node('trigger.manual');
      const k = g.node('logic.comparePeaks', { a: x, b: y });
      const r = g.node('action.report', { text: '{value}' });
      void t;
      g.link(k, 'text', r, 'value');
      const wf = make(game, g);
      game.runWorkflowNow(wf.id, { test: false });
      return lastNote(game, wf.id, 'logic.comparePeaks');
    };
    const na = game.state.routes[a.route].number, nb = game.state.routes[b.route].number, nc = game.state.routes[c.route].number;
    expect(cmp(a.route, b.route)).toMatch(new RegExp(`^Line ${na} is busiest 07:00–09:00 and 16:00–18:00; line ${nb} is busiest 11:00–14:00\\. They do not overlap\\. Line ${nb} could lend line ${na} \\d+ bus`));
    expect(cmp(a.route, c.route)).toMatch(new RegExp(`They overlap by 4 h\\. Line ${nc} needs all its buses during line ${na}’s peaks\\.`));
  });
});

describe('moving a bus after the trips it already has', () => {
  it('runs its trips, takes no new ones, then moves; moving it by hand cancels the wait; it survives a save', () => {
    const game = newGame({ extraFunds: 9_000_000 });
    const a = buildLine(game, { buses: 3, stops: 6, headway: 10 });
    const b = buildLine(game, { buses: 1, stops: 5, headway: 30, from: [28.985, 41.03] });
    runTo(game, 0, 8);
    const v = game.state.routes[a.route].vehicles.map((id) => game.state.vehicles[id]).find((x) => x.trip !== null)!;
    const mine = new Set([v.trip, v.next].filter((x): x is number => x !== null));
    expect(game.handoverVehicle(v.id, b.route).ok).toBe(true);
    expect(v.route).toBe(a.route);
    expect(v.handover).toEqual({ route: b.route, src: 'player' });
    expect(busesAvailable(game, a.route)).toBe(2);
    // a save and reload keeps it
    const copy = new Game(JSON.parse(game.serialize()), region());
    expect(copy.state.vehicles[v.id].handover).toEqual({ route: b.route, src: 'player' });
    game.run(2 * HOUR);
    expect(v.route).toBe(b.route);
    expect(v.handover).toBeUndefined();
    // it ran the trips it had, and no other trip of line A was given to it
    for (const id of mine) expect([3, 4]).toContain(game.trip(id)?.state ?? 3);
    // moving it by hand while it waits cancels the wait
    const w = game.state.routes[a.route].vehicles.map((id) => game.state.vehicles[id]).find((x) => x.trip !== null)!;
    game.handoverVehicle(w.id, null);
    expect(w.handover).toBeTruthy();
    game.assignVehicle(w.id, a.route);
    expect(w.handover).toBeUndefined();
  });
});

describe('more building blocks', () => {
  it('picks the highest or lowest, joins a list in words, and a bus stands for its line', () => {
    const game = newGame({ extraFunds: 9_000_000 });
    const a = buildLine(game, { buses: 1, stops: 5, headway: 15 });
    buildLine(game, { buses: 3, stops: 5, headway: 15, from: [28.985, 41.03] });
    runTo(game, 0, 7);
    const g = graph(game);
    const t = g.node('trigger.manual');
    const lines = g.node('data.lines');
    const pick = g.node('logic.pick', { field: 'buses', order: 'asc' });
    const words = g.node('math.expr', { expr: "concat('Lines ', join(pluck(a, 'number')))" });
    const buses = g.node('data.buses', { line: a.route });
    const first = g.node('logic.first');
    const line = g.node('data.line');
    const rep = g.node('action.report', { text: '{value}' });
    g.link(t, 'event', lines, 'after');
    g.link(lines, 'lines', pick, 'list');
    g.link(lines, 'lines', words, 'a');
    g.link(t, 'event', buses, 'after');
    g.link(buses, 'buses', first, 'list');
    g.link(first, 'item', line, 'line'); // a bus connected where a line is wanted: its line
    g.link(words, 'value', rep, 'value');
    const wf = make(game, g);
    game.runWorkflowNow(wf.id, { test: false });
    expect(lastNote(game, wf.id, 'logic.pick')).toBe(`Line ${game.state.routes[a.route].number}: buses 1.`);
    expect(lastNote(game, wf.id, 'math.expr')).toMatch(/= "Lines \d+, \d+"$/);
    expect(lastNote(game, wf.id, 'data.line')).toMatch(new RegExp(`^Line ${game.state.routes[a.route].number}:`));
  });

  it('runs a function once for every item of a list, at most the set number', () => {
    const game = newGame({ extraFunds: 9_000_000 });
    for (let i = 0; i < 3; i++) buildLine(game, { buses: 1, stops: 4, headway: 20, from: [28.97 + i * 0.012, 41.035] });
    runTo(game, 0, 7);
    const f = graph(game);
    const fin = f.node('adv.input');
    const calc = f.node('math.expr', { expr: "concat(a.number, '#', b)" });
    const fout = f.node('adv.output');
    f.link(fin, 'a', calc, 'a');
    f.link(fin, 'b', calc, 'b');
    f.link(calc, 'value', fout, 'value');
    const fn = make(game, f, { kind: 'function' }, 'Label a line');
    const g = graph(game);
    const t = g.node('trigger.manual');
    const lines = g.node('data.lines');
    const each = g.node('adv.forEach', { workflow: fn.id, max: 2 });
    const rep = g.node('action.report', { text: '{value}' });
    g.link(t, 'event', lines, 'after');
    g.link(lines, 'lines', each, 'list');
    g.link(each, 'count', rep, 'value');
    const wf = make(game, g);
    game.runWorkflowNow(wf.id, { test: false });
    expect(lastNote(game, wf.id, 'adv.forEach')).toBe('Ran the function for 2 items (1 more left out: at most 2).');
    // a function used by For each cannot be deleted
    expect(game.deleteWorkflow(fn.id).ok).toBe(false);
  });
});
