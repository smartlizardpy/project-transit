// Messages between the computers in a co-op session. The host owns the clock and the order of
// actions; everyone else follows. See docs/multiplayer-plan.md.

import type { Action } from '../game/actions.ts';
import type { LngLat } from '../game/world/graph.ts';

/** Bumped when messages change shape: different versions refuse to play together. */
export const PROTO = 1;

export interface Player {
  /** transport peer id */
  id: string;
  name: string;
  colour: string;
  host: boolean;
}

/** An action with the game second at which every computer applies it (after that second's tick). */
export interface Stamped {
  seq: number;
  t: number;
  /** player id of whoever asked for it */
  by: string;
  /** the sender's request number, so it can match the result to its promise */
  req?: number;
  a: Action;
}

export type Msg =
  // guest → host
  | { k: 'hello'; name: string; proto: number; build: string }
  | { k: 'act'; req: number; a: Action }
  | { k: 'speed'; i: number }
  /** the guest has run the game up to `t` (the host never runs far ahead of the slowest guest) */
  | { k: 'ack'; t: number }
  /** state checksum at game second `t` */
  | { k: 'sum'; t: number; h: number }
  // host → guests
  | { k: 'welcome'; you: Player; players: Player[] }
  | { k: 'refuse'; reason: string }
  | { k: 'players'; players: Player[] }
  /** guests may run the game up to `upTo`, applying `acts` at their seconds */
  | { k: 'frame'; upTo: number; speed: number; acts: Stamped[] }
  | { k: 'bye'; reason: string }
  // anyone → everyone
  | { k: 'cursor'; at: LngLat | null }
  | { k: 'ping'; at: LngLat };

/** What a game snapshot carries (sent as a packed binary blob, see codec.ts). */
export interface SnapshotMeta {
  why: 'join' | 'resync' | 'grow';
  /** game second of the snapshot */
  t: number;
  /** last action sequence number included in it */
  seq: number;
  speed: number;
  /** the region's road graph etc. is included (on join and when the map grew) */
  region: boolean;
}

export const PLAYER_COLOURS = ['#f2a93b', '#4fb3e8', '#e8607a', '#7ccf6a'];
