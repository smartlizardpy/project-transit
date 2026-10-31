// Operational commands shared by the player UI and automations. Every command can be checked
// without changing anything (a dry run with a plain-language explanation of what would happen)
// and is executed through the same Game methods the player uses, so automations follow exactly
// the same rules: no teleporting, no invented buses, capacity and depot limits, routing, money.

import type { Game, Result } from './engine.ts';
import type { Id, Timetable } from './types.ts';
import { ECON, MODEL } from './content.ts';
import { requirement } from './timetable.ts';
import { hhmm } from './time.ts';
import { workEnds } from './vehicles.ts';

export type Command =
  | { type: 'assign_vehicle'; vehicle: Id; route: Id | null; after?: 'trips' | 'now' }
  | { type: 'schedule_extra'; route: Id; at: number; pat?: number; vehicle?: Id }
  | { type: 'dispatch_extra'; route: Id; pat?: number; vehicle?: Id }
  | { type: 'set_headway'; route: Id; minutes: number; band?: number | 'all'; days?: 'weekday' | 'weekend' | 'both' }
  | { type: 'suspend_line'; route: Id; suspended: boolean }
  | { type: 'service_plan'; route: Id; plan: string; on: boolean }
  | { type: 'set_fare'; fare: number }
  | { type: 'service_vehicle'; vehicle: Id }
  | { type: 'move_depot'; vehicle: Id; depot: Id };

export type Impact = 'low' | 'high';

export interface CommandCheck {
  ok: boolean;
  /** what the command asks for, e.g. "Move 14 to line 3" */
  summary: string;
  /** why it cannot run (when not ok) */
  reason?: string;
  /** what will happen in the game if it runs, including anything deferred */
  transition?: string;
  /** the change will happen later (e.g. the bus finishes its trip first) */
  deferred?: boolean;
  /** already the case: running it would change nothing */
  noop?: boolean;
  /** estimated money committed */
  cost: number;
  impact: Impact;
  /** what the command acts on, e.g. `vehicle:v3` (for cooldowns and conflicts) */
  target: string;
  /** the desired end state on that target; a different key on the same target conflicts */
  key: string;
}

export const COMMAND_LABEL: Record<Command['type'], string> = {
  assign_vehicle: 'Move a bus to a line',
  dispatch_extra: 'Extra departure',
  schedule_extra: 'Schedule an extra departure',
  set_headway: 'Change frequency',
  suspend_line: 'Suspend or resume a line',
  service_plan: 'Switch a service plan',
  set_fare: 'Change the fare',
  service_vehicle: 'Send a bus for maintenance',
  move_depot: 'Move a bus to another depot',
};

/** High-impact commands change what passengers are offered or pay; automations need permission. */
export const HIGH_IMPACT = new Set<Command['type']>(['set_headway', 'suspend_line', 'service_plan', 'set_fare']);

/** A line's service plan by id or name (names are matched without regard to case). */
export function findPlan(game: Game, route: Id, plan: string) {
  const plans = game.state.routes[route]?.timetable.plans ?? [];
  const want = plan.trim().toLowerCase();
  return plans.find((p) => p.id === plan) ?? plans.find((p) => p.name.trim().toLowerCase() === want) ?? null;
}

const lineName = (game: Game, id: Id | null) => (id ? `line ${game.state.routes[id]?.number ?? '?'}` : 'no line');

/** Dry run: never changes the game. */
export function checkCommand(game: Game, cmd: Command): CommandCheck {
  const s = game.state;
  const impact: Impact = HIGH_IMPACT.has(cmd.type) ? 'high' : 'low';
  const base = { cost: 0, impact };
  if (s.company.status === 'bankrupt') return { ...base, ok: false, summary: COMMAND_LABEL[cmd.type], reason: 'The company is bankrupt.', target: 'company', key: 'none' };
  switch (cmd.type) {
    case 'assign_vehicle': {
      const v = s.vehicles[cmd.vehicle];
      const target = `vehicle:${cmd.vehicle}`;
      const key = `route:${cmd.route ?? 'none'}`;
      if (!v) return { ...base, ok: false, summary: 'Move a bus', reason: 'That bus no longer exists.', target, key };
      const summary = cmd.route ? `Move ${v.fleetNo} to ${lineName(game, cmd.route)}` : `Take ${v.fleetNo} off ${lineName(game, v.route)}`;
      if (cmd.route && !s.routes[cmd.route]) return { ...base, ok: false, summary, reason: 'That line no longer exists.', target, key };
      if (v.sell) return { ...base, ok: false, summary, reason: `${v.fleetNo} is being sold.`, target, key };
      if (v.route === cmd.route) return { ...base, ok: true, noop: true, summary, transition: `${v.fleetNo} is already ${cmd.route ? `on ${lineName(game, cmd.route)}` : 'a spare bus'}.`, target, key };
      if (v.handover && v.handover.route === cmd.route && cmd.after === 'trips') return { ...base, ok: true, noop: true, summary, transition: `${v.fleetNo} already ${cmd.route ? `joins ${lineName(game, cmd.route)}` : 'parks'} after the trips it has.`, target, key };
      let transition: string;
      let deferred = false;
      const join = cmd.route ? `joins ${lineName(game, cmd.route)}` : 'becomes a spare bus';
      const ends = cmd.after === 'trips' && v.status !== 'maintenance' && v.status !== 'broken' ? workEnds(game, v) : null;
      if (ends !== null) {
        deferred = true;
        const carrying = v.load > 0 ? `${v.fleetNo} is carrying ${v.load} passenger${v.load === 1 ? '' : 's'} and finishes this trip. It ` : `${v.fleetNo} `;
        transition = `${carrying}runs the trips it already has on ${lineName(game, v.route)} (until about ${hhmm(ends)}), so none is missed, then ${cmd.route ? `goes to ${lineName(game, cmd.route)}` : 'parks at its depot as a spare'}.`;
      } else switch (v.status) {
        case 'in_service': case 'at_stop':
          deferred = true;
          transition = v.load > 0
            ? `${v.fleetNo} is carrying ${v.load} passenger${v.load === 1 ? '' : 's'}. It finishes this trip first, returns to its depot, then ${join}.`
            : `${v.fleetNo} finishes its current trip, returns to its depot, then ${join}.`;
          break;
        case 'maintenance': deferred = true; transition = `${v.fleetNo} is in the workshop until ${hhmm(v.until)}, then ${join}.`; break;
        case 'broken': deferred = true; transition = `${v.fleetNo} has broken down; once recovered it goes to the depot, then ${join}.`; break;
        case 'preparing': case 'to_route': case 'layover':
          transition = v.trip !== null ? `${v.fleetNo} gives up its next trip on ${lineName(game, v.route)}, returns to its depot, then ${join}.` : `${v.fleetNo} returns to its depot, then ${join}.`;
          deferred = true;
          break;
        default: transition = `${v.fleetNo} ${join}${cmd.route ? ' and leaves the depot when the timetable needs it' : ''}.`;
      }
      // leaving a line short of buses is allowed (the player can too) but said out loud
      if (v.route) {
        const req = game.requirement(v.route);
        const left = (s.routes[v.route]?.vehicles.length ?? 1) - 1;
        if (req && req.peak > left) transition += ` ${lineName(game, v.route).replace(/^l/, 'L')} will have ${left} bus${left === 1 ? '' : 'es'} for a timetable that needs ${req.peak}.`;
      }
      return { ...base, ok: true, summary, transition, deferred, target, key };
    }
    case 'dispatch_extra': {
      const target = `route:${cmd.route}`;
      const key = `extra:${cmd.route}:${cmd.pat ?? '*'}`;
      const summary = `Extra departure on ${lineName(game, cmd.route)}`;
      const plan = game.extraPlan(cmd.route, { pat: cmd.pat, vehicle: cmd.vehicle });
      if (!plan.ok) return { ...base, ok: false, summary, reason: plan.error, target, key };
      return { ...base, ok: true, summary: `${summary} with ${plan.value.fleetNo}`, transition: plan.value.text, cost: plan.value.cost, target, key };
    }
    case 'schedule_extra': {
      // each departure time is its own target: extras at different times never "disagree"
      const minute = Math.round(cmd.at / 60);
      const target = `extra:${cmd.route}:${minute}`;
      const key = `extra_at:${cmd.pat ?? '*'}`;
      const summary = `Extra departure at ${hhmm(cmd.at)} on ${lineName(game, cmd.route)}`;
      const same = game.scheduledExtras(cmd.route).find((x) => Math.round((x.ask ?? x.dep) / 60) === minute && (cmd.pat === undefined || x.pat === cmd.pat));
      if (same) return { ...base, ok: true, noop: true, summary, transition: `An extra departure at ${hhmm(same.dep)} is already scheduled on ${lineName(game, cmd.route)}.`, target, key };
      const plan = game.scheduleExtra(cmd.route, cmd.at, { pat: cmd.pat, vehicle: cmd.vehicle });
      if (!plan.ok) return { ...base, ok: false, summary, reason: plan.error, target, key };
      return { ...base, ok: true, summary: `Extra departure at ${hhmm(plan.value.dep)} on ${lineName(game, cmd.route)}`, transition: plan.value.text, cost: plan.value.cost, target, key };
    }
    case 'set_headway': {
      const r = s.routes[cmd.route];
      const target = `route:${cmd.route}`;
      const key = `headway:${cmd.days ?? 'both'}:${cmd.band ?? 'all'}:${Math.round(cmd.minutes)}`;
      const summary = `Every ${Math.round(cmd.minutes)} min on ${lineName(game, cmd.route)}`;
      if (!r) return { ...base, ok: false, summary, reason: 'That line no longer exists.', target, key };
      const tt = headwayTimetable(r.timetable, cmd);
      if (!tt.ok) return { ...base, ok: false, summary, reason: tt.error, target, key };
      if (JSON.stringify(tt.value) === JSON.stringify(r.timetable)) return { ...base, ok: true, noop: true, summary, transition: 'The timetable already runs at that frequency.', target, key };
      const prof = game.profiles.get(cmd.route);
      const now = game.headwayAt(cmd.route, 0, game.t);
      const which = cmd.days === 'weekday' ? 'on weekdays' : cmd.days === 'weekend' ? 'at weekends' : 'every day';
      const when = cmd.band ? ` (${cmd.band})` : '';
      let transition = `Line ${r.number} runs every ${Math.round(cmd.minutes)} min ${which}${when}${now ? `, now every ${Math.round(now)} min` : ''}. Departures already given to buses still run.`;
      if (prof) {
        const req = requirement({ ...r, timetable: tt.value }, prof, game.isWeekend(game.t));
        if (req && req.peak > r.vehicles.length) transition += ` It would need ${req.peak} buses at its peak but has ${r.vehicles.length}, so some departures would be missed.`;
      }
      return { ...base, ok: true, summary, transition, target, key };
    }
    case 'suspend_line': {
      const r = s.routes[cmd.route];
      const target = `route:${cmd.route}`;
      const key = `suspended:${cmd.suspended}`;
      const summary = `${cmd.suspended ? 'Suspend' : 'Resume'} ${lineName(game, cmd.route)}`;
      if (!r) return { ...base, ok: false, summary, reason: 'That line no longer exists.', target, key };
      if (r.suspended === cmd.suspended) return { ...base, ok: true, noop: true, summary, transition: `Line ${r.number} is already ${cmd.suspended ? 'suspended' : 'running'}.`, target, key };
      return { ...base, ok: true, summary, transition: cmd.suspended ? `No new trips start on line ${r.number}; buses finish the trips they are on and return to the depot.` : `Line ${r.number} runs its timetable again.`, target, key };
    }
    case 'service_plan': {
      const r = s.routes[cmd.route];
      const target = `route:${cmd.route}`;
      const key = `plan:${cmd.plan.trim().toLowerCase()}:${cmd.on}`;
      const summary = `${cmd.on ? 'Switch on' : 'Switch off'} the "${cmd.plan}" plan on ${lineName(game, cmd.route)}`;
      if (!r) return { ...base, ok: false, summary, reason: 'That line no longer exists.', target, key };
      const p = findPlan(game, cmd.route, cmd.plan);
      if (!p) return { ...base, ok: false, summary, reason: `Line ${r.number} has no service plan called "${cmd.plan}". Add a manual plan in its timetable first.`, target, key };
      if (p.when.kind !== 'manual') return { ...base, ok: false, summary, reason: `The "${p.name}" plan on line ${r.number} switches itself on by its condition; only manual plans can be switched.`, target, key };
      if (!p.enabled) return { ...base, ok: false, summary, reason: `The "${p.name}" plan on line ${r.number} is turned off in the timetable.`, target, key };
      if (p.when.on === cmd.on) return { ...base, ok: true, noop: true, summary, transition: `The "${p.name}" plan is already ${cmd.on ? 'on' : 'off'}.`, target, key };
      return { ...base, ok: true, summary, transition: cmd.on ? `Line ${r.number} runs its "${p.name}" plan from now: departures not yet given to buses follow it.` : `Line ${r.number} goes back to its normal timetable for departures not yet given to buses.`, target, key };
    }
    case 'set_fare': {
      const target = 'company:fare';
      const fare = Math.round(cmd.fare * 20) / 20;
      const key = `fare:${fare}`;
      const summary = `Set the fare to ${game.money(fare)}`;
      if (!(fare >= ECON.fareMin && fare <= ECON.fareMax)) return { ...base, ok: false, summary, reason: `The fare must be between ${game.money(ECON.fareMin)} and ${game.money(ECON.fareMax)}.`, target, key };
      if (Math.abs(fare - s.company.fare) < 0.005) return { ...base, ok: true, noop: true, summary, transition: 'That is already the fare.', target, key };
      return { ...base, ok: true, summary, transition: `Every new journey pays ${game.money(fare)} (now ${game.money(s.company.fare)}). Ridership responds within the hour.`, target, key };
    }
    case 'service_vehicle': {
      const v = s.vehicles[cmd.vehicle];
      const target = `vehicle:${cmd.vehicle}`;
      const key = 'service';
      if (!v) return { ...base, ok: false, summary: 'Send a bus for maintenance', reason: 'That bus no longer exists.', target, key };
      const summary = `Send ${v.fleetNo} for maintenance`;
      if (v.status === 'maintenance') return { ...base, ok: true, noop: true, summary, transition: `${v.fleetNo} is already in the workshop.`, target, key };
      if (v.condition > 0.985) return { ...base, ok: false, summary, reason: `${v.fleetNo} does not need maintenance.`, target, key };
      const q = game.maintenanceQuote(v);
      const now = v.status === 'parked';
      return { ...base, ok: true, summary, cost: q.cost, deferred: !now, transition: now ? `${v.fleetNo} goes into the workshop for about ${Math.round(q.minutes)} min (${game.money(q.cost)}).` : `${v.fleetNo} finishes its current work, returns to the depot and goes into the workshop (about ${game.money(q.cost)}).`, target, key };
    }
    case 'move_depot': {
      const v = s.vehicles[cmd.vehicle];
      const d = s.depots[cmd.depot];
      const target = `vehicle:${cmd.vehicle}`;
      const key = `depot:${cmd.depot}`;
      const summary = `Base ${v?.fleetNo ?? 'a bus'} at ${d?.name ?? 'another depot'}`;
      const plan = game.depotMovePlan(cmd.vehicle, cmd.depot);
      if (!plan.ok) return { ...base, ok: v?.depot === cmd.depot, noop: v?.depot === cmd.depot, summary, reason: plan.error, transition: v?.depot === cmd.depot ? plan.error : undefined, target, key };
      const m = v ? MODEL[v.model] : null;
      // the empty run: energy for the distance and the driver's time at about 20 km/h
      const cost = plan.value.now && plan.value.km !== null && m ? Math.round(plan.value.km * m.energyPerKm * (m.electric ? ECON.electricPrice : ECON.fuelPrice) + (plan.value.km / 20) * ECON.driverPerHour) : 0;
      return { ...base, ok: true, summary, transition: plan.value.text, deferred: !plan.value.now, cost, target, key };
    }
  }
}

/** Execute through the game's own commands. Returns what changed, in the game's words. */
export function runCommand(game: Game, cmd: Command, src = 'player'): Result<{ check: CommandCheck; effect: string }> {
  const check = checkCommand(game, cmd);
  if (!check.ok) return { ok: false, error: check.reason ?? 'This cannot be done now.' };
  if (check.noop) return { ok: true, value: { check, effect: check.transition ?? 'Nothing to change.' } };
  let r: Result<unknown>;
  switch (cmd.type) {
    case 'assign_vehicle': r = cmd.after === 'trips' ? game.handoverVehicle(cmd.vehicle, cmd.route, src) : game.assignVehicle(cmd.vehicle, cmd.route, src); break;
    case 'schedule_extra': {
      const x = game.scheduleExtra(cmd.route, cmd.at, { pat: cmd.pat, vehicle: cmd.vehicle, src, commit: true });
      if (!x.ok) return x;
      return { ok: true, value: { check, effect: x.value.text } };
    }
    case 'dispatch_extra': {
      const x = game.dispatchExtra(cmd.route, { pat: cmd.pat, vehicle: cmd.vehicle, src });
      if (!x.ok) return x;
      return { ok: true, value: { check, effect: x.value.text } };
    }
    case 'set_headway': {
      const route = game.state.routes[cmd.route];
      const tt = headwayTimetable(route.timetable, cmd);
      if (!tt.ok) return tt;
      r = game.setTimetable(cmd.route, tt.value);
      break;
    }
    case 'suspend_line': r = game.updateRoute(cmd.route, { suspended: cmd.suspended }); break;
    case 'service_plan': r = game.switchServicePlan(cmd.route, findPlan(game, cmd.route, cmd.plan)!.id, cmd.on); break;
    case 'set_fare': r = game.setFare(cmd.fare); break;
    case 'service_vehicle': r = game.serviceVehicle(cmd.vehicle); break;
    case 'move_depot': r = game.moveToDepot(cmd.vehicle, cmd.depot); break;
  }
  if (!r.ok) return r;
  return { ok: true, value: { check, effect: check.transition ?? check.summary } };
}

// ───────────────────────────────────────────── timetable edits

/** The timetable with the headway of one band (or all bands) changed. */
export function headwayTimetable(tt: Timetable, cmd: { minutes: number; band?: number | 'all'; days?: 'weekday' | 'weekend' | 'both' }): Result<Timetable> {
  const m = Math.round(cmd.minutes);
  if (!(m >= 3 && m <= 120)) return { ok: false, error: 'A frequency must be between every 3 and every 120 minutes.' };
  const out: Timetable = structuredClone(tt);
  const days = cmd.days ?? 'both';
  const plans = days === 'both' ? [out.weekday, out.weekend] : [days === 'weekday' ? out.weekday : out.weekend];
  for (const p of plans) {
    if (cmd.band === undefined || cmd.band === 'all') for (const b of p.bands) b.headway = m;
    else {
      const b = p.bands[cmd.band];
      if (!b) return { ok: false, error: 'That part of the day is not in the timetable.' };
      b.headway = m;
    }
  }
  return { ok: true, value: out };
}
