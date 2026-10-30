# City Activity Engine: progress

Tracks the City Activity Engine against its plan in `docs/city-activity-engine-plan.md`. Section numbers below refer to that plan.

Status key (as in `docs/development-progress.md`):
- ✅ **done and verified**: by an automated test or by inspecting screenshots of the real game. The evidence is named.
- 🟡 **partial**: works, with a known gap.
- ⬜ **not started**.

A feature is not marked done just because its UI exists.

Last updated: 2026-10-30 (phase 2).

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

## Phase 2. Journeys and choice 🟡

Built and tested. Screenshots in `docs/screenshots/city-activity/` come from a company simulated for 31 days until Network Control unlocked (`scripts/capture-network.mjs sim`, then `scripts/capture-activity.mjs`). 🟡 until the owner has played it, because it changes which lines carry riders (see "Effect on play").

| Item | Status | Evidence |
|---|---|---|
| Activity budget from buildings: the demand grid gains jobs from floor area, floor space, health, services and hotels (`regionBuilder.ts`). A POI's own jobs count only where no building is mapped, so shops and venues are no longer counted on top of the building they are in | ✅ | `activity.test.ts` "a block with 500 restaurants…" (the floor space caps visits; POIs change the mix; no POIs and empty cells give no NaN) |
| Activity zones (`src/game/activity/zones.ts`): 600 m squares in your areas and one ring around them, one zone per area beyond that, one zone per significant place (airports, main stations, piers, metro and bus stations, hospitals, campuses, malls, stadiums, big markets), and the airports beyond the map | ✅ | 410 zones for İstanbul with every area owned; `activity.test.ts` "size and speed" |
| Tours by kind (13 kinds: work, shifts, school, university, shopping, errands, health, leisure, nights out, visits, business, flights, arrivals), with start and stay curves by day type. Gravity per kind; work and education doubly constrained; each origin keeps its top destinations (95% of tours, at most 60, all of them when there are at most 8); airport arrivals mirror departures (`od.ts`) | ✅ | `activity.test.ts`: a 40 million passenger airport draws at least 30 times the air travellers of a 0.5 million one |
| Ten traveller types with their own sensitivity to fares, waits, changes, walking and reliability, car and taxi use, cycling and patience (`params.ts`) | ✅ | used by the choice below; patience by type in `passengers.ts` |
| Tour-level choice between walking, cycling, car (by car availability), taxi and your network, with the way home counted: a tour whose last bus has gone scores your network as a taxi ride plus 15 minutes. Optional tours rise a little when your network is good (at most +15%) | ✅ | `activity.test.ts` "a more frequent line wins riders from walking and cars, with a bounded rise in trips" |
| Linked returns: travellers who arrive go into the away pool (saved), and come back from where they got off at a time drawn from their tour's length of stay. With no bus home they are stranded, counted with those who gave up | ✅ | `activity.test.ts` "origin–destination consistency" (the audit checks away = sent away − returned, and returns never exceed outbound arrivals); "determinism with the away pool" |
| Directional demand | ✅ | `activity.test.ts`: a line from Haseki to Beyazıt boards at least 2× more at the home end from 06:00 to 10:00, and at least 1.4× more at the job end from 16:00 to 20:00 (measured 2.7× and 1.8×) |
| Gateways: train stations, piers, metro stations (tier 3 and up) and bus stations send a share of their users into the city and attract travellers heading there | ✅ | `zones.ts` (`GATEWAY_SHARE`); approximate until phase 3 |
| The new rates feed the existing passenger generator; groups carry their traveller type and tour kind | ✅ | full suite green (133 tests) |
| Analytics by traveller type: boardings per stop and line, journeys, left behind, stranded by hour, origin–destination by type | ✅ | `network-control.test.ts` "analytics queries" (counts add up, with stranded travellers); `activity.test.ts`: the new fields add at most 30% to a day record |
| Estimated demand from the model, by mode (walk, bike, car, taxi, your network), for trips starting or ending in your areas, by area or by place; an unserved view that says why (no stop within a walk, or no line links the stops) | ✅ | `network-control.test.ts` "estimated demand" (2 tests); `activity.test.ts` "unserved demand" (2 tests); screenshots `nc-estimated-areas.png`, `nc-estimated-places.png`, `nc-unserved-areas.png`, `nc-unserved-places.png` |
| Place card: "How people travel here", modelled trips a day by mode and your share; for airports beyond the map, the trips from your areas and "none by your network" | ✅ | `activity.test.ts` (Cevahir, İstanbul Airport, Sabiha Gökçen); screenshots `place-card-travel.png` (Mısır Çarşısı), `place-card-airport-travel.png` |
| Unserved demand creates no passengers and no fares | ✅ | `activity.test.ts`: a game that reads the estimate every 3 hours ends identical to one that never does |
| Calibration within ±10% | ✅ | `pnpm calibrate`, table below |
| Performance | ✅ | one hour of choice: 8.5 ms with 410 zones and 72 stops (`activity.test.ts` holds it under 30 ms at about 100 stops); the day estimate takes about 90 ms and is kept until the network, day, fare or reputation changes |

**Calibration** (`pnpm calibrate`, baseline = the earlier model):

| Figure | Now | Baseline | Change | Limit |
|---|---|---|---|---|
| Reference riders, weekday | 3,572 | 3,611 | −1.1% | ±10% |
| Reference riders, weekend | 3,045 | 3,076 | −1.0% | ±15% |
| Reference boardings a day | 3,397 | 3,432 | −1.0% | ±10% |
| Reference result a day | 3,966 | 4,032 | −1.6% | ±20% |
| Reference satisfaction | 0.74 | 0.77 | | above 0.6 |
| Thin line result, day 2 | −2,128 | −2,190 | | below 0 |
| Crowded line peak load | 1.00 | 0.97 | | above 0.8 |

The reputation cap is still in place (removed in phase 7).

**Changes from the plan, and why:**
- **The crowded scenario's line changed** (allowed by section 11, "a documented change to its setup"). It was a 14-stop zig-zag chain of nearby stops from Taksim. Under the new model walking or driving beats a line that wanders, so its morning peak reached only 71%. It is now a straight 10-stop line from Taksim to Mecidiyeköy along the main road, with the same two Mini 8 buses, headway, reputation and fare (`crowdedLine` in `test/helpers.ts`). Automation scenario 3 and the Simulation Lab test use the same line. Two tests that wait for "a bus with passengers on board" now wait up to 3 game hours instead of 15–30 minutes: they test commands, not demand.
- **The tour kind is split statelessly** (a deterministic sample from a hash of the stop pair and the minute) instead of separate accumulator keys per type. Same totals, no extra state in the save.
- **Space units and boarding time by type** move to phase 3 with the place profiles.
- **Stay-home is a bounded factor** on optional tours (at most +15% when your network is excellent), not a separate alternative.
- **Calibration constants:** your network carries a constant of +1 minute per journey (an alternative-specific constant, the usual calibration term). Access walking weighs 1.2 for most types (1.05 for students and event crowds, 1.5–1.6 for shoppers, pupils, air travellers and patients). Cycling carries a 60-minute propensity constant, which puts cycling near 2% of trips. That suits İstanbul, but it is one setting for every city.
- **Station gateways are approximate:** a share of each station's daily users, by mode. Phase 3 replaces them with the background transit network.
- **The estimate's other modes** use the traffic of each tour kind's busiest hour; your network is scored hour by hour, as in the simulation.

**Effect on play (measured):**
- Lines that wander lose riders to walking and cars; straight lines on busy corridors gain. That is the intended change, but it changes which lines pay.
- On the progression bot's network (two lines in Fatih and Beyoğlu) the new model carries about 25% fewer riders than the old one (about 6,900 against 9,100 on a weekday). The old model counted shop and venue jobs on top of building jobs (twice the jobs around Beyazıt) and gave every metro station a flat bonus. The bot still grows and stays profitable.
- The thin three-stop line carries more riders than before (131 against 97 on day 2) and still loses money.

**Known gaps:**
- Metro, tram and ferry lines are not in the choice yet (phase 3). Until then their trips appear as walking, car or taxi in the estimate (taxi is about a quarter of trips). The panel and the place card say so.
- The evening reversal is weaker than the morning peak (1.8× against 2.7× on the Haseki–Beyazıt line), because trips home spread over more hours.
- The development switch `setDemandEngine('legacy')` stays until phase 7 for comparisons.

## Phase 3. Places come alive ⬜

## Phase 4. Weather ⬜

Before this phase: ERA5 downloads need a free Copernicus account and API key, which the developer must create. The alternative is NOAA GHCN-Daily station data (public domain, no key).

## Phase 5. Events ⬜

## Phase 6. Network Control and automation ⬜

## Phase 7. Depth and balancing ⬜
