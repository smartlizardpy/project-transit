// Races in the app: the host picks a city and a length, friends join with a code, everyone founds a
// company in the same place at the same moment, and a scoreboard shows who carries the most
// passengers. The rules live in racing.ts; this file connects them to the session and the UI.

import { create } from 'zustand';
import type { Game } from '../game/engine.ts';
import { DAY, COMPANY_COLOURS } from '../game/content.ts';
import { applyAction } from '../game/actions.ts';
import type { LngLat } from '../game/world/graph.ts';
import type { Region } from '../game/world/region.ts';
import { session, useSession } from '../app/session.ts';
import { setActionRouter } from '../app/act.ts';
import { PRESETS, presetSpec } from '../app/presets.ts';
import { RaceGuest, RaceHost, type RaceEvents } from './racing.ts';
import { PLAYER_COLOURS, type Msg, type Player, type RaceResult, type RaceSetup, type RaceStart, type Score } from './protocol.ts';
import type { Transport } from './transport.ts';
import { connect, makeCode, rememberName } from './room.ts';

export type RacePhase = 'off' | 'lobby' | 'loading' | 'racing' | 'finished' | 'ended';

/** How long a race can run, in game days. */
export const RACE_DAYS = [7, 14, 30] as const;
/** The clock starts at this speed (anyone can change it). */
const START_SPEED = 1;

interface RaceStore {
  phase: RacePhase;
  role: 'host' | 'guest' | null;
  code: string | null;
  me: Player | null;
  players: Player[];
  setup: RaceSetup | null;
  start: RaceStart | null;
  scores: Record<string, Score>;
  /** players the clock waits for */
  waiting: string[];
  /** guest: the map download, 0–1 (null: the host is still loading the city) */
  loading: number | null;
  results: RaceResult[] | null;
  /** why the race ended early (or could not start) */
  ended: string | null;
  /** draw the rivals' lines on the map */
  ghosts: boolean;
}

const initial = { phase: 'off' as RacePhase, role: null, code: null, me: null, players: [], setup: null, start: null, scores: {}, waiting: [], loading: null, results: null, ended: null };
export const useRace = create<RaceStore>(() => ({ ...initial, ghosts: true }));

/** Rivals' networks, read by the map layer. */
export const rivals = {
  nets: new Map<string, { lines: LngLat[][]; stops: LngLat[] }>(),
  listeners: new Set<() => void>(),
  emit() {
    this.listeners.forEach((f) => f());
  },
};

let host: RaceHost | null = null;
let guest: RaceGuest | null = null;
let stopWatching: (() => void) | null = null;

const side = () => host ?? guest;

/** A race is running on this computer: its clock drives the game (see the map controller). */
export const raceActive = () => {
  const s = side();
  return !!(s && s.game && !s.done);
};

/** The race clock on this computer (game seconds), for the scoreboard. */
export const raceClock = () => side()?.clock ?? 0;

export function raceFrame(dt: number) {
  side()?.frame(dt);
}

function events(): RaceEvents {
  return {
    players: (players) => {
      useRace.setState({ players });
      for (const id of [...rivals.nets.keys()]) if (!players.some((p) => p.id === id)) rivals.nets.delete(id);
      rivals.emit();
    },
    scores: (scores) => useRace.setState({ scores }),
    setup: (setup) => useRace.setState({ setup }),
    ghost: (id, lines, stops) => {
      rivals.nets.set(id, { lines, stops });
      rivals.emit();
    },
    waiting: (waiting) => useRace.setState({ waiting }),
    preparing: () => useRace.setState({ phase: 'loading', loading: null }),
    loading: (share) => useRace.setState({ phase: 'loading', loading: share }),
    started: (start) => {
      useRace.setState({ phase: 'racing', start, loading: null });
      watchGame();
    },
    finished: (results) => {
      useRace.setState({ phase: 'finished', results, waiting: [] });
      detach();
    },
    ended: (reason) => finish(reason),
  };
}

/** The company colour closest to each player colour (amber, blue, pink, green). */
const COMPANY_FOR_PLAYER = [3, 2, 6, 5];

/** Every player's company: their name, in the company colour nearest their player colour. */
function companyFor(p: Player) {
  const i = Math.max(0, PLAYER_COLOURS.indexOf(p.colour));
  return { name: `${p.name} Transit`.slice(0, 40), colour: COMPANY_COLOURS[COMPANY_FOR_PLAYER[i]], logo: i };
}

/** Speed changes go to the host's clock; everything else is this player's own business. */
function route(s: RaceHost | RaceGuest) {
  setActionRouter({
    submit: (a, local) => (session.game ? Promise.resolve(applyAction(session.game, a, local)) : Promise.resolve({ ok: false, error: 'No game is running.' })),
    setSpeed: (i) => s.setSpeed(i),
  });
}

/** The map grew: follow the new game. Quitting or loading another game leaves the race. */
function watchGame() {
  stopWatching?.();
  const s = side();
  let current = s?.game ?? null;
  stopWatching = session.onGame((next: Game | null, info) => {
    const now = side();
    if (!now || !current) return;
    if (next && info?.grown) {
      now.rebind(next);
      current = next;
    } else if (next !== current) leaveRace();
  });
}

// ─────────────────────────────────────────────────────────────── host

/** Open a race lobby (from the start menu). Returns the code for friends. */
export async function openRace(name: string, preset: string, days: number): Promise<string | null> {
  if (host || guest) return null;
  const p = PRESETS.find((x) => x.id === preset) ?? PRESETS[0];
  rememberName(name);
  const code = makeCode();
  useRace.setState({ ...initial, phase: 'lobby', role: 'host', code });
  let t: Transport;
  try {
    t = await connect(code);
  } catch (e) {
    useRace.setState({ ...initial, phase: 'ended', ended: `Could not start the connection: ${(e as Error).message}` });
    return null;
  }
  if (useRace.getState().code !== code) {
    t.leave();
    return null;
  }
  const setup: RaceSetup = { preset: p.id, city: p.city, area: p.area, days };
  const h = new RaceHost(t, name.trim() || 'Host', __APP_VERSION__, setup, events());
  host = h;
  useRace.setState({ me: h.me, players: h.players, setup });
  return code;
}

/** Change the city or length before the race starts (friends see it when they join). */
export function changeRace(preset: string, days: number) {
  const p = PRESETS.find((x) => x.id === preset);
  if (!host || !p || host.phase !== 'lobby') return;
  const setup: RaceSetup = { preset: p.id, city: p.city, area: p.area, days };
  host.changeSetup(setup);
  useRace.setState({ setup: { ...setup } });
}

/** Host: load the city, found everyone's company and start the clock. */
export async function startRace() {
  const h = host;
  if (!h || h.phase !== 'lobby') return;
  const p = PRESETS.find((x) => x.id === h.setup.preset) ?? PRESETS[0];
  h.announce();
  useRace.setState({ phase: 'loading', loading: null });
  const region = await session.loadRaceCity(presetSpec(p));
  if (host !== h) return;
  if (!region) {
    // the race dialog says why; friends are told the race is off
    h.end('The host’s game could not load the city, so the race was called off.');
    const why = useSession.getState().error;
    useSession.setState({ error: null });
    return finish(`The city could not be loaded${why ? `: ${why}` : '.'} Check your connection and try again.`);
  }
  const home = busiest(region);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
  const game = session.startRace(region, { seed, home }, companyFor(h.me!));
  route(h);
  await h.begin(game, { seed, home, startT: game.t, endT: game.t + h.setup.days * DAY, speed: START_SPEED });
}

/** The busiest area (most residents and jobs) is everyone's home area. */
function busiest(region: Region): string {
  const zones = region.zones.filter((z) => !z.water).sort((a, b) => b.residents + b.jobs - (a.residents + a.jobs));
  return zones[0].id;
}

// ─────────────────────────────────────────────────────────────── guest

/** The join flow (coop.ts) found a race behind the code: this computer joins it. */
export function joinedRace(t: Transport, welcome: Extract<Msg, { k: 'race' }>, from: string, code: string) {
  if (host || guest) {
    t.leave();
    return;
  }
  useRace.setState({ ...initial, phase: 'lobby', role: 'guest', code, me: welcome.you, players: welcome.players, setup: welcome.setup });
  const g = new RaceGuest(t, welcome, from, (region, start) => {
    const me = useRace.getState().me ?? welcome.you;
    const game = session.startRace(region, start, companyFor(me));
    return game;
  }, events());
  guest = g;
  route(g);
}

// ─────────────────────────────────────────────────────────────── leaving

/** Leave the race (or call it off, for the host). This player's company stays open. */
export function leaveRace() {
  finish(null, true);
}

/** The race is over or called off: the session lets go, the game (if any) becomes a normal game. */
function detach() {
  stopWatching?.();
  stopWatching = null;
  setActionRouter(null);
  host = null;
  guest = null;
}

function finish(reason: string | null, byMe = false) {
  if (byMe) {
    if (host) host.end(useRace.getState().phase === 'lobby' ? 'The host closed the race.' : 'The host ended the race.');
    guest?.leave();
  }
  const game = side()?.game;
  detach();
  game?.setSpeed(0);
  rivals.nets.clear();
  rivals.emit();
  const s = useRace.getState();
  useRace.setState({ ...initial, ghosts: s.ghosts, phase: reason ? 'ended' : 'off', ended: reason });
}

/** Close the results or the "race ended" note. */
export function dismissRace() {
  rivals.nets.clear();
  rivals.emit();
  useRace.setState({ ...initial, ghosts: useRace.getState().ghosts });
}

if (typeof window !== 'undefined') Object.assign(window, { __race: { state: useRace.getState, open: openRace, change: changeRace, start: startRace, leave: leaveRace } });
