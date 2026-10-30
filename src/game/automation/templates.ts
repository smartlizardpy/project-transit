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
];

/** Create a workflow from a template. */
export function fromTemplate(game: Game, id: string) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return { ok: false as const, error: 'Unknown template.' };
  const { nodes, edges } = t.build(game);
  return game.createWorkflow({ name: t.name, description: t.description, mode: t.mode, nodes, edges });
}
