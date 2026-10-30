// Simulation events for automation triggers. Cheap to call from the simulation: nothing is
// recorded unless an enabled workflow listens for that kind of event. Events are queued in the
// save and handled at the next game minute, so a reload neither loses nor repeats them.

import type { Game } from '../engine.ts';

export const QUEUE_MAX = 300;

/**
 * Departure events are frequent (every stop of every trip), so only the ones some trigger could
 * match are queued: late by at least the smallest "late" threshold, or at least as full as the
 * lowest "crowded" threshold.
 */
const departGate = new WeakMap<Game, { delay: number; occ: number }>();

export function setDepartGate(game: Game, delayMin: number, occ: number) {
  departGate.set(game, { delay: delayMin, occ });
}

export function departWanted(game: Game, delayMin: number, occ: number): boolean {
  const g = departGate.get(game);
  return !g || delayMin >= g.delay || occ >= g.occ;
}

export function simEvent(game: Game, kind: string, data: Record<string, string | number | boolean | null>) {
  if (!game.autoWants.has(kind)) return;
  const q = game.state.automation.queue;
  q.push({ t: game.state.clock.t, kind, data });
  if (q.length > QUEUE_MAX) q.splice(0, q.length - QUEUE_MAX);
}
