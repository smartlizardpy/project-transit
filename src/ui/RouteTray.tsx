import { ArrowCounterClockwise, ArrowClockwise, Trash, Check, X, CursorClick, Info, ArrowUp, ArrowDown, Warning, Path, MapPin } from '@phosphor-icons/react';
import { useUI } from '../state/store.ts';
import { Tip, Segmented } from './primitives.tsx';
import { useGameRev } from './hooks.ts';
import { LINE_COLOURS, ECON } from '../game/content.ts';
import { activeSeq, commitDraft, moveStop, removeStopAt, useDraftPreview } from './routeDraft.ts';
import { focusStop } from './camera.ts';
import { DiagnosticButton } from './RouteCheck.tsx';

const km = (k: number) => (k ? `${k.toFixed(1)} km` : '–');

export function RouteTray() {
  const game = useGameRev();
  const draft = useUI((s) => s.draft);
  const tool = useUI((s) => s.tool);
  const preview = useDraftPreview((s) => s.preview);
  const edit = useUI((s) => s.editDraft);
  const setDraft = useUI((s) => s.setDraft);
  if (!draft || tool !== 'route' || !game) return null;
  const seq = activeSeq(draft);
  const n = draft.stops.length;
  const valid = !!preview && n >= 2 && preview.problems.length === 0 && preview.patterns.length > 0 && preview.patterns.every((p) => p.valid);
  const totalMin = preview?.minutes.reduce((a, b) => a + b, 0) ?? 0;
  const cycle = totalMin + (preview?.minutes.length ?? 0) * 4;
  const buses10 = valid ? Math.max(1, Math.ceil(cycle / 10)) : 0;
  const hint =
    n === 0
      ? 'Click a stop spot (the round markers on the streets) or one of your stops to start the line.'
      : n === 1
        ? 'Click the next stop. The line follows real streets and one-way rules.'
        : draft.kind === 'loop'
          ? 'Keep adding stops in order; the loop returns to stop 1. Shift-click the line to force it along a street.'
          : 'Keep adding stops in order. Buses come back the same way unless you set a custom return. Shift-click the line to force it along a street.';
  const editing = draft.editing ? game.state.routes[draft.editing] : null;
  const changed = !editing || JSON.stringify([editing.stops, editing.returnStops, editing.kind, editing.via, editing.number, editing.name, editing.colour]) !== JSON.stringify([draft.stops, draft.kind === 'linear' ? draft.returnStops : null, draft.kind, draft.via, draft.number, draft.name, draft.colour]);
  const affordable = !!editing || game.state.finance.balance >= ECON.routeFee;
  const vias = Object.values(draft.via).reduce((a, v) => a + v.length, 0);
  // route warnings as diagnostics: each opens a route check on the draft (fixes go through the draft's undo)
  const diags = preview && n >= 2 ? preview.patterns.flatMap((p) => p.diagnostics ?? []).filter((d) => d.kind === 'detour' || d.kind === 'contraflow') : [];
  return (
    <>
      <div className="card route-side" role="region" aria-label="Line stops">
        <div className="rs-head">
          <div className="rs-title">{editing ? `Editing line ${editing.number}` : 'New line'}</div>
          <Segmented
            options={[
              { value: 'linear', label: 'Two-way' },
              { value: 'loop', label: 'Loop' },
            ]}
            value={draft.kind}
            onChange={(k) => edit(() => ({ kind: k, editingReturn: false }))}
          />
        </div>
        <div className="colour-pick rs-colours" role="radiogroup" aria-label="Line colour">
          {LINE_COLOURS.map((c) => (
            <button key={c} role="radio" aria-checked={c === draft.colour} className={c === draft.colour ? 'on' : ''} style={{ ['--c' as string]: c }} onClick={() => setDraft({ ...draft, colour: c })} aria-label={`Colour ${c}`} />
          ))}
        </div>
        {draft.kind === 'linear' && n >= 2 && (
          <div className="rs-dir">
            <Segmented
              options={[
                { value: 'out', label: 'Outbound' },
                { value: 'ret', label: 'Return' },
              ]}
              value={draft.editingReturn ? 'ret' : 'out'}
              onChange={(v) => edit((d) => (v === 'ret' ? { editingReturn: true, returnStops: d.returnStops ?? [...d.stops].reverse() } : { editingReturn: false }))}
            />
            {draft.editingReturn && (
              <button className="link" onClick={() => edit(() => ({ returnStops: null, editingReturn: false, via: Object.fromEntries(Object.entries(draft.via).filter(([k]) => !k.startsWith('r:'))) }))}>
                Use outbound stops reversed
              </button>
            )}
          </div>
        )}
        <ol className="rs-list" style={{ ['--c' as string]: draft.colour }}>
          {seq.map((id, i) => {
            const s = game.state.stops[id];
            return (
              <li key={`${id}-${i}`}>
                <span className="rs-num">{i + 1}</span>
                <button className="t grow" onClick={() => focusStop(id)}>{s?.name ?? 'Removed stop'}</button>
                <button className="icon-btn sm" disabled={i === 0} onClick={() => { const p = moveStop(draft, i, -1); if (p) edit(() => p); }} aria-label="Move up"><ArrowUp size={12} weight="bold" /></button>
                <button className="icon-btn sm" disabled={i === seq.length - 1} onClick={() => { const p = moveStop(draft, i, 1); if (p) edit(() => p); }} aria-label="Move down"><ArrowDown size={12} weight="bold" /></button>
                <button className="icon-btn sm" onClick={() => edit((d) => removeStopAt(d, i))} aria-label="Remove stop"><X size={12} weight="bold" /></button>
              </li>
            );
          })}
          {draft.kind === 'loop' && seq.length >= 3 && (
            <li className="rs-back"><span className="rs-num">↺</span><span className="faint">back to {game.state.stops[seq[0]]?.name}</span></li>
          )}
          {!seq.length && <li className="rs-empty"><MapPin size={14} weight="bold" /> No stops yet</li>}
        </ol>
        {vias > 0 && (
          <div className="rs-via">
            <Path size={13} weight="bold" /> {vias} forced street{vias > 1 ? 's' : ''}
            <button className="link" onClick={() => edit(() => ({ via: {} }))}>Clear</button>
          </div>
        )}
        {preview && n >= 2 && (preview.problems.length > 0 || diags.length > 0) && (
          <div className="rs-issues">
            {preview.problems.map((p) => <div key={p} className="issue bad"><Warning size={14} weight="fill" />{p}</div>)}
            {diags.slice(0, 3).map((d) => <DiagnosticButton key={d.id} d={d} size={14} onOpen={() => useUI.getState().openRouteCheck({ route: null, pat: d.pat ?? 0, leg: d.leg ?? 0 })} />)}
          </div>
        )}
      </div>
      <div className="card tray" role="region" aria-label="Line editor">
        <label className="swatch" style={{ ['--c' as string]: draft.colour }} title="Line number">
          <input value={draft.number} maxLength={4} onChange={(e) => setDraft({ ...draft, number: e.target.value.replace(/\s/g, '') })} aria-label="Line number" />
        </label>
        <div className="tray-coach" role="status">
          {n === 0 ? <CursorClick size={14} weight="bold" /> : <Info size={14} weight="bold" />} <span>{hint}</span>
        </div>
        <div className="tray-main">
          <input className="tray-name" placeholder={`Line ${draft.number} name (optional)`} value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Line name" />
          <span className="tray-sub">{editing ? `Editing line ${editing.number}` : draft.kind === 'loop' ? 'New loop line' : 'New two-way line'}</span>
        </div>
        <div className="tray-stats">
          <div className="tstat"><b>{n}</b><span>Stops</span></div>
          <div className="tstat"><b>{valid ? preview!.lengths.map(km).join(' / ') : '–'}</b><span>{draft.kind === 'loop' ? 'Loop length' : 'Outbound / return'}</span></div>
          <div className="tstat" title="Driving time with traffic at the current hour, plus a short layover at each end"><b>{valid ? `${Math.round(cycle)} min` : '–'}</b><span>Round trip</span></div>
          <div className="tstat opt"><b>{valid ? buses10 : '–'}</b><span>Buses for a 10-min service</span></div>
        </div>
        <div className="tray-actions">
          <button className="icon-btn has-tip" onClick={() => useUI.getState().undoDraft()} disabled={!draft.history.length} aria-label="Undo">
            <ArrowCounterClockwise size={17} weight="bold" />
            <Tip label="Undo" k="⌘Z" hint="Right-click on the map also undoes" side="below" />
          </button>
          <button className="icon-btn has-tip" onClick={() => useUI.getState().redoDraft()} disabled={!draft.future.length} aria-label="Redo">
            <ArrowClockwise size={17} weight="bold" />
            <Tip label="Redo" k="⇧⌘Z" side="below" />
          </button>
          <button className="icon-btn has-tip" onClick={() => edit(() => ({ stops: [], returnStops: null, via: {}, editingReturn: false }))} disabled={!n} aria-label="Clear">
            <Trash size={17} weight="bold" />
            <Tip label="Clear all stops" side="below" />
          </button>
          <button className="btn sm" onClick={() => useUI.getState().setTool('select')}>
            <X size={14} weight="bold" /> Cancel
          </button>
          <button className="btn sm primary has-tip" disabled={!valid || !changed || !affordable} onClick={commitDraft}>
            <Check size={14} weight="bold" /> {editing ? 'Save changes' : `Register line · ${game.money(ECON.routeFee, { compact: true })}`}
            {!affordable && <Tip label="Not enough funds" side="below" />}
          </button>
        </div>
      </div>
    </>
  );
}
