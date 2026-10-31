// Determinism harness: the same inputs must give the same city, and a reloaded game must carry
// on exactly as if it had never been saved. Later City Activity Engine phases (weather, events,
// journeys) extend these checks instead of writing their own.
import { expect } from 'vitest';
import { Game } from '../engine.ts';
import type { GameState } from '../types.ts';
import { region } from './helpers.ts';

/** The saved state without bookkeeping that legitimately differs between sessions. */
export function simState(g: Game): Omit<GameState, 'meta'> {
  const { meta: _meta, ...rest } = JSON.parse(g.serialize()) as GameState;
  return rest;
}

export const reload = (g: Game) => new Game(JSON.parse(g.serialize()), region());

/** Two games built the same way and run for the same time end in identical states. */
export function expectIdenticalRuns(make: () => Game, seconds: number) {
  const a = make(), b = make();
  a.run(seconds);
  b.run(seconds);
  expect(simState(b)).toEqual(simState(a));
  return a;
}

/** Saving and loading `game` now, then running both for `seconds`, gives identical states. */
export function expectReloadContinuity(game: Game, seconds: number) {
  const copy = reload(game);
  expect(simState(copy)).toEqual(simState(game));
  game.run(seconds);
  copy.run(seconds);
  expect(simState(copy)).toEqual(simState(game));
  return copy;
}
