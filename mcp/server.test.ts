// The MCP server answers from a real save: a company runs a line for a few hours, saves, and an
// MCP client (the official SDK, over stdio like Claude Code) reads it back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildLine, newGame } from '../src/game/test/helpers.ts';
import { HOUR } from '../src/game/content.ts';
import { currencyFor } from '../src/game/currency.ts';
import type { Game } from '../src/game/engine.ts';

describe('MCP server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-mcp-'));
  let game: Game;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: !!r.isError, text: r.content[0].text, data: r.isError ? null : JSON.parse(r.content[0].text) };
  };

  beforeAll(async () => {
    game = newGame({ extraFunds: 1_000_000 });
    buildLine(game, { stops: 6, buses: 3, headway: 10 });
    game.run(5 * HOUR);
    const id = 'mcp-test';
    writeFileSync(join(dir, `${id}.json`), game.serialize());
    writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify({ id, name: 'MCP Test · Day 1', company: game.state.company.name, colour: '#000', city: 'İstanbul', day: 1, balance: 0, savedAt: Date.now(), version: 1, kind: 'manual' }));
    client = new Client({ name: 'test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, process.env.PT_MCP_BUNDLE ? '../dist-mcp/project-transit-mcp.mjs' : 'main.ts')], env: { ...process.env, PT_SAVES_DIR: dir } as Record<string, string> }));
  }, 120_000); // builds a game and runs it for 5 hours first

  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists read-only tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('company_overview');
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('reports the company as the game sees it', async () => {
    const cur = currencyFor(game.state.region.country);
    const { data } = await call('company_overview');
    expect(data.company).toBe(game.state.company.name);
    expect(data.currency).toBe(cur.code);
    expect(data.balance).toBe(Math.round(game.state.finance.balance * cur.factor));
    expect(data.network.buses).toBe(3);
    expect(data.last24h.boardings).toBeGreaterThan(0);
    expect(data.gameTime.time).toBe('10:00');
  });

  it('describes lines, buses, stops and money', async () => {
    const lines = (await call('list_lines')).data;
    expect(lines).toHaveLength(1);
    expect(lines[0].buses).toBe(3);
    expect(lines[0].headwayNowMin).toBe(10);
    const line = (await call('line_details', { line: lines[0].number })).data;
    expect(line.outboundStops).toHaveLength(6);
    expect(line.tripsInPlan.done).toBeGreaterThan(0);
    expect((await call('list_buses')).data.every((b: { line: string }) => b.line === lines[0].number)).toBe(true);
    expect((await call('list_stops')).data).toHaveLength(6);
    const money = (await call('finances')).data;
    expect(money.booksBalance).toBe(true);
    expect(money.byDay.at(-1).fares).toBeGreaterThan(0);
    expect((await call('territory')).data.squares.length).toBe(game.state.territory.owned.length);
    expect((await call('query_save', { pointer: '/routes/r1/number' })).data.value).toBe(lines[0].number);
  });

  it('explains what went wrong instead of failing', async () => {
    expect((await call('line_details', { line: '99' })).error).toBe(true);
    const bad = await call('company_overview', { save: '../../etc/passwd' });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/not a save id/);
  });
});
