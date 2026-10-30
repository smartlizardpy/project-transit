// Save upgrades that only need the game state (shared by the app, tests and the MCP server).

import { SAVE_VERSION, type GameState } from './types.ts';
import { DAY } from './content.ts';
import { emptyAnalytics } from './analytics/types.ts';
import { backfillControl } from './control.ts';
import { emptyAutomation, DEFAULT_LIMITS } from './automation/types.ts';
import { calendarFrom } from './calendar.ts';
import { hashString } from './hash.ts';

/**
 * Bring a version 1 state (or a partially filled one) up to the current format. Idempotent:
 * fields that exist are left alone.
 *
 * Version 2 adds analytics, control and automation. Analytics for an upgraded save start on the
 * day it is first loaded (that day is marked partial); qualifying operating days are seeded from
 * the recorded daily rows.
 *
 * Version 3 adds `world`: the game calendar starts with the week the save is first loaded in
 * (week 1 of autumn), and the city seed comes from the save's id, so it is the same on every load.
 * Its place snapshot starts empty; the game fills it from the map when it loads.
 */
export function upgradeState(s: GameState): GameState {
  const day = Math.floor(s.clock.t / DAY);
  if (!s.analytics) s.analytics = emptyAnalytics(day, (s.version ?? 1) < 2 && s.clock.t % DAY !== 0);
  if (!s.control) s.control = backfillControl(s);
  if (!s.automation) s.automation = emptyAutomation();
  s.world ??= { seed: hashString(s.meta?.id ?? 'save'), calendar: calendarFrom(s.clock.startWeekday, day), places: { digest: '', significant: [] } };
  s.world.places ??= { digest: '', significant: [] };
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
