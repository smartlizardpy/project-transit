// Calibration harness: the reference scenarios the economy is tuned against (docs/economy.md).
// Each City Activity Engine phase must keep these within the agreed limits of the baseline in
// calibration-baseline.json: ±10% for riders, averaged over term-time weekdays with typical
// weather (docs/city-activity-engine-plan.md, section 11). Run with `pnpm calibrate`.
import { newGame, stopsAlong, crowdedLine } from './helpers.ts';
import { flatTimetable, sustainableHeadway } from '../timetable.ts';
import { dayTotals } from '../finance.ts';
import { DAY, ECON, HOUR, MODEL } from '../content.ts';
import type { Game } from '../engine.ts';

/** The reference first line: Taksim → Karaköy on real İstanbul streets, City 12 buses. */
export function referenceLine(stopCount: number, buses: number) {
  const game = newGame({ allZones: true });
  const d = game.buildDepot([28.9805, 41.0335]);
  if (!d.ok) throw new Error(d.error);
  const pts = stopsAlong(game, [28.9858, 41.0369], [28.9707, 41.0172]).slice(0, stopCount);
  const stops = pts.map((p) => game.placeStop(p)).filter((r) => r.ok).map((r) => (r as { value: string }).value);
  const r = game.createRoute({ stops, timetable: flatTimetable(12) });
  if (!r.ok) throw new Error(r.error);
  const ids = Array.from({ length: buses }, () => game.buyVehicle('city12', d.value)).filter((b) => b.ok).map((b) => (b as { value: string }).value);
  ids.forEach((b) => game.assignVehicle(b, r.value));
  game.setTimetable(r.value, flatTimetable(sustainableHeadway(game.profiles.get(r.value)!, 4, ids.length)));
  return { game, route: r.value, buses: ids };
}

export interface Metrics {
  [k: string]: number;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Daily figures from the recorded daily rows (days 1…n-1; day 0 starts at 05:00). */
function daily(game: Game, days: number) {
  const rows = game.state.stats.days.filter((d) => d.day >= 1 && d.day < days);
  const weekday = rows.filter((d) => !game.isWeekend(d.day * DAY + 12 * HOUR));
  const weekend = rows.filter((d) => game.isWeekend(d.day * DAY + 12 * HOUR));
  return { rows, weekday, weekend };
}

export const SCENARIOS: Record<string, () => Metrics> = {
  /** 8 stops, 4 × City 12, a week. economy.md: ~3,000 riders a day, about +3,800 a day. */
  reference() {
    const { game } = referenceLine(8, 4);
    for (let day = 0; day < 7; day++) game.run(24 * HOUR);
    const { rows, weekday, weekend } = daily(game, 7);
    return {
      ridersWeekday: avg(weekday.map((d) => d.trips)),
      ridersWeekend: avg(weekend.map((d) => d.trips)),
      boardingsPerDay: avg(rows.map((d) => d.boardings)),
      resultPerDay: avg(rows.map((d) => dayTotals(game.state, d.day).result)),
      satisfaction: avg(rows.map((d) => d.satisfaction)),
    };
  },
  /** The same 4 buses on 3 stops must lose money. */
  thin() {
    const { game } = referenceLine(3, 4);
    for (let day = 0; day < 3; day++) game.run(24 * HOUR);
    return { ridersDay2: game.state.stats.days.find((d) => d.day === 2)?.trips ?? 0, resultDay2: dayTotals(game.state, 2).result };
  },
  /** Automation scenario 3: small buses on a busy corridor, morning peak load above 80%. */
  crowded() {
    const game = newGame({ seed: 21, extraFunds: 1_000_000, allZones: true });
    game.state.company.reputation = 85;
    game.setFare(ECON.fareMin);
    const line = crowdedLine(game);
    // live line occupancy every 15 minutes, as the automation's line node reads it (automation/live.ts)
    const occupancy = () => {
      const running = game.state.routes[line.route].vehicles.map((v) => game.state.vehicles[v]).filter((v) => (v.status === 'in_service' || v.status === 'at_stop') && v.pos.kind === 'pattern');
      return running.length ? running.reduce((a, v) => a + v.load / MODEL[v.model].capacity, 0) / running.length : 0;
    };
    game.run(6 * HOUR - game.t);
    let peak = 0;
    for (let i = 0; i < 12; i++) {
      game.run(15 * 60);
      peak = Math.max(peak, occupancy());
    }
    const rd = game.state.analytics.today.routes[line.route];
    return { peakLoad: peak, boardings0609: rd ? rd.b.slice(6, 9).reduce((a, b) => a + b, 0) : 0 };
  },
};

/** How far each figure may move from the baseline (fraction), and figures with a hard floor. */
export const TOLERANCE: Record<string, number> = {
  'reference.ridersWeekday': 0.1,
  'reference.ridersWeekend': 0.15,
  'reference.boardingsPerDay': 0.1,
  'reference.resultPerDay': 0.2,
};
export const FLOORS: Record<string, (v: number) => boolean> = {
  'reference.resultPerDay': (v) => v > 0,
  'reference.satisfaction': (v) => v > 0.6,
  'thin.resultDay2': (v) => v < 0,
  'crowded.peakLoad': (v) => v > 0.8,
};
