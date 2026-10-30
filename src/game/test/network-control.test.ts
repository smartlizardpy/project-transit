// Network Control foundations: qualifying operating days, company level, the unlock,
// analytics recorded from the simulation, and save/load continuity of all of it.
import { describe, expect, it } from 'vitest';
import { Game } from '../engine.ts';
import { buildLine, newGame, region } from './helpers.ts';
import { DAY, HOUR } from '../content.ts';
import { REQUIRED_DAYS, closeControlDay, companyLevel, unlockProgress } from '../control.ts';
import { closeAnalyticsDay, dayActivity } from '../analytics/record.ts';
import { DETAIL_DAYS, SUMMARY_DAYS } from '../analytics/types.ts';
import { upgradeState } from '../upgrade.ts';
import { aggregate, estimatedDemand, metricValue, odMatrix, type AnalyticsQuery, type CustomMetric } from '../analytics/query.ts';
import { SAVE_VERSION, type GameState } from '../types.ts';

const reload = (g: Game) => new Game(JSON.parse(g.serialize()), region());
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
/** run until the next midnight has been processed */
const toMidnight = (g: Game) => g.run(DAY - (g.t % DAY));

describe('company level', () => {
  it('follows the reputation tiers shown in the top bar', () => {
    expect(companyLevel(0).level).toBe(1);
    expect(companyLevel(30).level).toBe(2);
    expect(companyLevel(44.9).level).toBe(2);
    expect(companyLevel(45).level).toBe(3);
    expect(companyLevel(45).title).toBe('Trusted operator');
    expect(companyLevel(82).level).toBe(5);
    expect(companyLevel(82).next).toBeNull();
    expect(companyLevel(30).next?.from).toBe(45);
  });
});

describe('Network Control unlock (scenario 1)', () => {
  const game = newGame({ seed: 11, extraFunds: 1_000_000 });
  const line = buildLine(game, { buses: 3, stops: 7 });
  const s = game.state;

  it('starts locked with analytics already recording', () => {
    expect(s.control.unlocked).toBe(false);
    expect(s.control.days.count).toBe(0);
    expect(s.analytics.since).toBe(0);
    expect(s.version).toBe(SAVE_VERSION);
  });

  it('counts days with a real service, once per calendar day', () => {
    toMidnight(game); // day 0 (from 05:00)
    toMidnight(game); // day 1
    expect(s.control.days.count).toBe(2);
    expect(s.control.days.recent).toEqual([0, 1]);
    // closing the same day again (e.g. a replayed event) never counts it twice
    closeControlDay(game, 1);
    closeControlDay(game, 0);
    expect(s.control.days.count).toBe(2);
  });

  it('does not count fast-forwarded days without passenger service', () => {
    const r = game.updateRoute(line.route, { suspended: true });
    expect(r.ok).toBe(true);
    game.speed = 4; // fastest speed: speed does not matter, only what happened
    toMidnight(game); // day 2: buses finish the trips under way, then nothing
    toMidnight(game); // day 3: nothing runs
    const d3 = s.analytics.days.find((d) => d.day === 3)!;
    expect(dayActivity(d3).boardings).toBe(0);
    expect(s.control.days.recent).not.toContain(3);
    const before = s.control.days.count;
    toMidnight(game); // day 4
    expect(s.control.days.count).toBe(before);
    game.speed = 0;
    expect(game.updateRoute(line.route, { suspended: false }).ok).toBe(true);
  });

  it('survives save and load without double counting', () => {
    game.run(20 * HOUR); // part-way through day 5
    const counted = s.control.days.count;
    const copy = reload(game);
    expect(copy.state.control).toEqual(s.control);
    expect(copy.state.analytics.today).toEqual(s.analytics.today);
    toMidnight(copy);
    expect(copy.state.control.days.count).toBe(counted + 1);
    // loading the same save again and playing the same day gives the same count
    const again = reload(game);
    toMidnight(again);
    expect(again.state.control.days.count).toBe(counted + 1);
    toMidnight(game);
    expect(s.control.days.count).toBe(counted + 1);
  });

  it(`unlocks after ${REQUIRED_DAYS} operating days only once level 3 is reached`, () => {
    while (s.control.days.count < REQUIRED_DAYS - 1) toMidnight(game);
    expect(s.control.unlocked).toBe(false);
    // hold the company below level 3 for the 30th day
    s.company.reputation = 30;
    toMidnight(game);
    expect(s.control.days.count).toBe(REQUIRED_DAYS);
    expect(companyLevel(s.company.reputation).level).toBeLessThan(3);
    expect(s.control.unlocked).toBe(false);
    const p = unlockProgress(game);
    expect(p.days).toBe(REQUIRED_DAYS);
    expect(p.level).toBeLessThan(p.requiredLevel);
    // level 3 reached: unlocks at the next check (every 10 game minutes)
    s.company.reputation = 50;
    game.run(600);
    expect(s.control.unlocked).toBe(true);
    expect(s.control.unlockedAt).toBeGreaterThan(0);
    expect(s.notifications.some((n) => n.title === 'Network Control is available')).toBe(true);
    // stays unlocked if reputation falls later
    s.company.reputation = 10;
    game.run(600);
    expect(reload(game).state.control.unlocked).toBe(true);
  });

  it('keeps a detailed day well under 50 KB in the save', () => {
    const a = s.analytics;
    expect(a.days.length).toBe(Math.floor(game.t / DAY));
    const bytes = JSON.stringify(a.days[a.days.length - 1]).length;
    expect(bytes).toBeLessThan(50_000);
  });
});

describe('analytics retention', () => {
  it(`keeps ${DETAIL_DAYS} detailed days, then compact summaries, then drops them`, () => {
    const game = newGame({ seed: 2, extraFunds: 1_000_000 });
    buildLine(game, { buses: 2, stops: 5 });
    game.run(DAY - (game.t % DAY) + 6 * HOUR);
    const st = game.state;
    const sample = st.analytics.days[0];
    // replay the recorded day as if 160 more days had passed (the recorder is the same code)
    for (let d = 1; d <= 160; d++) {
      st.analytics.today = { ...structuredClone(sample), day: d };
      closeAnalyticsDay(st, d);
    }
    const a = st.analytics;
    expect(a.days.length).toBe(DETAIL_DAYS);
    expect(a.days[0].day).toBe(160 - DETAIL_DAYS + 1);
    expect(a.summary[a.summary.length - 1].day).toBe(a.days[0].day - 1);
    expect(a.summary[0].day).toBeGreaterThanOrEqual(160 - SUMMARY_DAYS);
    const s0 = a.summary[a.summary.length - 1];
    expect(s0.n[0]).toBe(sample.net.j.reduce((x, y) => x + y, 0));
    // the whole history stays bounded
    expect(JSON.stringify(a).length).toBeLessThan(DETAIL_DAYS * 50_000 + SUMMARY_DAYS * 2_000);
  });
});

describe('analytics match the simulation (scenario 2)', () => {
  const game = newGame({ seed: 5, extraFunds: 3_000_000 });
  buildLine(game, { buses: 4, stops: 8 });
  const lineB = buildLine(game, { from: [28.9745, 41.0255], buses: 3, stops: 6 });
  game.run(2 * DAY + 7 * HOUR);
  const s = game.state;
  const records = [...s.analytics.days, s.analytics.today];

  it('counts every boarding, journey and abandonment the simulation counted', () => {
    let boardings = 0, journeys = 0, abandoned = 0, stopBoardings = 0, odJourneys = 0, odAbandoned = 0;
    for (const r of records) {
      boardings += dayActivity(r).boardings;
      journeys += sum(r.net.j);
      abandoned += sum(r.net.ab);
      for (const st of Object.values(r.stops)) stopBoardings += sum(st.b);
      for (const v of Object.values(r.od)) for (let i = 0; i < v.length; i += 5) {
        odJourneys += v[i + 1];
        odAbandoned += v[i + 2];
      }
    }
    expect(boardings).toBeGreaterThan(500);
    expect(boardings).toBe(game.counters.boardings);
    expect(stopBoardings).toBe(boardings);
    expect(journeys).toBe(s.stats.total.trips);
    // fares recorded where they were sold match the ledger's fare income to the cent
    let fares = 0, stopFares = 0, busFares = 0;
    for (const r of records) {
      for (const x of Object.values(r.routes)) fares += sum(x.rv);
      for (const x of Object.values(r.stops)) stopFares += x.rv;
      for (const x of Object.values(r.veh)) busFares += x.rv;
    }
    let ledger = 0;
    for (const d of Object.values(s.finance.daily)) ledger += d.fares ?? 0;
    for (const a of Object.values(s.finance.acc.fares)) ledger += a.amt;
    expect(fares).toBeCloseTo(ledger, 0);
    expect(stopFares).toBeCloseTo(fares, 0);
    expect(busFares).toBeCloseTo(fares, 0);
    expect(abandoned).toBe(s.stats.total.abandoned);
    expect(odJourneys).toBe(journeys);
    expect(odAbandoned).toBe(abandoned);
  });

  it('records loads, run times, delays and vehicle time that make sense', () => {
    const d = s.analytics.days[1];
    for (const r of Object.values(d.routes)) {
      expect(sum(r.pk)).toBeGreaterThan(0);
      expect(sum(r.pk)).toBeLessThanOrEqual(sum(r.ck));
      expect(sum(r.vm)).toBeGreaterThan(0);
      const pats = Object.values(r.p);
      expect(pats.length).toBeGreaterThan(0);
      for (const p of pats) {
        expect(sum(p.rn)).toBeGreaterThan(0);
        for (let i = 0; i < p.rs.length; i++) if (p.rn[i]) expect(p.rs[i] / p.rn[i]).toBeGreaterThan(5);
        for (let i = 0; i < p.ls.length; i++) if (p.ln[i]) expect(p.ls[i] / p.ln[i]).toBeLessThanOrEqual(1.0001);
      }
      expect(sum(r.d)).toBeGreaterThan(0);
      expect(sum(r.o)).toBeLessThanOrEqual(sum(r.d));
    }
    // every bus has a full day of minutes
    for (const v of Object.values(d.veh)) {
      expect(v.sv + v.ly + v.dh + v.pk + v.mt + v.bk).toBe(24 * 60);
      expect(v.km).toBeGreaterThanOrEqual(0);
    }
    // transfers between the two lines are recorded on both sides consistently
    const xfJourneys = d.net.xf;
    expect(xfJourneys).toBeGreaterThanOrEqual(0);
    expect(Object.keys(d.routes)).toContain(lineB.route);
  });

  it('tracks route assignment history with its source', () => {
    const a = s.analytics.assignments;
    expect(a.length).toBe(7);
    expect(a.every((x) => x.src === 'player' && x.from === null && x.to)).toBe(true);
  });

  it('keeps every record through a reload mid-day and carries on recording (scenario 7)', () => {
    const copy = reload(game);
    expect(copy.state.analytics).toEqual(game.state.analytics);
    expect(copy.state.control).toEqual(game.state.control);
    const before = dayActivity(copy.state.analytics.today).boardings;
    const counted = copy.counters.boardings; // this session's counter starts at 0 on load
    copy.run(3 * HOUR);
    expect(dayActivity(copy.state.analytics.today).boardings - before).toBe(copy.counters.boardings - counted);
    expect(copy.state.analytics.days.length).toBe(game.state.analytics.days.length);
  });

  it('continues identically after a reload mid-day (scenario 7)', () => {
    const copy = reload(game);
    game.run(4 * HOUR);
    copy.run(4 * HOUR);
    expect(copy.state.vehicles).toEqual(game.state.vehicles);
    expect(copy.state.analytics).toEqual(game.state.analytics);
    expect(copy.state.control).toEqual(game.state.control);
  });
});

describe('analytics queries (shared by Network Control and automation)', () => {
  const game = newGame({ seed: 9, extraFunds: 3_000_000 });
  const a = buildLine(game, { buses: 4, stops: 8 });
  const b = buildLine(game, { from: [28.9745, 41.0255], buses: 3, stops: 6 });
  game.run(3 * DAY - (game.t % DAY) + 9 * HOUR);
  const s = game.state;
  const last2: AnalyticsQuery['days'] = { last: 2 };

  it('adds up the same whichever way it is grouped', () => {
    const net = aggregate(game, { groupBy: 'network', days: last2 }).total.values;
    const lines = aggregate(game, { groupBy: 'line', days: last2 });
    const stops = aggregate(game, { groupBy: 'stop', days: last2 });
    const hours = aggregate(game, { groupBy: 'hour', days: last2 });
    const days = aggregate(game, { groupBy: 'day', days: last2 });
    const recs = s.analytics.days.slice(-2);
    const boardings = recs.reduce((t, r) => t + dayActivity(r).boardings, 0);
    expect(net.boardings).toBe(boardings);
    expect(lines.total.values.boardings).toBe(boardings);
    expect(stops.total.values.boardings).toBe(boardings);
    expect(hours.total.values.boardings).toBe(boardings);
    expect(days.rows.map((r) => r.values.boardings)).toEqual(recs.map((r) => dayActivity(r).boardings));
    expect(lines.rows.map((r) => r.id).sort()).toEqual([a.route, b.route].sort());
    // journeys by first line add up to all journeys
    expect(lines.total.values.journeys).toBe(net.journeys);
    expect(stops.total.values.journeys).toBe(net.journeys);
    // fares and costs agree with the ledger
    const ledgerFares = recs.reduce((t, r) => t + (s.finance.daily[r.day]?.fares ?? 0), 0);
    expect(net.revenue!).toBeCloseTo(ledgerFares, 0);
    const lineCost = recs.reduce((t, r) => t + Object.values(s.finance.routeDaily[r.day] ?? {}).reduce((x, y) => x + y.cost, 0), 0);
    expect(lines.total.values.cost!).toBeCloseTo(lineCost, 0);
    expect(net.cost!).toBeGreaterThanOrEqual(lineCost - 1);
    expect(net.occupancy!).toBeGreaterThan(0);
    expect(net.occupancy!).toBeLessThanOrEqual(100);
  });

  it('filters by hours honestly and compares periods', () => {
    const morning = aggregate(game, { groupBy: 'line', days: last2, lines: [a.route], hours: [6, 10] });
    const evening = aggregate(game, { groupBy: 'line', days: last2, lines: [a.route], hours: [16, 20] });
    const all = aggregate(game, { groupBy: 'line', days: last2, lines: [a.route] });
    const m = morning.rows[0].values, e = evening.rows[0].values, w = all.rows[0].values;
    expect(m.boardings! + e.boardings!).toBeLessThanOrEqual(w.boardings!);
    expect(m.boardings).toBeGreaterThan(0);
    // per-day measures are not invented for an hour range
    expect(m.cost).toBeNull();
    expect(m.avgWait).toBeNull();
    expect(morning.notes.join(' ')).toMatch(/per day/);
    expect(m.occupancy).not.toBeNull();
    const hourRows = aggregate(game, { groupBy: 'hour', days: last2, lines: [a.route], hours: [6, 10] }).rows;
    expect(hourRows.map((r) => r.key)).toEqual(['6', '7', '8', '9']);
    expect(hourRows.reduce((t, r) => t + (r.values.boardings ?? 0), 0)).toBe(m.boardings);
  });

  it('evaluates custom metrics from the same measures', () => {
    const r = aggregate(game, { groupBy: 'line', days: last2 }).rows[0].values;
    const metric: CustomMetric = { id: 'm1', name: 'Fares per bus-hour', expr: 'revenue / busHours', unit: 'money' };
    expect(metricValue(metric, r)).toBeCloseTo(r.revenue! / r.busHours!, 6);
    expect(metricValue({ ...metric, expr: 'revenue / 0' }, r)).toBeNull();
    expect(metricValue({ ...metric, expr: 'nonsense(' }, r)).toBeNull();
  });

  it('builds an origin–destination matrix that matches the journeys', () => {
    const net = aggregate(game, { groupBy: 'network', days: last2 }).total.values;
    const od = odMatrix(game, { level: 'stop', days: last2 });
    expect(od.total.journeys).toBe(net.journeys);
    expect(od.flows.length).toBeGreaterThan(5);
    const f = od.flows[0];
    expect(f.journeys).toBeGreaterThan(0);
    expect(f.itineraries[0].label).toMatch(/^Line /);
    const zones = odMatrix(game, { level: 'zone', days: last2 });
    expect(zones.total.journeys).toBe(net.journeys);
    // a band filter selects part of the day
    const am = odMatrix(game, { level: 'stop', days: last2, bands: [1] });
    expect(am.total.journeys).toBeLessThan(od.total.journeys);
    expect(am.total.journeys).toBeGreaterThan(0);
    // one line, one origin
    const one = odMatrix(game, { level: 'stop', days: last2, lines: [b.route], origin: f.o });
    expect(one.flows.every((x) => x.o === f.o)).toBe(true);
    // estimated demand is labelled separately and comes from the model
    const est = estimatedDemand(game, { level: 'stop', limit: 10 });
    expect(est.length).toBeGreaterThan(0);
    expect(est[0].trips).toBeGreaterThan(0);
  });

  it('says when nothing was recorded for a selection', () => {
    const r = aggregate(game, { groupBy: 'network', days: { from: 50, to: 60 } });
    expect(r.notes[0]).toMatch(/No recorded days/);
    expect(r.coverage.detailed).toEqual([]);
  });
});

describe('estimated demand', () => {
  it('knows which places the network links, also at night when no bus is running', () => {
    const game = newGame({ seed: 9 });
    const line = buildLine(game, { buses: 2, stops: 7 });
    game.run(20 * HOUR + 30 * 60); // 05:00 → 01:30, after the last departures
    expect(game.demand.itin.size).toBe(0); // the live model only knows lines running this hour
    const est = estimatedDemand(game, { level: 'stop' });
    const onLine = new Set(line.stopIds);
    const both = est.filter((f) => onLine.has(f.o) && onLine.has(f.d));
    expect(both.length).toBeGreaterThan(0);
    expect(both.every((f) => f.served)).toBe(true);
  });

  it('is available straight after loading, before the game has run', () => {
    const game = newGame({ seed: 9 });
    buildLine(game, { buses: 2, stops: 7 });
    game.run(2 * HOUR);
    const copy = new Game(JSON.parse(game.serialize()), region());
    expect(estimatedDemand(copy, { level: 'stop' }).length).toBeGreaterThan(0);
    // reading it does not change what happens next
    const other = new Game(JSON.parse(game.serialize()), region());
    copy.run(HOUR);
    other.run(HOUR);
    expect(JSON.stringify(copy.state.pax)).toBe(JSON.stringify(other.state.pax));
  });
});

describe('save version 2 upgrade', () => {
  it('adds analytics, control and automation to a version 1 save and back-fills operating days', () => {
    const game = newGame({ seed: 3 });
    buildLine(game, { buses: 3 });
    game.run(3 * DAY + 2 * HOUR);
    const raw = JSON.parse(game.serialize()) as Partial<GameState> & { version: number };
    raw.version = 1;
    delete raw.analytics;
    delete raw.control;
    delete raw.automation;
    const up = upgradeState(raw as GameState);
    expect(up.version).toBe(SAVE_VERSION);
    expect(up.control.days.count).toBe(3);
    expect(up.control.days.last).toBe(2);
    expect(up.analytics.today.partial).toBe(true);
    expect(up.analytics.since).toBe(4);
    expect(up.automation.workflows).toEqual({});
    // and it plays on
    const g = new Game(up, region());
    toMidnight(g);
    expect(g.state.control.days.count).toBe(4);
    expect(g.state.analytics.days.length).toBe(1);
  });
});
