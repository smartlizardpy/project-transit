# Network Control and Intelligent Operations: progress

Tracks the "Network Control & Intelligent Operations" update against its brief. The plan is in `docs/network-control-implementation-plan.md`; the automation reference is in `docs/automation-api.md`; route diagnostics are described in `docs/route-diagnostics.md`.

Status key (as in `docs/development-progress.md`):
- ✅ **done and verified**: by an automated test or by inspecting screenshots of the real game. The evidence is named.
- 🟡 **partial**: works, with a known gap.
- ⬜ **not started**.

A feature is not marked done just because its UI exists.

Last updated: 2026-10-30.

## A. Foundations: save version 2, analytics recording, unlock ✅

| Item | Status | Evidence |
|---|---|---|
| Save version 2 with safe defaults; version 1 saves upgrade (operating days back-filled from daily stats; analytics marked partial from the next day) | ✅ | `network-control.test.ts` "save version 2 upgrade" |
| Analytics recorded from day one by hooks in the simulation (boardings, alightings, waits, fares, loads, run times, delays, bus time use, journeys by origin and destination) | ✅ | `network-control.test.ts` scenario 2: totals equal the simulation's own counters and the ledger to the cent |
| Retention: today plus 35 detailed days, then 120 daily summaries; assignment log of 500 | ✅ | `network-control.test.ts` retention replay; a detailed day of a small network is about 16 KB (measured: 590 KB for 35 days of a two-line network) |
| Qualifying operating days (25 boardings and a completed trip; one per day number; never double counted on reload; suspended days do not count) | ✅ | `network-control.test.ts` scenario 1 |
| Company levels from reputation (New, Local, Trusted, City, Metropolitan) shown in the top bar and Company panel | ✅ | `network-control.test.ts`; screenshots `overview.png`, `locked.png` |
| Unlock at 30 operating days and level 3, once, with a notification | ✅ | scenario 1 |
| Determinism: a game reloaded mid-day continues identically (this also fixed a pre-existing drift in demand refresh timing) | ✅ | `network-control.test.ts` "continues identically after a reload mid-day (scenario 7)"; `automation.test.ts` reload with workflows running |

## B. Query layer, custom metrics, reports ✅

| Item | Status | Evidence |
|---|---|---|
| One query layer (`analytics/query.ts`) used by the panels and by automation: group by network, line, stop, bus, day, weekday, hour or time band; filter by days, day type, hours and lines; coverage reported | ✅ | `network-control.test.ts` query tests (grouping consistency, ledger agreement, hour filters) |
| Origin–destination matrix by stop or area, with filters | ✅ | `network-control.test.ts` OD tests; `passengers-od.png` |
| Estimated demand from the gravity model, labelled separately from observed journeys | ✅ | `network-control.test.ts` "estimated demand" (also at night, and straight after loading) |
| Custom metrics from a sandboxed expression language | ✅ | `network-control.test.ts` custom metric; `automation.test.ts` sandbox tests; `reports-metric.png` |
| Saved reports (table, comparison, OD) | ✅ | Reports tab; `reports-metric.png` |

## C. Commands and the automation engine ✅

| Item | Status | Evidence |
|---|---|---|
| Shared command layer for the player and automations, with plain-language dry runs | ✅ | `commands.test.ts` |
| Extra departures as a real operation (a free or spare bus prepares, drives to the line, runs the trip, returns) | ✅ | `commands.test.ts`; `automation.test.ts` scenario 3 |
| Node registry: 57 node types: 11 triggers, 10 data (including Network Control figures), 11 logic, 5 maths, 6 memory, 10 actions, 4 advanced | ✅ | `docs/automation-api.md` (tables generated from the registry) |
| Validation: types, required inputs, loops, deleted entities, expressions, size limits | ✅ | `automation.test.ts` "workflow validation" |
| Executor on game time with an event queue in the save; deterministic; branches, lists, memory, functions | ✅ | `automation.test.ts` (events and reload continuity) |
| Modes Observe / Suggest / Automatic; big changes need approval unless allowed; suggestions re-checked on approval | ✅ | `automation.test.ts` "modes" |
| Safety: run, action, spending and work limits; cooldowns; duplicates; conflicts between workflows; the player's own changes protected for 24 game hours; switch-off after 5 failures | ✅ | `automation.test.ts` "safety rules", scenario 5 |
| History with node traces (inputs, outputs, why a condition was true or false) | ✅ | `automation.test.ts` scenario 3 checks the trace notes |
| Simulation Lab on copies of the company | ✅ | `automation.test.ts` "Simulation Lab" (the live game is unchanged; the copy with the workflow runs more trips) |
| Starter templates (6) | ✅ | `automation.test.ts` scenario 3 uses the crowding template unchanged |

## D. Network Control interface ✅

| Item | Status | Evidence |
|---|---|---|
| Rail entry with a lock badge and `K`; locked view with progress, level and what is already recorded | ✅ | `locked.png` |
| Unlock card (no confetti) with the data collected so far and a three-step tour | 🟡 | `unlock-card.png`; the tour works but has no screenshot |
| Overview, Passengers (with map flows), Stops, Lines (segments, comparisons), Fleet, Reports | ✅ | `overview.png`, `passengers-od.png`, `flows-map.png`, `flows-estimated.png`, `stops.png`, `lines.png`, `lines-table.png`, `lines-custom-column.png`, `line-compare.png`, `fleet.png`, `reports-metric.png` |
| Missing values shown as a dash with the reason; ledger and derived values marked | ✅ | screenshots above |

## E. Automation Studio interface 🟡

Checked in a real browser by `scripts/capture-automation.mjs` (24 interaction checks through the real interface and engine).

| Item | Status | Evidence |
|---|---|---|
| Automation tab: workflow list (on/off, mode, trigger, last run, today's runs and actions, why the game switched it off), pause all, new workflow or function, duplicate, delete, templates; suggestions inbox (approve, decline, expiry, big-change tag); recent activity | ✅ | `automation-tab.png` |
| Studio canvas (`@xyflow/react` with the game's own node cards): library with search and categories, click or drag to add, typed connection points, refused connections explained by the engine, pan, zoom, fit, box and shift selection, duplicate, delete, undo and redo, save, groups | ✅ | `automation-studio.png`, `automation-library-search.png`, `automation-validation.png` |
| Inspector: rename, settings for every field kind with live formula checking, switch a node off, connection points with types, last test's inputs and outputs; workflow name, mode, big changes, limits, memory | ✅ | `automation-library-search.png` |
| Test on a draft (nothing changes in the game): path on the canvas, why each condition was true or false, what it would do | ✅ | `automation-test-trace.png` |
| History in the game's list style, with traces for the latest 3 runs | ✅ | `automation-history.png` |
| Simulation Lab: 2/4/8/24 h, as if Automatic or its own mode, approve suggestions, big changes, progress and cancel, comparison table with notes | ✅ | `automation-lab.png` (a real result: 5 extra departures cost ₺552 and moved nothing else, which the table shows plainly) |
| Game shortcuts ignored while the Studio is open | ✅ | `keyboard.ts` |
| Not built: copy and paste (Ctrl/Cmd+D duplicates instead), edge labels, minimap; testing a function on its own (test a workflow that uses it); a cross-workflow Lab | ⬜ | |
| Not checked: 200-node graphs; windows narrower than about 1500 px | 🟡 | |

The screenshots use a copy of the crowding template with a 1% threshold, because the demo company's buses are only 2–3% full. The threshold is a demo setting, not a recommendation; everything after it (suggestion, runs, trace, Lab) came from the engine.

Data nodes have an optional **After** input so a template shows its trigger wired to what it reads; an exact duplicate connection is refused by the engine.

## F. Route diagnostics ✅

| Item | Status | Evidence |
|---|---|---|
| Clickable route warnings opening a route check (camera, highlighted leg, dashed straight-line reference, blocking one-way streets, cause) | ✅ | `diagnostics.test.ts`; `route-diagnostic-warning.png`, `route-diagnostic-selected.png` |
| Fixes: move stop, waypoints, return route, suggested alternative stop, remove stop; before/after card; apply, cancel, undo, redo; nothing committed before Apply | ✅ | `diagnostics.test.ts`; `route-diagnostic-before-after.png` |
| El Born one-way case reproduced: 422 m straight line, 1,458 m by road, cause one-way (Passeig de Picasso) | ✅ | `diagnostics.test.ts` (Barcelona tiles; skipped when the tiles are absent) |
| Root causes found and fixed in routing: halt choice ignored the next leg; stop positions wrong with waypoints | ✅ | regression tests in `diagnostics.test.ts` |

## Moving buses between depots (requested during the update) ✅

| Item | Status | Evidence |
|---|---|---|
| A bus can be based at another depot: a parked bus drives there on the road (visible on the map); a working bus goes there when it next returns; full depots, buses in the workshop or getting ready are refused with a reason | ✅ | `commands.test.ts` "depot moves" |
| Bus inspector: depot picker with spaces used, the plan in words, Move / Cancel | ✅ | `depot-move-plan.png` |
| The bus drives to its new depot on the road, drawn as a hollow ring like other depot runs | ✅ | `depot-move-driving.png` |
| Available to automations (`Move bus to depot` node) | ✅ | registry; command checks shared |

## Mandatory scenarios

| # | Scenario | Status | Evidence |
|---|---|---|---|
| 1 | Unlock progression | ✅ | `network-control.test.ts` |
| 2 | Analytics consistency | ✅ | `network-control.test.ts` |
| 3 | Every 15 min → line occupancy → compare → find a free bus → extra departure, which really runs | ✅ | `automation.test.ts` (an established company with small buses: occupancy measured above 80% in the morning peak; the template is unchanged) |
| 4 | Reassigning a loaded bus is deferred safely | ✅ | `commands.test.ts`, and through a workflow in `automation.test.ts` |
| 5 | Two contradictory workflows: one consistent result, the conflict reported, no flip-flopping | ✅ | `automation.test.ts` |
| 6 | El Born one-way diagnostic | ✅ | `diagnostics.test.ts` |
| 7 | Save/load continuity | ✅ | `network-control.test.ts`, `automation.test.ts` |
| 8 | Visual consistency | ✅ | screenshots in `docs/screenshots/network-control/` taken by the capture scripts from the real game and reviewed; same panels, tokens and type as the rest of the game, no new theme |

## Measured, estimated, unavailable

| Figure | Kind |
|---|---|
| Boardings, alightings, journeys, gave up, left behind, transfers, waits, trips, on time, missed, loads, passenger-km, run times, delays, bus time use, km, fares | **Measured** in the simulation |
| Costs per line and per category | **Ledger** (what the company was charged) |
| Running cost per bus, revenue per bus-hour and other ratios | **Derived** from measured figures and the ledger, marked in the interface |
| Demand between places the network does not serve yet | **Estimated** by the game's gravity model, always labelled "Estimate" and drawn dashed |
| Simulation Lab differences | **Measured in copies** of the company: one possible future, not a forecast |
| Figures for hours within a day before version 2 (old saves), or older than the retention window | **Unavailable**, shown as a dash with the reason |

## Performance

Measured on a two-line network with 10 buses (vitest, Node 26, while other work ran on the machine):
- one game day takes about 2.0 s to simulate without workflows and about 2.2 s with all six templates enabled (167 runs that day);
- after 40 game days the save is 869 KB, of which analytics 590 KB and automation 68 KB.

Departure events are only queued when a trigger could match them.

Tests: the full suite (102 tests in 16 files) takes about 90 s with Vitest capped at 4 workers (`vitest.config.ts`). With the default (one per thread) the long simulations slowed each other 4–5× and timed out.

## Limitations and planned

- See the per-area notes in `docs/route-diagnostics.md` (fix search changes one stop at a time; undo lasts while the check is open).
- Flows are drawn as arcs between stops or the middle of an area's stops, not along roads.
- Passenger choice is still the original bus-versus-walk-or-car model. A richer model (several modes, population groups, habit) is researched in `docs/passenger-choice-research.md` and planned in `docs/city-activity-engine-plan.md`, not built.
- The Stops and per-line hourly charts ignore the time-of-day filter and say so.
