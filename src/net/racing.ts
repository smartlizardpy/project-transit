// Races: friends found their own companies in the same city at the same moment and see who carries
// the most passengers by the end. Every player runs their own simulation; only the clock, the
// scores and a sketch of each network travel. The host keeps the clock: nobody runs ahead of it,
// and it never runs far ahead of the slowest player, so everyone plays the same hours together.
//
// Nothing here knows about React or the session: race.ts wires it up, and tests drive it with an
// in-memory transport.

import type { Game } from '../game/engine.ts';
import { SPEEDS } from '../game/content.ts';
import type { RegionData } from '../game/world/region.ts';
import type { LngLat } from '../game/world/graph.ts';
import { pack, unpack } from './codec.ts';
import { PLAYER_COLOURS, PROTO, type Msg, type Player, type RaceResult, type RaceSetup, type RaceStart, type Score } from './protocol.ts';
import type { Transport } from './transport.ts';
import { MAX_PLAYERS } from './lockstep.ts';

const FRAME_MS = 100;
const HEARTBEAT_MS = 500;
const ACK_MS = 200;
/** scores go out at most this often (ms), and a network sketch after it settles */
const SCORE_MS = 1000;
const GHOST_MS = 1500;
/** the race starts without a player whose map has not loaded after this long (ms) */
const READY_TIMEOUT_MS = 90_000;
/** at the finish, results go out without a player who has not reported after this long (ms) */
const FINISH_TIMEOUT_MS = 20_000;

export interface RaceEvents {
  players?(list: Player[]): void;
  /** guest: the host changed the city or the length */
  setup?(setup: RaceSetup): void;
  scores?(scores: Record<string, Score>): void;
  ghost?(id: string, lines: LngLat[][], stops: LngLat[]): void;
  /** the host's clock waits for these players (still loading, or behind) */
  waiting?(names: string[]): void;
  /** guest: the host is loading the city */
  preparing?(): void;
  /** guest: the map is on its way (0–1) */
  loading?(share: number): void;
  /** the race began on this computer (its game exists) */
  started?(start: RaceStart): void;
  finished?(results: RaceResult[]): void;
  /** the race ended early: refused, or the host left */
  ended?(reason: string): void;
}

/** A player's standing, from their game. */
export function scoreOf(game: Game): Score {
  const s = game.state;
  return {
    t: s.clock.t,
    journeys: s.stats.total.trips,
    balance: Math.round(s.finance.balance),
    rep: Math.round(s.company.reputation * 10) / 10,
    lines: Object.keys(s.routes).length,
    buses: Object.keys(s.vehicles).length,
    bankrupt: s.company.status === 'bankrupt',
  };
}

/** A light sketch of a player's network for the others' maps: each line's streets and the stops. */
export function ghostOf(game: Game): { lines: LngLat[][]; stops: LngLat[] } {
  const g = game.region.graph;
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  const lines: LngLat[][] = [];
  for (const r of Object.values(game.state.routes)) {
    const pat = game.patterns.get(r.id)?.[0];
    const nodes = pat?.path.nodes ?? [];
    if (nodes.length < 2) continue;
    const step = Math.max(1, Math.ceil(nodes.length / 240));
    const p: LngLat[] = [];
    for (let i = 0; i < nodes.length; i += step) p.push([r5(g.lng[nodes[i]]), r5(g.lat[nodes[i]])]);
    const last = nodes[nodes.length - 1];
    p.push([r5(g.lng[last]), r5(g.lat[last])]);
    lines.push(p);
  }
  const stops = Object.values(game.state.stops).map((st) => [r5(st.lngLat[0]), r5(st.lngLat[1])] as LngLat);
  return { lines, stops };
}

/** Standings: most journeys first; a tie goes to the higher balance. */
export function rank(players: Player[], scores: Record<string, Score>): RaceResult[] {
  return players
    .map((p) => ({ id: p.id, name: p.name, colour: p.colour, score: scores[p.id] ?? null }))
    .sort((a, b) => (b.score?.journeys ?? -1) - (a.score?.journeys ?? -1) || (b.score?.balance ?? 0) - (a.score?.balance ?? 0));
}

/** What host and guest share: their own game, the scores, and sending their score and network. */
abstract class RaceSide {
  game: Game | null = null;
  me: Player | null = null;
  players: Player[] = [];
  scores: Record<string, Score> = {};
  start: RaceStart | null = null;
  done = false;
  protected lastScore = -Infinity;
  protected lastGhost = -Infinity;
  protected ghostDirty = true;
  private sentScore = '';

  constructor(protected net: Transport, protected ev: RaceEvents, protected now: () => number) {}

  /** The race clock as this computer sees it (a bankrupt company's game stops; the race does not). */
  abstract get clock(): number;

  /** Follow this player's game (a new Game object when the map grew). */
  protected follow(game: Game) {
    this.game = game;
    this.ghostDirty = true;
    game.on('changed', () => {
      if (this.game === game) this.ghostDirty = true;
    });
  }

  /** Send our score (when it changed, or at once on reaching the finish) and our network sketch. */
  protected report(force = false) {
    const g = this.game;
    if (!g || !this.me) return;
    const now = this.now();
    const t = this.clock;
    const atEnd = !!this.start && t >= this.start.endT && (this.scores[this.me.id]?.t ?? -1) < this.start.endT;
    if (force || atEnd || now - this.lastScore >= SCORE_MS) {
      this.lastScore = now;
      const s = { ...scoreOf(g), t };
      const key = `${s.journeys}|${s.balance}|${s.rep}|${s.lines}|${s.buses}|${s.bankrupt}|${atEnd}`;
      if (force || atEnd || key !== this.sentScore) {
        this.sentScore = key;
        this.scores = { ...this.scores, [this.me.id]: s };
        this.net.send({ k: 'score', s });
        this.ev.scores?.(this.scores);
      }
    }
    if (this.ghostDirty && now - this.lastGhost >= GHOST_MS) {
      this.lastGhost = now;
      this.ghostDirty = false;
      const { lines, stops } = ghostOf(g);
      this.net.send({ k: 'ghost', lines, stops });
    }
  }

  protected shared(m: Msg, from: string): boolean {
    if (m.k === 'score') {
      if (!this.players.some((p) => p.id === from)) return true;
      this.scores = { ...this.scores, [from]: m.s };
      this.ev.scores?.(this.scores);
      return true;
    }
    if (m.k === 'ghost') {
      this.ev.ghost?.(from, m.lines, m.stops);
      return true;
    }
    return false;
  }
}

// ─────────────────────────────────────────────────────────────── host

interface Racer {
  player: Player;
  /** game second the player has run to (null until their game exists) */
  ack: number | null;
}

export class RaceHost extends RaceSide {
  private racers = new Map<string, Racer>();
  /** the race's speed (our own game follows it unless our company went bankrupt) */
  private speed = 0;
  private t = 0;
  private vacc = 0;
  private startedAt = 0;
  private finishAt = 0;
  private lastFrame = -Infinity;
  private lastSentT = -1;
  private flush = false;
  private waitingFor = '';
  private go = false;
  /** the host is loading the city: nobody else can join */
  private locked = false;

  constructor(net: Transport, name: string, private build: string, readonly setup: RaceSetup, ev: RaceEvents = {}, now = () => performance.now()) {
    super(net, ev, now);
    this.me = { id: net.selfId, name, colour: PLAYER_COLOURS[0], host: true };
    this.players = [this.me];
    net.onMessage = (m, from) => this.receive(m, from);
    net.onPeer = (id, joined) => !joined && this.drop(id);
  }

  get clock() {
    return this.t;
  }

  get phase(): 'lobby' | 'running' | 'done' {
    return this.done ? 'done' : this.start ? 'running' : 'lobby';
  }

  /** Change the city or the length while still in the lobby. */
  changeSetup(setup: RaceSetup) {
    if (this.locked) return;
    Object.assign(this.setup, setup);
    this.net.send({ k: 'rsetup', setup: { ...this.setup } });
  }

  /** The host starts loading the city: tell everyone, and take no more players. */
  announce() {
    this.locked = true;
    this.net.send({ k: 'rstart' });
  }

  /**
   * Start the race: `game` is the host's own new company. Everyone else gets the map and the same
   * start (seed, home area, clock); the clock waits until their games exist.
   */
  async begin(game: Game, start: Omit<RaceStart, 'why'>) {
    if (this.start) return;
    this.start = { why: 'race', ...start };
    this.follow(game);
    game.setSpeed(0);
    this.t = game.t;
    this.startedAt = this.now();
    this.locked = true;
    this.ev.started?.(this.start);
    if (!this.racers.size) return;
    const { index: _index, ...region } = game.region;
    const bytes = await pack(region);
    await Promise.all([...this.racers.keys()].map((id) => this.net.sendBlob(this.start, bytes, id)));
  }

  /** Follow a new Game object (the map grew). */
  rebind(game: Game) {
    this.follow(game);
  }

  setSpeed(i: number) {
    if (!this.game || !this.start || this.done) return;
    this.speed = i;
    this.go = true;
    this.flush = true;
  }

  /** Called every animation frame: run the clock (held for players still loading, and at the finish). */
  frame(realDt: number) {
    const g = this.game, st = this.start;
    if (!g || !st || this.done) return;
    const now = this.now();
    const loading = [...this.racers.values()].filter((r) => r.ack === null);
    const holding = loading.length > 0 && now - this.startedAt < READY_TIMEOUT_MS;
    // everyone is in: the clock starts
    if (!holding && !this.go) {
      this.go = true;
      this.speed = st.speed;
      this.flush = true;
    }
    const speed = holding ? 0 : this.speed;
    const rate = SPEEDS[speed] ?? 0;
    let limit = st.endT;
    for (const r of this.racers.values()) if (r.ack !== null) limit = Math.min(limit, r.ack + Math.max(60, rate));
    if (!g.halted) {
      if (g.speed !== speed) g.setSpeed(speed);
      g.advance(realDt, limit);
      this.t = g.t;
    } else if (rate > 0) {
      // our company went bankrupt: the race clock runs on without it
      this.vacc += Math.min(realDt, 0.25) * rate;
      const n = Math.floor(this.vacc), room = Math.max(0, Math.floor(limit - this.t));
      this.t += Math.min(n, room);
      this.vacc = n > room ? 0 : this.vacc - n;
    }
    const slow = holding ? loading.map((r) => r.player.name) : [...this.racers.values()].filter((r) => r.ack !== null && rate > 0 && this.t < st.endT && r.ack + Math.max(60, rate) <= this.t).map((r) => r.player.name);
    const key = slow.join();
    if (key !== this.waitingFor) {
      this.waitingFor = key;
      this.ev.waiting?.(slow);
    }
    this.report();
    if (this.racers.size) {
      const due = this.flush || (this.t !== this.lastSentT && now - this.lastFrame >= FRAME_MS) || now - this.lastFrame >= HEARTBEAT_MS;
      if (due) {
        this.net.send({ k: 'clock', upTo: this.t, speed });
        this.flush = false;
        this.lastFrame = now;
        this.lastSentT = this.t;
      }
    }
    if (this.t >= st.endT) this.checkFinish(now);
  }

  /** Close the race for everyone. */
  end(reason = 'The host ended the race.') {
    if (!this.done) this.net.send({ k: 'bye', reason });
    this.done = true;
    this.net.leave();
  }

  private checkFinish(now: number) {
    const st = this.start!;
    if (!this.finishAt) this.finishAt = now;
    const reported = (id: string) => (this.scores[id]?.t ?? -1) >= st.endT;
    const all = reported(this.me!.id) && [...this.racers.keys()].every(reported);
    if (!all && now - this.finishAt < FINISH_TIMEOUT_MS) return;
    const results = rank(this.players, this.scores);
    this.net.send({ k: 'rend', results });
    this.done = true;
    this.game?.setSpeed(0);
    this.ev.finished?.(results);
    // give the results a moment to arrive, then close the connection
    setTimeout(() => this.net.leave(), 2000);
  }

  private receive(m: Msg, from: string) {
    if (this.shared(m, from)) return;
    const racer = this.racers.get(from);
    switch (m.k) {
      case 'hello': {
        if (racer) return;
        const refuse = m.proto !== PROTO || m.build !== this.build
          ? `You and the host have different versions of the game (${m.build} and ${this.build}). Update both to the latest version.`
          : this.locked ? 'This race has already started.'
          : this.racers.size + 1 >= MAX_PLAYERS ? `This race is full (${MAX_PLAYERS} players).` : null;
        if (refuse) return this.net.send({ k: 'refuse', reason: refuse }, from);
        const used = new Set(this.players.map((p) => p.colour));
        const player: Player = { id: from, name: m.name.trim().slice(0, 24) || 'Friend', colour: PLAYER_COLOURS.find((c) => !used.has(c)) ?? PLAYER_COLOURS[1], host: false };
        this.racers.set(from, { player, ack: null });
        this.players = [this.me!, ...[...this.racers.values()].map((r) => r.player)];
        this.net.send({ k: 'race', you: player, players: this.players, setup: this.setup }, from);
        this.net.send({ k: 'players', players: this.players });
        this.ev.players?.(this.players);
        return;
      }
      case 'speed':
        if (racer && Number.isInteger(m.i) && m.i >= 0 && m.i < SPEEDS.length) this.setSpeed(m.i);
        return;
      case 'ack':
        if (racer) racer.ack = m.t;
        return;
    }
  }

  private drop(id: string) {
    if (!this.racers.delete(id)) return;
    this.players = this.players.filter((p) => p.id !== id);
    this.net.send({ k: 'players', players: this.players });
    this.ev.players?.(this.players);
  }
}

// ─────────────────────────────────────────────────────────────── guest

export class RaceGuest extends RaceSide {
  host: string;
  setup: RaceSetup;
  private upTo = 0;
  private speed = 0;
  private lastAck = -Infinity;

  /**
   * Made from the host's `race` answer (the join flow starts as co-op's and hands over here).
   * `create` founds this player's company on the host's map.
   */
  constructor(
    net: Transport,
    welcome: Extract<Msg, { k: 'race' }>,
    from: string,
    private create: (region: RegionData, start: RaceStart) => Game,
    ev: RaceEvents = {},
    now = () => performance.now(),
  ) {
    super(net, ev, now);
    this.host = from;
    this.me = welcome.you;
    this.players = welcome.players;
    this.setup = welcome.setup;
    net.onMessage = (m, f) => this.receive(m, f);
    net.onBlob = (meta, bytes, f) => void this.begin(meta as RaceStart, bytes, f);
    net.onBlobProgress = (share, f) => (f === this.host ? this.ev.loading?.(share) : undefined);
    net.onPeer = (id, joined) => {
      if (!joined && id === this.host && !this.done) this.stop(this.game ? 'The host left the race. Your company keeps going on its own.' : 'The host left before the race started.');
    };
    queueMicrotask(() => this.ev.players?.(this.players));
  }

  get clock() {
    const g = this.game;
    return !g ? 0 : g.halted ? Math.max(g.t, this.upTo) : g.t;
  }

  rebind(game: Game) {
    this.follow(game);
  }

  setSpeed(i: number) {
    this.net.send({ k: 'speed', i }, this.host);
  }

  /** Called every animation frame: follow the host's clock with our own game. */
  frame(realDt: number) {
    const g = this.game;
    if (!g || this.done) return;
    if (!g.halted) {
      const rate = SPEEDS[this.speed] ?? 0;
      if (g.speed !== this.speed) g.setSpeed(this.speed);
      g.advance(realDt, this.upTo);
      // behind the host (a slow frame, a busy computer, the map just arrived): catch up a few ms at a time
      const behind = this.upTo - g.t;
      if (behind > 0 && (rate === 0 || behind > Math.max(30, rate * 0.5))) {
        const target = rate === 0 ? this.upTo : this.upTo - Math.floor(rate * 0.1);
        const t0 = this.now();
        while (g.t < target && this.now() - t0 < 12) g.tick();
      }
    }
    const now = this.now();
    if (now - this.lastAck >= ACK_MS) {
      this.lastAck = now;
      this.net.send({ k: 'ack', t: this.clock }, this.host);
    }
    this.report();
  }

  leave() {
    if (this.done) return;
    this.done = true;
    this.net.leave();
  }

  private stop(reason: string) {
    if (this.done) return;
    this.done = true;
    this.net.leave();
    this.ev.ended?.(reason);
  }

  private async begin(meta: RaceStart, bytes: Uint8Array, from: string) {
    if (from !== this.host || this.start || this.done || meta.why !== 'race') return;
    const region = await unpack<RegionData>(bytes);
    if (this.done) return;
    this.start = meta;
    const g = this.create(region, meta);
    this.follow(g);
    g.setSpeed(0);
    if (this.upTo < meta.startT) this.upTo = meta.startT;
    this.lastAck = -Infinity;
    this.ev.loading?.(1);
    this.ev.started?.(meta);
    this.frame(0); // tell the host at once that we are in
  }

  private receive(m: Msg, from: string) {
    if (this.shared(m, from)) return;
    if (from !== this.host) return;
    switch (m.k) {
      case 'players':
        this.players = m.players;
        this.ev.players?.(m.players);
        return;
      case 'rsetup':
        if (this.start) return;
        this.setup = m.setup;
        this.ev.setup?.(m.setup);
        return;
      case 'rstart':
        this.ev.preparing?.();
        return;
      case 'clock':
        if (m.upTo > this.upTo) this.upTo = m.upTo;
        this.speed = m.speed;
        return;
      case 'rend':
        this.done = true;
        this.game?.setSpeed(0);
        this.ev.finished?.(m.results);
        this.net.leave();
        return;
      case 'bye':
        this.stop(this.game ? `${m.reason} Your company keeps going on its own.` : m.reason);
        return;
    }
  }
}
