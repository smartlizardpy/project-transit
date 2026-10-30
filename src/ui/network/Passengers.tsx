import { useEffect, useMemo, useState } from 'react';
import type { Game } from '../../game/engine.ts';
import { useUI, type FlowOverlay } from '../../state/store.ts';
import { fitPoints } from '../camera.ts';
import { Segmented } from '../primitives.tsx';
import { BANDS } from '../../game/analytics/types.ts';
import { odMatrix, estimatedDemand, type OdFlow, type OdQuery, type DemandFlow } from '../../game/analytics/query.ts';
import type { LngLat } from '../../game/world/graph.ts';
import { FilterBar, SectionHead, coverageText, hoursOf, periodDays, todayNo, useNC, fmt } from './common.tsx';
import { SaveReport } from './SaveReport.tsx';

type Mode = 'observed' | 'estimated';
type Level = 'stop' | 'zone';

function bandsOf(h: [number, number] | null): number[] {
  if (!h) return [];
  return BANDS.map((b, i) => ({ b, i })).filter(({ b }) => (h[0] <= h[1] ? b.from < h[1] && b.to > h[0] : b.from < h[1] || b.to > h[0])).map(({ i }) => i);
}

export function Passengers({ game }: { game: Game }) {
  const f = useNC((s) => s.f);
  const [mode, setMode] = useState<Mode>('observed');
  const init = useMemo(() => useNC.getState().odInit, []);
  const [level, setLevel] = useState<Level>(init?.level ?? 'zone');
  const [origin, setOrigin] = useState(init?.origin ?? '');
  const [dest, setDest] = useState(init?.destination ?? '');
  useEffect(() => { if (init) useNC.getState().setOdInit(null); }, [init]);
  const [showMap, setShowMap] = useState(true);
  const selected = useUI((s) => s.flowOverlay?.selected ?? null);

  const baseQ: OdQuery = useMemo(() => {
    const { days, includeToday } = periodDays(f, todayNo(game));
    const dt = f.dayType.startsWith('wd') ? { dayType: 'all' as const, weekday: Number(f.dayType.slice(2)) } : { dayType: f.dayType as 'all' | 'weekday' | 'weekend', weekday: null };
    return { days, includeToday, ...dt, bands: bandsOf(hoursOf(f)), level, lines: f.line ? [f.line] : undefined };
  }, [f, level, game]);

  const rev = game.state.analytics.days.length;
  const tick = Math.floor(game.t / 1800);
  const nets = Object.keys(game.state.routes).length + Object.keys(game.state.stops).length;
  const key = JSON.stringify(baseQ);
  // options come from the unfiltered result; the table from the origin/destination filtered one
  const base = useMemo(() => odMatrix(game, baseQ), [game, key, rev, tick, nets]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = !!(origin || dest);
  const res = useMemo(() => (filtered ? odMatrix(game, { ...baseQ, origin: origin || null, destination: dest || null }) : base), [game, base, filtered, origin, dest, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const est = useMemo(() => (mode === 'estimated' ? estimatedDemand(game, { level, origin: origin || null, limit: 200 }) : []), [game, mode, level, origin, Math.floor(game.t / 3600), nets]); // eslint-disable-line react-hooks/exhaustive-deps
  const estRows = dest ? est.filter((x) => x.d === dest) : est;

  // an area's flows start and end in the middle of the company's stops there (an area's own
  // centre can fall in water or far from any stop)
  const pos = (id: string): LngLat | null => {
    if (level === 'stop') return game.state.stops[id]?.lngLat ?? null;
    let x = 0, y = 0, n = 0;
    for (const s of Object.values(game.state.stops)) {
      if (s.zone !== id) continue;
      x += s.lngLat[0];
      y += s.lngLat[1];
      n++;
    }
    return n ? [x / n, y / n] : game.geo.zone(id)?.centroid ?? null;
  };
  const flows = useMemo(() => {
    const out: FlowOverlay['flows'] = [];
    if (mode === 'observed') {
      for (const x of res.flows) {
        if (x.o === x.d) continue;
        const a = pos(x.o), b = pos(x.d);
        if (a && b) out.push({ id: x.key, from: a, to: b, value: x.journeys, kind: 'observed', label: `${x.oLabel} → ${x.dLabel} · ${x.journeys} journeys` });
        if (out.length >= 24) break;
      }
    } else {
      for (const x of estRows) {
        const a = pos(x.o), b = pos(x.d);
        if (a && b) out.push({ id: `${x.o}>${x.d}`, from: a, to: b, value: x.trips, kind: 'estimated', label: `${x.oLabel} → ${x.dLabel} · about ${Math.round(x.trips)} trips a day (estimate)` });
        if (out.length >= 24) break;
      }
    }
    return out;
  }, [mode, res, estRows]); // eslint-disable-line react-hooks/exhaustive-deps
  const flowKey = flows.map((x) => `${x.id}:${Math.round(x.value)}`).join('|') + origin;

  useEffect(() => {
    const ui = useUI.getState();
    if (!showMap || !flows.length) return ui.setFlowOverlay(null);
    const cur = ui.flowOverlay?.selected;
    const o = origin ? pos(origin) : null;
    ui.setFlowOverlay({ flows, origin: o ? { at: o, label: level === 'stop' ? game.state.stops[origin]?.name ?? '' : game.geo.zone(origin)?.name ?? '' } : null, selected: cur && flows.some((x) => x.id === cur) ? cur : null });
  }, [flowKey, showMap]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => useUI.getState().setFlowOverlay(null), []);

  const choose = (id: string) => {
    const ui = useUI.getState();
    const cur = ui.flowOverlay;
    const flow = flows.find((x) => x.id === id);
    if (cur) ui.setFlowOverlay({ ...cur, selected: cur.selected === id ? null : id });
    if (flow && cur?.selected !== id) fitPoints([flow.from, flow.to]);
  };
  const reset = (l: Level) => { setLevel(l); setOrigin(''); setDest(''); useUI.getState().setFlowOverlay(null); };

  const opts = (list: { id: string; label: string; journeys: number }[]) => list.slice(0, 40);
  const nObs = base.total.journeys;
  const hasData = nObs > 0 || base.total.abandoned > 0;
  const top = res.flows.slice(0, 40);

  return (
    <>
      <FilterBar game={game} line res={base} />
      <div className="section tight" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="nc-split">
          <Segmented value={mode} onChange={setMode} options={[{ value: 'observed', label: 'Observed journeys' }, { value: 'estimated', label: 'Estimated demand' }]} />
          <span className="grow" />
          <Segmented value={level} onChange={reset} options={[{ value: 'zone', label: 'Areas' }, { value: 'stop', label: 'Stops' }]} />
        </div>
        <div className="nc-filters">
          <label>From
            <select className="pn-select" value={origin} onChange={(e) => setOrigin(e.target.value)} style={{ maxWidth: 190 }}>
              <option value="">Anywhere</option>
              {mode === 'observed' ? opts(base.origins).map((o) => <option key={o.id} value={o.id}>{o.label}</option>) : opts(originsOf(game, level)).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <label>To
            <select className="pn-select" value={dest} onChange={(e) => setDest(e.target.value)} style={{ maxWidth: 190 }}>
              <option value="">Anywhere</option>
              {mode === 'observed' ? opts(base.destinations).map((o) => <option key={o.id} value={o.id}>{o.label}</option>) : opts(originsOf(game, level)).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <span className="grow" style={{ flex: 1 }} />
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6, textTransform: 'none', letterSpacing: 0, fontSize: 12.5, color: 'var(--text-2)' }}>
            <input type="checkbox" checked={showMap} onChange={(e) => setShowMap(e.target.checked)} /> Show on map
          </label>
        </div>
        {showMap && <div className="nc-split"><span className="nc-key"><i /> Observed journeys</span><span className="nc-key"><i className="est" /> Estimated demand (model)</span><span className="nc-hint">Arc width follows volume. Top 24 only.</span></div>}
      </div>

      {mode === 'observed' ? (
        <>
          <div className="nc-kpis" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
            <div className="nc-kpi"><b>{fmt(game, 'count', res.total.journeys)}</b><span>Journeys completed</span></div>
            <div className="nc-kpi"><b>{fmt(game, 'count', res.total.abandoned)}</b><span>Gave up</span></div>
            <div className="nc-kpi"><b>{res.total.pairs}</b><span>{level === 'zone' ? 'Area pairs' : 'Stop pairs'}</span></div>
          </div>
          {!hasData ? (
            <div className="pn-empty">No journeys are recorded for this selection yet. Try a longer period or clear the filters.</div>
          ) : (
            <>
              <div className="section">
                <SectionHead title="Busiest flows" right={<span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>top {top.length} of {res.total.pairs}</span>} />
                <div className="nc-scroll">
                  <table className="pn-table nc-table">
                    <thead><tr><th>From → to</th><th>Journeys</th><th>Gave up</th><th title="Average minutes of completed journeys, stop to stop">Journey</th><th title="Average minutes waited before the first bus">Wait</th><th title="Journeys that changed bus">Changes</th><th style={{ textAlign: 'left' }}>Main route</th></tr></thead>
                    <tbody>
                      {top.map((x) => <ObsRow key={x.key} x={x} on={selected === x.key} onPick={() => choose(x.key)} map={flows.some((y) => y.id === x.key)} />)}
                    </tbody>
                  </table>
                </div>
                {top.some((x) => !flows.some((y) => y.id === x.key)) && <div className="nc-hint" style={{ marginTop: 6 }}>Only the 24 busiest flows are drawn on the map.</div>}
              </div>
              <Matrix res={res} level={level} />
            </>
          )}
          {res.notes.length > 0 && <div className="pn-note">{res.notes.join(' ')}</div>}
          <div className="nc-cov">{coverageText(res.coverage)}{res.coverage.summary.length ? ' · journey detail is kept for 35 days' : ''}</div>
          <div className="nc-split"><SaveReport game={game} kind="od" od={{ ...baseQ, origin: origin || null, destination: dest || null }} columns={[]} suggest={`Journeys by ${level === 'zone' ? 'area' : 'stop'}`} /></div>
        </>
      ) : (
        <EstimatedTable game={game} ready={game.demand.pairs.length > 0} rows={estRows} level={level} selected={selected} onPick={choose} onMap={new Set(flows.map((x) => x.id))} />
      )}
    </>
  );
}

function originsOf(game: Game, level: Level) {
  const seen = new Map<string, string>();
  for (const s of Object.values(game.state.stops)) {
    const id = level === 'zone' ? s.zone : s.id;
    if (!seen.has(id)) seen.set(id, level === 'zone' ? game.geo.zone(id)?.name ?? id : s.name);
  }
  return [...seen].map(([id, label]) => ({ id, label, journeys: 0 })).sort((a, b) => a.label.localeCompare(b.label));
}

function ObsRow({ x, on, onPick, map }: { x: OdFlow; on: boolean; onPick: () => void; map: boolean }) {
  return (
    <tr className={`click ${on ? 'on' : ''}`} onClick={onPick} title={map ? 'Click to highlight on the map' : 'Not drawn on the map (outside the top 24)'}>
      <td className="name" style={{ maxWidth: 170, whiteSpace: 'normal' }}><b style={{ fontWeight: 700 }}>{x.oLabel}</b><br /><span className="faint">→ {x.dLabel}</span></td>
      <td>{x.journeys}</td>
      <td className={x.abandoned ? 'nc-up-bad' : ''}>{x.abandoned || '—'}</td>
      <td>{x.journeyMin === null ? '—' : `${x.journeyMin.toFixed(0)} min`}</td>
      <td>{x.waitMin === null ? '—' : `${x.waitMin.toFixed(1)} min`}</td>
      <td>{x.journeys ? `${Math.round((x.transfers / x.journeys) * 100)}%` : '—'}</td>
      <td className="wrap" style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={x.itineraries.map((i) => `${i.label} (${i.journeys})`).join('\n')}>{x.itineraries[0]?.label ?? '—'}</td>
    </tr>
  );
}

function Matrix({ res, level }: { res: ReturnType<typeof odMatrix>; level: Level }) {
  const os = res.origins.slice(0, 6), ds = res.destinations.slice(0, 6);
  const cell = new Map(res.flows.map((x) => [x.key, x.journeys]));
  const max = Math.max(1, ...os.flatMap((o) => ds.map((d) => cell.get(`${o.id}>${d.id}`) ?? 0)));
  if (os.length < 2 && ds.length < 2) return null;
  return (
    <div className="section">
      <SectionHead title={`Busiest ${level === 'zone' ? 'areas' : 'stops'}`} right={<span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>journeys, from (rows) to (columns)</span>} />
      <table className="nc-matrix">
        <thead><tr><th style={{ width: 120 }} />{ds.map((d) => <th key={d.id} title={d.label}>{d.label}</th>)}</tr></thead>
        <tbody>
          {os.map((o) => (
            <tr key={o.id}>
              <th className="row" title={o.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</th>
              {ds.map((d) => {
                const v = cell.get(`${o.id}>${d.id}`) ?? 0;
                return <td key={d.id} className={v ? 'v' : ''} style={{ ['--a' as string]: Math.max(0.12, v / max) * 0.75 }} title={`${o.label} → ${d.label}: ${v} journeys`}><span>{v || ''}</span></td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EstimatedTable({ ready, rows, level, selected, onPick, onMap }: { game: Game; ready: boolean; rows: DemandFlow[]; level: Level; selected: string | null; onPick: (id: string) => void; onMap: Set<string> }) {
  return (
    <div className="section">
      <SectionHead title="Estimated demand" right={<span className="pn-tag nc-tag-est">Estimate</span>} />
      <div className="pn-note" style={{ marginBottom: 8 }}>
        A model estimate of trips per day by all modes between {level === 'zone' ? 'areas' : 'stops'} you serve, from homes, jobs and distance. These are not journeys your buses carried; map arcs are dashed.
      </div>
      {rows.length === 0 ? <div className="pn-empty">{ready ? `No estimated demand between served ${level === 'zone' ? 'areas' : 'stops'} yet.` : 'The demand estimate is being prepared. It appears after the game has run for a minute.'}</div> : (
        <div className="nc-scroll">
          <table className="pn-table nc-table">
            <thead><tr><th>From → to</th><th>Est. trips / day</th><th>Bus link</th></tr></thead>
            <tbody>
              {rows.slice(0, 40).map((x) => {
                const id = `${x.o}>${x.d}`;
                return (
                  <tr key={id} className={`click ${selected === id ? 'on' : ''}`} onClick={() => onPick(id)} title={onMap.has(id) ? 'Click to highlight on the map' : 'Not drawn on the map (outside the top 24)'}>
                    <td className="name" style={{ maxWidth: 260, whiteSpace: 'normal' }}><b style={{ fontWeight: 700 }}>{x.oLabel}</b><br /><span className="faint">→ {x.dLabel}</span></td>
                    <td>about {Math.round(x.trips)}</td>
                    <td><span className={`pn-tag ${x.served ? 'good' : ''}`}>{x.served ? 'Served' : 'No direct link'}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
