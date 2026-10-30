// What a line is used for: summaries of its recorded days for the line inspector (plan section 13).
// Pure functions of the analytics days, so they work (and are tested) without the UI.

import type { Game } from '../engine.ts';
import type { Id } from '../types.ts';
import { DAY } from '../content.ts';
import { TRAVELLERS } from '../activity/params.ts';
import { BANDS, bandOf, type DayRecord, type RouteDay } from './types.ts';
import { odMatrix } from './query.ts';

export const CHARACTER_DAYS = 7;

export interface DirectionCurve {
  /** pattern index */
  pat: number;
  /** where this direction ends (stop name); null for a loop */
  to: string | null;
  /** average boardings per recorded day, by hour */
  hours: number[];
}

export interface Peak { hour: number; band: number; pat: number; to: string | null; riders: number }

export interface DirectionLoad { pat: number; to: string | null; busiest: number | null; average: number | null }

export interface LineCharacter {
  /** finished days in the window that were recorded in full */
  days: number;
  /** boardings by traveller type (index into TRAVELLERS) over the window; null when none recorded */
  riders: number[] | null;
  /** hourly curve per direction; `split` is false when only the all-directions total is known */
  curves: DirectionCurve[];
  split: boolean;
  peaks: Peak[];
  /** fares per recorded day by time band (base currency) */
  revenue: number[];
  directions: DirectionLoad[];
  /** share of trips on time, null when no trips were recorded */
  onTime: number | null;
  trips: number;
}

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

/** Finished, fully recorded days of the last `n`. */
export function recordedDays(game: Game, n = CHARACTER_DAYS): DayRecord[] {
  const today = Math.floor(game.t / DAY);
  return game.state.analytics.days.filter((d) => d.day >= today - n && d.day < today && !d.partial);
}

export function lineCharacter(game: Game, id: Id): LineCharacter {
  const st = game.state;
  const recs = recordedDays(game);
  const rds: RouteDay[] = [];
  for (const r of recs) if (r.routes[id]) rds.push(r.routes[id]);
  const stopName = (s: Id) => st.stops[s]?.name ?? st.analytics.names.s[s] ?? null;
  const out: LineCharacter = { days: recs.length, riders: null, curves: [], split: false, peaks: [], revenue: BANDS.map(() => 0), directions: [], onTime: null, trips: 0 };
  if (!recs.length) return out;

  // who rides
  const k = new Array<number>(TRAVELLERS.length).fill(0);
  let anyK = false;
  for (const rd of rds) {
    if (!rd.k) continue;
    anyK = true;
    for (let i = 0; i < rd.k.length; i++) k[Math.floor(i / BANDS.length)] += rd.k[i];
  }
  if (anyK && sum(k) > 0) out.riders = k;

  // revenue by period (per recorded day, so a quiet day counts as zero)
  for (const rd of rds) rd.rv.forEach((v, h) => { out.revenue[bandOf(h)] += v / recs.length; });

  // reliability
  let d = 0, o = 0;
  for (const rd of rds) { d += sum(rd.d); o += sum(rd.o); }
  out.trips = d;
  out.onTime = d > 0 ? o / d : null;

  // direction loads and curves, merged by pattern index
  const byPat = new Map<number, { to: string | null; hours: number[]; ls: number; ln: number; seg: Map<number, [number, number]> }>();
  const get = (pat: number, stops: Id[]) => {
    let e = byPat.get(pat);
    if (!e) byPat.set(pat, (e = { to: null, hours: new Array<number>(24).fill(0), ls: 0, ln: 0, seg: new Map() }));
    if (stops.length > 1) e.to = stopName(stops[stops.length - 1]);
    return e;
  };
  const isLoop = st.routes[id]?.kind === 'loop';
  let bpDays = 0;
  for (const rd of rds) {
    if (rd.bp) {
      bpDays++;
      for (const [key, hrs] of Object.entries(rd.bp)) {
        const pd = rd.p[key];
        const e = get(Number(key.split('|')[0]), pd?.stops ?? []);
        for (let h = 0; h < 24; h++) e.hours[h] += hrs[h] ?? 0;
      }
    }
    for (const pd of Object.values(rd.p)) {
      const e = get(pd.pat, pd.stops);
      for (let i = 0; i < pd.ln.length; i++) {
        if (!pd.ln[i]) continue;
        e.ls += pd.ls[i];
        e.ln += pd.ln[i];
        const s = e.seg.get(i) ?? [0, 0];
        s[0] += pd.ls[i];
        s[1] += pd.ln[i];
        e.seg.set(i, s);
      }
    }
  }
  const pats = [...byPat.entries()].sort((a, b) => a[0] - b[0]);
  for (const [pat, e] of pats) {
    let busiest: number | null = null;
    for (const [s, n] of e.seg.values()) if (n > 0) busiest = Math.max(busiest ?? 0, s / n);
    out.directions.push({ pat, to: isLoop ? null : e.to, busiest, average: e.ln > 0 ? e.ls / e.ln : null });
  }
  if (bpDays > 0) {
    out.split = true;
    for (const [pat, e] of pats) {
      if (sum(e.hours) <= 0) continue;
      out.curves.push({ pat, to: isLoop ? null : e.to, hours: e.hours.map((x) => x / bpDays) });
    }
  } else {
    const hours = new Array<number>(24).fill(0);
    for (const rd of rds) rd.b.forEach((v, h) => { hours[h] += v / recs.length; });
    if (sum(hours) > 0) out.curves.push({ pat: 0, to: null, hours });
  }

  // peaks: the busiest hour of each direction in each peak band, when it stands out
  for (const c of out.curves) {
    const top = Math.max(...c.hours);
    for (const b of [1, 3]) {
      let bh = -1, bv = 0;
      for (let h = BANDS[b].from; h < BANDS[b].to; h++) if (c.hours[h] > bv) { bv = c.hours[h]; bh = h; }
      if (bh >= 0 && bv >= 0.5 && bv >= 0.45 * top) out.peaks.push({ hour: bh, band: b, pat: c.pat, to: c.to, riders: bv });
    }
  }
  out.peaks.sort((a, b) => b.riders - a.riders);
  return out;
}

export interface LineWhere {
  destinations: { label: string; share: number }[];
  origins: { label: string; share: number }[];
  journeys: number;
}

/** Where journeys on this line start and finish (areas), over the last seven days. */
export function lineWhere(game: Game, id: Id, top = 4): LineWhere {
  const r = odMatrix(game, { level: 'zone', lines: [id], days: { last: CHARACTER_DAYS }, includeToday: false });
  const j = r.total.journeys;
  const pick = (a: { label: string; journeys: number }[], n: number) =>
    [...a].sort((x, y) => y.journeys - x.journeys).slice(0, n).filter((x) => x.journeys > 0).map((x) => ({ label: x.label, share: j ? x.journeys / j : 0 }));
  return { destinations: pick(r.destinations, top), origins: pick(r.origins, 3), journeys: j };
}
