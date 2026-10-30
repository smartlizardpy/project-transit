import { useMemo, useState } from 'react';
import { CaretRight } from '@phosphor-icons/react';
import type { Game } from '../../game/engine.ts';
import { useUI } from '../../state/store.ts';
import { focusLine, focusStop } from '../camera.ts';
import { MEASURE } from '../../game/analytics/query.ts';
import {
  FilterBar, LineChart, SectionHead, Notes, change, fmt, lineLabel, periodLabel, previousQuery, stopName, toQuery, todayNo, useAgg, useNC, SOURCE_TEXT, SrcMark, type Pt,
} from './common.tsx';

const KPIS = ['boardings', 'journeys', 'abandoned', 'avgWait', 'onTime', 'occupancy', 'revenue', 'cost', 'profit', 'satisfaction'];
const TREND = ['boardings', 'journeys', 'abandoned', 'avgWait', 'onTime', 'occupancy', 'revenue', 'profit', 'satisfaction'];

export function Overview({ game }: { game: Game }) {
  const f = useNC((s) => s.f);
  const [trend, setTrend] = useState('boardings');
  const q = toQuery(f, game, 'network');
  const res = useAgg(game, q);
  const pq = previousQuery(q, f, game);
  const prev = useAgg(game, pq);
  const days = useAgg(game, { groupBy: 'day', days: { last: 35 }, includeToday: false, lines: f.line ? [f.line] : undefined });
  const lines = useAgg(game, toQuery(f, game, 'line'));
  const stops = useAgg(game, toQuery(f, game, 'stop'));
  const today = todayNo(game);

  const points: Pt[] = useMemo(() => (days?.rows ?? []).map((r) => ({ x: Number(r.id), label: `Day ${Number(r.id) + 1}`, v: r.values[trend] ?? null })).sort((a, b) => a.x - b.x), [days, trend]);

  // top problems, from the same period
  const problems = useMemo(() => {
    const out: { key: string; tone: 'bad' | 'warn'; title: string; detail: string; go: () => void }[] = [];
    const sel = (kind: 'line' | 'stop', id: string) => { useUI.getState().select({ kind, id }); if (kind === 'line') focusLine(id); else focusStop(id); };
    const lr = (lines?.rows ?? []).filter((r) => r.id && game.state.routes[r.id]);
    const crowded = [...lr].filter((r) => (r.values.avgLoad ?? 0) > 0).sort((a, b) => (b.values.leftBehind ?? 0) - (a.values.leftBehind ?? 0) || (b.values.avgLoad ?? 0) - (a.values.avgLoad ?? 0))[0];
    if (crowded && ((crowded.values.leftBehind ?? 0) > 0 || (crowded.values.avgLoad ?? 0) >= 60)) {
      out.push({ key: 'crowd', tone: 'warn', title: `${lineLabel(game, crowded.id)} is the most crowded`, detail: `Buses leave stops ${fmt(game, 'percent', crowded.values.avgLoad)} full on average; ${fmt(game, 'count', crowded.values.leftBehind)} passengers were left behind.`, go: () => sel('line', crowded.id!) });
    }
    const missed = [...lr].sort((a, b) => (b.values.missed ?? 0) - (a.values.missed ?? 0))[0];
    if (missed && (missed.values.missed ?? 0) > 0) {
      out.push({ key: 'missed', tone: 'bad', title: `${lineLabel(game, missed.id)} missed the most trips`, detail: `${fmt(game, 'count', missed.values.missed)} missed against ${fmt(game, 'count', missed.values.trips)} run. Check it has enough buses.`, go: () => sel('line', missed.id!) });
    }
    const sr = (stops?.rows ?? []).filter((r) => r.id && game.state.stops[r.id]);
    const wait = [...sr].filter((r) => (r.values.avgWait ?? 0) > 0).sort((a, b) => (b.values.avgWait ?? 0) - (a.values.avgWait ?? 0))[0];
    if (wait && (wait.values.avgWait ?? 0) >= 6) {
      out.push({ key: 'wait', tone: 'warn', title: `Longest waits at ${stopName(game, wait.id!)}`, detail: `${fmt(game, 'minutes', wait.values.avgWait)} on average, up to ${fmt(game, 'minutes', wait.values.maxWait, 0)}.`, go: () => sel('stop', wait.id!) });
    }
    const gave = [...sr].sort((a, b) => (b.values.abandoned ?? 0) - (a.values.abandoned ?? 0))[0];
    if (gave && (gave.values.abandoned ?? 0) > 0) {
      out.push({ key: 'gaveup', tone: 'bad', title: `Most journeys abandoned from ${stopName(game, gave.id!)}`, detail: `${fmt(game, 'count', gave.values.abandoned)} passengers gave up. They waited too long or had no way to continue.`, go: () => sel('stop', gave.id!) });
    }
    return out;
  }, [lines, stops, game]);

  const m = MEASURE[trend];
  return (
    <>
      <FilterBar game={game} line res={res} />
      <div className="nc-kpis">
        {KPIS.map((id) => {
          const def = MEASURE[id];
          const v = res?.total.values[id] ?? null;
          const ch = change(v, prev?.total.values[id] ?? null, def.unit, def.better);
          return (
            <div className="nc-kpi" key={id} title={`${def.describe} ${SOURCE_TEXT[def.source]}`}>
              <b>{v === null ? <span className="nc-null" title={res?.notes[0] ?? 'Not available for this selection.'}>—</span> : fmt(game, def.unit, v)}</b>
              <span>{def.label}<SrcMark source={def.source} /></span>
              <small className={ch?.tone ?? ''}>{ch ? `${ch.text}` : f.period === 'today' ? 'so far' : ' '}</small>
            </div>
          );
        })}
      </div>
      <div className="pn-note" style={{ padding: '0 2px' }}>
        {f.period === 'today' ? 'Today is not finished, so there is no comparison.' : `Changes compare ${periodLabel(f)} with the same number of days before.`}
        {' '}<span style={{ color: 'var(--amber)' }}>●</span> ledger value · <span style={{ color: 'var(--accent)' }}>●</span> derived from records
      </div>
      <Notes res={res} />

      <div className="section">
        <SectionHead title="Daily trend" right={
          <select className="pn-select" value={trend} onChange={(e) => setTrend(e.target.value)} aria-label="Measure">
            {TREND.map((id) => <option key={id} value={id}>{MEASURE[id].label}</option>)}
          </select>
        } />
        <LineChart points={points} unit={m.unit} game={game} today={today + 1000} labelEvery={Math.max(1, Math.ceil(points.length / 9))} />
        <div className="nc-hint" style={{ marginTop: 6 }}>Last 35 days{f.line ? `, ${lineLabel(game, f.line)}` : ''}. Days before recording began are missing.</div>
      </div>

      <div className="section">
        <SectionHead title="Top problems" right={<span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>{periodLabel(f)}</span>} />
        {problems.length === 0 ? (
          <div className="pn-note">Nothing stands out in this period: no crowding, missed trips, long waits or abandoned journeys worth flagging.</div>
        ) : (
          <div className="nc-problems">
            {problems.map((p) => (
              <button key={p.key} className={`nc-problem ${p.tone === 'bad' ? 'bad' : ''}`} onClick={p.go}>
                <div className="grow">{p.title}<small>{p.detail}</small></div>
                <CaretRight size={14} weight="bold" />
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
