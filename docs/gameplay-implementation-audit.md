# Gameplay implementation audit

**Date:** 2026-10-29 · **Commit audited:** `7c35c4a` (Project Transit: design prototype)
**Method:** read every source file in `src/`, `scripts/` and `src-tauri/src/`, ran the dev
server, drove it with Playwright (Chromium, Metal GPU) and measured the simulation from the
page (`window.__sim`). Screenshots of the prototype are in `docs/screenshots/`.

Classification key:

| Label | Meaning |
|---|---|
| **Functional** | Implemented and actually works as a game system |
| **Partial** | Real logic exists but is incomplete or has gaps that matter for gameplay |
| **Visual only** | UI or animation exists, but the numbers or behaviour behind it are scripted or invented |
| **Missing** | Not present |
| **Broken** | Present but wrong or unreliable |

## Summary

The prototype is a strong **renderer and interface**: a convincing miniature 3D Istanbul built
from OpenStreetMap vector tiles, a polished dark floating HUD, and a road graph that line
geometry genuinely follows. It is **not yet a game**. There is no game state beyond a handful of
fields on a singleton, no economy, no passenger model, no timetable, no save, and most numbers in
the HUD are hard-coded.

The most important technical finding: **vehicle movement is not tied to the game clock.**
`Simulation.tick` advances the clock by one game minute per real second at 1×, but moves buses at
~9.5 metres per *real* second. Measured: in 5.0 game minutes buses moved 28.7 m on average
(≈0.34 km/h of game time), while the line inspector claims 14-minute round trips on 5–7 km loops.
Any ETA, timetable, revenue or traffic figure derived from this movement would be meaningless, so
the vehicle simulation has to be rebuilt on a consistent time base.

## System by system

### Geography, map and rendering

| System | State | Evidence |
|---|---|---|
| 2D base map (MapLibre, custom style) | **Functional** | `src/map/style.ts`. OpenFreeMap tiles, Figtree glyphs, attribution shown. |
| 3D miniature city (buildings, roofs, trees) | **Functional** | `cityLayer.ts` + `cityWorker.ts`. Worker builds geometry per z14 tile; heights inferred when OSM has none (documented). |
| Offline Istanbul tiles | **Functional** | 12 bundled z14 tiles in `public/tiles`, listed in `src/data/bundledTiles.json`. |
| Other cities (London, Hamburg, Durham, Tokyo) | **Visual only** | Map and 3D city stream and render, but no road graph, stops or gameplay exist there. `flyToCity` is camera-only. |
| Location search | **Missing** | Only five hard-coded camera presets. |
| Coverage indicators (roads/buildings/POIs/traffic) | **Missing** | |
| Loading progress | **Partial** | Boot screen with an indeterminate bar; hides after map load or 9 s. |
| Bridges in the road graph | **Partial** | Bridges are kept, but nodes are merged purely by rounded coordinates (`buildGraph`), so a bridge vertex that coincides with a road underneath becomes a false junction, and `snapDangles` can join a road to a bridge deck above it. |
| Tunnels in the road graph | **Broken** | `bake-istanbul.ts` drops every `brunnel=tunnel` segment, so buses can never use underpasses and some roads may be disconnected. |
| Bridge rendering | **Partial** | Road bridges render correctly with casings. The Haliç Metro Bridge deck (a building feature over water) is extruded as a solid wall from the water surface. |

### Road graph and routing

| System | State | Evidence |
|---|---|---|
| Road graph | **Functional (Istanbul only)** | Baked offline into `src/data/istanbul/graph.json` (≈2.3k nodes). Largest connected component kept. Road class per edge. |
| One-way streets | **Partial** | Wrong-way travel is allowed at 4× cost + 80 m (`adjacency`), a deliberate workaround for tile-simplified junctions. Routes can therefore still drive against one-way restrictions. |
| Turn restrictions, access restrictions | **Missing / partial** | `access=no` and parking aisles are dropped in the bake; no turn restrictions (the tile schema does not carry them). |
| Shortest path | **Functional** | Dijkstra with a binary heap and class-based costs (`shortestPath`). Distance-based, not time-based. |
| Runtime graph for other places | **Missing** | Graph building only runs in the Node bake script. |
| Spatial index / snapping | **Partial** | A 100 m grid index for snapping (`routeEditor.snap`); nearest-node search elsewhere is linear. |

### Transport network

| System | State | Evidence |
|---|---|---|
| Bus stops | **Partial** | 78 real OSM stops are baked and selectable. Players **cannot place, rename, move or delete stops**. Stop `waiting`, `demand` and catchment values are invented (hash of the name, +1 at random intervals). |
| Line creation | **Partial** | `R` tool: click OSM stops in order; legs route along roads; undo/redo; colour choice. Always creates a closed loop. No naming, renumbering, waypoints, reordering, removing a stop in the middle, editing an existing line, deleting a line, or outbound/return variants. |
| Route preview, distance, journey time | **Partial** | Preview leg to the cursor works. Journey time is `length / 15.5 km/h + 0.6 min/stop`, unrelated to the actual vehicle simulation. |
| Demo lines 26/32/46 | **Visual only** | Real routed paths, but all performance figures (`PERF`) are hard-coded. |
| Draft validation | **Partial** | Rejects a stop with no drivable connection. No duplicate-stop or disconnected-network warnings. |

### Vehicles

| System | State | Evidence |
|---|---|---|
| 3D bus models, smoothing, right-hand offset | **Functional** | `vehicles3d.ts`. Three model geometries, hover ring, selection ring, x-ray silhouette when occluded. |
| Movement along lines | **Broken** | Moves along the line polyline but on real time, not game time (see summary). Speed is a function of a hashed "local congestion", not road class. |
| Stopping at stops, dwell | **Partial** | Buses stop and dwell `4 + 0.18 s × (boarding + alighting)` (real seconds). |
| Vehicle state machine | **Missing** | Statuses are `running/boarding/delayed/depot`. No preparing, deadheading, terminus layover, returning to depot or maintenance states. Buses run 24 hours a day. |
| Depot movements | **Missing** | Assigning a depot bus teleports it onto the line ("largest gap"). |
| Vehicle attributes | **Visual only** | Condition, age and odometer are random at start. Condition never changes. |
| Follow camera, picking, hover tags | **Functional** | Screen-space picking, follow mode, floating tag. |
| Zoom-dependent markers | **Missing** | Buses are scaled up when zoomed out (`zoomBoost`) and hidden below z13.2. |

### Passengers and demand

| System | State | Evidence |
|---|---|---|
| Passenger generation | **Visual only** | Each stop gains +1 waiting passenger with 50 % × peak probability per tick, capped at 120. No origins, destinations or purposes. |
| Boarding / alighting | **Visual only** | Random fractions: alight 15–45 % of the load, board 30–80 % of those waiting, capped at capacity. Passengers have no destinations, so "alighting" is random. Capacity is respected. |
| Demand overlay | **Partial** | Heat map of building floor area from the 3D worker (real OSM footprints, inferred heights). Not used by any simulation. |
| Destinations (landmarks) | **Visual only** | Nine real OSM places; `tripsPerHour` values are invented. |
| Satisfaction | **Visual only** | Hard-coded 74 % with a hard-coded breakdown. |
| Transfers, walking, fares, crowding effects | **Missing** | |

### Timetables and operations

| System | State | Evidence |
|---|---|---|
| Timetable editor | **Missing** | Button disabled ("Not in demo"). Lines show a fixed `05:30–23:30`, which is never enforced. |
| Frequency | **Visual only** | Displayed headway = estimated round trip ÷ vehicle count. |
| Vehicle requirements | **Visual only** | Route tray shows "buses for 10 min" from the estimate. |
| Delays, punctuality | **Visual only** | `delayMin` is a function of hashed local congestion at the moment of arrival; no schedule exists to be late against. |

### Traffic

| System | State | Evidence |
|---|---|---|
| Time-of-day profile | **Partial** | `congestionAt(hour)`: two Gaussian peaks plus midday. Labelled as simulated. No weekday/weekend difference. |
| Per-edge congestion overlay | **Partial** | Per-edge values from road class × hashed noise × profile, drawn per direction. Correctly labelled "Simulated estimate, not live data". |
| Effect on vehicles | **Partial** | Affects bus speed through a separate hashed value (not the same numbers the overlay shows). |
| Effect on schedules, costs, satisfaction | **Missing** | |
| Traffic provider abstraction | **Missing** | |

### Economy

| System | State | Evidence |
|---|---|---|
| Balance | **Visual only** | Starts at ₺18.42M; increases by the sum of hard-coded `profitPerDay` values spread over the day. |
| Vehicle purchase | **Partial** | Deducts the price and checks affordability. No ledger entry. |
| Running, maintenance, depot, staff costs | **Missing** | `costPerHour` is displayed but never charged. |
| Ledger | **Missing** | |
| Finance panel | **Visual only** | Rows, 7-day history and per-line profit are constants. |
| Ticket price, loans, bankruptcy | **Missing** | |

### Company, progression and territory

| System | State |
|---|---|
| Company identity | **Visual only**: "Haliç Transit", level 4, 62 % to level 5 are constants. |
| Reputation, levels, objectives | **Missing** |
| Territories / licensing | **Missing** |
| Depots | **Visual only**: a named "Kasımpaşa depot" exists only as text; no location or capacity. |
| Onboarding | **Missing** |
| Notifications | **Visual only**: the bell shows one fixed message. |

### Application shell

| System | State |
|---|---|
| Tauri v2 desktop shell | **Functional**: builds and runs; diagnostics hook (`PT_DIAG_DIR`). |
| Start menu, new game, continue, load | **Missing** |
| Save / load / autosave | **Missing** (no persistence of any kind) |
| Settings | **Missing** (button disabled) |
| Keyboard shortcuts | **Functional**: Space, 1–3, WASD, Q/E, F, H, L/G/M, T/P/N, R, Esc, ⌘Z/⇧⌘Z (route draft only). |
| Tests | **Missing**: no test runner or tests in the repository. |

## Architecture as found

- `src/sim/sim.ts` exports a mutable singleton `sim` (clock, lines, stops, vehicles, funds) that
  every map module and React component reads directly. React components poll it with timers
  (`useTicker`).
- The simulation is ticked from the map's `requestAnimationFrame` loop (`controller.ts`) with a
  variable `dt` capped at 0.1 s, so it depends on frame rate and on the map existing.
- UI state lives in a small Zustand store (`src/state/store.ts`), which is a good base.
- The renderer (`cityLayer`, worker, style, vehicles3d) is well separated and should be kept.

## What to keep, change and replace

**Keep:** the map style, 3D city worker and layer, bus models, overlay layer machinery, stop
marker designs, HUD components and CSS design system, Zustand UI store, keyboard handling,
Tauri shell, tile helpers.

**Change:** road graph building (runtime, worldwide, bridge/tunnel aware, travel-time costs);
overlays and markers to read a real game state; inspectors and panels to show derived data.

**Replace:** `sim.ts`, `network.ts`, `actions.ts`, `demoLines.ts`, hard-coded performance and
finance values. A new game core with a fixed-step clock, a serialisable game state and typed
systems is needed. Progress against the plan is tracked in `docs/development-progress.md`.
