# Network Control, Automation Studio and Route Diagnostics: implementation plan

This plan follows an audit of the game as it stood on 2026-10-30 (branch `gameplay/playable-core`, 42 passing tests). Progress is tracked in [`network-control-progress.md`](network-control-progress.md).

## 1. What the game already has (audit)

| System | Where | Real or placeholder | What we reuse |
|---|---|---|---|
| Fixed 1 s simulation step; minute, hour and day systems | `src/game/engine.ts` (`tick`, `minute`, `hour`, `day`) | Real | Analytics and automation hook into `minute`/`hour`/`day`. Nothing runs per frame. |
| Speed control and pause | `Game.advance`, `SPEEDS` | Real | Automation runs on game minutes, so it pauses and speeds up with the game. |
| Passenger groups with real origins, destinations and legs | `src/game/passengers.ts` | Real (demand is an estimate from OSM land use; journeys are simulated) | Boardings, alightings, waits, transfers, abandonment and completed journeys are recorded where they happen (`serveStop`, `abandonAndReplan`, `recordTrip`). |
| Vehicle state machine, timetabled dispatch, deadheads, maintenance, breakdowns | `src/game/vehicles.ts` | Real | Status time, km, loads by segment, delays and segment run times are recorded from it. "Dispatch" actions reuse its `assign` path. |
| Timetables and run profiles (ghost runs under typical traffic) | `src/game/timetable.ts` | Real | Scheduled vs actual segment times. |
| Simulated traffic by time of day | `src/game/world/traffic.ts` | Simulated and labelled as such | Congestion reads for automation and the delay analysis. |
| Ledger with daily and per-line aggregates (120 days) | `src/game/finance.ts` | Real | Revenue and cost in every analytic come from the ledger aggregates, so they reconcile with Finances. |
| Hourly stats (last 50 h) and daily rows (120 days) | `src/game/progress.ts` | Real | Back-fills qualifying operating days for existing saves. |
| Reputation, objectives, territory | `src/game/progress.ts` | Real | Company level is derived from the reputation tiers already shown in the top bar. |
| Validated commands (`Result` with a readable error) | `Game` methods | Real | The command layer wraps these; player and automation use the same checks. |
| Route patterns, one-way routing, waypoints, custom return, detour warnings | `src/game/network.ts`, `world/graph.ts` | Real | Diagnostics turn the warning into structured data and use the same router for alternatives. |
| Line editor with undo/redo and live preview | `src/ui/RouteTray.tsx`, `src/ui/routeDraft.ts` | Real | Diagnostics fixes can feed the draft. |
| Saves: versioned JSON, migration hook, atomic desktop writes | `src/app/session.ts` (`migrate`), `src-tauri/src/saves.rs` | Real | Save version 2 adds three fields with safe defaults. |
| Event emitter on `Game` | `Game.on/emit` | Real, coarse (`minute`, `changed`, `notify`) | Extended with typed simulation events for automation triggers. |

Missing foundations that Network Control needs, built as part of this work rather than faked:
- **Per-day operational history.** The game kept 50 hours of detail and 120 daily totals. There was no per-stop, per-vehicle, per-segment or origin–destination history.
- **Company level.** The top bar shows reputation tiers ("Trusted operator"), but there was no level number. Two components used slightly different thresholds.
- **Extra departures.** All service was timetabled; there was no way to put an extra bus on a crowded line, which a "dispatch" action needs.
- **Typed simulation events** for vehicles arriving, departing, running late and missing trips.

## 2. Data model changes (save version 2)

`GameState` gains three fields. `migrate()` adds them to version 1 saves with safe defaults.

```ts
analytics: AnalyticsState   // recorded from day one, before the unlock
control: ControlState       // qualifying days, unlock state, tour
automation: AutomationState // workflows, memory, history, proposals, safety ledger
```

### Analytics storage (`src/game/analytics/`)

- **`today`**: the day being recorded. It is part of the save, so a reload mid-day loses nothing and counts nothing twice.
- **`days`**: finished days with full detail, kept for 35 days.
  - Per stop, by hour: boardings, alightings, passengers who gave up, a waiting-count sample. Per day: wait sum, count and maximum, transfers, passengers left behind by full buses.
  - Per line, by hour: boardings, departures, on-time departures, missed departures, passengers left behind. Per pattern segment: load and run time. Per day: passenger-km, capacity-km, delay, completed trips, satisfaction.
  - Per vehicle: minutes by status, km, boardings, passenger-km, line time split, maintenance spend.
  - Origin–destination: per stop pair and itinerary (lines and transfer stop), by time band (night, AM peak, midday, PM peak, evening): journeys completed, journeys abandoned, journey and wait minutes, transfers.
- **`summary`**: older days, compact totals per line and stop, kept for 120 days. Origin–destination detail is not kept beyond 35 days, and the UI says so.
- **`assignments`**: route assignment history for vehicles, with the source (player or workflow).
- **`since`**: the first day with full coverage. Saves from before this update start coverage on the day they were loaded; earlier days show as "not recorded".

Size target: under 50 KB per day for a 60-stop, 8-line, 30-bus company. A test measures this.

Money is never duplicated: revenue and costs come from `finance.daily` / `finance.routeDaily`. Vehicle costs are computed from recorded minutes and km at the same rates the ledger uses.

### Qualifying operating days and the unlock

- A calendar day qualifies when the company carried at least **25 boardings and completed at least one timetabled trip** that day. Speed controls do not matter; an idle fast-forward does not qualify.
- Days are counted at day close by day number (`control.days.last` must be lower), so reloading can never count a day twice.
- Existing saves are back-filled from the recorded daily rows (`stats.days`, boardings ≥ 25), which are genuine records.
- **Company level** is derived from reputation tiers already on screen: 1 New (<25), 2 Local (25–44), **3 Trusted (45–64)**, 4 City (65–81), 5 Metropolitan (82+). Level 3 is the requirement.
- Unlock check: at day close and every 10 game minutes. It needs 30 qualifying days and level ≥ 3 at the same time. Once unlocked it stays unlocked.

## 3. Query layer (shared by analytics and automation)

`src/game/analytics/query.ts`:

- `aggregate(game, { groupBy, range, hours, dayType, filter })` returns rows of base measures for `network | line | stop | vehicle | zone | day | hour`.
  - Base measures include boardings, journeys, abandoned, left behind, average and maximum wait, transfers, revenue, cost, profit, vehicle-hours, service-hours, vehicle-km, passenger-km, capacity-km, departures, on-time share, missed departures, average delay, average load and satisfaction.
  - Each measure carries `kind: measured | estimated` and a unit.
- `odMatrix(game, query)` gives flows by stop or by area, with filters by line, stop, area, date and time band.
- `coverage(game, range)` reports how many days in a range have full detail, summary only, or no record.
- **Custom metrics** are expressions over base measures (`revenue / serviceHours`) evaluated by the same safe expression engine automation uses. Saved reports store a query plus metrics.
- Results for finished days are memoised. Today's partial day is recomputed on demand, so nothing rescans history on every render.

## 4. Command layer

`src/game/commands.ts` defines a `Command` union:
- `assign_vehicle`, `dispatch_extra`, `set_headway`, `suspend_line`, `set_fare`, `service_vehicle`, `set_waypoints`.

It offers:
- `check(game, cmd)`: a dry run that changes nothing. It returns ok/reason, a plain-language summary, the operational transition (for example "finishes its trip with 23 passengers, returns to the depot, then joins line 3"), an estimated cost and an impact level.
- `execute(game, cmd, source)` re-checks, then calls the existing `Game` methods. Player UI and automation both go through these methods, so the rules are identical: no teleporting, no invented buses, capacity limits, routing restrictions and the funds checks.

New engine capability: **extra departures** (`Game.dispatchExtra`). This adds a real trip to today's timetable and gives it to a specific spare or idle bus. That bus then prepares, drives to the terminus and runs the trip like any other.

## 5. Automation engine

`src/game/automation/`. Plain TypeScript, no React, saved in `state.automation`.

- **Workflow** = nodes + edges + groups + mode (`observe | suggest | automatic`) + limits + enabled flag.
- **Node registry** (`registry.ts`): each node type declares typed input and output ports, config fields, a category and a `run` function. Adding a node type means adding one definition. The editor and executor read the registry.
- **Values** are numbers, booleans, text, records (entities such as a line with its fields) and lists. Ports have types (`number`, `boolean`, `text`, `record`, `line`, `stop`, `vehicle`, `list`, `any`); the validator checks compatibility.
- **Execution**: when a trigger fires, the executor evaluates the enabled nodes in a stable topological order; nodes hanging off other triggers, or on a branch not taken, receive *not active* and are skipped. (As built; the first draft of this plan evaluated only the trigger's downstream nodes, which left shared data nodes unevaluated.)
  - **Branches**: If/Switch send a value down one output; the other branch is inactive and its nodes are skipped.
  - **Iteration**: lists flow through Filter, Sort, Map and Aggregate (expression lists are capped at 500 items). Actions accept lists and act per item, at most 10 per action node and 10 per run.
  - **Sub-workflows**: a function node calls another workflow, at most 3 levels deep.
- **Triggers** (as built): every N game minutes (optionally between hours), at a time of day, end of the day, a bus arrives at a stop, a crowded bus leaves, a bus is running late, a departure is missed, a bus breaks down, passengers waiting above a threshold, balance below a threshold, manual. ("Area licensed" and "start of day" from the first draft were not built; "At a time of day" covers the start of the day.)
  - Events are queued in the save and processed at the next game minute, so they are never lost or doubled by a reload.
  - Schedules use game time, so pause and speed apply.
- **Expressions** (`expr.ts`): a small parser and evaluator with no `eval`.
  - It covers arithmetic, comparisons, logic, field access and a whitelist of functions, with a step budget.
  - There is no access to the file system, network, Tauri or the DOM.
  - The API is versioned and documented in `docs/automation-api.md` (node and function tables generated from the code).
- **Modes**:
  - **Observe** records what actions would have done.
  - **Suggest** puts validated proposals in an inbox for the player to approve; they are re-checked when approved.
  - **Automatic** executes them within limits.
  - High-impact actions (timetable, fare, suspension, route changes) need an explicit "allow high-impact" switch; otherwise they become suggestions.
- **Safety**:
  - Per-run limits on node runs, list sizes and expression steps.
  - Per-workflow limits on runs per game hour, actions per day and spend per day, plus a cooldown per action and target.
  - Duplicate prevention.
  - A conflict ledger: an opposite action of the same kind on the same target by a different workflow within 24 game hours is blocked, recorded in both histories and notified (once an hour per pair). (The first draft said 60 minutes; that let two workflows undo each other every hour.)
  - The player's own changes are recorded in the same ledger, so automations do not undo them for 24 game hours.
  - Automatic disable after 5 consecutive errors.
- **History**: run records with the trigger, node trace (inputs, outputs, why a condition was true or false), requested actions and their outcome, and the effect text. They are saved within caps.
- **Simulation Lab**: clones the saved state into a separate `Game`, runs the next hours with and without the workflow, and reports the measured difference. The real company is untouched.

## 6. Route diagnostics (not locked behind Network Control)

- `buildPatterns` keeps its warning strings and adds structured `diagnostics`: the leg, stops, road distance, straight-line distance, path range and **cause**. The cause is found by counterfactual routing on the real graph:
  - **one-way restrictions**: the route ignoring one-way rules is much shorter; it names the blocking one-way edges;
  - **no U-turn at an intermediate stop**: the route without the arrival-direction constraint is much shorter;
  - **halt on the far carriageway**: the opposite halt is much shorter;
  - **no nearby connection**: even ignoring one-way rules the road network has no short link. This may be a gap in OSM data; it names the nearest disconnected road ends;
  - **genuine geography** (river, rail, motorway).
- Clicking a warning opens a **route check** in the inspector:
  - The camera focuses on the leg.
  - The map shows the current road path in the line colour, a thin dashed straight-line reference, the blocking one-way streets with their permitted direction, labelled stops, and any alternative as a dashed preview.
- **Fixes**, previewed with before/after distance, run time at the current hour and catchment (residents and jobs), then committed only on confirmation, with undo and redo inside the session:
  - move a stop by dragging (snapped to valid road positions);
  - add or move waypoints;
  - switch to a separate return route;
  - pick a suggested nearby stop;
  - remove the stop.
- Suggestions are evaluated on the routing graph. If nothing is better, the card says so.

## 7. UI integration

- **Rail and keyboard**:
  - A Network Control entry on the tool rail (and `K`) with a lock badge until unlocked.
  - The locked card shows operating-day progress, the level requirement, what is already being recorded and a short explanation.
- **Network Control panel**: a wider version of the existing left panel, with tabs Overview · Passengers · Stops · Lines · Fleet · Reports · Automation. It uses `.section`, `.kpi`, `.pn-table`, `Segmented` and SVG charts in the existing palette. Selecting a stop or line selects and focuses it on the map. Origin–destination flows draw on the map as a few aggregated arcs (top 24), solid for observed journeys and dashed for estimated demand.
- **Automation Studio**: a large workspace card over the map with a breadcrumb back to Network Control.
  - Layout: workflow list, a node canvas (React Flow, styled entirely with our tokens: nodes look like our cards), and an inspector for settings and run traces.
  - Controls: mode switch, enable toggle, Test, Run, Simulation Lab and history. A "Show on map" peek collapses it to reveal affected lines.
- **Unlock moment**: a calm card in the game's style (no confetti or sound). It summarises the data already collected, previews what can be investigated, and offers a three-step tour.
- **Route check**: inspector view plus a map overlay module; warnings in the line inspector and line editor become buttons.

## 8. Testing strategy

- Unit tests:
  - expression parser and evaluator, including limits;
  - graph validation and port compatibility;
  - executor branches and lists;
  - safety limits, conflicts and duplicates;
  - command checks.
- Simulation tests on real İstanbul data:
  - **Scenario 1**: 30-day unlock with inactive days and speed changes, no double counting across save/load.
  - **Scenario 2**: analytics match the simulation's own counters (boardings, journeys, ledger revenue).
  - **Scenario 3**: an occupancy workflow dispatches a real extra bus.
  - **Scenario 4**: reassigning a loaded bus is deferred safely.
  - **Scenario 5**: contradictory workflows are rejected and reported.
  - **Scenario 7**: save/load continuity of every new field, plus migration of a version 1 save.
  - Analytics size per day.
- Route diagnostics: one-way detour cause, measurements, fixes and undo on İstanbul. On Barcelona El Born tiles, the test runs when they have been fetched (`scripts/dev/fetch-test-tiles.mjs`).
- Visual QA: screenshots of the screens listed in the brief through the Playwright scripts, reviewed against the existing screenshots.

## 9. Milestones and order of work

1. Foundations: save v2 and migration, analytics recording, qualifying days, company level, unlock, tests.
2. Query layer, expression engine, metrics, saved reports, tests.
3. Command layer, extra departures, automation engine, nodes, safety, history, Simulation Lab, tests.
4. UI: locked entry, unlock moment, Network Control analytics, map flows.
5. UI: Automation Studio.
6. Route diagnostics (in parallel with 2–5, separate files).
7. Integration, screenshots, documentation, performance check.

Parallel work is split by file ownership so no two people edit the same file at once:
- engine and game core;
- diagnostics (`network.ts`, `src/game/diagnostics.ts`, `src/map/diagnosticsLayer.ts`, `src/ui/RouteCheck.tsx`);
- analytics UI (`src/ui/network/`, `src/map/flowsLayer.ts`);
- Studio UI (`src/ui/automation/`).
