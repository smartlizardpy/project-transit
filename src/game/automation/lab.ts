// Simulation Lab: try a workflow on two copies of the company and compare them. The live game is
// never touched. Both copies start from the same moment with the same random seed; one runs
// without the workflow, the other with it, for the same game time. The figures are measured in
// those copies, not estimated, but they are one possible future: once the workflow changes
// something the copies drift apart, so small differences can be chance.

import { Game } from '../engine.ts';
import type { GameState } from '../types.ts';
import type { ActionOutcome, Mode, RunRecord } from './types.ts';
import { DAY } from '../content.ts';
import { hhmm } from '../time.ts';

export const LAB_HOURS = [2, 4, 8, 24] as const;

export interface LabMetrics {
  boardings: number;
  journeys: number;
  abandoned: number;
  trips: number;
  missed: number;
  /** % of trips on time */
  onTime: number | null;
  /** minutes */
  avgWait: number | null;
  /** % */
  avgLoad: number | null;
  /** 0–100 */
  satisfaction: number | null;
  leftBehind: number;
  fares: number;
  /** change in the bank balance over the run (fares minus every cost paid) */
  result: number;
}

export interface LabResult {
  workflow: string;
  name: string;
  mode: Mode;
  approveSuggestions: boolean;
  from: number;
  to: number;
  label: string;
  baseline: LabMetrics;
  variant: LabMetrics;
  runs: number;
  outcomes: Partial<Record<ActionOutcome, number>>;
  /** the workflow's runs that asked for something, latest first (traces removed) */
  samples: RunRecord[];
  /** extra departures it ran, in the copy */
  extras: number;
  notes: string[];
  wallMs: number;
}

export interface LabOptions {
  hours: number;
  /** 'automatic' tries the workflow as if it were allowed to act; 'current' uses its own mode */
  mode: 'automatic' | 'current';
  /** in Suggest mode (or for big changes), approve every suggestion in the copy */
  approveSuggestions: boolean;
  /** allow big changes in the copy */
  allowHighImpact: boolean;
}

interface Totals {
  boardings: number; trips: number; ontime: number; missed: number; fares: number; deps: number; load: number;
  journeys: number; abandoned: number; waitSum: number; waitN: number; satS: number; satN: number; leftBehind: number; balance: number;
}

/** Totals of everything recorded from day `d0` to now. Differences of two snapshots give a window. */
function totals(state: GameState, d0: number): Totals {
  const a = state.analytics;
  const t: Totals = { boardings: 0, trips: 0, ontime: 0, missed: 0, fares: 0, deps: 0, load: 0, journeys: 0, abandoned: 0, waitSum: 0, waitN: 0, satS: 0, satN: 0, leftBehind: 0, balance: state.finance.balance };
  const recs = [...a.days.filter((d) => d.day >= d0), a.today];
  const sum = (x: number[]) => x.reduce((p, q) => p + q, 0);
  for (const rec of recs) {
    for (const r of Object.values(rec.routes)) {
      t.boardings += sum(r.b);
      t.trips += sum(r.d);
      t.ontime += sum(r.o);
      t.missed += sum(r.m);
      t.fares += sum(r.rv);
      t.deps += sum(r.dp);
      t.load += sum(r.lf);
      t.waitSum += r.ws;
      t.waitN += r.wn;
      t.leftBehind += r.lb;
    }
    t.journeys += sum(rec.net.j);
    t.abandoned += sum(rec.net.ab);
    t.satS += rec.net.ss;
    t.satN += rec.net.sn;
  }
  return t;
}

function metrics(a: Totals, b: Totals): LabMetrics {
  const d = (k: keyof Totals) => b[k] - a[k];
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const trips = d('trips'), deps = d('deps'), waitN = d('waitN'), satN = d('satN');
  return {
    boardings: d('boardings'),
    journeys: d('journeys'),
    abandoned: d('abandoned'),
    trips,
    missed: d('missed'),
    onTime: trips ? r1((d('ontime') / trips) * 100) : null,
    avgWait: waitN ? r1(d('waitSum') / waitN) : null,
    avgLoad: deps ? r1((d('load') / deps) * 100) : null,
    satisfaction: satN ? r1((d('satS') / satN) * 100) : null,
    leftBehind: d('leftBehind'),
    fares: Math.round(d('fares') * 100) / 100,
    result: Math.round(d('balance') * 100) / 100,
  };
}

const CHUNK = 15 * 60;

/**
 * Run the comparison. Yields to the browser between chunks so the game stays responsive;
 * `cancelled()` stops it early (the result is then not returned).
 */
export async function runLab(game: Game, workflowId: string, opts: LabOptions, progress?: (done: number) => void, cancelled?: () => boolean): Promise<LabResult | null> {
  const wf = game.state.automation.workflows[workflowId];
  if (!wf) throw new Error('That workflow no longer exists.');
  if (wf.kind !== 'workflow') throw new Error('Try the workflow that uses this function.');
  const started = performance.now();
  const hours = Math.max(1, Math.min(24, Math.round(opts.hours)));
  const json = JSON.stringify(game.state);
  const base = new Game(JSON.parse(json) as GameState, game.region);
  const test = new Game(JSON.parse(json) as GameState, game.region);
  base.updateWorkflow(workflowId, { enabled: false });
  const mode: Mode = opts.mode === 'automatic' ? 'automatic' : wf.mode;
  test.updateWorkflow(workflowId, { enabled: true, mode, allowHighImpact: opts.allowHighImpact || wf.allowHighImpact });
  const from = game.t, to = from + hours * 3600;
  const d0 = Math.floor(from / DAY);
  const t0b = totals(base.state, d0), t0t = totals(test.state, d0);
  const runStart = test.state.automation.counters.run;
  for (let t = from; t < to; t += CHUNK) {
    if (cancelled?.()) return null;
    const step = Math.min(CHUNK, to - t);
    base.run(step);
    test.run(step);
    if (opts.approveSuggestions) {
      for (const p of test.state.automation.proposals) if (p.status === 'open' && p.wf === workflowId) test.approveProposal(p.id);
    }
    progress?.((t + step - from) / (to - from));
    await new Promise((r) => setTimeout(r, 0));
  }
  const runs = test.state.automation.runs.filter((r) => r.wf === workflowId && r.id > runStart);
  const outcomes: Partial<Record<ActionOutcome, number>> = {};
  for (const r of runs) for (const a of r.actions) outcomes[a.outcome] = (outcomes[a.outcome] ?? 0) + 1;
  const extras = runs.reduce((n, r) => n + r.actions.filter((a) => a.cmd.type === 'dispatch_extra' && a.outcome === 'executed').length, 0)
    + test.state.automation.proposals.filter((p) => p.wf === workflowId && p.status === 'approved' && p.cmd.type === 'dispatch_extra' && p.t >= from).length;
  const notes: string[] = [
    'Both copies start now with the same random seed. Other workflows run in both.',
    'Figures are measured in the copies over the same game time. Once the workflow changes something the two futures drift apart, so small differences can be chance.',
  ];
  if (wf.mode === 'observe' && opts.mode === 'current') notes.push('This workflow is in Observe mode, so in the copy it only records what it would do: both copies behave the same.');
  if (outcomes.proposed && !opts.approveSuggestions) notes.push(`${outcomes.proposed} suggestion${outcomes.proposed === 1 ? '' : 's'} were left unanswered in the copy. Tick “Approve suggestions” to see their effect.`);
  if (runs.some((r) => r.status === 'error')) notes.push('Some runs failed in the copy; see the run list.');
  return {
    workflow: workflowId,
    name: wf.name,
    mode,
    approveSuggestions: opts.approveSuggestions,
    from,
    to,
    label: `${hhmm(from)} to ${hhmm(to)}${hours >= 24 ? ' the next day' : to % DAY < from % DAY ? ' (next day)' : ''}`,
    baseline: metrics(t0b, totals(base.state, d0)),
    variant: metrics(t0t, totals(test.state, d0)),
    runs: runs.length,
    outcomes,
    samples: runs.filter((r) => r.actions.length).slice(-20).reverse().map((r) => ({ ...r, trace: undefined })),
    extras,
    notes,
    wallMs: Math.round(performance.now() - started),
  };
}
