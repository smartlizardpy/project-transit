# Development progress

How the prototype is becoming a playable game. The milestones come from the "prototype to playable game" brief.

Status key:
- ✅ **done and verified**: by an automated test, by the scripted play-through (`scripts/play.mjs`), or by inspecting screenshots of the real game (`scripts/capture.mjs`). The evidence is named.
- 🟡 **partial**: works, with a known gap.
- ⬜ **not started**.

A feature is not marked done just because its UI exists.

Last updated: 2026-10-30.

## Milestone A — A real bus service ✅

| Item | Status | Evidence |
|---|---|---|
| Road-following routes (one-way streets, bridges, tunnels, road classes) | ✅ | `core.test.ts` (one-way routing, continuous pattern paths); `engine.test.ts` (buses stay on roads) |
| Stop placement with snapping, validity checks and explanations | ✅ | ghost marker with reasons in the stop and line tools; `core.test.ts` (outside-licence rejection) |
| Vehicle assignment | ✅ | play-through (buy → assign spare buses); line inspector |
| Timetables (bands, layover, fleet requirement) | ✅ | `core.test.ts` (departures match headway, requirement grows as headway shrinks, missed departures with too few buses); `timetableLogic.test.ts` |
| Vehicles serving stops (full state machine, no teleporting) | ✅ | `engine.test.ts` (4 h service, 28 trips done); vehicles always move along road paths |
| Passenger boarding and alighting with capacity | ✅ | `core.test.ts` (load never exceeds capacity; passengers left behind or abandoning) |
| Simulation-derived fare revenue | ✅ | ledger fares per line per hour; `core.test.ts` finance |

**Acceptance (one functioning line you can watch operate) is met.** Play-through: depot, stops by clicking streets, Register line, buy and assign buses, run. 272 trips in two days, the audit is clean, and buses are visible on the streets with live ETAs.

## Milestone B — A real company ✅

| Item | Status | Evidence |
|---|---|---|
| Vehicle market (6 models, unlocks by reputation or objective) | ✅ | Fleet → Buy; `docs/economy.md` |
| Fleet management (assign, service, sell, cancel sale) | ✅ | bus inspector, Fleet panel; `core.test.ts` (sale credits the ledger) |
| Depots (capacity, expansion) | ✅ | depot tool and inspector |
| Operating costs (drivers, energy, maintenance, fixed, depots, stops, interest) | ✅ | `docs/economy.md`; finance panel by category |
| Financial ledger and reconciliation | ✅ | `core.test.ts`, `balance.test.ts`, `progression.test.ts` (reconciles every day for 40 days) |
| Profitability per line and per day | ✅ | Finance → Lines; the line inspector's money section counts operating money only |
| Save/load (manual, autosave, versioning, migration, recovery) | 🟡 | `core.test.ts` (round trip and determinism; a newer-version save is rejected); `regressions.test.ts` (redrawn areas on load); play-through (save → quit → continue gives identical state in the browser, IndexedDB). Desktop: the Rust save commands (atomic write, backup) pass `cargo test`. The full desktop save/reopen journey has not been run in the native window, because the screen was locked during this session. |
| Basic company management (name, colour, logo, fare, loans) | ✅ | Company and Finance panels |

**Acceptance (make money, lose money, buy assets, run for days) is met.** `balance.test.ts`: a good line is profitable every day, and a thin line loses money. Bankruptcy ends the game with a summary screen.

## Milestone C — A real challenge 🟡

| Item | Status | Evidence |
|---|---|---|
| Passenger demand from real geography, by time of day | ✅ | residents/jobs/POIs from OSM buildings and land use, labelled "estimated" |
| Traffic conditions (simulated and labelled as such) | ✅ | `core.test.ts` (peak slower than night; journeys longer at 08:00); legend says "a model, not live data" |
| Service quality (waiting, journey time, crowding, reliability, price) | ✅ | satisfaction popover shows the worst component and advice |
| Reputation | ✅ | daily drift towards satisfaction; penalties for missed departures |
| Territory expansion (adjacent areas, cost, reputation gate) | ✅ | `core.test.ts`; `progression.test.ts` (a scripted player licenses a second area and serves it) |
| Objectives with grants | ✅ | 12 objectives; grants are not counted as operating income |
| Meaningful decisions (fare, stop spacing, vehicle choice, timetable, loans) | ✅ | fare elasticity in the demand model; vehicle trade-offs in `docs/economy.md` |

**Acceptance (better routes and timetables improve performance and unlock expansion): mostly met.** The progression test grows steadily after the 2026-10-30 retune; before it, the scripted player stalled after its first expansion. A second expansion by an average player still needs a loan or a strong line. Human playtesting should confirm the pacing.

## Milestone D — The desktop experience 🟡

| Item | Status | Evidence |
|---|---|---|
| Start menu (Continue, New company, Load, Settings, Exit) | ✅ | screenshots `*-start-menu.png`; Exit appears in the desktop app only |
| New company: place search, presets, home area, name, colour, logo | ✅ | screenshots `*-choose-place.png`, `*-company-setup.png` |
| Optional onboarding | ✅ | 5 steps completed from real state; can be dismissed |
| LED arrival boards, per-bus next stops | ✅ | `core.test.ts` (ETAs sorted and roughly right); screenshots `*-stop-board.png`, `*-bus-selected.png` |
| Zoom-dependent vehicle markers | ✅ | 3D buses up close, line-coloured markers far away; screenshot `*-operating-areas.png` |
| Detailed inspectors (bus, line, stop, depot, area) | ✅ | screenshots |
| Line editor (loops, custom return, forced streets, undo/redo, warnings) | ✅ | play-through; `regressions.test.ts` (editing a line) |
| Settings (autosave interval, edge pan, FPS) | ✅ | game menu → Settings |
| Error and empty states | ✅ | `scripts/dev/edge-cases.mjs`: offline download error shown in the place picker; buying without a depot (banner + Place a depot); stops on service roads/water and outside the licence explained; insufficient funds states the cost and balance; disconnected roads reported by the line editor |
| Keyboard shortcuts, fullscreen (F11), hide HUD (F10, ⇧U) | ✅ | `src/ui/keyboard.ts` |
| Bridge rendering | ✅ | Golden Horn bridges inspected up close (metro, Galata, Atatürk); no deck walls |
| Desktop app build | 🟡 | release build compiles; the native window was not inspected this session (screen locked) |
| High-DPI and window sizes | ✅ | screenshots at 1366×768, 1920×1080 and 2560×1440 |

**Acceptance (understandable without developer help) needs a human playtest.** The scripted play-through only uses visible controls, apart from the ones noted in the script.

## Milestone E — Quality and balancing 🟡

| Item | Status | Evidence |
|---|---|---|
| End-to-end gameplay testing | ✅ | `scripts/play.mjs` (real clicks: new company → depot → buy → line → assign → run → save → quit → continue) |
| Economy balancing | 🟡 | `docs/economy.md`; `balance.test.ts`; `progression.test.ts`. Retuned 2026-10-30. Pacing needs human playtesting. |
| Performance profiling | ✅ | `perf.test.ts`: 70 buses on 10 lines take about 12 ms of CPU per real second at the fastest speed (budget 120 ms); `serialize` about 1 ms |
| Save/load stability | ✅ | determinism after load; migration rejects newer versions; areas reconciled on load |
| Visual regression review | ✅ | `pnpm shots` captures 16 screens at 3 sizes; reviewed 2026-10-30 |
| Fixes for interaction and simulation defects | ✅ | see the log below |

## Worldwide play

| Location | Status | Notes |
|---|---|---|
| İstanbul (Beyoğlu & Fatih) | ✅ | bundled tiles, works offline; dense one-way streets, bridges |
| Durham, UK (small town) | ✅ | downloaded from OpenFreeMap; left-hand traffic, £, rural roads; line built and running (`scripts/dev/scene.mjs … 1`) |
| Barcelona (Eixample grid, €) | ✅ | downloaded; line built and running; one-way grid warnings are correct |
| Tokyo (Shibuya, ¥, left-hand traffic) | ✅ | downloaded; line built and running |
| Hamburg preset | 🟡 | same pipeline; not run this session |
| Any place via search (Nominatim, on Enter only) | 🟡 | search UI works in the browser; allowed in the desktop CSP |

Fallbacks:
- Building heights are inferred when OSM has none.
- Areas are generated where OSM has no place names.
- A missing tile is reported to the player.
- If no tiles download at all, the app suggests İstanbul (offline).
- Traffic is always the simulated model and is labelled as such.

## Known gaps and next steps

1. **Native desktop check:** run `Project Transit.app`, then save, quit, reopen and Continue in the real window (it needs an unlocked screen).
2. **Human playtest of pacing:** how quickly a new player reaches a second and third area.
3. **Trip history:** finished trips are pruned at the end of each service day. Per-bus history is kept in daily stats only.
4. **More presets:** play-test Barcelona's grid and Tokyo's narrow streets.

## Log

- **2026-10-29.**
  - Built the game core: road graph, regions, traffic, timetables, vehicles, passengers and ledger. Commit `999a1c3`.
  - Built the playable loop: start menu, company setup, saves, line editor, timetables, arrival boards and finance UI. Commit `0b2ad7c`.
- **2026-10-30.**
  - QA play-through fixes. Commit `617e751`:
    - buses turn at termini;
    - editing a line works;
    - grants are no longer counted as operating income;
    - areas are no longer centred on open water;
    - core test suite;
    - real-game screenshot script.
  - Further fixes:
    - buses repositioning at a terminus may turn round;
    - territory is reconciled on load.
  - Economy retune: demand +25%, driver wages 24/h, top speed 720×.
  - New tests: progression, performance, regressions.
  - Save hardening, from a review of the save code:
    - saves are serialised;
    - quitting no longer drops a game whose save failed;
    - loading another save first autosaves the current game;
    - a failed load keeps the current game running;
    - migrate validates the save's structure;
    - one bad save entry no longer hides the list;
    - IndexedDB reopens after a transient failure;
    - the desktop window saves before closing.
  - The offline download error is now visible in the place picker.
  - The first-steps card no longer covers the map legend.
  - Barcelona and Tokyo verified.
