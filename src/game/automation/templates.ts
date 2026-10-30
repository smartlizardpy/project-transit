// Starter workflows. They are ordinary workflows built from the node library, created in
// Observe mode so they never change anything until the player chooses Suggest or Automatic.

import type { Game } from '../engine.ts';
import type { Mode, WfEdge, WfNode } from './types.ts';
import { defaultConfig } from './registry.ts';
import type { Value } from './types.ts';

export interface Template {
  id: string;
  name: string;
  description: string;
  mode: Mode;
  build: (game: Game) => { nodes: WfNode[]; edges: WfEdge[] };
}

/** Small builder: nodes laid out on a grid, edges by node handle. */
function graph(game: Game) {
  const nodes: WfNode[] = [];
  const edges: WfEdge[] = [];
  const add = (type: string, col: number, row: number, config: Record<string, Value> = {}, label?: string) => {
    const n: WfNode = { id: game.newNodeId(), type, x: 80 + col * 300, y: 80 + row * 170, config: { ...defaultConfig(type), ...config }, label };
    nodes.push(n);
    return n.id;
  };
  const link = (from: string, out: string, to: string, inp: string) => edges.push({ id: `e${edges.length + 1}_${from}_${to}`, from, out, to, in: inp });
  return { nodes, edges, add, link };
}

const firstLine = (game: Game) => Object.values(game.state.routes).sort((a, b) => b.vehicles.length - a.vehicles.length)[0]?.id ?? '';

export const TEMPLATES: Template[] = [
  {
    id: 'crowding',
    name: 'Extra bus when a line is crowded',
    description: 'Every 15 minutes: if buses on the line are more than 80% full on average, find a free bus and run an extra departure.',
    mode: 'observe',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.every', 0, 0, { minutes: 15, from: 6, to: 21 });
      const line = g.add('data.line', 0, 1, { line: firstLine(game) });
      g.link(t, 'event', line, 'after');
      const cmp = g.add('logic.compare', 1, 1, { op: '>', b: 80 }, 'More than 80% full?');
      const iff = g.add('logic.if', 2, 1);
      const find = g.add('data.findBus', 3, 1);
      const go = g.add('action.dispatch', 4, 1);
      g.link(line, 'occupancy', cmp, 'a');
      g.link(cmp, 'result', iff, 'condition');
      g.link(line, 'line', iff, 'value');
      g.link(iff, 'yes', find, 'line');
      g.link(find, 'found', go, 'when');
      g.link(iff, 'yes', go, 'line');
      g.link(find, 'bus', go, 'bus');
      return g;
    },
  },
  {
    id: 'crowded-all',
    name: 'Watch every line for crowding',
    description: 'Every 15 minutes: take the most crowded line above 85% and suggest an extra departure there.',
    mode: 'suggest',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.every', 0, 0, { minutes: 15 });
      const lines = g.add('data.lines', 0, 1);
      g.link(t, 'event', lines, 'after');
      const filter = g.add('logic.filter', 1, 1, { expr: 'item.occupancy > 85 and not item.suspended' });
      const sort = g.add('logic.sort', 2, 1, { field: 'occupancy', order: 'desc' });
      const first = g.add('logic.first', 3, 1);
      const go = g.add('action.dispatch', 4, 1);
      g.link(lines, 'lines', filter, 'list');
      g.link(filter, 'list', sort, 'list');
      g.link(sort, 'list', first, 'list');
      g.link(first, 'item', go, 'line');
      return g;
    },
  },
  {
    id: 'late',
    name: 'Tell me when a bus runs late',
    description: 'When a bus is 5 minutes or more behind, send a notification (at most once per trip, and not more than once an hour per line).',
    mode: 'automatic',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.late', 0, 0, { minutes: 5 });
      const cool = g.add('state.cooldown', 1, 0, { minutes: 60 });
      const n = g.add('action.notify', 2, 0, { title: '{event.fleetNo} is {event.delay} min late', body: 'Line {event.lineNumber}, at {event.stopName}.', tone: 'warn' });
      g.link(t, 'line', cool, 'value');
      g.link(cool, 'value', n, 'value');
      return g;
    },
  },
  {
    id: 'breakdown',
    name: 'Cover a breakdown',
    description: 'When a bus breaks down, suggest an extra departure on its line with a free bus.',
    mode: 'suggest',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.breakdown', 0, 0);
      const find = g.add('data.findBus', 1, 0);
      const go = g.add('action.dispatch', 2, 0);
      g.link(t, 'line', find, 'line');
      g.link(find, 'found', go, 'when');
      g.link(t, 'line', go, 'line');
      g.link(find, 'bus', go, 'bus');
      return g;
    },
  },
  {
    id: 'daily',
    name: 'Daily summary',
    description: 'At the end of every day, write the day’s journeys, punctuality and result to this workflow’s report.',
    mode: 'automatic',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.day', 0, 0);
      const r = g.add('action.report', 1, 0, { text: 'Day {value.dayNumber}: {value.journeys} journeys, {value.onTime}% on time, result {value.result}' });
      g.link(t, 'summary', r, 'value');
      return g;
    },
  },
  {
    id: 'balance',
    name: 'Low balance warning',
    description: 'When the balance drops below 20,000, warn me.',
    mode: 'automatic',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.balance', 0, 0, { amount: 20000 });
      const n = g.add('action.notify', 1, 0, { title: 'Balance is low', body: 'The balance fell to {value.balance}. Check costs in Finances.', tone: 'warn' });
      g.link(t, 'company', n, 'value');
      return g;
    },
  },
  {
    id: 'event-crowds',
    name: 'Extra buses for big events',
    description: 'For a match, concert, festival or gathering of 3,000 people or more: an extra departure on each of your lines near the venue an hour before it starts, ten minutes before it ends and a quarter of an hour after.',
    mode: 'suggest',
    build: (game) => {
      const g = graph(game);
      const rows: [string, Record<string, Value>, string][] = [
        ['trigger.eventStart', { minutes: 60, kinds: 'crowds', people: 3000 }, 'An hour before the start'],
        ['trigger.eventEnd', { minutes: -10, kinds: 'crowds', people: 3000 }, '10 min before the end'],
        ['trigger.eventEnd', { minutes: 15, kinds: 'crowds', people: 3000 }, '15 min after the end'],
      ];
      rows.forEach(([type, cfg, label], i) => {
        const t = g.add(type, 0, i, cfg, label);
        const go = g.add('action.dispatch', 1, i);
        g.link(t, 'lines', go, 'line');
      });
      return g;
    },
  },
  {
    id: 'storm-plan',
    name: 'Rain plan when a storm is forecast',
    description: 'At 18:00, when tomorrow’s forecast says heavy rain or snow, switch on the line’s manual "Rain" service plan; otherwise switch it off. Make the plan in the line’s timetable first (for example more buses at the peaks, as roads are slower).',
    mode: 'observe',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.forecast', 0, 0, { when: 'any' });
      const f = g.add('math.field', 1, 0, { field: 'storm' }, 'Storm forecast?');
      const iff = g.add('logic.if', 2, 0);
      const on = g.add('action.servicePlan', 3, 0, { line: firstLine(game), plan: 'Rain', on: 'on' });
      const off = g.add('action.servicePlan', 3, 1, { line: firstLine(game), plan: 'Rain', on: 'off' });
      g.link(t, 'forecast', f, 'record');
      g.link(f, 'value', iff, 'condition');
      g.link(iff, 'yes', on, 'when');
      g.link(iff, 'no', off, 'when');
      return g;
    },
  },
  {
    id: 'rain-extra',
    name: 'Extra bus when heavy rain starts',
    description: 'When heavy rain or snow starts between 07:00 and 20:00, find a free bus and run an extra departure on the line: roads are slower, so buses fall behind.',
    mode: 'suggest',
    build: (game) => {
      const g = graph(game);
      g.add('trigger.weather', 0, 0, { when: 'heavy', from: 7, to: 20 });
      const find = g.add('data.findBus', 1, 0, { line: firstLine(game) });
      const go = g.add('action.dispatch', 2, 0, { line: firstLine(game) });
      g.link(find, 'found', go, 'when');
      g.link(find, 'bus', go, 'bus');
      return g;
    },
  },
  {
    id: 'disruption-cover',
    name: 'Cover a rail disruption',
    description: 'When a metro, train or tram stretch closes, run an extra departure on each of your lines near it: its passengers are looking for another way to travel.',
    mode: 'suggest',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.eventAnnounced', 0, 0, { kinds: 'disruption', people: 0 });
      const go = g.add('action.dispatch', 1, 0);
      g.link(t, 'lines', go, 'line');
      return g;
    },
  },
  {
    id: 'events-week',
    name: 'Events in the next three days',
    description: 'Every morning at 07:00, write the announced events of the next three days to this workflow’s report.',
    mode: 'automatic',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.time', 0, 0, { time: '07:00' });
      const ev = g.add('data.events', 1, 0, { hours: '72', kinds: 'any' });
      const r = g.add('action.report', 2, 0, { text: '{value} events in the next three days' });
      g.link(t, 'event', ev, 'after');
      g.link(ev, 'count', r, 'value');
      return g;
    },
  },
];

/** Create a workflow from a template. */
export function fromTemplate(game: Game, id: string) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return { ok: false as const, error: 'Unknown template.' };
  const { nodes, edges } = t.build(game);
  return game.createWorkflow({ name: t.name, description: t.description, mode: t.mode, nodes, edges });
}
