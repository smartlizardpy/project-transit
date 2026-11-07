// Co-op sessions in the app: host the open game or join a friend's with a room code, see each
// other's cursors, and play one company together. The lockstep rules live in lockstep.ts; this
// file connects them to the session, the action router and the UI.

import { create } from 'zustand';
import type { Game } from '../game/engine.ts';
import type { GameState } from '../game/types.ts';
import type { RegionData } from '../game/world/region.ts';
import type { Action } from '../game/actions.ts';
import type { LngLat } from '../game/world/graph.ts';
import { session } from '../app/session.ts';
import { setActionRouter } from '../app/act.ts';
import { GuestSim, HostSim, type CoopEvents } from './lockstep.ts';
import type { Player, Stamped } from './protocol.ts';
import type { Transport } from './transport.ts';
import { checksum } from './checksum.ts';
import { act } from '../app/act.ts';
import { connect, makeCode, rememberName } from './room.ts';
import { joinedRace } from './race.ts';

export type CoopPhase = 'off' | 'hosting' | 'connecting' | 'loading' | 'playing' | 'ended';

export interface FeedItem {
  id: number;
  who: string;
  colour: string;
  text: string;
  at: number;
}

interface CoopStore {
  phase: CoopPhase;
  role: 'host' | 'guest' | null;
  code: string | null;
  me: Player | null;
  players: Player[];
  /** game copy download, 0–1 (guest) */
  loading: number | null;
  /** players the host's clock is waiting for */
  waiting: string[];
  feed: FeedItem[];
  /** why the session could not start or ended */
  ended: string | null;
}

export const useCoop = create<CoopStore>(() => ({ phase: 'off', role: null, code: null, me: null, players: [], loading: null, waiting: [], feed: [], ended: null }));

/** Remote cursors and pings change many times a second: kept outside React, read by the map layer. */
export const presence = {
  cursors: new Map<string, { at: LngLat; seen: number }>(),
  pings: [] as { id: string; at: LngLat; colour: string; t: number }[],
  listeners: new Set<() => void>(),
  emit() {
    this.listeners.forEach((f) => f());
  },
};

export { savedName, makeCode, normaliseCode, coopAvailable } from './room.ts';

let host: HostSim | null = null;
let guest: GuestSim | null = null;
let net: Transport | null = null;
let stopWatching: (() => void) | null = null;
let connectTimer = 0;
let feedId = 0;

export const coopActive = () => !!(host || guest?.game);

/** The shared clock: called every animation frame instead of Game.advance while a session runs. */
export function coopFrame(dt: number) {
  if (host) host.frame(dt);
  else guest?.frame(dt);
}

function playerName(id: string) {
  return useCoop.getState().players.find((p) => p.id === id);
}

function events(): CoopEvents {
  return {
    players: (players) => {
      const before = useCoop.getState().players;
      const me = host?.me ?? guest?.me ?? useCoop.getState().me;
      useCoop.setState({ players, me });
      for (const p of players) if (!before.some((b) => b.id === p.id) && p.id !== me?.id && before.length) addFeed(p, 'joined');
      for (const p of before) if (!players.some((q) => q.id === p.id)) {
        addFeed(p, 'left');
        presence.cursors.delete(p.id);
        presence.emit();
      }
    },
    applied: (st, res) => noteAction(st, res),
    presence: (m, from) => {
      if (m.k === 'cursor') {
        if (m.at) presence.cursors.set(from, { at: m.at, seen: performance.now() });
        else presence.cursors.delete(from);
      } else presence.pings.push({ id: from, at: m.at, colour: playerName(from)?.colour ?? '#fff', t: performance.now() });
      presence.emit();
    },
    waiting: (names) => useCoop.setState({ waiting: names }),
    desync: (name) => console.warn(`co-op: re-synced ${name}`),
    loading: (share, why) => {
      if (why !== 'join') return;
      useCoop.setState(share >= 1 ? { loading: null, phase: 'playing' } : { loading: share, phase: 'loading' });
    },
    ended: (reason) => finish(reason),
    // the code was for a race: hand the connection over (race.ts)
    race: (welcome, from) => {
      const t = net, code = useCoop.getState().code;
      if (!t || !code) return;
      clearTimeout(connectTimer);
      stopWatching?.();
      stopWatching = null;
      guest = null;
      net = null;
      setActionRouter(null);
      session.coop = null;
      useCoop.setState({ phase: 'off', role: null, code: null, me: null, players: [], loading: null, waiting: [], ended: null });
      joinedRace(t, welcome, from, code);
    },
  };
}

const VERB: Partial<Record<Action['m'], string>> = {
  placeStop: 'built a stop', renameStop: 'renamed a stop', removeStop: 'removed a stop', moveStop: 'moved a stop',
  createRoute: 'opened a line', updateRoute: 'changed a line', deleteRoute: 'closed a line', setTimetable: 'changed a timetable', setServicePlans: 'changed service plans',
  buildDepot: 'built a depot', expandDepot: 'expanded a depot', moveToDepot: 'moved a bus to another depot',
  buyVehicle: 'bought a bus', assignVehicle: 'moved a bus', sellVehicle: 'sold a bus', serviceVehicle: 'sent a bus for maintenance',
  setFare: 'changed the fare', takeLoan: 'took a loan', repayLoan: 'repaid some of the loan', buyLicence: 'licensed a new area',
  createWorkflow: 'made a workflow', updateWorkflow: 'changed a workflow', deleteWorkflow: 'deleted a workflow', fromTemplate: 'made a workflow',
  applyPlan: 'applied Improve service changes', applyFix: 'fixed a route', undoApplied: 'undid a change',
};

function noteAction(st: Stamped, res: unknown) {
  const me = useCoop.getState().me;
  if (!me || st.by === me.id) return;
  const ok = !(res && typeof res === 'object' && 'ok' in res && (res as { ok: boolean }).ok === false);
  const verb = VERB[st.a.m];
  const p = playerName(st.by);
  if (ok && verb && p) addFeed(p, verb);
}

function addFeed(p: Player, text: string) {
  const feed = [...useCoop.getState().feed, { id: ++feedId, who: p.name, colour: p.colour, text, at: performance.now() }].slice(-6);
  useCoop.setState({ feed });
}

/** Host the game that is open now. Returns the room code to give to friends. */
export async function hostGame(name: string): Promise<string | null> {
  const g = session.game;
  if (!g || host || guest) return null;
  rememberName(name);
  const code = makeCode();
  const t = await connect(code);
  if (session.game !== g || host || guest) {
    t.leave();
    return null;
  }
  net = t;
  host = new HostSim(g, net, name.trim() || 'Host', __APP_VERSION__, events());
  session.coop = 'host';
  const h = host;
  setActionRouter({
    submit: (a, local) => Promise.resolve(h.submit(a, undefined, undefined, local)),
    setSpeed: (i) => h.setSpeed(i),
  });
  // the map grew: everyone moves to the bigger map; another game opened (or quit): the session ends
  stopWatching = session.onGame((next: Game | null, info) => {
    if (!host) return;
    if (next && info?.grown) host.bind(next);
    else finish(null, true);
  });
  useCoop.setState({ phase: 'hosting', role: 'host', code, me: h.me, players: h.players(), ended: null, feed: [], waiting: [] });
  return code;
}

/** Join a friend's game. The game opens once the host has sent it. */
export async function joinGame(code: string, name: string) {
  if (host || guest) return;
  rememberName(name);
  if (session.game) {
    if (!(await session.quitToMenu())) return;
  }
  session.coop = 'guest';
  useCoop.setState({ phase: 'connecting', role: 'guest', code, me: null, players: [], ended: null, feed: [], loading: null });
  let t: Transport;
  try {
    t = await connect(code);
  } catch (e) {
    session.coop = null;
    useCoop.setState({ phase: 'ended', role: null, code: null, ended: `Could not start the connection: ${(e as Error).message}` });
    return;
  }
  // cancelled while the connection library loaded
  if (useCoop.getState().phase !== 'connecting' || useCoop.getState().code !== code) {
    t.leave();
    return;
  }
  net = t;
  let adopting = false;
  const adopt = (state: GameState, region: RegionData | null, why: 'join' | 'resync' | 'grow') => {
    adopting = true;
    try {
      return session.adoptCoopGame(state, region, why);
    } finally {
      adopting = false;
    }
  };
  const gs = new GuestSim(t, name.trim() || 'Friend', __APP_VERSION__, adopt, events());
  guest = gs;
  setActionRouter({ submit: (a, local) => gs.submit(a, local), setSpeed: (i) => gs.setSpeed(i) });
  connectTimer = window.setTimeout(() => {
    if (guest === gs && !gs.host) finish('Could not reach your friend’s game. Check the code with them and that their game is still open. If it still fails, one of your networks may block direct connections (some work, school and mobile networks do): try another Wi‑Fi.');
  }, 45_000);
  // quitting to the menu (or loading another game) leaves the session
  stopWatching = session.onGame((next) => {
    if (guest === gs && gs.game && !adopting && next !== gs.game) finish(null, true);
  });
}

/** Leave (guest) or end (host) the session. The game stays open on this computer. */
export function leaveCoop() {
  finish(null, true);
}

function finish(reason: string | null, byMe = false) {
  clearTimeout(connectTimer);
  stopWatching?.();
  stopWatching = null;
  if (host) {
    if (byMe) host.end();
    host = null;
  }
  if (guest) {
    guest.leave();
    // the copy keeps running on its own, paused
    guest.game?.setSpeed(0);
    guest = null;
  }
  net = null;
  setActionRouter(null);
  session.leaveCoop();
  presence.cursors.clear();
  presence.pings.length = 0;
  presence.emit();
  useCoop.setState({ phase: reason ? 'ended' : 'off', role: null, code: null, me: null, players: [], loading: null, waiting: [], ended: reason });
}

export function dismissEnded() {
  useCoop.setState({ phase: 'off', ended: null });
}

// ───────────────────────────────────────── presence

let lastCursor = 0;
let cursorTimer = 0;
let pendingCursor: LngLat | null = null;

/** Tell the others where this player's mouse is on the map (null: off the map). At most ~15 times a second. */
export function sendCursor(at: LngLat | null) {
  if (!net || (!host && !guest?.game)) return;
  pendingCursor = at;
  const now = performance.now();
  const go = () => {
    lastCursor = performance.now();
    cursorTimer = 0;
    net?.send({ k: 'cursor', at: pendingCursor });
  };
  if (now - lastCursor >= 66) go();
  else if (!cursorTimer) cursorTimer = window.setTimeout(go, 66 - (now - lastCursor));
}

/** Point at a spot: a pulse appears there for everyone. */
export function sendPing(at: LngLat) {
  const me = useCoop.getState().me;
  if (!net || !me) return;
  net.send({ k: 'ping', at });
  presence.pings.push({ id: me.id, at, colour: me.colour, t: performance.now() });
  presence.emit();
}

// for scripts and the console, like window.__game: act as this player, and compare games
if (typeof window !== 'undefined') Object.assign(window, { __coop: { act, state: useCoop.getState, sum: () => (session.game ? checksum(session.game) : null) } });
