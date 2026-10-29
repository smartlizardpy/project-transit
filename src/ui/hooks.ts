import { useEffect, useReducer, useState } from 'react';
import { session } from '../app/session.ts';
import type { Game } from '../game/engine.ts';

/** Re-render on a fixed real-time cadence while mounted (for live readouts). */
export function useTicker(hz = 4) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(force, 1000 / hz);
    return () => clearInterval(id);
  }, [hz]);
}

/** The running game (null on the start menu). */
export function useGame(): Game | null {
  const [game, setGame] = useState<Game | null>(session.game);
  useEffect(() => session.onGame(setGame), []);
  return game;
}

/**
 * Re-render when the game clock moves (throttled to `hz` real-time updates per second) and
 * whenever the network, fleet or company changes.
 */
export function useGameUpdates(hz = 4) {
  const game = useGame();
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!game) return;
    let last = 0;
    let pending = 0;
    const tick = () => {
      const now = performance.now();
      if (now - last >= 1000 / hz) {
        last = now;
        force();
      } else if (!pending) {
        pending = window.setTimeout(() => {
          pending = 0;
          last = performance.now();
          force();
        }, 1000 / hz);
      }
    };
    const offs = [game.on('minute', tick), game.on('changed', force), game.on('speed', force), game.on('notify', force)];
    return () => {
      offs.forEach((f) => f());
      clearTimeout(pending);
    };
  }, [game, hz]);
  return game;
}

/** Re-render only on structural changes (network, fleet, company). */
export function useGameRev() {
  const game = useGame();
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => (game ? game.on('changed', force) : undefined), [game]);
  return game;
}
