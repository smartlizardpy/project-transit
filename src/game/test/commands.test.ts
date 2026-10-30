// The command layer shared by the player and automations: dry-run checks and execution
// through the game's own rules. Extra departures and depot moves are real operations.
import { describe, expect, it } from 'vitest';
import { Game } from '../engine.ts';
import { buildLine, newGame, region } from './helpers.ts';
import { HOUR } from '../content.ts';
import { checkCommand, runCommand } from '../commands.ts';
import { TripState } from '../types.ts';

describe('extra departures', () => {
  const game = newGame({ seed: 21, extraFunds: 1_000_000 });
  const line = buildLine(game, { buses: 2, stops: 7, headway: 12 });
  game.run(3 * HOUR); // 08:00, rush hour
  const spare = game.buyVehicle('city12', line.depot);
  if (!spare.ok) throw new Error(spare.error);

  it('checks without changing anything', () => {
    const snapshot = () => JSON.stringify({ ...game.state, meta: null });
    const before = snapshot();
    const c = checkCommand(game, { type: 'dispatch_extra', route: line.route });
    expect(c.ok).toBe(true);
    expect(c.transition).toMatch(/extra line .* trip from .* at \d\d:\d\d/);
    expect(c.cost).toBeGreaterThan(0);
    expect(snapshot()).toBe(before);
  });

  it('sends a spare bus that drives to the line, carries passengers and goes back', () => {
    const r = runCommand(game, { type: 'dispatch_extra', route: line.route, vehicle: spare.value }, 'wf1');
    expect(r.ok).toBe(true);
    const v = game.state.vehicles[spare.value];
    expect(v.route).toBeNull(); // a spare stays a spare
    expect(v.status).toBe('preparing');
    const trip = game.trip(v.trip!)!;
    expect(trip.extra).toBe('wf1');
    expect(trip.state).toBe(TripState.Assigned);
    let boarded = 0, sawOnRoad = false;
    const stopEvents = game.recentStops.length;
    for (let i = 0; i < 120 && trip.state !== TripState.Done; i++) {
      game.run(60);
      if (v.status === 'to_route' || v.status === 'in_service') sawOnRoad = game.pose(v) !== null || sawOnRoad;
    }
    expect(trip.state).toBe(TripState.Done);
    expect(sawOnRoad).toBe(true);
    boarded = game.recentStops.slice(stopEvents).filter((e) => e.veh === v.id).reduce((n, e) => n + e.board, 0);
    expect(boarded).toBeGreaterThan(0);
    // after the extra trip the spare bus returns to its depot
    for (let i = 0; i < 60 && v.status !== 'parked'; i++) game.run(60);
    expect(v.status).toBe('parked');
    expect(game.audit()).toEqual([]);
  });

  it('never takes a bus off a trip with passengers on board', () => {
    let busy = Object.values(game.state.vehicles).find((x) => x.route === line.route && x.load > 0);
    for (let i = 0; i < 30 && !busy; i++) {
      game.run(30);
      busy = Object.values(game.state.vehicles).find((x) => x.route === line.route && x.load > 0);
    }
    expect(busy).toBeTruthy();
    const c = checkCommand(game, { type: 'dispatch_extra', route: line.route, vehicle: busy!.id });
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/carrying \d+ passengers/);
  });
});

describe('reassigning a bus that is carrying passengers (scenario 4)', () => {
  const game = newGame({ seed: 22, extraFunds: 1_000_000 });
  const a = buildLine(game, { buses: 3, stops: 7 });
  const b = buildLine(game, { from: [28.9745, 41.0255], buses: 1, stops: 5 });
  game.run(3 * HOUR);

  it('defers the move until the trip is finished, without losing anyone', () => {
    let v = Object.values(game.state.vehicles).find((x) => x.route === a.route && x.load > 0 && x.status === 'in_service');
    for (let i = 0; i < 60 && !v; i++) {
      game.run(20);
      v = Object.values(game.state.vehicles).find((x) => x.route === a.route && x.load > 0 && x.status === 'in_service');
    }
    expect(v).toBeTruthy();
    const load = v!.load;
    const c = checkCommand(game, { type: 'assign_vehicle', vehicle: v!.id, route: b.route });
    expect(c.ok).toBe(true);
    expect(c.deferred).toBe(true);
    expect(c.transition).toMatch(new RegExp(`carrying ${load} passenger`));
    const trip = v!.trip;
    const r = runCommand(game, { type: 'assign_vehicle', vehicle: v!.id, route: b.route }, 'wf-a');
    expect(r.ok).toBe(true);
    // still on its trip with its passengers
    expect(v!.trip).toBe(trip);
    expect(v!.load).toBe(load);
    expect(v!.pos.kind).toBe('pattern');
    for (let i = 0; i < 120 && game.trip(trip!)?.state !== TripState.Done; i++) game.run(60);
    expect(game.trip(trip!)?.state).toBe(TripState.Done);
    expect(game.state.pax.onboard[v!.id]?.length ?? 0).toBe(0);
    expect(game.state.analytics.assignments.at(-1)).toMatchObject({ v: v!.id, from: a.route, to: b.route, src: 'wf-a' });
    expect(game.audit()).toEqual([]);
  });
});

describe('moving a bus to another depot', () => {
  const game = newGame({ seed: 23, extraFunds: 1_000_000 });
  const line = buildLine(game, { buses: 2, stops: 6 });
  const d2 = game.buildDepot([28.9745, 41.0255]);
  if (!d2.ok) throw new Error(d2.error);
  const bus = game.buyVehicle('midi10', line.depot);
  if (!bus.ok) throw new Error(bus.error);

  it('drives a parked bus to the new depot on the road', () => {
    const v = game.state.vehicles[bus.value];
    const c = checkCommand(game, { type: 'move_depot', vehicle: v.id, depot: d2.value });
    expect(c.ok).toBe(true);
    expect(c.transition).toMatch(/drives empty .* km/);
    const r = game.moveToDepot(v.id, d2.value);
    expect(r.ok && r.value).toBe('driving');
    expect(v.status).toBe('to_depot');
    expect(v.depot).toBe(d2.value);
    game.run(60);
    expect(game.pose(v)).not.toBeNull(); // visible on the map
    const km0 = v.km;
    for (let i = 0; i < 90 && v.status !== 'parked'; i++) game.run(60);
    expect(v.status).toBe('parked');
    expect(v.pos.kind).toBe('depot');
    expect(v.km).toBeGreaterThan(km0);
    expect(game.audit()).toEqual([]);
    // and it survives a save
    const copy = new Game(JSON.parse(game.serialize()), region());
    expect(copy.state.vehicles[v.id].depot).toBe(d2.value);
  });

  it('a bus at work keeps working and returns to the new depot later', () => {
    game.run(2 * HOUR);
    const v = Object.values(game.state.vehicles).find((x) => x.route === line.route && x.status === 'in_service')!;
    expect(v).toBeTruthy();
    const r = game.moveToDepot(v.id, d2.value);
    expect(r.ok && r.value).toBe('later');
    expect(v.status).toBe('in_service');
  });

  it('respects depot capacity and the workshop', () => {
    const d = game.state.depots[d2.value];
    const full = d.capacity;
    d.capacity = game.depotUse(d2.value);
    const v = Object.values(game.state.vehicles).find((x) => x.depot === line.depot)!;
    expect(game.moveToDepot(v.id, d2.value).ok).toBe(false);
    expect(checkCommand(game, { type: 'move_depot', vehicle: v.id, depot: d2.value }).reason).toMatch(/full/);
    d.capacity = full;
  });
});
