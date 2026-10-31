import { useState } from 'react';
import { Plus, Trash, PencilSimple, Check } from '@phosphor-icons/react';
import { Segmented } from './primitives.tsx';
import { serviceDayOf } from '../game/time.ts';
import type { Game } from '../game/engine.ts';
import type { ServicePlan, Timetable } from '../game/types.ts';
import { CONDITIONS, MAX_PLANS, PLAN_PRESETS, conditionValue, newPlan } from './timetableLogic.ts';

/** "Today: normal timetable · Tomorrow: School holidays" for a line (what is saved, not the draft). */
export function planSummary(game: Game, routeId: string): string {
  const sd = serviceDayOf(game.t);
  const say = (n: number) => {
    const d = game.dayPlan(routeId, sd + n);
    return d.planId ? d.name : 'normal timetable';
  };
  return `Today: ${say(0)} · Tomorrow: ${say(1)}`;
}

export function ServicePlans({ game, routeId, draft, setDraft, editing, setEditing }: {
  game: Game;
  routeId: string;
  draft: Timetable;
  setDraft: (t: Timetable) => void;
  editing: string;
  setEditing: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const plans = draft.plans ?? [];
  const setPlans = (p: ServicePlan[]) => setDraft({ ...draft, plans: p.length ? p : undefined });
  const patch = (id: string, change: Partial<ServicePlan>) => setPlans(plans.map((p) => (p.id === id ? { ...p, ...change } : p)));
  const add = (preset: string) => {
    const p = newPlan(draft, preset);
    if (!p) return;
    setPlans([...plans, p]);
    setEditing(p.id);
    setAdding(false);
  };
  const editingPlan = plans.find((p) => p.id === editing);

  return (
    <div className="section">
      <div className="section-head">
        <span className="label">Service plans</span>
        <span className="faint">{planSummary(game, routeId)}</span>
      </div>
      {!plans.length && <div className="faint tt-none">A service plan is a different timetable for a season, the school holidays or a busy day. The normal timetable runs when none applies.</div>}
      {plans.map((p) => (
        <div key={p.id} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {renaming === p.id ? (
            <input className="title-input" style={{ flex: 1, minWidth: 100 }} autoFocus maxLength={40} aria-label="Plan name" value={p.name}
              onChange={(e) => patch(p.id, { name: e.target.value })} onBlur={() => setRenaming(null)} onKeyDown={(e) => { if (e.key === 'Enter') setRenaming(null); }} />
          ) : (
            <b style={{ flex: 1, minWidth: 100 }}>{p.name}</b>
          )}
          <select className="select" aria-label={`When ${p.name} runs`} value={conditionValue(p.when)}
            onChange={(e) => patch(p.id, { when: CONDITIONS.find((c) => c.value === e.target.value)!.make() })}>
            {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          {p.when.kind === 'manual' && (
            <button className={`pill ${p.when.on ? 'good' : ''}`} aria-pressed={p.when.on} onClick={() => patch(p.id, { when: { kind: 'manual', on: p.when.kind === 'manual' ? !p.when.on : true } })}>
              {p.when.on ? 'Switched on' : 'Switched off'}
            </button>
          )}
          <button role="switch" aria-checked={p.enabled} aria-label={`${p.name} enabled`} title={p.enabled ? 'Plan is in use' : 'Plan is ignored'} className={'mn-switch' + (p.enabled ? ' on' : '')} onClick={() => patch(p.id, { enabled: !p.enabled })}><i /></button>
          <button className="icon-btn" aria-label={`Rename ${p.name}`} onClick={() => setRenaming(p.id)}><PencilSimple size={14} /></button>
          <button className="icon-btn" aria-label={`Delete ${p.name}`} onClick={() => { setPlans(plans.filter((x) => x.id !== p.id)); if (editing === p.id) setEditing('normal'); }}><Trash size={14} /></button>
        </div>
      ))}
      <div className="tt-toolbar" style={{ marginTop: 8 }}>
        {plans.length > 0 ? (
          <Segmented options={[{ value: 'normal', label: 'Normal' }, ...plans.map((p) => ({ value: p.id, label: p.name }))]} value={editingPlan ? editing : 'normal'} onChange={setEditing} />
        ) : <span />}
        <button className="btn sm" disabled={plans.length >= MAX_PLANS} onClick={() => setAdding(!adding)}><Plus size={14} /> Add a plan</button>
      </div>
      {plans.length > 0 && <div className="tt-hint faint">Editing: {editingPlan ? `${editingPlan.name} (the first plan in the list that applies wins)` : 'the normal timetable'}.</div>}
      {adding && (
        <div className="tt-presets" style={{ marginTop: 8 }}>
          {PLAN_PRESETS.map((p) => (
            <button key={p.id} className="btn sm" onClick={() => add(p.id)}><b>{p.label}</b><small>{p.hint}</small></button>
          ))}
          <small className="faint" style={{ gridColumn: '1 / -1' }}><Check size={11} /> A new plan starts as a copy of the normal timetable.</small>
        </div>
      )}
    </div>
  );
}
