# City Activity Engine: progress

Tracks the City Activity Engine against its plan in `docs/city-activity-engine-plan.md`. Section numbers below refer to that plan.

Status key (as in `docs/development-progress.md`):
- ✅ **done and verified**: by an automated test or by inspecting screenshots of the real game. The evidence is named.
- 🟡 **partial**: works, with a known gap.
- ⬜ **not started**.

A feature is not marked done just because its UI exists.

Last updated: 2026-10-30.

## Phase 0. Foundations ✅

| Item | Status | Evidence |
|---|---|---|
| Game calendar of seasons and weeks, no real dates or months: 12-week year (autumn, winter, spring, summer, 3 weeks each); new games and upgraded saves start in week 1 of autumn; weeks start on Monday even when a company starts mid-week (`src/game/calendar.ts`) | ✅ | `calendar.test.ts` "game calendar" (5 tests) |
| Season and week in the top bar ("Mon · Day 1 · Autumn, week 1"), with the year in the tooltip | ✅ | screenshot `docs/screenshots/city-activity/place-card-station.png` (top bar) |
| Save version 3 with `world` (fixed city seed, calendar); version 2 saves upgrade idempotently | ✅ | `calendar.test.ts` "city seed and save version 3" |
| The city seed never changes, and nothing in the engine draws from the shared random stream for city randomness (`src/game/hash.ts`) | ✅ | `calendar.test.ts` "never changes the city seed while the shared random stream advances" |
| Calibration harness: reference, thin and crowded scenarios against a recorded baseline, with the agreed limits (`pnpm calibrate`) | ✅ | `src/game/test/calibration.ts`, `calibration-baseline.json` |
| Determinism harness: two identical runs, and reload mid-day | ✅ | `src/game/test/determinism.ts`; `calendar.test.ts` "determinism harness" |

## Phase 1. Place Registry ✅

| Item | Status | Evidence |
|---|---|---|
| Registry built with the region from the z14 tiles (`src/game/world/placeBuilder.ts`): airports (`aerodrome_label`, aprons), stations, piers, bus stations, cable cars and funiculars, hospitals, universities, schools, stadiums, venues, malls, markets, sights, parks, beaches, industrial areas, and nightlife and hotel districts from venue clusters | ✅ | `places.test.ts`; 866 places for İstanbul |
| Merging: points inside one outline become one place (faculties of a campus, the models inside Miniatürk); the same name within 250 m; stations merge by name (400 m), same mode (120 m) and other modes (80 m) into interchanges; metro entrances become ways in | ✅ | `places.test.ts` "merges stations…", "merges points inside one outline…" |
| Station modes from the track geometry (railway stations on funiculars and metro lines are told apart from trains); tiers from tracks, rail yards, ferry routes calling and interchanges | ✅ | `places.test.ts`: Yenikapı is a tier 1 train and metro interchange; Kabataş is a pier with a funicular |
| Airports beyond the map from the bundled OurAirports list (4,010 airports with scheduled service; public domain) | ✅ | `places.test.ts`: İstanbul Airport and Sabiha Gökçen listed 31–34 km away |
| Landside anchor for an airport on the map: the largest building beside an apron | ✅ | `places.test.ts` (Barcelona airport tiles, test-only): El Prat anchored within 1 km of a terminal |
| Measured sizes from a bundled Wikidata extract (CC0): passengers for 2,479 airports, plus 314 stadiums, universities and hospitals around the preset cities; every place says whether its size is measured or estimated, and from what | ✅ | `places.test.ts` "uses measured sizes from Wikidata…"; data scripts `scripts/data/build-airports.mjs`, `scripts/data/build-wikidata.mjs` |
| Stable ids (`osm:<tile feature id>`, `iata:<code>`, cluster keys); identical output on every build | ✅ | `places.test.ts` "has unique, stable ids…" |
| Spatial index over places (`PlaceIndex`, 300 m grid) | ✅ | `places.test.ts` "finds places by distance" |
| Place snapshot in the save (`world.places`): every airport, then the 300 most significant places, with a digest; refreshed when the map data changes | ✅ | `places.test.ts` "place snapshot in the save" (3 tests); 44 KB for İstanbul |
| Place card in the inspector: category, tier, modes, IATA code, size with its source, your stops within a 450 m walk and their lines, data credits, "Place a stop nearby" | ✅ | screenshots `place-card-station.png`, `place-card-airport.png` |
| Destination markers from the registry, clickable with the select tool | ✅ | screenshot `place-markers-airport-chips.png` |
| Chips on the map edge for the larger airports beyond the map, with their distance; they open the airport's card | ✅ | screenshots `place-markers-airport-chips.png`, `place-card-airport.png` |
| Stop card: "Nearby" lists the most significant places within the walk as links to their cards | ✅ | screenshot `stop-nearby-places.png` |
| Hub detection lists the registry's stations and piers for each served stop | ✅ | `passengers.ts` `DemandModel.hubs` |
| Demand unchanged | ✅ | `pnpm calibrate`: every figure equals the baseline (0.0% change) |
| Performance: registry build within the 300 ms budget | ✅ | about 80–100 ms for İstanbul (30 tiles) on the development Mac |
| Bundled data stays in the map worker (the worker grew to 389 KB, 151 KB gzipped); the main bundle does not carry it | ✅ | production build: the airport list appears only in `regionWorker-*.js`. Moving `tilesAround` to `zoneTiles.ts` also took the tile decoder out of the main bundle (3.21 MB → 2.95 MB) |

Screenshots are in `docs/screenshots/city-activity/`.

**Changes from the plan, and why:**
- **No z8 tile scan for airports beyond the map.** The bundled OurAirports list already has the location of every airport with scheduled service, so the extra tile download (section 6.1) adds nothing. It saves a network request and works offline.
- **Snapshot size:** 44 KB for İstanbul rather than "about 30 KB" (section 6.2), with 300 entries. Long Turkish hospital names are most of it.
- **Station lines** (grouping the tracks through a station into named lines, section 6.7) move to phase 3, where the background transit network needs them. Phase 1 counts tracks and ferry routes for the tiers only.
- **Shopping centres** are sized from their building, not from retail or commercial land use, which in the tiles covers whole shopping districts. Department stores are not places.
- **Beaches** come from the tiles' `beach` land cover; sand next to water without that tag is not used yet.
- **Wikidata student numbers** cover a whole university. The card says so ("whole university"); phase 2 must not treat them as one campus's students.

**Known limits (data, not code):**
- Closed or historic stations still mapped as stations keep their tier (Haydarpaşa in İstanbul).
- Some OpenStreetMap points are mistagged (a restaurant tagged as a school). The registry takes the tags as they are.

## Phase 2. Journeys and choice ⬜

## Phase 3. Places come alive ⬜

## Phase 4. Weather ⬜

Before this phase: ERA5 downloads need a free Copernicus account and API key, which the developer must create. The alternative is NOAA GHCN-Daily station data (public domain, no key).

## Phase 5. Events ⬜

## Phase 6. Network Control and automation ⬜

## Phase 7. Depth and balancing ⬜
