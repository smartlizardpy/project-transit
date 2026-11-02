// Live access for AI agents: the requests an MCP server may make of the running game, and their
// answers. The desktop app passes requests here from its local bridge (src-tauri/src/agent.rs,
// src/app/agentBridge.ts) only while the player has switched live access on.
//
// What agents may do:
// - read the company as it is now (the same views the MCP server gives for saves),
//   Network Control analytics, and the Improve service plan;
// - build workflows in Automation Studio, test them in the Simulation Lab, and change or delete
//   the workflows they made. Their workflows run in Observe or Suggest mode only: Automatic is
//   the player's choice, made in the Studio. Workflows act through the same commands and safety
//   limits as everything else.
// They cannot change lines, buses, money or settings directly, and nothing here touches files,
// the network or the operating system.

import type { Game } from '../engine.ts';
import type { Mode, WfEdge, WfNode, Workflow } from '../automation/types.ts';
import { NODE, NODES, CATEGORIES, defaultConfig } from '../automation/registry.ts';
import { runLab, LAB_HOURS } from '../automation/lab.ts';
import { aggregate, odMatrix, estimatedDemand, type AnalyticsQuery, type OdQuery } from '../analytics/query.ts';
import { planService } from '../optimise.ts';
import { notify } from '../progress.ts';
import { hhmm, WEEKDAYS_LONG, weekdayOf } from '../time.ts';
import { DAY } from '../content.ts';
import * as view from '../../../mcp/data.ts';

export class AgentError extends Error {}
const no = (msg: string): never => { throw new AgentError(msg); };

type Params = Record<string, unknown>;
const obj = (p: unknown): Params => (p && typeof p === 'object' && !Array.isArray(p) ? (p as Params) : {});
const text = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** Modes an agent may give a workflow. */
const AGENT_MODES: Mode[] = ['observe', 'suggest'];

const VIEWS = ['overview', 'lines', 'line_details', 'buses', 'stops', 'finances', 'history', 'objectives', 'notifications', 'territory', 'places', 'weather_calendar', 'events', 'line_character'] as const;
export type ViewName = (typeof VIEWS)[number];

export const METHODS = ['status', 'view', 'analytics', 'improve_service', 'node_types', 'workflows', 'workflow', 'create_workflow', 'update_workflow', 'delete_workflow', 'test_workflow'] as const;
export type Method = (typeof METHODS)[number];

function needGame(game: Game | null): Game {
  return game ?? no('No company is open in the game. Start or load one first.');
}

function needControl(game: Game) {
  if (!game.state.control.unlocked) no('Network Control is not open yet for this company (it opens after 30 operating days at company level 3). Analytics and Automation Studio are part of it.');
}

function wfSummary(game: Game, wf: Workflow) {
  const runs = game.state.automation.runs.filter((r) => r.wf === wf.id);
  const last = runs[runs.length - 1];
  const v = game.validateWorkflow(wf.id);
  return {
    id: wf.id, name: wf.name, description: wf.description ?? '', kind: wf.kind, enabled: wf.enabled, mode: wf.mode,
    madeByAgent: wf.by === 'agent', nodes: wf.nodes.length, edges: wf.edges.length,
    valid: v?.ok ?? false, problems: (v?.issues ?? []).filter((i) => i.level === 'error').map((i) => i.message),
    stopped: wf.stopped ?? null, failedRunsInARow: wf.errors,
    lastRun: last ? { at: `day ${Math.floor(last.t / DAY) + 1} ${hhmm(last.t)}`, trigger: last.triggerLabel, status: last.status, error: last.error ?? null, actions: last.actions.map((a) => ({ what: a.summary, outcome: a.outcome })) } : null,
  };
}

function cleanGraph(p: Params): { nodes?: WfNode[]; edges?: WfEdge[] } {
  const out: { nodes?: WfNode[]; edges?: WfEdge[] } = {};
  if (p.nodes !== undefined) {
    if (!Array.isArray(p.nodes)) no('`nodes` must be a list.');
    out.nodes = (p.nodes as unknown[]).map((x, i) => {
      const n = obj(x);
      const id = text(n.id, 40) ?? `n${i + 1}`;
      const type = text(n.type, 60) ?? no(`Node ${id} has no type.`);
      // settings left out take the block's defaults, as when the player adds it in the Studio
      const config = { ...(NODE[type] ? defaultConfig(type) : {}), ...obj(n.config) } as WfNode['config'];
      return { id, type, x: Number(n.x ?? 80 + 300 * (i % 5)) || 0, y: Number(n.y ?? 80 + 170 * Math.floor(i / 5)) || 0, config, label: text(n.label, 40), disabled: n.disabled === true || undefined };
    });
  }
  if (p.edges !== undefined) {
    if (!Array.isArray(p.edges)) no('`edges` must be a list.');
    out.edges = (p.edges as unknown[]).map((x, i) => {
      const e = obj(x);
      const s = (k: string) => text(e[k], 40) ?? no(`Connection ${i + 1} needs \`${k}\`.`);
      return { id: text(e.id, 40) ?? `e${i + 1}`, from: s('from'), out: s('out'), to: s('to'), in: s('in') };
    });
  }
  return out;
}

function agentMode(v: unknown, fallback: Mode): Mode {
  if (v === undefined) return fallback;
  if (v === 'automatic') no('Agents cannot switch a workflow to Automatic. Make it in Suggest mode: the player approves each change, or switches it to Automatic in Automation Studio.');
  if (!AGENT_MODES.includes(v as Mode)) no('`mode` must be "observe" or "suggest".');
  return v as Mode;
}

function ownWorkflow(game: Game, id: unknown): Workflow {
  const wf = game.state.automation.workflows[String(id)] ?? no(`No workflow "${String(id)}". Use workflows to list them.`);
  if (wf.by !== 'agent') no(`"${wf.name}" was made by the player. Agents may read it, but change or delete only the workflows they made.`);
  return wf;
}

function nodeTypes(p: Params) {
  const cat = text(p.category, 20);
  const q = text(p.search, 60)?.toLowerCase();
  const list = NODES.filter((n) => (!cat || n.category === cat) && (!q || `${n.type} ${n.label} ${n.description}`.toLowerCase().includes(q)));
  return {
    categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, help: c.help })),
    count: list.length,
    nodes: list.map((n) => ({
      type: n.type, category: n.category, label: n.label, description: n.description,
      trigger: !!n.trigger, impact: n.action?.impact ?? null,
      inputs: n.inputs.map((x) => ({ id: x.id, type: x.type, optional: !!x.optional, list: !!x.list, help: x.help })),
      outputs: n.outputs.map((x) => ({ id: x.id, type: x.type, help: x.help })),
      config: n.config.map((f) => ({ id: f.id, kind: f.kind, default: f.default, options: f.options?.map((o) => o.value), min: f.min, max: f.max, unit: f.unit, help: f.help })),
    })),
  };
}

function planView(game: Game) {
  const plan = planService(game);
  const d = plan.diagnosis;
  return {
    note: 'A plan only: nothing has changed. The player applies it from Satisfaction → Improve service.',
    satisfactionPct: d.satisfaction === null ? null : Math.round(d.satisfaction * 100),
    breakdownPct: Object.fromEntries(['waiting', 'journeyTime', 'spaceOnBoard', 'reliability', 'fares'].map((k, i) => [k, Math.round((d.comp[i] ?? 0) * 100)])),
    averageWaitMin: Math.round(d.avgWait * 10) / 10,
    strandedPerDay: d.stranded,
    causes: d.causes.map((c) => ({ title: c.title, text: c.text })),
    lines: d.lines.map((l) => ({ line: l.number, kind: l.kind, buses: l.buses, busesNeeded: l.need, ridersPerDay: l.boardings, averageWaitMin: l.avgWait === null ? null : Math.round(l.avgWait * 10) / 10, gaveUpPerDay: l.gaveUp, leftBehindPerDay: l.leftBehind, missedPerDay: l.missed, headwayMin: l.headway })),
    steps: plan.steps.map((s) => ({ title: s.title, kind: s.kind, why: s.why, details: s.details, cost: s.cost ? game.money(s.cost) : null, waitingMinutesSavedPerDay: Math.round(s.saves), suggested: s.on })),
    notes: plan.notes,
    window: d.window,
  };
}

/** Answer one request. Throws AgentError with a message for the agent when it cannot. */
export async function handleAgentRequest(game: Game | null, method: string, params: unknown, who = 'An AI agent'): Promise<unknown> {
  const p = obj(params);
  switch (method as Method) {
    case 'status': {
      if (!game) return { companyOpen: false, note: 'No company is open in the game.' };
      const s = game.state;
      return {
        companyOpen: true, company: s.company.name, city: [s.region.city, s.region.area].filter(Boolean).join(', '),
        day: Math.floor(game.t / DAY) + 1, weekday: WEEKDAYS_LONG[weekdayOf(s.clock.startWeekday, game.t)], time: hhmm(game.t),
        paused: game.speed === 0,
        networkControl: s.control.unlocked, workflows: game.workflowList().length,
      };
    }
    case 'view': {
      const g = needGame(game);
      const what = String(p.what ?? 'overview') as ViewName;
      if (!VIEWS.includes(what)) no(`\`what\` must be one of: ${VIEWS.join(', ')}.`);
      const s = g.state;
      const line = () => view.findLine(s, String(p.line ?? '')) ?? no(`No line "${String(p.line ?? '')}". Lines: ${Object.values(s.routes).map((x) => x.number).join(', ') || 'none'}.`);
      switch (what) {
        case 'overview': return { ...view.overview(s), note: 'Live: the running game, now.' };
        case 'lines': return view.lines(s);
        case 'line_details': return view.lineDetails(s, line());
        case 'buses': return view.buses(s);
        case 'stops': return view.stops(s);
        case 'finances': return view.finances(s, Math.max(1, Math.min(60, Number(p.days ?? 7) || 7)));
        case 'history': return view.history(s);
        case 'objectives': return view.objectives(s);
        case 'notifications': return view.notifications(s, Math.max(1, Math.min(100, Number(p.limit ?? 20) || 20)), p.unreadOnly === true);
        case 'territory': return view.territory(s);
        case 'places': return view.places(s, { category: text(p.category, 40), query: text(p.query, 60), limit: typeof p.limit === 'number' ? p.limit : undefined });
        case 'weather_calendar': return view.weatherCalendar(s);
        case 'events': return view.events(s, text(p.kind, 20));
        case 'line_character': return view.lineCharacter(s, line());
      }
      return null;
    }
    case 'analytics': {
      const g = needGame(game);
      needControl(g);
      const kind = String(p.kind ?? 'aggregate');
      const q = obj(p.query);
      if (kind === 'aggregate') {
        if (!q.groupBy) no('An aggregate query needs `groupBy` (network, line, stop, vehicle, zone, day, hour, weekday, weather, daykind, eventday or type).');
        const r = aggregate(g, q as unknown as AnalyticsQuery);
        return { ...r, rows: r.rows.slice(0, 300), truncated: r.rows.length > 300 };
      }
      if (kind === 'od') return odMatrix(g, { level: 'stop', limit: 100, ...q } as OdQuery);
      if (kind === 'demand') return estimatedDemand(g, { level: (q.level as 'zone') ?? 'zone', view: q.view === 'unserved' ? 'unserved' : 'all', origin: text(q.origin, 60) ?? null, destination: text(q.destination, 60) ?? null, limit: Math.min(200, Number(q.limit ?? 50) || 50) });
      return no('`kind` must be "aggregate", "od" or "demand".');
    }
    case 'improve_service': return planView(needGame(game));
    case 'node_types': return nodeTypes(p);
    case 'workflows': {
      const g = needGame(game);
      return { networkControl: g.state.control.unlocked, workflows: g.workflowList().map((wf) => wfSummary(g, wf)) };
    }
    case 'workflow': {
      const g = needGame(game);
      const wf = g.state.automation.workflows[String(p.id)] ?? no(`No workflow "${String(p.id)}".`);
      return { ...wfSummary(g, wf), limits: wf.limits, nodes: wf.nodes.map(({ id, type, x, y, config, label, disabled }) => ({ id, type, x, y, config, label, disabled })), edges: wf.edges, validation: g.validateWorkflow(wf.id)?.issues ?? [] };
    }
    case 'create_workflow': {
      const g = needGame(game);
      needControl(g);
      const name = text(p.name, 60)?.trim() || no('Give the workflow a `name`.');
      const mode = agentMode(p.mode, 'suggest');
      const graph = cleanGraph(p);
      const r = g.createWorkflow({ name, description: text(p.description, 300), mode, by: 'agent', ...graph });
      if (!r.ok) no(r.error);
      const id = (r as { value: string }).value;
      const v = g.validateWorkflow(id);
      const enable = p.enabled === true && !!v?.ok;
      if (enable) g.updateWorkflow(id, { enabled: true });
      notify(g, 'info', `${who} added the workflow “${name}”`, `${mode === 'suggest' ? 'Suggest mode: you approve each change' : 'Observe mode: it only records what it would do'}. ${enable ? 'It is switched on.' : 'It is switched off until you or the agent turn it on.'} See Automation Studio.`);
      return { id, enabled: enable, mode, valid: v?.ok ?? false, issues: v?.issues ?? [], note: p.enabled === true && !enable ? 'Left switched off because it has problems: fix them with update_workflow.' : undefined };
    }
    case 'update_workflow': {
      const g = needGame(game);
      needControl(g);
      const wf = ownWorkflow(g, p.id);
      const graph = cleanGraph(p);
      let mode = p.mode === undefined ? undefined : agentMode(p.mode, wf.mode);
      // the player switched it to Automatic: new blocks need their approval again
      const backToSuggest = wf.mode === 'automatic' && (graph.nodes !== undefined || graph.edges !== undefined) && mode === undefined;
      if (backToSuggest) mode = 'suggest';
      const r = g.updateWorkflow(wf.id, { ...graph, name: text(p.name, 60), description: text(p.description, 300), mode });
      if (!r.ok) no(r.error);
      const v = g.validateWorkflow(wf.id);
      if (p.enabled !== undefined) {
        const on = p.enabled === true;
        if (on && !v?.ok) no('It has problems, so it cannot be switched on. See `issues` from workflow.');
        g.updateWorkflow(wf.id, { enabled: on });
      }
      notify(g, 'info', `${who} changed the workflow “${wf.name}”`, `${wf.enabled ? 'On' : 'Off'}, ${wf.mode} mode.${backToSuggest ? ' Its blocks changed, so it is back in Suggest mode until you switch it to Automatic again.' : ''} See Automation Studio.`);
      return { id: wf.id, enabled: wf.enabled, mode: wf.mode, valid: v?.ok ?? false, issues: v?.issues ?? [], note: backToSuggest ? 'The player had it on Automatic; changing its blocks put it back in Suggest mode.' : undefined };
    }
    case 'delete_workflow': {
      const g = needGame(game);
      const wf = ownWorkflow(g, p.id);
      const r = g.deleteWorkflow(wf.id);
      if (!r.ok) no(r.error);
      notify(g, 'info', `${who} deleted the workflow “${wf.name}”`);
      return { deleted: wf.id };
    }
    case 'test_workflow': {
      const g = needGame(game);
      needControl(g);
      const wf = g.state.automation.workflows[String(p.id)] ?? no(`No workflow "${String(p.id)}".`);
      const hours = (LAB_HOURS as readonly number[]).includes(Number(p.hours)) ? Number(p.hours) : 4;
      const r = await runLab(g, wf.id, { hours, mode: 'automatic', approveSuggestions: true, allowHighImpact: false });
      if (!r) no('The test was cancelled.');
      return { workflow: r!.name, hours, label: r!.label, without: r!.baseline, with: r!.variant, runs: r!.runs, outcomes: r!.outcomes, extras: r!.extras, notes: r!.notes, samples: r!.samples.slice(0, 6).map((x) => ({ trigger: x.triggerLabel, status: x.status, actions: x.actions.map((a) => ({ what: a.summary, outcome: a.outcome })) })) };
    }
  }
  return no(`Unknown request "${method}". Known: ${METHODS.join(', ')}.`);
}
