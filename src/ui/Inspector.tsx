import { useEffect, useState } from 'react';
import { X, Crosshair, Warehouse, MapPin, Users, Wrench, Path, Plus, Warning, CalendarBlank, PencilSimple, Trash, Pause, Play, CurrencyCircleDollar, ArrowsOutSimple, Lock, LockOpen, Check, Minus } from '@phosphor-icons/react';
import { useUI } from '../state/store.ts';
import { useGameUpdates } from './hooks.ts';
import { LineBadge, LoadBar, Tip, Kpi } from './primitives.tsx';
import { BusArt } from './BusArt.tsx';
import { focusVehicle, focusLine, focusStop, focusDepot } from './camera.ts';
import { ArrivalBoard, VehicleStops } from './ArrivalBoard.tsx';
import { startDrafting } from './routeDraft.ts';
import type { Game } from '../game/engine.ts';
import type { Vehicle } from '../game/types.ts';
import { MODEL, ECON, STOP_RULES } from '../game/content.ts';
import { STATUS_LABEL } from '../game/vehicles.ts';
import { routeWindow, routeMoney, licenceInfo } from '../game/progress.ts';
import { describeTimetable } from '../game/timetable.ts';
import { waitingAt } from '../game/passengers.ts';
import { distanceM, type LngLat } from '../game/world/graph.ts';
import { POI_LABEL } from '../game/world/region.ts';
import { RouteCheck, DiagnosticButton } from './RouteCheck.tsx';
import { lineDiagnostics } from '../game/diagnostics.ts';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

export function Inspector() {
  const selection = useUI((s) => s.selection);
  const draft = useUI((s) => s.draft);
  const routeCheck = useUI((s) => s.routeCheck);
  const [shown, setShown] = useState(selection);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (selection) {
      setShown(selection);
      setClosing(false);
    } else if (shown) {
      setClosing(true);
      const t = setTimeout(() => {
        setShown(null);
        setClosing(false);
      }, 150);
      return () => clearTimeout(t);
    }
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps
  // a route check (interactive diagnostic) replaces the selection content; for the line being
  // drafted there is no selection, so it opens the card on its own
  if (routeCheck && (routeCheck.route === null || (selection?.kind === 'line' && selection.id === routeCheck.route)))
    return (
      <aside className={`card inspector ${draft ? 'with-tray' : ''}`} key={`check-${routeCheck.route ?? 'draft'}`} aria-label="Route check">
        <RouteCheck target={routeCheck} />
      </aside>
    );
  if (!shown) return null;
  const key = `${shown.kind}-${shown.id}`;
  return (
    <aside className={`card inspector ${closing ? 'closing' : ''} ${draft ? 'with-tray' : ''}`} key={key} aria-label="Inspector">
      {shown.kind === 'vehicle' && <VehicleInspector id={shown.id} />}
      {shown.kind === 'line' && <LineInspector id={shown.id} />}
      {shown.kind === 'stop' && <StopInspector id={shown.id} />}
      {shown.kind === 'depot' && <DepotInspector id={shown.id} />}
      {shown.kind === 'zone' && <ZoneInspector id={shown.id} />}
    </aside>
  );
}

function Close() {
  return (
    <button className="close-btn has-tip" onClick={() => useUI.getState().select(null)} aria-label="Close">
      <X size={15} weight="bold" />
      <Tip label="Close" k="Esc" side="left" />
    </button>
  );
}

function Gone({ what }: { what: string }) {
  return (
    <>
      <div className="p-head">
        <div className="grow">
          <div className="p-title">{what}</div>
          <div className="p-sub">No longer exists</div>
        </div>
        <Close />
      </div>
    </>
  );
}

function run(res: { ok: true } | { ok: false; error: string }, good?: string) {
  const ui = useUI.getState();
  if (!res.ok) ui.notify(res.error, 'bad');
  else if (good) ui.notify(good, 'good');
  return res.ok;
}

export function statusPill(v: Vehicle): { text: string; pill: string; cls: string } {
  const late = Math.round(v.delay / 60);
  if (v.status === 'broken') return { text: 'Broken down · waiting for recovery', pill: 'bad', cls: 'delayed' };
  if (v.status === 'maintenance') return { text: STATUS_LABEL[v.status], pill: 'warn', cls: 'depot' };
  if (v.status === 'parked') return { text: v.sell ? 'Parked · being sold' : 'Parked in depot', pill: '', cls: 'depot' };
  if ((v.status === 'in_service' || v.status === 'at_stop') && late >= 3) return { text: `Delayed +${late} min`, pill: 'warn', cls: 'delayed' };
  if (v.status === 'at_stop') return { text: STATUS_LABEL[v.status], pill: 'info', cls: 'boarding' };
  if (v.status === 'in_service') return { text: late <= -2 ? `In service · ${-late} min early` : 'In service · on time', pill: 'good', cls: '' };
  return { text: STATUS_LABEL[v.status], pill: 'info', cls: '' };
}

// ───────────────────────────────────────────── vehicle

/** Home depot, with a move to another depot (asks first, saying what will happen). */
function DepotMove({ game, v }: { game: Game; v: Vehicle }) {
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => setTo(null), [v.id]);
  const depots = Object.values(game.state.depots);
  const depot = game.state.depots[v.depot];
  if (depots.length < 2) {
    return (
      <div className="row faint" style={{ fontSize: 12, minHeight: 22 }}>
        <span><Warehouse size={13} weight="bold" /> {depot?.name ?? 'No depot'}</span>
      </div>
    );
  }
  const plan = to ? game.depotMovePlan(v.id, to) : null;
  return (
    <>
      <div className="row" style={{ gap: 8, marginTop: 6 }}>
        <select
          className="select grow"
          value={to ?? v.depot}
          disabled={!!v.sell}
          onChange={(e) => setTo(e.target.value === v.depot ? null : e.target.value)}
          aria-label="Home depot"
        >
          {depots.map((d) => {
            const used = game.depotUse(d.id);
            const full = d.id !== v.depot && used >= d.capacity;
            return (
              <option key={d.id} value={d.id} disabled={full}>
                {d.id === v.depot ? 'Based at ' : 'Move to '}{d.name} · {used}/{d.capacity} spaces{full ? ' · full' : ''}
              </option>
            );
          })}
        </select>
      </div>
      {plan && (
        <div className="depot-move">
          <div>{plan.ok ? plan.value.text : plan.error}</div>
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            <button
              className="btn primary sm"
              disabled={!plan.ok}
              onClick={() => {
                const name = game.state.depots[to!]?.name ?? 'the depot';
                const r = game.moveToDepot(v.id, to!);
                if (r.ok) {
                  useUI.getState().notify(r.value === 'driving' ? `Bus ${v.fleetNo} is driving to ${name}` : `Bus ${v.fleetNo} is now based at ${name}`, 'good');
                  if (r.value === 'driving') focusVehicle(v.id);
                } else useUI.getState().notify(r.error, 'bad');
                setTo(null);
              }}
            >
              <Check size={14} weight="bold" /> Move bus
            </button>
            <button className="btn sm" onClick={() => setTo(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

function VehicleInspector({ id }: { id: string }) {
  const game = useGameUpdates(5);
  const following = useUI((s) => s.following);
  const [confirmSell, setConfirmSell] = useState(false);
  if (!game) return null;
  const v = game.state.vehicles[id];
  if (!v) return <Gone what="Bus" />;
  const m = MODEL[v.model];
  const line = v.route ? game.state.routes[v.route] : null;
  const st = statusPill(v);
  if (v.status === 'to_depot' && game.state.depots[v.depot]) st.text = `Driving to ${game.state.depots[v.depot].name}`;
  const load = v.load / m.capacity;
  const isFollowing = following === v.id;
  const depot = game.state.depots[v.depot];
  const ageDays = Math.floor((game.t - v.bought) / 86400);
  const quote = game.maintenanceQuote(v);
  const routes = Object.values(game.state.routes);
  const kmh = v.status === 'in_service' || v.status === 'to_route' || v.status === 'to_depot' ? Math.round(v.v * 3.6) : 0;
  return (
    <>
      <div className="p-head">
        {line ? <LineBadge colour={line.colour} size="lg">{line.number}</LineBadge> : <LineBadge colour="#5b6660" size="lg">–</LineBadge>}
        <div className="grow">
          <div className="p-title">Bus {v.fleetNo}</div>
          <div className="p-sub">
            {m.name} · {line ? (line.name || `Line ${line.number}`) : 'Not assigned to a line'}
          </div>
        </div>
        <Close />
      </div>
      <div className="p-body">
        <div className="illus">
          <BusArt model={v.model} line={line?.number} lineColour={line?.colour} livery={game.state.company.colour} width={300} />
        </div>
        <div className="row" style={{ padding: '2px 2px' }}>
          <span className={`pill ${st.pill}`}><span className={`status-dot ${st.cls}`} />{st.text}</span>
          <span className="v num muted">{kmh} km/h</span>
        </div>
        {v.status === 'maintenance' && <div className="issue info"><Wrench size={16} weight="fill" />Back in service around {new Date((v.until % 86400) * 1000).toISOString().slice(11, 16)}.</div>}
        {v.sell && <div className="issue"><CurrencyCircleDollar size={16} weight="fill" />Will be sold when it reaches {depot?.name ?? 'the depot'}.</div>}
        {v.withdraw && <div className="issue info"><Warehouse size={16} weight="fill" />Leaving service after this trip.</div>}
        <div className="section">
          <div className="row" style={{ minHeight: 0, marginBottom: 8 }}>
            <span className="k" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Users size={15} weight="bold" /> Passengers</span>
            <span className="v num">{v.load}<span className="faint"> / {m.capacity}</span></span>
          </div>
          <LoadBar value={load} />
          <div className="row faint" style={{ fontSize: 12, marginTop: 6, minHeight: 0 }}>
            <span>{m.seats} seats · {m.capacity - m.seats} standing</span>
            <span>{pct(load)} full</span>
          </div>
        </div>
        {v.trip !== null && v.pos.kind === 'pattern' && (
          <div className="section">
            <div className="label" style={{ marginBottom: 6 }}>Next stops</div>
            <VehicleStops vehicleId={v.id} />
          </div>
        )}
        <div className="section">
          <div className="label" style={{ marginBottom: 6 }}>Assignment</div>
          <div className="row" style={{ gap: 8 }}>
            <select
              className="select grow"
              value={v.route ?? ''}
              disabled={!!v.sell}
              onChange={(e) => {
                const to = e.target.value || null;
                run(game.assignVehicle(v.id, to), to ? `Bus ${v.fleetNo} assigned to line ${game.state.routes[to].number}` : `Bus ${v.fleetNo} will return to ${depot?.name ?? 'its depot'}`);
              }}
              aria-label="Assign to line"
            >
              <option value="">Not assigned (stay in depot)</option>
              {routes.map((r) => (
                <option key={r.id} value={r.id}>Line {r.number}{r.name ? ` · ${r.name}` : ''}</option>
              ))}
            </select>
          </div>
          <DepotMove game={game} v={v} />
        </div>
        <div className="grid3">
          <Kpi value={pct(v.condition)} label="Condition" tone={v.condition < 0.6 ? 'coral' : v.condition < 0.8 ? 'amber' : undefined} />
          <Kpi value={`${Math.round(v.km).toLocaleString()}`} label="km driven" />
          <Kpi value={`${ageDays} d`} label="In fleet" />
        </div>
        {v.condition < 0.985 && v.status !== 'maintenance' && (
          <div className="row faint" style={{ fontSize: 12, minHeight: 24 }}>
            <span>Full service: {game.money(quote.cost)} · {Math.round(quote.minutes)} min in depot</span>
          </div>
        )}
      </div>
      <div className="p-foot">
        <button className={`btn ${isFollowing ? 'primary' : ''}`} style={{ flex: 1 }} disabled={v.status === 'parked' || v.status === 'maintenance'} onClick={() => { useUI.getState().follow(isFollowing ? null : v.id); if (!isFollowing) focusVehicle(v.id); }}>
          <Crosshair size={16} weight="bold" /> {isFollowing ? 'Following' : 'Follow'} <kbd className="key">F</kbd>
        </button>
        <button className="btn has-tip" disabled={v.status === 'maintenance' || v.condition > 0.985} onClick={() => run(game.serviceVehicle(v.id), v.status === 'parked' ? 'Maintenance started' : 'Will go for maintenance after this trip')} aria-label="Service">
          <Wrench size={16} weight="bold" />
          <Tip label="Send for maintenance" hint={`Restores condition. About ${game.money(quote.cost)}.`} side="below" />
        </button>
        {confirmSell ? (
          <button className="btn danger" onClick={() => { const r = game.sellVehicle(v.id); if (r.ok) useUI.getState().notify(r.value === 'sold' ? `Bus ${v.fleetNo} sold for ${game.money(game.resaleValue(v))}` : `Bus ${v.fleetNo} will be sold at the depot`, 'good'); else useUI.getState().notify(r.error, 'bad'); setConfirmSell(false); if (r.ok && r.value === 'sold') useUI.getState().select(null); }}>
            Sell for {game.money(game.resaleValue(v), { compact: true })}?
          </button>
        ) : v.sell ? (
          <button className="btn" onClick={() => run(game.cancelSale(v.id), 'Sale cancelled')}>Keep bus</button>
        ) : (
          <button className="btn has-tip" onClick={() => setConfirmSell(true)} aria-label="Sell">
            <CurrencyCircleDollar size={16} weight="bold" />
            <Tip label="Sell bus" hint={`Resale value now: ${game.money(game.resaleValue(v))}`} side="below" />
          </button>
        )}
      </div>
    </>
  );
}

// ───────────────────────────────────────────── line

function LineInspector({ id }: { id: string }) {
  const game = useGameUpdates(2);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!game) return null;
  const r = game.state.routes[id];
  if (!r) return <Gone what="Line" />;
  const pats = game.patterns.get(id) ?? [];
  const valid = pats.length > 0 && pats.every((p) => p.valid);
  const lengths = pats.map((p) => p.path.length);
  const w = routeWindow(game.state, id, 24);
  const money = routeMoney(game.state, id, 1);
  const weekend = game.isWeekend(game.t);
  const req = game.requirement(id);
  const assigned = r.vehicles.length;
  const short = req && req.peak > assigned;
  const buses = r.vehicles.map((v) => game.state.vehicles[v]).filter(Boolean);
  const inService = buses.filter((v) => v.status === 'in_service' || v.status === 'at_stop' || v.status === 'layover' || v.status === 'to_route' || v.status === 'preparing').length;
  const spare = Object.values(game.state.vehicles).filter((v) => !v.route && !v.sell);
  const problems = [...new Set(pats.flatMap((p) => p.problems))];
  // route warnings as structured diagnostics: each one opens a route check
  const diags = lineDiagnostics(game, id);
  const legDiags = diags.filter((d) => d.kind === 'detour' || d.kind === 'contraflow');
  const busDiag = diags.find((d) => d.kind === 'insufficient-buses');
  const headway = game.headwayAt(id, 0, game.t);
  return (
    <>
      <div className="p-head">
        <LineBadge colour={r.colour} size="lg">{r.number}</LineBadge>
        <div className="grow">
          <div className="p-title">{r.name || `Line ${r.number}`}</div>
          <div className="p-sub">
            {r.kind === 'loop' ? 'Loop' : 'Two-way'} · {r.stops.length} stops · {lengths.length ? lengths.map((l) => km(l)).join(' / ') : '–'}
          </div>
        </div>
        <Close />
      </div>
      <div className="p-body">
        <div className="row" style={{ padding: '2px 2px' }}>
          {r.suspended ? (
            <span className="pill warn"><Pause size={12} weight="fill" /> Suspended</span>
          ) : !assigned ? (
            <span className="pill warn"><Warning size={12} weight="fill" /> No buses assigned</span>
          ) : (
            <span className="pill good"><span className="status-dot" /> {inService} of {assigned} buses working</span>
          )}
          <span className="v num muted">{headway ? `every ${headway} min now` : 'no service now'}</span>
        </div>
        {problems.map((p) => <div key={p} className="issue bad"><Warning size={16} weight="fill" />{p}</div>)}
        {short && !r.suspended && busDiag && <DiagnosticButton d={busDiag} onOpen={() => useUI.getState().openModal({ kind: 'timetable', route: id })} />}
        {legDiags.slice(0, 2).map((d) => <DiagnosticButton key={d.id} d={d} onOpen={() => useUI.getState().openRouteCheck({ route: id, pat: d.pat ?? 0, leg: d.leg ?? 0 })} />)}
        {legDiags.length > 2 && (
          <button className="link dg-more" onClick={() => useUI.getState().openRouteCheck({ route: id, pat: legDiags[2].pat ?? 0, leg: legDiags[2].leg ?? 0 })}>
            {legDiags.length - 2} more route warning{legDiags.length > 3 ? 's' : ''} on this line
          </button>
        )}
        <div className="grid3">
          <Kpi value={w.boardings.toLocaleString()} label="Riders, 24 h" />
          <Kpi value={w.ontime === null ? '–' : pct(w.ontime)} label="On time" tone={w.ontime !== null && w.ontime < 0.75 ? 'amber' : undefined} />
          <Kpi value={w.load === null ? '–' : pct(w.load)} label="Avg load" tone={w.load !== null && w.load > 0.85 ? 'amber' : undefined} />
        </div>
        <div className="section">
          <div className="label" style={{ marginBottom: 4 }}>Today so far</div>
          <div className="row"><span className="k">Fares</span><span className="v num mint">{game.money(money.rev)}</span></div>
          <div className="row"><span className="k">Running costs</span><span className="v num">{game.money(-money.cost)}</span></div>
          <div className="row"><span className="k">Result</span><span className={`v num ${money.profit >= 0 ? 'mint' : 'coral'}`}>{game.money(money.profit, { sign: true })}</span></div>
          <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>Includes yesterday. Drivers, energy, maintenance and insurance of this line's buses; depots and stops are in Finances.</div>
        </div>
        <div className="section">
          <div className="row" style={{ minHeight: 0, marginBottom: 6 }}>
            <span className="label">Timetable · {weekend ? 'weekend' : 'weekday'}</span>
            <button className="link" onClick={() => useUI.getState().openModal({ kind: 'timetable', route: id })}>Edit</button>
          </div>
          <div className="t" style={{ fontWeight: 700 }}>{describeTimetable(r.timetable, weekend)}</div>
          {req && <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>Needs {req.peak} bus{req.peak === 1 ? '' : 'es'} at peak · round trip ≈ {Math.round(Math.max(0, ...req.bands.map((b) => b.cycle)))} min incl. layover</div>}
        </div>
        <div className="section">
          <div className="row" style={{ minHeight: 0, marginBottom: 6 }}>
            <span className="label">Buses ({assigned})</span>
            {spare.length > 0 && (
              <button className="link" onClick={() => run(game.assignVehicle(spare[0].id, id), `Bus ${spare[0].fleetNo} assigned`)}>
                <Plus size={12} weight="bold" /> Assign spare bus
              </button>
            )}
          </div>
          {!buses.length && <div className="faint" style={{ fontSize: 12.5 }}>{spare.length ? `${spare.length} spare bus${spare.length > 1 ? 'es' : ''} in your depots.` : 'No spare buses. Buy one in the Fleet panel.'}</div>}
          <div className="mini-list">
            {buses.map((v) => {
              const st = statusPill(v);
              return (
                <div className="mini-row" key={v.id}>
                  <button className="t grow" onClick={() => { useUI.getState().select({ kind: 'vehicle', id: v.id }); focusVehicle(v.id); }}>
                    <span className={`status-dot ${st.cls}`} /> #{v.fleetNo} <span className="faint">{MODEL[v.model].name}</span>
                  </button>
                  <span className="faint num" style={{ fontSize: 12 }}>{st.text.replace('In service · ', '')}</span>
                  <button className="icon-btn sm has-tip" onClick={() => run(game.assignVehicle(v.id, null), `Bus ${v.fleetNo} will return to the depot`)} aria-label="Unassign">
                    <Minus size={13} weight="bold" />
                    <Tip label="Take off this line" side="left" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="section">
          <div className="label" style={{ marginBottom: 6 }}>Stops</div>
          <ol className="stop-seq" style={{ ['--c' as string]: r.colour }}>
            {r.stops.map((sid) => {
              const s = game.state.stops[sid];
              if (!s) return null;
              const n = waitingAt(game.state, sid);
              return (
                <li key={sid}>
                  <button className="t" onClick={() => { useUI.getState().select({ kind: 'stop', id: sid }); focusStop(sid); }}>{s.name}</button>
                  {n > 0 && <span className="faint num">{n} waiting</span>}
                </li>
              );
            })}
          </ol>
        </div>
        {!valid && !problems.length && <div className="issue bad"><Warning size={16} weight="fill" />This line cannot run in its current form.</div>}
      </div>
      <div className="p-foot">
        <button className="btn" style={{ flex: 1 }} onClick={() => useUI.getState().openModal({ kind: 'timetable', route: id })}>
          <CalendarBlank size={16} weight="bold" /> Timetable
        </button>
        <button className="btn has-tip" onClick={() => startDrafting(id)} aria-label="Edit route">
          <PencilSimple size={16} weight="bold" />
          <Tip label="Edit route" hint="Change stops, order or streets" side="below" />
        </button>
        <button className="btn has-tip" onClick={() => run(game.updateRoute(id, { suspended: !r.suspended }), r.suspended ? `Line ${r.number} resumed` : `Line ${r.number} suspended`)} aria-label={r.suspended ? 'Resume' : 'Suspend'}>
          {r.suspended ? <Play size={16} weight="fill" /> : <Pause size={16} weight="fill" />}
          <Tip label={r.suspended ? 'Resume service' : 'Suspend service'} side="below" />
        </button>
        <button className="btn has-tip" onClick={() => focusLine(id)} aria-label="Show on map">
          <ArrowsOutSimple size={16} weight="bold" />
          <Tip label="Show whole line" side="below" />
        </button>
        {confirmDelete ? (
          <button className="btn danger" onClick={() => { if (run(game.deleteRoute(id), `Line ${r.number} closed`)) useUI.getState().select(null); }}>Delete?</button>
        ) : (
          <button className="btn has-tip" onClick={() => setConfirmDelete(true)} aria-label="Delete line">
            <Trash size={16} weight="bold" />
            <Tip label="Close this line" hint="Buses return to their depot" side="below" />
          </button>
        )}
      </div>
    </>
  );
}

// ───────────────────────────────────────────── stop

/** Estimated residents and jobs within walking distance (from the region's demand grid). */
export function catchment(game: Game, at: LngLat) {
  const d = game.region.demand;
  const [x, y] = game.geo.xy(at);
  const R = STOP_RULES.catchmentM;
  let residents = 0, jobs = 0;
  const i0 = Math.max(0, Math.floor((x - R - d.x0) / d.cell)), i1 = Math.min(d.w - 1, Math.floor((x + R - d.x0) / d.cell));
  const j0 = Math.max(0, Math.floor((y - R - d.y0) / d.cell)), j1 = Math.min(d.h - 1, Math.floor((y + R - d.y0) / d.cell));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const cx = d.x0 + (i + 0.5) * d.cell, cy = d.y0 + (j + 0.5) * d.cell;
      if ((cx - x) ** 2 + (cy - y) ** 2 > R * R) continue;
      residents += d.residents[j * d.w + i];
      jobs += d.jobs[j * d.w + i];
    }
  const pois = game.region.pois.filter((p) => distanceM(p.lngLat, at) <= R && p.name).sort((a, b) => b.weight - a.weight).slice(0, 3);
  return { residents: Math.round(residents / 50) * 50, jobs: Math.round(jobs / 50) * 50, pois };
}

function StopInspector({ id }: { id: string }) {
  const game = useGameUpdates(2);
  const [name, setName] = useState<string | null>(null);
  if (!game) return null;
  const s = game.state.stops[id];
  if (!s) return <Gone what="Stop" />;
  const lines = game.routesUsing(id);
  const zone = game.geo.zone(s.zone);
  const road = game.geo.streetNear(s.lngLat);
  const c = catchment(game, s.lngLat);
  const commit = () => {
    if (name !== null && name.trim() && name !== s.name) run(game.renameStop(id, name), 'Stop renamed');
    setName(null);
  };
  return (
    <>
      <div className="p-head">
        <div className="stop-icon"><MapPin size={20} weight="fill" /></div>
        <div className="grow">
          {name === null ? (
            <button className="p-title editable" onClick={() => setName(s.name)} title="Rename stop">
              {s.name} <PencilSimple size={13} weight="bold" className="faint" />
            </button>
          ) : (
            <input className="title-input" autoFocus value={name} maxLength={48} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setName(null); }} aria-label="Stop name" />
          )}
          <div className="p-sub">{road ? `${road} · ` : ''}{zone?.name ?? ''}{s.alt !== undefined && s.alt >= 0 ? ' · both sides of the road' : ''}</div>
        </div>
        <Close />
      </div>
      <div className="p-body">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-start' }}>
          {lines.length ? lines.map((r) => (
            <button key={r.id} className="badge-btn" onClick={() => { useUI.getState().select({ kind: 'line', id: r.id }); focusLine(r.id); }}>
              <LineBadge colour={r.colour}>{r.number}</LineBadge>
            </button>
          )) : <span className="pill warn">Not served by any line</span>}
        </div>
        <ArrivalBoard stopId={id} />
        <div className="section">
          <div className="label" style={{ marginBottom: 4 }}>Within {STOP_RULES.catchmentM} m walk (estimate)</div>
          <div className="grid3" style={{ marginTop: 6 }}>
            <Kpi value={c.residents.toLocaleString()} label="Residents" />
            <Kpi value={c.jobs.toLocaleString()} label="Jobs" />
            <Kpi value={String(waitingAt(game.state, id))} label="Waiting now" />
          </div>
          {c.pois.length > 0 && <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Nearby: {c.pois.map((p) => `${p.name} (${POI_LABEL[p.kind].toLowerCase()})`).join(', ')}</div>}
        </div>
      </div>
      <div className="p-foot">
        <button className="btn primary" style={{ flex: 1 }} onClick={() => { startDrafting(null); useUI.getState().editDraft(() => ({ stops: [id] })); }}>
          <Path size={16} weight="bold" /> Start a line here
        </button>
        <button className="btn has-tip" disabled={lines.length > 0} onClick={() => { if (run(game.removeStop(id), 'Stop removed')) useUI.getState().select(null); }} aria-label="Remove stop">
          <Trash size={16} weight="bold" />
          <Tip label={lines.length ? 'Remove it from its lines first' : 'Remove stop'} hint="Construction costs are not refunded" side="below" />
        </button>
      </div>
    </>
  );
}

// ───────────────────────────────────────────── depot

function DepotInspector({ id }: { id: string }) {
  const game = useGameUpdates(2);
  if (!game) return null;
  const d = game.state.depots[id];
  if (!d) return <Gone what="Depot" />;
  const buses = Object.values(game.state.vehicles).filter((v) => v.depot === id);
  const parked = buses.filter((v) => v.status === 'parked').length;
  const maint = buses.filter((v) => v.status === 'maintenance').length;
  const upkeep = ECON.depotUpkeepPerDay + (d.level - 1) * ECON.depotExpandUpkeep;
  return (
    <>
      <div className="p-head">
        <div className="stop-icon depot"><Warehouse size={20} weight="fill" /></div>
        <div className="grow">
          <div className="p-title">{d.name}</div>
          <div className="p-sub">{game.geo.zone(d.zone)?.name ?? ''} · level {d.level}</div>
        </div>
        <Close />
      </div>
      <div className="p-body">
        <div className="section">
          <div className="row" style={{ minHeight: 0, marginBottom: 8 }}>
            <span className="k">Spaces used</span>
            <span className="v num">{buses.length}<span className="faint"> / {d.capacity}</span></span>
          </div>
          <LoadBar value={buses.length / d.capacity} marker={false} />
        </div>
        <div className="grid3">
          <Kpi value={String(parked)} label="Parked" />
          <Kpi value={String(buses.length - parked - maint)} label="Out working" />
          <Kpi value={String(maint)} label="In service bay" />
        </div>
        <div className="section">
          <div className="row"><span className="k">Upkeep</span><span className="v num">{game.money(upkeep)} / day</span></div>
          {d.level < 4 && <div className="row"><span className="k">Expansion (+{ECON.depotExpandCapacity} spaces)</span><span className="v num">{game.money(ECON.depotExpandCost)}</span></div>}
        </div>
        <div className="mini-list">
          {buses.map((v) => {
            const st = statusPill(v);
            const r = v.route ? game.state.routes[v.route] : null;
            return (
              <div className="mini-row" key={v.id}>
                <button className="t grow" onClick={() => useUI.getState().select({ kind: 'vehicle', id: v.id })}>
                  <span className={`status-dot ${st.cls}`} /> #{v.fleetNo} <span className="faint">{MODEL[v.model].name}</span>
                </button>
                {r ? <LineBadge colour={r.colour}>{r.number}</LineBadge> : <span className="faint" style={{ fontSize: 12 }}>spare</span>}
              </div>
            );
          })}
        </div>
      </div>
      <div className="p-foot">
        <button className="btn primary" style={{ flex: 1 }} onClick={() => useUI.getState().openPanel('fleet')}>
          <Plus size={16} weight="bold" /> Buy buses
        </button>
        <button className="btn has-tip" disabled={d.level >= 4} onClick={() => run(game.expandDepot(id), `${d.name} expanded`)} aria-label="Expand">
          <ArrowsOutSimple size={16} weight="bold" />
          <Tip label="Expand depot" hint={`+${ECON.depotExpandCapacity} spaces for ${game.money(ECON.depotExpandCost)}`} side="below" />
        </button>
        <button className="btn has-tip" onClick={() => focusDepot(id)} aria-label="Show">
          <Crosshair size={16} weight="bold" />
          <Tip label="Show on map" side="below" />
        </button>
      </div>
    </>
  );
}

// ───────────────────────────────────────────── operating area

function ZoneInspector({ id }: { id: string }) {
  const game = useGameUpdates(1);
  if (!game) return null;
  const info = licenceInfo(game, id);
  if (!info) return <Gone what="Area" />;
  const z = info.zone;
  const home = game.state.territory.home === id;
  const stops = Object.values(game.state.stops).filter((s) => s.zone === id).length;
  return (
    <>
      <div className="p-head">
        <div className={`stop-icon ${info.owned ? '' : 'locked'}`}>{info.owned ? <LockOpen size={20} weight="fill" /> : <Lock size={20} weight="fill" />}</div>
        <div className="grow">
          <div className="p-title">{z.name}</div>
          <div className="p-sub">{z.named ? 'Neighbourhood' : 'Unnamed area'} · {(z.landKm2 ?? z.areaKm2).toFixed(1)} km² of land</div>
        </div>
        <Close />
      </div>
      <div className="p-body">
        <div className="row" style={{ padding: '2px 2px' }}>
          {info.owned ? <span className="pill good"><Check size={12} weight="bold" /> Licensed{home ? ' · home area' : ''}</span> : info.adjacent ? <span className="pill warn">Available to license</span> : <span className="pill">Locked</span>}
          {info.owned && <span className="v num muted">{stops} stop{stops === 1 ? '' : 's'}</span>}
        </div>
        <div className="grid3">
          <Kpi value={`${(z.residents / 1000).toFixed(1)}k`} label="Residents" />
          <Kpi value={`${(z.jobs / 1000).toFixed(1)}k`} label="Jobs" />
          <Kpi value={String(z.neighbours.length)} label="Neighbours" />
        </div>
        <div className="faint" style={{ fontSize: 12 }}>Population and jobs are estimates derived from OpenStreetMap buildings and land use, not official statistics.</div>
        {z.highlights.length > 0 && (
          <div className="section">
            <div className="label" style={{ marginBottom: 4 }}>Notable destinations</div>
            <div className="t" style={{ fontSize: 13 }}>{z.highlights.join(' · ')}</div>
          </div>
        )}
        {!info.owned && (
          <div className="section">
            <div className="label" style={{ marginBottom: 4 }}>Operating licence</div>
            <div className="row"><span className="k">Licence fee</span><span className="v num">{game.money(info.cost)}</span></div>
            <div className="row"><span className="k">Reputation needed</span><span className={`v num ${game.state.company.reputation >= info.repRequired ? 'mint' : 'amber'}`}>{info.repRequired}</span></div>
            {info.blockers.map((b) => <div key={b} className="issue info"><Lock size={14} weight="bold" />{b}</div>)}
            <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>Without a licence your buses can still drive through this area, but you cannot open stops or depots here.</div>
          </div>
        )}
      </div>
      {!info.owned && (
        <div className="p-foot">
          <button className="btn primary" style={{ flex: 1 }} disabled={!info.canBuy} onClick={() => run(game.buyLicence(id))}>
            <LockOpen size={16} weight="bold" /> Buy licence · {game.money(info.cost, { compact: true })}
          </button>
        </div>
      )}
    </>
  );
}
