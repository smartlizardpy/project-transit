// Save upgrades that only need the game state (shared by the app, tests and the MCP server).

import { SAVE_VERSION, type GameState } from './types.ts';
import { DAY } from './content.ts';
import { emptyAnalytics } from './analytics/types.ts';
import { backfillControl } from './control.ts';
import { emptyAutomation, DEFAULT_LIMITS } from './automation/types.ts';

/**
 * Bring a version 1 state (or a partially filled one) up to the current format. Idempotent:
 * fields that exist are left alone.
 *
 * Version 2 adds analytics, control and automation. Analytics for an upgraded save start on the
 * day it is first loaded (that day is marked partial); qualifying operating days are seeded from
 * the recorded daily rows.
 */
export function upgradeState(s: GameState): GameState {
  const day = Math.floor(s.clock.t / DAY);
  if (!s.analytics) s.analytics = emptyAnalytics(day, (s.version ?? 1) < 2 && s.clock.t % DAY !== 0);
  if (!s.control) s.control = backfillControl(s);
  if (!s.automation) s.automation = emptyAutomation();
  s.control.metrics ??= [];
  s.control.reports ??= [];
  s.control.counter ??= 0;
  const a = s.automation;
  for (const wf of Object.values(a.workflows)) {
    wf.limits = { ...DEFAULT_LIMITS, ...wf.limits };
    wf.groups ??= [];
    wf.errors ??= 0;
  }
  s.version = SAVE_VERSION;
  return s;
}
