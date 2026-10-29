import { ArrowCounterClockwise, ArrowClockwise, Trash, Check, X, CursorClick, Info } from '@phosphor-icons/react';
import { useUI } from '../state/store.ts';
import { Tip } from './primitives.tsx';
import { km } from './format.ts';
import { DRAFT_COLOURS, createLine, assignDepotVehicle, nextLineNumber } from '../sim/actions.ts';
import type { RouteDraft } from '../state/store.ts';
import { draftLoop } from '../sim/routeEditor.ts';
import { sim } from '../sim/sim.ts';
import { focusLine } from './camera.ts';

export function RouteTray() {
  const draft = useUI((s) => s.draft);
  const setDraft = useUI((s) => s.setDraft);
  const tool = useUI((s) => s.tool);
  if (!draft || tool !== 'route') return null;
  const n = draft.stops.length;
  const loop = n >= 2 ? draftLoop(draft.stops.map((s) => s.node)) : null;
  const len = loop?.length ?? 0;
  const roundTrip = Math.round((len / 1000 / 15.5) * 60 + n * 0.6);
  const buses = Math.max(1, Math.ceil(roundTrip / 10));
  const hint =
    n === 0 ? 'Click an existing bus stop (white dot) to start' : n === 1 ? 'Click the next stop; the path follows real streets' : 'Add more stops or create the line; it loops back to stop 1';
  const undo = () => {
    if (!draft.stops.length) return;
    setDraft({ ...draft, stops: draft.stops.slice(0, -1), history: [...draft.history, draft.stops], future: [] });
  };
  const redo = () => {
    const next = draft.future[draft.future.length - 1];
    if (!next) return;
    setDraft({ ...draft, stops: next, history: [...draft.history, draft.stops], future: draft.future.slice(0, -1) });
  };
  const create = () => {
    if (!loop) return;
    const line = createLine({ number: draft.number, colour: draft.colour, stops: draft.stops, path: loop.path, stopDistances: loop.stopDistances });
    useUI.getState().setDraft(null);
    useUI.getState().setTool('select');
    useUI.getState().select({ kind: 'line', id: line.id });
    const depot = sim.vehicles.filter((v) => v.status === 'depot').length;
    for (let i = 0; i < Math.min(2, depot); i++) assignDepotVehicle(line.id);
    useUI.getState().notify(`Line ${line.number} created · ${km(line.length)} · ${Math.min(2, depot)} buses assigned`, 'good');
    focusLine(line.id);
  };
  return (
    <div className="card tray" role="region" aria-label="Route editor">
      <div className="swatch" style={{ ['--c' as string]: draft.colour }}>{draft.number}</div>
      <div className="tray-main">
        <div className="tray-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          New line {draft.number}
          <div className="colour-pick">
            {DRAFT_COLOURS.map((c) => (
              <button key={c} className={c === draft.colour ? 'on' : ''} style={{ ['--c' as string]: c }} onClick={() => setDraft({ ...draft, colour: c })} aria-label={`Colour ${c}`} />
            ))}
          </div>
        </div>
        <div className="tray-hint">
          {n === 0 ? <CursorClick size={14} weight="bold" /> : <Info size={14} weight="bold" />} <span>{hint}</span>
        </div>
      </div>
      <div className="tray-stats">
        <div className="tstat"><b>{n}</b><span>Stops</span></div>
        <div className="tstat"><b>{n >= 2 ? km(len) : '–'}</b><span>Loop</span></div>
        <div className="tstat"><b>{n >= 2 ? `${roundTrip} min` : '–'}</b><span>Round trip</span></div>
        <div className="tstat opt"><b>{n >= 2 ? buses : '–'}</b><span>Buses for 10 min</span></div>
      </div>
      <div className="tray-actions">
        <button className="icon-btn has-tip" onClick={undo} disabled={!n} aria-label="Undo">
          <ArrowCounterClockwise size={17} weight="bold" />
          <Tip label="Undo stop" k="⌘Z" side="below" />
        </button>
        <button className="icon-btn has-tip" onClick={redo} disabled={!draft.future.length} aria-label="Redo">
          <ArrowClockwise size={17} weight="bold" />
          <Tip label="Redo" k="⇧⌘Z" side="below" />
        </button>
        <button className="icon-btn has-tip" onClick={() => setDraft({ ...draft, stops: [], history: [...draft.history, draft.stops], future: [] })} disabled={!n} aria-label="Clear">
          <Trash size={17} weight="bold" />
          <Tip label="Clear stops" side="below" />
        </button>
        <button className="btn sm" onClick={() => { useUI.getState().setTool('select'); }}>
          <X size={14} weight="bold" /> Cancel
        </button>
        <button className="btn sm primary" disabled={n < 2} onClick={create}>
          <Check size={14} weight="bold" /> Create line
        </button>
      </div>
    </div>
  );
}

export function newDraft(): RouteDraft {
  const used = new Set(sim.lines.map((l) => l.colour));
  const colour = DRAFT_COLOURS.find((c) => !used.has(c)) ?? DRAFT_COLOURS[0];
  return { colour, number: nextLineNumber(), stops: [], path: [], length: 0, history: [], future: [] };
}
