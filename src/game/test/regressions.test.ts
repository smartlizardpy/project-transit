// Regression tests for defects found in play-testing.
import { describe, expect, it } from 'vitest';
import { Game } from '../engine.ts';
import { buildLine, newGame, region } from './helpers.ts';
import { EDGE_ONEWAY, route } from '../world/graph.ts';

describe('regressions', () => {
  it('previewing changes to an existing line does not report its own number as taken', () => {
    const game = newGame({ extraFunds: 500_000 });
    const { route } = buildLine(game, { stops: 5, buses: 1 });
    const r = game.state.routes[route];
    const pv = game.previewRoute({ stops: r.stops, kind: r.kind, number: r.number }, route);
    expect(pv.problems).toEqual([]);
    // a new line with the same number is still rejected
    expect(game.previewRoute({ stops: r.stops, kind: r.kind, number: r.number }).problems.join(' ')).toMatch(/already in use/);
  });

  it('a two-way line turns round at its terminus instead of driving on to find a loop', () => {
    const game = newGame({ extraFunds: 500_000 });
    const g = game.region.graph;
    // find two points on a two-way main road where both directions take the same street
    let found = false;
    const mains: number[] = [];
    for (let e = 0; e < g.m && mains.length < 4000; e++) if (g.cls[e] >= 2 && g.cls[e] <= 3 && !(g.flags[e] & EDGE_ONEWAY)) mains.push(g.ea[e]);
    outer: for (const a of mains)
      for (const b of mains) {
        const d = Math.hypot(g.x[b] - g.x[a], g.y[b] - g.y[a]);
        if (d < 350 || d > 600) continue;
        const ab = route(g, a, b), ba = route(g, b, a);
        if (!ab || !ba || ab.metres > d * 1.15 || Math.abs(ab.metres - ba.metres) > 30) continue;
        const sa = game.placeStop([g.lng[a], g.lat[a]]), sb = game.placeStop([g.lng[b], g.lat[b]]);
        if (!sa.ok || !sb.ok) continue;
        // a single halt at the far end, as on most two-way streets: the bus must turn round there
        const end = game.state.stops[sb.value];
        if (end.alt !== undefined && end.alt >= 0 && end.alt !== end.node) continue;
        const r = game.createRoute({ stops: [sa.value, sb.value], kind: 'linear' });
        if (!r.ok) continue;
        const [, back] = game.patterns.get(r.value)!;
        // the way back is the shortest drive from the terminus, not a loop to avoid turning round
        const start = back.path.nodes[0];
        const halts = [game.state.stops[sa.value].node, game.state.stops[sa.value].alt ?? -1].filter((h) => h >= 0);
        const shortest = Math.min(...halts.map((h) => route(g, start, h)?.metres ?? Infinity));
        expect(back.stopS[1]).toBeLessThan(shortest + 25);
        found = true;
        break outer;
      }
    expect(found).toBe(true);
  });

  it('loading a save whose operating areas were redrawn keeps the areas the company uses', () => {
    const game = newGame({ extraFunds: 500_000 });
    const stopId = buildLine(game, { stops: 3, buses: 0 }).stopIds[0];
    const state = JSON.parse(game.serialize());
    // simulate an older save: the home area had a different id
    state.territory.owned = ['z-old-area'];
    state.territory.home = 'z-old-area';
    state.stops[stopId].zone = 'z-old-area';
    const loaded = new Game(state, region());
    const valid = new Set(loaded.region.zones.map((z) => z.id));
    expect(loaded.state.territory.owned.every((id) => valid.has(id))).toBe(true);
    expect(loaded.state.territory.owned).toContain(loaded.state.stops[stopId].zone);
    expect(valid.has(loaded.state.territory.home)).toBe(true);
    expect(loaded.state.notifications.some((n) => n.title === 'Operating areas were redrawn')).toBe(true);
    expect(loaded.audit()).toEqual([]);
  });
});
