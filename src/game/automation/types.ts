// Automation Studio data model. Workflows are graphs of typed nodes saved with the company.
// The executor (executor.ts) runs them on game time, never on wall-clock timers.

import type { Command } from '../commands.ts';

/** Values that flow between nodes. Records are plain objects (a line, stop, bus, row). */
export type Value = null | number | string | boolean | Value[] | { [k: string]: Value };

export type Mode = 'observe' | 'suggest' | 'automatic';

export interface WfNode {
  id: string;
  type: string;
  x: number;
  y: number;
  config: Record<string, Value>;
  /** player label shown on the node instead of the type name */
  label?: string;
  disabled?: boolean;
  /** group the node belongs to */
  group?: string;
}

export interface WfEdge {
  id: string;
  from: string;
  out: string;
  to: string;
  in: string;
}

export interface WfGroup {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WfLimits {
  /** runs started per game hour */
  runsPerHour: number;
  /** actions executed (or proposed) per game day */
  actionsPerDay: number;
  /** money the workflow may commit per game day (extra departures, services) */
  spendPerDay: number;
  /** minimum game minutes between two actions of the same kind on the same target */
  cooldownMin: number;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  /** a function is a reusable sub-workflow called by a Function node; it has no triggers of its own */
  kind: 'workflow' | 'function';
  enabled: boolean;
  mode: Mode;
  /** high-impact actions (timetable, fare, suspension, line changes) may run automatically */
  allowHighImpact: boolean;
  nodes: WfNode[];
  edges: WfEdge[];
  groups: WfGroup[];
  limits: WfLimits;
  viewport?: { x: number; y: number; zoom: number };
  created: number;
  updated: number;
  rev: number;
  /** consecutive failed runs (the workflow is switched off at 5) */
  errors: number;
  /** why the game switched it off, if it did */
  stopped?: string;
}

export interface QueuedEvent {
  t: number;
  kind: string;
  data: Record<string, string | number | boolean | null>;
}

export type TraceStatus = 'ok' | 'inactive' | 'error' | 'disabled';

/** What a node did in one run, for the debugger. Values are trimmed previews. */
export interface NodeTrace {
  node: string;
  status: TraceStatus;
  inputs?: Record<string, Value>;
  outputs?: Record<string, Value>;
  /** plain-language explanation, e.g. "86% > 80% → true" */
  note?: string;
  error?: string;
}

export type ActionOutcome = 'executed' | 'observed' | 'proposed' | 'rejected' | 'deferred' | 'duplicate' | 'conflict' | 'limit' | 'cooldown';

/** Notifications are recorded like actions but are not game commands. */
export type NotifyAction = { type: 'notify'; title: string };

export interface ActionRecord {
  node: string;
  cmd: Command | NotifyAction;
  summary: string;
  outcome: ActionOutcome;
  /** why it was not executed, or what will happen (transition) */
  reason?: string;
  /** what changed, in the game's words */
  effect?: string;
  cost?: number;
}

export interface RunRecord {
  id: number;
  wf: string;
  t: number;
  trigger: string;
  /** e.g. "Every 15 minutes" or "Bus 12 arrived at Vefa" */
  triggerLabel: string;
  mode: Mode;
  status: 'ok' | 'error' | 'limit';
  error?: string;
  /** nodes evaluated */
  evaluated: number;
  actions: ActionRecord[];
  /** node trace: kept for the latest runs of each workflow only */
  trace?: NodeTrace[];
  /** run from the editor's Test button: nothing executed */
  test?: boolean;
  /** lines written by "Add to report" nodes */
  report?: string[];
  /** a run that carried on after a Wait or One-at-a-time node */
  resumed?: boolean;
}

export interface Proposal {
  id: number;
  wf: string;
  node: string;
  t: number;
  /** proposals expire: conditions change */
  expires: number;
  cmd: Command;
  summary: string;
  detail?: string;
  impact: 'low' | 'high';
  status: 'open' | 'approved' | 'declined' | 'expired' | 'failed';
  outcome?: string;
}

/** Actions taken recently, for cooldowns, conflicts, duplicates and daily limits. */
export interface LedgerEntry {
  t: number;
  wf: string;
  /** e.g. `vehicle:v3`, `route:r2` */
  target: string;
  kind: string;
  /** opposing actions on the same target conflict (e.g. assign to r1 vs assign to r2) */
  key: string;
  cost: number;
}

/**
 * A workflow paused at a "Wait" or "One at a time" node. Each game minute the executor checks it
 * and, when it is due, carries on from that node: only the steps after it run.
 */
export interface Pending {
  id: number;
  wf: string;
  node: string;
  kind: 'wait' | 'queue';
  /** wait: when it carries on (or gives up, for "until"); queue: the next release */
  due: number;
  /** when the workflow started waiting */
  from: number;
  /** the run's trigger event, so the steps after it can still read it */
  event: Record<string, Value>;
  /** what the Wait node passes on */
  value?: Value;
  /** waiting until a figure crosses a value (the item is a line, stop or bus id) */
  until?: { figure: string; item: string | null; op: 'above' | 'below'; value: number };
  /** what it is waiting for, in words ("Line 3") */
  label: string;
  /** one wait per node and item */
  key: string;
  /** set when it carries on */
  outcome?: 'then' | 'timeout';
}

export interface AutomationState {
  v: 1;
  workflows: Record<string, Workflow>;
  order: string[];
  /** workflow memory: values a workflow keeps between runs */
  memory: Record<string, Record<string, Value>>;
  /** last time a schedule trigger fired, by `${workflow}:${node}` */
  schedule: Record<string, number>;
  queue: QueuedEvent[];
  proposals: Proposal[];
  runs: RunRecord[];
  ledger: LedgerEntry[];
  /** per day: runs, actions and spend per workflow */
  daily: { day: number; byWf: Record<string, { runs: number; actions: number; spend: number }> };
  /** runs started this hour per workflow (rate limit) */
  hourly: { hour: number; byWf: Record<string, number> };
  counters: { run: number; proposal: number; workflow: number; node: number; pending?: number };
  /** game-wide switch: pause every workflow */
  paused: boolean;
  /** workflows waiting at a Wait or One-at-a-time node (missing on older saves) */
  pending?: Pending[];
}

export const DEFAULT_LIMITS: WfLimits = { runsPerHour: 60, actionsPerDay: 40, spendPerDay: 2000, cooldownMin: 30 };

export function emptyAutomation(): AutomationState {
  return {
    v: 1,
    workflows: {},
    order: [],
    memory: {},
    schedule: {},
    queue: [],
    proposals: [],
    runs: [],
    ledger: [],
    daily: { day: -1, byWf: {} },
    hourly: { hour: -1, byWf: {} },
    counters: { run: 0, proposal: 0, workflow: 0, node: 0 },
    paused: false,
  };
}
