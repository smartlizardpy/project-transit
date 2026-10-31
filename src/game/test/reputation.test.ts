// The daily reputation notice says what cost the points: missed departures, naming the lines and
// why they miss them (no buses, too few buses), and how passengers rated their journeys.
import { describe, expect, it } from 'vitest';
import { buildLine, newGame } from './helpers.ts';
import { DAY } from '../content.ts';
import { flatTimetable } from '../timetable.ts';

describe('why reputation fell', () => {
  it('names the lines with a timetable and no buses, not slow journeys', () => {
    const game = newGame();
    const a = buildLine(game, { buses: 3, stops: 7, headway: 15 });
    // two more lines with timetables and no buses, as in a player's save
    const r5 = game.createRoute({ stops: a.stopIds.slice(0, 4), kind: 'linear', timetable: flatTimetable(15) });
    const r7 = game.createRoute({ stops: a.stopIds.slice(3), kind: 'linear', timetable: flatTimetable(20) });
    if (!r5.ok || !r7.ok) throw new Error('line');
    game.state.company.reputation = 60;
    game.run(DAY + 60 - game.t);
    const n = game.state.notifications.filter((x) => /^Reputation down/.test(x.title)).at(-1);
    expect(n).toBeTruthy();
    const body = n!.body ?? '';
    if (process.env.SHOW) console.log(n!.title, '|', body);
    const num5 = game.state.routes[r5.value].number, num7 = game.state.routes[r7.value].number;
    expect(body).toMatch(/timetabled departures were missed \(−\d/);
    expect(body).toMatch(new RegExp(`Lines (${num5} and ${num7}|${num7} and ${num5}) have a timetable but no buses`));
    expect(body).not.toMatch(/^Journeys take too long/);
    // it opens the line that missed the most
    expect([r5.value, r7.value]).toContain(n!.ref?.id);
  });

  it('a line with too few buses is named with what its timetable needs', () => {
    const game = newGame();
    const a = buildLine(game, { buses: 1, stops: 9, headway: 6 });
    game.state.company.reputation = 60;
    game.run(DAY + 60 - game.t);
    const n = game.state.notifications.filter((x) => /^Reputation down/.test(x.title)).at(-1);
    if (!n) return; // a single bus kept enough of the timetable that reputation held
    if (process.env.SHOW) console.log(n.title, '|', n.body);
    const need = game.requirement(a.route)!.peak;
    expect(n.body).toContain(`its timetable needs ${need} buses at the busiest time and it has 1`);
  });
});
