// Automation Studio: the node editor workspace (opened from Network Control).
import { useEffect, useState } from 'react';
import { X, Eye, EyeSlash } from '@phosphor-icons/react';
import { useUI } from '../../state/store.ts';
import { useGameRev } from '../hooks.ts';
import { Editor } from './Editor.tsx';
import { WorkflowRow, TemplateList, NewButtons } from './Lists.tsx';
import '../../styles/automation.css';

export function AutomationStudio() {
  const studio = useUI((s) => s.studio);
  const game = useGameRev();
  const [dirty, setDirty] = useState(false);
  const wf = studio.workflow && game ? game.state.automation.workflows[studio.workflow] : null;
  // closing the studio from elsewhere (e.g. leaving the game) never leaves it half open
  useEffect(() => { if (!studio.open) setDirty(false); }, [studio.open]);
  useEffect(() => {
    if (!dirty) return;
    const f = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [dirty]);
  if (!studio.open || !game) return null;
  const set = useUI.getState().setStudio;
  return (
    <section className={`studio card ${studio.peek ? 'peek' : ''}`} aria-label="Automation Studio">
      {wf ? (
        <Editor key={wf.id} game={game} wfId={wf.id} onLeave={() => set({ workflow: null })} onDirty={setDirty} />
      ) : (
        <>
          <div className="st-top">
            <div className="st-title"><b style={{ fontSize: 16, fontWeight: 800, padding: '2px 0' }}>Automation Studio</b><small>Build workflows that watch the game and act through its normal rules</small></div>
            <span className="grow" />
            <button className="icon-btn" onClick={() => set({ peek: !studio.peek })} aria-label={studio.peek ? 'Show the workspace' : 'Show the map'}>{studio.peek ? <EyeSlash size={17} weight="bold" /> : <Eye size={17} weight="bold" />}</button>
            <button className="icon-btn" onClick={() => set({ open: false })} aria-label="Close Automation Studio"><X size={17} weight="bold" /></button>
          </div>
          <div className="st-home st-body-home">
            <div>
              <div className="label">Your workflows</div>
              {game.workflowList().length === 0 && <div className="pn-empty">No workflows yet. Start from a template, or make an empty one.</div>}
              {game.workflowList().map((w) => <WorkflowRow key={w.id} game={game} wf={w} onOpen={(id) => set({ workflow: id })} />)}
              <NewButtons game={game} onOpen={(id) => set({ workflow: id })} />
            </div>
            <div>
              <div className="label">Start from a template</div>
              <TemplateList game={game} onOpen={(id) => set({ workflow: id })} />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
