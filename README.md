# Project Transit: design prototype

An interactive, design-first prototype of a desktop public-transport management game, set in a stylised 3D model of real Istanbul (Karaköy, Galata, Eminönü and the Golden Horn). It is a look-and-feel prototype, not the game: the map, the floating UI and the core interactions work, while the economy and simulation are lightweight stand-ins.

![Overview](docs/screenshots/1920x1080-overview.png)

## Run it

Requirements: Node 22+ and pnpm. The desktop app also needs Rust (stable) and the Xcode command-line tools on macOS.

```sh
pnpm install

pnpm dev          # browser: http://localhost:5173
pnpm app          # desktop window (Tauri v2), with hot reload
pnpm app:build    # release build -> src-tauri/target/release/bundle/macos/Project Transit.app
```

`pnpm app` starts its own Vite server on port 5173, so stop any running `pnpm dev` first.

Other scripts:

| Script | What it does |
| --- | --- |
| `pnpm shots` | Drives the running dev server with real clicks and key presses, and saves every demo state at 1920×1080, 2560×1440 and 1366×768 to `docs/screenshots/`. Pass a size and states to narrow it down, e.g. `node scripts/capture.mjs 1920x1080 overview,bus-selected`. |
| `pnpm check:webkit` | Loads a production build (`pnpm build && pnpm preview --port 4173`) in WebKit, the engine behind Tauri's macOS window. |
| `pnpm bake` | Re-downloads the bundled Istanbul tiles and rebuilds the road graph, the real bus stop list and the demo lines in `src/data/istanbul/`. |
| `pnpm build` | Type-checks and builds the web bundle. |

## Things to try

1. **Look around.** Drag to pan, scroll to zoom, right-drag (or Ctrl-drag) to rotate and tilt. Q/E rotate, WASD pan, H returns home.
2. **Click a bus.** Buses are the small red-and-white models on the coloured lines. The inspector shows its line, occupancy, next stop and position on the line. Press **F** (or *Follow*) and the camera rides along. A selected bus stays visible as a coloured silhouette when buildings hide it.
3. **Click a coloured line** (or pick one in **Lines**, key L). The line is highlighted, the others dim, and stop catchments appear. The inspector has Overview, Stops and Vehicles tabs, and **Add bus** takes a vehicle from the depot.
4. **Click a stop.** You see the lines that serve it, live next arrivals, and real destinations within walking distance.
5. **Traffic (T), Passenger demand (P) and Network view (N).** The first two lower the city so the overlay reads. Network view flattens it completely.
6. **Fleet (G)** lists the buses in service, assigns depot buses to lines, and buys new buses. **Finances (M)** shows the account, the last 24 hours and the last 7 days.
7. **Create a line (R).** The real bus stops from OpenStreetMap appear as white dots. Click them in order; stops already on a line work too. The path is routed along actual roads. Clicking anywhere else only shows a hint. Undo and redo with ⌘Z and ⇧⌘Z. **Create line** puts two depot buses on it straight away.
8. **Time.** Space pauses; 1, 2 and 3 set the speed. The strip beside the clock shows the typical traffic curve for the day.
9. **Esc** steps back: tool, then follow, then selection, then panel, ending on the clean map. **Shift+U** hides the whole HUD.

The company menu (top left) can also fly to London, Hamburg, Durham or Tokyo. Those cities show the same 3D map, but the transport network only exists in Istanbul.

## What is real, simulated and placeholder

**Real (authentic data)**
- Streets, building footprints, water, parks, woods, rail, bridges, and street and district names all come from OpenStreetMap, via OpenMapTiles vector tiles served by OpenFreeMap. The twelve zoom-14 tiles around the demo area ship with the app (`public/tiles`, 4.1 MB), so Istanbul loads without a network. Anywhere else streams from OpenFreeMap.
- **Bus stops are real.** The 252 OpenStreetMap bus stops in the play area are baked into `src/data/istanbul/stops.json`. The pair on either side of a street, and numbered platforms such as *Şişhane 1–6*, are merged into one stop, leaving 78 stops on bus roads. New lines can only use these stops; players don't place their own. The three demo lines already sit on real stops, within about 25 m.
- The destination landmarks (Galata Kulesi, Mısır Çarşısı, Sirkeci Garı, İstanbul Modern and others) use real OSM names and positions.
- Lines and newly drawn routes follow the real road network, which is built from the same tiles. One-way streets are respected as a strong preference: going the wrong way is allowed at four times the cost, because the tile data's simplified junctions otherwise force absurd detours.

**Simulated (generated or modelled, not measured)**
- **Building heights and roofs.** About 96% of buildings in this area have no height in OSM. Heights are inferred from footprint size plus a stable per-building variation, and small blocks get hipped roofs. The colours are a stylised palette.
- **Trees.** Placed procedurally inside OSM parks, woods, grass and cemeteries.
- **Movement.** Bus movement, stop dwell, boarding and alighting, occupancy and delays come from a small simulation (`src/sim/sim.ts`), with buses drawn larger than life for legibility.
- **Traffic.** A time-of-day congestion model with morning and evening peaks plus per-street variation. It is not live traffic, and the legend says so.
- **Passenger demand.** A heat estimate from building floor area.
- **Money.** The balance accrues from each line's daily result as the clock runs.

**Placeholder (prototype values, clearly labelled in the UI)**
- Company name, level and reputation; satisfaction and its breakdown; each line's profit, riders, punctuality and issues; the finance rows and 7-day history; vehicle condition, age and mileage; fleet numbers; destination trip counts; the notification.
- Vehicle models (*Midi 9*, *Urban 12*, *Artic 18*) and their prices.
- **Controls marked "Not in demo" or "Soon"**, which are disabled on purpose: reassign bus, send to depot, edit timetable, the Depots tab, loans, settings, depots & research, and custom liveries.
- A "PROTOTYPE · simulated data" tag sits at the bottom of the screen at all times.

There is no backend, account system, save game, full economy or multiplayer.

## How it is built

- **Tauri v2, React 19 and TypeScript, built with Vite.** UI state lives in Zustand. The simulation is plain TypeScript, independent of React.
- **MapLibre GL** draws the 2D base map from a custom style (`src/map/style.ts`): ground, water, roads, labels and a Figtree glyph set generated for the map.
- **Three.js** draws buildings, trees and buses in a MapLibre custom layer that shares the depth buffer (`src/map/cityLayer.ts`). Web Workers decode each zoom-14 tile into flat-shaded geometry with baked lighting (`src/map/cityWorker.ts`). The light comes from the west-south-west, giving a light top and two clearly different wall tones, as in a miniature model. Each tile has its own origin, and matrices are computed in 64-bit to avoid jitter.
- **Map overlays.** Lines, traffic, demand, catchments and the route draft are GeoJSON layers (`src/map/overlays.ts`). Lines that share a street run in parallel lanes. Stops and destinations are HTML markers with original designs (`src/map/markers.ts`).
- **The floating HUD** is in `src/ui/`, styled by `src/styles/tokens.css` and `src/styles/ui.css`.
- **Design docs** are in `docs/design/`:
  - `visual-research.md`: what was studied and which screenshots were inspected.
  - `reference-board.md`
  - `design-system.md`: palette, type, layout and components.
  - `desktop-layouts.md`: three layout directions and the recommendation.

## Data and attribution

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Tiles from [OpenMapTiles](https://openmaptiles.org/), served by [OpenFreeMap](https://openfreemap.org/). Attribution is shown on the map at all times.

The UI font is Figtree (SIL Open Font License). Icons are Phosphor (MIT). All art is original: the buses, stop markers, logo and illustrations are drawn in code. The design takes cues from City Transport Manager by PeDePe, but no screenshots or art from that game are included.

## Verification and known limitations

- The screenshots in `docs/screenshots/` come from Chromium with GPU WebGL (Metal), driven by `scripts/capture.mjs`.
- The production build was also checked in Playwright's WebKit, which renders the 3D city, lines and HUD correctly.
- `Project Transit.app` was checked in its own native window: it renders the 3D city and the HUD on the Apple GPU with no errors (`tauri://localhost`). To repeat that check, launch it with `open -n --env PT_DIAG_DIR=/some/folder "Project Transit.app"`; it writes a render report and a PNG of its map canvas. The window only draws while the Mac is unlocked, because WebKit suspends rendering for hidden windows.
- Wide views (zoom < 14) switch to a flat map by design. Only zoom-14 tiles carry 3D buildings.
- Route creation is limited to the Istanbul demo area, where the road graph exists.
- With both a management panel and the inspector open, roughly 66–70% of a 1920×1080 map stays unobstructed, below the PRD's 75–85% target. The clean map and single-panel states are well above it. `docs/design/desktop-layouts.md` suggests fixes.
