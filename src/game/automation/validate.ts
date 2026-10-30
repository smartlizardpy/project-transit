// Workflow validation: everything the editor shows as a problem, and the executor refuses to
// run with. Errors block a run; warnings are advice.

import type { Workflow, WfEdge } from './types.ts';
import { NODE, canConnect, type PortDef } from './registry.ts';
import { checkExpr } from '../expr.ts';
import type { GameState } from '../types.ts';

export const GRAPH_LIMITS = { nodes: 200, edges: 400, functionDepth: 3 };

export interface Issue {
  level: 'error' | 'warning';
  message: string;
  node?: string;
  edge?: string;
}

export interface Validation {
  ok: boolean;
  issues: Issue[];
  /** enabled nodes in a stable topological order (empty when there is a cycle) */
  order: string[];
}

export function portOf(type: string, side: 'in' | 'out', id: string): PortDef | undefined {
  const def = NODE[type];
  return (side === 'in' ? def?.inputs : def?.outputs)?.find((p) => p.id === id);
}

/** Can an edge from (node, out) to (node, in) be added? Returns a reason when not. */
export function connectionProblem(wf: Workflow, e: Omit<WfEdge, 'id'>): string | null {
  const a = wf.nodes.find((n) => n.id === e.from), b = wf.nodes.find((n) => n.id === e.to);
  if (!a || !b) return 'That node no longer exists.';
  if (a.id === b.id) return 'A node cannot connect to itself.';
  const po = portOf(a.type, 'out', e.out), pi = portOf(b.type, 'in', e.in);
  if (!po || !pi) return 'That connection point does not exist.';
  if (!canConnect(po.type, pi.type, pi.list)) return `${po.label} (${typeName(po.type)}) cannot go into ${pi.label} (${typeName(pi.type)}).`;
  if (wf.edges.some((x) => x.from === e.from && x.out === e.out && x.to === e.to && x.in === e.in)) return 'These are already connected.';
  if (wf.edges.some((x) => x.to === e.to && x.in === e.in && !(x.from === e.from && x.out === e.out))) return `${pi.label} already has a connection. Remove it first.`;
  if (reaches(wf, b.id, a.id)) return 'That would make a loop. Workflows run from triggers to actions without going back.';
  return null;
}

const TYPE_NAMES: Record<string, string> = { any: 'anything', number: 'number', boolean: 'yes/no', text: 'text', record: 'record', list: 'list', line: 'line', stop: 'stop', vehicle: 'bus', event: 'event' };
export const typeName = (t: string) => TYPE_NAMES[t] ?? t;

function reaches(wf: Workflow, from: string, to: string): boolean {
  const out = new Map<string, string[]>();
  for (const e of wf.edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(out.get(n) ?? []));
  }
  return false;
}

export function validateWorkflow(wf: Workflow, state?: GameState): Validation {
  const issues: Issue[] = [];
  const err = (message: string, node?: string, edge?: string) => issues.push({ level: 'error', message, node, edge });
  const warn = (message: string, node?: string) => issues.push({ level: 'warning', message, node });
  if (wf.nodes.length > GRAPH_LIMITS.nodes) err(`A workflow can have at most ${GRAPH_LIMITS.nodes} nodes.`);
  if (wf.edges.length > GRAPH_LIMITS.edges) err(`A workflow can have at most ${GRAPH_LIMITS.edges} connections.`);
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const live = wf.nodes.filter((n) => !n.disabled && NODE[n.type]);
  for (const n of wf.nodes) if (!NODE[n.type]) err(`Unknown node type “${n.type}”.`, n.id);

  // edges
  const incoming = new Map<string, WfEdge[]>();
  for (const e of wf.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) { err('A connection points to a node that no longer exists.', undefined, e.id); continue; }
    const po = portOf(a.type, 'out', e.out), pi = portOf(b.type, 'in', e.in);
    if (!po || !pi) { err('A connection uses a point that no longer exists.', b.id, e.id); continue; }
    if (!canConnect(po.type, pi.type, pi.list)) err(`${NODE[a.type].label} → ${NODE[b.type].label}: ${typeName(po.type)} cannot go into ${pi.label} (${typeName(pi.type)}).`, b.id, e.id);
    const k = `${e.to}:${e.in}`;
    (incoming.get(k) ?? incoming.set(k, []).get(k)!).push(e);
  }
  for (const [k, list] of incoming) if (list.length > 1) err(`${portLabel(wf, k)} has more than one connection.`, k.split(':')[0]);

  // triggers
  const triggers = live.filter((n) => NODE[n.type].trigger);
  if (wf.kind === 'workflow' && !triggers.length) err('Add a trigger: the workflow needs something that starts it.');
  if (wf.kind === 'function') {
    if (triggers.length) err('A function is started by a “Use a function” node, so it cannot have triggers.');
    if (!live.some((n) => n.type === 'adv.output')) warn('A function gives nothing back without a “Function result” node.');
  }
  if (wf.kind === 'workflow' && live.some((n) => n.type === 'adv.input' || n.type === 'adv.output')) warn('Function inputs and results only do something inside a function.');

  // nodes: required inputs, settings, expressions
  for (const n of live) {
    const def = NODE[n.type];
    for (const p of def.inputs) {
      if (p.optional) continue;
      if (!incoming.has(`${n.id}:${p.id}`)) err(`${def.label}: connect “${p.label}”.`, n.id);
    }
    for (const f of def.config) {
      const v = n.config[f.id];
      if (f.kind === 'expr') {
        const r = checkExpr(String(v ?? ''), f.vars ?? []);
        if (!r.ok) err(`${def.label}: ${r.error}`, n.id);
      }
      if ((f.kind === 'line' || f.kind === 'stop' || f.kind === 'vehicle' || f.kind === 'depot' || f.kind === 'workflow') && !f.allowAny) {
        const port = def.inputs.find((p) => p.id === f.id);
        const connected = port ? incoming.has(`${n.id}:${port.id}`) : false;
        if (!connected && !v) err(`${def.label}: choose a ${f.label.toLowerCase()}${port ? ' or connect one' : ''}.`, n.id);
      }
      if (state && typeof v === 'string' && v) {
        if (f.kind === 'line' && !state.routes[v]) err(`${def.label}: the chosen line no longer exists.`, n.id);
        if (f.kind === 'stop' && !state.stops[v]) err(`${def.label}: the chosen stop no longer exists.`, n.id);
        if (f.kind === 'vehicle' && !state.vehicles[v]) err(`${def.label}: the chosen bus no longer exists.`, n.id);
        if (f.kind === 'depot' && !state.depots[v]) err(`${def.label}: the chosen depot no longer exists.`, n.id);
        if (f.kind === 'workflow') {
          const fn = state.automation.workflows[v];
          if (!fn) err(`${def.label}: that function no longer exists.`, n.id);
          else if (fn.kind !== 'function') err(`${def.label}: “${fn.name}” is not a function.`, n.id);
          else if (fn.id === wf.id) err(`${def.label}: a function cannot use itself.`, n.id);
        }
      }
      if (f.kind === 'number' && v !== undefined && v !== null && typeof v === 'number') {
        if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) err(`${def.label}: ${f.label} must be between ${f.min} and ${f.max}.`, n.id);
      }
    }
    if (def.action && def.action.impact === 'high' && !wf.allowHighImpact && wf.mode === 'automatic') warn(`${def.label} is a big change: it will wait for your approval unless you allow big changes.`, n.id);
  }
  // action nodes that nothing triggers
  const reachable = new Set<string>();
  const out = new Map<string, string[]>();
  for (const e of wf.edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  const stack = triggers.map((t) => t.id);
  while (stack.length) {
    const n = stack.pop()!;
    if (reachable.has(n)) continue;
    reachable.add(n);
    stack.push(...(out.get(n) ?? []));
  }
  void reachable; // nodes not attached to a trigger run whenever any trigger fires

  // topological order (Kahn), stable by node order
  const indeg = new Map<string, number>();
  const ids = live.map((n) => n.id);
  const liveSet = new Set(ids);
  for (const id of ids) indeg.set(id, 0);
  for (const e of wf.edges) if (liveSet.has(e.from) && liveSet.has(e.to)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const order: string[] = [];
  const ready = ids.filter((id) => indeg.get(id) === 0);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const e of wf.edges) {
      if (e.from !== id || !liveSet.has(e.to)) continue;
      const d = indeg.get(e.to)! - 1;
      indeg.set(e.to, d);
      if (d === 0) {
        // keep the original node order among ready nodes
        const pos = ids.indexOf(e.to);
        let i = 0;
        while (i < ready.length && ids.indexOf(ready[i]) < pos) i++;
        ready.splice(i, 0, e.to);
      }
    }
  }
  if (order.length < ids.length) err('The workflow contains a loop. Remove a connection that goes back to an earlier node.');
  const ok = !issues.some((i) => i.level === 'error');
  return { ok, issues, order: order.length === ids.length ? order : [] };
}

function portLabel(wf: Workflow, key: string) {
  const [node, port] = key.split(':');
  const n = wf.nodes.find((x) => x.id === node);
  const def = n ? NODE[n.type] : null;
  return `${def?.label ?? 'A node'} “${def?.inputs.find((p) => p.id === port)?.label ?? port}”`;
}
