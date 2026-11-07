// Co-op guarantee: a game loaded from a save at any second reacts to a player's actions exactly as
// the game it was saved from. A co-op guest is such a copy, and the host and guest apply the same
// actions at the same second. Anything an action reads that is not saved (a cache, a counter) shows
// up here as the two games drifting apart.
import { describe, expect, it } from 'vitest';
import { applyAction, type Action } from '../actions.ts';
import { DAY } from '../content.ts';
import { buildLine, crowdedLine, newGame } from './helpers.ts';
import { reload, simState } from './determinism.ts';

describe('actions on a loaded copy', () => {
  it('leave the copy identical to the original, mid-minute and after a change', () => {
    const g = newGame({ seed: 7, extraFunds: 2_000_000 });
    const busy = crowdedLine(g);
    const loop = buildLine(g, { from: [28.985, 41.03], stops: 6, buses: 2, headway: 15, kind: 'loop', model: 'mini8' });
    g.run(DAY + 3 * 3600 + 37); // from 05:00 to 08:00:37 the next day: morning peak, between minutes

    // a change first, so the next actions run while the game's caches are stale
    g.setFare(2.1);
    const copy = reload(g);
    expect(simState(copy)).toEqual(simState(g));

    const r = g.state.routes[busy.route];
    const shorter = r.stops.slice(0, -2);
    const moved = r.stops[2];
    const at = g.state.stops[moved].lngLat;
    const actions: Action[] = [
      { m: 'updateRoute', args: [busy.route, { kind: 'linear', stops: shorter, returnStops: null, via: {} }] },
      { m: 'buyVehicle', args: ['city12', busy.depot] },
      { m: 'assignVehicle', args: [loop.buses[0], busy.route] },
      { m: 'handoverVehicle', args: [busy.buses[0], null] },
      { m: 'setTimetable', args: [loop.route, { weekday: { bands: [{ from: 360, to: 1380, headway: 10 }] }, weekend: { bands: [{ from: 360, to: 1380, headway: 20 }] }, layover: 4 }] },
      { m: 'moveStop', args: [moved, [at[0] + 0.0004, at[1] + 0.0002]] },
      { m: 'sellVehicle', args: [loop.buses[1]] },
      { m: 'deleteRoute', args: [loop.route] },
    ];
    for (const a of actions) {
      // as on the wire: the arguments survive JSON
      const wire = JSON.parse(JSON.stringify(a)) as Action;
      const ra = applyAction(g, wire), rb = applyAction(copy, JSON.parse(JSON.stringify(a)) as Action);
      expect(rb, a.m).toEqual(ra);
      expect(simState(copy), a.m).toEqual(simState(g));
      // a few seconds pass between actions
      g.run(7);
      copy.run(7);
    }
    g.run(2 * 3600);
    copy.run(2 * 3600);
    expect(simState(copy)).toEqual(simState(g));
  }, 120_000);
});
