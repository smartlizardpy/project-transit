import { useEffect, useState } from 'react';
import { X, Plus, Lock, Warehouse } from '@phosphor-icons/react';
import { useUI, type Panel } from '../state/store.ts';
import type { Game, Result } from '../game/engine.ts';
import { useGameUpdates } from './hooks.ts';
import { LineBadge, LoadBar, Segmented, Tip } from './primitives.tsx';
import { BusArt } from './BusArt.tsx';
import { focusDepot, focusLine, focusStop, focusVehicle, focusZone } from './camera.ts';
import { startDrafting } from './routeDraft.ts';
import { ECON, MODEL, MODELS, DAY } from '../game/content.ts';
import { STATUS_LABEL } from '../game/vehicles.ts';
import { waitingAt } from '../game/passengers.ts';
import { OBJECTIVES, licenceInfo, routeMoney, routeWindow, unlockedModels } from '../game/progress.ts';
import { CATEGORY_LABEL, dayTotals } from '../game/finance.ts';
import { hhmm } from '../game/time.ts';
import type { LedgerCategory } from '../game/types.ts';
import { NetworkControl } from './network/NetworkControl.tsx';
import { companyLevel } from '../game/control.ts';
import '../styles/panels.css';

const notify = (text: string, tone: 'good' | 'bad' | 'warn' | 'info') => useUI.getState().notify(text, tone);
function run<T>(r: Result<T>, ok?: string): r is { ok: true; value: T } {
  if (r.ok) { if (ok) notify(ok, 'good'); return true; }
  notify(r.error, 'bad');
  return false;
}
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function Panels() {
  const panel = useUI((s) => s.panel);
  const [shown, setShown] = useState<Panel>(panel);
  const [closing, setClosing] = useState(false);
  const game = useGameUpdates(2);
  useEffect(() => {
    if (panel) {
      setShown(panel);
      setClosing(false);
    } else if (shown) {
      setClosing(true);
      const t = setTimeout(() => { setShown(null); setClosing(false); }, 150);
      return () => clearTimeout(t);
    }
  }, [panel]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown || !game) return null;
  return (
    <section className={`card panel ${shown === 'network' ? 'wide' : ''} ${closing ? 'closing' : ''}`} key={shown} aria-label={shown}>
      {shown === 'fleet' && <FleetPanel game={game} />}
      {shown === 'finance' && <FinancePanel game={game} />}
      {shown === 'lines' && <LinesPanel game={game} />}
      {shown === 'company' && <CompanyPanel game={game} />}
      {shown === 'network' && <NetworkControl game={game} />}
    </section>
  );
}

function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="p-head">
      <div className="grow">
        <div className="p-title" style={{ fontSize: 19 }}>{title}</div>
        <div className="p-sub">{sub}</div>
      </div>
      <button className="close-btn has-tip" onClick={() => useUI.getState().openPanel(null)} aria-label="Close panel">
        <X size={15} weight="bold" />
        <Tip label="Close" k="Esc" side="left" />
      </button>
    </div>
  );
}

const hover = (kind: 'line' | 'stop' | 'vehicle' | 'depot', id: string) => ({
  onMouseEnter: () => useUI.getState().setHover({ kind, id } as never),
  onMouseLeave: () => useUI.getState().setHover(null),
});

// ───────────────────────────────────────── lines

function LinesPanel({ game }: { game: Game }) {
  const [tab, setTab] = useState<'lines' | 'stops'>('lines');
  const sel = useUI((s) => s.selection);
  const st = game.state;
  const routes = Object.values(st.routes);
  const stops = Object.values(st.stops)
    .map((s) => ({ s, w: waitingAt(st, s.id), lines: Object.values(st.routes).filter((r) => r.stops.includes(s.id) || r.returnStops?.includes(s.id)) }))
    .sort((a, b) => b.w - a.w);
  return (
    <>
      <Head title="Lines" sub={`${routes.length} bus lines · ${stops.length} stops`} />
      <div className="p-body">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'lines', label: 'Lines' }, { value: 'stops', label: 'Stops' }]} />
        {tab === 'lines' && (routes.length === 0 ? (
          <div className="pn-empty">No lines yet. Build stops with the stop tool (<b>B</b>), then draw a line (<b>R</b>).</div>
        ) : (
          <div className="list">
            {routes.map((r) => {
              const need = game.requirement(r.id)?.peak ?? 0;
              const have = r.vehicles.length;
              const short = !r.suspended && have < need;
              const riders = routeWindow(st, r.id, 24).boardings;
              const profit = routeMoney(st, r.id, 1).profit;
              return (
                <button key={r.id} className={`lrow ${sel?.kind === 'line' && sel.id === r.id ? 'on' : ''}`} style={{ ['--c' as string]: r.colour }}
                  onClick={() => { useUI.getState().select({ kind: 'line', id: r.id }); focusLine(r.id); }} {...hover('line', r.id)}>
                  <span className="colour-bar" />
                  <div className="grow">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <LineBadge colour={r.colour} size="sm">{r.number}</LineBadge>
                      <span className="t">{r.name}</span>
                      {r.suspended && <span className="pn-tag warn">Suspended</span>}
                    </div>
                    <div className="s" style={{ marginTop: 5 }}>
                      {r.stops.length} stops · <span className={short ? 'amber' : ''}>{have}/{need} buses{short ? ' (short)' : ''}</span> · {riders.toLocaleString('en-GB')} riders/24 h
                    </div>
                  </div>
                  <div className="r" style={{ color: profit >= 0 ? 'var(--mint)' : 'var(--coral)', fontSize: 13 }}>
                    {game.money(profit, { sign: true, compact: true })}
                    <div className="faint" style={{ fontSize: 11, fontWeight: 600, marginTop: 2 }}>today</div>
                  </div>
                </button>
              );
            })}
          </div>
        ))}
        {tab === 'stops' && (stops.length === 0 ? (
          <div className="pn-empty">No stops yet. Build stops with the stop tool (<b>B</b>), then draw a line (<b>R</b>).</div>
        ) : (
          <div className="list">
            {stops.map(({ s, w, lines }) => (
              <button key={s.id} className={`lrow ${sel?.kind === 'stop' && sel.id === s.id ? 'on' : ''}`}
                onClick={() => { useUI.getState().select({ kind: 'stop', id: s.id }); focusStop(s.id); }} {...hover('stop', s.id)}>
                <div className="grow">
                  <div className="t">{s.name}</div>
                  <div className="pn-pips">
                    {lines.length ? lines.map((l) => <LineBadge key={l.id} colour={l.colour} size="sm">{l.number}</LineBadge>) : <span className="s">Not served yet</span>}
                  </div>
                </div>
                <div className="r">{w}<div className="faint" style={{ fontSize: 11, fontWeight: 600 }}>waiting</div></div>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="p-foot">
        <button className="btn primary block" onClick={() => startDrafting(null)}>
          <Plus size={16} weight="bold" /> New line <kbd className="key" style={{ background: 'rgba(12,34,51,0.12)', color: 'var(--accent-ink)', boxShadow: 'none' }}>R</kbd>
        </button>
      </div>
    </>
  );
}

// ───────────────────────────────────────── fleet

function FleetPanel({ game }: { game: Game }) {
  const [tab, setTab] = useState<'buses' | 'buy' | 'depots'>('buses');
  const st = game.state;
  const vehicles = Object.values(st.vehicles).sort((a, b) => a.fleetNo.localeCompare(b.fleetNo, undefined, { numeric: true }));
  const running = vehicles.filter((v) => v.status === 'in_service' || v.status === 'at_stop' || v.status === 'layover').length;
  return (
    <>
      <Head title="Fleet" sub={`${vehicles.length} buses · ${running} in service · ${Object.keys(st.depots).length} depots`} />
      <div className="p-body">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'buses', label: 'Buses' }, { value: 'buy', label: 'Buy' }, { value: 'depots', label: 'Depots' }]} />
        {tab === 'buses' && <BusList game={game} />}
        {tab === 'buy' && <BuyTab game={game} />}
        {tab === 'depots' && <DepotsTab game={game} />}
      </div>
    </>
  );
}

function BusList({ game }: { game: Game }) {
  const sel = useUI((s) => s.selection);
  const st = game.state;
  const vehicles = Object.values(st.vehicles).sort((a, b) => a.fleetNo.localeCompare(b.fleetNo, undefined, { numeric: true }));
  if (!vehicles.length) return <div className="pn-empty">You have no buses. Open the <b>Buy</b> tab to purchase one, then assign it to a line.</div>;
  return (
    <div className="list">
      {vehicles.map((v) => {
        const m = MODEL[v.model];
        const r = v.route ? st.routes[v.route] : null;
        const cap = m?.capacity ?? 1;
        return (
          <button key={v.id} className={`lrow ${sel?.kind === 'vehicle' && sel.id === v.id ? 'on' : ''}`}
            onClick={() => { useUI.getState().select({ kind: 'vehicle', id: v.id }); focusVehicle(v.id); }} {...hover('vehicle', v.id)}>
            {r ? <LineBadge colour={r.colour} size="sm">{r.number}</LineBadge> : <span className="pn-tag">Spare</span>}
            <div className="grow">
              <div className="t">{v.fleetNo} · {m?.name ?? v.model}</div>
              <div className={`s ${v.status === 'broken' ? 'coral' : ''}`}>{STATUS_LABEL[v.status]} · condition <span className={v.condition < 0.45 ? 'coral' : v.condition < 0.7 ? 'amber' : ''}>{pct(v.condition)}</span></div>
            </div>
            <div style={{ width: 76 }}>
              <div className="r" style={{ marginBottom: 5 }}>{v.load}<span className="faint">/{cap}</span></div>
              <LoadBar value={v.load / cap} marker={false} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function BuyTab({ game }: { game: Game }) {
  const st = game.state;
  const depots = Object.values(st.depots);
  const [depotId, setDepotId] = useState<string>(depots[0]?.id ?? '');
  const [bought, setBought] = useState<string | null>(null);
  const [routeId, setRouteId] = useState('');
  const unlocked = unlockedModels(st);
  const depot = st.depots[depotId] ?? depots[0];
  const free = depot ? depot.capacity - game.depotUse(depot.id) : 0;
  const routes = Object.values(st.routes);
  const boughtV = bought ? st.vehicles[bought] : null;
  return (
    <>
      {depots.length === 0 ? (
        <div className="pn-warn">
          You need a depot before you can buy buses: buses are parked and serviced there.
          <div style={{ marginTop: 8 }}><button className="btn sm" onClick={() => useUI.getState().setTool('depot')}><Warehouse size={14} weight="bold" /> Place a depot</button></div>
        </div>
      ) : (
        <div className="section tight">
          <div className="row"><span className="k">Deliver to</span>
            <select className="pn-select" value={depot?.id} onChange={(e) => setDepotId(e.target.value)}>
              {depots.map((d) => <option key={d.id} value={d.id}>{d.name} ({game.depotUse(d.id)}/{d.capacity})</option>)}
            </select>
          </div>
          <div className="row"><span className="k">Balance</span><span className="v">{game.money(st.finance.balance)}</span></div>
        </div>
      )}
      {boughtV && (
        <div className="section tight">
          <div className="row"><span className="k">Bought {boughtV.fleetNo}. Assign to a line?</span></div>
          {routes.length === 0 ? <div className="pn-note">No lines yet. Draw one with the line tool (R).</div> : (
            <div className="pn-actions" style={{ marginTop: 6 }}>
              <select className="pn-select grow" value={routeId} onChange={(e) => setRouteId(e.target.value)}>
                <option value="">Choose a line…</option>
                {routes.map((r) => <option key={r.id} value={r.id}>{r.number} · {r.name}</option>)}
              </select>
              <button className="btn sm primary" disabled={!routeId} onClick={() => { if (run(game.assignVehicle(boughtV.id, routeId), 'Bus assigned')) setBought(null); }}>Assign</button>
              <button className="btn sm" onClick={() => setBought(null)}>Later</button>
            </div>
          )}
        </div>
      )}
      <div className="list" style={{ gap: 8 }}>
        {MODELS.map((m) => {
          const ok = unlocked.has(m.id);
          const afford = st.finance.balance - m.price >= ECON.overdraftLimit;
          const full = !!depot && free <= 0;
          return (
            <div className={`pn-card ${ok ? '' : 'locked'}`} key={m.id}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 800 }}>{m.name}</span>
                  {m.electric && <span className="pn-tag good">Electric</span>}
                </div>
                <div className="faint" style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>{m.kind} · {m.length} m</div>
              </div>
              <div className="pn-art"><BusArt model={m.id} livery={st.company.colour} width={220} /></div>
              <div className="pn-note">{m.blurb}</div>
              <div className="pn-stats">
                <div><b>{m.capacity}</b><span>capacity</span></div>
                <div><b>{m.seats}</b><span>seats</span></div>
                <div><b>{game.money(m.price, { compact: true })}</b><span>price</span></div>
              </div>
              <div className="pn-note">Energy {m.energyPerKm.toFixed(2)} per km{m.electric ? ' (electricity, cheaper per unit)' : ''} · servicing about {Math.round(m.serviceCost * 100)}% of price</div>
              {ok ? (
                <button className="btn primary block" disabled={!depot || full || !afford}
                  onClick={() => { const r = game.buyVehicle(m.id, depot.id); if (run(r)) { notify(`Bought ${m.name}`, 'good'); setBought(r.value); setRouteId(''); } }}>
                  {!depot ? 'Needs a depot' : full ? 'Depot full' : !afford ? 'Not enough funds' : `Buy · ${game.money(m.price)}`}
                </button>
              ) : (
                <div className="pn-actions"><Lock size={15} weight="bold" /><span className="amber" style={{ fontWeight: 700, fontSize: 13 }}>
                  Needs reputation {m.unlockRep}{m.unlockObjective ? ' (or an objective)' : ''}</span></div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function DepotsTab({ game }: { game: Game }) {
  const sel = useUI((s) => s.selection);
  const depots = Object.values(game.state.depots);
  return (
    <>
      {depots.length === 0 && <div className="pn-empty">No depots yet. A depot houses your buses. Place one on a road with the depot tool.</div>}
      <div className="list">
        {depots.map((d) => {
          const use = game.depotUse(d.id);
          return (
            <div className={`lrow ${sel?.kind === 'depot' && sel.id === d.id ? 'on' : ''}`} key={d.id} style={{ cursor: 'pointer' }}
              onClick={() => { useUI.getState().select({ kind: 'depot', id: d.id }); focusDepot(d.id); }} {...hover('depot', d.id)}>
              <Warehouse size={18} weight="bold" />
              <div className="grow">
                <div className="t">{d.name}</div>
                <div className="s">{use}/{d.capacity} bays · level {d.level}</div>
                <div className="pn-bar" style={{ marginTop: 6 }}><i style={{ width: pct(Math.min(1, use / d.capacity)) }} /></div>
              </div>
              <button className="btn sm" onClick={(e) => { e.stopPropagation(); run(game.expandDepot(d.id), 'Depot expanded'); }}>
                Expand<span className="faint"> {game.money(ECON.depotExpandCost, { compact: true })}</span>
              </button>
            </div>
          );
        })}
      </div>
      <button className="btn block" onClick={() => useUI.getState().setTool('depot')}><Plus size={16} weight="bold" /> Build depot · {game.money(ECON.depotCost, { compact: true })}</button>
      <div className="pn-note">Expanding adds {ECON.depotExpandCapacity} bays and {game.money(ECON.depotExpandUpkeep)} daily upkeep. Depots cost {game.money(ECON.depotUpkeepPerDay)} per day to run.</div>
    </>
  );
}

// ───────────────────────────────────────── finance

function FinancePanel({ game }: { game: Game }) {
  const [tab, setTab] = useState<'overview' | 'lines' | 'ledger' | 'loans'>('overview');
  const f = game.state.finance;
  return (
    <>
      <Head title="Finances" sub={`${game.state.company.name} · amounts in ${game.money(0).replace(/[0-9.,\s]/g, '') || 'base units'}`} />
      <div className="p-body">
        <div className="section" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="label">Account balance</div>
            <div className={`num ${f.balance < 0 ? 'coral' : 'mint'}`} style={{ fontSize: 28, fontWeight: 800, marginTop: 4 }}>{game.money(f.balance)}</div>
          </div>
          {f.loan > 0 && <div className="r" style={{ textAlign: 'right' }}><div className="label">Loan</div><div className="num coral" style={{ fontWeight: 800, fontSize: 16 }}>{game.money(f.loan)}</div></div>}
        </div>
        <Segmented tone="money" value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'lines', label: 'Lines' }, { value: 'ledger', label: 'Ledger' }, { value: 'loans', label: 'Loans' }]} />
        {tab === 'overview' && <FinOverview game={game} />}
        {tab === 'lines' && <FinLines game={game} />}
        {tab === 'ledger' && <FinLedger game={game} />}
        {tab === 'loans' && <FinLoans game={game} />}
      </div>
    </>
  );
}

function FinOverview({ game }: { game: Game }) {
  const st = game.state;
  const f = st.finance;
  const day = Math.floor(game.t / DAY);
  const today = dayTotals(st, day);
  const yest = dayTotals(st, day - 1);
  const fare = st.company.fare;
  const low = f.balance < 20_000 || st.company.status === 'warning' || st.company.status === 'insolvent';
  const setFare = (x: number) => run(game.setFare(Math.round(Math.min(ECON.fareMax, Math.max(ECON.fareMin, x)) * 100) / 100));
  // cost breakdown for yesterday + today
  const cats = new Map<LedgerCategory, number>();
  for (const d of [day - 1, day]) for (const [c, v] of Object.entries(f.daily[d] ?? {}) as [LedgerCategory, number][]) cats.set(c, (cats.get(c) ?? 0) + v);
  const rows = [...cats.entries()].filter(([c]) => c !== 'equity').sort((a, b) => a[1] - b[1]);
  const firstDay = Math.max(Math.floor(st.company.founded / DAY), day - 13);
  const series: { d: number; v: number }[] = [];
  for (let d = firstDay; d <= day; d++) if (f.daily[d] || d === day) series.push({ d, v: dayTotals(st, d).result });
  return (
    <>
      {low && (
        <div className={`pn-warn ${st.company.status !== 'ok' ? 'bad' : ''}`}>
          {st.company.status === 'insolvent' ? 'Insolvent. ' : 'Low funds. '}
          Your balance may go as low as {game.money(ECON.overdraftLimit)} (the overdraft limit, charged {(ECON.overdraftRatePerDay * 100).toFixed(2)}% per day).
          After {ECON.graceDays} consecutive days in the red the company becomes insolvent{st.company.redDays > 0 ? ` (${st.company.redDays} so far)` : ''}. Raise fares, cut idle buses or take a loan.
        </div>
      )}
      <div className="section">
        <table className="pn-table">
          <thead><tr><th /><th>Yesterday</th><th>Today so far</th></tr></thead>
          <tbody>
            {([['Operating income', 'income'], ['Operating costs', 'operating'], ['Operating result', 'result']] as const).map(([k, key]) => (
              <tr key={k}><td>{k}</td>
                {[yest, today].map((t, i) => <td key={i} className={key === 'result' ? (t.result >= 0 ? 'mint' : 'coral') : ''}>{game.money(t[key], { sign: key === 'result' })}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pn-note" style={{ marginTop: 6 }}>Operating figures exclude purchases, construction, licences and loans.</div>
      </div>
      <div className="section">
        <div className="section-head"><span style={{ fontWeight: 800, fontSize: 14 }}>Daily operating result</span>
          <span className="pn-legend"><span><i style={{ background: 'var(--mint)' }} />profit</span><span><i style={{ background: 'var(--coral)' }} />loss</span></span></div>
        <ResultChart game={game} series={series} today={day} />
      </div>
      {rows.length > 0 && (
        <div className="section">
          <div className="section-head"><span style={{ fontWeight: 800, fontSize: 14 }}>By category</span><span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>yesterday + today</span></div>
          {rows.map(([c, v]) => <div className="row" key={c}><span className="k">{CATEGORY_LABEL[c]}</span><span className={`v ${v < 0 ? 'coral' : 'mint'}`}>{game.money(v, { sign: true })}</span></div>)}
        </div>
      )}
      <div className="section">
        <div className="section-head"><span style={{ fontWeight: 800, fontSize: 14 }}>Fare per journey</span></div>
        <div className="pn-stepper">
          <button className="btn sm" onClick={() => setFare(fare - 0.05)} disabled={fare <= ECON.fareMin} aria-label="Lower fare">−</button>
          <div className="val">{game.money(fare, { fine: true })}</div>
          <button className="btn sm" onClick={() => setFare(fare + 0.05)} disabled={fare >= ECON.fareMax} aria-label="Raise fare">+</button>
        </div>
        <div className="pn-note" style={{ marginTop: 8 }}>
          Suggested around {game.money(ECON.referenceFare, { fine: true })}. A higher fare earns more per rider but reduces ridership and lowers the Fares part of passenger satisfaction. Transfers are included in one fare. Range {game.money(ECON.fareMin, { fine: true })} to {game.money(ECON.fareMax, { fine: true })}.
        </div>
      </div>
    </>
  );
}

function ResultChart({ game, series, today }: { game: Game; series: { d: number; v: number }[]; today: number }) {
  if (series.length < 2) return <div className="pn-note">Not enough history yet. A chart appears after the first full day.</div>;
  const W = 316, H = 132, L = 40, T = 8, B = 20, R = 4;
  const max = Math.max(1, ...series.map((s) => s.v));
  const min = Math.min(0, ...series.map((s) => s.v));
  const y = (v: number) => T + ((max - v) / (max - min || 1)) * (H - T - B);
  const bw = (W - L - R) / series.length;
  const y0 = y(0);
  return (
    <svg className="pn-chart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Daily operating result, last days">
      {[max, 0, ...(min < 0 ? [min] : [])].map((v, i) => (
        <g key={i}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.08)" /><text x={L - 4} y={y(v) + 3} textAnchor="end">{game.money(v, { compact: true })}</text></g>
      ))}
      {series.map((s, i) => {
        const yy = y(s.v);
        return (
          <g key={s.d}>
            <rect x={L + i * bw + bw * 0.15} width={bw * 0.7} y={Math.min(yy, y0)} height={Math.max(1, Math.abs(yy - y0))} rx={2}
              fill={s.v >= 0 ? 'var(--mint)' : 'var(--coral)'} opacity={s.d === today ? 0.55 : 1}><title>{`Day ${s.d + 1}: ${game.money(s.v, { sign: true })}${s.d === today ? ' (so far)' : ''}`}</title></rect>
            {(i % Math.ceil(series.length / 7) === 0 || s.d === today) && <text x={L + i * bw + bw / 2} y={H - 6} textAnchor="middle">{s.d + 1}</text>}
          </g>
        );
      })}
      <text x={W - R} y={H - 6} textAnchor="end" style={{ display: 'none' }} />
    </svg>
  );
}

function FinLines({ game }: { game: Game }) {
  const st = game.state;
  const rows = Object.values(st.routes).map((r) => ({ r, d1: routeMoney(st, r.id, 1), d7: routeMoney(st, r.id, 7) })).sort((a, b) => b.d7.profit - a.d7.profit);
  if (!rows.length) return <div className="pn-empty">No lines yet. Draw a line with the line tool (R) to see its profitability.</div>;
  const mv = (x: number, sign = false) => game.money(x, { compact: true, sign });
  return (
    <div className="section">
      <table className="pn-table">
        <thead><tr><th>Line</th><th>Rev 1d</th><th>Cost 1d</th><th>Profit 1d</th><th>Profit 7d</th></tr></thead>
        <tbody>
          {rows.map(({ r, d1, d7 }) => (
            <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => { useUI.getState().select({ kind: 'line', id: r.id }); focusLine(r.id); }}>
              <td><LineBadge colour={r.colour} size="sm">{r.number}</LineBadge></td>
              <td>{mv(d1.rev)}</td><td>{mv(d1.cost)}</td>
              <td className={d1.profit >= 0 ? 'mint' : 'coral'}>{mv(d1.profit, true)}</td>
              <td className={d7.profit >= 0 ? 'mint' : 'coral'}>{mv(d7.profit, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pn-note" style={{ marginTop: 8 }}>"1d" covers yesterday and today so far; "7d" the last seven days plus today. Revenue is fares; cost is driver wages and fuel. Fixed costs (insurance, depots, stops, maintenance) are not allocated to lines, so the company result is lower than the sum of these.</div>
    </div>
  );
}

function FinLedger({ game }: { game: Game }) {
  const entries = game.state.finance.ledger.slice(-80).reverse();
  if (!entries.length) return <div className="pn-empty">No ledger entries yet.</div>;
  return (
    <div className="section">
      <table className="pn-table">
        <thead><tr><th>When</th><th>Entry</th><th>Amount</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>D{Math.floor(e.t / DAY) + 1} {hhmm(e.t)}</td>
              <td className="memo">{e.memo}<div className="faint" style={{ fontSize: 10.5 }}>{CATEGORY_LABEL[e.cat]}</div></td>
              <td className={e.amt >= 0 ? 'mint' : 'coral'}>{game.money(e.amt, { sign: true, fine: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pn-note" style={{ marginTop: 8 }}>Showing the latest {entries.length} entries. Entries older than about a week are summarised into daily totals.</div>
    </div>
  );
}

function FinLoans({ game }: { game: Game }) {
  const f = game.state.finance;
  const room = ECON.loanMax - f.loan;
  return (
    <>
      <div className="section">
        <div className="row"><span className="k">Outstanding loan</span><span className="v">{game.money(f.loan)}</span></div>
        <div className="row"><span className="k">Maximum</span><span className="v">{game.money(ECON.loanMax)}</span></div>
        <div className="row"><span className="k">Interest</span><span className="v">{(ECON.loanRatePerDay * 100).toFixed(3)}% per day</span></div>
        <div className="row"><span className="k">Interest per day now</span><span className="v coral">{game.money(f.loan * ECON.loanRatePerDay, { fine: true })}</span></div>
      </div>
      <div className="section">
        <div className="section-head"><span style={{ fontWeight: 800, fontSize: 14 }}>Borrow</span></div>
        <div className="pn-actions">
          {[25_000, 100_000].map((a) => <button key={a} className="btn money sm" disabled={room < 1} onClick={() => run(game.takeLoan(Math.min(a, room)), `Borrowed ${game.money(Math.min(a, room))}`)}>+ {game.money(a, { compact: true })}</button>)}
        </div>
        <div className="section-head" style={{ marginTop: 12 }}><span style={{ fontWeight: 800, fontSize: 14 }}>Repay</span></div>
        <div className="pn-actions">
          {[25_000, 100_000].map((a) => <button key={a} className="btn sm" disabled={f.loan < 1} onClick={() => run(game.repayLoan(Math.min(a, f.loan)), `Repaid ${game.money(Math.min(a, f.loan))}`)}>− {game.money(a, { compact: true })}</button>)}
          <button className="btn sm" disabled={f.loan < 1} onClick={() => run(game.repayLoan(f.loan), 'Loan repaid')}>All</button>
        </div>
        <div className="pn-note" style={{ marginTop: 8 }}>Interest is a daily operating cost. Borrowing is cheaper than the overdraft, but it still has to be repaid.</div>
      </div>
    </>
  );
}

// ───────────────────────────────────────── company

function repTitle(r: number) {
  const l = companyLevel(r);
  return `Level ${l.level} · ${l.title}`;
}

function CompanyPanel({ game }: { game: Game }) {
  const st = game.state;
  const c = st.company;
  const [name, setName] = useState(c.name);
  useEffect(() => setName(c.name), [c.name]);
  const owned = st.territory.owned;
  const avail = game.region.zones
    .map((z) => licenceInfo(game, z.id))
    .filter((i): i is NonNullable<typeof i> => !!i && !i.owned && i.adjacent)
    .sort((a, b) => a.cost - b.cost);
  const days = st.stats.days.slice(-10).reverse();
  const commit = () => { const n = name.trim(); if (n && n !== c.name) run(game.setCompany({ name: n }), 'Company renamed'); else setName(c.name); };
  return (
    <>
      <Head title="Company" sub={`Founded day ${Math.floor(c.founded / DAY) + 1} · day ${Math.floor(game.t / DAY) + 1} now`} />
      <div className="p-body">
        <div className="section">
          <div className="label">Company name</div>
          <input className="pn-input" style={{ marginTop: 6 }} value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <div className="row" style={{ marginTop: 10 }}><span className="k">Reputation</span><span className="v">{Math.floor(c.reputation)} / 100 · {repTitle(c.reputation)}</span></div>
          <div className="pn-bar good" style={{ marginTop: 6 }}><i style={{ width: `${c.reputation}%` }} /></div>
          <div className="row" style={{ marginTop: 8 }}><span className="k">Status</span><span className={`pn-tag ${c.status === 'ok' ? 'good' : 'bad'}`}>{c.status}</span></div>
        </div>

        <div className="section">
          <div className="section-head"><span style={{ fontWeight: 800, fontSize: 14 }}>Objectives</span>
            <span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>{OBJECTIVES.filter((o) => st.objectives[o.id]?.done).length}/{OBJECTIVES.length}</span></div>
          <div className="list">
            {OBJECTIVES.map((o) => {
              const s = st.objectives[o.id];
              const p = s?.done ? 1 : s?.progress ?? 0;
              const reward = [o.reward.cash ? game.money(o.reward.cash) : '', o.reward.rep ? `+${o.reward.rep} reputation` : '', o.reward.label ?? ''].filter(Boolean).join(' · ');
              return (
                <div key={o.id} style={{ opacity: s?.done ? 0.7 : 1 }}>
                  <div className="row"><span style={{ fontWeight: 700 }}>{s?.done ? '✓ ' : ''}{o.title}</span><span className="faint num" style={{ fontSize: 12 }}>{pct(p)}</span></div>
                  <div className="pn-note">{o.description}{reward && <> Reward: {reward}.</>}</div>
                  <div className={`pn-bar ${s?.done ? 'good' : ''}`} style={{ marginTop: 5 }}><i style={{ width: pct(p) }} /></div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="section">
          <div className="section-head"><span style={{ fontWeight: 800, fontSize: 14 }}>Territory</span><span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>{owned.length} licensed</span></div>
          {owned.map((id) => (
            <div className="row" key={id}><span className="k">{game.geo.zone(id)?.name ?? id}{id === st.territory.home ? ' (home)' : ''}</span>
              <button className="btn sm" onClick={() => { useUI.getState().select({ kind: 'zone', id }); focusZone(id); }}>Show</button></div>
          ))}
          <div className="label" style={{ margin: '12px 0 6px' }}>Available</div>
          {avail.length === 0 && <div className="pn-note">No neighbouring areas to license.</div>}
          {avail.map((i) => (
            <div key={i.zone.id} style={{ padding: '8px 0', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <div className="row"><span style={{ fontWeight: 700 }}>{i.zone.name}</span><span className="v">{game.money(i.cost)}</span></div>
              <div className="pn-note">Needs reputation {i.repRequired} · {i.zone.residents.toLocaleString('en-GB')} residents, {i.zone.jobs.toLocaleString('en-GB')} jobs</div>
              {i.blockers.map((b) => <div key={b} className="pn-note amber">{b}</div>)}
              <div className="pn-actions" style={{ marginTop: 6 }}>
                <button className="btn sm" onClick={() => { useUI.getState().select({ kind: 'zone', id: i.zone.id }); focusZone(i.zone.id); }}>Show</button>
                <button className="btn sm primary" disabled={!i.canBuy} onClick={() => run(game.buyLicence(i.zone.id), `Licence bought: ${i.zone.name}`)}>Buy licence</button>
              </div>
            </div>
          ))}
        </div>

        <div className="section">
          <div className="section-head"><span style={{ fontWeight: 800, fontSize: 14 }}>Recent days</span></div>
          {days.length === 0 ? <div className="pn-note">Daily records appear after the first full day.</div> : (
            <table className="pn-table">
              <thead><tr><th>Day</th><th>Riders</th><th>Sat.</th><th>On time</th><th>Revenue</th><th>Costs</th></tr></thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.day}><td>{d.day + 1}</td><td>{d.boardings.toLocaleString('en-GB')}</td><td>{d.boardings ? pct(d.satisfaction) : '–'}</td><td>{d.trips ? pct(d.ontime) : '–'}</td>
                    <td>{game.money(d.revenue, { compact: true })}</td><td>{game.money(d.costs, { compact: true })}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="pn-note" style={{ marginTop: 6 }}>Satisfaction is a 0 to 100% estimate from waiting, journey time, crowding, reliability and fares.</div>
        </div>
      </div>
    </>
  );
}
