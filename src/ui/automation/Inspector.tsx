// Right-hand inspector: the selected node's settings, ports and last test, or the workflow's own settings.
import { Copy, Trash, ArrowsInLineHorizontal } from '@phosphor-icons/react';
import type { Game } from '../../game/engine.ts';
import { NODE } from '../../game/automation/registry.ts';
import { typeName } from '../../game/automation/validate.ts';
import type { Issue } from '../../game/automation/validate.ts';
import type { Mode, NodeTrace, Value, WfGroup, WfNode, Workflow } from '../../game/automation/types.ts';
import { Segmented } from '../primitives.tsx';
import { FieldControl } from './Fields.tsx';
import { CatChip, MODE_INFO, Switch, catLabel, showValue } from './common.tsx';

const hex = (t: string) => `t-${t}`;

export function NodeInspector({ game, node, edgesIn, trace, issues, stale, onConfig, onLabel, onDisabled, onDuplicate, onDelete }: {
  game: Game; node: WfNode; edgesIn: Set<string>; trace?: NodeTrace; issues: Issue[]; stale: boolean;
  onConfig: (id: string, v: Value) => void; onLabel: (v: string) => void; onDisabled: (v: boolean) => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const def = NODE[node.type];
  if (!def) return <div className="st-pad"><div className="pn-warn bad">This node type no longer exists.</div></div>;
  return (
    <div className="st-pad">
      <div className="st-sec">
        <div className="pn-actions"><CatChip cat={def.category} /><div className="grow"><b>{def.label}</b><div className="st-help">{catLabel(def.category)}{def.action?.impact === 'high' ? ' · big change' : ''}</div></div></div>
        <div className="st-help">{def.description}</div>
        <div className="st-field"><label htmlFor="st-label">Name on the canvas</label>
          <input id="st-label" className="pn-input" placeholder={def.label} value={node.label ?? ''} maxLength={40} onChange={(e) => onLabel(e.target.value)} />
        </div>
        <div className="st-switchrow"><div><b>Switched on</b><div className="st-help">An off node is skipped; what it feeds receives nothing.</div></div><Switch on={!node.disabled} onChange={(v) => onDisabled(!v)} label="Node switched on" /></div>
        <div className="pn-actions"><button className="btn sm" onClick={onDuplicate}><Copy size={13} weight="bold" />Duplicate</button><button className="btn sm danger" onClick={onDelete}><Trash size={13} weight="bold" />Delete</button></div>
      </div>

      {issues.length > 0 && <div className="st-sec">{issues.map((i, k) => <div key={k} className={`pn-warn ${i.level === 'error' ? 'bad' : ''}`}>{i.message}</div>)}</div>}

      {[{ title: 'Settings', fields: def.config.filter((f) => f.section !== 'timing') }, { title: 'When it may fire', fields: def.config.filter((f) => f.section === 'timing') }].filter((g) => g.fields.length).map((g) => (
        <div className="st-sec" key={g.title}>
          <h4>{g.title}</h4>
          {g.fields.map((f) => {
            const port = def.inputs.find((p) => p.id === f.id);
            const wired = port ? edgesIn.has(port.id) : false;
            return (
              <div className="st-field" key={f.id}>
                <label>{f.label}{wired && <span className="pn-tag good">Connected</span>}</label>
                {wired ? <div className="st-help">A connection feeds this, so the setting is not used.</div>
                  : <FieldControl game={game} field={f} value={node.config[f.id]} onChange={(v) => onConfig(f.id, v)} />}
                {f.help && <div className="st-help">{f.help}</div>}
              </div>
            );
          })}
        </div>
      ))}

      <div className="st-sec">
        <h4>Connection points</h4>
        <div className="st-portlist">
          {def.inputs.map((p) => <div className="p" key={`i${p.id}`}><i className={hex(p.type)} /><div>{p.label} <span className="faint">in · {typeName(p.type)}{p.optional ? ' · optional' : ''}{p.list ? ' · or a list' : ''}</span>{p.help && <small>{p.help}</small>}</div></div>)}
          {def.outputs.map((p) => <div className="p" key={`o${p.id}`}><i className={hex(p.type)} /><div>{p.label} <span className="faint">out · {typeName(p.type)}</span>{p.help && <small>{p.help}</small>}</div></div>)}
          {!def.inputs.length && !def.outputs.length && <div className="st-help">None.</div>}
        </div>
      </div>

      <div className="st-sec">
        <h4>Last test</h4>
        {!trace ? <div className="st-help">{stale ? 'The workflow changed since the last test. Press Test again.' : 'Press Test to see what this node receives and gives.'}</div> : (
          <>
            <div className="st-ioline"><span className="k">Result</span><span className="v">{trace.status === 'ok' ? 'Ran' : trace.status === 'inactive' ? 'Not reached' : trace.status === 'error' ? 'Failed' : 'Off'}</span></div>
            {trace.note && <div className="st-ioline"><span className="k">Why</span><span className="v">{trace.note}</span></div>}
            {trace.error && <div className="st-ioline"><span className="k">Error</span><span className="v st-bad">{trace.error}</span></div>}
            {trace.inputs && Object.entries(trace.inputs).map(([k, v]) => <div className="st-ioline" key={`i${k}`}><span className="k">In · {def.inputs.find((p) => p.id === k)?.label ?? k}</span><span className="v">{showValue(v)}</span></div>)}
            {trace.outputs && Object.entries(trace.outputs).map(([k, v]) => <div className="st-ioline" key={`o${k}`}><span className="k">Out · {def.outputs.find((p) => p.id === k)?.label ?? k}</span><span className="v">{showValue(v)}</span></div>)}
            {stale && <div className="st-help">From before your latest edit.</div>}
          </>
        )}
      </div>
    </div>
  );
}

export function GroupInspector({ group, count, onLabel, onUngroup }: { group: WfGroup; count: number; onLabel: (v: string) => void; onUngroup: () => void }) {
  return (
    <div className="st-pad">
      <div className="st-sec">
        <h4>Group</h4>
        <div className="st-field"><label htmlFor="st-g">Label</label><input id="st-g" className="pn-input" value={group.label} maxLength={40} onChange={(e) => onLabel(e.target.value)} /></div>
        <div className="st-help">{count} node{count === 1 ? '' : 's'} inside. Move the frame to move them together; drag its corners to resize.</div>
        <button className="btn sm" onClick={onUngroup}><ArrowsInLineHorizontal size={13} weight="bold" />Ungroup</button>
      </div>
    </div>
  );
}

export function WorkflowInspector({ game, wf, draft, setDraft, onEnabled, onClearMemory }: {
  game: Game; wf: Workflow; draft: Workflow; setDraft: (fn: (d: Workflow) => Workflow, key: string) => void; onEnabled: (v: boolean) => void; onClearMemory: () => void;
}) {
  const mem = game.state.automation.memory[wf.id] ?? {};
  const stored = Object.entries(mem);
  const lim = draft.limits;
  const setLim = (k: keyof typeof lim, v: number) => setDraft((d) => ({ ...d, limits: { ...d.limits, [k]: v } }), `lim-${k}`);
  const isFn = draft.kind === 'function';
  const hasHigh = draft.nodes.some((n) => NODE[n.type]?.action?.impact === 'high');
  return (
    <div className="st-pad">
      <div className="st-sec">
        <h4>{isFn ? 'Function' : 'Workflow'}</h4>
        <div className="st-field"><label htmlFor="st-desc">Description</label>
          <textarea id="st-desc" className="pn-input st-area" rows={2} maxLength={300} placeholder="What is this for?" value={draft.description ?? ''} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }), 'desc')} />
        </div>
        {!isFn && (
          <div className="st-switchrow"><div><b>Switched on</b><div className="st-help">Takes effect straight away, whatever else is unsaved.</div></div><Switch on={wf.enabled} onChange={onEnabled} label="Workflow switched on" /></div>
        )}
        {wf.stopped && <div className="pn-warn">Switched off by the game: {wf.stopped}</div>}
      </div>

      {!isFn && (
        <div className="st-sec">
          <h4>What it may do</h4>
          <Segmented<Mode> value={draft.mode} onChange={(m) => setDraft((d) => ({ ...d, mode: m }), 'mode')} options={(['observe', 'suggest', 'automatic'] as Mode[]).map((m) => ({ value: m, label: MODE_INFO[m].label }))} />
          <div className="st-modehelp"><b>{MODE_INFO[draft.mode].short}.</b> {MODE_INFO[draft.mode].long}</div>
          <div className="st-switchrow">
            <div><b>Allow big changes</b><div className="st-help">Timetable, fare and suspension changes. Without this they always wait for your approval, even in Automatic.{hasHigh ? '' : ' None of its nodes make big changes now.'}</div></div>
            <Switch on={draft.allowHighImpact} onChange={(v) => setDraft((d) => ({ ...d, allowHighImpact: v }), 'high')} label="Allow big changes" />
          </div>
        </div>
      )}

      {!isFn && (
        <div className="st-sec">
          <h4>Limits</h4>
          <div className="st-limits">
            <LimitField label="Runs per hour" v={lim.runsPerHour} min={1} max={120} on={(v) => setLim('runsPerHour', v)} />
            <LimitField label="Actions per day" v={lim.actionsPerDay} min={1} max={500} on={(v) => setLim('actionsPerDay', v)} />
            <LimitField label="Spending per day" v={lim.spendPerDay} min={0} max={1_000_000} on={(v) => setLim('spendPerDay', v)} />
            <LimitField label="Cooldown (min)" v={lim.cooldownMin} min={0} max={1440} on={(v) => setLim('cooldownMin', v)} />
          </div>
          <div className="st-help">Cooldown is the wait before the same kind of action on the same line or bus can repeat.</div>
        </div>
      )}

      <div className="st-sec">
        <h4>Memory</h4>
        {stored.length === 0 ? <div className="st-help">Nothing remembered. “Remember” and “Count” nodes keep values here between runs.</div> : (
          <div className="st-mem">{stored.slice(0, 12).map(([k, v]) => <div key={k}><span>{k}</span><span>{showValue(v)}</span></div>)}</div>
        )}
        {stored.length > 0 && <button className="btn sm" onClick={onClearMemory}>Clear memory</button>}
      </div>
    </div>
  );
}

function LimitField({ label, v, min, max, on }: { label: string; v: number; min: number; max: number; on: (v: number) => void }) {
  return (
    <div className="st-field"><label>{label}</label>
      <input className="pn-input" type="number" value={v} min={min} max={max} onChange={(e) => e.target.value !== '' && on(Math.max(min, Math.min(max, Number(e.target.value))))} />
    </div>
  );
}
