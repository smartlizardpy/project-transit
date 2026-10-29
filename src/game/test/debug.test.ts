import { it } from 'vitest';
import { newGame, stopsAlong } from './helpers.ts';
import { dayTotals } from '../finance.ts';
import { flatTimetable, sustainableHeadway } from '../timetable.ts';
import { window } from '../progress.ts';

it('balance: a new company with no test funding, 10 days', () => {
  const game = newGame({ allZones: true });
  const d = game.buildDepot([28.9805, 41.0335]);
  if (!d.ok) throw new Error(d.error);
  const stops = stopsAlong(game, [28.9858, 41.0369], [28.9707, 41.0172]).map((p) => game.placeStop(p)).filter((r) => r.ok).map((r) => (r as { value: string }).value);
  const r = game.createRoute({ stops, timetable: flatTimetable(12) });
  if (!r.ok) throw new Error(r.error);
  const buses = [0, 1, 2, 3].map(() => game.buyVehicle('city12', d.value)).filter((b) => b.ok).map((b) => (b as { value: string }).value);
  buses.forEach((b) => game.assignVehicle(b, r.value));
  const hw = sustainableHeadway(game.profiles.get(r.value)!, 4, buses.length);
  game.setTimetable(r.value, flatTimetable(hw));
  console.log(`${stops.length} stops, ${buses.length} buses, headway ${hw} min, warnings: ${game.patterns.get(r.value)!.flatMap((p) => p.warnings).join(' / ')}`);
  console.log('balance after setup', Math.round(game.state.finance.balance));
  for (let day = 0; day < 10; day++) {
    game.run(24 * 3600);
    const t = dayTotals(game.state, day);
    const w = window(game.state, 24);
    console.log(`day ${day}: pax ${w.trips} lost ${w.abandoned} sat ${(w.satisfaction ?? 0).toFixed(2)} ontime ${(w.ontime ?? 0).toFixed(2)} load ${(w.load ?? 0).toFixed(2)} | income ${Math.round(t.income)} operating ${Math.round(t.operating)} result ${Math.round(t.result)} | balance ${Math.round(game.state.finance.balance)} rep ${game.state.company.reputation.toFixed(1)} cond ${buses.map((b) => game.state.vehicles[b].condition.toFixed(2)).join('/')}`);
  }
  const cats: Record<string, number> = {};
  for (let day = 1; day < 10; day++) for (const [k, v] of Object.entries(game.state.finance.daily[day] ?? {})) cats[k] = Math.round((cats[k] ?? 0) + v / 9);
  console.log('avg per day', cats);
  console.log('audit', game.audit());
  console.log(game.state.notifications.slice(-6).map((n) => `${n.tone}: ${n.title} — ${n.body ?? ''}`).join('\n'));
});
