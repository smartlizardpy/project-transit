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
| Save/load (manual, autosave, versioning, migration, recovery) | ✅ | `core.test.ts` (round trip and determinism; a newer-version save is rejected); `regressions.test.ts` (redrawn areas on load); browser play-through (save → quit → continue gives identical state, IndexedDB; also in WebKit). Desktop: `cargo test` for the Rust save commands, and `scripts/dev/native-saves.sh` runs the real app three times: save → close window (autosave) → reopen and load → quit the way ⌘Q does (autosave) → reopen and load. Each load matched the state at close or quit exactly (time, balance, passengers waiting and on board), the audit was clean, and the test saves were deleted afterwards. |
| Basic company management (name, colour, logo, fare, loans) | ✅ | Company and Finance panels |

**Acceptance (make money, lose money, buy assets, run for days) is met.** `balance.test.ts`: a good line is profitable every day, and a thin line loses money. Bankruptcy ends the game with a summary screen.

## Milestone C — A real challenge 🟡

| Item | Status | Evidence |
|---|---|---|
| Passenger demand from real geography, by time of day | ✅ | residents/jobs/POIs from OSM buildings and land use, labelled "estimated" |
| Traffic conditions (simulated and labelled as such) | ✅ | `core.test.ts` (peak slower than night; journeys longer at 08:00); legend says "a model, not live data" |
| Service quality (waiting, journey time, crowding, reliability, price) | ✅ | satisfaction popover shows the worst component and advice |
| Reputation | ✅ | daily drift towards satisfaction; penalties for missed departures |
| Territory expansion (adjacent areas, cost, reputation gate) | ✅ | map squares; starts with ~15 km² of land (`startingZones`); the map grows as you expand (`growth.test.ts`); `core.test.ts`; `progression.test.ts` (a scripted player licenses a new area and serves it). Only the operable area and the areas for sale are shown. |
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
| Settings (autosave interval, fullscreen) | ✅ | game menu → Settings |
| Error and empty states | ✅ | `scripts/dev/edge-cases.mjs`: offline download error shown in the place picker; buying without a depot (banner + Place a depot); stops on service roads/water and outside the licence explained; insufficient funds states the cost and balance; disconnected roads reported by the line editor |
| Keyboard shortcuts, fullscreen (F11), hide HUD (F10, ⇧U) | ✅ | `src/ui/keyboard.ts` |
| Bridge rendering | ✅ | Golden Horn bridges inspected up close (metro, Galata, Atatürk); no deck walls |
| Desktop app build | 🟡 | release build compiles and runs: the native save round trip passes in it (see Save/load). The window's visuals were not inspected this session (screen locked), so check the HUD in the native window once. |
| High-DPI and window sizes | ✅ | screenshots at 1366×768, 1920×1080 and 2560×1440 |

**Acceptance (understandable without developer help) needs a human playtest.** The scripted play-through only uses visible controls, apart from the ones noted in the script.

## Milestone E — Quality and balancing 🟡

| Item | Status | Evidence |
|---|---|---|
| End-to-end gameplay testing | ✅ | `scripts/play.mjs` (real clicks: new company → depot → buy → line → assign → run → save → quit → continue) |
| Economy balancing | 🟡 | `docs/economy.md`; `balance.test.ts`; `progression.test.ts`. Retuned 2026-10-30. Pacing needs human playtesting. |
| Performance profiling | ✅ | `perf.test.ts`: 70 buses on 10 lines take about 12 ms of CPU per real second at the fastest speed (budget 120 ms); `serialize` about 1 ms |
| Save/load stability | ✅ | determinism after load; migration rejects newer versions; areas reconciled on load |
| Visual regression review | ✅ | `pnpm shots` captures 17 screens at 3 sizes; reviewed 2026-10-30 (to regenerate for the territory view) |
| Fixes for interaction and simulation defects | ✅ | see the log below |

## Worldwide play

| Location | Status | Notes |
|---|---|---|
| İstanbul (Beyoğlu & Fatih) | ✅ | 30 bundled tiles (`scripts/bundle-tiles.mjs`), works offline; dense one-way streets, bridges |
| Durham, UK (small town) | ✅ | downloaded from OpenFreeMap; left-hand traffic, £, rural roads; line built and running (`scripts/dev/scene.mjs … 1`) |
| Barcelona (Eixample grid, €) | ✅ | downloaded; line built and running; one-way grid warnings are correct |
| Tokyo (Shibuya, ¥, left-hand traffic) | ✅ | downloaded (25 tiles, 1.6 s cold load in the browser); line built and running; starting area 15.2 km² |
| Hamburg (Altstadt & St. Pauli, €) | ✅ | downloaded; line built and running, audit clean |
| Any place via search (Nominatim, on Enter only) | 🟡 | search UI works in the browser; allowed in the desktop CSP |

Fallbacks:
- Building heights are inferred when OSM has none.
- Areas are generated where OSM has no place names.
- A missing tile is reported to the player.
- If no tiles download at all, the app suggests İstanbul (offline).
- Traffic is always the simulated model and is labelled as such.

## City Activity Engine

Tracked in detail in [`docs/city-activity-engine-progress.md`](city-activity-engine-progress.md), phases 0–7, with evidence, calibration and known gaps. Every phase is 🟡 until the owner has played it.

- Zones and places from the map (airports, stations, universities, schools, hospitals, malls, stadiums, markets, piers, sights), with opening rules, busy hours and a place card.
- Tours by purpose, with ten traveller types and a nested choice between walking, cycling, car, taxi, the city's metro, tram, rail and ferries, and your buses. People can ride your bus to a station and go on by the city's transit, and walk up to 300 m between stops to change lines.
- Weather from a climate model per city, with forecasts; events and disruptions; service plans for school holidays, weekends and events.
- Reputation works through trust minutes on each journey leg (see `docs/economy.md`).
- Open: the progression bot reaches about 7,400 weekday riders against the plan's 9,000 (owner decision); habit is not built; people do not change from the train to your bus.

## Network Control and Intelligent Operations

Tracked in detail in [`docs/network-control-progress.md`](network-control-progress.md), with evidence for each item.

- **Network Control** unlocks after 30 operating days at company level 3. Analytics are recorded from day one and reconcile with the simulation and the ledger. The panel covers overview, passengers (observed journeys and estimated demand, drawn on the map), stops, lines, fleet, custom metrics and saved reports.
- **Automation Studio**: workflows of typed nodes run on game time through the same commands as the player, in Observe, Suggest or Automatic mode, within safety limits, with history, traces and a Simulation Lab. Triggers can wait for a condition to last, keep to hours and days, and limit repeats; *Watch a figure* covers 18 figures; each trigger shows its live state. Peak hours (from timetables and riders), a peak trigger, buses to borrow from lines that peak at other times, and moves that wait for a bus's trips so no departure is missed. Blocks to build your own strategies: compare with a normal day, passenger journeys, group by, join lists, and extra departures planned ahead; 49 starter workflows in nine groups (including the *Control room* group). Reference: [`docs/automation-api.md`](automation-api.md).
- **Route diagnostics** (not locked): clickable route warnings with the cause, a map overlay, fixes with before/after, and undo. See [`docs/route-diagnostics.md`](route-diagnostics.md).
- **Depot moves**: a bus can be based at another depot and drives there on the road.

## Known gaps and next steps

1. **Native window visuals:** saving, closing, quitting and reopening are verified in the real app. Still to do: look at the HUD in the native window, and press ⌘Q by hand once (the test sends the same event as the menu item). Both need an unlocked screen.
2. **Human playtest of pacing:** how quickly a new player reaches a second and third area.
3. **Trip history:** finished trips are pruned at the end of each service day. Per-bus history is kept in daily stats only.
4. **Growing beyond the bundled İstanbul tiles needs a connection.** Downloaded tiles go into the browser's tile cache, so a grown game should reopen offline. Not yet checked in the desktop app.
5. **Selected line behind tall buildings:** in dense grids (Barcelona) a selected line can be hidden by buildings at a steep pitch. The line still shows in the network view (N).

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
  - Barcelona, Tokyo and Hamburg verified.
  - 3D buses keep left in left-hand-traffic countries (UK, Japan), matching the line overlays.
  - Desktop quitting: macOS ⌘Q used to terminate at once, skipping the save. The app menu's Quit item is now our own: it asks the game to save (at most 3 s), then exits, with a 5 s fallback.
  - Native save round trip: `scripts/dev/native-saves.sh` covers three launches of the release app. All steps pass.
  - Start screen: the menu city runs a real bus company behind the menu, and the camera follows its buses. New company setup is three short steps: place, home area, company.
  - Esc in the game works again: it leaves the current tool, then opens the menu.
  - From the player's feedback:
    - **Stop spots.** Stops can only be built on stop spots: every real bus stop in OpenStreetMap, plus generated spots about every 300 m along main roads, and on residential streets where nothing else is within 450 m (`src/game/spots.ts`).
      - Clicking anywhere else builds nothing and says why.
      - `spots.test.ts` checks the spacing. It also checks that every generated spot is buildable, and that 99.9% of homes and jobs a bus can reach are within 500 m of a spot.
    - **Line editor tray.** The instructions now sit in their own strip above the tray, so they are never cut off. The stats read "Outbound / return", "Round trip" and "Buses for a 10-min service".
    - **Demand overlay.** It was a grid of uniform dots. It is now a smooth field, scaled to the busy 95th percentile of the area, with the heat radius following the 150 m cells at every zoom. Homes the road network cannot reach, such as across the water, are left out.
    - **Bigger maps.** Each preset city covers about 2.5× the area (İstanbul: Zeytinburnu to Ortaköy, 6×5 tiles, 30 bundled offline). Custom places use about 9–10 km squares.
    - **Bigger start.** A new company starts with its home area plus the areas around it: about 15 km² of land (water does not count). Licence prices and reputation gates count only areas bought after founding.
    - **Only your territory is shown.**
      - Your areas are drawn in full, with a green border.
      - Areas you can license next sit under a light veil, with their name and price; clicking one opens its licence.
      - Everything else is blank paper: map, 3D buildings (masked in the city shader), labels, stop spots and landmarks.
      - Panning far into the paper eases the camera back.
    - **Economy check after the bigger maps.** Destinations now compete across a larger city, so the reference Taksim → Karaköy line carries about 3,000 riders a day (was 4,300) and makes about +3,800 a day (was +6,000). The 40-day progression bot does better than before, about +7,000 a day with 2 lines and 7 buses, because the bigger start gives it better corridors. See `docs/economy.md`.
  - From the player's feedback ("still small, allow me to expand the map"):
    - **The map grows with the company.** Areas are now z14 map squares (about 2 km across, 3–4 km²), named after the main place inside. Squares are fixed worldwide, so an area keeps its id and outline when more map loads.
    - The region always covers the territory plus 2 squares all round (`src/game/world/zoneTiles.ts`). Licensing a square near the edge rebuilds the region with more tiles in the background. The running game then moves onto it (`src/game/growth.ts`): stops, depots and buses on the road are re-attached to the same street points, and the camera and open panels stay put.
    - Open water squares are never for sale. They are shown beside your areas, and land across one of them counts as a neighbour (Selimiye across the Bosphorus).
    - Starting area: a compact block of about 5 squares (about 15 km² of land).
    - `growth.test.ts`: a company running buses on the old 12-tile map moves onto the 30-tile map mid-service. No bus returns to its depot, every stop keeps its street point, money and statuses are unchanged, and trips keep completing with clean books.
    - Browser: founding grew İstanbul from 30 to 49 tiles in 0.7 s; licensing Bademlik at the edge grew it to 56 tiles in 1.2 s with buses running and a clean audit. Offline, the map waits and grows when the connection is back.
    - Older saves: their areas are redrawn as squares on load. The game keeps every square with a stop or depot, and says so.
  - From the player's requests ("a little MCP for AI agents", "better onboarding form content", "automatic updates, push to GitHub"):
    - **MCP server** (`mcp/server.ts`, `mcp/data.ts`; `.mcp.json` for Claude Code). It gives agents read-only access to the desktop saves through 12 tools: overview, lines, line details, buses, stops, finances, daily history, objectives, notifications, territory, and raw JSON-pointer queries. Figures come from the game's own helpers and are shown in the city's currency. Checked on the real Tokyo and İstanbul saves. `mcp/server.test.ts` runs a company, saves it, and reads it back through the official MCP client over stdio; it also refuses a path-traversal save id.
    - The desktop app ships the server as one bundled file (`pnpm build:mcp` → `dist-mcp/project-transit-mcp.mjs`, a Tauri resource). Settings → AI agents copies a Claude Code command or a JSON config pointing at it, with the absolute Node.js path the app finds (Rust `find_node`; apps like Claude Desktop start servers with a bare PATH). Verified:
      - the bundle passes the MCP tests (`PT_MCP_BUNDLE=1`);
      - the copied JSON entry starts the server from inside the built app with a bare PATH and reads the real Tokyo save;
      - the copied command splits correctly in zsh despite the space in "Project Transit.app".
    - The game core now runs in plain Node (no TypeScript-only constructor shorthand in `engine.ts`, `geo.ts`, `graph.ts` and `traffic.ts`).
    - **New-company form:**
      - Step 1: clearer search and "start where the map is".
      - Step 2: each area shows how busy it is, whether it is mostly homes or workplaces, and its kinds of key places. Kinds only, because OSM maps one university as many buildings. The starting area is summarised the same way.
      - Step 3: name suggestions, named colours with a bus paint preview, named logos, and what the money buys (depot and bus prices). It explains what reputation does, gives the right starting area (it said "1 area"), says what happens after founding, and hints when the name is empty.
    - **Automatic updates** (`src/app/updates.ts`, `src/ui/UpdateBanner.tsx`, `.github/workflows/release.yml`, `docs/releasing.md`). Tauri's updater checks this repository's GitHub releases at launch and every 6 hours, downloads in the background, and offers "Restart now". Otherwise it installs on quit, saving first. Settings has the version, Check now, and an on/off switch.
      - Updates are signed. The key is outside the repository, with a GitHub secret copy.
      - Tagging `v*` tests, builds macOS (both chips), Windows and Linux, and publishes the release with `latest.json`.
      - The speed test's budget is tripled on CI only, because shared runners are slower.
      - Verified locally: a signed release build produces the `.app.tar.gz` update and its signature.
      - First release: v0.2.1. The v0.2.0 tag's run stopped in tests (the 40-day test hit its 180 s limit on the slower CI runner; CI now allows 900 s), so v0.2.0 has no release.
      - v0.3.0: Network Control (analytics, Automation Studio, Simulation Lab), clickable route diagnostics, moving buses between depots. Details in `docs/network-control-progress.md`.
- **2026-10-31.**
  - v0.4.0: the City Activity Engine (phases 0–7: places, tours, traveller types, nested mode choice, the city's own transit, weather, events, service plans, trust minutes, walking changes) and more Automation Studio blocks (peaks, sharing buses between lines, connection holds, control-room blocks, "why reputation fell", 49 starter workflows). Details in `docs/city-activity-engine-progress.md` and `docs/network-control-progress.md`. PR #4.
