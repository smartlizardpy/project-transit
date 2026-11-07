// Co-op lockstep: a host and a guest over an in-memory connection must end with identical games,
// whoever makes the changes, and a guest that drifts is put right by a fresh copy.
import { describe, expect, it } from 'vitest';
import { Game } from '../game/engine.ts';
import { prepareRegion } from '../game/world/geo.ts';
import type { GameState } from '../game/types.ts';
import type { RegionData } from '../game/world/region.ts';
import { buildLine, crowdedLine, newGame, region } from '../game/test/helpers.ts';
import { planService } from '../game/optimise.ts';
import { DAY } from '../game/content.ts';
import { simState } from '../game/test/determinism.ts';
import { decode, encode, pack, unpack } from './codec.ts';
import { GuestSim, HostSim } from './lockstep.ts';
import { MemoryHub } from './transport.ts';
import { checksum } from './checksum.ts';
import type { Stamped } from './protocol.ts';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A fake clock for the sims' frame pacing. */
function clock() {
  let ms = 0;
  return { now: () => ms, step: (d: number) => (ms += d) };
}

async function session(hostGame: Game) {
  const hub = new MemoryHub();
  const c = clock();
  const applied: { who: 'host' | 'guest'; st: Stamped }[] = [];
  const host = new HostSim(hostGame, hub.join('H'), 'Ana', 'test', { applied: (st) => applied.push({ who: 'host', st }) }, c.now);
  const adopt = (state: GameState, data: RegionData | null) => new Game(state, data ? prepareRegion(data) : guest.game!.region);
  const guest = new GuestSim(hub.join('G'), 'Ben', 'test', adopt, { applied: (st) => applied.push({ who: 'guest', st }) }, c.now);
  // hello → welcome → snapshot
  const until = Date.now() + 20_000;
  while (!guest.game && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  expect(guest.game).not.toBeNull();
  /** Run both computers for `frames` animation frames of `dt` real seconds. */
  const run = async (frames: number, dt = 0.05) => {
    for (let i = 0; i < frames; i++) {
      c.step(dt * 1000);
      host.frame(dt);
      await flush();
      guest.frame(dt);
      await flush();
    }
  };
  /** Let the guest reach the host's clock. */
  const settle = async () => {
    for (let i = 0; i < 400 && (guest.lag > 0 || guest.game!.t !== host.game.t); i++) {
      c.step(50);
      host.frame(0); // send any frame still due
      await flush();
      guest.frame(0.25);
      await flush();
    }
  };
  return { hub, host, guest, run, settle, applied };
}

describe('codec', () => {
  it('round-trips typed arrays and JSON, with and without gzip', async () => {
    const v = { a: 1, s: 'İstanbul', f: new Float64Array([1.5, -2, Math.PI]), i: new Int32Array([7, -9]), u: new Uint8Array([1, 2, 3]), nested: [{ x: new Float32Array([0.25]) }] };
    const back = decode<typeof v>(encode(v));
    expect(back.f).toBeInstanceOf(Float64Array);
    expect([...back.f]).toEqual([...v.f]);
    expect([...back.i]).toEqual([7, -9]);
    expect(back.nested[0].x).toBeInstanceOf(Float32Array);
    const zipped = await unpack<typeof v>(await pack(v));
    expect([...zipped.u]).toEqual([1, 2, 3]);
    expect(zipped.s).toBe('İstanbul');
  });

  it('carries a whole region', async () => {
    const { index: _index, ...data } = region();
    const back = await unpack<RegionData>(await pack(data));
    expect(back.fingerprint).toBe(data.fingerprint);
    expect([...back.graph.x.slice(0, 50)]).toEqual([...data.graph.x.slice(0, 50)]);
  });
});

describe('co-op lockstep', () => {
  it('a guest joins, both make changes, and the games stay identical', async () => {
    const g = newGame({ seed: 7, extraFunds: 2_000_000 });
    const line = buildLine(g, { stops: 6, buses: 2 });
    g.run(1800);
    const s = await session(g);
    const { host, guest } = s;
    expect(simState(guest.game!)).toEqual(simState(host.game));
    host.setSpeed(3);
    await s.run(20);

    // the host buys a bus; the guest puts it on the line and changes the fare
    const bought = host.submit({ m: 'buyVehicle', args: ['city12', line.depot] }) as { ok: true; value: string };
    expect(bought.ok).toBe(true);
    await s.run(5);
    const assign = guest.submit({ m: 'assignVehicle', args: [bought.value, line.route] });
    const fare = guest.submit({ m: 'setFare', args: [2.5] });
    await s.run(20);
    expect(await assign).toMatchObject({ ok: true });
    expect(await fare).toMatchObject({ ok: true });
    expect(host.game.state.vehicles[bought.value].route).toBe(line.route);

    // the guest asks for a faster clock, then builds a stop
    guest.setSpeed(4);
    await s.run(10);
    expect(host.game.speed).toBe(4);
    const stop = await (async () => {
      const p = guest.submit({ m: 'placeStop', args: [host.game.state.stops[line.stopIds[2]].lngLat] });
      await s.run(10);
      return p;
    })();
    expect(stop).toMatchObject({ ok: false }); // a stop is already there: both computers agree why

    await s.run(200);
    await s.settle();
    expect(guest.game!.t).toBe(host.game.t);
    expect(host.game.t).toBeGreaterThan(1800 + 3600);
    expect(checksum(guest.game!)).toBe(checksum(host.game));
    expect(simState(guest.game!)).toEqual(simState(host.game));
    // both applied the same actions in the same order
    const order = (who: string) => s.applied.filter((x) => x.who === who).map((x) => `${x.st.seq}@${x.st.t}`);
    expect(order('guest')).toEqual(order('host'));
  }, 120_000);

  it('a guest that drifts is sent the game again', async () => {
    const g = newGame({ seed: 9 });
    buildLine(g, { stops: 6, buses: 3 });
    const s = await session(g);
    const { host, guest } = s;
    const before = guest.game;
    // corrupt the guest's copy: its random numbers now differ from the host's
    guest.game!.state.rng = (guest.game!.state.rng + 12345) >>> 0;
    host.setSpeed(4);
    await s.run(60, 0.1); // past at least one ten-minute checksum
    const until = Date.now() + 20_000;
    while (guest.game === before && Date.now() < until) await s.run(1);
    expect(guest.game).not.toBe(before);
    await s.run(30, 0.1);
    await s.settle();
    expect(simState(guest.game!)).toEqual(simState(host.game));
  }, 120_000);

  it('a guest applies an Improve service plan and undoes it; the host follows', async () => {
    const g = newGame({ seed: 21, extraFunds: 1_000_000 });
    const busy = crowdedLine(g);
    buildLine(g, { from: [28.985, 41.03], stops: 7, buses: 3, headway: 20, kind: 'loop', model: 'mini8' });
    g.buyVehicle('mini8', busy.depot);
    g.buyVehicle('mini8', busy.depot);
    g.run(DAY + 3 * 3600);
    const s = await session(g);
    const { host, guest } = s;
    // the guest plans on its own copy (planning changes nothing), then sends the plan as an action
    const plan = planService(guest.game!);
    expect(plan.steps.length).toBeGreaterThan(0);
    const before = host.game.state.routes[busy.route].vehicles.length;
    const applied = guest.submit({ m: 'applyPlan', args: [plan, plan.steps.filter((x) => x.on).map((x) => x.id), 'k1'] });
    await s.run(5);
    const r = (await applied) as { done: string[]; problems: string[] };
    expect(r.done.length).toBeGreaterThan(0);
    expect(host.game.state.routes[busy.route].vehicles.length).toBeGreaterThan(before);
    expect(simState(guest.game!)).toEqual(simState(host.game));
    // undo by key: both computers kept their own record of the change
    const undone = guest.submit({ m: 'undoApplied', args: ['k1'] });
    await s.run(5);
    expect(await undone).toEqual([]);
    host.setSpeed(3);
    await s.run(100);
    await s.settle();
    expect(simState(guest.game!)).toEqual(simState(host.game));
  }, 120_000);

  it('refuses a guest with another version of the game', async () => {
    const hub = new MemoryHub();
    new HostSim(newGame(), hub.join('H'), 'Ana', '1.0.0');
    let reason = '';
    const guest = new GuestSim(hub.join('G'), 'Ben', '0.9.0', () => { throw new Error('should not load'); }, { ended: (r) => (reason = r) });
    for (let i = 0; i < 10; i++) await flush();
    expect(guest.game).toBeNull();
    expect(reason).toMatch(/different versions/);
  });
});
