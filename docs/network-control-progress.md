# Network Control and Intelligent Operations: progress

Tracks the "Network Control & Intelligent Operations" update against its brief. The plan is in `docs/network-control-implementation-plan.md`; the automation reference is in `docs/automation-api.md`; route diagnostics are described in `docs/route-diagnostics.md`.

Status key (as in `docs/development-progress.md`):
- ✅ **done and verified**: by an automated test or by inspecting screenshots of the real game. The evidence is named.
- 🟡 **partial**: works, with a known gap.
- ⬜ **not started**.

A feature is not marked done just because its UI exists.

Last updated: 2026-10-31 (peak hours and sharing buses).

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

## G. Smarter triggers and starter workflows (requested 2026-10-31) 🟡

The owner found the triggers too basic and asked for more ready-made flows. Research (Home Assistant, Node-RED, n8n, Prometheus and Grafana alert rules, Oxygen Not Included, Factorio, OpenTTD, TfL's excess wait time, transit holding research) led to a recommended first batch, built here. 🟡 until the owner has played it.

| Item | Status | Evidence |
|---|---|---|
| **For at least N minutes** on condition triggers (watch a figure, people waiting, people giving up, a line short of buses, balance): a short spike does not fire; it fires once and then waits for the condition to clear (a tenth of the value back, or as chosen) before it can fire again for the same line, stop or bus | ✅ | `automation-triggers.test.ts` "waits for the condition to hold, ignores a shorter spike, and fires once until it clears" (5-minute dip: nothing; 10 minutes: one run; back by less than a tenth: still waits; clearly back: re-arms) |
| **Hours and days** (From, Until, every day / weekdays / weekends) on every condition and event trigger and on *Every few minutes*; outside them nothing builds up | ✅ | tests "only builds up and fires within its hours", "skips weekdays for a weekend-only trigger" |
| **At most once every N minutes** for each stop, line or bus on event triggers | ✅ | test "runs an event trigger at most once every N minutes for each stop" (arrivals every 8 min, at most 2 an hour per stop, 30 min apart) |
| Half-built conditions start again when a workflow is switched off, automation is paused, or its trigger settings change (not when a node is moved); saved, so a reload fires at the same minute; old workflows without the new settings behave as before | ✅ | tests "starts again when the workflow is switched off, and a reload carries on the same", "keeps an old workflow … working as before" |
| **Watch a figure**: 18 figures (line load and punctuality over 3 hours, how full now, delay, waiting, missed today, buses short, road traffic; stop waiting, longest wait, gave up in the last hour; bus condition, delay, fullness; reputation, satisfaction today, balance, today's result), checked every minute for each line, stop or bus, or one line's; hands on the line, stop or bus record | ✅ | tests "watches each bus and hands the bus on…", "reads line, stop and company figures…" |
| New triggers: **A line is short of buses** (fewer working buses than the timetable needs right now; buses in the workshop or broken down do not count), **People left behind**, **People give up waiting** (in the last 60 minutes at one stop), **End of the week** (journeys, change on the week before, satisfaction, fares, busiest line) | ✅ | tests in "new triggers" (4) |
| **Live state on every trigger card**: the current reading (for many lines or stops, the one closest to firing), *Watching*, *Building up: 11 of 30 min*, *Fired, waits to clear*, the next run for schedules, last fired and runs today, from the running game | ✅ | `automation-trigger-live.png`, `automation-rebalance-flow.png` ("Next 09:00") |
| Inspector: timing settings under **When it may fire**; the figure list grouped by lines, stops, buses and the company | ✅ | `automation-trigger-live.png` |
| New figures on records for Filter and Expression blocks: line `neededNow`, `working`, `short`; stop `gaveUpHour`, `leftBehindToday`; company `satisfactionToday`, `spareBuses` | ✅ | `docs/automation-api.md` |
| **13 new starter workflows** (28 in all), in a gallery grouped by topic: crowding and waiting, reliability, fleet and maintenance, money and reputation, events/weather/calendar, reports and briefings | ✅ | test "every template has a group, validates and test-runs without failing"; `automation-template-groups.png`; list in `docs/automation-api.md` |
| *Move a bus from a quiet line to a busy one* takes a free bus only from a line with more working buses than its timetable needs | ✅ | test (measured: one move, at 17:00 on the first day of the crowded test line) |
| *Find out why reputation is falling* names the line missing the most departures, or says none is | ✅ | `automation-reputation-flow.png` |
| *Service worn buses between the peaks* sends buses below 78% between 09:00 and 16:00, ahead of the game's own automatic service at 70% (which can strike in the rush hour) | ✅ | test (a bus at 76% at 08:00 is sent at 09:00) |
| Performance: eight of the new workflows on a three-line company add nothing measurable (about 360 ms per 3 game hours with or without) | ✅ | measured with a throwaway benchmark |

The live-state screenshot uses a custom workflow, *Reputation slipping*, whose threshold (60) is the next round ten above the demo company's real reputation (58.1), so the trigger is building up in the shot. Everything else in it is the engine's real state.

**Not built yet (second batch, recommended):** bus bunching and gaps between buses on frequent lines, with a *Hold this bus* action; *Check back later* (a workflow re-checks its own fix N minutes on); a preview of how often a trigger would have fired over the last week; a trigger for another workflow acting or being blocked by a limit; a *collect, then send one summary* block.

## H. Peak hours and sharing buses (requested 2026-10-31) 🟡

The owner could not build flows like "compare lines' peak hours" or "park a free bus at the depot and bring a spare in when a line's peak is coming": the blocks were missing. 🟡 until the owner has played it.

| Item | Status | Evidence |
|---|---|---|
| Peak hours from the timetable (stretches that need clearly more buses) and from riders (busiest hours on recent days of the same kind) | ✅ | `automation-peaks.test.ts` "finds a line’s timetable peaks…", "finds the busiest hours from riders…" |
| Trigger **Peak hours start or end**: once per line and peak, N minutes before the start or after the end, on chosen days; live "Next 06:00: line 1, peak 07:00–09:00" on the card | ✅ | tests in "Peak hours start or end" (2) |
| **Peak hours** block (each line's peaks, hour by hour, a sentence naming lines that could share buses), **Compare peaks**, **Buses to borrow** (spares first, then lines that can do without a bus until the peak ends) | ✅ | tests "compares two lines’ peaks", "brings in a parked spare, then buses another line can do without" |
| **Buses**: *spare and parked*, *not needed by their line for the next hour*; **Park bus at its depot** (renamed from "Take bus off line"); **Base bus at another depot** (renamed from "Move bus to depot") | ✅ | test "parks the buses a line no longer needs after its peak…" |
| **After the trips it already has**: moving or parking a bus waits for the trips it was given, takes no new ones, then moves (default for automations; "straight away" still available). Shown on the bus panel, cancelled by a manual move, saved | ✅ | test "runs its trips, takes no new ones, then moves…"; measured: parking 4 buses straight away after a peak cost 4 missed departures in the next two hours, after their trips none |
| Line records gain `neededSoon`, `neededMax`, `spareNow`, `peakHours`, `inPeak`, `nextPeak`, `nextPeakIn`, `busiestHours`, so Filter and Expression blocks can use them | ✅ | `docs/automation-api.md` |
| General blocks: **Pick the highest or lowest** (one block for Sort + First item), **For each item, use a function** (at most 20), expression `join()`; a bus or peak connected where a line is wanted stands for its line | ✅ | tests in "more building blocks" (2) |
| Four starter workflows in a new gallery group: bring in buses before a peak, park after it, warn before a peak a line cannot cover, today's peak hours | ✅ | every template validates and test-runs (existing test); the first two tested end to end |
| Screenshots of the new blocks in the real UI (`scripts/capture-peaks.mjs`, 4 checks) | ✅ | `automation-peaks-gallery.png`, `automation-peaks-bring-in.png` (live: "Next 06:00: line 1, peak 07:00–09:00"), `automation-peaks-report.png` (a test run: "Line 1: 07:00–09:00 and 16:00–18:00 (3 buses)") |

The demo company's timetables ran the same all day, so they had no timetable peaks. The capture script first gives its busiest line a weekday timetable of every 20 minutes, every 10 minutes 07:00–09:00 and 16:00–18:00, as a player would; everything after that is the engine's real state. Lines 2 and 3 have no peaks and the report leaves them out.

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
