// Company level and the Network Control unlock.
//
// Network Control opens once the company has run a real service on REQUIRED_DAYS separate
// calendar days AND reached company level REQUIRED_LEVEL. A day only counts when buses
// actually carried passengers that day, so fast-forwarding an empty network does not count.
// Days are counted once, by day number, at day close: a reload cannot count a day twice.

import type { Game } from './engine.ts';
import type { GameState } from './types.ts';
import { DAY } from './content.ts';
import { notify, window as statsWindow } from './progress.ts';
import type { CustomMetric, SavedReport } from './analytics/query.ts';

export const REQUIRED_DAYS = 30;
export const REQUIRED_LEVEL = 3;
/** a qualifying operating day: at least this many boardings and completed trips */
export const QUALIFY_BOARDINGS = 25;
export const QUALIFY_TRIPS = 1;

export interface ControlState {
  /** qualifying operating days: how many, the last one (day number) and the most recent ones */
  days: { count: number; last: number; recent: number[] };
  unlocked: boolean;
  /** game time of the unlock */
  unlockedAt?: number;
  /** the unlock card has been seen and closed */
  introSeen: boolean;
  /** guided tour: -1 not started or dismissed, 0.. current step, 99 finished */
  tour: number;
  /** the player's own metrics and saved reports */
  metrics: CustomMetric[];
  reports: SavedReport[];
  counter: number;
}

export function emptyControl(): ControlState {
  return { days: { count: 0, last: -1, recent: [] }, unlocked: false, introSeen: false, tour: -1, metrics: [], reports: [], counter: 0 };
}

/**
 * Seed qualifying days for a save made before this update from its recorded daily rows
 * (`stats.days`, last 120 days). Only days with recorded boardings count.
 */
export function backfillControl(state: GameState): ControlState {
  const c = emptyControl();
  for (const row of state.stats.days ?? []) {
    if (row.boardings >= QUALIFY_BOARDINGS && row.trips + row.abandoned > 0) {
      c.days.count++;
      c.days.last = Math.max(c.days.last, row.day);
      c.days.recent.push(row.day);
    }
  }
  c.days.recent = c.days.recent.slice(-40);
  return c;
}

// ───────────────────────────────────────────── company level

export const LEVELS = [
  { level: 1, title: 'New operator', from: 0 },
  { level: 2, title: 'Local operator', from: 25 },
  { level: 3, title: 'Trusted operator', from: 45 },
  { level: 4, title: 'City operator', from: 65 },
  { level: 5, title: 'Metropolitan operator', from: 82 },
] as const;

/** Company level from reputation (the tiers the top bar has always shown). */
export function companyLevel(reputation: number) {
  let i = 0;
  while (i + 1 < LEVELS.length && reputation >= LEVELS[i + 1].from) i++;
  const cur = LEVELS[i];
  const next = LEVELS[i + 1] ?? null;
  return { level: cur.level, title: cur.title, from: cur.from, next: next ? { level: next.level, title: next.title, from: next.from } : null };
}

// ───────────────────────────────────────────── qualifying days and unlock

export interface UnlockProgress {
  days: number;
  required: number;
  level: number;
  requiredLevel: number;
  reputation: number;
  /** reputation needed for the required level */
  reputationNeeded: number;
  unlocked: boolean;
  /** today so far: boardings and completed trips (whether today will count) */
  today: { boardings: number; trips: number; qualifies: boolean };
}

export function unlockProgress(game: Game): UnlockProgress {
  const s = game.state;
  const lv = companyLevel(s.company.reputation);
  const rec = s.analytics.today;
  let boardings = 0, trips = 0;
  for (const r of Object.values(rec.routes)) {
    for (const x of r.b) boardings += x;
    for (const x of r.d) trips += x;
  }
  return {
    days: Math.min(s.control.days.count, REQUIRED_DAYS),
    required: REQUIRED_DAYS,
    level: lv.level,
    requiredLevel: REQUIRED_LEVEL,
    reputation: s.company.reputation,
    reputationNeeded: LEVELS[REQUIRED_LEVEL - 1].from,
    unlocked: s.control.unlocked,
    today: { boardings, trips, qualifies: boardings >= QUALIFY_BOARDINGS && trips >= QUALIFY_TRIPS },
  };
}

/** Day close: count the day if the company operated, then check the unlock. */
export function closeControlDay(game: Game, day: number) {
  const s = game.state;
  const c = s.control;
  if (day > c.days.last) {
    // the last 24 recorded hours are exactly the day that just ended
    const w = statsWindow(s, 24);
    if (w.boardings >= QUALIFY_BOARDINGS && w.deps >= QUALIFY_TRIPS) {
      c.days.count++;
      c.days.last = day;
      c.days.recent.push(day);
      if (c.days.recent.length > 40) c.days.recent.shift();
    }
  }
  checkUnlock(game);
}

/** Unlock Network Control when both requirements hold at the same time. Idempotent. */
export function checkUnlock(game: Game): boolean {
  const s = game.state;
  const c = s.control;
  if (c.unlocked) return false;
  if (c.days.count < REQUIRED_DAYS) return false;
  if (companyLevel(s.company.reputation).level < REQUIRED_LEVEL) return false;
  c.unlocked = true;
  c.unlockedAt = s.clock.t;
  const recorded = s.analytics.days.length;
  notify(game, 'good', 'Network Control is available', `After ${c.days.count} operating days you can study passenger journeys, line and fleet performance, and build automations. ${recorded} days of history are already recorded.`);
  game.emit('unlock', 'network-control');
  return true;
}

/** Calendar day number at game time t. */
export const dayOf = (t: number) => Math.floor(t / DAY);
