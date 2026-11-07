// Every change a player makes goes through one door: a plain, JSON-serialisable action applied by
// `applyAction`. Single-player applies it at once. In co-op the host stamps each action with the
// game second at which every computer applies it, so all copies of the game stay identical
// (src/net/coop.ts). The simulation itself (ticks, automations) never needs actions: it runs the
// same on every computer.

import type { Game } from './engine.ts';
import type { Id } from './types.ts';
import { applyPlan, type Applied, type Plan } from './optimise.ts';
import { fromTemplate } from './automation/templates.ts';
import { applyFix, routeTarget, type AppliedFix, type FixPlan, type LineShape, type ShapeTarget } from './diagnostics.ts';

/** Game methods a player (or the UI on their behalf) may call. Everything else is read-only or internal. */
export const GAME_METHODS = [
  'placeStop', 'renameStop', 'moveStop', 'removeStop',
  'createRoute', 'updateRoute', 'setTimetable', 'setServicePlans', 'switchServicePlan', 'deleteRoute',
  'buildDepot', 'expandDepot', 'moveToDepot',
  'scheduleExtra', 'dispatchExtra', 'endDetour', 'cancelControl', 'cancelExtra',
  'buyVehicle', 'assignVehicle', 'handoverVehicle', 'sellVehicle', 'cancelSale', 'serviceVehicle',
  'setFare', 'setCompany', 'setSettings', 'setOnboarding',
  'createWorkflow', 'updateWorkflow', 'deleteWorkflow', 'duplicateWorkflow', 'reorderWorkflow', 'clearWorkflowMemory', 'runWorkflowNow',
  'approveProposal', 'declineProposal', 'setAutomationPaused',
  'setNetworkIntro', 'saveMetric', 'deleteMetric', 'saveReport', 'deleteReport',
  'takeLoan', 'repayLoan', 'buyLicence', 'declareBankruptcy',
] as const satisfies readonly (keyof Game)[];

export type GameMethod = (typeof GAME_METHODS)[number];
type Fn<K extends GameMethod> = Game[K] extends (...a: infer A) => infer R ? (...a: A) => R : never;
export type MethodArgs<K extends GameMethod> = Parameters<Fn<K>>;
export type MethodResult<K extends GameMethod> = ReturnType<Fn<K>>;

/** Where a route-check fix applies: a committed line, or the line being drafted (the issuer's own UI). */
export type FixTarget = { route: Id } | { draft: true };

export type Action =
  | { [K in GameMethod]: { m: K; args: MethodArgs<K> } }[GameMethod]
  /** Improve service: apply the chosen steps. `key` names the result so it can be undone later. */
  | { m: 'applyPlan'; args: [plan: Plan, ids: string[], key: string] }
  /** Route check: commit a fix. */
  | { m: 'applyFix'; args: [base: LineShape, plan: FixPlan, target: FixTarget, key: string] }
  /** Automation Studio: a new workflow from a template. */
  | { m: 'fromTemplate'; args: [id: string] }
  | { m: 'undoApplied'; args: [key: string] }
  | { m: 'redoApplied'; args: [key: string] };

export type ActionName = Action['m'];
export type ActionArgs<K extends ActionName> = Extract<Action, { m: K }>['args'];

/** Things only the computer that sent an action has, such as its own line draft. */
export interface LocalHooks {
  draft?: ShapeTarget;
}

const METHOD_SET = new Set<string>(GAME_METHODS);
export const isGameMethod = (m: string): m is GameMethod => METHOD_SET.has(m);

/** Results that can be undone, by key. Each computer keeps its own (they hold closures), built the same way. */
const applied = new WeakMap<Game, Map<string, Applied | AppliedFix>>();
const registry = (g: Game) => {
  let m = applied.get(g);
  if (!m) applied.set(g, (m = new Map()));
  return m;
};

/** A draft target on computers other than the sender: the game-side changes happen, the draft is not theirs. */
const noDraft: ShapeTarget = { apply: () => null, revert: () => null, reapply: () => null };

/**
 * Apply one action. Returns what the game method returns (a Result for most), so the computer
 * that sent it can react the same way as in single-player.
 */
export function applyAction(game: Game, a: Action, local?: LocalHooks): unknown {
  if (isGameMethod(a.m)) {
    const fn = game[a.m] as (...args: unknown[]) => unknown;
    return fn.apply(game, a.args as unknown[]);
  }
  switch (a.m) {
    case 'applyPlan': {
      const [plan, ids, key] = a.args as ActionArgs<'applyPlan'>;
      const r = applyPlan(game, plan, ids);
      registry(game).set(key, r);
      return { done: r.done, problems: r.problems };
    }
    case 'applyFix': {
      const [base, plan, target, key] = a.args as ActionArgs<'applyFix'>;
      const dest = 'route' in target ? routeTarget(game, target.route, base) : local?.draft ?? noDraft;
      const r = applyFix(game, base, plan, dest);
      if (typeof r === 'string') return r;
      registry(game).set(key, r);
      return { title: r.title, placed: r.placed };
    }
    case 'fromTemplate':
      return fromTemplate(game, (a.args as ActionArgs<'fromTemplate'>)[0]);
    case 'undoApplied': case 'redoApplied': {
      const [key] = a.args as ActionArgs<'undoApplied'>;
      const r = registry(game).get(key);
      if (!r) return a.m === 'undoApplied' ? ['That change can no longer be undone.'] : 'That change can no longer be redone.';
      if ('redo' in r) return a.m === 'undoApplied' ? r.undo() : r.redo();
      return a.m === 'undoApplied' ? r.undo() : ['Improve service changes cannot be redone.'];
    }
  }
  throw new Error(`Unknown action ${(a as { m: string }).m}`);
}
