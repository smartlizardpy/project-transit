// The automation executor. Plain TypeScript, separate from React, run by the game on game time.
//
// - Schedules and conditions are checked once per game minute; simulation events are queued and
//   handled at the next minute. Pausing the game pauses automation; speeding it up speeds it up.
// - A run evaluates the nodes downstream of the trigger that fired (and the data they need) in a
//   fixed order, so the same state always gives the same result.
// - Actions go through the shared command checks (commands.ts) and then the safety rules here:
//   limits, cooldowns, duplicates, conflicts between workflows, and the workflow's mode.

import type { Game } from '../engine.ts';
import type { ActionOutcome, ActionRecord, AutomationState, Mode, NodeTrace, Proposal, RunRecord, Value, Workflow } from './types.ts';
import { NODE, OFF, isOff, trim, triggerLabel, type Flow, type NodeCtx } from './registry.ts';
import { validateWorkflow, GRAPH_LIMITS, type Validation } from './validate.ts';
import { LiveData, type Rec } from './live.ts';
import { setDepartGate } from './events.ts';
import { checkCommand, runCommand, type Command } from '../commands.ts';
import { DAY, HOUR, MODEL } from '../content.ts';
import { dayTotals } from '../finance.ts';
import { hhmm, serviceDayOf, weekdayOf } from '../time.ts';
import { linePeaks, nowMinute, peakEvent, peakFireTime, nextPeakFire, timetablePeaks, type Peak } from './peaks.ts';
import { notify } from '../progress.ts';
import { waitingAt } from '../passengers.ts';
import { dayMatches, eventKindMatches, forecastMatches, linesNearEvent, weatherChangeMatches, weatherRecs } from './city.ts';
import { actualEnd, type GameEvent } from '../events.ts';
import { CONDITION_LABEL, hourCondition } from '../weather.ts';
import { FIGURE, REPEAT_PER, condStep, firedKey, gaveUpLastHour, markFired, pendingKey, repeatOk, shortOf, busesAvailable, busesNeededNow, timeOk, watchTest, watchedItems } from './watch.ts';

export const RUN_LIMITS = {
  /** node evaluations and list items handled per run */
  work: 5000,
  /** actions requested per run */
  actions: 10,
  /** workflow runs per game minute, all workflows together */
  perMinute: 30,
  /** run summaries kept, and detailed traces kept per workflow */
  history: 300,
  traces: 3,
  /** notifications a workflow may send per game hour */
  notices: 6,
  /** minutes a different workflow's action on the same thing blocks an opposite one */
  conflictMin: 24 * 60,
  /** minutes the same action by a different workflow counts as already done */
  duplicateMin: 30,
  /** minutes a suggestion stays open */
  proposalMin: 30,
  /** consecutive failed runs before a workflow is switched off */
  errors: 5,
};

export const OUTCOME_LABEL: Record<ActionOutcome, string> = {
  executed: 'Done',
  deferred: 'Done, takes effect shortly',
  observed: 'Would do',
  proposed: 'Waiting for your approval',
  rejected: 'Not possible',
  duplicate: 'Already done',
  conflict: 'Blocked: conflicts with another workflow',
  limit: 'Limit reached',
  cooldown: 'Too soon after the last time',
};

class Stop extends Error {}

// ───────────────────────────────────────────── validation cache

const validations = new WeakMap<Game, Map<string, { rev: number; game: number; v: Validation }>>();

export function validation(game: Game, wf: Workflow): Validation {
  let m = validations.get(game);
  if (!m) validations.set(game, (m = new Map()));
  const hit = m.get(wf.id);
  // re-check when the workflow or the game changes (a line it uses may have been deleted)
  if (hit && hit.rev === wf.rev && hit.game === game.rev) return hit.v;
  const v = validateWorkflow(wf, game.state);
  m.set(wf.id, { rev: wf.rev, game: game.rev, v });
  return v;
}

export function invalidate(game: Game, id?: string) {
  const m = validations.get(game);
  if (!m) return;
  if (id) m.delete(id);
  else m.clear();
}

/** Which simulation events any enabled workflow listens to. */
export function refreshWants(game: Game) {
  const a = game.state.automation;
  game.autoWants.clear();
  let delay = Infinity, occ = Infinity;
  if (!a.paused) {
    for (const wf of Object.values(a.workflows)) {
      if (!wf.enabled || wf.kind !== 'workflow') continue;
      for (const n of wf.nodes) {
        const src = !n.disabled ? NODE[n.type]?.trigger?.source : undefined;
        if (src && src !== 'clock' && src !== 'condition' && src !== 'manual') game.autoWants.add(src);
        if (src === 'depart' && n.type === 'trigger.late') delay = Math.min(delay, Number(n.config.minutes) || 5);
        if (src === 'depart' && n.type === 'trigger.crowded') occ = Math.min(occ, Number(n.config.load) || 85);
        if (src === 'depart' && n.type !== 'trigger.late' && n.type !== 'trigger.crowded') delay = occ = 0;
      }
    }
  }
  setDepartGate(game, delay, occ);
}

// ───────────────────────────────────────────── one run

export interface RunOptions {
  /** a test run: nothing in the game changes, actions are only described */
  test?: boolean;
  /** override the mode (Simulation Lab) */
  mode?: Mode;
  allowHighImpact?: boolean;
  /** an unsaved copy from the editor: validate it afresh instead of using the cache */
  draft?: boolean;
}

interface RunState {
  game: Game;
  wf: Workflow;
  mode: Mode;
  test: boolean;
  allowHigh: boolean;
  run: RunRecord;
  work: number;
  live: LiveData;
  /** target+key acted on in this run */
  seen: Set<string>;
  memory: Record<string, Value>;
}

export function runWorkflow(game: Game, wf: Workflow, trigger: { node: string | null; event: Rec; label: string }, opts: RunOptions = {}): RunRecord {
  const a = game.state.automation;
  const test = !!opts.test;
  const run: RunRecord = {
    id: test ? -1 : ++a.counters.run,
    wf: wf.id,
    t: game.t,
    trigger: trigger.node ?? 'manual',
    triggerLabel: trigger.label,
    mode: opts.mode ?? wf.mode,
    status: 'ok',
    evaluated: 0,
    actions: [],
    trace: [],
    test: test || undefined,
  };
  const val = opts.draft ? validateWorkflow(wf, game.state) : validation(game, wf);
  if (!val.ok) {
    run.status = 'error';
    run.error = `The workflow has problems: ${val.issues.find((i) => i.level === 'error')?.message ?? 'see the editor'}`;
    return finish(game, wf, run, test);
  }
  const memory = test ? structuredClone(a.memory[wf.id] ?? {}) : (a.memory[wf.id] ??= {});
  const rs: RunState = { game, wf, mode: run.mode, test, allowHigh: opts.allowHighImpact ?? wf.allowHighImpact, run, work: 0, live: new LiveData(game), seen: new Set(), memory };
  try {
    evaluateGraph(rs, wf, val, trigger.node, trigger.event, memory, run.trace!, 0);
  } catch (e) {
    if (e instanceof Stop) {
      run.status = 'limit';
      run.error = e.message;
    } else {
      run.status = 'error';
      run.error = e instanceof Error ? e.message : 'The run failed.';
    }
  }
  return finish(game, wf, run, test);
}

function finish(game: Game, wf: Workflow, run: RunRecord, test: boolean): RunRecord {
  if (test) return run;
  const a = game.state.automation;
  if (run.status === 'error') {
    wf.errors = (wf.errors ?? 0) + 1;
    if (wf.errors >= RUN_LIMITS.errors && wf.enabled) {
      wf.enabled = false;
      wf.stopped = `Switched off after ${wf.errors} failed runs in a row. Last problem: ${run.error}`;
      notify(game, 'warn', `Automation “${wf.name}” was switched off`, wf.stopped);
      refreshWants(game);
    }
  } else wf.errors = 0;
  a.runs.push(run);
  // keep traces only for the latest runs of each workflow
  let kept = 0;
  for (let i = a.runs.length - 1; i >= 0; i--) {
    const r = a.runs[i];
    if (r.wf !== wf.id || !r.trace) continue;
    if (++kept > RUN_LIMITS.traces) delete r.trace;
  }
  if (a.runs.length > RUN_LIMITS.history) a.runs.splice(0, a.runs.length - RUN_LIMITS.history);
  const d = dayCounts(a, wf.id, game.t);
  d.runs++;
  return run;
}

function dayCounts(a: AutomationState, wf: string, t: number) {
  const day = Math.floor(t / DAY);
  if (a.daily.day !== day) a.daily = { day, byWf: {} };
  return (a.daily.byWf[wf] ??= { runs: 0, actions: 0, spend: 0 });
}

const preview = (v: Flow): Value => (v === undefined ? null : isOff(v) ? null : trim(v as Value));

/** Evaluate a workflow graph from `start` (a trigger node; null = every node, for functions). */
function evaluateGraph(rs: RunState, wf: Workflow, val: Validation, start: string | null, event: Rec, memory: Record<string, Value>, trace: NodeTrace[], depth: number): Value {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, { from: string; out: string }>();
  for (const e of wf.edges) incoming.set(`${e.to}:${e.in}`, { from: e.from, out: e.out });
  // Every node runs, except those hanging off a trigger that did not fire: those receive OFF and
  // are skipped. Nodes not attached to any trigger (data, shared logic) run on every trigger.
  const needed = new Set(val.order);
  const values = new Map<string, Flow>();
  const game = rs.game;
  const ctxBase = (nodeId: string): NodeCtx => ({
    game, live: rs.live, event, memory,
    key: `${wf.id}:${nodeId}`,
    act: (cmd) => act(rs, nodeId, cmd),
    call: (id, inputs) => callFunction(rs, id, inputs, depth + 1),
    report: (text) => {
      (rs.run.report ??= []).push(text);
      if (!rs.test) {
        const m = (game.state.automation.memory[rs.wf.id] ??= {});
        const list = Array.isArray(m['@report']) ? (m['@report'] as Value[]) : [];
        list.push({ t: game.t, text });
        m['@report'] = list.slice(-50);
      }
    },
    notify: (tone, title, body) => notice(rs, nodeId, tone, title, body),
    spend: (n) => spend(rs, n),
  });
  let result: Value = null;
  for (const id of val.order) {
    if (!needed.has(id)) continue;
    const node = byId.get(id)!;
    const def = NODE[node.type];
    spend(rs, 1);
    rs.run.evaluated++;
    const offAll = () => { for (const p of def.outputs) values.set(`${id}:${p.id}`, OFF); };
    if (def.trigger && id !== start) {
      offAll();
      continue;
    }
    // inputs
    const inp: Record<string, Value | undefined> = {};
    let inactive = false;
    for (const p of def.inputs) {
      const src = incoming.get(`${id}:${p.id}`);
      if (!src) continue;
      const srcNode = byId.get(src.from);
      let v = values.get(`${src.from}:${src.out}`);
      if (srcNode?.disabled || v === undefined) v = OFF;
      if (isOff(v)) {
        if (node.type === 'logic.either') continue;
        inactive = true;
        break;
      }
      inp[p.id] = v === undefined ? null : (v as Value);
    }
    if (inactive) {
      offAll();
      trace.push({ node: id, status: 'inactive', note: 'Not reached: the branch before it was not taken.' });
      continue;
    }
    try {
      const res = def.run(ctxBase(id), inp, { ...defaultsFor(node.type), ...node.config }, node);
      for (const p of def.outputs) values.set(`${id}:${p.id}`, p.id in res.out ? res.out[p.id] : null);
      trace.push({ node: id, status: 'ok', inputs: Object.fromEntries(Object.entries(inp).map(([k, v]) => [k, preview(v)])), outputs: Object.fromEntries(def.outputs.map((p) => [p.id, preview(res.out[p.id])])), note: res.note });
      if (node.type === 'adv.output') result = memory['@result'] ?? null;
    } catch (e) {
      if (e instanceof Stop) throw e;
      const msg = e instanceof Error ? e.message : 'This node failed.';
      trace.push({ node: id, status: 'error', inputs: Object.fromEntries(Object.entries(inp).map(([k, v]) => [k, preview(v)])), error: msg });
      throw new Error(`${node.label || def.label}: ${msg}`);
    }
  }
  return result;
}

const defaultCache = new Map<string, Record<string, Value>>();
function defaultsFor(type: string) {
  let d = defaultCache.get(type);
  if (!d) defaultCache.set(type, (d = Object.fromEntries((NODE[type]?.config ?? []).map((f) => [f.id, f.default]))));
  return d;
}

function spend(rs: RunState, n: number) {
  rs.work += n;
  if (rs.work > RUN_LIMITS.work) throw new Stop(`Stopped: the run did more than ${RUN_LIMITS.work} steps of work. Use smaller lists or fewer nodes.`);
}

function callFunction(rs: RunState, id: string, inputs: Record<string, Value>, depth: number): Value {
  if (depth > GRAPH_LIMITS.functionDepth) throw new Error(`Functions can call each other at most ${GRAPH_LIMITS.functionDepth} deep.`);
  const fn = rs.game.state.automation.workflows[id];
  if (!fn || fn.kind !== 'function') throw new Error('That function no longer exists.');
  const val = validation(rs.game, fn);
  if (!val.ok) throw new Error(`The function “${fn.name}” has problems: ${val.issues.find((i) => i.level === 'error')?.message}`);
  const a = rs.game.state.automation;
  const memory = rs.test ? structuredClone(a.memory[fn.id] ?? {}) : (a.memory[fn.id] ??= {});
  delete memory['@result'];
  const sub: NodeTrace[] = [];
  const out = evaluateGraph(rs, fn, val, null, inputs as Rec, memory, sub, depth);
  return out;
}

// ───────────────────────────────────────────── actions and safety

function act(rs: RunState, node: string, cmd: Command): Rec {
  const { game, wf, run } = rs;
  const a = game.state.automation;
  const record = (outcome: ActionOutcome, summary: string, extra: Partial<ActionRecord> = {}): Rec => {
    const rec: ActionRecord = { node, cmd, summary, outcome, ...extra };
    run.actions.push(rec);
    return { kind: 'action', outcome, outcomeLabel: OUTCOME_LABEL[outcome], summary, reason: rec.reason ?? null, effect: rec.effect ?? null, cost: rec.cost ?? 0 };
  };
  if (run.actions.length >= RUN_LIMITS.actions) return record('limit', 'Action', { reason: `A run can ask for at most ${RUN_LIMITS.actions} actions.` });
  const check = checkCommand(game, cmd);
  if (!check.ok) return record('rejected', check.summary, { reason: check.reason });
  if (check.noop) return record('duplicate', check.summary, { reason: check.transition });
  const sig = `${check.target}|${check.key}`;
  if (rs.seen.has(sig)) return record('duplicate', check.summary, { reason: 'This run already asked for that.' });
  rs.seen.add(sig);
  const t = game.t;
  // conflicts and duplicates with other workflows
  for (let i = a.ledger.length - 1; i >= 0; i--) {
    const e = a.ledger[i];
    if (t - e.t > RUN_LIMITS.conflictMin * 60) break;
    if (e.target !== check.target || e.wf === wf.id || e.kind !== cmd.type) continue;
    // the same action is only "already done" for a short while (an extra departure can be
    // wanted again later); an opposite one blocks for the whole conflict window
    if (e.key === check.key && t - e.t > RUN_LIMITS.duplicateMin * 60) continue;
    if (e.wf === 'player') {
      if (e.key === check.key) return record('duplicate', check.summary, { reason: `You already did this by hand at ${hhmm(e.t)}.` });
      return record('conflict', check.summary, { reason: `You changed this by hand at ${hhmm(e.t)} (${describeKey(game, e.key)}). Automations do not undo your own changes for 24 game hours.` });
    }
    const other = a.workflows[e.wf]?.name ?? 'another workflow';
    if (e.key === check.key) return record('duplicate', check.summary, { reason: `“${other}” already did this at ${hhmm(e.t)}.` });
    if (!rs.test) conflictNotice(rs, e.wf, check.summary, e.t);
    return record('conflict', check.summary, { reason: `“${other}” changed this at ${hhmm(e.t)} (${describeKey(game, e.key)}). Two workflows are pulling the same thing in different directions, so this one is blocked for 24 game hours instead of undoing it.` });
  }
  for (const p of a.proposals) {
    if (p.status !== 'open' || p.wf === wf.id) continue;
    const c2 = checkCommand(game, p.cmd);
    if (p.cmd.type === cmd.type && c2.target === check.target && c2.key !== check.key) return record('conflict', check.summary, { reason: `“${a.workflows[p.wf]?.name ?? 'Another workflow'}” has an opposite suggestion waiting for your approval.` });
  }
  // cooldown for this workflow on this target
  const cool = wf.limits.cooldownMin * 60;
  for (let i = a.ledger.length - 1; i >= 0; i--) {
    const e = a.ledger[i];
    if (t - e.t > Math.max(cool, RUN_LIMITS.conflictMin * 60)) break;
    if (e.wf === wf.id && e.target === check.target && e.kind === cmd.type && t - e.t < cool) return record('cooldown', check.summary, { reason: `Last done at ${hhmm(e.t)}; this workflow waits ${wf.limits.cooldownMin} min before doing it again.` });
  }
  const d = rs.test ? { actions: 0, spend: 0 } : dayCounts(a, wf.id, t);
  if (d.actions >= wf.limits.actionsPerDay) return record('limit', check.summary, { reason: `This workflow has used its ${wf.limits.actionsPerDay} actions for today.` });
  if (check.cost > 0 && d.spend + check.cost > wf.limits.spendPerDay) return record('limit', check.summary, { reason: `This would take today's spending over the ${game.money(wf.limits.spendPerDay)} limit.`, cost: check.cost });
  // modes
  if (rs.test) return record('observed', check.summary, { reason: 'Test run: nothing was changed.', effect: check.transition, cost: check.cost });
  if (rs.mode === 'observe') return record('observed', check.summary, { reason: 'Observe mode: nothing was changed.', effect: check.transition, cost: check.cost });
  const needsApproval = rs.mode === 'suggest' || (check.impact === 'high' && !rs.allowHigh);
  if (needsApproval) {
    const dup = a.proposals.find((p) => p.status === 'open' && p.wf === wf.id && JSON.stringify(p.cmd) === JSON.stringify(cmd));
    if (dup) return record('duplicate', check.summary, { reason: 'The same suggestion is already waiting for your approval.' });
    const p: Proposal = { id: ++a.counters.proposal, wf: wf.id, node, t, expires: t + RUN_LIMITS.proposalMin * 60, cmd, summary: check.summary, detail: check.transition, impact: check.impact, status: 'open' };
    a.proposals.push(p);
    trimProposals(a);
    d.actions++;
    return record('proposed', check.summary, { reason: rs.mode === 'suggest' ? 'Suggest mode: approve it in Network Control → Automation.' : 'A big change: it needs your approval.', effect: check.transition, cost: check.cost });
  }
  game.automationActing = true;
  let r: ReturnType<typeof runCommand>;
  try {
    r = runCommand(game, cmd, wf.id);
  } finally {
    game.automationActing = false;
  }
  if (!r.ok) return record('rejected', check.summary, { reason: r.error });
  a.ledger.push({ t, wf: wf.id, target: check.target, kind: cmd.type, key: check.key, cost: check.cost });
  d.actions++;
  d.spend += check.cost;
  if (check.impact === 'high') notify(game, 'info', `Automation “${wf.name}”: ${check.summary}`, r.value.effect);
  return record(check.deferred ? 'deferred' : 'executed', check.summary, { effect: r.value.effect, cost: check.cost });
}

function describeKey(game: Game, key: string): string {
  const [k, v] = key.split(':');
  if (k === 'route') return v === 'none' ? 'made it a spare bus' : `moved it to line ${game.state.routes[v]?.number ?? '?'}`;
  if (k === 'depot') return `based it at ${game.state.depots[v]?.name ?? 'another depot'}`;
  if (k === 'timetable') return 'edited the timetable';
  if (k === 'headway') return `set every ${key.split(':').pop()} min`;
  if (k === 'suspended') return v === 'true' ? 'suspended it' : 'resumed it';
  if (k === 'fare') return `set the fare to ${v}`;
  if (k === 'cancelled') return 'cancelled it';
  if (k === 'extra_at') return 'scheduled it';
  return key;
}

function conflictNotice(rs: RunState, otherWf: string, summary: string, at: number) {
  // throttled once an hour per pair; kept in the save so a reload sends exactly the same notices
  const sched = rs.game.state.automation.schedule;
  const k = `conflict:${[rs.wf.id, otherWf].sort().join('|')}`;
  const last = sched[k] ?? -Infinity;
  if (rs.game.t - last < HOUR) return;
  sched[k] = rs.game.t;
  const other = rs.game.state.automation.workflows[otherWf]?.name ?? 'another workflow';
  notify(rs.game, 'warn', 'Two automations disagree', `“${rs.wf.name}” wanted to ${summary.charAt(0).toLowerCase() + summary.slice(1)}, but “${other}” changed the same thing at ${hhmm(at)}. Neither will undo the other. Check both in Automation Studio.`);
}

function notice(rs: RunState, node: string, tone: 'info' | 'good' | 'warn' | 'bad', title: string, body: string): Rec {
  const { game, wf, run } = rs;
  const rec = (outcome: ActionOutcome, reason?: string): Rec => {
    run.actions.push({ node, cmd: { type: 'notify', title }, summary: `Notify: ${title}`, outcome, reason });
    return { kind: 'action', outcome, outcomeLabel: OUTCOME_LABEL[outcome], summary: `Notify: ${title}`, reason: reason ?? null };
  };
  if (rs.test) return rec('observed', 'Test run: no notification sent.');
  if (rs.mode === 'observe') return rec('observed', 'Observe mode: no notification sent.');
  const recent = game.state.automation.runs.filter((r) => r.wf === wf.id && game.t - r.t < HOUR).reduce((n, r) => n + r.actions.filter((x) => x.cmd.type === 'notify' && x.outcome === 'executed').length, 0);
  if (recent >= RUN_LIMITS.notices) return rec('limit', `At most ${RUN_LIMITS.notices} notifications an hour per workflow.`);
  notify(game, tone, title, body ? `${body}` : `From “${wf.name}”.`);
  return rec('executed');
}

function trimProposals(a: AutomationState) {
  const open = a.proposals.filter((p) => p.status === 'open');
  if (open.length > 50) for (const p of open.slice(0, open.length - 50)) p.status = 'expired';
  if (a.proposals.length > 120) a.proposals.splice(0, a.proposals.length - 120);
}

// ───────────────────────────────────────────── suggestions

export function approveProposal(game: Game, id: number): { ok: true; effect: string } | { ok: false; error: string } {
  const a = game.state.automation;
  const p = a.proposals.find((x) => x.id === id);
  if (!p || p.status !== 'open') return { ok: false, error: 'That suggestion is no longer open.' };
  const check = checkCommand(game, p.cmd);
  if (!check.ok) {
    p.status = 'failed';
    p.outcome = check.reason;
    return { ok: false, error: `Things have changed: ${check.reason}` };
  }
  game.automationActing = true;
  let r: ReturnType<typeof runCommand>;
  try {
    r = runCommand(game, p.cmd, p.wf);
  } finally {
    game.automationActing = false;
  }
  if (!r.ok) {
    p.status = 'failed';
    p.outcome = r.error;
    return { ok: false, error: r.error };
  }
  p.status = 'approved';
  p.outcome = r.value.effect;
  a.ledger.push({ t: game.t, wf: p.wf, target: check.target, kind: p.cmd.type, key: check.key, cost: check.cost });
  dayCounts(a, p.wf, game.t).spend += check.cost;
  return { ok: true, effect: r.value.effect };
}

export function declineProposal(game: Game, id: number): boolean {
  const p = game.state.automation.proposals.find((x) => x.id === id);
  if (!p || p.status !== 'open') return false;
  p.status = 'declined';
  return true;
}

// ───────────────────────────────────────────── each game minute

/** Called by the game once per simulated minute. */
export function processAutomation(game: Game) {
  const a = game.state.automation;
  const t = game.t;
  for (const p of a.proposals) if (p.status === 'open' && t > p.expires) p.status = 'expired';
  while (a.ledger.length && t - a.ledger[0].t > DAY) a.ledger.shift();
  const wfs = a.order.map((id) => a.workflows[id]).filter((w): w is Workflow => !!w && w.enabled && w.kind === 'workflow');
  if (a.paused || !wfs.length) {
    a.queue.length = 0;
    return;
  }
  const hour = Math.floor(t / HOUR);
  if (a.hourly.hour !== hour) a.hourly = { hour, byWf: {} };
  let budget = RUN_LIMITS.perMinute;
  const minute = Math.floor(t / 60);
  const mod = Math.floor((t % DAY) / 60);
  const wd = weekdayOf(game.state.clock.startWeekday, t);
  // event trigger keys (`ev:` …) and repeat limits (`rp:` …) hold the time they can be forgotten
  if (mod === 0) for (const [k, v] of Object.entries(a.schedule)) if ((k.startsWith('ev:') || k.startsWith('rp:')) && v < t) delete a.schedule[k];
  const fire = (wf: Workflow, nodeId: string, event: Rec): boolean => {
    if (budget <= 0) return false;
    const n = (a.hourly.byWf[wf.id] ?? 0) + 1;
    a.hourly.byWf[wf.id] = n;
    if (n > wf.limits.runsPerHour) {
      if (n === wf.limits.runsPerHour + 1) {
        const run: RunRecord = { id: ++a.counters.run, wf: wf.id, t, trigger: nodeId, triggerLabel: 'Run limit', mode: wf.mode, status: 'limit', error: `More than ${wf.limits.runsPerHour} runs this hour: paused until ${hhmm((hour + 1) * HOUR)}.`, evaluated: 0, actions: [] };
        a.runs.push(run);
      }
      return true;
    }
    budget--;
    const node = wf.nodes.find((x) => x.id === nodeId)!;
    runWorkflow(game, wf, { node: nodeId, event: { ...event, time: hhmm(t) }, label: eventLabel(game, node, event) });
    return true;
  };

  /**
   * A condition trigger for one item this minute: fires once the condition has held for the
   * node's "for at least", then waits for it to clear. Outside its hours nothing builds up.
   */
  const cond = (wf: Workflow, node: Workflow['nodes'][number], item: string, on: boolean, off: boolean, event: () => Rec, allowed = true): boolean => {
    const k = firedKey(wf.id, node.id, item), pk = pendingKey(wf.id, node.id, item);
    if (!allowed) {
      if (a.schedule[pk] !== undefined) delete a.schedule[pk];
      if (a.schedule[k] && off) delete a.schedule[k];
      return false;
    }
    if (!condStep(a, k, pk, t, on, off, Number(node.config.for ?? 0) || 0)) return false;
    if (budget <= 0) return false; // try again next minute
    fire(wf, node.id, event());
    markFired(a, k, pk);
    return true;
  };

  // 1. clock and condition triggers
  // An enabled workflow with problems still "fires": the run is recorded as failed with the
  // reason, and after a few failures in a row the workflow switches itself off and says why.
  for (const wf of wfs) {
    for (const node of wf.nodes) {
      if (node.disabled) continue;
      const c = node.config;
      switch (node.type) {
        case 'trigger.every': {
          const every = Math.max(5, Number(c.minutes) || 15);
          if (minute % every === 0 && timeOk(game, c, t)) fire(wf, node.id, { kind: 'event', source: 'clock' });
          break;
        }
        case 'trigger.time': {
          const [hh, mm] = String(c.time ?? '07:00').split(':').map(Number);
          const days = String(c.days ?? 'all');
          if (mod === (hh || 0) * 60 + (mm || 0) && !(days === 'weekdays' && wd >= 5) && !(days === 'weekend' && wd < 5)) fire(wf, node.id, { kind: 'event', source: 'clock' });
          break;
        }
        case 'trigger.waiting': {
          const thr = Math.max(2, Number(c.threshold) || 30);
          const line = typeof c.line === 'string' && c.line ? game.state.routes[c.line] : null;
          const ids = line ? [...new Set([...line.stops, ...(line.returnStops ?? [])])] : Object.keys(game.state.stops);
          const ok = timeOk(game, c, t);
          let fired = 0;
          for (const stop of ids) {
            const w = waitingAt(game.state, stop);
            if (cond(wf, node, stop, w >= thr, w < thr * 0.7, () => ({ kind: 'event', source: 'waiting', stop, stopName: game.state.stops[stop]?.name ?? '', waiting: w, line: line?.id ?? null }), ok && fired < 3)) fired++;
          }
          break;
        }
        case 'trigger.gaveUp': {
          const thr = Math.max(1, Number(c.people) || 8);
          const line = typeof c.line === 'string' && c.line ? game.state.routes[c.line] : null;
          const ids = line ? [...new Set([...line.stops, ...(line.returnStops ?? [])])] : Object.keys(game.state.stops);
          const ok = timeOk(game, c, t);
          let fired = 0;
          for (const stop of ids) {
            const g = gaveUpLastHour(game, stop);
            const event = () => {
              const first = line ?? Object.values(game.state.routes).find((r) => r.stops.includes(stop) || r.returnStops?.includes(stop));
              return { kind: 'event', source: 'gaveUp', stop, stopName: game.state.stops[stop]?.name ?? '', gaveUp: g, line: first?.id ?? null, lineNumber: first?.number ?? '' };
            };
            if (cond(wf, node, stop, g >= thr, g < thr * 0.7, event, ok && fired < 3)) fired++;
          }
          break;
        }
        case 'trigger.shortBuses': {
          const only = typeof c.line === 'string' && c.line ? game.state.routes[c.line] : null;
          const ok = timeOk(game, c, t);
          for (const r of only ? [only] : Object.values(game.state.routes)) {
            const short = shortOf(game, r.id);
            cond(wf, node, r.id, short > 0, short === 0, () => ({ kind: 'event', source: 'shortBuses', line: r.id, lineNumber: r.number, lineName: r.name || `Line ${r.number}`, short, needed: busesNeededNow(game, r.id), buses: busesAvailable(game, r.id) }), ok);
          }
          break;
        }
        case 'trigger.watch': {
          const fig = FIGURE[String(c.figure ?? '')];
          if (!fig) break;
          const ok = timeOk(game, c, t);
          let fired = 0;
          for (const it of watchedItems(game, c)) {
            const { on, off } = watchTest(c, it.value);
            const ln = it.line ? game.state.routes[it.line] : null;
            const shown = it.value === null ? '' : fig.unit === 'money' ? game.money(it.value, { compact: true }) : fig.unit === '%' ? `${it.value}%` : `${it.value} ${fig.unit}`;
            const thr = Number(c.value) || 0;
            if (cond(wf, node, it.key, on, off, () => ({
              kind: 'event', source: 'watch', figure: fig.id, figureLabel: fig.label, scope: it.kind, itemId: it.id, name: it.name, label: it.name, value: it.value, reading: shown,
              op: String(c.op ?? 'above'), threshold: fig.unit === 'money' ? game.money(thr, { compact: true }) : fig.unit === '%' ? `${thr}%` : `${thr} ${fig.unit}`, for: Number(c.for ?? 0) || 0,
              line: it.line, lineNumber: ln?.number ?? '', stop: it.stop, stopName: it.stop ? game.state.stops[it.stop]?.name ?? '' : '', vehicle: it.vehicle,
              fleetNo: it.vehicle ? game.state.vehicles[it.vehicle]?.fleetNo ?? '' : '',
            }), ok && fired < 3)) fired++;
          }
          break;
        }
        case 'trigger.eventStart':
        case 'trigger.eventEnd': {
          // once per event, at the set time (a game loaded a little later still catches it)
          const mins = Number(c.minutes ?? (node.type === 'trigger.eventStart' ? 90 : -10)) || 0;
          for (const ev of game.eventList()) {
            if (!ev.announced || ev.cancelled) continue;
            const at = node.type === 'trigger.eventStart' ? ev.start - mins * 60 : actualEnd(ev) + mins * 60;
            if (t < at || t >= at + 15 * 60) continue;
            const k = `ev:${wf.id}:${node.id}:${ev.id}`;
            if (a.schedule[k] || !eventFilterMatches(game, c, ev)) continue;
            a.schedule[k] = actualEnd(ev) + DAY;
            fire(wf, node.id, { kind: 'event', source: node.type === 'trigger.eventStart' ? 'eventStart' : 'eventEnd', ...game.eventData(ev) });
          }
          break;
        }
        case 'trigger.peak': {
          // once per line and peak, at the set time (a game loaded a little later still catches it)
          if (!timeOk(game, c, t)) break;
          const at = String(c.at ?? 'start') === 'end' ? 'end' : 'start';
          const mins = Math.max(0, Number(c.minutes ?? 30) || 0);
          const source = String(c.source ?? 'timetable') === 'riders' ? 'riders' : 'timetable';
          const only = typeof c.line === 'string' && c.line ? game.state.routes[c.line] : null;
          const sd = serviceDayOf(t);
          for (const r of only ? [only] : Object.values(game.state.routes)) {
            if (r.suspended) continue;
            for (const p of linePeaks(game, r.id, source)) {
              const x = peakFireTime(game, p, at, mins);
              if (t < x || t >= x + 15 * 60) continue;
              const k = `ev:${wf.id}:${node.id}:${r.id}:${sd}:${p.from}:${at}`;
              if (a.schedule[k]) continue;
              if (!fire(wf, node.id, peakEvent(game, r.id, p, at))) continue;
              a.schedule[k] = t + DAY;
            }
          }
          break;
        }
        case 'trigger.calendar': {
          const [hh, mm] = String(c.time ?? '05:00').split(':').map(Number);
          if (mod !== (hh || 0) * 60 + (mm || 0)) break;
          const today = Math.floor(t / DAY), kind = String(c.day ?? 'school_holidays');
          if (!dayMatches(game, kind, today)) break;
          if (c.first !== false && dayMatches(game, kind, today - 1)) break;
          fire(wf, node.id, { kind: 'event', source: 'calendar', day: kind });
          break;
        }
        case 'trigger.balance': {
          const amt = Number(c.amount) || 0;
          const old = `${wf.id}:${node.id}`; // before trigger timing (0.3)
          if (a.schedule[old]) { a.schedule[firedKey(wf.id, node.id, 'balance')] = 1; delete a.schedule[old]; }
          const bal = game.state.finance.balance;
          cond(wf, node, 'balance', bal < amt, bal >= amt + Math.max(1000, Math.abs(amt) * 0.1), () => ({ kind: 'event', source: 'balance', balance: Math.round(bal) }));
          break;
        }
      }
    }
  }

  // 2. queued simulation events
  let i = 0;
  for (; i < a.queue.length && budget > 0; i++) {
    const ev = a.queue[i];
    for (const wf of wfs) {
      for (const node of wf.nodes) {
        if (node.disabled) continue;
        const def = NODE[node.type];
        if (def?.trigger?.source !== ev.kind) continue;
        const per = REPEAT_PER[node.type];
        if (per && !timeOk(game, node.config, ev.t)) continue;
        if (!matches(game, wf, node, ev.data)) continue;
        if (per && !repeatOk(a, wf.id, node.id, String(ev.data[per.field] ?? ''), ev.t, Number(node.config.repeat ?? 0) || 0)) continue;
        fire(wf, node.id, { kind: 'event', source: ev.kind, ...ev.data });
      }
    }
  }
  a.queue.splice(0, i);
}

/** Event triggers' settings: kind of event, size and a line near it. */
function eventFilterMatches(game: Game, c: Workflow['nodes'][number]['config'], ev: GameEvent): boolean {
  if (!eventKindMatches(String(c.kinds ?? 'crowds'), ev)) return false;
  if ((Number(c.people) || 0) > ev.people) return false;
  if (typeof c.line === 'string' && c.line && !linesNearEvent(game, ev).includes(c.line)) return false;
  return true;
}

function matches(game: Game, wf: Workflow, node: Workflow['nodes'][number], d: Record<string, string | number | boolean | null>): boolean {
  const c = node.config;
  switch (node.type) {
    case 'trigger.eventAnnounced': {
      const ev = game.eventList().find((x) => x.id === d.event);
      return !!ev && eventFilterMatches(game, c, ev);
    }
    case 'trigger.forecast': return forecastMatches(String(c.when ?? 'any'), d);
    case 'trigger.weather': {
      const h = Number(d.hour ?? 0), from = Number(c.from ?? 0), to = Number(c.to ?? 24);
      const inHours = from <= to ? h >= from && h < to : h >= from || h < to;
      return inHours && weatherChangeMatches(String(c.when ?? 'rain'), Number(d.from ?? 0), Number(d.to ?? 0));
    }
  }
  if (typeof c.line === 'string' && c.line && d.line !== c.line) return false;
  switch (node.type) {
    case 'trigger.arrive': return !(typeof c.stop === 'string' && c.stop && d.stop !== c.stop);
    case 'trigger.crowded': return Number(d.occupancy ?? 0) >= (Number(c.load) || 85);
    case 'trigger.leftBehind': return Number(d.leftBehind ?? 0) >= (Number(c.people) || 5);
    case 'trigger.late': {
      if (Number(d.delay ?? 0) < (Number(c.minutes) || 5)) return false;
      const k = `${wf.id}:${node.id}:v:${d.vehicle}`;
      const a = game.state.automation;
      if (a.schedule[k] === d.trip) return false;
      a.schedule[k] = Number(d.trip);
      return true;
    }
    default: return true;
  }
}

function eventLabel(game: Game, node: Workflow['nodes'][number], e: Rec): string {
  switch (node.type) {
    case 'trigger.arrive': return `${e.fleetNo} arrived at ${e.stopName}`;
    case 'trigger.crowded': return `${e.fleetNo} left ${e.stopName} ${e.occupancy}% full`;
    case 'trigger.late': return `${e.fleetNo} ${e.delay} min late on line ${e.lineNumber}`;
    case 'trigger.missed': return `Line ${e.lineNumber} missed the ${e.dep} departure`;
    case 'trigger.breakdown': return `${e.fleetNo} broke down`;
    case 'trigger.waiting': return `${e.waiting} waiting at ${e.stopName}`;
    case 'trigger.balance': return `Balance ${game.money(Number(e.balance) || 0, { compact: true })}`;
    case 'trigger.day': return `Day ${e.dayNumber} ended`;
    case 'trigger.week': return `Week ${e.week} ended`;
    case 'trigger.leftBehind': return `${e.leftBehind} left behind at ${e.stopName} (line ${e.lineNumber})`;
    case 'trigger.gaveUp': return `${e.gaveUp} gave up waiting at ${e.stopName}`;
    case 'trigger.peak': return e.at === 'end' ? `Line ${e.lineNumber}’s peak ${e.period} ended` : `Line ${e.lineNumber}’s peak ${e.period} is coming`;
    case 'trigger.shortBuses': return `Line ${e.lineNumber} short of ${e.short} bus${e.short === 1 ? '' : 'es'}`;
    case 'trigger.watch': return `${e.name}: ${String(e.figureLabel ?? '').toLowerCase()} ${e.reading}`;
    case 'trigger.forecast': return `Forecast for tomorrow: ${e.label}`;
    case 'trigger.weather': return `${e.label} from ${e.time ?? hhmm(game.t)}`;
    case 'trigger.eventAnnounced': return `Announced: ${e.eventTitle}, ${e.when}`;
    case 'trigger.eventStart': return `${e.eventTitle} starts at ${e.start}`;
    case 'trigger.eventEnd': return `${e.eventTitle} ends at ${e.end}`;
    default: return triggerLabel(game, node);
  }
}

/** Run a workflow now from the editor: its manual trigger, or the first trigger with a sample event. */
export function runNow(game: Game, wf: Workflow, opts: { test: boolean; node?: string; draft?: boolean }): RunRecord {
  const val = opts.draft ? validateWorkflow(wf, game.state) : validation(game, wf);
  const triggers = wf.nodes.filter((n) => !n.disabled && NODE[n.type]?.trigger);
  const node = (opts.node ? triggers.find((n) => n.id === opts.node) : null) ?? triggers.find((n) => n.type === 'trigger.manual') ?? triggers[0] ?? null;
  const event = node ? sampleEvent(game, node) : { kind: 'event', source: 'manual' };
  if (!val.ok || !node) return runWorkflow(game, wf, { node: node?.id ?? null, event, label: 'Run by hand' }, { test: opts.test, draft: opts.draft });
  return runWorkflow(game, wf, { node: node.id, event: { ...event, time: hhmm(game.t) }, label: `${opts.test ? 'Test' : 'Run by hand'}: ${eventLabel(game, node, event)}` }, { test: opts.test, draft: opts.draft });
}

/**
 * A realistic event for testing an event trigger now: taken from the current game (a bus on
 * the chosen line, its next stop), never invented numbers.
 */
export function sampleEvent(game: Game, node: Workflow['nodes'][number]): Rec {
  const s = game.state;
  const c = node.config;
  const line = typeof c.line === 'string' && c.line ? c.line : null;
  const buses = game.vehicleList().filter((v) => (line ? v.route === line : !!v.route) && v.pos.kind === 'pattern');
  const v = buses[0] ?? game.vehicleList().find((x) => (line ? x.route === line : !!x.route)) ?? null;
  const p = v && v.pos.kind === 'pattern' ? game.pattern(v.pos.route, v.pos.pat) : null;
  const stop = p ? p.stops[Math.min(v!.stopIdx, p.stops.length - 1)] : line ? s.routes[line]?.stops[0] : Object.keys(s.stops)[0];
  const r = v?.route ? s.routes[v.route] : line ? s.routes[line] : null;
  const base: Rec = { kind: 'event', source: 'test', sample: true };
  if (v) Object.assign(base, { vehicle: v.id, fleetNo: v.fleetNo, load: v.load, occupancy: Math.round(((v.sp ?? v.load) / MODEL[v.model].capacity) * 100), delay: Math.round(Math.max(0, v.delay) / 6) / 10, trip: v.trip ?? -1 });
  if (r) Object.assign(base, { line: r.id, lineNumber: r.number });
  if (stop) Object.assign(base, { stop, stopName: s.stops[stop]?.name ?? '' });
  if (node.type === 'trigger.waiting' && stop) base.waiting = waitingAt(s, stop);
  if (node.type === 'trigger.balance') base.balance = Math.round(s.finance.balance);
  if (node.type === 'trigger.missed' && r) base.dep = hhmm(game.t);
  if (node.type === 'trigger.day') Object.assign(base, daySummary(game, Math.floor(game.t / DAY) - 1));
  if (node.type === 'trigger.week') Object.assign(base, weekSummary(game));
  if (node.type === 'trigger.leftBehind') base.leftBehind = Math.max(1, Number(c.people) || 5);
  if (node.type === 'trigger.gaveUp') {
    const ids = line ? [...new Set([...(s.routes[line]?.stops ?? []), ...(s.routes[line]?.returnStops ?? [])])] : Object.keys(s.stops);
    const top = ids.map((id) => ({ id, g: gaveUpLastHour(game, id) })).sort((x, y) => y.g - x.g)[0];
    if (top) Object.assign(base, { stop: top.id, stopName: s.stops[top.id]?.name ?? '', gaveUp: top.g });
  }
  if (node.type === 'trigger.shortBuses') {
    const lines = line ? [s.routes[line]].filter(Boolean) : Object.values(s.routes);
    const top = lines.map((x) => ({ r: x, n: shortOf(game, x.id) })).sort((x, y) => y.n - x.n)[0];
    if (top) Object.assign(base, { line: top.r.id, lineNumber: top.r.number, lineName: top.r.name || `Line ${top.r.number}`, short: top.n, needed: busesNeededNow(game, top.r.id), buses: busesAvailable(game, top.r.id) });
  }
  if (node.type === 'trigger.watch') {
    const fig = FIGURE[String(c.figure ?? '')];
    const items = watchedItems(game, c).filter((x) => x.value !== null);
    const below = String(c.op ?? 'above') === 'below';
    const it = items.sort((x, y) => (below ? x.value! - y.value! : y.value! - x.value!))[0];
    if (fig && it) {
      const ln = it.line ? s.routes[it.line] : null;
      const show = (v: number) => (fig.unit === 'money' ? game.money(v, { compact: true }) : fig.unit === '%' ? `${v}%` : `${v} ${fig.unit}`);
      Object.assign(base, {
        figure: fig.id, figureLabel: fig.label, scope: it.kind, itemId: it.id, name: it.name, label: it.name, value: it.value, reading: show(it.value!),
        op: below ? 'below' : 'above', threshold: show(Number(c.value) || 0), for: Number(c.for ?? 0) || 0,
        line: it.line, lineNumber: ln?.number ?? '', stop: it.stop, stopName: it.stop ? s.stops[it.stop]?.name ?? '' : '', vehicle: it.vehicle, fleetNo: it.vehicle ? s.vehicles[it.vehicle]?.fleetNo ?? '' : '',
      });
    }
  }
  if (node.type === 'trigger.peak') {
    // the next peak this trigger would fire for, or any line's first peak today
    const nx = nextPeakFire(game, c);
    const at = c.at === 'end' ? 'end' : 'start';
    const any = nx ?? (() => {
      for (const x of line ? [s.routes[line]].filter(Boolean) : Object.values(s.routes)) {
        const pk = linePeaks(game, x.id, c.source === 'riders' ? 'riders' : 'timetable')[0] ?? timetablePeaks(game, x.id)[0];
        if (pk) return { t: game.t, line: x.id, peak: pk };
      }
      return null;
    })();
    if (any) Object.assign(base, peakEvent(game, any.line, any.peak, at), { source: 'test', sample: true });
    else {
      // no line has peak hours today: an example peak an hour from now, so a test run can go through
      const r = (line ? s.routes[line] : null) ?? Object.values(s.routes)[0];
      if (r) {
        const from = Math.ceil(nowMinute(game) / 60) * 60 + 60;
        const pk: Peak = { line: r.id, source: 'timetable', from, to: from + 120, need: Math.max(1, game.requirement(r.id)?.peak ?? r.vehicles.length), riders: null };
        Object.assign(base, peakEvent(game, r.id, pk, at), { source: 'test', sample: true, example: true });
      }
    }
  }
  // weather and events: the real forecast, weather and next event in the game
  if (node.type === 'trigger.forecast') {
    const w = weatherRecs(game);
    Object.assign(base, w.tomorrow ?? w.today);
  }
  if (node.type === 'trigger.weather') {
    const day = Math.floor(game.t / DAY), h = Math.floor((game.t % DAY) / HOUR);
    const w = game.weatherDay(day)?.actual;
    const to = w ? hourCondition(w, h) : 0, from = w && h > 0 ? hourCondition(w, h - 1) : to;
    Object.assign(base, { from, to, label: CONDITION_LABEL[to], wasLabel: CONDITION_LABEL[from], hour: h, time: hhmm(day * DAY + h * HOUR) });
  }
  if (node.type === 'trigger.eventAnnounced' || node.type === 'trigger.eventStart' || node.type === 'trigger.eventEnd') {
    const ev = game.upcomingEvents().find((x) => eventFilterMatches(game, c, x)) ?? game.upcomingEvents()[0];
    if (ev) Object.assign(base, game.eventData(ev));
  }
  return base;
}


/** The latest game week's figures and the change on the week before (for the end-of-week trigger). */
export function weekSummary(game: Game): Rec {
  const weeks = game.state.analytics.weeks ?? [];
  const w = weeks.at(-1);
  if (!w) return { week: null, days: 0, journeys: 0 };
  const prev = weeks.at(-2);
  const fares = (x: typeof w) => Math.round(x.net[4]);
  const perDay = (x: typeof w) => (x.n ? x.net[0] / x.n : 0);
  const change = (now: number, before: number | null) => (before ? Math.round(((now - before) / before) * 1000) / 10 : null);
  let busiest: { id: string; b: number } | null = null;
  for (const [id, row] of Object.entries(w.r)) if (!busiest || row[0] > busiest.b) busiest = { id, b: row[0] };
  const br = busiest ? game.state.routes[busiest.id] : null;
  return {
    week: w.w, year: w.y, season: w.season, days: w.n,
    journeys: w.net[0], gaveUp: w.net[1], fares: fares(w),
    satisfaction: w.net[3] ? Math.round((w.net[2] / w.net[3]) * 1000) / 10 : null,
    journeysPerDay: Math.round(perDay(w)),
    journeysChange: prev ? change(perDay(w), perDay(prev)) : null,
    changeText: (() => { const c = prev ? change(perDay(w), perDay(prev)) : null; return c === null ? 'the first week recorded' : `${c >= 0 ? '+' : ''}${c}% a day on the week before`; })(),
    faresChange: prev && prev.n ? change(fares(w) / w.n, fares(prev) / prev.n) : null,
    wetDays: w.wx[2] + w.wx[4],
    busiestLine: br ? br.number : null, busiestLineBoardings: busiest?.b ?? 0,
  };
}

/** The figures of a finished day (for the end-of-day trigger). */
export function daySummary(game: Game, day: number): Rec {
  const s = game.state;
  const rec = s.analytics.days.find((d) => d.day === day);
  const tot = dayTotals(s, day);
  let boardings = 0, trips = 0, ontime = 0, missed = 0;
  if (rec) for (const r of Object.values(rec.routes)) {
    for (let h = 0; h < 24; h++) { boardings += r.b[h]; trips += r.d[h]; ontime += r.o[h]; missed += r.m[h]; }
  }
  const journeys = rec ? rec.net.j.reduce((a, b) => a + b, 0) : 0;
  const gaveUp = rec ? rec.net.ab.reduce((a, b) => a + b, 0) : 0;
  return {
    dayNumber: day + 1, boardings, journeys, gaveUp, trips, missed,
    onTime: trips ? Math.round((ontime / trips) * 1000) / 10 : null,
    satisfaction: rec && rec.net.sn ? Math.round((rec.net.ss / rec.net.sn) * 1000) / 10 : null,
    fares: Math.round(tot.income), costs: Math.round(-tot.operating), result: Math.round(tot.result),
  };
}
