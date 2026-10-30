// Events (docs/city-activity-engine-plan.md, section 9.3): football matches, concerts, festivals
// and public gatherings at the city's own venues, and rare rail and flight disruptions.
//
// - Templates are data (EVENT_TEMPLATES): timing, how crowds arrive and leave, traffic, parking.
// - The schedule is a pure function of the world seed, the venue and the game day (stateless
//   hashes; nothing is drawn from the game's random stream). Days are generated ten days ahead
//   and saved, so a changed map never rewrites events already on the calendar.
// - Planned events are announced 3–10 days ahead; short-notice gatherings the day before;
//   disruptions when they start. Each comes with a reason when it is unexpected.
// - Opponents, artists and fixtures are never named: they are not fabricated, and real fixture
//   lists carry rights issues.

import type { CityPlace } from './world/places.ts';
import type { TransitNet } from './world/region.ts';
import type { LngLat } from './world/graph.ts';
import type { CalendarDay, DayType } from './calendar.ts';
import type { Curve } from './activity/params.ts';
import { hashString, mix, unit } from './hash.ts';

export const EVENTS_VERSION = 1;
/** Days ahead the schedule is generated (the longest announcement lead). */
export const EVENT_HORIZON = 10;
const DAY = 86400;
const H = 3600;

export type EventKind = 'football' | 'concert' | 'festival' | 'gathering' | 'rail' | 'flight';
export const EVENT_KINDS: EventKind[] = ['football', 'concert', 'festival', 'gathering', 'rail', 'flight'];

export interface GameEvent {
  id: string;
  kind: EventKind;
  /** the venue's place id (rail: the first station of the closed stretch; flight: the airport) */
  place: string;
  /** the venue's name and entrance when scheduled (the map may change later) */
  venue: string;
  at: LngLat;
  title: string;
  /** start and planned end, game seconds */
  start: number;
  end: number;
  /** minutes added on the day (a cup tie going to extra time), revealed at the planned end */
  extra?: number;
  /** expected attendance (0 for disruptions) */
  people: number;
  /** when it is announced, game seconds (unexpected events: when they start) */
  ann: number;
  announced?: 1;
  started?: 1;
  ended?: 1;
  /** called off (outdoor events in storms), with the reason */
  cancelled?: string;
  /** why it happens (short-notice gatherings and disruptions) */
  reason?: string;
  /** rail disruption: the closed links (indices into the transit network's links) and their mode */
  links?: number[];
  mode?: string;
  /** flight disruption: share of arrivals delayed */
  share?: number;
  /** festivals: day n of m */
  series?: [number, number];
  /** results: journeys of attendees completed on your network (both ways), and lost (gave up or stranded) */
  carried?: number;
  lost?: number;
}

export interface EventsState {
  v: number;
  nextId: number;
  /** the schedule is generated up to and including this game day */
  through: number;
  list: GameEvent[];
}

export interface EventTemplate {
  kind: EventKind;
  label: string;
  /** when attendees set off, hours relative to the start; when they leave, hours after the end */
  arrive: Curve;
  leave: Curve;
  /** people come and go (festivals): hours spent there, capped by the end */
  stay?: Curve;
  /** extra congestion on roads near the venue at the busiest moment (0–1), and how far it reaches (m) */
  traffic: number;
  radius: number;
  /** minutes added to parking at the venue and to finding a taxi */
  parking: number;
  taxiWait: number;
  outdoor: boolean;
  /** days announced ahead [min, max] */
  lead: [number, number];
}

/** Game settings (plan 9.3). Where attendees come from: the map, stations and piers, or beyond the map by car and coach. */
export const EVENT = {
  /** share of attendees from homes on the map, through its stations and piers, and from beyond (not on your network) */
  local: 0.5,
  gateway: 0.25,
  /** distance decay for attendees from homes (people travel far for events), and from stations, metres */
  decay: 9000,
  gatewayDecay: 2500,
  /** walking distance to a stop near a venue (crowds walk further than usual), metres */
  walkM: 800,
};

export const EVENT_TEMPLATES: Record<EventKind, EventTemplate> = {
  // the ramp over the 3 hours before kick-off; about 60% leave within 30 minutes of the end
  football: { kind: 'football', label: 'Football match', arrive: [[0.65, -1.0, 0.45], [0.35, -2.0, 0.6]], leave: [[0.55, 0.2, 0.15], [0.45, 0.9, 0.5]], traffic: 0.35, radius: 1500, parking: 15, taxiWait: 10, outdoor: false, lead: [6, 10] },
  // most leave within about 45 minutes
  concert: { kind: 'concert', label: 'Concert', arrive: [[0.7, -0.9, 0.45], [0.3, -1.9, 0.55]], leave: [[0.6, 0.3, 0.2], [0.4, 0.8, 0.4]], traffic: 0.25, radius: 1200, parking: 12, taxiWait: 8, outdoor: false, lead: [4, 10] },
  // all day: people come and go
  festival: { kind: 'festival', label: 'Festival', arrive: [[1, 3.5, 2.6]], leave: [[1, 0.3, 0.3]], stay: [[1, 3.5, 1.4]], traffic: 0.2, radius: 1200, parking: 10, taxiWait: 6, outdoor: true, lead: [8, 10] },
  // arrivals over 2 hours, departures concentrated
  gathering: { kind: 'gathering', label: 'Public gathering', arrive: [[1, -0.8, 0.5]], leave: [[0.7, 0.25, 0.2], [0.3, 0.8, 0.4]], traffic: 0.3, radius: 1300, parking: 15, taxiWait: 10, outdoor: true, lead: [7, 10] },
  rail: { kind: 'rail', label: 'Rail disruption', arrive: [[1, 0, 1]], leave: [[1, 0, 1]], traffic: 0, radius: 0, parking: 0, taxiWait: 0, outdoor: false, lead: [0, 0] },
  flight: { kind: 'flight', label: 'Flight disruption', arrive: [[1, 0, 1]], leave: [[1, 0, 1]], traffic: 0, radius: 0, parking: 0, taxiWait: 0, outdoor: false, lead: [0, 0] },
};

/** Events that bring crowds (the rest change the city's networks). */
export const CROWD_KINDS = new Set<EventKind>(['football', 'concert', 'festival', 'gathering']);

// ───────────────────────────────────────────── curves

const erf = (x: number) => {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
};
export function curveCdf(c: Curve, x: number): number {
  let w = 0, v = 0;
  for (const [wt, mu, sd] of c) {
    w += wt;
    v += wt * 0.5 * (1 + erf((x - mu) / (sd * Math.SQRT2)));
  }
  return w ? v / w : 0;
}
/** Window the arrival curve is kept to, hours relative to the start (festivals: from opening to an hour before closing). */
function arriveWindow(ev: GameEvent): [number, number] {
  const tpl = EVENT_TEMPLATES[ev.kind];
  return tpl.stay ? [0, Math.max(1, (ev.end - ev.start) / H - 1)] : [-4, 0.25];
}

/** Share of an event's attendees who set off in [t0, t1) (game seconds). */
export function arriveShare(ev: GameEvent, t0: number, t1: number): number {
  const c = EVENT_TEMPLATES[ev.kind].arrive;
  const [a, b] = arriveWindow(ev);
  const x0 = Math.max(a, (t0 - ev.start) / H), x1 = Math.min(b, (t1 - ev.start) / H);
  if (!(x1 > x0)) return 0;
  const tot = curveCdf(c, b) - curveCdf(c, a);
  return tot > 0 ? (curveCdf(c, x1) - curveCdf(c, x0)) / tot : 0;
}

/** The end as it happens (with any extra time). */
export const actualEnd = (ev: GameEvent) => ev.end + (ev.extra ?? 0) * 60;

/** Minutes until each of `n` attendees heads home, for people arriving at `now` (systematic sample from `u`). */
export function eventReturnMinutes(ev: GameEvent, now: number, n: number, u: number): number[] {
  const tpl = EVENT_TEMPLATES[ev.kind];
  const end = actualEnd(ev);
  const c = tpl.stay ?? tpl.leave;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const q = (i + u) / n;
    let lo = tpl.stay ? 0 : -1, hi = 12;
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      if (curveCdf(c, mid) < q) lo = mid;
      else hi = mid;
    }
    const x = Math.max(0, (lo + hi) / 2);
    // stay: hours from arrival, but out by closing time (spread over half an hour); leave: hours after the end
    const at = tpl.stay ? (now + x * H <= end ? now + x * H : end + q * 0.5 * H) : end + x * H;
    // whole minutes, rounded up: nobody leaves before the end
    out.push(Math.max(10, Math.ceil((Math.max(at, now) - now) / 60)));
  }
  return out;
}

/** Share of returns in each hour from the hour starting at `t0`, for attendees setting off then (`horizon` entries). */
export function returnShareFrom(ev: GameEvent, t0: number, horizon: number): number[] {
  const out = new Array<number>(horizon).fill(0);
  // they set off mid-hour and arrive about half an hour later
  const arr = t0 + 0.5 * H + 30 * 60;
  const mins = eventReturnMinutes(ev, arr, 24, 0.5);
  for (const m of mins) {
    const off = Math.floor((arr + m * 60 - t0) / H);
    if (off >= 0 && off < horizon) out[off] += 1 / mins.length;
  }
  return out;
}

// ───────────────────────────────────────────── the schedule

export interface ScheduleInput {
  seed: number;
  day: number;
  cal: CalendarDay;
  type: DayType;
  /** the Place Registry (reachable places only are used) */
  places: CityPlace[];
  transit?: TransitNet;
  /** a public holiday or festive week day later in the same week (for gatherings) */
}

type Draft = Omit<GameEvent, 'id'>;

const seats = (p: CityPlace) => (p.scale.unit === 'seats' ? p.scale.value : 0);
const pick = <T>(u: number, xs: [T, number][]): T => {
  const tot = xs.reduce((a, [, w]) => a + w, 0);
  let acc = 0;
  for (const [x, w] of xs) {
    acc += w / tot;
    if (u < acc) return x;
  }
  return xs[xs.length - 1][0];
};
const round50 = (n: number) => Math.max(50, Math.round(n / 50) * 50);
const at = (day: number, hours: number) => day * DAY + Math.round(hours * 60) * 60;
const WEEKDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const weekdayName = (wd: number) => WEEKDAY[wd];

/** Announcement time: `lead` days before the start day, at 09:00. */
function announceAt(seed: number, key: string, day: number, lead: [number, number]): number {
  const n = lead[0] + Math.floor(unit(seed, hashString(key), 31) * (lead[1] - lead[0] + 1));
  return (day - n) * DAY + 9 * H;
}

/** The week number of a game day (Monday-based, so every day of a week shares it). */
const weekOf = (day: number, weekday: number) => Math.floor((day - weekday) / 7);

/** Parks big enough for festivals and gatherings, largest first. */
function bigParks(places: CityPlace[]): CityPlace[] {
  return places.filter((p) => p.reachable && p.category === 'park' && p.areaM2 >= 60000).sort((a, b) => b.areaM2 - a.areaM2 || (a.id < b.id ? -1 : 1));
}

function football(inp: ScheduleInput, out: Draft[]) {
  const { seed, day, cal } = inp;
  if (cal.season === 'summer') return;
  const wk = weekOf(day, cal.weekday);
  for (const p of inp.places) {
    if (!p.reachable || p.category !== 'stadium' || seats(p) < 800) continue;
    const s = seats(p);
    const h = hashString(p.id);
    const pro = s >= 5000;
    // professional clubs play at home every other week; lower leagues every week
    if (pro && ((wk + (h & 1)) & 1)) continue;
    const u = unit(seed, h, wk, 1);
    const wd = pro ? pick(u, [[2, 0.1], [4, 0.12], [5, 0.4], [6, 0.38]]) : pick(u, [[5, 0.5], [6, 0.5]]);
    if (wd !== cal.weekday) continue;
    const u2 = unit(seed, h, wk, 2);
    const ko = !pro ? pick(u2, [[14, 0.5], [15, 0.5]]) : wd < 5 ? pick(u2, [[19, 0.4], [20.75, 0.6]]) : pick(u2, [[13.5, 0.15], [16, 0.3], [19, 0.3], [20.75, 0.25]]);
    const fill = pro ? 0.6 + 0.38 * unit(seed, h, wk, 3) : 0.3 + 0.4 * unit(seed, h, wk, 3);
    const start = at(day, ko);
    const key = `${p.id}@${day}:football`;
    out.push({
      kind: 'football', place: p.id, venue: p.name, at: p.lngLat, title: `Football match at ${p.name}`,
      start, end: start + 115 * 60, people: round50(s * fill), ann: announceAt(seed, key, day, EVENT_TEMPLATES.football.lead),
      ...(pro && unit(seed, h, wk, 4) < 0.08 ? { extra: 30 } : {}),
    });
  }
}

function concerts(inp: ScheduleInput, out: Draft[]) {
  const { seed, day, cal } = inp;
  const w = [0.6, 0.7, 0.9, 1.1, 1.5, 1.6, 0.6];
  const wsum = w.reduce((a, b) => a + b, 0);
  for (const p of inp.places) {
    if (!p.reachable) continue;
    const s = seats(p);
    let rate = 0, people = 0, start = 0, len = 0;
    const h = hashString(p.id);
    if (p.category === 'venue' && s >= 1000) {
      // indoor halls: a few concerts a week, fewer in the summer break
      rate = Math.min(2, Math.max(0.4, s / 2500)) * (cal.season === 'summer' ? 0.6 : 1);
      people = s * (0.7 + 0.3 * unit(seed, h, day, 3));
      start = pick(unit(seed, h, day, 2), [[19.5, 0.3], [20, 0.3], [20.5, 0.2], [21, 0.2]]);
      len = 2.5 + 0.5 * unit(seed, h, day, 4);
    } else if (p.category === 'stadium' && s >= 20000 && cal.season === 'summer' && (cal.weekday === 4 || cal.weekday === 5)) {
      // big summer concerts in stadiums, with standing on the pitch
      rate = 0.25 * (wsum / (w[4] + w[5]));
      people = Math.min(s * 1.2, s * (0.85 + 0.3 * unit(seed, h, day, 3)));
      start = 21;
      len = 3;
    } else continue;
    if (unit(seed, h, day, 1) >= (rate * w[cal.weekday]) / wsum) continue;
    const t0 = at(day, start);
    const key = `${p.id}@${day}:concert`;
    out.push({ kind: 'concert', place: p.id, venue: p.name, at: p.lngLat, title: `Concert at ${p.name}`, start: t0, end: t0 + Math.round(len * 4) * 900, people: round50(people), ann: announceAt(seed, key, day, EVENT_TEMPLATES.concert.lead) });
  }
}

function festivals(inp: ScheduleInput, out: Draft[]) {
  const { seed, day, cal } = inp;
  if (cal.season !== 'spring' && cal.season !== 'summer') return;
  if (cal.weekday < 4) return;
  const wk = weekOf(day, cal.weekday);
  // one festival weekend in about three in summer, fewer in spring, in one of the largest parks
  if (unit(seed, wk, 11) >= (cal.season === 'summer' ? 0.35 : 0.25)) return;
  const parks = bigParks(inp.places).filter((x) => x.areaM2 >= 100000).slice(0, 3);
  if (!parks.length) return;
  const tot = parks.reduce((a, p) => a + p.areaM2, 0);
  let u = unit(seed, wk, 13) * tot, p = parks[0];
  for (const x of parks) {
    u -= x.areaM2;
    if (u < 0) {
      p = x;
      break;
    }
  }
  // Friday to Sunday, noon to late evening (Sunday ends earlier)
  const n = cal.weekday - 3;
  const dayW = [0.8, 1.2, 1][n - 1];
  const people = Math.min(20000, Math.max(2000, p.areaM2 * 0.03)) * (0.6 + 0.4 * unit(seed, wk, 12)) * dayW;
  const key = `${p.id}@${wk}:festival`;
  const firstDay = day - (n - 1);
  out.push({
    kind: 'festival', place: p.id, venue: p.name, at: p.lngLat, title: `Festival in ${p.name}, day ${n} of 3`, series: [n, 3],
    start: at(day, 12), end: at(day, cal.weekday === 6 ? 21 : 23), people: round50(people), ann: announceAt(seed, key, firstDay, EVENT_TEMPLATES.festival.lead),
  });
}

const GATHERING_REASONS = ['a free open-air concert announced at short notice', 'a community celebration called at short notice', 'a charity fun run with a finish-line party'];

function gatherings(inp: ScheduleInput, out: Draft[]) {
  const { seed, day, cal, type } = inp;
  const parks = bigParks(inp.places);
  if (!parks.length) return;
  const main = parks[0];
  const size = (p: CityPlace, k: number) => Math.min(30000, Math.max(3000, p.areaM2 * 0.04)) * (0.6 + 0.4 * unit(seed, hashString(p.id), day, k));
  if (type.holiday) {
    const key = `${main.id}@${day}:holiday`;
    const start = at(day, 18);
    out.push({ kind: 'gathering', place: main.id, venue: main.name, at: main.lngLat, title: `Public holiday celebration in ${main.name}`, start, end: start + 4 * H, people: round50(size(main, 21)), ann: announceAt(seed, key, day, EVENT_TEMPLATES.gathering.lead) });
  }
  // the end-of-year celebration: the last evening of the festive week, past midnight
  if (type.festive && cal.weekday === 6) {
    const key = `${main.id}@${day}:festive`;
    const start = at(day, 21);
    out.push({ kind: 'gathering', place: main.id, venue: main.name, at: main.lngLat, title: `End-of-year celebration in ${main.name}`, start, end: start + 3.5 * H, people: round50(size(main, 22) * 1.3), ann: announceAt(seed, key, day, EVENT_TEMPLATES.gathering.lead) });
  }
  // short notice: about once in 25 days somewhere in the city, announced the day before
  if (unit(seed, day, 23) < 0.04) {
    const p = parks[Math.floor(unit(seed, day, 24) * Math.min(5, parks.length))];
    const start = at(day, pick(unit(seed, day, 25), [[14, 0.3], [16, 0.3], [18, 0.4]]));
    const len = 2 + Math.floor(unit(seed, day, 26) * 3);
    out.push({
      kind: 'gathering', place: p.id, venue: p.name, at: p.lngLat, title: `Gathering in ${p.name}`, reason: GATHERING_REASONS[Math.floor(unit(seed, day, 27) * GATHERING_REASONS.length)],
      start, end: start + len * H, people: round50(Math.min(10000, size(p, 28) * 0.5)), ann: (day - 1) * DAY + 9 * H,
    });
  }
}

const RAIL_REASONS: Record<string, string[]> = {
  metro: ['a signal failure', 'a broken-down train', 'a power fault', 'a passenger taken ill on a train'],
  rail: ['a signal failure', 'a broken-down train', 'a points failure', 'damage to the overhead wires'],
  tram: ['a road accident blocking the track', 'a broken-down tram', 'a power fault'],
};
const MODE_NAME: Record<string, string> = { metro: 'Metro', rail: 'Train', tram: 'Tram' };

function railDisruption(inp: ScheduleInput, out: Draft[]) {
  const { seed, day } = inp;
  const net = inp.transit;
  if (!net || unit(seed, day, 41) >= 1 / 12) return;
  // a stretch of one line: metro, train or tram, weighted by track length
  const cands = net.links.map((l, i) => ({ l, i })).filter(({ l }) => (l.mode === 'metro' || l.mode === 'rail' || l.mode === 'tram') && net.modes[l.mode]?.ok);
  if (!cands.length) return;
  const tot = cands.reduce((a, c) => a + c.l.m, 0);
  let u = unit(seed, day, 42) * tot, first = cands[0];
  for (const c of cands) {
    u -= c.l.m;
    if (u < 0) {
      first = c;
      break;
    }
  }
  const mode = first.l.mode;
  const links = [first.i];
  const stations = new Set([first.l.a, first.l.b]);
  const want = 1 + Math.floor(unit(seed, day, 43) * 3);
  while (links.length < want) {
    const next = cands.find((c) => !links.includes(c.i) && c.l.mode === mode && (stations.has(c.l.a) || stations.has(c.l.b)));
    if (!next) break;
    links.push(next.i);
    stations.add(next.l.a);
    stations.add(next.l.b);
  }
  const ends = [...stations].map((s) => net.stations[s]);
  const a = ends[0], b = ends[ends.length - 1];
  const start = at(day, 7 + Math.floor(unit(seed, day, 44) * 26) / 2);
  const len = 1 + Math.floor(unit(seed, day, 45) * 7) / 2;
  const reasons = RAIL_REASONS[mode] ?? RAIL_REASONS.rail;
  out.push({
    kind: 'rail', place: a.place, venue: a.name, at: [0, 0], title: `${MODE_NAME[mode] ?? 'Rail'} disruption: ${a.name} – ${b.name}`, reason: reasons[Math.floor(unit(seed, day, 46) * reasons.length)],
    start, end: start + len * H, people: 0, ann: start, links: links.sort((x, y) => x - y), mode,
  });
}

const FLIGHT_REASONS = ['storms over the airport', 'an air traffic control restriction', 'a runway closure'];

function flightDisruption(inp: ScheduleInput, out: Draft[]) {
  const { seed, day } = inp;
  const airport = inp.places.filter((p) => p.reachable && p.category === 'airport').sort((a, b) => a.scale.tier - b.scale.tier || (a.id < b.id ? -1 : 1))[0];
  if (!airport || unit(seed, day, 51) >= 1 / 20) return;
  const start = at(day, 10 + Math.floor(unit(seed, day, 52) * 10));
  const len = 2 + Math.floor(unit(seed, day, 53) * 5);
  out.push({
    kind: 'flight', place: airport.id, venue: airport.name, at: airport.lngLat, title: `Flight delays at ${airport.name}`, reason: FLIGHT_REASONS[Math.floor(unit(seed, day, 54) * FLIGHT_REASONS.length)],
    start, end: start + len * H, people: 0, ann: start, share: 0.3 + 0.3 * unit(seed, day, 55),
  });
}

/** Every event starting on a game day, in a fixed order. */
export function eventsForDay(inp: ScheduleInput): Draft[] {
  const out: Draft[] = [];
  football(inp, out);
  concerts(inp, out);
  festivals(inp, out);
  gatherings(inp, out);
  railDisruption(inp, out);
  flightDisruption(inp, out);
  // the city's places are scheduled in id order; then by start
  return out.sort((a, b) => a.start - b.start || (a.place < b.place ? -1 : a.place > b.place ? 1 : 0) || (a.kind < b.kind ? -1 : 1));
}

/** Seed of the event schedule (independent of the weather's). */
export const eventSeed = (worldSeed: number) => mix(worldSeed, 0x6576);

// ───────────────────────────────────────────── wording

/** "Saturday at 19:00" or "today at 19:00" relative to `now`. */
export function whenLabel(ev: GameEvent, now: number, startWeekday: number): string {
  const d = Math.floor(ev.start / DAY), today = Math.floor(now / DAY);
  const hm = `${String(Math.floor((ev.start % DAY) / H)).padStart(2, '0')}:${String(Math.floor((ev.start % H) / 60)).padStart(2, '0')}`;
  const wd = (((startWeekday + d) % 7) + 7) % 7;
  const rel = d === today ? 'today' : d === today + 1 ? 'tomorrow' : `${WEEKDAY[wd]}, day ${d + 1}`;
  return `${rel} at ${hm}`;
}

/** The notification for an announcement. */
export function announcement(ev: GameEvent, now: number, startWeekday: number, people: (n: number) => string): { title: string; body: string } {
  const tpl = EVENT_TEMPLATES[ev.kind];
  const when = whenLabel(ev, now, startWeekday);
  const days = Math.floor(ev.start / DAY) - Math.floor(now / DAY);
  const lead = days >= 2 ? ` (in ${days} days)` : '';
  if (ev.kind === 'football')
    return { title: `${ev.title}, ${when}`, body: `Kick-off ${when}${lead}. About ${people(ev.people)} expected. Fans arrive over the three hours before; most leave within half an hour of the final whistle, and roads near the stadium will be busy.` };
  if (ev.kind === 'concert') return { title: `${ev.title}, ${when}`, body: `Starts ${when}${lead}. About ${people(ev.people)} expected; most leave within 45 minutes of the end.` };
  if (ev.kind === 'festival') return { title: `${ev.title}, ${when}`, body: `Open from ${when}${lead}. About ${people(ev.people)} expected over the day; people come and go. Outdoor events are called off in storms.` };
  if (ev.reason) return { title: `${tpl.label} in ${ev.venue}, ${when}`, body: `Called at short notice: ${ev.reason}. About ${people(ev.people)} expected; most leave together at the end.` };
  return { title: `${ev.title}, ${when}`, body: `Starts ${when}${lead}. About ${people(ev.people)} expected; most leave together at the end, and roads nearby will be busy.` };
}
