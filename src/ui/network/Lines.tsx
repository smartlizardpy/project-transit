import { useMemo, useState } from 'react';
import type { Game } from '../../game/engine.ts';
import { useUI } from '../../state/store.ts';
import { focusLine } from '../camera.ts';
import { LineBadge, LoadBar } from '../primitives.tsx';
import { BANDS } from '../../game/analytics/types.ts';
import { MEASURE, weekdayName, type Coverage } from '../../game/analytics/query.ts';
import {
  FilterBar, LineChart, Notes, SectionHead, SrcMark, Val, change, columns, lineLabel, stopName, toQuery, useAgg, useNC, type Filters, type Pt,
} from './common.tsx';
import { DataTable } from './table.tsx';
import { SaveReport } from './SaveReport.tsx';

const BASE = ['boardings', 'trips', 'onTime', 'missed', 'avgLoad', 'avgDelay', 'revenue', 'profit'];
const MORE = ['occupancy', 'cost', 'revenuePerBusHour', 'satisfaction', 'leftBehind', 'avgWait'];

export function Lines({ game }: { game: Game }) {
  const f = useNC((s) => s.f);
  const extra = useNC((s) => s.extra);
  const sel = useNC((s) => s.line);
  const setLine = useNC((s) => s.setLine);
  const [more, setMore] = useState(false);
  const q = toQuery({ ...f, line: '' }, game, 'line');
  const res = useAgg(game, q);
  const rows = (res?.rows ?? []).filter((r) => r.id && game.state.routes[r.id]);
  const ids = more ? [...BASE, ...MORE] : BASE;
  const cols = columns(game, ids, extra);
  const pick = (id: string) => {
    setLine(id);
    useUI.getState().select({ kind: 'line', id });
    focusLine(id);
  };
  return (
    <>
      <FilterBar game={game} res={res} />
      <div className="section">
        <DataTable game={game} res={res} rows={rows} cols={cols} head="Line" initial="boardings" selected={sel} onPick={(r) => r.id && pick(r.id)}
          name={(r) => <span className="nc-name"><LineBadge colour={game.state.routes[r.id!].colour} size="sm">{game.state.routes[r.id!].number}</LineBadge><span>{game.state.routes[r.id!].name}</span></span>} />
        {rows.length === 0 && <div className="pn-note">No lines yet, or none ran in this selection.</div>}
        <div className="nc-split" style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={() => setMore(!more)}>{more ? 'Fewer columns' : 'More columns'}</button>
          <span className="grow" />
          <SaveReport game={game} kind="table" query={q} columns={cols.map((c) => c.id)} suggest="Lines table" />
        </div>
      </div>
      <Notes res={res} />
      {sel && game.state.routes[sel] ? <LineDetail game={game} id={sel} cov={res?.coverage} /> : <div className="pn-note" style={{ padding: '0 4px' }}>Select a line to see its hours, segments and run times.</div>}
      <Compare game={game} line={sel && game.state.routes[sel] ? sel : null} />
    </>
  );
}

// ───────────────────────────────────────── one line

const HOURLY = ['boardings', 'trips', 'avgLoad', 'onTime', 'revenue'];

function LineDetail({ game, id, cov }: { game: Game; id: string; cov?: Coverage }) {
  const f = useNC((s) => s.f);
  const [m, setM] = useState('boardings');
  const r = game.state.routes[id];
  const hq = { ...toQuery({ ...f, line: id }, game, 'hour'), hours: null };
  const hres = useAgg(game, hq);
  const def = MEASURE[m];
  const pts: Pt[] = useMemo(() => Array.from({ length: 24 }, (_, h) => ({ x: h, label: `${String(h).padStart(2, '0')}:00`, v: hres?.rows.find((x) => x.id === String(h))?.values[m] ?? null })), [hres, m]);
  const seg = useMemo(() => segmentStats(game, id, cov), [game, id, cov, game.state.analytics.days.length]);
  return (
    <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SectionHead title={r.name && r.name !== r.number ? `${lineLabel(game, id)} · ${r.name}` : lineLabel(game, id)} right={
        <select className="pn-select" value={m} onChange={(e) => setM(e.target.value)} aria-label="Measure by hour">
          {HOURLY.map((x) => <option key={x} value={x}>{MEASURE[x].label} by hour</option>)}
        </select>
      } />
      <div>
        <LineChart points={pts} unit={def.unit} game={game} labelEvery={3} />
        <div className="nc-hint">By hour of the day, for the days selected above. The time-of-day filter does not apply.</div>
      </div>
      {seg.length === 0 ? (
        <div className="pn-note">No segment detail yet: it is recorded for each trip, so it appears once this line has run on a full recorded day in the selected period.</div>
      ) : seg.map((s) => (
        <div key={s.pat}>
          <div className="nc-sub" style={{ fontSize: 13, marginBottom: 6 }}>{seg.length > 1 ? (s.pat === 0 ? 'Outbound' : 'Return') : 'Route'} · load and run time by segment</div>
          <div className="nc-scroll">
            <table className="pn-table nc-table nc-seg">
              <thead><tr><th>Segment</th><th title="Average share of seats and standing places taken when leaving the first stop of the segment.">Load</th><th title="Measured average run time between the two stops.">Run</th><th title="Run time the timetable assumes for the same trips.">Planned</th><th>Diff</th></tr></thead>
              <tbody>
                {s.stops.slice(0, -1).map((from, i) => {
                  const run = s.run[i], plan = s.plan[i], load = s.load[i];
                  const d = run !== null && plan !== null ? run - plan : null;
                  return (
                    <tr key={i}>
                      <td className="name" style={{ maxWidth: 210 }} title={`${stopName(game, from)} to ${stopName(game, s.stops[i + 1])}`}>{stopName(game, from)} <span className="faint">→</span> {stopName(game, s.stops[i + 1])}</td>
                      <td>{load === null ? '—' : <div className="nc-load"><LoadBar value={load} colour={r.colour} /><span style={{ minWidth: 30 }}>{Math.round(load * 100)}%</span></div>}</td>
                      <td>{run === null ? '—' : mmss(run)}</td>
                      <td>{plan === null ? '—' : mmss(plan)}</td>
                      <td style={{ color: d === null ? undefined : d > 30 ? 'var(--coral)' : d > 10 ? 'var(--amber)' : 'var(--text-2)' }}>{d === null ? '—' : `${d >= 0 ? '+' : '−'}${mmss(Math.abs(d))}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="nc-hint" style={{ marginTop: 4 }}>{s.n} runs recorded. Segments with no runs show a dash.</div>
        </div>
      ))}
    </div>
  );
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

interface SegStat { pat: number; stops: string[]; load: (number | null)[]; run: (number | null)[]; plan: (number | null)[]; n: number }

/** Segment loads and run times for one line, averaged over the recorded days in the selection. */
export function segmentStats(game: Game, id: string, cov?: Coverage): SegStat[] {
  const a = game.state.analytics;
  const want = new Set(cov?.detailed ?? []);
  const recs = a.days.filter((d) => want.has(d.day));
  if (cov?.today) recs.push(a.today);
  const groups = new Map<string, { pat: number; stops: string[]; ls: number[]; ln: number[]; rs: number[]; rn: number[]; ss: number[]; tot: number }>();
  for (const rec of recs) {
    const rd = rec.routes[id];
    if (!rd) continue;
    for (const pd of Object.values(rd.p)) {
      const key = `${pd.pat}:${pd.stops.join(',')}`;
      let g = groups.get(key);
      const n = Math.max(0, pd.stops.length - 1);
      if (!g) groups.set(key, (g = { pat: pd.pat, stops: pd.stops, ls: new Array(n).fill(0), ln: new Array(n).fill(0), rs: new Array(n).fill(0), rn: new Array(n).fill(0), ss: new Array(n).fill(0), tot: 0 }));
      for (let i = 0; i < n; i++) {
        g.ls[i] += pd.ls[i] ?? 0; g.ln[i] += pd.ln[i] ?? 0; g.rs[i] += pd.rs[i] ?? 0; g.rn[i] += pd.rn[i] ?? 0; g.ss[i] += pd.ss[i] ?? 0;
        g.tot += pd.rn[i] ?? 0;
      }
    }
  }
  const best = new Map<number, (typeof groups extends Map<string, infer V> ? V : never)>();
  for (const g of groups.values()) if (!best.has(g.pat) || g.tot > best.get(g.pat)!.tot) best.set(g.pat, g);
  return [...best.values()].sort((x, y) => x.pat - y.pat).map((g) => ({
    pat: g.pat,
    stops: g.stops,
    load: g.ln.map((n, i) => (n ? g.ls[i] / n : null)),
    run: g.rn.map((n, i) => (n ? g.rs[i] / n : null)),
    plan: g.rn.map((n, i) => (n ? g.ss[i] / n : null)),
    n: Math.max(0, ...g.rn),
  }));
}

// ───────────────────────────────────────── comparison

const CMP = ['boardings', 'trips', 'onTime', 'missed', 'avgLoad', 'occupancy', 'avgDelay', 'avgWait', 'leftBehind', 'revenue', 'revenuePerBusHour', 'satisfaction'];

function Compare({ game, line }: { game: Game; line: string | null }) {
  const [a, b] = useNC((s) => s.cmp);
  const setCmp = useNC((s) => s.setCmp);
  const setA = (f: Filters) => setCmp(0, f);
  const setB = (f: Filters) => setCmp(1, f);
  const qa = toQuery({ ...a, line: line ?? '' }, game, 'line');
  const qb = toQuery({ ...b, line: line ?? '' }, game, 'line');
  const ra = useAgg(game, qa);
  const rb = useAgg(game, qb);
  const label = (f: Filters) => `${f.dayType === 'all' ? 'All days' : f.dayType === 'weekday' ? 'Weekdays' : f.dayType === 'weekend' ? 'Weekends' : `${weekdayName(Number(f.dayType.slice(2)))}s`}, ${f.time === 'all' ? 'all day' : f.time === 'custom' ? `${f.h0}–${f.h1}h` : BANDS.find((x) => x.id === f.time)!.short}`;
  return (
    <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHead title="Compare two periods" right={<span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>{line ? lineLabel(game, line) : 'Whole network'}</span>} />
      <div className="grid2">
        <PeriodPick title="A" f={a} set={setA} />
        <PeriodPick title="B" f={b} set={setB} />
      </div>
      <table className="pn-table nc-table">
        <thead><tr><th>Measure</th><th>A</th><th>B</th><th>B vs A</th></tr></thead>
        <tbody>
          {CMP.map((id) => {
            const m = MEASURE[id];
            const va = ra?.total.values[id] ?? null, vb = rb?.total.values[id] ?? null;
            const ch = change(vb, va, m.unit, m.better);
            return (
              <tr key={id}>
                <td className="name" title={m.describe}>{m.label}<SrcMark source={m.source} /></td>
                <td><Val game={game} m={m} v={va} note={ra?.notes[0]} /></td>
                <td><Val game={game} m={m} v={vb} note={rb?.notes[0]} /></td>
                <td className={ch?.tone === 'good' ? 'nc-up-good' : ch?.tone === 'bad' ? 'nc-up-bad' : ''}>{ch ? ch.text : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="nc-hint">A: {label(a)} · B: {label(b)}. {ra?.coverage ? `${ra.coverage.detailed.length} and ${rb?.coverage.detailed.length ?? 0} recorded days.` : ''} A dash means the measure cannot be split that way{ra?.notes[0] ? `: ${ra.notes[0]}` : '.'}</div>
      <div className="nc-split"><SaveReport game={game} kind="compare" query={qa} compare={qb} columns={CMP} suggest={`${line ? lineLabel(game, line) : 'Network'}: ${label(a)} vs ${label(b)}`.slice(0, 60)} /></div>
    </div>
  );
}

function PeriodPick({ title, f, set }: { title: string; f: Filters; set: (f: Filters) => void }) {
  return (
    <div className="nc-filters" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <span className="nc-sub" style={{ fontSize: 12 }}>Period {title}</span>
      <select className="pn-select" value={f.period} onChange={(e) => set({ ...f, period: e.target.value as Filters['period'] })}>
        <option value="7">Last 7 days</option>
        <option value="35">Last 35 days</option>
        <option value="yesterday">Yesterday</option>
      </select>
      <select className="pn-select" value={f.dayType} onChange={(e) => set({ ...f, dayType: e.target.value })}>
        <option value="all">All days</option>
        <option value="weekday">Weekdays</option>
        <option value="weekend">Weekend</option>
        {Array.from({ length: 7 }, (_, i) => <option key={i} value={`wd${i}`}>{weekdayName(i)}s</option>)}
      </select>
      <select className="pn-select" value={f.time} onChange={(e) => set({ ...f, time: e.target.value })}>
        <option value="all">All day</option>
        {BANDS.map((x) => <option key={x.id} value={x.id}>{x.label} {x.short}</option>)}
      </select>
    </div>
  );
}

