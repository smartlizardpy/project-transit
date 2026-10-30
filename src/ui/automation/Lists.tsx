// Workflow rows, templates and creation helpers, shared by the Automation tab and the Studio's home.
import { useState } from 'react';
import { Plus, PencilSimple, Copy, Trash, Lightning } from '@phosphor-icons/react';
import type { Game } from '../../game/engine.ts';
import { NODE, triggerLabel, defaultConfig } from '../../game/automation/registry.ts';
import { TEMPLATES, fromTemplate } from '../../game/automation/templates.ts';
import type { WfNode, Workflow } from '../../game/automation/types.ts';
import { DAY } from '../../game/content.ts';
import { useUI } from '../../state/store.ts';
import { ModeTag, Switch, whenLabel } from './common.tsx';

export function openInStudio(id: string | null) { useUI.getState().setStudio({ open: true, workflow: id, peek: false }); }

/** A new workflow with its starting node already on the canvas. */
export function createBlank(game: Game, kind: 'workflow' | 'function'): string | null {
  const n = game.workflowList().filter((w) => w.kind === kind).length + 1;
  const mk = (type: string, x: number, y: number): WfNode => ({ id: game.newNodeId(), type, x, y, config: defaultConfig(type) });
  const nodes = kind === 'workflow' ? [mk('trigger.every', 80, 100)] : [mk('adv.input', 80, 100), mk('adv.output', 520, 100)];
  const r = game.createWorkflow({ name: kind === 'workflow' ? `New workflow ${n}` : `New function ${n}`, kind, nodes, edges: [] });
  if (!r.ok) { useUI.getState().notify(r.error, 'warn'); return null; }
  return r.value;
}

export function startFromTemplate(game: Game, id: string): string | null {
  const r = fromTemplate(game, id);
  if (!r.ok) { useUI.getState().notify(r.error, 'warn'); return null; }
  return r.value;
}

export function triggerSummary(game: Game, wf: Workflow): string {
  if (wf.kind === 'function') return 'Used by other workflows';
  const ts = wf.nodes.filter((n) => NODE[n.type]?.trigger && !n.disabled);
  if (!ts.length) return 'No trigger yet';
  return ts.slice(0, 2).map((t) => triggerLabel(game, t)).join(' · ') + (ts.length > 2 ? ` · +${ts.length - 2}` : '');
}

export function WorkflowRow({ game, wf, onOpen }: { game: Game; wf: Workflow; onOpen: (id: string) => void }) {
  const a = game.state.automation;
  const runs = a.runs.filter((r) => r.wf === wf.id);
  const last = runs.reduce<typeof runs[number] | null>((m, r) => (!m || r.t > m.t || (r.t === m.t && r.id > m.id) ? r : m), null);
  const day = Math.floor(game.t / DAY);
  const today = a.daily.day === day ? a.daily.byWf[wf.id] : undefined;
  const val = game.validateWorkflow(wf.id);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState('');
  const isFn = wf.kind === 'function';
  return (
    <div className="st-wf">
      <div className="st-wf-main">
        <div className="st-wf-name">
          <button onClick={() => onOpen(wf.id)}>{wf.name}</button>
          {isFn ? <span className="pn-tag">Function</span> : <ModeTag mode={wf.mode} />}
          {val && !val.ok && <span className="pn-tag bad">Has problems</span>}
        </div>
        <div className="st-wf-meta">
          {triggerSummary(game, wf)}<br />
          {isFn ? `${wf.nodes.length} nodes` : last ? <>Last run {whenLabel(last.t)} · {last.status === 'ok' ? 'ran' : last.status === 'error' ? 'failed' : 'limit reached'}{today ? ` · today ${today.runs} run${today.runs === 1 ? '' : 's'}, ${today.actions} action${today.actions === 1 ? '' : 's'}` : ' · nothing yet today'}</> : wf.enabled ? 'Has not run yet' : 'Has not run'}
        </div>
      </div>
      {!isFn && <Switch on={wf.enabled} onChange={(v) => { const r = game.updateWorkflow(wf.id, { enabled: v }); setErr(r.ok ? '' : r.error); }} label={`${wf.name} switched on`} />}
      {wf.stopped && <div className="st-wf-stop">Switched off by the game: {wf.stopped}</div>}
      {err && <div className="st-wf-stop">{err}</div>}
      <div className="st-wf-foot">
        <button className="btn sm" onClick={() => onOpen(wf.id)}><PencilSimple size={13} weight="bold" />Open in Studio</button>
        <button className="btn sm" onClick={() => { const r = game.duplicateWorkflow(wf.id); if (!r.ok) setErr(r.error); }}><Copy size={13} weight="bold" />Duplicate</button>
        {confirm
          ? <><button className="btn sm danger" onClick={() => { const r = game.deleteWorkflow(wf.id); if (!r.ok) { setErr(r.error); setConfirm(false); } }}>Delete for good</button><button className="btn sm" onClick={() => setConfirm(false)}>Keep it</button></>
          : <button className="btn sm" onClick={() => setConfirm(true)} aria-label={`Delete ${wf.name}`}><Trash size={13} weight="bold" /></button>}
      </div>
    </div>
  );
}

export function TemplateList({ game, onOpen }: { game: Game; onOpen: (id: string) => void }) {
  return (
    <div className="list" style={{ gap: 6 }}>
      {TEMPLATES.map((t) => (
        <button key={t.id} className="st-tpl" onClick={() => { const id = startFromTemplate(game, t.id); if (id) onOpen(id); }}>
          <b><Lightning size={13} weight="bold" style={{ color: 'var(--amber)' }} />{t.name}<ModeTag mode={t.mode} /></b>
          <span>{t.description}</span>
        </button>
      ))}
    </div>
  );
}

export function NewButtons({ game, onOpen }: { game: Game; onOpen: (id: string) => void }) {
  return (
    <div className="pn-actions">
      <button className="btn primary" onClick={() => { const id = createBlank(game, 'workflow'); if (id) onOpen(id); }}><Plus size={14} weight="bold" />New workflow</button>
      <button className="btn" onClick={() => { const id = createBlank(game, 'function'); if (id) onOpen(id); }} title="A reusable piece other workflows can use">New function</button>
    </div>
  );
}
