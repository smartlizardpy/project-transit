// Project Transit MCP server: lets AI agents read your saved games, and, with live access on,
// the running game. Started by mcp/main.ts (stdio). The desktop app ships it as one bundled file
// (pnpm build:mcp) and Settings → AI agents copies the setup for Claude and other apps.
//
// Save tools read the desktop app's save folder (read-only). PT_SAVES_DIR points them somewhere
// else. Saves are snapshots: the game autosaves every few minutes and when you quit; ⌘S saves now.
//
// Live tools (live_*, and the workflow tools) ask the running game through its local bridge while
// the player has Settings → AI agents → Live access on. They read the game as it is now and build
// workflows in Automation Studio, in Observe or Suggest mode only. PT_AGENT_FILE points them at
// another connection file.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GameState } from '../src/game/types.ts';
import { SAVE_VERSION } from '../src/game/types.ts';
import * as view from './data.ts';
import { agentName, askLive } from './live.ts';

const APP_ID = 'dev.projecttransit.prototype';

/** The desktop app's data folder. */
function appDir(): string {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', APP_ID);
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_ID);
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), APP_ID);
}

export function savesDir(): string {
  return process.env.PT_SAVES_DIR || join(appDir(), 'saves');
}

/** Where the running game says how to reach it (only while live access is on). */
export function agentFile(): string {
  return process.env.PT_AGENT_FILE || join(appDir(), 'agent.json');
}

interface Meta {
  id: string;
  name: string;
  company: string;
  city: string;
  day: number;
  savedAt: number;
  kind: 'manual' | 'auto';
}

const VALID_ID = /^[a-z0-9_-]{1,64}$/;

function listMeta(dir: string): Meta[] {
  if (!existsSync(dir)) return [];
  const out: Meta[] = [];
  for (const f of readdirSync(dir)) {
    const id = f.endsWith('.meta.json') ? f.slice(0, -'.meta.json'.length) : null;
    if (!id || !VALID_ID.test(id)) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Meta);
    } catch {
      // a half-written meta file: skip it
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** The save's game state; falls back to the backup copy like the game does. */
function readSave(dir: string, id: string): GameState {
  if (!VALID_ID.test(id)) throw new Error(`"${id}" is not a save id. Use list_saves to see them.`);
  for (const f of [`${id}.json`, `${id}.json.bak`]) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as GameState;
      if (s.version > SAVE_VERSION) throw new Error(`This save is from a newer version of the game (save version ${s.version}). Update the project.`);
      return s;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('This save')) throw e;
    }
  }
  throw new Error(`Save "${id}" was not found or could not be read.`);
}

export function createServer(dir = savesDir(), liveFile = agentFile()) {
  const server = new McpServer({ name: 'project-transit', version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev' });

  const pick = (save?: string): { state: GameState; meta: Meta | null } => {
    const metas = listMeta(dir);
    if (save) {
      const meta = metas.find((m) => m.id === save) ?? metas.find((m) => m.company.toLowerCase() === save.toLowerCase()) ?? null;
      return { state: readSave(dir, meta?.id ?? save), meta };
    }
    if (!metas.length) throw new Error(`No saved games in ${dir}. Play the desktop app and save (⌘S), or set PT_SAVES_DIR.`);
    return { state: readSave(dir, metas[0].id), meta: metas[0] };
  };
  const reply = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });
  const saveArg = z.string().optional().describe('Save id from list_saves, or a company name. Default: the most recent save.');
  const ro = { readOnlyHint: true, openWorldHint: false };

  /** A tool that reads one save. */
  type Args = Record<string, unknown> & { save?: string };
  const tool = (name: string, description: string, shape: z.ZodRawShape, run: (state: GameState, args: Args, meta: Meta | null) => unknown) => {
    const inputSchema: z.ZodRawShape = { save: saveArg, ...shape };
    server.registerTool(name, { description, inputSchema, annotations: ro }, async (args: Args) => {
      try {
        const { state, meta } = pick(args.save);
        return reply(run(state, args, meta));
      } catch (e) {
        return fail(e);
      }
    });
  };

  server.registerTool(
    'list_saves',
    { description: 'List the saved games (newest first) with company, city, game day and when they were saved.', annotations: ro },
    async () => reply({ folder: dir, saves: listMeta(dir).map((m) => ({ id: m.id, name: m.name, company: m.company, city: m.city, day: m.day, kind: m.kind, savedAt: new Date(m.savedAt).toISOString() })) }),
  );

  tool('company_overview', 'The state of a bus company: money, reputation, passengers and satisfaction over the last 24 game hours, network size, and today\'s and yesterday\'s results. Start here.', {}, (s, _a, meta) => view.overview(s, meta?.savedAt));

  tool('list_lines', 'Every bus line with its buses, current frequency, riders, punctuality, crowding, satisfaction and profit.', {}, (s) => view.lines(s));

  tool('line_details', 'One line in full: stops in order with waiting passengers, timetable, buses on it, trips today and money by day.', { line: z.string().describe('Line id (r1), number (1) or name') }, (s, a) => {
    const r = view.findLine(s, String(a.line));
    if (!r) throw new Error(`No line "${a.line}". Lines: ${Object.values(s.routes).map((x) => `${x.number} ${x.name}`.trim()).join('; ') || 'none'}.`);
    return view.lineDetails(s, r);
  });

  tool('list_buses', 'The fleet: model, capacity, status, line, depot, condition, mileage, passengers on board and delay.', {}, (s) => view.buses(s));

  tool('list_stops', 'All stops (busiest first) with the lines serving them and passengers waiting now.', {}, (s) => view.stops(s));

  tool('finances', 'Balance, loan, income and costs by day and category, and the latest ledger entries.', { days: z.number().int().min(1).max(60).optional().describe('How many days back (default 7)') }, (s, a) => view.finances(s, Number(a.days ?? 7)));

  tool('daily_history', 'One row per finished game day: journeys, riders, gave-ups, satisfaction, punctuality, revenue, costs, reputation and balance.', {}, (s) => view.history(s));

  tool('objectives', 'Company objectives with progress and rewards.', {}, (s) => view.objectives(s));

  tool('notifications', 'Recent in-game notifications (newest first).', { limit: z.number().int().min(1).max(100).optional(), unreadOnly: z.boolean().optional() }, (s, a) => view.notifications(s, Number(a.limit ?? 20), a.unreadOnly === true));

  tool('territory', 'The map squares (about 2 km across) the company is licensed to operate in, with their centres, stops and depots.', {}, (s) => view.territory(s));

  tool('places', 'Significant places on the map (airports, stations, hospitals, universities, stadiums, malls and more) with size, position and the nearest of your stops within 500 m.', { category: z.string().optional().describe('Category, e.g. airport, hospital, university, stadium'), query: z.string().optional().describe('Part of the name'), limit: z.number().int().min(1).max(300).optional().describe('Default 50') }, (s, a) => view.places(s, { category: a.category as string | undefined, query: a.query as string | undefined, limit: a.limit as number | undefined }));

  tool('weather_calendar', "Today's season, week and day type, today's weather, tomorrow's forecast, the last 14 days' weather and the next 14 days' calendar.", {}, (s) => view.weatherCalendar(s));

  tool('events', 'Announced events not yet over (soonest first) and recent ones with results: journeys on your buses and people who gave up or were stranded. Unannounced events are never shown.', { kind: z.enum(['football', 'concert', 'festival', 'gathering', 'rail', 'flight']).optional() }, (s, a) => view.events(s, a.kind as string | undefined));

  tool('line_character', 'Who rides a line and when, from the last 7 recorded days: riders by type, boardings by time band and the busiest hour.', { line: z.string().describe('Line id (r1), number (1) or name') }, (s, a) => {
    const r = view.findLine(s, String(a.line));
    if (!r) throw new Error(`No line "${a.line}". Lines: ${Object.values(s.routes).map((x) => `${x.number} ${x.name}`.trim()).join('; ') || 'none'}.`);
    return view.lineCharacter(s, r);
  });

  registerLive(server, liveFile, reply, fail);

  tool('query_save', 'Raw save data (money in the game\'s base unit, about euros; times in game seconds) for anything the other tools leave out, by JSON pointer (e.g. /routes/r1/timetable, /company, /pax/waiting). Large objects return their keys.', { pointer: z.string().describe('JSON pointer, starting with /') }, (s, a) => view.query(s, String(a.pointer)));

  return server;
}

type Reply = (data: unknown) => { content: { type: 'text'; text: string }[] };
type Fail = (e: unknown) => { isError: boolean; content: { type: 'text'; text: string }[] };

const lineArg = z.string().describe('Line id (r1), number (1) or name');
const nodeShape = z.object({
  id: z.string().describe('Your id for the block, unique in the workflow (e.g. n1)'),
  type: z.string().describe('Block type from workflow_blocks, e.g. trigger.every'),
  config: z.record(z.string(), z.unknown()).optional().describe('Settings by id (see workflow_blocks); left out = the default'),
  label: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  disabled: z.boolean().optional(),
});
const edgeShape = z.object({
  from: z.string().describe('Block id the value comes from'),
  out: z.string().describe('Output id on that block'),
  to: z.string().describe('Block id it goes to'),
  in: z.string().describe('Input id on that block'),
});
const graphArgs = {
  nodes: z.array(nodeShape).optional().describe('Every block in the workflow (replaces the current ones)'),
  edges: z.array(edgeShape).optional().describe('Every connection (replaces the current ones)'),
};

/** Tools that ask the running game (live access). */
function registerLive(server: McpServer, file: string, reply: Reply, fail: Fail) {
  const who = () => agentName(server.server.getClientVersion()?.name);
  const ro = { readOnlyHint: true, openWorldHint: false };
  const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const live = (name: string, description: string, shape: z.ZodRawShape, method: string, annotations: Record<string, boolean> = ro, params: (a: Record<string, unknown>) => unknown = (a) => a) =>
    server.registerTool(name, { description, inputSchema: shape, annotations }, async (args: Record<string, unknown>) => {
      try {
        return reply(await askLive(file, method, params(args ?? {}), who()));
      } catch (e) {
        return fail(e);
      }
    });

  live('live_status', 'LIVE: whether the desktop game is running with live access on, the company open, its game day and time, and whether Network Control (analytics, Automation Studio) is open. Start here for live tools.', {}, 'status');

  live('live_view', 'LIVE: the running game as it is now, not a save. Same views as the save tools: overview, lines, line_details (needs line), buses, stops, finances (days), history, objectives, notifications (limit, unreadOnly), territory, places (category, query, limit), weather_calendar, events (kind), line_character (needs line).', {
    what: z.enum(['overview', 'lines', 'line_details', 'buses', 'stops', 'finances', 'history', 'objectives', 'notifications', 'territory', 'places', 'weather_calendar', 'events', 'line_character']),
    line: lineArg.optional(),
    days: z.number().int().min(1).max(60).optional(),
    limit: z.number().int().min(1).max(300).optional(),
    unreadOnly: z.boolean().optional(),
    category: z.string().optional(),
    query: z.string().optional(),
    kind: z.string().optional(),
  }, 'view');

  live('live_analytics', 'LIVE: Network Control analytics from the running game (needs Network Control open). kind "aggregate": query { groupBy: network|line|stop|vehicle|zone|day|hour|weekday|weather|daykind|eventday|type, days?: {last: N} or {from, to}, includeToday?, hours?: [from, to], dayType?: all|weekday|weekend, weekday?: 0-6 (0 = Monday), lines?: [ids], stops?: [ids] } gives every measure per row (boardings, journeys, gave up, waits, load, punctuality, revenue, costs...). kind "od": where journeys go, query { level: stop|zone, days?, includeToday?, lines?, origin?, destination?, limit? }. kind "demand": estimated travel demand, query { level: zone, view?: all|unserved, origin?, destination?, limit? }.', {
    kind: z.enum(['aggregate', 'od', 'demand']).optional().describe('Default aggregate'),
    query: z.record(z.string(), z.unknown()).describe('See the description'),
  }, 'analytics');

  live('live_improve_service', 'LIVE: why passengers are unhappy (waiting, journey time, crowding, reliability, fares), line by line, and the plan the game\'s Improve service would suggest: moving or buying buses, timetables fitted to the buses, shorter routes. Read-only: the player applies a plan in the game (Satisfaction → Improve service).', {}, 'improve_service');

  live('workflow_blocks', 'LIVE: the Automation Studio blocks you can build workflows from: type, inputs, outputs and settings. Filter by category (trigger, data, logic, math, state, action, advanced) or a search word.', {
    category: z.enum(['trigger', 'data', 'logic', 'math', 'state', 'action', 'advanced']).optional(),
    search: z.string().optional(),
  }, 'node_types');

  live('list_workflows', 'LIVE: the workflows in Automation Studio with mode, on/off, whether they are valid, who made them and their last run.', {}, 'workflows');

  live('get_workflow', 'LIVE: one workflow in full: blocks with settings, connections, limits and any problems.', { id: z.string().describe('Workflow id from list_workflows') }, 'workflow');

  live('create_workflow', 'LIVE: build a workflow in Automation Studio in the running game. It runs in Suggest mode (the player approves each change) or Observe mode (it only records what it would do): agents cannot choose Automatic. Its actions follow the same rules and limits as the player\'s. The player is told. enabled: true switches it on if it has no problems. Get block types and ports from workflow_blocks first.', {
    name: z.string().max(60),
    description: z.string().max(300).optional(),
    mode: z.enum(['suggest', 'observe']).optional().describe('Default suggest'),
    enabled: z.boolean().optional(),
    ...graphArgs,
  }, 'create_workflow', writes);

  live('update_workflow', 'LIVE: change a workflow you made (not the player\'s): blocks, connections, name, mode (suggest or observe) or on/off. If the player had switched it to Automatic, changing its blocks puts it back in Suggest mode.', {
    id: z.string(),
    name: z.string().max(60).optional(),
    description: z.string().max(300).optional(),
    mode: z.enum(['suggest', 'observe']).optional(),
    enabled: z.boolean().optional(),
    ...graphArgs,
  }, 'update_workflow', writes);

  live('delete_workflow', 'LIVE: delete a workflow you made (not the player\'s).', { id: z.string() }, 'delete_workflow', { ...writes, destructiveHint: true });

  live('test_workflow', 'LIVE: try a workflow in the Simulation Lab: plays the next 2, 4, 8 or 24 game hours on two copies of the company, without and with the workflow running automatically, and compares them. The real game is not changed.', {
    id: z.string(),
    hours: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(24)]).optional().describe('Default 4'),
  }, 'test_workflow', { readOnlyHint: true, openWorldHint: false });
}
