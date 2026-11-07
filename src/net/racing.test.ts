// Races: a host and a guest over an in-memory connection found companies in the same city at the
// same moment, run on one clock to the finish, and agree on who won.
import { describe, expect, it } from 'vitest';
import { Game, newGameState } from '../game/engine.ts';
import { prepareRegion } from '../game/world/geo.ts';
import type { RegionData } from '../game/world/region.ts';
import { buildLine, region } from '../game/test/helpers.ts';
import { SPEEDS } from '../game/content.ts';
import { GuestSim } from './lockstep.ts';
import { RaceGuest, RaceHost, rank, type RaceEvents } from './racing.ts';
import { MemoryHub } from './transport.ts';
import type { Msg, RaceResult, RaceSetup, RaceStart } from './protocol.ts';

const flush = () => new Promise((r) => setTimeout(r, 0));
const SETUP: RaceSetup = { preset: 'istanbul-galata', city: 'İstanbul', area: 'Beyoğlu & Fatih', days: 1 };

function clock() {
  let ms = 0;
  return { now: () => ms, step: (d: number) => (ms += d) };
}

/** A company on a race map, as the session founds one. */
function found(map: ReturnType<typeof region>, start: { seed: number; home: string }, name: string) {
  const state = newGameState({ region: map, company: { name, colour: '#4f7fd6', logo: 1 }, homeZone: start.home, seed: start.seed, startHour: 5 });
  state.territory.owned = map.zones.map((z) => z.id);
  return new Game(state, map);
}

const home = () => region().zones.slice().sort((a, b) => b.residents + b.jobs - (a.residents + a.jobs))[0].id;

async function until(cond: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

/** A host with a lobby, and a guest that joins the way the app does: through the co-op join flow. */
async function lobby(build = 'test') {
  const hub = new MemoryHub();
  const c = clock();
  const hostEv: RaceEvents & { results?: RaceResult[] } = {};
  hostEv.finished = (r) => (hostEv.results = r);
  const host = new RaceHost(hub.join('H'), 'Ana', 'test', { ...SETUP }, hostEv, c.now);
  const guestEv: RaceEvents & { results?: RaceResult[]; ghost?: RaceEvents['ghost']; ghosts: number; ended?: (r: string) => void; reason?: string } = { ghosts: 0 };
  guestEv.finished = (r) => (guestEv.results = r);
  guestEv.ghost = (_id, lines) => (guestEv.ghosts = lines.length);
  guestEv.ended = (r) => (guestEv.reason = r);
  let guest: RaceGuest | null = null;
  let refused: string | null = null;
  const t = hub.join('G');
  const create = (data: RegionData, start: RaceStart) => found(prepareRegion(data), start, 'Ben Transit');
  new GuestSim(t, 'Ben', build, () => {
    throw new Error('a race never sends a game copy');
  }, {
    race: (w: Extract<Msg, { k: 'race' }>, from: string) => (guest = new RaceGuest(t, w, from, create, guestEv, c.now)),
    ended: (r) => (refused = r),
  });
  await until(() => !!guest || !!refused);
  return { hub, c, host, hostEv, guestEv, guest: () => guest, refused: () => refused };
}

/** Run both computers frame by frame (the guest optional: a stalled computer). */
async function run(h: Awaited<ReturnType<typeof lobby>>, frames: number, dt = 0.25, guestToo = true) {
  for (let i = 0; i < frames; i++) {
    h.c.step(dt * 1000);
    h.host.frame(dt);
    await flush();
    if (guestToo) h.guest()?.frame(dt);
    await flush();
  }
}

describe('race', () => {
  it('starts both companies level, runs one clock to the finish and agrees on the winner', async () => {
    const h = await lobby();
    const g = h.guest()!;
    expect(g.setup.city).toBe('İstanbul');
    expect(h.host.players.map((p) => p.name)).toEqual(['Ana', 'Ben']);

    const start = { seed: 1234, home: home() };
    const mine = found(region(), start, 'Ana Transit');
    await h.host.begin(mine, { ...start, startT: mine.t, endT: mine.t + 4 * 3600, speed: 4 });
    await until(() => !!g.game);
    const theirs = g.game!;
    // the same city, the same money, the same moment
    expect(theirs.region.fingerprint).toBe(mine.region.fingerprint);
    expect(theirs.t).toBe(mine.t);
    expect(theirs.state.finance.balance).toBe(mine.state.finance.balance);
    expect(theirs.state.rng).toBe(mine.state.rng);

    // only Ana builds: she should win
    buildLine(mine, { buses: 3 });
    await run(h, 200);
    expect(h.hostEv.results).toBeDefined();
    await until(() => !!h.guestEv.results);
    const endT = h.host.start!.endT;
    expect(mine.t).toBe(endT);
    expect(theirs.t).toBe(endT);
    expect(h.hostEv.results!.map((r) => r.name)).toEqual(['Ana', 'Ben']);
    expect(h.guestEv.results).toEqual(h.hostEv.results);
    expect(h.hostEv.results![0].score!.journeys).toBeGreaterThan(0);
    expect(h.hostEv.results![1].score!.journeys).toBe(0);
    // Ben saw Ana's line on his map
    expect(h.guestEv.ghosts).toBe(1);
    // the clocks stop at the finish
    expect(mine.speed).toBe(0);
    expect(theirs.speed).toBe(0);
  }, 60_000);

  it('holds the clock until the guest has the map, and never runs far ahead of a slow guest', async () => {
    const h = await lobby();
    const g = h.guest()!;
    const start = { seed: 9, home: home() };
    const mine = found(region(), start, 'Ana Transit');
    await h.host.begin(mine, { ...start, startT: mine.t, endT: mine.t + 6 * 3600, speed: 4 });
    // the map is on its way: the host waits at the start
    const t0 = mine.t;
    h.c.step(250);
    h.host.frame(0.25);
    expect(mine.t).toBe(t0);
    await until(() => !!g.game);
    await run(h, 10);
    expect(mine.t).toBeGreaterThan(t0);
    // the guest stops: the host waits for it
    const waiting: string[][] = [];
    h.hostEv.waiting = (n) => waiting.push(n);
    await run(h, 30, 0.25, false);
    expect(mine.t - g.game!.t).toBeLessThanOrEqual(Math.max(60, SPEEDS[4]) + 1);
    expect(waiting.at(-1)).toEqual(['Ben']);
    // and catches up
    await run(h, 10);
    expect(Math.abs(mine.t - g.game!.t)).toBeLessThan(SPEEDS[4]);
  }, 60_000);

  it('lets a guest change the shared speed', async () => {
    const h = await lobby();
    const g = h.guest()!;
    const start = { seed: 9, home: home() };
    const mine = found(region(), start, 'Ana Transit');
    await h.host.begin(mine, { ...start, startT: mine.t, endT: mine.t + 6 * 3600, speed: 1 });
    await until(() => !!g.game);
    await run(h, 2);
    g.setSpeed(0);
    await run(h, 3);
    expect(mine.speed).toBe(0);
    expect(g.game!.speed).toBe(0);
    const t = mine.t;
    await run(h, 5);
    expect(mine.t).toBe(t);
  }, 60_000);

  it('runs the race clock on after the host goes bankrupt', async () => {
    const h = await lobby();
    const g = h.guest()!;
    const start = { seed: 9, home: home() };
    const mine = found(region(), start, 'Ana Transit');
    await h.host.begin(mine, { ...start, startT: mine.t, endT: mine.t + 2 * 3600, speed: 4 });
    await until(() => !!g.game);
    await run(h, 4);
    mine.state.company.status = 'bankrupt';
    const frozen = mine.t;
    await run(h, 200);
    expect(mine.t).toBe(frozen);
    expect(g.game!.t).toBe(h.host.start!.endT);
    await until(() => !!h.guestEv.results);
    expect(h.guestEv.results!.find((r) => r.name === 'Ana')!.score!.bankrupt).toBe(true);
  }, 60_000);

  it('turns away a different version and anyone after the start', async () => {
    const other = await lobby('other');
    expect(other.refused()).toMatch(/different versions/);
    const h = await lobby();
    h.host.announce();
    const t = h.hub.join('Late');
    let refused = '';
    new GuestSim(t, 'Cem', 'test', () => {
      throw new Error('no');
    }, { ended: (r) => (refused = r) });
    await until(() => !!refused);
    expect(refused).toMatch(/already started/);
  });

  it('shows friends in the lobby when the host changes the city or the length', async () => {
    const h = await lobby();
    const seen: RaceSetup[] = [];
    h.guestEv.setup = (s) => seen.push(s);
    h.host.changeSetup({ preset: 'tokyo-shibuya', city: 'Tokyo', area: 'Shibuya', days: 7 });
    await until(() => seen.length > 0);
    expect(h.guest()!.setup).toMatchObject({ city: 'Tokyo', days: 7 });
    // the setup is fixed once the race starts
    h.host.announce();
    h.host.changeSetup({ ...SETUP });
    await flush();
    expect(h.host.setup.city).toBe('Tokyo');
  });

  it('tells a guest waiting in the lobby when the host closes the race', async () => {
    const h = await lobby();
    h.host.end('The host closed the race.');
    await until(() => !!h.guestEv.reason);
    expect(h.guestEv.reason).toBe('The host closed the race.');
  });

  it('ranks by journeys, then balance', () => {
    const p = (id: string) => ({ id, name: id, colour: '#fff', host: false });
    const s = (journeys: number, balance: number) => ({ t: 0, journeys, balance, rep: 50, lines: 1, buses: 1, bankrupt: false });
    expect(rank([p('a'), p('b'), p('c'), p('d')], { a: s(10, 0), b: s(30, 0), c: s(10, 500) }).map((r) => r.id)).toEqual(['b', 'c', 'a', 'd']);
  });
});
