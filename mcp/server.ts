// Project Transit MCP server: lets AI agents read your saved games (read-only).
// Started by mcp/main.ts (stdio). The desktop app ships it as one bundled file
// (pnpm build:mcp) and Settings → AI agents copies the setup for Claude and other apps.
//
// It reads the desktop app's save folder. PT_SAVES_DIR points it somewhere else. Saves are
// snapshots: the game autosaves every few minutes and when you quit; ⌘S saves now.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GameState } from '../src/game/types.ts';
import { SAVE_VERSION } from '../src/game/types.ts';
import * as view from './data.ts';

const APP_ID = 'dev.projecttransit.prototype';

export function savesDir(): string {
  if (process.env.PT_SAVES_DIR) return process.env.PT_SAVES_DIR;
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', APP_ID, 'saves');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_ID, 'saves');
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), APP_ID, 'saves');
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

export function createServer(dir = savesDir()) {
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

  tool('query_save', 'Raw save data (money in the game\'s base unit, about euros; times in game seconds) for anything the other tools leave out, by JSON pointer (e.g. /routes/r1/timetable, /company, /pax/waiting). Large objects return their keys.', { pointer: z.string().describe('JSON pointer, starting with /') }, (s, a) => view.query(s, String(a.pointer)));

  return server;
}
