// Starter workflows. They are ordinary workflows built from the node library, created in
// Observe mode so they never change anything until the player chooses Suggest or Automatic.

import type { Game } from '../engine.ts';
import type { Mode, WfEdge, WfNode } from './types.ts';
import { defaultConfig } from './registry.ts';
import type { Value } from './types.ts';

export type TemplateGroup = 'crowding' | 'reliability' | 'fleet' | 'money' | 'city' | 'reports';

/** Template groups, in the order the gallery shows them. */
export const TEMPLATE_GROUPS: { id: TemplateGroup; label: string; help: string }[] = [
  { id: 'crowding', label: 'Crowding and waiting', help: 'Full buses, people left behind, crowded stops.' },
  { id: 'reliability', label: 'Reliability', help: 'Late lines, missed departures, lines short of buses.' },
  { id: 'fleet', label: 'Fleet and maintenance', help: 'Breakdowns, worn buses, spare buses.' },
  { id: 'money', label: 'Money and reputation', help: 'Balance and reputation.' },
  { id: 'city', label: 'Events, weather and the calendar', help: 'Matches, concerts, rain, school holidays, the airport.' },
  { id: 'reports', label: 'Reports and briefings', help: 'Daily, weekly and morning summaries.' },
];

export interface Template {
  id: string;
  name: string;
  description: string;
  mode: Mode;
  group: TemplateGroup;
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
    group: 'crowding',
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
    group: 'crowding',
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
    group: 'reliability',
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
    group: 'fleet',
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
    group: 'reports',
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
    group: 'money',
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
    group: 'city',
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
    group: 'city',
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
    group: 'city',
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
    group: 'city',
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
    group: 'city',
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
  {
    id: 'school-holidays',
    name: 'School holidays check',
    description: 'On the first day of the school holidays at 05:00, tell me how many lines still run their term-time timetable. Pupils are off, so the school-run peaks fade. A “School holidays” service plan in a line’s timetable switches by itself.',
    mode: 'automatic',
    group: 'city',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.calendar', 0, 0, { day: 'school_holidays', time: '05:00', first: true });
      const lines = g.add('data.lines', 1, 0);
      const f = g.add('logic.filter', 2, 0, { expr: 'not item.holidayPlan' });
      const any = g.add('logic.compare', 3, 0, { op: '>', b: 0 });
      const n = g.add('action.notify', 4, 0, {
        title: 'School holidays from today',
        body: '{value} of your lines run their term-time timetable. Add a School holidays plan in a line’s timetable to change it.',
        tone: 'info',
      });
      g.link(t, 'event', lines, 'after');
      g.link(lines, 'lines', f, 'list');
      g.link(f, 'count', any, 'a');
      g.link(any, 'result', n, 'when');
      g.link(f, 'count', n, 'value');
      return g;
    },
  },
  {
    id: 'airport-early',
    name: 'Early-morning airport boost',
    description: 'At 05:15, run an extra departure on each of your lines that stop at the largest airport: the first flights leave from about 06:00. Nothing runs when no line stops there.',
    mode: 'suggest',
    group: 'city',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.time', 0, 0, { time: '05:15', days: 'all' });
      const p = g.add('data.place', 1, 0, { category: 'airport', limit: 1 });
      const go = g.add('action.dispatch', 2, 0);
      g.link(t, 'event', p, 'after');
      g.link(p, 'lines', go, 'line');
      return g;
    },
  },
  {
    id: 'busy-hour-ahead',
    name: 'Busy hour ahead',
    description: 'Every hour from 06:00 to 20:00, ask the demand model about the next hour and tell me which lines expect more than 50 boardings per timetabled departure. An estimate: add a bus or shorten the headway before the crowd arrives.',
    mode: 'automatic',
    group: 'crowding',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.every', 0, 0, { minutes: 60, from: 6, to: 20 });
      const f = g.add('data.demandForecast', 1, 0, { hours: '1' });
      const busy = g.add('logic.filter', 2, 0, { expr: 'item.hours[0].perDeparture > 50' });
      const any = g.add('logic.compare', 3, 0, { op: '>', b: 0 });
      const first = g.add('logic.first', 3, 1);
      const n = g.add('action.notify', 4, 0, {
        title: 'Line {value.number} looks busy next hour',
        body: 'About {value.riders} boardings expected (estimate), more than 50 per timetabled departure.',
        tone: 'warn',
      });
      g.link(t, 'event', f, 'after');
      g.link(f, 'lines', busy, 'list');
      g.link(busy, 'count', any, 'a');
      g.link(busy, 'list', first, 'list');
      g.link(any, 'result', n, 'when');
      g.link(first, 'item', n, 'value');
      return g;
    },
  },
  {
    id: 'unserved-corridors',
    name: 'Unserved corridors report',
    description: 'Every weekday at 06:00, write the busiest connections between your areas that no line links to this workflow’s report: the demand model’s estimate of trips a day, by every mode and purpose.',
    mode: 'automatic',
    group: 'reports',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.time', 0, 0, { time: '06:00', days: 'weekdays' });
      const u = g.add('data.unserved', 1, 0, { limit: 3 });
      const total = g.add('action.report', 2, 0, { text: 'About {value} trips a day between your areas have no line (estimate)' });
      const top = g.add('action.report', 2, 1, { text: 'Busiest: {value.label}, about {value.trips} a day; missing a {value.missing}' });
      g.link(t, 'event', u, 'after');
      g.link(u, 'trips', total, 'value');
      g.link(u, 'first', top, 'value');
      return g;
    },
  },

  // ── crowding and waiting
  {
    id: 'left-behind-extra',
    name: 'Extra bus when people are left behind',
    description: 'When a full bus leaves 5 or more people behind, find a free bus and run an extra departure on that line (at most once every 20 minutes per stop).',
    mode: 'suggest',
    group: 'crowding',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.leftBehind', 0, 0, { people: 5, repeat: 20 });
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
    id: 'stop-overflow',
    name: 'Crowded stop alert',
    description: 'When more than 40 people have been waiting at a stop for 10 minutes, tell me which stop. It warns again for that stop only once the crowd has gone down.',
    mode: 'automatic',
    group: 'crowding',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.watch', 0, 0, { figure: 'stop.waiting', op: 'above', value: 40, for: 10 });
      const n = g.add('action.notify', 1, 0, { title: '{event.reading} waiting at {event.name}', body: 'More than 40 people have been waiting here for 10 minutes. An extra departure or a shorter headway on its lines would clear it.', tone: 'warn' });
      g.link(t, 'item', n, 'value');
      return g;
    },
  },
  {
    id: 'gave-up-alert',
    name: 'People giving up at a stop',
    description: 'When 8 or more people give up waiting at one stop within an hour, tell me. People who give up travel another way, so their fares are lost and satisfaction drops.',
    mode: 'automatic',
    group: 'crowding',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.gaveUp', 0, 0, { people: 8 });
      const n = g.add('action.notify', 1, 0, { title: '{event.gaveUp} gave up waiting at {event.stopName}', body: 'In the last hour. Buses there are too far apart or too full: check the frequency of line {event.lineNumber}.', tone: 'warn' });
      g.link(t, 'stop', n, 'value');
      return g;
    },
  },
  {
    id: 'rebalance',
    name: 'Move a bus from a quiet line to a busy one',
    description: 'Every 30 minutes from 07:00 to 19:00: when one line averages more than 80% full and another less than 30% with more buses working than its timetable needs, move a free bus from the quiet line to the busy one.',
    mode: 'suggest',
    group: 'crowding',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.every', 0, 1, { minutes: 30, from: 7, to: 19 });
      const lines = g.add('data.lines', 1, 1);
      g.link(t, 'event', lines, 'after');
      const busy = g.add('logic.filter', 2, 0, { expr: 'item.load3h > 80 and not item.suspended' }, 'Busy lines');
      const busySort = g.add('logic.sort', 3, 0, { field: 'load3h', order: 'desc' });
      const busiest = g.add('logic.first', 4, 0, {}, 'Busiest');
      const quiet = g.add('logic.filter', 2, 2, { expr: 'item.load3h < 30 and item.working > item.neededNow and not item.suspended' }, 'Quiet, a bus to spare');
      const quietSort = g.add('logic.sort', 3, 2, { field: 'load3h', order: 'asc' });
      const quietest = g.add('logic.first', 4, 2, {}, 'Quietest');
      const buses = g.add('data.buses', 5, 2, { which: 'free' }, 'Its free buses');
      const bus = g.add('logic.first', 6, 2, {}, 'One bus');
      const move = g.add('action.assign', 7, 1);
      g.link(lines, 'lines', busy, 'list');
      g.link(busy, 'list', busySort, 'list');
      g.link(busySort, 'list', busiest, 'list');
      g.link(lines, 'lines', quiet, 'list');
      g.link(quiet, 'list', quietSort, 'list');
      g.link(quietSort, 'list', quietest, 'list');
      g.link(quietest, 'item', buses, 'line');
      g.link(buses, 'buses', bus, 'list');
      g.link(busiest, 'found', move, 'when');
      g.link(bus, 'item', move, 'bus');
      g.link(busiest, 'item', move, 'line');
      return g;
    },
  },

  // ── reliability
  {
    id: 'short-of-buses',
    name: 'Warn me when a line is short of buses',
    description: 'When a line has fewer working buses than its timetable needs right now, tell me straight away. Every departure it cannot run is missed, and missed departures cost reputation every day.',
    mode: 'automatic',
    group: 'reliability',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.shortBuses', 0, 0);
      const n = g.add('action.notify', 1, 0, { title: 'Line {event.lineNumber} is short of buses', body: 'It needs {event.needed} working buses for its timetable now and has {event.buses}, so departures will be missed and reputation will fall. Assign a bus, or suspend the line until you have one.', tone: 'bad' });
      g.link(t, 'line', n, 'value');
      return g;
    },
  },
  {
    id: 'cover-short-line',
    name: 'Send a spare bus to a line that is short',
    description: 'When a line has fewer working buses than its timetable needs, move a spare bus (one with no line) to it.',
    mode: 'suggest',
    group: 'reliability',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.shortBuses', 0, 0);
      const spares = g.add('data.buses', 1, 0, { which: 'spare' }, 'Spare buses');
      const first = g.add('logic.first', 2, 0);
      const move = g.add('action.assign', 3, 0);
      g.link(t, 'event', spares, 'after');
      g.link(spares, 'buses', first, 'list');
      g.link(first, 'item', move, 'bus');
      g.link(t, 'line', move, 'line');
      return g;
    },
  },
  {
    id: 'unreliable-line',
    name: 'Unreliable line alert',
    description: 'From 07:00 to 21:00: when fewer than 75% of a line’s trips have been on time over three hours, and that lasts half an hour, tell me which line.',
    mode: 'automatic',
    group: 'reliability',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.watch', 0, 0, { figure: 'line.onTime3h', op: 'below', value: 75, for: 30, from: 7, to: 21 });
      const n = g.add('action.notify', 1, 0, { title: '{event.name} is running unreliably', body: 'Only {event.reading} of its trips were on time over the last three hours. Slow roads, a timetable that is too tight, or buses that cannot keep up: check its run times in the timetable.', tone: 'warn' });
      g.link(t, 'item', n, 'value');
      return g;
    },
  },
  {
    id: 'late-line',
    name: 'Tell me when a whole line runs late',
    description: 'When a line’s buses are more than 5 minutes late on average for 15 minutes, tell me once. Quieter than a notice for every late bus.',
    mode: 'automatic',
    group: 'reliability',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.watch', 0, 0, { figure: 'line.delay', op: 'above', value: 5, for: 15 });
      const n = g.add('action.notify', 1, 0, { title: '{event.name} is running late', body: 'Its buses are {event.reading} late on average. Roads may be busy or wet; a bus out of the depot can fill the gaps.', tone: 'warn' });
      g.link(t, 'item', n, 'value');
      return g;
    },
  },
  {
    id: 'missed-digest',
    name: 'Missed departures at the end of the day',
    description: 'At 23:45, write how many departures were missed today and on which line most, to this workflow’s report.',
    mode: 'automatic',
    group: 'reliability',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.time', 0, 0, { time: '23:45' });
      const lines = g.add('data.lines', 1, 0);
      const total = g.add('math.aggregate', 2, 0, { op: 'sum', field: 'missedToday' }, 'Missed in all');
      const missed = g.add('logic.filter', 2, 1, { expr: 'item.missedToday > 0' }, 'Lines that missed some');
      const sort = g.add('logic.sort', 3, 1, { field: 'missedToday', order: 'desc' });
      const worst = g.add('logic.first', 4, 1, {}, 'Most missed');
      const r1 = g.add('action.report', 3, 0, { text: '{value} departures missed today' });
      const r2 = g.add('action.report', 5, 1, { text: 'Most on line {value.number}: {value.missedToday}' });
      g.link(t, 'event', lines, 'after');
      g.link(lines, 'lines', total, 'list');
      g.link(total, 'value', r1, 'value');
      g.link(lines, 'lines', missed, 'list');
      g.link(missed, 'list', sort, 'list');
      g.link(sort, 'list', worst, 'list');
      g.link(worst, 'item', r2, 'value');
      return g;
    },
  },

  // ── fleet
  {
    id: 'maintenance-off-peak',
    name: 'Service worn buses between the peaks',
    description: 'The game sends a bus to the workshop by itself once it falls below your automatic-service level (70% unless you changed it), even in the rush hour. This sends buses below 78% between 09:00 and 16:00, so they are serviced in the quiet middle of the day instead.',
    mode: 'suggest',
    group: 'fleet',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.watch', 0, 0, { figure: 'bus.condition', op: 'below', value: 78, for: 0, from: 9, to: 16 });
      const go = g.add('action.service', 1, 0);
      g.link(t, 'item', go, 'bus');
      return g;
    },
  },

  // ── money and reputation
  {
    id: 'reputation-guard',
    name: 'Find out why reputation is falling',
    description: 'When reputation falls below 50, name the line missing the most departures today (missed departures cost reputation every day), or say that none is and point to crowding and waits.',
    mode: 'automatic',
    group: 'money',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.watch', 0, 0, { figure: 'company.reputation', op: 'below', value: 50, for: 0 });
      const lines = g.add('data.lines', 1, 0);
      const bad = g.add('logic.filter', 2, 0, { expr: 'item.missedToday > 0 or item.short > 0' }, 'Missing departures');
      const sort = g.add('logic.sort', 3, 0, { field: 'missedToday', order: 'desc' });
      const worst = g.add('logic.first', 4, 0, {}, 'Worst line');
      const none = g.add('logic.compare', 3, 1, { op: '==', b: 0 }, 'None missing?');
      const n1 = g.add('action.notify', 5, 0, { title: 'Reputation is down to {event.reading}', body: 'Line {value.number} has missed {value.missedToday} departures today. Give it enough buses for its timetable, or suspend it: a suspended line costs no reputation.', tone: 'bad' });
      const n2 = g.add('action.notify', 5, 1, { title: 'Reputation is down to {event.reading}', body: 'No line is missing departures. Crowded buses, long waits and late running lower satisfaction: see Network Control.', tone: 'warn' });
      g.link(t, 'event', lines, 'after');
      g.link(lines, 'lines', bad, 'list');
      g.link(bad, 'list', sort, 'list');
      g.link(sort, 'list', worst, 'list');
      g.link(worst, 'item', n1, 'value');
      g.link(bad, 'count', none, 'a');
      g.link(none, 'result', n2, 'when');
      return g;
    },
  },

  // ── reports
  {
    id: 'weekly-report',
    name: 'Weekly report',
    description: 'When a game week ends, tell me its journeys, the change on the week before, satisfaction, fares and the busiest line, and keep them in this workflow’s report.',
    mode: 'automatic',
    group: 'reports',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.week', 0, 0);
      const n = g.add('action.notify', 1, 0, { title: 'Week {value.week} in numbers', body: '{value.journeys} journeys ({value.changeText}), satisfaction {value.satisfaction}%, fares {value.fares}. Busiest: line {value.busiestLine}.', tone: 'info' });
      const r = g.add('action.report', 1, 1, { text: 'Week {value.week}: {value.journeys} journeys ({value.changeText}), satisfaction {value.satisfaction}%, fares {value.fares}' });
      g.link(t, 'summary', n, 'value');
      g.link(t, 'summary', r, 'value');
      return g;
    },
  },
  {
    id: 'morning-briefing',
    name: 'Morning briefing',
    description: 'Every morning at 06:00: today’s weather, the events coming up today, and how many lines are short of buses, in one notification.',
    mode: 'automatic',
    group: 'reports',
    build: (game) => {
      const g = graph(game);
      const t = g.add('trigger.time', 0, 0, { time: '06:00' });
      const wx = g.add('data.weather', 1, 0);
      const ev = g.add('data.events', 1, 1, { hours: '24', kinds: 'any' });
      const lines = g.add('data.lines', 1, 2);
      const short = g.add('logic.filter', 2, 2, { expr: 'item.short > 0' }, 'Short of buses');
      const text = g.add('math.expr', 3, 1, { expr: 'concat(a.label, ", ", text(a.high), " °C. ", text(b), if(b == 1, " event", " events"), " in the next day. ", text(c), if(c == 1, " line", " lines"), " short of buses.")' }, 'Briefing text');
      const n = g.add('action.notify', 4, 1, { title: 'Good morning', body: '{value}', tone: 'info' });
      g.link(t, 'event', wx, 'after');
      g.link(t, 'event', ev, 'after');
      g.link(t, 'event', lines, 'after');
      g.link(lines, 'lines', short, 'list');
      g.link(wx, 'today', text, 'a');
      g.link(ev, 'count', text, 'b');
      g.link(short, 'count', text, 'c');
      g.link(text, 'value', n, 'value');
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
