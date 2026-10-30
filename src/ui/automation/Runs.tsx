// Run history in the game's list style, shared by the tab, the Studio history view and the Lab samples.
import { useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import type { Game } from '../../game/engine.ts';
import type { RunRecord, Workflow } from '../../game/automation/types.ts';
import { OUTCOME_LABEL, RUN_LIMITS } from '../../game/automation/executor.ts';
import { ModeTag, StatusTag, whenLabel, nodeTitle, showValue } from './common.tsx';

export function ActionList({ game, run }: { game: Game; run: RunRecord }) {
  return (
    <>
      {run.actions.map((a, i) => (
        <div className="st-act" key={i}>
          <b><span className={`st-oc ${a.outcome}`}>{OUTCOME_LABEL[a.outcome]}</span>{a.summary}</b>
          {(a.reason || a.effect) && <span>{[a.effect, a.reason].filter(Boolean).join(' ')}</span>}
          {a.cost ? <span>Cost {game.money(a.cost)}</span> : null}
        </div>
      ))}
    </>
  );
}

export function TraceList({ game, run, onPick, picked, wf: draft }: { game: Game; run: RunRecord; onPick?: (node: string) => void; picked?: string | null; wf?: Workflow }) {
  const wf = draft ?? game.state.automation.workflows[run.wf];
  if (!run.trace) return <div className="pn-note">Detailed trace is kept for the latest {RUN_LIMITS.traces} runs of each workflow.</div>;
  if (!run.trace.length) return <div className="pn-note">No node ran: {run.error ?? 'the workflow has nothing to run.'}</div>;
  return (
    <div className="list" style={{ gap: 0 }}>
      {run.trace.map((t) => {
        const n = wf?.nodes.find((x) => x.id === t.node);
        const label = n ? nodeTitle(n) : 'A removed node';
        return (
          <button key={t.node} className={`st-step ${t.status} ${picked === t.node ? 'on' : ''}`} onClick={() => onPick?.(t.node)}>
            <i />
            <div>
              <b>{label}</b>
              <span>{t.status === 'inactive' ? 'Not reached: the branch before it was not taken.' : t.status === 'error' ? t.error : t.note || (t.outputs ? Object.entries(t.outputs).slice(0, 2).map(([k, v]) => `${k}: ${showValue(v)}`).join(' · ') : 'Done')}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function RunRow({ game, run, showWf, open: initial }: { game: Game; run: RunRecord; showWf?: boolean; open?: boolean }) {
  const [open, setOpen] = useState(!!initial);
  const wf = game.state.automation.workflows[run.wf];
  const done = run.actions.filter((a) => a.outcome === 'executed' || a.outcome === 'deferred').length;
  const summary = run.error ? run.error : run.actions.length ? run.actions.map((a) => a.summary).slice(0, 2).join(' · ') + (run.actions.length > 2 ? ` · +${run.actions.length - 2} more` : '') : run.report?.length ? run.report[0] : 'Nothing needed doing.';
  return (
    <div className="st-run-row">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="st-run-time">{whenLabel(run.t)}</span>
        <span className="st-run-what"><b>{showWf ? `${wf?.name ?? 'Removed workflow'} · ` : ''}{run.triggerLabel}</b><span>{summary}</span></span>
        <span className="st-run-tags">
          {done > 0 && <span className="pn-tag good">{done} done</span>}
          <ModeTag mode={run.mode} /><StatusTag run={run} />
          <CaretDown size={12} weight="bold" style={{ transform: open ? 'rotate(180deg)' : undefined, color: 'var(--text-3)' }} />
        </span>
      </button>
      {open && (
        <div className="st-run-detail">
          {run.test && <div className="pn-note">A test: nothing was changed.</div>}
          {run.error && <div className="pn-warn bad">{run.error}</div>}
          {run.actions.length > 0 && <><h5>Actions</h5><ActionList game={game} run={run} /></>}
          {run.report && run.report.length > 0 && <><h5>Report</h5>{run.report.map((l, i) => <div className="pn-note" key={i}>{l}</div>)}</>}
          <h5>What each node did</h5>
          <TraceList game={game} run={run} />
        </div>
      )}
    </div>
  );
}

export function RunList({ game, runs, showWf, limit = 30 }: { game: Game; runs: RunRecord[]; showWf?: boolean; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? runs : runs.slice(0, limit);
  return (
    <div className="st-runs">
      {shown.map((r) => <RunRow key={r.id} game={game} run={r} showWf={showWf} />)}
      {runs.length > shown.length && <button className="btn sm" onClick={() => setAll(true)}>Show all {runs.length} runs</button>}
    </div>
  );
}
