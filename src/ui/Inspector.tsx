import { useEffect, useState } from 'react';
import { X, Crosshair, ArrowsLeftRight, Warehouse, MapPin, Users, Clock, Gauge, Wrench, Path, Plus, Warning, NavigationArrow, Smiley } from '@phosphor-icons/react';
import { sim, MODELS, type Vehicle } from '../sim/sim.ts';
import { useUI } from '../state/store.ts';
import { useTicker } from './hooks.ts';
import { LineBadge, LoadBar, Segmented, Tip, Kpi } from './primitives.tsx';
import { BusArt } from './BusArt.tsx';
import { money, pct, km } from './format.ts';
import { focusVehicle, focusLine, focusStop } from './camera.ts';
import { DESTINATIONS } from '../sim/destinations.ts';
import { distanceM } from '../sim/roadGraph.ts';
import { assignDepotVehicle } from '../sim/actions.ts';

function statusOf(v: Vehicle): { text: string; cls: string; pill: string } {
  if (v.status === 'depot') return { text: 'In depot', cls: 'depot', pill: '' };
  if (v.dwell > 0) return { text: 'At stop · boarding', cls: 'boarding', pill: 'info' };
  if (v.delayMin > 2) return { text: `Delayed +${v.delayMin} min`, cls: 'delayed', pill: 'warn' };
  return { text: 'Running on time', cls: '', pill: 'good' };
}

export function Inspector() {
  const selection = useUI((s) => s.selection);
  const draft = useUI((s) => s.draft);
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
  if (!shown) return null;
  const key = `${shown.kind}-${shown.id}`;
  return (
    <aside className={`card inspector ${closing ? 'closing' : ''} ${draft ? 'with-tray' : ''}`} key={key} aria-label="Inspector">
      {shown.kind === 'vehicle' && <VehicleInspector id={shown.id} />}
      {shown.kind === 'line' && <LineInspector id={shown.id} />}
      {shown.kind === 'stop' && <StopInspector id={shown.id} />}
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

// ───────────────────────────────────────────── vehicle

function VehicleInspector({ id }: { id: string }) {
  useTicker(5);
  const v = sim.vehicle(id);
  const following = useUI((s) => s.following);
  if (!v) return null;
  const line = sim.line(v.lineId);
  const spec = MODELS[v.model];
  const st = statusOf(v);
  const next = line ? sim.stops.get(line.stops[v.nextStop].stopId) : null;
  const dist = sim.distanceToNext(v);
  const etaMin = Math.max(1, Math.round(dist / 6.2 / 60 + (v.dwell > 0 ? v.dwell / 60 : 0)));
  const load = v.occupancy / spec.capacity;
  const isFollowing = following === v.id;
  return (
    <>
      <div className="p-head">
        {line && <LineBadge colour={line.colour} size="lg">{line.number}</LineBadge>}
        <div className="grow">
          <div className="p-title">Bus {v.fleetNo}</div>
          <div className="p-sub">{v.model} · {line ? line.name : 'Unassigned'}</div>
        </div>
        <Close />
      </div>
      <div className="p-body">
        <div className="illus">
          <BusArt model={v.model} line={line?.number} lineColour={line?.colour} width={300} />
        </div>
        <div className="row" style={{ padding: '2px 2px' }}>
          <span className={`pill ${st.pill}`}><span className={`status-dot ${st.cls}`} />{st.text}</span>
          <span className="v num muted">{Math.round(v.v * 3.6 * 0.82)} km/h</span>
        </div>
        <div className="section">
          <div className="row" style={{ minHeight: 0, marginBottom: 8 }}>
            <span className="k" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Users size={15} weight="bold" /> Occupancy</span>
            <span className="v num">{v.occupancy}<span className="faint"> / {spec.capacity}</span></span>
          </div>
          <LoadBar value={load} />
          <div className="row faint" style={{ fontSize: 12, marginTop: 6, minHeight: 0 }}>
            <span>{spec.seats} seats · {spec.capacity - spec.seats} standing</span>
            <span>{pct(load)} full</span>
          </div>
        </div>
        {line && next && (
          <div className="section">
            <div className="label" style={{ marginBottom: 6 }}>Next stop</div>
            <div className="row" style={{ minHeight: 0 }}>
              <button className="t" style={{ fontSize: 15, fontWeight: 800 }} onClick={() => { useUI.getState().select({ kind: 'stop', id: next.id }); focusStop(next.id); }}>{next.name}</button>
              <span className="v num">{v.dwell > 0 ? 'Boarding' : `${etaMin} min`}</span>
            </div>
            <div className="faint num" style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>{km(dist)} · {next.waiting} waiting</div>
            <LineProgress lineId={line.id} vehicle={v} />
          </div>
        )}
        <div className="grid3">
          <Kpi value={pct(v.condition)} label="Condition" tone={v.condition < 0.8 ? 'amber' : undefined} />
          <Kpi value={`${Math.round(v.odometerKm / 1000)}k`} label="km driven" />
          <Kpi value={`${v.ageYears} yr`} label="Age" />
        </div>
      </div>
      <div className="p-foot">
        <button className={`btn ${isFollowing ? 'primary' : ''}`} style={{ flex: 1 }} onClick={() => { useUI.getState().follow(isFollowing ? null : v.id); if (!isFollowing) focusVehicle(v.id); }}>
          <Crosshair size={16} weight="bold" /> {isFollowing ? 'Following' : 'Follow'} <kbd className="key">F</kbd>
        </button>
        <button className="btn has-tip" disabled aria-label="Reassign">
          <ArrowsLeftRight size={16} weight="bold" />
          <Tip label="Reassign to another line" soon side="below" />
        </button>
        <button className="btn has-tip" disabled aria-label="Send to depot">
          <Warehouse size={16} weight="bold" />
          <Tip label="Send to depot" soon side="below" />
        </button>
      </div>
    </>
  );
}

function LineProgress({ lineId, vehicle }: { lineId: string; vehicle: Vehicle }) {
  const line = sim.line(lineId)!;
  const n = line.stops.length;
  const d = ((vehicle.s % line.length) + line.length) % line.length;
  // Stops evenly spaced; the bus sits between its previous and next stop. The last segment loops home.
  const next = vehicle.nextStop;
  const prev = (next - 1 + n) % n;
  const a = line.stops[prev].distance;
  let b = line.stops[next].distance;
  if (b <= a) b += line.length;
  let dd = d;
  if (dd < a) dd += line.length;
  const f = Math.max(0, Math.min(1, (dd - a) / (b - a)));
  const slot = (i: number) => i / n;
  const pos = (prev + f) / n;
  const x = (t: number) => `calc(${t * 100}% - ${t * 12}px)`;
  return (
    <div style={{ position: 'relative', height: 30, marginTop: 12 }}>
      <div style={{ position: 'absolute', left: 6, right: 6, top: 13, height: 4, borderRadius: 2, background: '#334039' }} />
      <div style={{ position: 'absolute', left: 6, width: x(pos), top: 13, height: 4, borderRadius: 2, background: line.colour, transition: 'width 300ms linear' }} />
      {line.stops.map((s, i) => {
        const passed = i <= prev;
        return (
          <div key={i} className="has-tip" style={{ position: 'absolute', left: x(slot(i)), top: 9, width: 12, height: 12, borderRadius: 6, background: passed ? line.colour : '#202823', boxShadow: `inset 0 0 0 2.5px ${line.colour}` }}>
            <Tip label={sim.stops.get(s.stopId)!.name} side="below" />
          </div>
        );
      })}
      <div className="has-tip" style={{ position: 'absolute', left: x(1), top: 9, width: 12, height: 12, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--text-3)' }}>
        <ArrowsLeftRight size={11} weight="bold" />
        <Tip label="Loops back to the first stop" side="below" />
      </div>
      <div style={{ position: 'absolute', left: `calc(${pos * 100}% - ${pos * 12}px - 3px)`, top: 4, width: 18, height: 22, display: 'grid', placeItems: 'center', transition: 'left 300ms linear' }}>
        <NavigationArrow size={15} weight="fill" color="#fff" style={{ transform: 'rotate(90deg)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.5))' }} />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── line

function LineInspector({ id }: { id: string }) {
  useTicker(2);
  const [tab, setTab] = useState<'overview' | 'stops' | 'vehicles'>('overview');
  const line = sim.line(id);
  if (!line) return null;
  const vehicles = sim.vehicles.filter((v) => v.lineId === id);
  const roundTrip = Math.round(line.length / 1000 / 15.5 * 60 + line.stops.length * 0.6);
  const headway = Math.max(3, Math.round(roundTrip / Math.max(1, vehicles.length)));
  const p = line.perf;
  const depot = sim.vehicles.filter((v) => v.status === 'depot').length;
  return (
    <>
      <div className="p-head">
        <LineBadge colour={line.colour} size="lg">{line.number}</LineBadge>
        <div className="grow">
          <div className="p-title">{line.name}</div>
          <div className="p-sub">{line.stops.length} stops · {km(line.length)} loop · {vehicles.length} buses</div>
        </div>
        <Close />
      </div>
      <div className="p-body">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'stops', label: 'Stops' },
            { value: 'vehicles', label: 'Vehicles' },
          ]}
        />
        {tab === 'overview' && (
          <>
            <div className="grid2">
              <Kpi value={money(p.profitPerDay, { sign: true })} label="Profit / day" tone={p.profitPerDay >= 0 ? 'mint' : 'coral'} />
              <Kpi value={p.ridersPerDay.toLocaleString('en-GB')} label="Riders / day" />
            </div>
            <div className="section">
              <div className="row" style={{ minHeight: 0, marginBottom: 8 }}>
                <span className="k">Average load</span>
                <span className="v">{pct(p.load)}</span>
              </div>
              <LoadBar value={p.load} />
              <div className="row" style={{ marginTop: 10 }}>
                <span className="k">On time</span>
                <span className="v" style={{ color: p.onTime > 0.88 ? 'var(--mint)' : 'var(--amber)' }}>{pct(p.onTime)}</span>
              </div>
              <div className="row">
                <span className="k">Satisfaction</span>
                <span className="v" style={{ display: 'flex', gap: 6, alignItems: 'center', color: p.satisfaction > 0.75 ? 'var(--mint)' : 'var(--amber)' }}>
                  <Smiley size={16} weight="fill" /> {pct(p.satisfaction)}
                </span>
              </div>
            </div>
            <div className="section">
              <div className="row"><span className="k" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Clock size={15} weight="bold" /> Service</span><span className="v">{line.service[0]}–{line.service[1]}</span></div>
              <div className="row"><span className="k">Frequency</span><span className="v">every {headway} min</span></div>
              <div className="row"><span className="k">Round trip</span><span className="v">{roundTrip} min</span></div>
              <div className="row"><span className="k">Fare</span><span className="v">₺{line.fare}</span></div>
            </div>
            {p.issue && (
              <div className="issue">
                <Warning size={16} weight="fill" />
                <span>{p.issue}</span>
              </div>
            )}
          </>
        )}
        {tab === 'stops' && (
          <div className="section diagram" style={{ ['--c' as string]: line.colour }}>
            {line.stops.map((ls, i) => {
              const s = sim.stops.get(ls.stopId)!;
              return (
                <div className="dstop" key={i}>
                  <button className="link grow" onClick={() => { useUI.getState().select({ kind: 'stop', id: s.id }); focusStop(s.id); }}>{s.name}</button>
                  <span className="meta">{s.waiting} waiting</span>
                </div>
              );
            })}
          </div>
        )}
        {tab === 'vehicles' && (
          <div className="list">
            {vehicles.map((v) => {
              const st = statusOf(v);
              const next = sim.stops.get(line.stops[v.nextStop].stopId);
              return (
                <button className="lrow" key={v.id} onClick={() => { useUI.getState().select({ kind: 'vehicle', id: v.id }); focusVehicle(v.id); }}>
                  <span className={`status-dot ${st.cls}`} />
                  <div className="grow">
                    <div className="t">{v.fleetNo} <span className="faint" style={{ fontWeight: 600 }}>· {v.model}</span></div>
                    <div className="s">→ {next?.name}</div>
                  </div>
                  <div style={{ width: 70 }}>
                    <div className="r" style={{ marginBottom: 5 }}>{v.occupancy}/{MODELS[v.model].capacity}</div>
                    <LoadBar value={v.occupancy / MODELS[v.model].capacity} marker={false} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="p-foot">
        <button className="btn" style={{ flex: 1 }} disabled={depot === 0} onClick={() => assignDepotVehicle(line.id)}>
          <Plus size={16} weight="bold" /> Add bus <span className="faint" style={{ fontWeight: 600 }}>({depot} in depot)</span>
        </button>
        <button className="btn has-tip" onClick={() => focusLine(line.id)} aria-label="Show whole line">
          <Path size={16} weight="bold" />
          <Tip label="Fit line in view" side="below" />
        </button>
        <button className="btn has-tip" disabled aria-label="Timetable">
          <Wrench size={16} weight="bold" />
          <Tip label="Edit timetable" soon side="below" />
        </button>
      </div>
    </>
  );
}

// ───────────────────────────────────────────── stop

function StopInspector({ id }: { id: string }) {
  useTicker(2);
  const stop = sim.stops.get(id);
  if (!stop) return null;
  const arrivals: { v: Vehicle; min: number }[] = [];
  for (const v of sim.vehicles) {
    const line = sim.line(v.lineId);
    if (!line || !stop.lines.includes(line.id)) continue;
    const ls = line.stops.find((s) => s.stopId === id);
    if (!ls) continue;
    const d = ((v.s % line.length) + line.length) % line.length;
    let to = ls.distance - d;
    if (to < 0) to += line.length;
    arrivals.push({ v, min: Math.max(0, Math.round(to / 6.2 / 60)) });
  }
  arrivals.sort((a, b) => a.min - b.min);
  const nearby = DESTINATIONS.map((d) => ({ d, m: distanceM(d.lngLat, stop.lngLat) })).filter((x) => x.m < 520).sort((a, b) => a.m - b.m).slice(0, 3);
  const demandTone = stop.demand === 'high' ? 'mint' : stop.demand === 'medium' ? undefined : 'amber';
  return (
    <>
      <div className="p-head">
        <div style={{ width: 34, height: 34, borderRadius: 17, background: '#fff', display: 'grid', placeItems: 'center', flex: 'none' }}>
          <MapPin size={18} weight="fill" color="#2a5d45" />
        </div>
        <div className="grow">
          <div className="p-title">{stop.name}</div>
          <div className="p-sub">{stop.lines.length ? `Bus stop · ${stop.lines.length} line${stop.lines.length > 1 ? 's' : ''}` : 'New stop · no lines yet'}</div>
        </div>
        <Close />
      </div>
      <div className="p-body">
        {stop.lines.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 2px' }}>
            {stop.lines.map((lid) => {
              const l = sim.line(lid)!;
              return (
                <button key={lid} onClick={() => { useUI.getState().select({ kind: 'line', id: lid }); }} className="has-tip" style={{ display: 'flex' }}>
                  <LineBadge colour={l.colour}>{l.number}</LineBadge>
                  <Tip label={l.name} side="below" />
                </button>
              );
            })}
          </div>
        )}
        <div className="grid3">
          <Kpi value={stop.waiting} label="Waiting now" />
          <Kpi value={stop.demand[0].toUpperCase() + stop.demand.slice(1)} label="Demand" tone={demandTone} />
          <Kpi value={`${stop.catchmentM} m`} label="Catchment" />
        </div>
        {arrivals.length > 0 && (
          <div className="section">
            <div className="label" style={{ marginBottom: 6 }}>Next arrivals</div>
            {arrivals.slice(0, 4).map(({ v, min }) => {
              const l = sim.line(v.lineId)!;
              return (
                <button className="row" key={v.id} style={{ width: '100%' }} onClick={() => { useUI.getState().select({ kind: 'vehicle', id: v.id }); focusVehicle(v.id); }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <LineBadge colour={l.colour} size="sm">{l.number}</LineBadge>
                    <span className="k">{v.fleetNo}</span>
                  </span>
                  <span className="v num">{min === 0 ? 'Now' : `${min} min`}</span>
                </button>
              );
            })}
          </div>
        )}
        {nearby.length > 0 && (
          <div className="section">
            <div className="label" style={{ marginBottom: 6 }}>Destinations in reach</div>
            {nearby.map(({ d, m }) => (
              <div className="row" key={d.id}>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: d.colour }} />
                  {d.name}
                </span>
                <span className="k num">{Math.round(m / 80)} min walk</span>
              </div>
            ))}
          </div>
        )}
        {stop.lines.length === 0 && (
          <div className="issue" style={{ background: 'var(--accent-soft)', color: '#8cc6ef' }}>
            <Gauge size={16} weight="bold" />
            <span>No line serves this stop yet. Use <b>Create route</b> (R) to connect it.</span>
          </div>
        )}
      </div>
    </>
  );
}
