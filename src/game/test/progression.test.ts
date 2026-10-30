// Progression bot: plays a fresh company (home zone only, no extra funds) like a sensible human for up to
// 40 game days: one good first line, then licence the best adjacent zone and run a second line into it.
import { describe, expect, it } from 'vitest';
import { newGame, stopsAlong } from './helpers.ts';
import type { Game } from '../engine.ts';
import { flatTimetable, sustainableHeadway } from '../timetable.ts';
import { licenceInfo, routeWindow, window } from '../progress.ts';
import { reconcile } from '../finance.ts';
import { MODEL } from '../content.ts';
import { TripState } from '../types.ts';
import { distanceM, type LngLat } from '../world/graph.ts';

const MAX_DAYS = 40;

function destination(from: LngLat, bearingDeg: number, metres: number): LngLat {
  const b = (bearingDeg * Math.PI) / 180;
  return [from[0] + (Math.sin(b) * metres) / (111_320 * Math.cos((from[1] * Math.PI) / 180)), from[1] + (Math.cos(b) * metres) / 110_540];
}

/** Place stops (those the rules allow), create a line, buy + assign `buses`, fit the timetable. */
function openLine(game: Game, pts: LngLat[], depot: string, buses: number) {
  const stops: string[] = [];
  for (const p of pts) {
    const r = game.placeStop(p);
    if (r.ok) stops.push(r.value);
  }
  if (stops.length < 2) return { error: `only ${stops.length} stops placeable`, stops };
  const r = game.createRoute({ stops, kind: 'linear', timetable: flatTimetable(12) });
  if (!r.ok) return { error: r.error, stops };
  const ids: string[] = [];
  for (let i = 0; i < buses; i++) {
    const b = game.buyVehicle('city12', depot);
    if (!b.ok) break;
    game.assignVehicle(b.value, r.value);
    ids.push(b.value);
  }
  if (ids.length) game.setTimetable(r.value, flatTimetable(sustainableHeadway(game.profiles.get(r.value)!, 4, ids.length)));
  return { route: r.value, stops, buses: ids, error: ids.length ? undefined : 'could not afford any bus' };
}

describe('progression bot', () => {
  const log: string[] = [];
  const blockers = new Set<string>();
  let expandedDay = -1;
  const stuck: string[] = [];
  let expansion: { zone: string; route: string } | null = null;

  const game = newGame({ allZones: false, seed: 7 });
  const home = game.state.territory.home;
  const homeZone = game.geo.zone(home)!;

  it('plays 40 days', () => {
    const s = game.state;
    expect(s.territory.owned).toEqual([home]);
    const centre = homeZone.centroid as LngLat;
    // depot near the centre of the home zone
    let depot = game.buildDepot(destination(centre, 45, 150));
    for (let a = 0; !depot.ok && a < 8; a++) depot = game.buildDepot(destination(centre, a * 45, 400));
    if (!depot.ok) throw new Error('depot: ' + depot.error);
    const depotId = depot.value;

    // first line: main-road nodes inside the home zone; the far-apart pair whose corridor yields 7-9 legal stops
    const gr = game.region.graph;
    const nodes: number[] = [];
    for (let e = 0; e < gr.m; e++) {
      if (gr.cls[e] < 2 || gr.cls[e] > 4 || (gr.flags[e] & 6)) continue;
      const v = gr.ea[e];
      if (game.geo.zoneAt([gr.lng[v], gr.lat[v]]).id === home) nodes.push(v);
    }
    const uniq = [...new Set(nodes)];
    const ll = (v: number): LngLat => [gr.lng[v], gr.lat[v]];
    const pairs: [number, number, number][] = [];
    for (let i = 0; i < uniq.length; i += 3) for (let j = i + 1; j < uniq.length; j += 3) pairs.push([uniq[i], uniq[j], distanceM(ll(uniq[i]), ll(uniq[j]))]);
    pairs.sort((x, y) => y[2] - x[2]);
    let best: LngLat[] = [];
    for (const [a, b, d] of pairs.slice(0, 400)) {
      if (d < 1000 || d > 4800) continue;
      const pts = stopsAlong(game, ll(a), ll(b), 300);
      if (pts.length >= 7 && pts.length <= 10) { best = pts; break; }
      if (pts.length > best.length) best = pts;
    }
    best = best.slice(0, 9);
    expect(best.length).toBeGreaterThanOrEqual(7);
    const first = openLine(game, best, depotId, 4);
    if (first.error && !first.buses?.length) throw new Error('first line: ' + first.error);
    const lines = [first.route!];
    log.push(`home=${homeZone.name} r+j=${homeZone.residents + homeZone.jobs} line1 stops=${first.stops.length} buses=${first.buses?.length}`);

    const homeBuses = new Set(first.buses);
    let lastDoneCheck = 0;
    for (let day = 0; day < MAX_DAYS; day++) {
      const t0 = game.t;
      // hourly steps so finished trips are harvested before the service-day roll-over prunes them
      const doneIds = new Map<number, string>();
      for (let h = 0; h < 24; h++) {
        game.run(3600);
        for (const list of Object.values(s.trips)) for (const t of list) if (t.state === TripState.Done && t.veh) doneIds.set(t.id, t.veh);
      }
      expect(s.company.status, `day ${day}`).not.toBe('bankrupt');
      expect(game.audit(), `audit day ${day}`).toEqual([]);
      expect(reconcile(s).ok).toBe(true);

      // passenger sanity
      for (const v of Object.values(s.vehicles)) {
        expect(v.load).toBeGreaterThanOrEqual(0);
        expect(v.load).toBeLessThanOrEqual(MODEL[v.model].capacity);
      }
      for (const list of Object.values(s.pax.waiting)) for (const g of list) expect(g.n).toBeGreaterThan(0);

      // no stuck vehicles: every bus that has been on a line for a full day completed trips yesterday
      if (day >= 1) {
        const done = new Map<string, number>();
        for (const veh of doneIds.values()) done.set(veh, (done.get(veh) ?? 0) + 1);
        for (const v of Object.values(s.vehicles)) {
          if (!v.route || v.bought > t0 - 0) continue;
          if (v.bought > t0 - 3600) continue;
          // weekends run a thinner timetable, so individual buses may legitimately stay parked; weekdays must all work
          if (game.isWeekend(t0 + 3600)) continue;
          if (!(done.get(v.id) ?? 0)) stuck.push(`day ${day} ${v.fleetNo} r=${v.route} status=${v.status} cond=${v.condition.toFixed(2)} since=${v.since} pos=${v.pos.kind} wk=${game.isWeekend(t0)} trip=${v.trip} next=${v.next} wants=${v.wantsService} routeVeh=${s.routes[v.route!].vehicles.length}`);
        }
      }
      lastDoneCheck = day;

      const rep = s.company.reputation;
      // expansion
      let note = '';
      if (!expansion) {
        const cands = s.territory.owned
          .flatMap((id) => game.geo.zone(id)!.neighbours)
          .filter((id, i, a) => a.indexOf(id) === i && !s.territory.owned.includes(id))
          .map((id) => licenceInfo(game, id)!)
          .filter(Boolean)
          .sort((a, b) => b.zone.residents + b.zone.jobs - (a.zone.residents + a.zone.jobs));
        const buyable = cands.find((c) => c.canBuy);
        if (buyable) {
          // a new line needs ~ stops + route fee + buses; take a loan only if that is what stands in the way
          const need = buyable.cost + 25_000 + 2 * MODEL.city12.price;
          let funds = s.finance.balance;
          if (funds < need && s.finance.loan < 400_000) {
            const want = Math.min(400_000 - s.finance.loan, need - funds);
            if (game.takeLoan(want).ok) { funds = s.finance.balance; note += ` loan+${Math.round(want)}`; }
          }
          if (s.finance.balance >= buyable.cost + 10_000) {
            game.buyLicence(buyable.zone.id);
            const z = buyable.zone;
            const from = destination(centre, 0, 0);
            let pts = stopsAlong(game, from, z.centroid as LngLat);
            const inNew = pts.filter((p) => game.geo.zoneAt(p).id === z.id);
            pts = pts.slice(-9);
            // buses: use what money allows (2, then 1)
            const o = inNew.length >= 1 ? openLine(game, pts, depotId, 2) : { error: 'no legal stops in new zone', stops: [] as string[], buses: [] as string[], route: undefined };
            if (o.error && !o.buses?.length) {
              blockers.add(`day ${day}: licence ${z.name} bought but line failed: ${o.error}`);
              note += ` LINEFAIL(${o.error})`;
            } else {
              expansion = { zone: z.id, route: o.route! };
              expandedDay = day;
              lines.push(o.route!);
              note += ` EXPAND ${z.name} stops=${o.stops.length} buses=${o.buses?.length}`;
            }
          } else blockers.add(`day ${day}: licence ${buyable.zone.name} costs ${buyable.cost} but balance ${Math.round(s.finance.balance)}`);
        } else {
          for (const c of cands.slice(0, 1)) blockers.add(`day ${day}: ${c.zone.name}: ${c.blockers.join(' ')}`);
        }
      } else if (day - expandedDay <= 3 && s.finance.balance > MODEL.city12.price + 20_000) {
        // top the new line up to 3 buses when cash allows
        const r = s.routes[expansion.route];
        if (r.vehicles.length < 3) {
          const b = game.buyVehicle('city12', depotId);
          if (b.ok) { game.assignVehicle(b.value, expansion.route); game.setTimetable(expansion.route, flatTimetable(sustainableHeadway(game.profiles.get(expansion.route)!, 4, r.vehicles.length))); }
        }
      }
      // repay loan when comfortably rich
      if (s.finance.loan > 0 && s.finance.balance > s.finance.loan + 150_000) game.repayLoan(s.finance.loan);
      // manual servicing for anything very worn when auto-service is off (it is on by default)
      if (!s.settings.autoService) for (const v of Object.values(s.vehicles)) if (v.condition < 0.5) game.serviceVehicle(v.id);

      // weekend: at least some of every line's buses ran
      if (day >= 1 && game.isWeekend(t0 + 3600)) for (const r of Object.values(s.routes)) if (r.vehicles.length) expect([...doneIds.values()].some((vid) => r.vehicles.includes(vid)), `${r.number} ran on weekend day ${day}`).toBe(true);
      // what stands between us and the next licence?
      const next = s.territory.owned
        .flatMap((id) => game.geo.zone(id)!.neighbours)
        .filter((id, i, a) => a.indexOf(id) === i && !s.territory.owned.includes(id))
        .map((id) => licenceInfo(game, id)!)
        .sort((a, b) => b.zone.residents + b.zone.jobs - (a.zone.residents + a.zone.jobs))[0];
      if (expansion && next) note += ` next=${next.zone.name}[cost ${next.cost} rep ${next.repRequired}]`;
      const w = window(s, 24);
      log.push(
        `d${String(day).padStart(2)} bal=${Math.round(s.finance.balance)} loan=${s.finance.loan} rep=${rep.toFixed(1)}->${s.company.reputation.toFixed(1)} riders=${w.trips} aband=${w.abandoned} lines=${Object.keys(s.routes).length} buses=${Object.keys(s.vehicles).length} zones=${s.territory.owned.length} sat=${(w.satisfaction ?? 0).toFixed(2)}${note}`,
      );
    }
    expect(stuck, 'buses with no completed trips on a weekday').toEqual([]);
    void lastDoneCheck; void homeBuses;
    console.log('\n' + log.join('\n') + '\nBLOCKERS:\n' + [...blockers].slice(0, 25).join('\n'));
  });

  // BALANCE: if this fails, the log above says what blocked the expansion.
  it('licenses an adjacent zone and serves it with a line that carries riders', () => {
    expect(expansion, [...blockers].slice(-5).join(' | ')).not.toBeNull();
    const rw = routeWindow(game.state, expansion!.route, 24 * (MAX_DAYS - expandedDay));
    console.log(`expansion on day ${expandedDay}, boardings since: ${rw.boardings}`);
    expect(rw.boardings).toBeGreaterThan(0);
    expect(game.state.territory.owned.length).toBeGreaterThan(1);
  });
});
