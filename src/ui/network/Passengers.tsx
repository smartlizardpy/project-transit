import { useEffect, useMemo, useState } from 'react';
import type { Game } from '../../game/engine.ts';
import { useUI, type FlowOverlay } from '../../state/store.ts';
import { fitPoints } from '../camera.ts';
import { Segmented } from '../primitives.tsx';
import { BANDS } from '../../game/analytics/types.ts';
import { odMatrix, estimatedDemand, type OdFlow, type OdQuery, type DemandEstimate } from '../../game/analytics/query.ts';
import type { LngLat } from '../../game/world/graph.ts';
import { FilterBar, SectionHead, approx, coverageText, hoursOf, periodDays, share, todayNo, useNC, fmt } from './common.tsx';
import { SaveReport } from './SaveReport.tsx';

type Mode = 'observed' | 'estimated' | 'unserved';
/** observed journeys: areas or stops; the model's estimate: areas or places */
type Level = 'stop' | 'zone' | 'place';

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
    return { days, includeToday, ...dt, bands: bandsOf(hoursOf(f)), level: level === 'stop' ? 'stop' : 'zone', lines: f.line ? [f.line] : undefined };
  }, [f, level, game]);

  const rev = game.state.analytics.days.length;
  const tick = Math.floor(game.t / 1800);
  const nets = Object.keys(game.state.routes).length + Object.keys(game.state.stops).length;
  const key = JSON.stringify(baseQ);
  // options come from the unfiltered result; the table from the origin/destination filtered one
  const base = useMemo(() => odMatrix(game, baseQ), [game, key, rev, tick, nets]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = !!(origin || dest);
  const res = useMemo(() => (filtered ? odMatrix(game, { ...baseQ, origin: origin || null, destination: dest || null }) : base), [game, base, filtered, origin, dest, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = mode === 'unserved' ? 'unserved' : 'all';
  const estLevel = level === 'place' ? 'place' : 'zone';
  const estAll = useMemo(() => (mode === 'observed' ? null : estimatedDemand(game, { level: estLevel, view })), [game, mode, estLevel, Math.floor(game.t / 3600), nets]); // eslint-disable-line react-hooks/exhaustive-deps
  const est = useMemo(() => (estAll && filtered ? estimatedDemand(game, { level: estLevel, view, origin: origin || null, destination: dest || null }) : estAll), [game, estAll, filtered, origin, dest, estLevel, view]);
  const estRows = est?.flows ?? [];

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
        if (x.o === x.d) continue;
        const a = x.oAt, b = x.dAt;
        if (a && b) out.push({ id: `${x.o}>${x.d}`, from: a, to: b, value: x.trips, kind: 'estimated', label: `${x.oLabel} → ${x.dLabel} · about ${Math.round(x.trips)} trips a day${mode === 'unserved' ? ', none by your network' : ''} (estimate)` });
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
    const from = origin && mode !== 'observed' ? estAll?.flows.find((x) => x.o === origin) : null;
    const o = !origin ? null : mode === 'observed' ? pos(origin) : from?.oAt ?? null;
    const label = mode !== 'observed' ? from?.oLabel ?? '' : level === 'stop' ? game.state.stops[origin]?.name ?? '' : game.geo.zone(origin)?.name ?? '';
    ui.setFlowOverlay({ flows, origin: o ? { at: o, label } : null, selected: cur && flows.some((x) => x.id === cur) ? cur : null });
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
  // stops exist only for observed journeys, places only in the model's estimate
  const pickMode = (m: Mode) => { setMode(m); if (m === 'observed' ? level === 'place' : level === 'stop') reset('zone'); };
  const estOpts = (side: 'o' | 'd') => {
    const by = new Map<string, { id: string; label: string; journeys: number }>();
    for (const x of estAll?.flows ?? []) {
      const id = x[side], o = by.get(id) ?? { id, label: side === 'o' ? x.oLabel : x.dLabel, journeys: 0 };
      o.journeys += x.trips;
      by.set(id, o);
    }
    return [...by.values()].sort((a, b) => b.journeys - a.journeys);
  };

  const opts = (list: { id: string; label: string; journeys: number }[]) => list.slice(0, 40);
  const nObs = base.total.journeys;
  const hasData = nObs > 0 || base.total.abandoned > 0;
  const top = res.flows.slice(0, 40);

  return (
    <>
      <FilterBar game={game} line res={base} />
      <div className="section tight" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="nc-split">
          <Segmented value={mode} onChange={pickMode} options={[{ value: 'observed', label: 'Observed journeys' }, { value: 'estimated', label: 'Estimated demand' }, { value: 'unserved', label: 'Unserved' }]} />
          <span className="grow" />
          <Segmented value={level} onChange={reset} options={mode === 'observed' ? [{ value: 'zone', label: 'Areas' }, { value: 'stop', label: 'Stops' }] : [{ value: 'zone', label: 'Areas' }, { value: 'place', label: 'Places' }]} />
        </div>
        <div className="nc-filters">
          <label>From
            <select className="pn-select" value={origin} onChange={(e) => setOrigin(e.target.value)} style={{ maxWidth: 190 }}>
              <option value="">Anywhere</option>
              {opts(mode === 'observed' ? base.origins : estOpts('o')).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <label>To
            <select className="pn-select" value={dest} onChange={(e) => setDest(e.target.value)} style={{ maxWidth: 190 }}>
              <option value="">Anywhere</option>
              {opts(mode === 'observed' ? base.destinations : estOpts('d')).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
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
        <EstimatedTable game={game} est={est} view={view} level={estLevel} selected={selected} onPick={choose} onMap={new Set(flows.map((x) => x.id))} />
      )}
    </>
  );
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

function EstimatedTable({ game, est, view, level, selected, onPick, onMap }: { game: Game; est: DemandEstimate | null; view: 'all' | 'unserved'; level: 'zone' | 'place'; selected: string | null; onPick: (id: string) => void; onMap: Set<string> }) {
  const rows = est?.flows ?? [];
  const t = est?.total ?? { trips: 0, network: 0, unserved: 0 };
  const n = (v: number) => fmt(game, 'count', approx(v));
  const pct = (v: number, of: number) => share(v, of);
  const noStop = rows.reduce((a, x) => a + x.noStop, 0), noLink = rows.reduce((a, x) => a + x.noLink, 0);
  const what = level === 'zone' ? 'areas' : 'places';
  return (
    <>
      <div className="nc-kpis" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        {view === 'all' ? (
          <>
            <div className="nc-kpi"><b>{n(t.trips)}</b><span>Trips a day, all modes</span></div>
            <div className="nc-kpi"><b>{n(t.network)}</b><span>Expected on your network ({pct(t.network, t.trips)})</span></div>
            <div className="nc-kpi"><b>{n(t.unserved)}</b><span>No link on your network</span></div>
          </>
        ) : (
          <>
            <div className="nc-kpi"><b>{n(t.trips)}</b><span>Trips a day not served</span></div>
            <div className="nc-kpi"><b>{n(noStop)}</b><span>No stop within a walk</span></div>
            <div className="nc-kpi"><b>{n(noLink)}</b><span>No line links the stops</span></div>
          </>
        )}
      </div>
      <div className="section">
        <SectionHead title={view === 'all' ? 'Estimated demand by mode' : 'Unserved demand'} right={<span className="pn-tag nc-tag-est">Estimate</span>} />
        <div className="pn-note" style={{ marginBottom: 8 }}>
          {view === 'all'
            ? `Trips a day by everyone, starting or ending in your areas, and how they travel, from the city model. “Your network” is what the model expects you to carry today. These are not journeys your buses carried; map arcs are dashed.`
            : `Trips your network cannot carry at any hour today: one end has no stop within a walk, or no line links the stops. This is potential only: it brings no passengers and no fares until you serve it.`}{' '}
          Metro, tram and ferry lines are not modelled yet, so trips that would use them count here as walking, car or taxi.
        </div>
        {rows.length === 0 ? <div className="pn-empty">{view === 'all' ? `No estimated trips between these ${what}.` : `Every modelled trip between these ${what} has a link on your network.`}</div> : (
          <div className="nc-scroll">
            <table className="pn-table nc-table">
              <thead><tr><th>From → to</th><th>Trips / day</th><th>{view === 'all' ? 'Your network' : 'Why'}</th><th>Walk</th><th>Bike</th><th>Car</th><th>Taxi</th></tr></thead>
              <tbody>
                {rows.slice(0, 40).map((x) => {
                  const id = `${x.o}>${x.d}`;
                  const inner = x.o === x.d;
                  return (
                    <tr key={id} className={`click ${selected === id ? 'on' : ''}`} onClick={() => onPick(id)} title={inner ? 'Trips within the same area (not drawn on the map)' : onMap.has(id) ? 'Click to highlight on the map' : 'Not drawn on the map (outside the top 24)'}>
                      <td className="name" style={{ maxWidth: 220, whiteSpace: 'normal' }}><b style={{ fontWeight: 700 }}>{x.oLabel}</b><br /><span className="faint">→ {inner ? 'within the area' : x.dLabel}</span></td>
                      <td>about {n(x.trips)}</td>
                      <td>
                        {view === 'unserved'
                          ? <span className="pn-tag warn">{x.noStop >= x.noLink ? 'No stop near' : 'No line links'}</span>
                          : x.served ? <>{x.modes[4] < 0.5 ? '<1' : n(x.modes[4])} <span className="faint">{pct(x.modes[4], x.trips)}</span></> : <span className="pn-tag">No link</span>}
                      </td>
                      {[0, 1, 2, 3].map((m) => <td key={m}>{pct(x.modes[m], x.trips)}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
