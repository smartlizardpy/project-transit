// The node cards drawn on the canvas.
import { memo } from 'react';
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react';
import type { Game } from '../../game/engine.ts';
import { NODE, triggerLabel, describeValue } from '../../game/automation/registry.ts';
import type { NodeTrace, WfGroup, WfNode } from '../../game/automation/types.ts';
import { CatChip, nodeTitle } from './common.tsx';

/** A line of what the node is set to, in the game's words. */
export function summarise(game: Game, node: WfNode, wired?: Set<string>): string {
  const def = NODE[node.type];
  if (!def) return '';
  if (def.trigger) return triggerLabel(game, node);
  const parts: string[] = [];
  for (const f of def.config) {
    if (wired?.has(f.id)) continue; // a connection feeds it
    const v = node.config[f.id];
    if (v === undefined || v === null || v === '') { if (f.allowAny && (f.kind === 'line' || f.kind === 'stop' || f.kind === 'vehicle')) continue; if (f.kind === 'line' || f.kind === 'stop' || f.kind === 'vehicle' || f.kind === 'depot') parts.push(`${f.label}: not chosen`); continue; }
    if (f.kind === 'boolean') { if (v) parts.push(f.label); continue; }
    let text: string;
    if (f.kind === 'line') text = `Line ${game.state.routes[String(v)]?.number ?? '?'}`;
    else if (f.kind === 'stop') text = game.state.stops[String(v)]?.name ?? '?';
    else if (f.kind === 'vehicle') text = `Bus ${game.state.vehicles[String(v)]?.fleetNo ?? '?'}`;
    else if (f.kind === 'depot') text = game.state.depots[String(v)]?.name ?? '?';
    else if (f.kind === 'workflow') text = game.state.automation.workflows[String(v)]?.name ?? '?';
    else if (f.kind === 'select') text = f.options?.find((o) => o.value === v)?.label ?? String(v);
    else if (f.kind === 'number') text = `${v}${f.unit ? ` ${f.unit}` : ''}`;
    else text = String(v);
    parts.push(f.kind === 'expr' || f.kind === 'text' || f.kind === 'textarea' ? text : `${f.label}: ${text}`);
  }
  return parts.slice(0, 3).join(' · ');
}

export interface StNodeData extends Record<string, unknown> {
  node: WfNode;
  game: Game;
  trace?: NodeTrace;
  /** 'error' | 'warning' from live validation */
  issue?: 'error' | 'warning';
  ran: boolean;
  /** input ports that have a connection */
  wired?: Set<string>;
}

function StNodeView({ data, selected }: NodeProps) {
  const { node, game, trace, issue, ran, wired } = data as StNodeData;
  const def = NODE[node.type];
  if (!def) return <div className="st-node has-error"><div className="st-node-head"><b>Unknown node</b></div></div>;
  const run = ran && trace ? trace.status : null;
  const sum = summarise(game, node, wired);
  const cls = ['st-node', `cat-${def.category}`, selected ? 'sel' : '', node.disabled ? 'disabled' : '', run ? `run-${run}` : '', issue ? `has-${issue}` : ''].join(' ');
  return (
    <div className={cls}>
      <div className="st-node-head">
        <CatChip cat={def.category} />
        <div>
          <b title={nodeTitle(node)}>{nodeTitle(node)}</b>
          <small>{node.label ? def.label : def.category === 'trigger' ? 'Trigger' : def.action ? (def.action.impact === 'high' ? 'Action · big change' : 'Action') : ''}</small>
        </div>
      </div>
      {sum && <div className="st-node-sum">{sum}</div>}
      {ran && trace?.note && trace.status === 'ok' && <div className="st-node-note">{trace.note}</div>}
      {ran && trace?.status === 'error' && <div className="st-node-note err">{trace.error}</div>}
      {ran && trace?.status === 'inactive' && <div className="st-node-note off">Not reached</div>}
      {(def.inputs.length > 0 || def.outputs.length > 0) && (
        <div className="st-ports">
          <div>
            {def.inputs.map((p) => (
              <div key={p.id} className={`st-port in ${p.optional ? 'opt' : ''}`} title={p.help}>
                <Handle type="target" position={Position.Left} id={p.id} className={`t-${p.type}`} />
                <span>{p.label}</span>
              </div>
            ))}
          </div>
          <div>
            {def.outputs.map((p) => (
              <div key={p.id} className="st-port out" title={p.help}>
                <span>{p.label}</span>
                <Handle type="source" position={Position.Right} id={p.id} className={`t-${p.type}`} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
export const StNode = memo(StNodeView);

function StGroupView({ data, selected }: NodeProps) {
  const g = (data as { group: WfGroup; onResize: (id: string, x: number, y: number, w: number, h: number) => void }).group;
  const onResize = (data as { onResize: (id: string, x: number, y: number, w: number, h: number) => void }).onResize;
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={200} minHeight={120} onResizeEnd={(_e, p) => onResize(g.id, p.x, p.y, p.width, p.height)} />
      <div className={`st-group ${selected ? 'sel' : ''}`}><span className="st-group-label">{g.label}</span></div>
    </>
  );
}
export const StGroup = memo(StGroupView);

export const describe = describeValue;
