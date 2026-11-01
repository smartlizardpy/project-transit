// Loop lines: people can get to a stop before theirs by staying with the line round the loop.
// Before this, a loop's return journeys (from a later stop back to an earlier one) had no
// itinerary, so travellers who went out on a loop were stranded when they set off home.
import { describe, expect, it } from 'vitest';
import { newGame, buildLine } from './helpers.ts';
import { changesOf } from '../analytics/record.ts';
import { itineraryLabel } from '../analytics/query.ts';

const sum = (x?: number[]) => (x ?? []).reduce((p, q) => p + q, 0);

describe('loop lines', () => {
  it('reach the stops behind you by going round the loop, without counting a change', () => {
    const game = newGame({ extraFunds: 1_000_000 });
    const { stopIds, route } = buildLine(game, { stops: 7, buses: 3, headway: 12, kind: 'loop' });
    game.run(3 * 3600); // 05:00 → 08:00: the timetable runs
    const dm = game.demand;
    const S = dm.stops.length;
    const at = (id: string) => dm.index.get(id)!;
    // from the fifth stop back to the second
    const it = dm.itin.get(at(stopIds[4]) * S + at(stopIds[1]));
    expect(it, 'an itinerary round the loop').toBeTruthy();
    expect(it!.legs.map((l) => l.r)).toEqual([route, route]);
    expect(it!.legs[0].a).toBe(stopIds[0]); // through the terminus
    expect(it!.legs[1].a).toBe(stopIds[1]);
    expect(it!.transfers).toBe(0);
    expect(changesOf(it!.legs)).toBe(0);
    // forwards is still one leg
    expect(dm.itin.get(at(stopIds[1]) * S + at(stopIds[4]))!.legs).toHaveLength(1);
    // a change onto another line, or a walk to another stop, still counts
    expect(changesOf([{ r: 'a' }, { r: 'b' }])).toBe(1);
    expect(changesOf([{ r: 'a' }, { r: 'a', b: 's9' }])).toBe(1);
    expect(itineraryLabel(game, `${route}.${stopIds[0]}.${route}`)).toBe(`Line ${game.state.routes[route].number} → round the loop through ${game.state.stops[stopIds[0]].name}`);
  });

  it('strand about as few travellers as a two-way line on the same streets', () => {
    const run = (kind: 'loop' | 'linear') => {
      const game = newGame({ extraFunds: 1_000_000 });
      const { route } = buildLine(game, { stops: 7, buses: 3, headway: 12, kind });
      game.run(18 * 3600); // 05:00 → 23:00 (the analytics day turns at midnight)
      const net = game.state.analytics.today.net;
      const round = Object.entries(game.state.analytics.today.od).filter(([k]) => k.split('>')[2] === `${route}.${k.split('>')[2].split('.')[1]}.${route}`);
      return { journeys: sum(net.j), stranded: sum(net.sd), round: round.reduce((n, [, arr]) => n + arr.filter((_, i) => i % 5 === 1).reduce((p, q) => p + q, 0), 0), xf: net.xf };
    };
    const loop = run('loop'), line = run('linear');
    // measured: loop 3 stranded (40 before the fix), two-way 3
    expect(loop.stranded).toBeLessThanOrEqual(Math.max(10, 2 * line.stranded));
    expect(loop.round, 'journeys completed round the loop').toBeGreaterThan(0);
    expect(loop.xf, 'going round the loop is not a change').toBe(0);
  });
});
