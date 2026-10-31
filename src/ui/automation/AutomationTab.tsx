// Network Control → Automation tab: workflow summaries, suggestions inbox and recent activity,
// with the way into Automation Studio.
import { useState } from 'react';
import { Check, X, Hourglass } from '@phosphor-icons/react';
import type { Game } from '../../game/engine.ts';
import { useGameUpdates } from '../hooks.ts';
import { RUN_LIMITS } from '../../game/automation/executor.ts';
import { Switch, Empty, whenLabel } from './common.tsx';
import { RunList } from './Runs.tsx';
import { WorkflowRow, TemplateList, NewButtons, openInStudio } from './Lists.tsx';
import '../../styles/automation.css';

export function AutomationTab({ game }: { game: Game }) {
  useGameUpdates(1);
  const a = game.state.automation;
  const wfs = game.workflowList();
  const open = a.proposals.filter((p) => p.status === 'open');
  const runs = [...a.runs].sort((x, y) => y.t - x.t || y.id - x.id).filter((r) => !r.test);
  const [showTpl, setShowTpl] = useState(false);
  const [done, setDone] = useState<Record<number, { ok: boolean; text: string }>>({});
  const act = (id: number, approve: boolean) => {
    const r = approve ? game.approveProposal(id) : game.declineProposal(id);
    setDone((d) => ({ ...d, [id]: r.ok ? { ok: true, text: approve ? `Approved. ${'value' in r && r.value ? r.value : ''}` : 'Declined.' } : { ok: false, text: r.error } }));
  };
  const resolved = Object.entries(done).filter(([id]) => !open.some((p) => p.id === Number(id)));
  return (
    <>
      {(open.length > 0 || resolved.length > 0) && (
        <>
      <div className="section">
        <div className="section-head"><span className="nc-sub">Suggestions waiting{open.length ? ` · ${open.length}` : ''}</span></div>
        <div className="list" style={{ gap: 8 }}>
          {open.map((p) => {
            const wf = a.workflows[p.wf];
            const mins = Math.max(0, Math.ceil((p.expires - game.t) / 60));
            return (
              <div className="st-prop" key={p.id}>
                <b>{p.summary}</b>
                {p.detail && <div className="pn-note">{p.detail}</div>}
                <div className="st-prop-meta">
                  <span>{wf?.name ?? 'Removed workflow'}</span><span>· {whenLabel(p.t)}</span>
                  {p.impact === 'high' && <span className="pn-tag warn">Big change</span>}
                  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Hourglass size={11} weight="bold" />expires in {mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`}</span>
                </div>
                {done[p.id] && !done[p.id].ok && <div className="pn-warn bad">{done[p.id].text}</div>}
                <div className="pn-actions">
                  <button className="btn sm primary" onClick={() => act(p.id, true)}><Check size={13} weight="bold" />Approve</button>
                  <button className="btn sm" onClick={() => act(p.id, false)}><X size={13} weight="bold" />Decline</button>
                </div>
              </div>
            );
          })}
          {resolved.map(([id, r]) => <div key={id} className={r.ok ? 'pn-note' : 'pn-warn bad'} style={{ padding: '2px 4px' }}>{r.ok ? <Check size={12} weight="bold" style={{ verticalAlign: -1, marginRight: 4 }} /> : null}{r.text}</div>)}
        </div>
        <div className="pn-note" style={{ marginTop: 8 }}>A suggestion stays open for {RUN_LIMITS.proposalMin} game minutes, because conditions change; a route change stays open for 3 game days. When you approve it, the game checks it again first.</div>
      </div>

        </>
      )}
      <div className="section">
        <div className="section-head"><span className="nc-sub">Automation Studio</span></div>
        <div className="pn-note" style={{ marginBottom: 10 }}>Workflows watch the game and act through the normal rules: the same costs, the same limits. Each one starts in <b>Observe</b>, which only records what it would do.</div>
        <NewButtons game={game} onOpen={openInStudio} />
        <div className="st-switchrow" style={{ marginTop: 12 }}>
          <div><b style={{ fontSize: 13 }}>Pause all automations</b><div className="st-help">Nothing runs while paused. Suggestions already waiting stay.</div></div>
          <Switch on={a.paused} onChange={(v) => game.setAutomationPaused(v)} label="Pause all automations" />
        </div>
        {a.paused && <div className="pn-warn" style={{ marginTop: 10 }}>All automations are paused.</div>}
      </div>

      {open.length === 0 && resolved.length === 0 && (
        <div className="section">
          <div className="section-head"><span className="nc-sub">Suggestions waiting</span></div>
          <div className="pn-note">Nothing is waiting. Workflows in Suggest mode, and big changes from Automatic ones, appear here for you to approve.</div>
        </div>
      )}
      <div className="section">
        <div className="section-head"><span className="nc-sub">Your workflows{wfs.length ? ` · ${wfs.length}` : ''}</span></div>
        {wfs.length === 0 ? <Empty>No workflows yet. Start from a template below, or build one from scratch in the Studio.</Empty> : (
          <div className="list" style={{ gap: 8 }}>{wfs.map((w) => <WorkflowRow key={w.id} game={game} wf={w} onOpen={openInStudio} />)}</div>
        )}
      </div>

      <div className="section">
        <div className="section-head"><span className="nc-sub">Start from a template</span><button className="btn sm" onClick={() => setShowTpl(!showTpl)}>{showTpl ? 'Hide' : 'Show'}</button></div>
        {showTpl || wfs.length === 0 ? <TemplateList game={game} onOpen={openInStudio} /> : <div className="pn-note">Ready-made workflows, created in Observe mode so they change nothing until you decide.</div>}
      </div>

      <div className="section">
        <div className="section-head"><span className="nc-sub">Recent activity</span></div>
        {runs.length === 0 ? <div className="pn-note">No workflow has run yet. {wfs.some((w) => w.enabled) ? 'Runs appear here as soon as a trigger fires.' : 'Switch one on, or open it and press Run now.'}</div> : <RunList game={game} runs={runs} showWf limit={8} />}
      </div>
    </>
  );
}
