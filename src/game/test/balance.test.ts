// Balance guard rails: a sensible first line on busy real streets should cover its running costs,
// and an oversized fleet on a thin line should not. Numbers are in the base currency.
import { describe, expect, it } from 'vitest';
import { referenceLine } from './calibration.ts';
import { dayTotals } from '../finance.ts';
import { window } from '../progress.ts';
import { reconcile } from '../finance.ts';

const setup = referenceLine;

describe('economy balance', () => {
  it('a good first line covers its operating costs and the start-up money lasts', () => {
    const { game } = setup(8, 4);
    const afterSetup = game.state.finance.balance;
    expect(afterSetup).toBeGreaterThan(0);
    const results: number[] = [];
    for (let day = 0; day < 7; day++) {
      game.run(24 * 3600);
      results.push(dayTotals(game.state, day).result);
    }
    const w = window(game.state, 24);
    console.log('daily operating result', results.map(Math.round), 'riders/day', w.trips, 'satisfaction', w.satisfaction?.toFixed(2));
    // every full day (after the first partial one) is operationally profitable
    for (const r of results.slice(1)) expect(r).toBeGreaterThan(0);
    expect(w.trips).toBeGreaterThan(1500);
    expect(w.satisfaction ?? 0).toBeGreaterThan(0.6);
    expect(game.state.company.status).not.toBe('bankrupt');
    expect(reconcile(game.state).ok).toBe(true);
    expect(game.audit()).toEqual([]);
  });

  it('an oversized fleet on a short, thin line loses money', () => {
    const { game } = setup(3, 4);
    for (let day = 0; day < 3; day++) game.run(24 * 3600);
    const t = dayTotals(game.state, 2);
    console.log('thin line day 2', Math.round(t.income), Math.round(t.operating));
    expect(t.result).toBeLessThan(0);
  });
});
