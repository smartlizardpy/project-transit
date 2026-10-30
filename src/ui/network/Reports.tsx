import { useState } from 'react';
import { Trash, PencilSimple, Check } from '@phosphor-icons/react';
import type { Game } from '../../game/engine.ts';
import { useUI } from '../../state/store.ts';
import { checkExpr } from '../../game/expr.ts';
import { BANDS } from '../../game/analytics/types.ts';
import { MEASURES, METRIC_VARIABLES, metricValue, type CustomMetric, type SavedReport, type Unit, type AnalyticsQuery } from '../../game/analytics/query.ts';
import { Segmented } from '../primitives.tsx';
import { SectionHead, SOURCE_TEXT, filtersFromQuery, fmt, useAgg, useNC } from './common.tsx';

const UNITS: [Unit, string][] = [['count', 'Count'], ['money', 'Money'], ['percent', 'Percent'], ['minutes', 'Minutes'], ['hours', 'Hours'], ['km', 'Kilometres'], ['score', 'Score'], ['ratio', 'Ratio']];
const warn = (t: string) => useUI.getState().notify(t, 'warn');

export function Reports({ game }: { game: Game }) {
  const [part, setPart] = useState<'metrics' | 'reports'>('metrics');
  return (
    <>
      <Segmented value={part} onChange={setPart} options={[{ value: 'metrics', label: 'Custom metrics' }, { value: 'reports', label: `Saved reports (${game.state.control.reports.length})` }]} />
      {part === 'metrics' ? <Metrics game={game} /> : <Saved game={game} />}
    </>
  );
}

// ───────────────────────────────────────── metrics

function Metrics({ game }: { game: Game }) {
  const metrics = game.state.control.metrics;
  const extra = useNC((s) => s.extra);
  const toggle = useNC((s) => s.toggleExtra);
  const [id, setId] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [expr, setExpr] = useState('');
  const [unit, setUnit] = useState<Unit>('money');
  const [dec, setDec] = useState('');
  const [better, setBetter] = useState<'higher' | 'lower' | 'none'>('none');
  const chk = expr.trim() ? checkExpr(expr, METRIC_VARIABLES) : null;
  const week = useAgg(game, { groupBy: 'network', days: { last: 7 }, includeToday: false });
  const draft: CustomMetric = { id: id ?? 'draft', name, expr, unit, decimals: dec === '' ? undefined : Number(dec), better };
  const preview = chk?.ok && week ? metricValue(draft, week.total.values) : null;
  const clear = () => { setId(undefined); setName(''); setExpr(''); setDec(''); setBetter('none'); };
  const save = () => {
    const r = game.saveMetric({ id, name, expr, unit, decimals: dec === '' ? undefined : Math.max(0, Math.min(4, Number(dec))), better });
    if (!r.ok) return warn(r.error);
    useUI.getState().notify(id ? 'Metric updated' : 'Metric saved. Tick "Show in tables" to add it as a column.', 'good');
    clear();
  };
  const edit = (m: CustomMetric) => { setId(m.id); setName(m.name); setExpr(m.expr); setUnit(m.unit); setDec(m.decimals === undefined ? '' : String(m.decimals)); setBetter(m.better ?? 'none'); };
  return (
    <>
      <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SectionHead title={id ? 'Edit metric' : 'New metric'} />
        <label className="nc-field"><span>Name</span><input className="pn-input" value={name} maxLength={40} placeholder="Fares per service hour" onChange={(e) => setName(e.target.value)} /></label>
        <label className="nc-field"><span>Expression</span><input className="pn-input nc-expr" value={expr} maxLength={400} placeholder="revenue / busHours" spellCheck={false} onChange={(e) => setExpr(e.target.value)} /></label>
        {chk && (chk.ok
          ? <div className="nc-ok">Valid. Uses {chk.vars.join(', ') || 'no measures'}.{preview !== null && <> Last 7 days across the network: <b>{fmt(game, unit, preview, draft.decimals)}</b></>}</div>
          : <div className="nc-err">{chk.error}</div>)}
        <div className="nc-filters">
          <label>Unit
            <select className="pn-select" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>{UNITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <label>Decimals
            <input className="pn-input" type="number" min={0} max={4} value={dec} placeholder="auto" onChange={(e) => setDec(e.target.value)} />
          </label>
          <label>Better when
            <select className="pn-select" value={better} onChange={(e) => setBetter(e.target.value as typeof better)}><option value="none">Neither</option><option value="higher">Higher</option><option value="lower">Lower</option></select>
          </label>
          <span style={{ flex: 1 }} />
          {id && <button className="btn sm" onClick={clear}>Cancel</button>}
          <button className="btn sm primary" onClick={save} disabled={!name.trim() || !chk?.ok}>{id ? 'Save changes' : 'Save metric'}</button>
        </div>
        <details>
          <summary className="nc-hint" style={{ cursor: 'pointer' }}>Measures you can use ({MEASURES.length}). Click to add.</summary>
          <div className="nc-chips" style={{ marginTop: 8 }}>
            {MEASURES.map((m) => <button key={m.id} className="nc-chip" title={`${m.label}: ${m.describe} ${SOURCE_TEXT[m.source]}`} onClick={() => setExpr((e) => (e.trim() ? `${e.trimEnd()} ${m.id}` : m.id))}>{m.id}</button>)}
          </div>
          <div className="nc-hint" style={{ marginTop: 6 }}>You can use + − × ÷ (as * and /), brackets, comparisons and functions such as max(a, b). A metric with a dash has no value for that row, for example when it divides by zero.</div>
        </details>
      </div>

      <div className="section">
        <SectionHead title="Your metrics" />
        {metrics.length === 0 ? <div className="pn-note">No metrics yet. Build one above, for example <span className="nc-expr">revenue / busHours</span>. It can then be shown as a column in the Lines and Stops tables.</div> : (
          <div className="nc-list">
            {metrics.map((m) => (
              <div className="nc-item" key={m.id}>
                <div className="grow">
                  <div className="t">{m.name}</div>
                  <div className="s nc-expr">{m.expr}</div>
                </div>
                <label className="nc-hint" style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={extra.includes(m.id)} onChange={() => toggle(m.id)} /> Show in tables
                </label>
                <button className="icon-btn" onClick={() => edit(m)} aria-label="Edit metric" title="Edit"><PencilSimple size={15} weight="bold" /></button>
                <button className="icon-btn" onClick={() => { const r = game.deleteMetric(m.id); if (!r.ok) warn(r.error); else if (extra.includes(m.id)) toggle(m.id); }} aria-label="Delete metric" title="Delete"><Trash size={15} weight="bold" /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ───────────────────────────────────────── saved reports

function Saved({ game }: { game: Game }) {
  const reports = game.state.control.reports;
  const [ren, setRen] = useState<string | null>(null);
  const [text, setText] = useState('');
  const commit = (r: SavedReport) => {
    const x = game.saveReport({ ...r, name: text });
    if (!x.ok) warn(x.error);
    setRen(null);
  };
  const open = (r: SavedReport) => {
    const nc = useNC.getState();
    const ui = useUI.getState();
    const custom = r.columns.filter((c) => game.state.control.metrics.some((m) => m.id === c));
    useNC.setState({ extra: custom });
    if (r.kind === 'od' && r.od) {
      const o = r.od;
      const band = o.bands?.length === 1 ? BANDS[o.bands[0]] : null;
      const q: AnalyticsQuery = { groupBy: 'network', days: o.days, includeToday: o.includeToday, dayType: o.dayType, weekday: o.weekday, hours: band ? [band.from, band.to] : null, lines: o.lines };
      nc.setAll(filtersFromQuery(q, game));
      nc.setOdInit({ level: o.level, origin: o.origin ?? '', destination: o.destination ?? '' });
      ui.setNetworkTab('passengers');
    } else if (r.kind === 'compare' && r.query && r.compare) {
      nc.setCmp(0, filtersFromQuery(r.query, game));
      nc.setCmp(1, filtersFromQuery(r.compare, game));
      const line = r.query.lines?.[0] ?? null;
      nc.setLine(line && game.state.routes[line] ? line : null);
      ui.setNetworkTab('lines');
    } else if (r.query) {
      nc.setAll(filtersFromQuery(r.query, game));
      ui.setNetworkTab(r.query.groupBy === 'stop' ? 'stops' : r.query.groupBy === 'vehicle' ? 'fleet' : r.query.groupBy === 'network' ? 'overview' : 'lines');
    }
  };
  const kind = { table: 'Table', compare: 'Comparison', od: 'Journeys' };
  return (
    <div className="section">
      <SectionHead title="Saved reports" />
      {reports.length === 0 ? (
        <div className="pn-note">Nothing saved yet. Use "Save as report" under the Lines table or comparison, or in Passengers, to keep a view you come back to. A report remembers its filters and columns, and always shows current data.</div>
      ) : (
        <div className="nc-list">
          {reports.map((r) => (
            <div className="nc-item" key={r.id}>
              <div className="grow">
                {ren === r.id
                  ? <input className="pn-input" autoFocus value={text} maxLength={60} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(r); if (e.key === 'Escape') setRen(null); }} />
                  : <div className="t">{r.name}</div>}
                <div className="s">{kind[r.kind]}{r.columns.length ? ` · ${r.columns.length} columns` : ''}</div>
              </div>
              {ren === r.id
                ? <button className="icon-btn" onClick={() => commit(r)} aria-label="Save name"><Check size={15} weight="bold" /></button>
                : <>
                  <button className="btn sm" onClick={() => open(r)}>Open</button>
                  <button className="icon-btn" onClick={() => { setRen(r.id); setText(r.name); }} aria-label="Rename report" title="Rename"><PencilSimple size={15} weight="bold" /></button>
                </>}
              <button className="icon-btn" onClick={() => { const x = game.deleteReport(r.id); if (!x.ok) warn(x.error); }} aria-label="Delete report" title="Delete"><Trash size={15} weight="bold" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
