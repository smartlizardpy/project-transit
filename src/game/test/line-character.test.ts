import { describe, expect, it } from 'vitest';
import { buildLine, newGame } from './helpers.ts';
import { DAY } from '../content.ts';
import { lineCharacter, lineWhere } from '../analytics/character.ts';

describe('line character (inspector sections)', () => {
  const game = newGame({ seed: 11, extraFunds: 1_000_000 });
  const line = buildLine(game, { buses: 3, stops: 7 });
  const id = line.route;

  it('says nothing is recorded before a full day has finished', () => {
    const c = lineCharacter(game, id);
    expect(c.days).toBe(0);
    expect(c.riders).toBeNull();
  });

  it('records boardings by hour and direction that add up to the hourly boardings', () => {
    game.run(3 * DAY + 2 * 3600);
    const days = game.state.analytics.days;
    expect(days.length).toBeGreaterThan(0);
    const all = [...days, game.state.analytics.today];
    let withBp = 0;
    for (const d of all) {
      const rd = d.routes[id];
      if (!rd || !rd.bp) continue;
      withBp++;
      for (let h = 0; h < 24; h++) {
        const s = Object.values(rd.bp).reduce((a, v) => a + v[h], 0);
        expect(s).toBe(rd.b[h]);
      }
    }
    expect(withBp).toBeGreaterThan(0);
  });

  it('summarises the last days, and still works on older days without bp', () => {
    const c = lineCharacter(game, id);
    expect(c.days).toBeGreaterThan(0);
    expect(c.split).toBe(true);
    expect(c.curves.length).toBeGreaterThan(0);
    expect(c.revenue.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(lineWhere(game, id).journeys).toBeGreaterThanOrEqual(0);
    for (const d of game.state.analytics.days) if (d.routes[id]) delete d.routes[id].bp;
    const old = lineCharacter(game, id);
    expect(old.split).toBe(false);
    expect(old.curves.length).toBe(1);
    expect(old.curves[0].hours.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});
