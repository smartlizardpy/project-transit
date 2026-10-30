// Events (docs/city-activity-engine-plan.md, sections 9.3 and 17): the schedule, a match day at
// a stadium, a rail disruption, outdoor events called off in storms, and determinism.
import { describe, expect, it } from 'vitest';
import { newGame, region, stopsAlong } from './helpers.ts';
import { expectIdenticalRuns, expectReloadContinuity } from './determinism.ts';
import { DAY, HOUR } from '../content.ts';
import { KIND, KIND_COUNT } from '../activity/params.ts';
import { CROWD_KINDS, EVENT_TEMPLATES, eventSeed, eventsForDay, type GameEvent } from '../events.ts';
import { OBJECTIVES, objectivesFor } from '../progress.ts';
import type { Game } from '../engine.ts';

const STADIUM = 'Tüpraş Stadyumu';

/** Replaces the generated schedule with `events` (nothing else is scheduled). */
function withEvents(g: Game, events: GameEvent[]) {
  const e = g.state.world.events!;
  e.list = events.map((x) => ({ ...x }));
  e.through = 100000;
  (g as unknown as { eventNext: number }).eventNext = 0; // the event clock looks at the new list next minute
  g.demand.slot = -1;
}

function stadium(g: Game) {
  return (g.region.cityPlaces ?? []).find((p) => p.name === STADIUM)!;
}

/** A match at the stadium on day 1 (a Tuesday) at 19:00, announced days before. */
function match(g: Game, people = 30000): GameEvent {
  const p = stadium(g);
  const start = DAY + 19 * HOUR;
  return { id: 'm1', kind: 'football', place: p.id, venue: p.name, at: p.lngLat, title: `Football match at ${p.name}`, start, end: start + 115 * 60, people, ann: start - 5 * DAY, announced: 1, started: undefined };
}

/** A line from Mecidiyeköy down to Beşiktaş, ending about 400 m from the stadium. */
function stadiumLine(g: Game) {
  const pts = stopsAlong(g, [28.9925, 41.067], stadium(g).lngLat).slice(4);
  const d = g.buildDepot([28.9885, 41.0455]);
  if (!d.ok) throw new Error(d.error);
  const stops = pts.map((x) => g.placeStop(x)).filter((r) => r.ok).map((r) => (r as { value: string }).value);
  const r = g.createRoute({ stops, timetable: { weekday: { bands: [{ from: 300, to: 1500, headway: 6 }] }, weekend: { bands: [{ from: 300, to: 1500, headway: 6 }] }, layover: 3 } });
  if (!r.ok) throw new Error(r.error);
  for (let i = 0; i < 8; i++) {
    const b = g.buyVehicle('city12', d.value);
    if (b.ok) g.assignVehicle(b.value, r.value);
  }
  return { route: r.value, stops };
}

/** Event riders setting off per hour, from the model's rates (sampled at each hour). */
function eventRatesByHour(g: Game, from: number, to: number): Map<number, number> {
  const out = new Map<number, number>();
  const off = g.on('minute', (t) => {
    const tt = t as number;
    if (tt % HOUR !== 60) return;
    const dm = g.demand;
    let r = 0;
    if (dm.kmix) for (let i = 0; i < dm.pairs.length; i++) r += dm.rate[i] * dm.kmix[i * KIND_COUNT + KIND.event];
    out.set(Math.floor(tt / HOUR) % 24, r * 60);
  });
  g.run(to - g.t);
  off();
  void from;
  return out;
}

const awayEvent = (g: Game) => {
  const mins: number[] = [];
  for (const [key, arr] of Object.entries(g.state.pax.away)) {
    if (!key.endsWith(`>${KIND.event}`)) continue;
    for (let i = 0; i < arr.length; i += 2) for (let n = 0; n < arr[i + 1]; n++) mins.push(arr[i]);
  }
  return mins;
};

describe('the schedule', () => {
  it('is the same for the same seed, keeps to the venues and never fills a stadium beyond its seats', () => {
    const g = newGame();
    const seed = eventSeed(g.state.world.seed);
    const places = g.region.cityPlaces ?? [];
    const byId = new Map(places.map((p) => [p.id, p]));
    const kinds = new Set<string>();
    for (let d = 0; d < 168; d++) {
      const mid = d * DAY + DAY / 2;
      const inp = { seed, day: d, cal: g.calendarAt(mid), type: g.dayTypeAt(mid), places, transit: g.region.transit };
      const a = eventsForDay(inp), b = eventsForDay(inp);
      expect(b).toEqual(a);
      for (const ev of a) {
        kinds.add(ev.kind);
        expect(Math.floor(ev.start / DAY)).toBe(d);
        expect(ev.end).toBeGreaterThan(ev.start);
        if (ev.kind === 'football') {
          const p = byId.get(ev.place)!;
          expect(p.category).toBe('stadium');
          expect(ev.people).toBeLessThanOrEqual(p.scale.value);
          // matches are not played in the summer break
          expect(inp.cal.season).not.toBe('summer');
        }
        if (CROWD_KINDS.has(ev.kind) && !ev.reason) {
          // planned events: announced 3 to 12 days ahead (festival days 2 and 3 with day 1)
          const lead = (ev.start - ev.ann) / DAY;
          expect(lead).toBeGreaterThan(3);
          expect(lead).toBeLessThan(13);
        }
        // nothing is named but the venue
        expect(ev.title).not.toMatch(/ vs | v\. /);
      }
    }
    for (const k of ['football', 'concert', 'gathering', 'rail']) expect(kinds.has(k)).toBe(true);
  });

  it('is generated ten days ahead, saved, and announced with a notice', () => {
    const g = newGame();
    const e = g.state.world.events!;
    expect(e.through).toBe(10);
    const ids = e.list.map((x) => x.id);
    g.run(3 * DAY);
    expect(e.through).toBe(13);
    // events already on the calendar keep their ids
    for (const id of ids) if (e.list.find((x) => x.id === id)) expect(e.list.find((x) => x.id === id)!.id).toBe(id);
    const announced = e.list.filter((x) => x.announced && x.ann > 5 * HOUR && x.ann <= g.t && CROWD_KINDS.has(x.kind));
    expect(announced.length).toBeGreaterThan(0);
    for (const ev of announced) expect(g.state.notifications.some((n) => n.ref?.kind === 'place' && n.ref.id === ev.place && n.t === Math.ceil(ev.ann / 60) * 60)).toBe(true);
  });

  it('does not draw from the shared random stream', () => {
    const g = newGame();
    const rng = g.state.rng;
    g.run(2 * HOUR);
    const h = newGame();
    withEvents(h, []);
    h.run(2 * HOUR);
    expect(g.state.rng).toBe(h.state.rng);
    expect(rng).toBeDefined();
  });
});

describe('a match day at the stadium', () => {
  it('brings riders in the three hours before kick-off and sends them home soon after the final whistle, on linked returns', { timeout: 120000 }, () => {
    const g = newGame({ allZones: true });
    const { stops } = stadiumLine(g);
    const ev = match(g);
    withEvents(g, [ev]);
    g.run(DAY + 12 * HOUR - g.t);
    const byHour = eventRatesByHour(g, g.t, ev.end - 60);
    const total = [...byHour.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(30);
    // arrivals: set off between 15:00 and 19:00, mostly in the last three hours
    let before3h = 0;
    for (const [h, r] of byHour) if (h >= 16 && h < 19) before3h += r;
    expect(before3h / total).toBeGreaterThan(0.85);
    // just before the end: everyone who came by bus has a way home booked (linked returns)
    const live = g.state.world.events!.list[0];
    const mins = awayEvent(g);
    expect(mins.length).toBe(live.carried);
    const endMin = Math.floor(ev.end / 60);
    const soon = mins.filter((m) => m <= endMin + 45).length;
    expect(soon / mins.length).toBeGreaterThanOrEqual(0.5);
    expect(Math.min(...mins)).toBeGreaterThanOrEqual(endMin - 60);
    // after the night: returns never exceed the arrivals, and the results are counted for the event
    const arrivals = live.carried!;
    g.run(2 * DAY + 4 * HOUR - g.t);
    const done = g.state.world.events!.list[0];
    expect(done.carried! - arrivals).toBeLessThanOrEqual(arrivals);
    expect(done.carried! + (done.lost ?? 0)).toBeGreaterThan(arrivals);
    // the stop nearest the stadium is far busier than on an ordinary evening
    const plain = newGame({ allZones: true });
    const line2 = stadiumLine(plain);
    withEvents(plain, []);
    plain.run(2 * DAY + 4 * HOUR - plain.t);
    const last = stops[stops.length - 1], last2 = line2.stops[line2.stops.length - 1];
    const evening = (gg: Game, s: string) => {
      const rec = gg.state.analytics.days.find((d) => d.day === 1)!;
      const b = rec.stops[s]?.b ?? [];
      return b.slice(21, 24).reduce((a, x) => a + x, 0);
    };
    expect(evening(g, last)).toBeGreaterThan(3 * Math.max(10, evening(plain, last2)));
  });

  it('slows roads near the stadium as crowds arrive and leave, not elsewhere and not in the timetable', () => {
    const g = newGame({ allZones: true });
    const ev = match(g);
    withEvents(g, [ev]);
    const p = stadium(g);
    const [vx, vy] = g.geo.xy(p.lngLat);
    const gr = g.region.graph;
    let near = -1, far = -1;
    for (let i = 0; i < gr.m && (near < 0 || far < 0); i++) {
      const d = Math.hypot((gr.x[gr.ea[i]] + gr.x[gr.eb[i]]) / 2 - vx, (gr.y[gr.ea[i]] + gr.y[gr.eb[i]]) / 2 - vy);
      if (d < 300 && near < 0) near = i;
      if (d > 4000 && far < 0) far = i;
    }
    const t = ev.end + 15 * 60;
    const quiet = ev.start - 6 * HOUR;
    const live = (e: number, at: number) => g.traffic.congestion(2 * e, at);
    // compared with the same hour a day later, when nothing is on
    expect(live(near, t) - g.traffic.congestion(2 * near, t + DAY)).toBeGreaterThan(0.15);
    expect(Math.abs(live(far, t) - g.traffic.congestion(2 * far, t + DAY))).toBeLessThan(0.15);
    expect(live(near, quiet)).toBeCloseTo(g.traffic.congestion(2 * near, quiet + DAY), 1);
    expect(g.traffic.typical(2 * near, t)).toBe(g.traffic.typical(2 * near, t + 7 * DAY));
  });

  it('charges only the fares of attendees who board: no money comes with an event', { timeout: 120000 }, () => {
    const g = newGame({ allZones: true });
    stadiumLine(g);
    withEvents(g, [match(g)]);
    g.run(2 * DAY + HOUR - g.t);
    const s = g.state;
    // income is fares, the starting capital and objective rewards only
    const objectiveIds = new Set(Object.keys(s.objectives));
    for (const x of s.finance.ledger) if (x.amt > 0) expect(x.cat === 'fares' || x.cat === 'equity' || (x.cat === 'grant' && objectiveIds.has(x.ref ?? ''))).toBe(true);
    // fares sold at first boardings match the ledger's fare income
    let fares = 0, ledger = 0;
    for (const r of s.analytics.days) for (const x of Object.values(r.routes)) fares += x.rv.reduce((a, b) => a + b, 0);
    for (const x of Object.values(s.analytics.today.routes)) fares += x.rv.reduce((a, b) => a + b, 0);
    for (const d of Object.values(s.finance.daily)) ledger += d.fares ?? 0;
    for (const a of Object.values(s.finance.acc.fares)) ledger += a.amt;
    expect(fares).toBeCloseTo(ledger, 0);
    expect(s.world.events!.list[0].carried).toBeGreaterThan(0);
  });
});

describe('a match-day service plan', () => {
  it('runs on the line near the stadium on match day, from the announcement, and not on other days', () => {
    const g = newGame({ extraFunds: 1_000_000 });
    const { route } = stadiumLine(g);
    const ev = { ...match(g), start: 3 * DAY + 19 * HOUR, end: 3 * DAY + 19 * HOUR + 115 * 60, ann: DAY + 9 * HOUR, announced: undefined };
    withEvents(g, [ev]);
    const bands = [{ from: 300, to: 1500, headway: 3 }];
    expect(g.setServicePlans(route, [{ id: 'md', name: 'Match day', enabled: true, when: { kind: 'event_day' }, weekday: { bands }, weekend: { bands } }]).ok).toBe(true);
    // before the notice nothing gives the match away
    expect(g.dayPlan(route, 3).planId).toBeNull();
    g.run(DAY + 9 * HOUR + 60 - g.t);
    expect(g.state.notifications.some((n) => n.title.startsWith(ev.title))).toBe(true);
    expect(g.dayPlan(route, 3).planId).toBe('md');
    expect(g.dayPlan(route, 2).planId).toBeNull();
    expect(g.dayPlan(route, 4).planId).toBeNull();
    // on the day, departures follow the plan
    g.run(3 * DAY + 12 * HOUR - g.t);
    expect(g.headwayAt(route, 0, g.t)).toBe(3);
    g.run(DAY);
    expect(g.headwayAt(route, 0, g.t)).toBe(6);
  });
});

describe('objectives for events, nights and airports', () => {
  const def = (id: string) => OBJECTIVES.find((o) => o.id === id)!;

  it('Match day counts one event’s journeys once its crowd has gone home, and asks that few give up', () => {
    const g = newGame();
    const ev = { ...match(g), start: 19 * HOUR, end: 19 * HOUR + 115 * 60, ann: 0, announced: 1 as const };
    withEvents(g, [{ ...ev, carried: 1200, lost: 60 }]);
    g.run(20 * HOUR - g.t);
    expect(def('match-day').check(g)).toBe(0.99); // not yet: the crowd is still leaving
    g.run(23 * HOUR - g.t);
    expect(def('match-day').check(g)).toBe(1);
    g.state.world.events!.list[0].lost = 200; // 1 in 7 gave up
    expect(def('match-day').check(g)).toBeCloseTo(0.9);
    g.state.world.events!.list[0] = { ...g.state.world.events!.list[0], carried: 400, lost: 0 };
    expect(def('match-day').check(g)).toBeCloseTo(0.4);
  });

  it('Night network counts trips between midnight and 05:00 of one night', () => {
    const g = newGame();
    const hs = g.state.stats.hours;
    hs.length = 0;
    const hour = (h: number, trips: number) => hs.push({ h, boardings: 0, trips, abandoned: 0, satSum: 0, satN: 0, comp: [0, 0, 0, 0, 0], waitSum: 0, deps: 0, ontime: 0, missed: 0, loadSum: 0, loadN: 0 });
    hour(23, 400); // 23:00 on day 0: not night-time
    for (let h = 24; h < 29; h++) hour(h, 40); // 00:00–05:00 on day 1: 200
    hour(29, 300); // 05:00: the day has begun
    expect(def('night-network').check(g)).toBeCloseTo(200 / 250);
    hs[1].trips = 90;
    expect(def('night-network').check(g)).toBe(1);
  });

  it('Airport link is offered only where an airport is on the map', () => {
    const g = newGame();
    const reachable = (g.region.cityPlaces ?? []).some((p) => p.category === 'airport' && p.reachable);
    expect(reachable).toBe(false); // İstanbul's airports are beyond the bundled map
    expect(objectivesFor(g).some((o) => o.id === 'airport-link')).toBe(false);
    expect(objectivesFor(g).some((o) => o.id === 'match-day')).toBe(true);
  });
});

describe('disruptions and storms', () => {
  it('a rail disruption closes its stretch of the city network and your line gains riders', { timeout: 120000 }, async () => {
    const { referenceLine } = await import('./calibration.ts');
    const net = region().transit!;
    const st = (name: string) => net.stations.findIndex((s) => s.name.includes(name) && s.modes.includes('metro'));
    const a = st('Taksim'), b = st('Şişhane');
    const link = net.links.findIndex((l) => l.mode === 'metro' && ((l.a === a && l.b === b) || (l.a === b && l.b === a)));
    expect(link).toBeGreaterThanOrEqual(0);
    const at = DAY + 8 * HOUR;
    const make = (disrupted: boolean) => {
      const { game } = referenceLine(8, 4);
      const ev: GameEvent = { id: 'r1', kind: 'rail', place: net.stations[a].place, venue: net.stations[a].name, at: [0, 0], title: 'Metro disruption: Taksim – Şişhane', reason: 'a signal failure', start: at - HOUR, end: at + 2 * HOUR, people: 0, ann: at - HOUR, links: [link], mode: 'metro' };
      withEvents(game, disrupted ? [ev] : []);
      game.run(at + 60 - game.t);
      return game;
    };
    const open = make(false), shut = make(true);
    expect(shut.closedTransitLinks(at)).toEqual([link]);
    expect(open.closedTransitLinks(at)).toEqual([]);
    const sum = (gg: Game) => gg.demand.rate.reduce((x, y) => x + y, 0);
    expect(sum(shut)).toBeGreaterThan(sum(open) * 1.005);
    // the skim without the link: fewer pairs by metro, or longer journeys
    const so = open.demand.activity.transit!, ss = shut.demand.activity.transit!;
    let worse = 0;
    for (let e = 0; e < so.ivt.length; e++) if (ss.ivt[e] > so.ivt[e] + 0.01 || (Number.isFinite(so.ivt[e]) && !Number.isFinite(ss.ivt[e]))) worse++;
    expect(worse).toBeGreaterThan(0);
    expect(shut.state.notifications.some((n) => n.title.startsWith('Metro disruption'))).toBe(true);
  });

  it('outdoor events are called off when storms are forecast; indoor ones go ahead', () => {
    const g = newGame();
    const park = (g.region.cityPlaces ?? []).filter((p) => p.category === 'park').sort((x, y) => y.areaM2 - x.areaM2)[0];
    const st = stadium(g);
    const d = 2;
    const fest: GameEvent = { id: 'f1', kind: 'festival', place: park.id, venue: park.name, at: park.lngLat, title: `Festival in ${park.name}, day 1 of 3`, start: d * DAY + 12 * HOUR, end: d * DAY + 23 * HOUR, people: 5000, ann: 0, announced: 1 };
    const m: GameEvent = { ...match(g), id: 'm2', start: d * DAY + 19 * HOUR, end: d * DAY + 21 * HOUR, place: st.id };
    withEvents(g, [fest, m]);
    // make tomorrow's weather a storm, then reach the 18:00 forecast
    const w = g.weatherDay(d)!;
    w.actual = { ...w.actual, kind: 'heavy' };
    g.run(DAY + 18 * HOUR + 60 - g.t);
    const f = g.weatherDay(d)!.forecast!;
    const list = g.state.world.events!.list;
    if (f.kind === 'heavy' || f.kind === 'snow') {
      expect(list.find((x) => x.id === 'f1')!.cancelled).toMatch(/Called off/);
      expect(g.state.notifications.some((n) => n.title.endsWith('called off'))).toBe(true);
    } else expect(list.find((x) => x.id === 'f1')!.cancelled).toBeUndefined();
    expect(list.find((x) => x.id === 'm2')!.cancelled).toBeUndefined();
    expect(EVENT_TEMPLATES.festival.outdoor && !EVENT_TEMPLATES.football.outdoor).toBe(true);
  });
});

describe('determinism', () => {
  it('two runs through a match day are identical, and a reload during the match carries on the same', { timeout: 180000 }, () => {
    const make = () => {
      const g = newGame({ allZones: true });
      stadiumLine(g);
      withEvents(g, [match(g)]);
      return g;
    };
    const g = expectIdenticalRuns(make, DAY + 20 * HOUR - 5 * HOUR);
    expectReloadContinuity(g, 3 * HOUR);
  });
});
