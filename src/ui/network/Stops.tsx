import { useMemo } from 'react';
import type { Game } from '../../game/engine.ts';
import { useUI } from '../../state/store.ts';
import { focusStop } from '../camera.ts';
import { LineBadge } from '../primitives.tsx';
import { FilterBar, Notes, SectionHead, columns, coverageText, stopName, toQuery, useAgg, useNC, Pt } from './common.tsx';
import { DataTable } from './table.tsx';

const COLS = ['boardings', 'alightings', 'abandoned', 'avgWait', 'maxWait', 'transfers', 'leftBehind', 'revenue'];

export function Stops({ game }: { game: Game }) {
  const f = useNC((s) => s.f);
  const extra = useNC((s) => s.extra);
  const sel = useNC((s) => s.stop);
  const setStop = useNC((s) => s.setStop);
  const q = toQuery(f, game, 'stop');
  const res = useAgg(game, q);
  const rows = (res?.rows ?? []).filter((r) => r.id && (game.state.stops[r.id] || (r.values.boardings ?? 0) > 0));
  const cols = columns(game, COLS, extra);
  const pick = (id: string) => {
    setStop(id);
    useUI.getState().select({ kind: 'stop', id });
    focusStop(id);
  };
  const lines = (id: string) => Object.values(game.state.routes).filter((r) => r.stops.includes(id) || r.returnStops?.includes(id));
  return (
    <>
      <FilterBar game={game} line res={res} />
      <div className="section">
        <DataTable game={game} res={res} rows={rows} cols={cols} head="Stop" initial="boardings" selected={sel} onPick={(r) => r.id && pick(r.id)}
          name={(r) => (
            <span className="nc-name">
              <span>{r.label}</span>
              {r.id && lines(r.id).slice(0, 3).map((l) => <LineBadge key={l.id} colour={l.colour} size="sm">{l.number}</LineBadge>)}
            </span>
          )} />
        {rows.length === 0 && <div className="pn-note">No passengers recorded at stops in this selection.</div>}
      </div>
      <Notes res={res} />
      {sel && <StopProfile game={game} id={sel} />}
    </>
  );
}

function StopProfile({ game, id }: { game: Game; id: string }) {
  const f = useNC((s) => s.f);
  const q = { ...toQuery(f, game, 'hour', { stops: [id] }), hours: null };
  const res = useAgg(game, q);
  const data = useMemo(() => {
    const b = new Array<number>(24).fill(0), a = new Array<number>(24).fill(0), w = new Array<number>(24).fill(0);
    for (const r of res?.rows ?? []) {
      const h = Number(r.id);
      b[h] = r.values.boardings ?? 0;
      a[h] = r.values.alightings ?? 0;
    }
    // waiting samples (end of each hour), averaged over the recorded days in the selection
    const days = new Set(res?.coverage.detailed ?? []);
    const recs = game.state.analytics.days.filter((d) => days.has(d.day));
    if (res?.coverage.today) recs.push(game.state.analytics.today);
    let n = 0;
    for (const d of recs) {
      const s = d.stops[id];
      if (!s) continue;
      n++;
      for (let h = 0; h < 24; h++) w[h] += s.w[h] ?? 0;
    }
    if (n) for (let h = 0; h < 24; h++) w[h] /= n;
    return { b, a, w, n };
  }, [res, game, id]);
  const name = stopName(game, id);
  const days = Math.max(1, (res?.coverage.detailed.length ?? 0) + (res?.coverage.today ? 1 : 0));
  return (
    <div className="section">
      <SectionHead title={name} right={
        <span className="pn-legend"><span><i style={{ background: 'var(--accent)' }} />boarding</span><span><i style={{ background: 'var(--mint)' }} />alighting</span><span><i style={{ background: 'var(--amber)' }} />waiting</span></span>
      } />
      <HourChart b={data.b.map((x) => x / days)} a={data.a.map((x) => x / days)} w={data.w} />
      <div className="nc-hint" style={{ marginTop: 6 }}>
        Average per recorded day by hour of the day ({coverageText(res?.coverage)}). The amber line is the number of people waiting at the end of each hour. The time-of-day filter does not apply to this chart.
      </div>
    </div>
  );
}

function HourChart({ b, a, w }: { b: number[]; a: number[]; w: number[] }) {
  const W = 572, H = 140, L = 34, T = 8, B = 20, R = 6;
  const max = Math.max(1, ...b, ...a, ...w);
  const top = Math.ceil(max / 5) * 5 || 1;
  const y = (v: number) => T + ((top - v) / top) * (H - T - B);
  const bw = (W - L - R) / 24;
  const wp: Pt[] = w.map((v, h) => ({ x: h, label: `${h}:00`, v }));
  const path = wp.map((p, i) => `${i ? 'L' : 'M'}${(L + p.x * bw + bw / 2).toFixed(1)} ${y(p.v!).toFixed(1)}`).join('');
  return (
    <svg className="pn-chart nc-chart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Hourly profile of the stop">
      {[top, top / 2, 0].map((v, i) => <g key={i}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.08)" /><text x={L - 5} y={y(v) + 3} textAnchor="end">{v % 1 ? v.toFixed(1) : v}</text></g>)}
      {b.map((v, h) => (
        <g key={h}>
          <rect x={L + h * bw + bw * 0.1} width={bw * 0.38} y={y(v)} height={Math.max(0, y(0) - y(v))} rx={1.5} fill="var(--accent)"><title>{`${h}:00 · boardings ${v.toFixed(1)}`}</title></rect>
          <rect x={L + h * bw + bw * 0.5} width={bw * 0.38} y={y(a[h])} height={Math.max(0, y(0) - y(a[h]))} rx={1.5} fill="var(--mint)"><title>{`${h}:00 · alightings ${a[h].toFixed(1)}`}</title></rect>
          {h % 3 === 0 && <text x={L + h * bw + bw / 2} y={H - 6} textAnchor="middle">{String(h).padStart(2, '0')}</text>}
        </g>
      ))}
      <path d={path} fill="none" stroke="var(--amber)" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
