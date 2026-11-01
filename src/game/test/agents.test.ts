// Live access for AI agents: what they may read and build in the running game, and what they may not.
import { describe, expect, it } from 'vitest';
import { newGame, buildLine } from './helpers.ts';
import { AgentError, handleAgentRequest } from '../agents/api.ts';
import { HOUR } from '../content.ts';
import type { Game } from '../engine.ts';

/** Every 15 minutes: an extra departure when the line is more than half full. */
const crowdWatch = (route: string) => ({
  nodes: [
    { id: 'n1', type: 'trigger.every', config: { minutes: 15 } },
    { id: 'n2', type: 'data.line', config: { line: route } },
    { id: 'n3', type: 'logic.compare', config: { op: '>', b: 50 } },
    { id: 'n4', type: 'logic.if' },
    { id: 'n5', type: 'action.dispatch', config: { line: route } },
  ],
  edges: [
    { from: 'n1', out: 'event', to: 'n2', in: 'after' },
    { from: 'n2', out: 'occupancy', to: 'n3', in: 'a' },
    { from: 'n3', out: 'result', to: 'n4', in: 'condition' },
    { from: 'n2', out: 'line', to: 'n4', in: 'value' },
    { from: 'n4', out: 'yes', to: 'n5', in: 'when' },
    { from: 'n4', out: 'yes', to: 'n5', in: 'line' },
  ],
});

const ask = (game: Game | null, method: string, params: unknown = {}) => handleAgentRequest(game, method, params, 'Claude Code') as Promise<Record<string, any>>;
const refused = async (p: Promise<unknown>, match: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e, 'should be refused').toBeInstanceOf(AgentError);
  expect((e as Error).message).toMatch(match);
};

describe('live access for AI agents', () => {
  it('reads the running game, and builds, tests and removes its own workflows within the rules', async () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const { route } = buildLine(game, { stops: 6, buses: 3, headway: 10 });
    game.run(4 * HOUR);

    expect((await ask(null, 'status')).companyOpen).toBe(false);
    await refused(ask(null, 'view'), /No company is open/);
    const st = await ask(game, 'status');
    expect(st).toMatchObject({ companyOpen: true, company: game.state.company.name, time: '09:00' });
    expect((await ask(game, 'view', { what: 'lines' })) as unknown as unknown[]).toHaveLength(1);
    expect((await ask(game, 'view', { what: 'line_details', line: game.state.routes[route].number })).outboundStops).toHaveLength(6);
    await refused(ask(game, 'view', { what: 'secrets' }), /must be one of/);
    await refused(ask(game, 'launch_missiles'), /Unknown request/);
    expect((await ask(game, 'improve_service')).note).toMatch(/nothing has changed/);
    expect((await ask(game, 'node_types', { search: 'extra departure' })).nodes.map((n: { type: string }) => n.type)).toContain('action.dispatch');

    // analytics and the Studio are Network Control features
    await refused(ask(game, 'analytics', { query: { groupBy: 'line' } }), /Network Control is not open/);
    await refused(ask(game, 'create_workflow', { name: 'x' }), /Network Control is not open/);
    game.state.control.unlocked = true;
    const a = await ask(game, 'analytics', { query: { groupBy: 'line', includeToday: true } });
    expect(a.rows.length).toBe(1);

    // agents never choose Automatic
    await refused(ask(game, 'create_workflow', { name: 'Crowding', mode: 'automatic', ...crowdWatch(route) }), /cannot switch a workflow to Automatic/);
    await refused(ask(game, 'create_workflow', { name: 'Bad', nodes: [{ id: 'n1', type: 'shell.exec' }] }), /Unknown node type/);
    expect(game.workflowList()).toHaveLength(0);
    const notes = game.state.notifications.length;
    const made = await ask(game, 'create_workflow', { name: 'Crowding', enabled: true, ...crowdWatch(route) });
    expect(made).toMatchObject({ mode: 'suggest', enabled: true, valid: true });
    const wf = game.state.automation.workflows[made.id];
    expect(wf.by).toBe('agent');
    expect(game.state.notifications.length).toBe(notes + 1);
    expect(game.state.notifications.at(-1)!.title).toBe('Claude Code added the workflow “Crowding”');
    expect((await ask(game, 'workflows')).workflows[0]).toMatchObject({ id: made.id, madeByAgent: true, valid: true });

    // a test on copies: the real company does not change
    const json = JSON.stringify(game.state);
    const t = await ask(game, 'test_workflow', { id: made.id, hours: 2 });
    expect(t.hours).toBe(2);
    expect(t.without).toBeTruthy();
    expect(t.with).toBeTruthy();
    expect(JSON.stringify(game.state)).toBe(json);

    // the player's workflows are theirs
    const mine = game.createWorkflow({ name: 'Mine' });
    expect(mine.ok).toBe(true);
    const mineId = (mine as { value: string }).value;
    await refused(ask(game, 'update_workflow', { id: mineId, name: 'Taken' }), /made by the player/);
    await refused(ask(game, 'delete_workflow', { id: mineId }), /made by the player/);
    await refused(ask(game, 'update_workflow', { id: made.id, mode: 'automatic' }), /cannot switch a workflow to Automatic/);

    // the player switched it to Automatic; changed blocks need their approval again
    game.updateWorkflow(made.id, { mode: 'automatic' });
    const changed = await ask(game, 'update_workflow', { id: made.id, ...crowdWatch(route), nodes: crowdWatch(route).nodes.map((n) => (n.id === 'n3' ? { ...n, config: { op: '>', b: 70 } } : n)) });
    expect(changed.mode).toBe('suggest');
    expect(changed.note).toMatch(/back in Suggest/);
    expect(game.state.automation.workflows[made.id].nodes.find((n) => n.id === 'n3')!.config.b).toBe(70);
    // a rename alone leaves the player's choice alone
    game.updateWorkflow(made.id, { mode: 'automatic' });
    expect((await ask(game, 'update_workflow', { id: made.id, name: 'Crowding watch' })).mode).toBe('automatic');

    expect(await ask(game, 'delete_workflow', { id: made.id })).toEqual({ deleted: made.id });
    expect(game.workflowList().map((w) => w.id)).toEqual([mineId]);
    expect(game.audit()).toEqual([]);
  });
});
