// Workflow management commands used by Automation Studio. The UI never edits automation state
// directly; it calls these through the Game (which marks the game as changed).

import type { Game, Result } from '../engine.ts';
import type { Mode, Value, WfEdge, WfGroup, WfNode, Workflow } from './types.ts';
import { DEFAULT_LIMITS } from './types.ts';
import { NODE, defaultConfig, trim } from './registry.ts';
import { GRAPH_LIMITS } from './validate.ts';
import { invalidate, refreshWants } from './executor.ts';
import { clearPending } from './watch.ts';

/** Trigger settings, to tell a moved node from a changed condition. */
const triggerSig = (nodes: WfNode[]) => JSON.stringify(nodes.filter((n) => NODE[n.type]?.trigger).map((n) => [n.id, n.type, n.config, !!n.disabled]));

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

export interface WorkflowPatch {
  name?: string;
  description?: string;
  nodes?: WfNode[];
  edges?: WfEdge[];
  groups?: WfGroup[];
  viewport?: Workflow['viewport'];
  mode?: Mode;
  enabled?: boolean;
  allowHighImpact?: boolean;
  limits?: Partial<Workflow['limits']>;
}

export function newNodeId(game: Game): string {
  return `n${++game.state.automation.counters.node}`;
}

export function newNode(game: Game, type: string, x: number, y: number): WfNode {
  return { id: newNodeId(game), type, x, y, config: defaultConfig(type) };
}

export function createWorkflow(game: Game, init: Partial<Workflow> & { name: string }): Result<string> {
  const a = game.state.automation;
  if (Object.keys(a.workflows).length >= 60) return fail('You can keep up to 60 workflows. Delete one first.');
  const id = `wf${++a.counters.workflow}`;
  const wf: Workflow = {
    id,
    name: init.name.trim().slice(0, 60) || 'New workflow',
    description: init.description?.slice(0, 300),
    kind: init.kind ?? 'workflow',
    enabled: false,
    mode: init.mode ?? 'observe',
    allowHighImpact: false,
    nodes: [],
    edges: [],
    groups: [],
    limits: { ...DEFAULT_LIMITS, ...init.limits },
    viewport: init.viewport,
    created: game.t,
    updated: game.t,
    rev: 1,
    errors: 0,
  };
  a.workflows[id] = wf;
  a.order.push(id);
  if (init.nodes || init.edges) {
    const r = updateWorkflow(game, id, { nodes: init.nodes, edges: init.edges, groups: init.groups });
    if (!r.ok) {
      delete a.workflows[id];
      a.order = a.order.filter((x) => x !== id);
      return r;
    }
  }
  return ok(id);
}

/** Replace parts of a workflow. Graph edits are checked for structure (not for meaning: see validate.ts). */
export function updateWorkflow(game: Game, id: string, patch: WorkflowPatch): Result {
  const a = game.state.automation;
  const wf = a.workflows[id];
  if (!wf) return fail('That workflow no longer exists.');
  if (wf.kind === 'function' && patch.enabled) return fail('Functions run when a workflow uses them; they are not switched on by themselves.');
  if (patch.nodes) {
    if (patch.nodes.length > GRAPH_LIMITS.nodes) return fail(`A workflow can have at most ${GRAPH_LIMITS.nodes} nodes.`);
    const ids = new Set<string>();
    for (const n of patch.nodes) {
      if (!NODE[n.type]) return fail(`Unknown node type “${n.type}”.`);
      if (!n.id || ids.has(n.id)) return fail('Every node needs its own id.');
      ids.add(n.id);
      if (wf.kind === 'function' && NODE[n.type].trigger) return fail('A function cannot contain triggers.');
    }
  }
  const sigBefore = patch.nodes ? triggerSig(wf.nodes) : '';
  const nodes = patch.nodes ?? wf.nodes;
  const nodeIds = new Set(nodes.map((n) => n.id));
  let edges = patch.edges ?? wf.edges;
  if (edges.length > GRAPH_LIMITS.edges) return fail(`A workflow can have at most ${GRAPH_LIMITS.edges} connections.`);
  // connections to removed nodes disappear with them
  edges = edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  if (patch.nodes) wf.nodes = patch.nodes.map((n) => ({ id: n.id, type: n.type, x: Math.round(n.x), y: Math.round(n.y), config: cleanConfig(n.config), label: n.label?.slice(0, 40) || undefined, disabled: n.disabled || undefined, group: n.group || undefined }));
  if (patch.nodes || patch.edges) wf.edges = edges.map((e) => ({ id: e.id, from: e.from, out: e.out, to: e.to, in: e.in }));
  if (patch.groups) wf.groups = patch.groups.slice(0, 30).map((g) => ({ ...g, label: g.label.slice(0, 40) }));
  if (patch.name !== undefined) wf.name = patch.name.trim().slice(0, 60) || wf.name;
  if (patch.description !== undefined) wf.description = patch.description.slice(0, 300);
  if (patch.viewport) wf.viewport = patch.viewport;
  if (patch.mode) wf.mode = patch.mode;
  if (patch.allowHighImpact !== undefined) wf.allowHighImpact = patch.allowHighImpact;
  if (patch.limits) {
    const l = { ...wf.limits, ...patch.limits };
    wf.limits = {
      runsPerHour: clamp(l.runsPerHour, 1, 120),
      actionsPerDay: clamp(l.actionsPerDay, 1, 500),
      spendPerDay: clamp(l.spendPerDay, 0, 1_000_000),
      cooldownMin: clamp(l.cooldownMin, 0, 1440),
    };
  }
  if (patch.enabled !== undefined) {
    wf.enabled = patch.enabled;
    if (patch.enabled) {
      wf.stopped = undefined;
      wf.errors = 0;
    }
  }
  const structural = !!(patch.nodes || patch.edges);
  // half-built "for at least" conditions start again: the trigger changed, or nothing was watched
  if ((patch.nodes && triggerSig(wf.nodes) !== sigBefore) || patch.enabled === false) clearPending(a, id);
  if (structural || patch.mode || patch.allowHighImpact !== undefined || patch.limits) wf.rev++;
  wf.updated = game.t;
  invalidate(game, id);
  refreshWants(game);
  return ok(undefined);
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(x) ? x : lo)));

function cleanConfig(c: Record<string, Value>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(c ?? {}).slice(0, 20)) out[k] = typeof v === 'string' ? v.slice(0, 2000) : trim(v);
  return out;
}

export function deleteWorkflow(game: Game, id: string): Result {
  const a = game.state.automation;
  const wf = a.workflows[id];
  if (!wf) return fail('That workflow no longer exists.');
  const users = Object.values(a.workflows).filter((w) => w.id !== id && w.nodes.some((n) => n.type === 'adv.function' && n.config.workflow === id));
  if (users.length) return fail(`“${users[0].name}” uses this function. Remove it there first.`);
  delete a.workflows[id];
  delete a.memory[id];
  a.order = a.order.filter((x) => x !== id);
  for (const k of Object.keys(a.schedule)) if (k.startsWith(`${id}:`) || (k.startsWith('conflict:') && k.slice(9).split('|').includes(id))) delete a.schedule[k];
  for (const p of a.proposals) if (p.wf === id && p.status === 'open') p.status = 'declined';
  invalidate(game, id);
  refreshWants(game);
  return ok(undefined);
}

export function duplicateWorkflow(game: Game, id: string): Result<string> {
  const wf = game.state.automation.workflows[id];
  if (!wf) return fail('That workflow no longer exists.');
  const copy = structuredClone(wf);
  return createWorkflow(game, { ...copy, name: `${wf.name} (copy)`, mode: 'observe' });
}

/** Move a workflow in the list. */
export function reorderWorkflow(game: Game, id: string, to: number): Result {
  const a = game.state.automation;
  if (!a.workflows[id]) return fail('That workflow no longer exists.');
  a.order = a.order.filter((x) => x !== id);
  a.order.splice(Math.max(0, Math.min(a.order.length, to)), 0, id);
  return ok(undefined);
}

export function clearMemory(game: Game, id: string): Result {
  const a = game.state.automation;
  if (!a.workflows[id]) return fail('That workflow no longer exists.');
  a.memory[id] = {};
  for (const k of Object.keys(a.schedule)) if (k.startsWith(`${id}:`)) delete a.schedule[k];
  return ok(undefined);
}
