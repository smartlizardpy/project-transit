// Lockstep co-op (the way OpenTTD does it): every computer runs the same simulation, and only
// player actions travel. The host owns the clock: it applies each action at its current game
// second, stamps it with that second, and tells the others how far they may run. A guest never
// runs past the host, so it always reaches an action's second before applying it. Every ten game
// minutes guests send a checksum; if one differs, the host sends that guest a fresh copy of the game.
//
// Nothing here knows about React or the session: coop.ts wires it up, and tests drive it with an
// in-memory transport.

import type { Game } from '../game/engine.ts';
import { applyAction, type Action, type LocalHooks } from '../game/actions.ts';
import { SPEEDS } from '../game/content.ts';
import type { GameState } from '../game/types.ts';
import type { RegionData } from '../game/world/region.ts';
import { checksum, SUM_EVERY } from './checksum.ts';
import { pack, unpack } from './codec.ts';
import { PLAYER_COLOURS, PROTO, type Msg, type Player, type SnapshotMeta, type Stamped } from './protocol.ts';
import type { Transport } from './transport.ts';

/** How often the host sends a frame while the clock runs, and while it is paused (ms). */
const FRAME_MS = 66;
const HEARTBEAT_MS = 500;
/** How often a guest reports how far it has run (ms). */
const ACK_MS = 150;
/** A guest's action gets no answer after this long: tell the player (ms). */
const ACT_TIMEOUT_MS = 20_000;
/** At most this many people in a session, host included. */
export const MAX_PLAYERS = 4;

/** JSON round trip, so the host applies exactly what the guests receive. */
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export interface Snapshot {
  state: GameState;
  region?: RegionData;
}

/** What the UI hears about (both roles). */
export interface CoopEvents {
  players?(list: Player[]): void;
  /** an action was applied on this computer (from anyone) */
  applied?(st: Stamped, result: unknown): void;
  /** presence messages (cursors, pings) */
  presence?(msg: Extract<Msg, { k: 'cursor' | 'ping' }>, from: string): void;
  /** the host waits for a slower guest */
  waiting?(names: string[]): void;
  /** host: a guest's checksum differed (it is being sent the game again) */
  desync?(player: string, t: number): void;
  /** guest: a game copy is on its way or arrived */
  loading?(share: number, why: SnapshotMeta['why']): void;
  /** guest: the host turned us away, or ended the session */
  ended?(reason: string): void;
  /** guest: the code belongs to a race, not a shared game (the guest stops; racing.ts takes over) */
  race?(welcome: Extract<Msg, { k: 'race' }>, from: string): void;
}

function runAction(game: Game, a: Action, local?: LocalHooks): unknown {
  try {
    return applyAction(game, a, local);
  } catch (e) {
    console.error('co-op action failed', a, e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────── host

interface Guest {
  player: Player;
  /** game second the guest has run to (null while it loads the game) */
  ack: number | null;
  lastResync: number;
}

export class HostSim {
  game!: Game;
  readonly me: Player;
  private seq = 0;
  private outbox: Stamped[] = [];
  private guests = new Map<string, Guest>();
  /** our checksums by game second, to compare with the guests' */
  private sums = new Map<number, number>();
  private lastFrame = -Infinity;
  private lastSentT = -1;
  private flush = false;
  private waitingFor = '';

  constructor(game: Game, private net: Transport, name: string, private build: string, private ev: CoopEvents = {}, private now = () => performance.now()) {
    this.me = { id: net.selfId, name, colour: PLAYER_COLOURS[0], host: true };
    this.bind(game);
    net.onMessage = (m, from) => this.receive(m, from);
    net.onPeer = (id, joined) => !joined && this.drop(id);
  }

  /** Follow a new Game object (the map grew); everyone gets the new map. */
  bind(game: Game) {
    const first = !this.game;
    this.game = game;
    this.sums.clear();
    game.on('minute', (t) => {
      if (this.game !== game || (t as number) % SUM_EVERY !== 0) return;
      this.sums.set(t as number, checksum(game));
      if (this.sums.size > 60) this.sums.delete(this.sums.keys().next().value!);
    });
    if (!first) for (const id of this.guests.keys()) void this.sendSnapshot(id, 'grow', true);
  }

  players(): Player[] {
    return [this.me, ...[...this.guests.values()].map((g) => g.player)];
  }

  /** Apply an action now and send it to everyone. Returns its result. */
  submit(a: Action, by = this.me.id, req?: number, local?: LocalHooks): unknown {
    const w = wire(a);
    const st: Stamped = { seq: ++this.seq, t: this.game.t, by, req, a: w };
    const res = runAction(this.game, w, by === this.me.id ? local : undefined);
    if (this.guests.size) this.outbox.push(st);
    this.flush = true;
    this.ev.applied?.(st, res);
    return res;
  }

  setSpeed(i: number) {
    this.game.setSpeed(i);
    this.flush = true;
  }

  /** Called every animation frame: run the clock (no further than the slowest guest allows) and send a frame. */
  frame(realDt: number) {
    const g = this.game;
    const rate = SPEEDS[g.speed] ?? 0;
    let limit = Infinity;
    const slow: string[] = [];
    for (const x of this.guests.values()) {
      if (x.ack === null) continue;
      const lim = x.ack + Math.max(60, rate);
      if (lim < limit) limit = lim;
    }
    g.advance(realDt, limit);
    if (rate > 0 && g.t >= limit) for (const x of this.guests.values()) if (x.ack !== null && x.ack + Math.max(60, rate) <= g.t) slow.push(x.player.name);
    const key = slow.join();
    if (key !== this.waitingFor) {
      this.waitingFor = key;
      this.ev.waiting?.(slow);
    }
    if (!this.guests.size) return;
    const now = this.now();
    const due = this.flush || this.outbox.length > 0 || (g.t !== this.lastSentT && now - this.lastFrame >= FRAME_MS) || now - this.lastFrame >= HEARTBEAT_MS;
    if (!due) return;
    this.net.send({ k: 'frame', upTo: g.t, speed: g.speed, acts: this.outbox });
    this.outbox = [];
    this.flush = false;
    this.lastFrame = now;
    this.lastSentT = g.t;
  }

  /** Close the session for everyone. */
  end(reason = 'The host ended the session.') {
    this.net.send({ k: 'bye', reason });
    this.net.leave();
  }

  private receive(m: Msg, from: string) {
    const guest = this.guests.get(from);
    switch (m.k) {
      case 'hello': {
        if (guest) return;
        const refuse = m.proto !== PROTO || m.build !== this.build
          ? `You and the host have different versions of the game (${m.build} and ${this.build}). Update both to the latest version.`
          : this.guests.size + 1 >= MAX_PLAYERS ? `This game is full (${MAX_PLAYERS} players).` : null;
        if (refuse) return this.net.send({ k: 'refuse', reason: refuse }, from);
        const used = new Set(this.players().map((p) => p.colour));
        const player: Player = { id: from, name: m.name.trim().slice(0, 24) || 'Friend', colour: PLAYER_COLOURS.find((c) => !used.has(c)) ?? PLAYER_COLOURS[1], host: false };
        this.guests.set(from, { player, ack: null, lastResync: -Infinity });
        const players = this.players();
        this.net.send({ k: 'welcome', you: player, players }, from);
        this.net.send({ k: 'players', players });
        this.ev.players?.(players);
        void this.sendSnapshot(from, 'join', true);
        return;
      }
      case 'act':
        if (!guest) return;
        this.submit(m.a, from, m.req);
        return;
      case 'speed':
        if (guest && Number.isInteger(m.i) && m.i >= 0 && m.i < SPEEDS.length) this.setSpeed(m.i);
        return;
      case 'ack':
        if (guest) guest.ack = m.t;
        return;
      case 'sum': {
        const ours = this.sums.get(m.t);
        if (!guest || ours === undefined || ours === m.h) return;
        const now = this.now();
        if (now - guest.lastResync < 10_000) return; // a copy is already on its way
        guest.lastResync = now;
        console.warn(`co-op: ${guest.player.name} drifted at game second ${m.t}; sending the game again`);
        this.ev.desync?.(guest.player.name, m.t);
        void this.sendSnapshot(from, 'resync', false);
        return;
      }
      case 'cursor': case 'ping':
        this.ev.presence?.(m, from);
        return;
    }
  }

  private async sendSnapshot(to: string, why: SnapshotMeta['why'], withRegion: boolean) {
    const g = this.game;
    const meta: SnapshotMeta = { why, t: g.t, seq: this.seq, speed: g.speed, region: withRegion };
    const state = JSON.parse(g.serialize()) as GameState;
    let snap: Snapshot = { state };
    if (withRegion) {
      const { index: _index, ...region } = g.region;
      snap = { state, region };
    }
    const bytes = await pack(snap);
    if (!this.guests.has(to)) return;
    await this.net.sendBlob(meta, bytes, to);
  }

  private drop(id: string) {
    if (!this.guests.delete(id)) return;
    const players = this.players();
    this.net.send({ k: 'players', players });
    this.ev.players?.(players);
  }
}

// ─────────────────────────────────────────────────────────────── guest

interface Pending {
  resolve: (r: unknown) => void;
  local?: LocalHooks;
  timer: ReturnType<typeof setTimeout>;
}

export class GuestSim {
  game: Game | null = null;
  me: Player | null = null;
  players: Player[] = [];
  host: string | null = null;
  private queue: Stamped[] = [];
  private upTo = 0;
  private speed = 0;
  private snapSeq = -1;
  private req = 0;
  private pending = new Map<number, Pending>();
  private lastAck = -Infinity;
  private closed = false;

  /**
   * `adopt` turns a received game into a running Game (the session does this so the UI follows;
   * `region` is null when the map did not change).
   */
  constructor(
    private net: Transport,
    private name: string,
    private build: string,
    private adopt: (state: GameState, region: RegionData | null, why: SnapshotMeta['why']) => Game,
    private ev: CoopEvents = {},
    private now = () => performance.now(),
  ) {
    net.onMessage = (m, from) => this.receive(m, from);
    net.onBlob = (meta, bytes, from) => void this.snapshot(meta as SnapshotMeta, bytes, from);
    net.onBlobProgress = (share, from) => (from === this.host ? this.ev.loading?.(share, this.game ? 'resync' : 'join') : undefined);
    // the host is whoever answers: say hello to everyone who appears until someone does
    net.onPeer = (id, joined) => {
      if (joined && !this.host) this.net.send({ k: 'hello', name: this.name, proto: PROTO, build: this.build }, id);
      if (!joined && id === this.host) this.end('The host left the game.');
    };
  }

  /** Ask the host to apply an action; resolves with its result once it runs here. */
  submit(a: Action, local?: LocalHooks): Promise<unknown> {
    if (!this.host || !this.game || this.closed) return Promise.resolve({ ok: false, error: 'Not connected to the host.' });
    const req = ++this.req;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(req)) resolve({ ok: false, error: 'The host did not answer. Check your connection.' });
      }, ACT_TIMEOUT_MS);
      this.pending.set(req, { resolve, local, timer });
      this.net.send({ k: 'act', req, a: wire(a) }, this.host);
    });
  }

  setSpeed(i: number) {
    if (this.host) this.net.send({ k: 'speed', i }, this.host);
  }

  /** Called every animation frame: follow the host's clock. */
  frame(realDt: number) {
    const g = this.game;
    if (!g || this.closed) return;
    this.applyDue();
    const rate = SPEEDS[this.speed] ?? 0;
    g.advance(realDt, this.upTo);
    // far behind (just joined, a slow frame, a busy computer) or the clock stopped short of the
    // host's: catch up, a few milliseconds at a time
    const behind = this.upTo - g.t;
    if (behind > 0 && (rate === 0 || behind > Math.max(30, rate * 0.5))) {
      const target = rate === 0 ? this.upTo : this.upTo - Math.floor(rate * 0.1);
      const t0 = this.now();
      while (g.t < target && this.now() - t0 < 12) g.tick();
    }
    this.applyDue();
    const now = this.now();
    if (now - this.lastAck >= ACK_MS && this.host) {
      this.lastAck = now;
      this.net.send({ k: 'ack', t: g.t }, this.host);
    }
  }

  /** How far behind the host's clock we are, in game seconds. */
  get lag() {
    return this.game ? this.upTo - this.game.t : 0;
  }

  leave() {
    if (this.closed) return;
    this.end(null);
    this.net.leave();
  }

  private end(reason: string | null) {
    if (this.closed) return;
    this.closed = true;
    for (const [req, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'The session ended.' });
      this.pending.delete(req);
    }
    if (reason) this.ev.ended?.(reason);
  }

  private receive(m: Msg, from: string) {
    if (m.k === 'welcome') {
      if (this.host) return;
      this.host = from;
      this.me = m.you;
      this.players = m.players;
      this.ev.players?.(m.players);
      return;
    }
    if (m.k === 'race') {
      if (this.host || this.closed) return;
      this.closed = true;
      this.ev.race?.(m, from);
      return;
    }
    if (m.k === 'cursor' || m.k === 'ping') return this.ev.presence?.(m, from);
    if (m.k === 'refuse') {
      if (!this.host) this.end(m.reason);
      return;
    }
    if (from !== this.host) return;
    switch (m.k) {
      case 'players':
        this.players = m.players;
        this.ev.players?.(m.players);
        return;
      case 'frame':
        for (const st of m.acts) if (st.seq > this.snapSeq) this.queue.push(st);
        if (m.upTo > this.upTo) this.upTo = m.upTo;
        if (m.speed !== this.speed) {
          this.speed = m.speed;
          this.game?.setSpeed(m.speed);
        }
        this.applyDue();
        return;
      case 'bye':
        this.end(m.reason);
        this.net.leave();
        return;
    }
  }

  private async snapshot(meta: SnapshotMeta, bytes: Uint8Array, from: string) {
    if (from !== this.host || this.closed) return;
    const snap = await unpack<Snapshot>(bytes);
    if (this.closed) return;
    const g = this.adopt(snap.state, meta.region ? snap.region ?? null : null, meta.why);
    this.game = g;
    g.beforeTick = (t) => this.applyDue(t);
    g.on('minute', (t) => {
      if (this.game === g && (t as number) % SUM_EVERY === 0 && this.host) this.net.send({ k: 'sum', t: t as number, h: checksum(g) }, this.host);
    });
    this.snapSeq = meta.seq;
    // actions already in the copy are dropped; anyone waiting on one is told
    const dropped = this.queue.filter((st) => st.seq <= meta.seq);
    this.queue = this.queue.filter((st) => st.seq > meta.seq);
    for (const st of dropped) this.settle(st, { ok: false, error: 'The game was synced again while this change was on its way. Check that it went through.' });
    if (meta.t > this.upTo) this.upTo = meta.t;
    if (this.speed === 0 && meta.speed) this.speed = meta.speed;
    g.setSpeed(this.speed);
    this.lastAck = -Infinity;
    this.ev.loading?.(1, meta.why);
  }

  /** Apply every queued action due by game second `t` (they never fall behind: we never pass the host). */
  private applyDue(t = this.game?.t ?? -1) {
    const g = this.game;
    if (!g) return;
    while (this.queue.length && this.queue[0].t <= t) {
      const st = this.queue.shift()!;
      if (st.t < t) console.warn(`co-op: action ${st.seq} applied late (${st.t} < ${t})`);
      const mine = st.by === this.me?.id && st.req !== undefined ? this.pending.get(st.req) : undefined;
      const res = runAction(g, st.a, mine?.local);
      this.settle(st, res);
      this.ev.applied?.(st, res);
    }
  }

  private settle(st: Stamped, res: unknown) {
    if (st.by !== this.me?.id || st.req === undefined) return;
    const p = this.pending.get(st.req);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(st.req);
    p.resolve(res);
  }

  /** Presence goes straight to everyone (not through the host). */
  presence(msg: Extract<Msg, { k: 'cursor' | 'ping' }>) {
    this.net.send(msg);
  }
}
