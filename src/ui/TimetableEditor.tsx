import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, X, Warning, ArrowsInLineHorizontal, Trash, Copy } from '@phosphor-icons/react';
import { useGameUpdates } from './hooks.ts';
import { useUI } from '../state/store.ts';
import { LineBadge, Segmented } from './primitives.tsx';
import { minutesLabel } from '../game/time.ts';
import { departures, normaliseBands, requirement, sustainableHeadway } from '../game/timetable.ts';
import { ECON } from '../game/content.ts';
import type { Band, Timetable } from '../game/types.ts';
import { MAX, MIN, STEP, PRESETS, addBandAt, applyPreset, raiseHeadways, setBandTimes, splitBand } from './timetableLogic.ts';
import '../styles/timetable.css';

const SPAN = MAX - MIN;
const pct = (m: number) => ((m - MIN) / SPAN) * 100;
const CHIPS = [5, 7, 10, 12, 15, 20, 30];
const clone = (t: Timetable): Timetable => JSON.parse(JSON.stringify(t));

function Stepper({ label, value, text, onDec, onInc, decDisabled, incDisabled }: { label: string; value?: number; text: string; onDec: () => void; onInc: () => void; decDisabled?: boolean; incDisabled?: boolean }) {
  void value;
  return (
    <div className="tt-stepper" role="group" aria-label={label}>
      <button className="icon-btn" aria-label={`Decrease ${label}`} onClick={onDec} disabled={decDisabled}><Minus size={14} weight="bold" /></button>
      <output aria-live="polite">{text}</output>
      <button className="icon-btn" aria-label={`Increase ${label}`} onClick={onInc} disabled={incDisabled}><Plus size={14} weight="bold" /></button>
    </div>
  );
}

export function TimetableEditor({ routeId, onClose }: { routeId: string; onClose: () => void }) {
  const game = useGameUpdates(2);
  const route = game?.state.routes[routeId];
  const initial = useRef<Timetable | null>(null);
  const [draft, setDraft] = useState<Timetable | null>(() => (route ? clone(route.timetable) : null));
  if (route && !initial.current) initial.current = clone(route.timetable);
  const [day, setDay] = useState<'weekday' | 'weekend'>('weekday');
  const [sel, setSel] = useState<number>(-1);
  const [error, setError] = useState('');
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onClose]);

  const weekend = day === 'weekend';
  const bands = draft?.[day].bands ?? [];
  const profiles = game && route ? game.profiles.get(routeId) ?? [] : [];
  const assigned = route?.vehicles.length ?? 0;
  const req = useMemo(
    () => (route && draft && profiles.length ? requirement({ ...route, timetable: draft }, profiles, weekend) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, profiles.length, weekend, route?.id],
  );

  if (!route || !draft || !game) return null;

  const setBands = (b: Band[]) => setDraft({ ...draft, [day]: { bands: b } });
  const selected = bands[sel];
  const dirty = JSON.stringify({ ...draft, weekday: { bands: normaliseBands(draft.weekday.bands) }, weekend: { bands: normaliseBands(draft.weekend.bands) } }) !== JSON.stringify(initial.current);
  const patch = (p: Partial<Band>) => setBands(bands.map((b, i) => (i === sel ? { ...b, ...p } : b)));

  const onTrackClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.tt-band')) return;
    const r = trackRef.current!.getBoundingClientRect();
    const m = MIN + ((e.clientX - r.left) / r.width) * SPAN;
    const res = addBandAt(bands, m);
    setBands(res.bands);
    setSel(res.index);
  };

  const drag = (i: number, edge: 'from' | 'to') => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const el = trackRef.current!;
    const w = el.getBoundingClientRect();
    const start = bands;
    setSel(i);
    const move = (ev: PointerEvent) => {
      const raw = MIN + ((ev.clientX - w.left) / w.width) * SPAN;
      const m = Math.round(raw / STEP) * STEP;
      const b = start[i];
      setDraft((d) => (d ? { ...d, [day]: { bands: edge === 'from' ? setBandTimes(start, i, m, b.to) : setBandTimes(start, i, b.from, m) } } : d));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const fit = () => {
    const h = sustainableHeadway(profiles, draft.layover, assigned, weekend);
    if (h) setBands(raiseHeadways(bands, h));
  };

  const save = () => {
    const res = game.setTimetable(routeId, draft);
    if (!res.ok) { setError(res.error); return; }
    useUI.getState().notify(`Timetable for line ${route.number} updated`, 'good');
    onClose();
  };

  const norm = normaliseBands(bands);
  const deps = departures({ bands: norm });
  const first = norm[0], last = norm[norm.length - 1];
  const cost = req ? req.bands.reduce((s, r) => s + r.need * ((r.band.to - r.band.from) / 60), 0) * ECON.driverPerHour : 0;
  const short = req ? req.bands.filter((r) => r.need > assigned) : [];
  const maxNeed = Math.max(assigned, ...(req?.bands.map((r) => r.need) ?? [1]), 1);
  const ticks = Array.from({ length: SPAN / 60 + 1 }, (_, i) => MIN + i * 60);

  return (
    <div className="tt-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card tt-dialog" role="dialog" aria-modal="true" aria-label={`Timetable for line ${route.number}`}>
        <div className="p-head">
          <LineBadge colour={route.colour} size="lg">{route.number}</LineBadge>
          <div className="grow">
            <div className="p-title">Timetable</div>
            <div className="p-sub">{route.name}</div>
          </div>
          <button className="close-btn" aria-label="Close timetable editor" onClick={onClose}><X size={16} weight="bold" /></button>
        </div>

        <div className="p-body tt-body">
          <div className="tt-toolbar">
            <Segmented options={[{ value: 'weekday', label: 'Weekday' }, { value: 'weekend', label: 'Weekend' }]} value={day} onChange={(v) => { setDay(v); setSel(-1); }} />
            <button className="btn sm" onClick={() => setDraft({ ...draft, weekend: clone({ ...draft, weekend: draft.weekday }).weekend })} title="Replace the weekend plan with the weekday plan">
              <Copy size={14} /> Copy weekday to weekend
            </button>
          </div>

          <div className="section">
            <div className="tt-axis" aria-hidden>
              {ticks.filter((_, i) => i % 3 === 0).map((m) => <span key={m} style={{ left: `${pct(m)}%` }}>{minutesLabel(m)}</span>)}
            </div>
            <div className="tt-track" ref={trackRef} onClick={onTrackClick} role="group" aria-label="Service timeline. Click a gap to add a band.">
              {ticks.map((m, i) => <i key={m} className={`tt-tick ${i % 3 === 0 ? 'major' : ''}`} style={{ left: `${pct(m)}%` }} />)}
              {bands.map((b, i) => {
                const h = 30 + 70 * Math.max(0, 1 - (b.headway - 2) / 40);
                return (
                  <div key={i} className={`tt-band ${i === sel ? 'sel' : ''}`} style={{ left: `${pct(b.from)}%`, width: `${pct(b.to) - pct(b.from)}%`, ['--c' as string]: route.colour, ['--h' as string]: `${h}%` }}>
                    <button className="tt-body-btn" aria-label={`Band ${minutesLabel(b.from)} to ${minutesLabel(b.to)}, every ${b.headway} minutes`} aria-pressed={i === sel} onClick={() => setSel(i)}>
                      <span className="tt-fill" />
                      <span className="tt-lbl">{b.headway}′</span>
                    </button>
                    <span className="tt-handle l" onPointerDown={drag(i, 'from')} />
                    <span className="tt-handle r" onPointerDown={drag(i, 'to')} />
                  </div>
                );
              })}
              {!bands.length && <div className="tt-empty">No service. Click to add a band, or pick a preset.</div>}
            </div>
            <div className="tt-hint faint">Click a gap to add a band. Drag band edges to resize (15 min steps). Taller block = more frequent.</div>
          </div>

          <div className="tt-cols">
            <div className="section">
              <div className="section-head"><span className="label">Selected band</span></div>
              {selected ? (
                <div className="tt-edit">
                  <div className="row"><span className="k">Starts</span>
                    <Stepper label="start time" text={minutesLabel(selected.from)} onDec={() => setBands(setBandTimes(bands, sel, selected.from - STEP, selected.to))} onInc={() => setBands(setBandTimes(bands, sel, selected.from + STEP, selected.to))} /></div>
                  <div className="row"><span className="k">Ends</span>
                    <Stepper label="end time" text={minutesLabel(selected.to)} onDec={() => setBands(setBandTimes(bands, sel, selected.from, selected.to - STEP))} onInc={() => setBands(setBandTimes(bands, sel, selected.from, selected.to + STEP))} /></div>
                  <div className="row"><span className="k">Every</span>
                    <Stepper label="headway" text={`${selected.headway} min`} decDisabled={selected.headway <= 2} incDisabled={selected.headway >= 120} onDec={() => patch({ headway: selected.headway - 1 })} onInc={() => patch({ headway: selected.headway + 1 })} /></div>
                  <div className="tt-chips">
                    {CHIPS.map((c) => <button key={c} className={`pill ${selected.headway === c ? 'info' : ''}`} onClick={() => patch({ headway: c })} aria-label={`Every ${c} minutes`}>{c}</button>)}
                  </div>
                  <div className="tt-actions">
                    <button className="btn sm" onClick={() => setBands(splitBand(bands, sel))}><ArrowsInLineHorizontal size={14} /> Split band</button>
                    <button className="btn sm" onClick={() => { setBands(bands.filter((_, i) => i !== sel)); setSel(-1); }}><Trash size={14} /> Delete band</button>
                  </div>
                </div>
              ) : <div className="faint tt-none">Select a band on the timeline to edit it.</div>}
            </div>

            <div className="section">
              <div className="section-head"><span className="label">Presets ({weekend ? 'weekend' : 'weekday'})</span></div>
              <div className="tt-presets">
                {PRESETS.map((p) => (
                  <button key={p.id} className="btn sm" onClick={() => { setBands(applyPreset(bands, p.id)); setSel(-1); }}>
                    <b>{p.label}</b><small>{p.hint}</small>
                  </button>
                ))}
              </div>
              <div className="row" style={{ marginTop: 10 }}><span className="k">Layover at each end</span>
                <Stepper label="layover" text={`${draft.layover} min`} decDisabled={draft.layover <= 1} incDisabled={draft.layover >= 30} onDec={() => setDraft({ ...draft, layover: draft.layover - 1 })} onInc={() => setDraft({ ...draft, layover: draft.layover + 1 })} /></div>
            </div>
          </div>

          <div className="section">
            <div className="section-head"><span className="label">Fleet requirement</span>
              <span className="pill">{assigned} assigned</span></div>
            {!req ? (
              <div className="faint">{bands.length ? 'This line has no valid run times yet, so the fleet needed cannot be worked out.' : 'No service planned.'}</div>
            ) : (
              <>
                {short.length > 0 ? (
                  <div className="tt-warn" role="alert"><Warning size={16} weight="fill" />
                    <span>Line {route.number} needs {Math.max(...short.map((s) => s.need))} buses between {minutesLabel(short.reduce((a, b) => (b.need > a.need ? b : a)).band.from)}–{minutesLabel(short.reduce((a, b) => (b.need > a.need ? b : a)).band.to)}. Only {assigned} {assigned === 1 ? 'is' : 'are'} assigned. Departures will be missed.</span>
                  </div>
                ) : <div className="pill good">Your {assigned} buses cover this timetable (peak need {req.peak}).</div>}
                <div className="tt-bars">
                  {req.bands.map((r, i) => (
                    <div key={i} className="tt-barrow">
                      <span className="t">{minutesLabel(r.band.from)}–{minutesLabel(r.band.to)}</span>
                      <div className="bar"><i className={r.need > assigned ? 'bad' : ''} style={{ width: `${(r.need / maxNeed) * 100}%` }} /><em style={{ left: `${(assigned / maxNeed) * 100}%` }} title="Buses assigned" /></div>
                      <span className={`n ${r.need > assigned ? 'coral' : ''}`}>{r.need}</span>
                    </div>
                  ))}
                </div>
                {short.length > 0 && assigned > 0 && (
                  <button className="btn sm" onClick={fit}>Fit to my buses</button>
                )}
                <div className="tt-stats">
                  <div className="row"><span className="k">Round trip (worst band)</span><span className="v">{Math.round(Math.max(0, ...req.bands.map((r) => r.cycle)))} min</span></div>
                  <div className="row"><span className="k">Departures per day</span><span className="v">{deps.length}</span></div>
                  <div className="row"><span className="k">First / last bus</span><span className="v">{first ? `${minutesLabel(first.from)} / ${minutesLabel(Math.max(first.from, last.to - last.headway))}` : '—'}</span></div>
                  <div className="row"><span className="k">Driver cost (estimate)</span><span className="v">~{game.money(cost)} / day</span></div>
                </div>
              </>
            )}
          </div>
          {error && <div className="tt-warn" role="alert"><Warning size={16} weight="fill" /><span>{error}</span></div>}
        </div>

        <div className="p-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" style={{ flex: 1 }} disabled={!dirty} onClick={save}>Save timetable</button>
        </div>
      </div>
    </div>
  );
}
