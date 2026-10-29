import { useEffect, useState } from 'react';
import { X, Plus, Smiley, SmileyMeh, Lock, Warehouse, Lightning } from '@phosphor-icons/react';
import { useUI, type Panel } from '../state/store.ts';
import { sim, MODELS, type VehicleModel } from '../sim/sim.ts';
import { useTicker } from './hooks.ts';
import { LineBadge, LoadBar, Segmented, Tip } from './primitives.tsx';
import { BusArt } from './BusArt.tsx';
import { money, pct } from './format.ts';
import { focusLine, focusStop, focusVehicle } from './camera.ts';
import { assignDepotVehicle, buyVehicle } from '../sim/actions.ts';
import { newDraft } from './RouteTray.tsx';
import { BRAND } from '../map/vehicles3d.ts';

export function Panels() {
  const panel = useUI((s) => s.panel);
  const [shown, setShown] = useState<Panel>(panel);
  const [closing, setClosing] = useState(false);
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
  if (!shown) return null;
  return (
    <section className={`card panel ${closing ? 'closing' : ''}`} key={shown} aria-label={shown}>
      {shown === 'fleet' && <FleetPanel />}
      {shown === 'finance' && <FinancePanel />}
      {shown === 'lines' && <LinesPanel />}
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

// ───────────────────────────────────────── lines

function LinesPanel() {
  useTicker(1);
  const [tab, setTab] = useState<'lines' | 'stops'>('lines');
  const sel = useUI((s) => s.selection);
  const stops = [...sim.stops.values()].sort((a, b) => b.waiting - a.waiting);
  return (
    <>
      <Head title="Lines" sub={`${sim.lines.length} bus lines · ${sim.stops.size} stops`} />
      <div className="p-body">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'lines', label: 'Lines' }, { value: 'stops', label: 'Stops' }]} />
        {tab === 'lines' && (
          <div className="list">
            {sim.lines.map((l) => {
              const n = sim.vehicles.filter((v) => v.lineId === l.id).length;
              const happy = l.perf.satisfaction >= 0.75;
              return (
                <button key={l.id} className={`lrow ${sel?.kind === 'line' && sel.id === l.id ? 'on' : ''}`} style={{ ['--c' as string]: l.colour, alignItems: 'stretch' }}
                  onClick={() => { useUI.getState().select({ kind: 'line', id: l.id }); focusLine(l.id); }}
                  onMouseEnter={() => useUI.getState().setHover({ kind: 'line', id: l.id })} onMouseLeave={() => useUI.getState().setHover(null)}>
                  <span className="colour-bar" />
                  <div className="grow">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {happy ? <Smiley size={18} weight="fill" color="var(--mint)" /> : <SmileyMeh size={18} weight="fill" color="var(--amber)" />}
                      <LineBadge colour={l.colour} size="sm">{l.number}</LineBadge>
                      <span className="t">{l.name}</span>
                    </div>
                    <div className="s" style={{ marginTop: 6 }}>{n} buses · {l.stops.length} stops · every {Math.max(3, Math.round((l.length / 1000 / 15.5 * 60 + l.stops.length * 0.6) / Math.max(1, n)))} min</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                      <span className="faint" style={{ fontSize: 11, fontWeight: 700 }}>LOAD</span>
                      <div style={{ flex: 1 }}><LoadBar value={l.perf.load} /></div>
                      <span className="r" style={{ width: 34 }}>{pct(l.perf.load)}</span>
                    </div>
                    {l.perf.issue && <div className="amber" style={{ fontSize: 12, fontWeight: 700, marginTop: 7 }}>{l.perf.issue}</div>}
                  </div>
                  <div className="r" style={{ color: l.perf.profitPerDay >= 0 ? 'var(--mint)' : 'var(--coral)', fontSize: 13 }}>
                    {money(l.perf.profitPerDay, { sign: true })}
                    <div className="faint" style={{ fontSize: 11, fontWeight: 600, marginTop: 2 }}>per day</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
        {tab === 'stops' && (
          <div className="list">
            {stops.map((s) => (
              <button key={s.id} className={`lrow ${sel?.kind === 'stop' && sel.id === s.id ? 'on' : ''}`} onClick={() => { useUI.getState().select({ kind: 'stop', id: s.id }); focusStop(s.id); }}
                onMouseEnter={() => useUI.getState().setHover({ kind: 'stop', id: s.id })} onMouseLeave={() => useUI.getState().setHover(null)}>
                <div className="grow">
                  <div className="t">{s.name}</div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                    {s.lines.length ? s.lines.map((lid) => { const l = sim.line(lid)!; return <LineBadge key={lid} colour={l.colour} size="sm">{l.number}</LineBadge>; }) : <span className="s">Not served yet</span>}
                  </div>
                </div>
                <div className="r">{s.waiting}<div className="faint" style={{ fontSize: 11, fontWeight: 600 }}>waiting</div></div>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="p-foot">
        <button className="btn primary block" onClick={() => { useUI.getState().setTool('route'); useUI.getState().setDraft(newDraft()); }}>
          <Plus size={16} weight="bold" /> New bus line <kbd className="key" style={{ background: 'rgba(12,34,51,0.12)', color: 'var(--accent-ink)', boxShadow: 'none' }}>R</kbd>
        </button>
      </div>
    </>
  );
}

// ───────────────────────────────────────── fleet

function FleetPanel() {
  useTicker(2);
  const [tab, setTab] = useState<'vehicles' | 'buy' | 'depots'>('vehicles');
  const sel = useUI((s) => s.selection);
  const inService = sim.vehicles.filter((v) => v.status !== 'depot');
  const depot = sim.vehicles.filter((v) => v.status === 'depot');
  return (
    <>
      <Head title="Fleet" sub={`${sim.vehicles.length} vehicles · ${inService.length} in service · ${depot.length} in depot`} />
      <div className="p-body">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'vehicles', label: 'Vehicles' },
            { value: 'buy', label: 'Buy' },
            { value: 'depots', label: <>Depots <span className="soon-tag">Soon</span></>, disabled: true },
          ]}
        />
        {tab === 'vehicles' && (
          <>
            {depot.length > 0 && (
              <div className="section" style={{ paddingBottom: 6 }}>
                <div className="section-head" style={{ marginBottom: 4 }}>
                  <span className="label" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Warehouse size={14} weight="bold" /> Kasımpaşa depot</span>
                  <span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>{depot.length} waiting</span>
                </div>
                {depot.map((v) => (
                  <div className="row" key={v.id} style={{ minHeight: 40 }}>
                    <span style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontWeight: 700 }}>{v.fleetNo}</span>
                      <span className="faint" style={{ fontSize: 12, fontWeight: 500 }}>{v.model} · new</span>
                    </span>
                    <span style={{ display: 'flex', gap: 4 }}>
                      {sim.lines.map((l) => (
                        <button key={l.id} className="has-tip" onClick={() => assignDepotVehicle(l.id)}>
                          <LineBadge colour={l.colour} size="sm">{l.number}</LineBadge>
                          <Tip label={`Assign to line ${l.number}`} side="below" />
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="list">
              {inService.map((v) => {
                const l = sim.line(v.lineId);
                const cap = MODELS[v.model].capacity;
                const status = v.dwell > 0 ? 'boarding' : v.delayMin > 2 ? 'delayed' : '';
                return (
                  <button key={v.id} className={`lrow ${sel?.kind === 'vehicle' && sel.id === v.id ? 'on' : ''}`} onClick={() => { useUI.getState().select({ kind: 'vehicle', id: v.id }); focusVehicle(v.id); }}
                    onMouseEnter={() => useUI.getState().setHover({ kind: 'vehicle', id: v.id })} onMouseLeave={() => useUI.getState().setHover(null)}>
                    {l && <LineBadge colour={l.colour} size="sm">{l.number}</LineBadge>}
                    <div className="grow">
                      <div className="t">{v.fleetNo}</div>
                      <div className="s">{v.model} · {status === 'boarding' ? 'At stop' : status === 'delayed' ? `+${v.delayMin} min late` : 'On time'}</div>
                    </div>
                    <span className={`status-dot ${status}`} />
                    <div style={{ width: 84 }}>
                      <div className="r" style={{ marginBottom: 5 }}>{v.occupancy}<span className="faint">/{cap}</span></div>
                      <LoadBar value={v.occupancy / cap} marker={false} />
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {tab === 'buy' && (
          <div className="list" style={{ gap: 8 }}>
            {(Object.keys(MODELS) as VehicleModel[]).map((m) => <BuyCard key={m} model={m} />)}
          </div>
        )}
      </div>
    </>
  );
}

function BuyCard({ model }: { model: VehicleModel }) {
  const spec = MODELS[model];
  const label = model === 'Midi 9' ? 'Midibus' : model === 'Artic 18' ? 'Articulated bus' : 'Standard bus';
  const locked = false;
  return (
    <div className="section" style={{ padding: 14 }}>
      <div className="section-head" style={{ marginBottom: 2 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800 }}>{label}</div>
          <div className="faint" style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>{model} · {spec.length} m</div>
        </div>
        <div className="has-tip" style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          <Lightning size={13} weight="fill" color="var(--text-3)" />
          {[0, 1, 2, 3, 4].map((i) => <span key={i} style={{ width: 6, height: 12, borderRadius: 2, background: i < spec.speed ? 'var(--text)' : '#38433d' }} />)}
          <Tip label="Acceleration and top speed" side="left" />
        </div>
      </div>
      <div style={{ display: 'grid', placeItems: 'center', height: 108 }}>
        <BusArt model={model} width={290} />
      </div>
      <div className="grid3" style={{ marginBottom: 10 }}>
        <div><b style={{ fontSize: 15, fontWeight: 800 }}>{spec.capacity}</b><div className="faint" style={{ fontSize: 11, fontWeight: 600 }}>passengers</div></div>
        <div><b style={{ fontSize: 15, fontWeight: 800 }}>{spec.seats}</b><div className="faint" style={{ fontSize: 11, fontWeight: 600 }}>seats</div></div>
        <div><b style={{ fontSize: 15, fontWeight: 800 }}>₺{spec.costPerHour.toLocaleString('en-GB')}</b><div className="faint" style={{ fontSize: 11, fontWeight: 600 }}>per hour</div></div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="has-tip" style={{ display: 'flex', gap: 6 }}>
          {[BRAND, '#f4f2ec', '#3a4a52', '#2f9e9a'].map((c, i) => (
            <span key={c} style={{ width: 20, height: 20, borderRadius: 10, background: c, boxShadow: i === 0 ? '0 0 0 2px var(--card-raised), 0 0 0 4px #fff' : 'inset 0 0 0 1px rgba(255,255,255,0.15)', opacity: i === 0 ? 1 : 0.45 }} />
          ))}
          <Tip label="Company livery" hint="Custom liveries arrive in a later build" side="below" />
        </div>
        <button className="btn primary" style={{ flex: 1 }} disabled={locked || sim.funds < spec.price} onClick={() => buyVehicle(model)}>
          {locked ? <Lock size={15} weight="bold" /> : null} Buy · {money(spec.price)}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────── finance

const HISTORY = [41_200, 44_800, 39_500, 52_100, 47_300, 36_000, 48_900];

function FinancePanel() {
  useTicker(1);
  const [tab, setTab] = useState<'overview' | 'lines' | 'loans'>('overview');
  const result = sim.lines.reduce((s, l) => s + l.perf.profitPerDay, 0);
  const rows = [
    { k: 'Ticket sales', v: 178_470 },
    { k: 'Municipal subsidy · 12%', v: 21_400 },
    { k: 'Operating costs', v: -131_200 },
    { k: 'Maintenance', v: -19_770 },
  ];
  const max = Math.max(...HISTORY.map(Math.abs));
  return (
    <>
      <Head title="Finances" sub="Haliç Transit · prototype figures" />
      <div className="p-body">
        <div className="section" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="label">Account balance</div>
            <div className="mint num" style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.01em', marginTop: 4 }}>{money(sim.funds, { compact: false })}</div>
          </div>
          <button className="btn money has-tip" disabled>
            Take loan
            <Tip label="Loans" soon side="left" />
          </button>
        </div>
        <Segmented tone="money" value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'lines', label: 'By line' }, { value: 'loans', label: <>Loans <span className="soon-tag">Soon</span></>, disabled: true }]} />
        {tab === 'overview' && (
          <>
            <div className="section">
              <div className="section-head" style={{ marginBottom: 4 }}>
                <span style={{ fontWeight: 800, fontSize: 14 }}>Last 24 hours</span>
              </div>
              {rows.map((r) => (
                <div className="row" key={r.k}>
                  <span className="k">{r.k}</span>
                  <span className={`v ${r.v < 0 ? 'coral' : ''}`}>{money(r.v, { compact: false })}</span>
                </div>
              ))}
              <div className="row" style={{ marginTop: 8, padding: '10px 12px', borderRadius: 9, background: '#21362a' }}>
                <span style={{ fontWeight: 800, color: 'var(--mint)' }}>Operating result</span>
                <span className="v mint" style={{ fontSize: 15 }}>{money(result, { compact: false, sign: true })}</span>
              </div>
            </div>
            <div className="section">
              <div className="section-head">
                <span style={{ fontWeight: 800, fontSize: 14 }}>Daily result</span>
                <span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>last 7 days</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 92 }}>
                {HISTORY.map((v, i) => (
                  <div key={i} className="has-tip" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: '100%', height: (Math.abs(v) / max) * 64, borderRadius: 5, background: i === HISTORY.length - 1 ? 'var(--mint)' : '#3c5a48' }} />
                    <span className="faint" style={{ fontSize: 10.5, fontWeight: 700 }}>{['W', 'T', 'F', 'S', 'S', 'M', 'T'][i]}</span>
                    <Tip label={money(v, { sign: true })} side="below" />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        {tab === 'lines' && (
          <div className="list">
            {sim.lines.map((l) => (
              <button key={l.id} className="lrow" onClick={() => { useUI.getState().select({ kind: 'line', id: l.id }); focusLine(l.id); }}>
                <LineBadge colour={l.colour} size="sm">{l.number}</LineBadge>
                <div className="grow">
                  <div className="t">{l.name}</div>
                  <div className="s">{l.perf.ridersPerDay.toLocaleString('en-GB')} riders · ₺{l.fare} fare</div>
                </div>
                <div className="r" style={{ color: l.perf.profitPerDay >= 0 ? 'var(--mint)' : 'var(--coral)' }}>{money(l.perf.profitPerDay, { sign: true })}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
