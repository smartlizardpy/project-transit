// The MCP server answers from a real save: a company runs a line for a few hours, saves, and an
// MCP client (the official SDK, over stdio like Claude Code) reads it back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildLine, newGame } from '../src/game/test/helpers.ts';
import { HOUR } from '../src/game/content.ts';
import { currencyFor } from '../src/game/currency.ts';
import { Game } from '../src/game/engine.ts';
import { AgentError, handleAgentRequest } from '../src/game/agents/api.ts';

describe('MCP server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-mcp-'));
  let game: Game;
  let client: Client;
  // live access: a stand-in for the desktop app's bridge (src-tauri/src/agent.rs), answering with
  // the game's own rules for agents
  const agentFile = join(dir, 'agent.json');
  let bridge: Server;
  let live: Game; // the running game: a copy of the saved one, so the save tools' numbers stay put
  const seen: { auth?: string; who?: string }[] = [];

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
    bridge = httpServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        const r = JSON.parse(body);
        seen.push({ auth: req.headers.authorization, who: r.who });
        if (req.headers.authorization !== 'Bearer t0ken') return res.writeHead(401).end(JSON.stringify({ ok: false, error: 'Wrong or missing token.' }));
        try {
          res.end(JSON.stringify({ ok: true, result: await handleAgentRequest(live, r.method, r.params, r.who) }));
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e instanceof AgentError ? e.message : String(e) }));
        }
      });
    });
    live = new Game(JSON.parse(game.serialize()), game.region);
    await new Promise<void>((ok) => bridge.listen(0, '127.0.0.1', ok));
    writeFileSync(agentFile, JSON.stringify({ port: (bridge.address() as AddressInfo).port, token: 't0ken' }));
    client = new Client({ name: 'claude-code', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, process.env.PT_MCP_BUNDLE ? '../dist-mcp/project-transit-mcp.mjs' : 'main.ts')], env: { ...process.env, PT_SAVES_DIR: dir, PT_AGENT_FILE: agentFile } as Record<string, string> }));
  }, 120_000); // builds a game and runs it for 5 hours first

  afterAll(async () => {
    await client?.close();
    bridge?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists tools: saves are read-only; only workflow tools change the live game', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('company_overview');
    const writes = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(writes).toEqual(['create_workflow', 'delete_workflow', 'update_workflow']);
    expect(tools.find((t) => t.name === 'delete_workflow')!.annotations?.destructiveHint).toBe(true);
  });

  it('live tools ask the running game, and build workflows only within the rules', async () => {
    const st = (await call('live_status')).data;
    expect(st).toMatchObject({ companyOpen: true, company: live.state.company.name, networkControl: false });
    expect(seen.at(-1)).toEqual({ auth: 'Bearer t0ken', who: 'Claude Code' });
    expect((await call('live_view', { what: 'lines' })).data).toHaveLength(1);
    // live means now: the save stays at 10:00 while the game runs on
    live.run(3600);
    expect((await call('live_view', { what: 'overview' })).data.gameTime.time).toBe('11:00');
    expect((await call('company_overview')).data.gameTime.time).toBe('10:00');
    const refused = await call('create_workflow', { name: 'x' });
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/Network Control is not open/);

    live.state.control.unlocked = true;
    const route = Object.keys(live.state.routes)[0];
    const made = await call('create_workflow', {
      name: 'Morning note',
      nodes: [{ id: 'n1', type: 'trigger.time', config: { time: '07:00' } }, { id: 'n2', type: 'action.notify', config: { title: 'Good morning' } }],
      edges: [{ from: 'n1', out: 'event', to: 'n2', in: 'when' }],
      enabled: true,
    });
    expect(made.error, made.text).toBe(false);
    expect(made.data).toMatchObject({ mode: 'suggest', enabled: true, valid: true });
    expect(live.state.automation.workflows[made.data.id].by).toBe('agent');
    expect(live.state.notifications.at(-1)!.title).toBe('Claude Code added the workflow “Morning note”');
    const list = (await call('list_workflows')).data.workflows;
    expect(list.map((w: { name: string; madeByAgent: boolean }) => [w.name, w.madeByAgent])).toEqual([['Morning note', true]]);
    expect((await call('get_workflow', { id: made.data.id })).data.nodes).toHaveLength(2);
    expect((await call('live_analytics', { query: { groupBy: 'line', includeToday: true } })).data.rows[0].key).toBe(route);
    expect((await call('workflow_blocks', { category: 'trigger' })).data.nodes.every((n: { trigger: boolean }) => n.trigger)).toBe(true);
    expect((await call('delete_workflow', { id: made.data.id })).data).toEqual({ deleted: made.data.id });
    live.state.control.unlocked = false;
  });

  it('says how to switch live access on when it is off', async () => {
    unlinkSync(agentFile);
    const off = await call('live_status');
    expect(off.error).toBe(true);
    expect(off.text).toMatch(/Settings → AI agents/);
    writeFileSync(agentFile, JSON.stringify({ port: (bridge.address() as AddressInfo).port, token: 'wrong' }));
    expect((await call('live_status')).text).toMatch(/Wrong or missing token/);
    writeFileSync(agentFile, JSON.stringify({ port: (bridge.address() as AddressInfo).port, token: 't0ken' }));
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

  describe('city activity tools', () => {
    // a second save: the same company with a hand-made world, so the numbers are known
    const id = 'mcp-city';
    beforeAll(() => {
      const st = JSON.parse(game.serialize());
      const t: number = st.clock.t;
      const stop = Object.values(st.stops)[0] as { lngLat: [number, number] };
      const [lng, lat] = stop.lngLat;
      st.world.places.significant = [
        { id: 'p1', name: 'Test General Hospital', category: 'hospital', lngLat: [lng + 0.001, lat], tier: 2, value: 600, unit: 'beds' },
        { id: 'p2', name: 'Far Airport', category: 'airport', lngLat: [lng + 1, lat + 1], tier: 1, value: 5_000_000, unit: 'pax_year', beyond: true },
        { id: 'p3', name: 'Test University', category: 'university', lngLat: [lng + 0.05, lat], tier: 1, value: 20000, unit: 'students' },
      ];
      const day = Math.floor(t / 86400);
      const mm = new Array(24).fill(0);
      mm[8] = 2.5;
      mm[9] = 0.6;
      st.world.weather = {
        station: 'test',
        days: [
          { day, actual: { v: 1, kind: 'rain', hi: 14, lo: 8, z: 0, mm } },
          { day: day + 1, actual: { v: 1, kind: 'clear', hi: 16, lo: 7, z: 0, mm: new Array(24).fill(0) }, forecast: { kind: 'cloudy', hi: 15, lo: 7, pop: 20, t: t - 3600 } },
        ],
      };
      st.stats.days.push({ ...st.stats.days.at(-1), day: day - 1, wx: { k: 'snow', hi: 1, lo: -4, mm: 3.2 } });
      const ev = (o: object) => ({ id: 'e', kind: 'football', place: 'p1', venue: 'Test Ground', at: [lng, lat], title: 'Derby', start: t + 3 * 3600, end: t + 5 * 3600, people: 30000, ann: 0, ...o });
      st.world.events = {
        v: 1,
        nextId: 9,
        through: day + 10,
        list: [
          ev({ id: 'e1', title: 'Announced derby' }),
          ev({ id: 'e2', title: 'Secret concert', kind: 'concert', ann: t + 1000 }),
          ev({ id: 'e3', title: 'Open-air festival', kind: 'festival', start: t + 6 * 3600, end: t + 9 * 3600, cancelled: 'storm warning' }),
          ev({ id: 'e4', title: 'Last week match', start: t - 6 * 3600, end: t - 4 * 3600, carried: 120, lost: 7 }),
        ],
      };
      const hours = new Array(24).fill(0);
      hours[8] = 30;
      hours[17] = 10;
      const k = new Array(10 * 5).fill(0);
      k[0 * 5 + 1] = 30; // commuters in the morning peak
      k[1 * 5 + 3] = 10; // students in the evening peak
      st.analytics.days = [{ day: day - 1, net: {}, stops: {}, veh: {}, od: {}, routes: { r1: { b: hours, k, bp: { '0|a': hours }, p: { '0|a': { pat: 0, stops: Object.keys(st.stops).slice(0, 3), ls: [], ln: [], rs: [], rn: [], ss: [] } } } } }];
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(st));
    });

    it('places filters, sizes and finds the nearest stop', async () => {
      const all = (await call('places', { save: id })).data;
      expect(all.total).toBe(3);
      const h = all.places.find((p: { id: string }) => p.id === 'p1');
      expect(h.size).toBe('600 beds');
      expect(h.reachable).toBe(true);
      expect(h.nearestOwnStop.metres).toBeLessThanOrEqual(500);
      const air = all.places.find((p: { id: string }) => p.id === 'p2');
      expect(air.reachable).toBe(false);
      expect(air.nearestOwnStop).toBeNull();
      expect((await call('places', { save: id, category: 'university' })).data.places).toHaveLength(1);
      expect((await call('places', { save: id, query: 'general' })).data.places[0].name).toBe('Test General Hospital');
      expect((await call('places', { save: id, limit: 1 })).data.places).toHaveLength(1);
    });

    it('weather_calendar gives today, the forecast, history and 14 days', async () => {
      const { data } = await call('weather_calendar', { save: id });
      expect(data.today.season).toBe('Autumn');
      expect(data.today.seasonWeek).toBe('Autumn, week 1');
      expect(data.weatherToday.kind).toBe('Rain');
      expect(data.weatherToday.highC).toBe(14);
      expect(data.weatherToday.rainByHour.map((x: { hour: number }) => x.hour)).toEqual([8, 9]);
      expect(data.tomorrowForecast.kind).toBe('Cloudy');
      expect(data.tomorrowForecast.chanceOfRainPct).toBe(20);
      expect(data.notes.join(' ')).toMatch(/8 forecasts in 10/);
      expect(data.lastDays.at(-1).weather).toBe('Snow');
      expect(data.next14Days).toHaveLength(14);
      expect(data.next14Days[1].day).toBe(data.next14Days[0].day + 1);
    });

    it('events hides unannounced ones and reports results', async () => {
      const { data } = await call('events', { save: id });
      const titles = (list: { title: string }[]) => list.map((e) => e.title);
      expect(titles(data.upcomingAndCurrent)).toEqual(['Announced derby', 'Open-air festival']);
      expect(data.upcomingAndCurrent[1].cancelled).toBe(true);
      expect(data.upcomingAndCurrent[1].cancelledBecause).toBe('storm warning');
      expect(JSON.stringify(data)).not.toMatch(/Secret concert/);
      expect(data.recent[0].journeysOnYourBuses).toBe(120);
      expect(data.recent[0].gaveUpOrStranded).toBe(7);
      expect(titles((await call('events', { save: id, kind: 'festival' })).data.upcomingAndCurrent)).toEqual(['Open-air festival']);
    });

    it('line_character shows who rides, and says so when nothing is recorded', async () => {
      const { data } = await call('line_character', { save: id, line: '1' });
      expect(data.daysRecorded).toBe(1);
      expect(data.boardingsPerDay).toBe(40);
      expect(data.whoRides[0]).toMatchObject({ type: 'Commuter', boardings: 30, sharePct: 75 });
      expect(data.boardingsByTimeBand.find((b: { band: string }) => b.band === 'Morning peak').perDay).toBe(30);
      expect(data.busiestHour.hour).toBe('08:00');
      expect(data.busiestHourByDirection[0].hour).toBe('08:00');
      const none = (await call('line_character', { line: '1' })).data;
      expect(none.note).toMatch(/No detailed days recorded yet/);
      expect((await call('line_character', { save: id, line: '99' })).error).toBe(true);
    });
  });

  it('explains what went wrong instead of failing', async () => {
    expect((await call('line_details', { line: '99' })).error).toBe(true);
    const bad = await call('company_overview', { save: '../../etc/passwd' });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/not a save id/);
  });
});
