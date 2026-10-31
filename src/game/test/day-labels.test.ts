// Day labels, weekly roll-ups and the new Network Control groupings and filters
// (docs/city-activity-engine-plan.md, section 12).
import { describe, expect, it } from 'vitest';
import { Game } from '../engine.ts';
import { buildLine, newGame, region } from './helpers.ts';
import { DAY, HOUR } from '../content.ts';
import { aggregate, odMatrix } from '../analytics/query.ts';
import { dayKind, eventDay, seasonYears, weatherGroup } from '../analytics/labels.ts';
import { TRAVELLERS } from '../activity/params.ts';
import type { GameEvent } from '../events.ts';
import type { DayRecord } from '../analytics/types.ts';

/** A company with one busy line, run for `days` days. */
function played(days: number) {
  const g = newGame({ extraFunds: 500_000 });
  buildLine(g, { buses: 4, stops: 8, headway: 8 });
  g.run(days * DAY - g.t + 60);
  return g;
}

const sumOf = (rows: { values: Record<string, number | null> }[], m: string) => rows.reduce((a, r) => a + (r.values[m] ?? 0), 0);

describe('day labels', () => {
  const g = played(9);
  const days = g.state.analytics.days;

  it('every closed day keeps its season, kind of day and weather, matching the day figures', () => {
    expect(days.length).toBe(9);
    for (const rec of days) {
      const l = rec.lbl!;
      expect(l).toBeTruthy();
      const c = g.calendarAt(rec.day * DAY + DAY / 2), d = g.dayTypeAt(rec.day * DAY + DAY / 2);
      expect([l.season, l.week, l.y, !!l.weekend, !!l.holiday, !!l.schoolHolidays]).toEqual([c.season, c.week, c.year, d.weekend, d.holiday, d.schoolHolidays]);
      const row = g.state.stats.days.find((x) => x.day === rec.day)!;
      expect(l.wx).toEqual({ k: row.wx!.k, mm: row.wx!.mm, hi: row.wx!.hi, lo: row.wx!.lo });
      expect(weatherGroup(l)).not.toBeNull();
      expect(dayKind(l)).toBe(d.holiday ? 'holiday' : d.weekend ? 'weekend' : d.schoolHolidays ? 'school_holidays' : 'working');
    }
  });

  it('groupings by weather, kind of day and event day split the same totals as the network', () => {
    const net = aggregate(g, { groupBy: 'network', days: { last: 9 } });
    for (const groupBy of ['weather', 'daykind', 'eventday'] as const) {
      const res = aggregate(g, { groupBy, days: { last: 9 } });
      expect(sumOf(res.rows, 'journeys'), groupBy).toBe(net.total.values.journeys);
      expect(sumOf(res.rows, 'boardings'), groupBy).toBe(net.total.values.boardings);
      expect(res.rows.every((r) => r.label && !r.label.includes('Not recorded')), groupBy).toBe(true);
    }
    // the weekend rows are the weekend days
    const kinds = aggregate(g, { groupBy: 'daykind', days: { last: 9 } });
    const weekend = aggregate(g, { groupBy: 'network', days: { last: 9 }, dayType: 'weekend' });
    expect(kinds.rows.find((r) => r.key === 'weekend')?.values.journeys ?? 0).toBe(weekend.total.values.journeys);
  });

  it('filters by weather add up to the whole, and a filter leaves out days recorded before labels', () => {
    const all = aggregate(g, { groupBy: 'network', days: { last: 9 } }).total.values.journeys!;
    const parts = (['dry', 'wet', 'storm'] as const).map((w) => aggregate(g, { groupBy: 'network', days: { last: 9 }, weather: w }).total.values.journeys ?? 0);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(all);
    // a day recorded before labels were kept
    const copy = new Game(JSON.parse(g.serialize()), region());
    delete copy.state.analytics.days[0].lbl;
    const res = aggregate(copy, { groupBy: 'network', days: { last: 9 }, weather: 'dry' });
    expect(res.coverage.unlabelled).toEqual([copy.state.analytics.days[0].day]);
    expect(res.notes.some((n) => n.includes('recorded before the weather'))).toBe(true);
  });

  it('by traveller type: boardings add up to the line’s, journeys to the network’s', () => {
    const byType = aggregate(g, { groupBy: 'type', days: { last: 7 } });
    const net = aggregate(g, { groupBy: 'network', days: { last: 7 } });
    expect(sumOf(byType.rows, 'boardings')).toBe(net.total.values.boardings);
    expect(sumOf(byType.rows, 'journeys')).toBe(net.total.values.journeys);
    expect(byType.rows.length).toBe(TRAVELLERS.length);
    expect(byType.rows[0].label).toBe(TRAVELLERS[+byType.rows[0].key].label);
    // a line's boardings by type, band by band, add up to its whole-day figure
    const line = Object.keys(g.state.routes)[0];
    const whole = aggregate(g, { groupBy: 'type', days: { last: 7 }, lines: [line] });
    const bands = ([[0, 6], [6, 10], [10, 16], [16, 20], [20, 24]] as [number, number][]).map((hours) => aggregate(g, { groupBy: 'type', days: { last: 7 }, lines: [line], hours }));
    for (const r of whole.rows) expect(bands.reduce((a, b) => a + (b.rows.find((x) => x.key === r.key)?.values.boardings ?? 0), 0)).toBe(r.values.boardings);
    // journeys of one type between stops add up to that type's journeys
    const commuters = byType.rows.find((r) => (r.values.journeys ?? 0) > 0)!;
    const od = odMatrix(g, { level: 'stop', days: { last: 7 }, type: +commuters.key });
    expect(od.total.journeys).toBeCloseTo(commuters.values.journeys!, 6);
  });

  it('weeks roll up whole game weeks', () => {
    const weeks = g.state.analytics.weeks!;
    expect(weeks.length).toBe(2);
    expect(weeks[0].n).toBe(7);
    expect(weeks[1].n).toBe(2);
    const first = days.filter((d) => d.lbl!.week === weeks[0].w);
    const j = (d: DayRecord) => d.net.j.reduce((a, b) => a + b, 0);
    expect(weeks[0].net[0]).toBe(first.reduce((a, d) => a + j(d), 0));
    const lineB = Object.values(weeks[0].r).reduce((a, r) => a + r[0], 0);
    expect(lineB).toBe(first.reduce((a, d) => a + Object.values(d.routes).reduce((x, r) => x + r.b.reduce((p, q) => p + q, 0), 0), 0));
    // boardings by type add up to the line's boardings
    for (const r of Object.values(weeks[0].r)) expect(r.slice(2).reduce((a, b) => a + b, 0)).toBe(r[0]);
    const wx = weeks[0].wx;
    expect(wx[0] + wx[2] + wx[4]).toBe(7);
    const autumn = seasonYears(g.state, 'autumn');
    expect(autumn.length).toBe(1);
    expect(autumn[0].days).toBe(9);
  });

  it('the activity engine’s additions keep a day record within 30% of its old size', () => {
    for (const rec of days.slice(-3)) {
      const full = JSON.stringify(rec).length;
      const old = JSON.parse(JSON.stringify(rec)) as DayRecord;
      delete old.lbl; delete old.odk; delete old.net.jk; delete old.net.sk; delete old.net.lk; delete old.net.sd;
      for (const s of Object.values(old.stops)) delete s.k;
      for (const r of Object.values(old.routes)) { delete r.k; delete r.bp; }
      expect(full / JSON.stringify(old).length).toBeLessThan(1.3);
    }
  });
});

describe('event days', () => {
  it('a day whose crowd your buses carried is an event day, with the results brought up to date after midnight', () => {
    const g = newGame({ extraFunds: 500_000 });
    buildLine(g, { buses: 2, stops: 6 });
    const p = (g.region.cityPlaces ?? []).find((x) => x.category === 'stadium')!;
    const start = DAY + 21 * HOUR;
    const ev: GameEvent = { id: 'x1', kind: 'concert', place: p.id, venue: p.name, at: p.lngLat, title: `Concert at ${p.name}`, start, end: start + 2.5 * HOUR, people: 5000, ann: 0, announced: 1 };
    const e = g.state.world.events!;
    e.list = [ev];
    e.through = 100000;
    g.run(2 * DAY - g.t + 60); // day 1 closes while the concert is still on
    const live = g.state.world.events!.list[0];
    expect(g.state.analytics.days.at(-1)!.lbl!.ev).toBeUndefined(); // nobody carried yet
    live.carried = 120;
    live.lost = 4;
    g.run(DAY); // day 2 closes: day 1's results are updated
    const day1 = g.state.analytics.days.find((d) => d.day === 1)!;
    expect(day1.lbl!.ev![0]).toMatchObject({ carried: 120, lost: 4 });
    expect(eventDay(day1.lbl)).toBe('event');
    expect(eventDay(g.state.analytics.days.find((d) => d.day === 2)!.lbl)).toBe('none');
    const res = aggregate(g, { groupBy: 'network', days: { last: 3 }, eventDay: 'event' });
    expect(res.coverage.detailed).toEqual([1]);
  });
});
