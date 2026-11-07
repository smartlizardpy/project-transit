// A cheap fingerprint of the simulation, compared between co-op computers every ten game
// minutes. The random-number state alone catches most drift (nearly every system draws from it);
// money, buses and passengers catch the rest. A mismatch makes the host resend the game.

import type { Game } from '../game/engine.ts';
import { hashString, mix } from '../game/hash.ts';

/** Seconds between checks. */
export const SUM_EVERY = 600;

export function checksum(game: Game): number {
  const s = game.state;
  let h = mix(s.clock.t, s.rng, Object.keys(s.vehicles).length, Object.keys(s.routes).length, Object.keys(s.stops).length);
  h = mix(h, hashString(JSON.stringify([s.finance.balance, s.finance.loan, s.company.reputation, s.company.fare, s.counters])));
  h = mix(h, hashString(JSON.stringify(s.vehicles)));
  let waiting = 0, onboard = 0;
  for (const groups of Object.values(s.pax.waiting)) for (const g of groups) waiting += g.n;
  for (const groups of Object.values(s.pax.onboard)) for (const g of groups) onboard += g.n;
  return mix(h, waiting, onboard);
}
