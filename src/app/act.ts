// The UI changes the game only through here. Single-player applies each action at once; in a
// co-op session the action goes to the host, which decides the game second at which every
// computer applies it (src/net/coop.ts). Results come back as a promise either way.

import { session } from './session.ts';
import { applyAction, type Action, type GameMethod, type LocalHooks, type MethodArgs, type MethodResult } from '../game/actions.ts';

/** How actions leave this computer while a co-op session runs. */
export interface ActionRouter {
  submit(a: Action, local?: LocalHooks): Promise<unknown>;
  setSpeed(i: number): void;
}

let router: ActionRouter | null = null;
export function setActionRouter(r: ActionRouter | null) {
  router = r;
}

const noGame = { ok: false as const, error: 'No game is running.' };

/** Send any action (including the compound ones such as applying a plan). */
export function send(a: Action, local?: LocalHooks): Promise<unknown> {
  const g = session.game;
  if (!g) return Promise.resolve(noGame);
  if (router) return router.submit(a, local);
  return Promise.resolve(applyAction(g, a, local));
}

/** Call a game method as an action: `act('buyVehicle', model, depot)`. */
export function act<K extends GameMethod>(m: K, ...args: MethodArgs<K>): Promise<MethodResult<K>> {
  return send({ m, args } as unknown as Action) as Promise<MethodResult<K>>;
}

/** Change the game speed (in co-op the host's clock is the one that counts). */
export function setSpeed(i: number) {
  const g = session.game;
  if (!g) return;
  if (router) router.setSpeed(i);
  else g.setSpeed(i);
}

/** A short random key for undoable results (unique enough within a session). */
export const actionKey = () => Math.random().toString(36).slice(2, 10);
