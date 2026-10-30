# City Activity Engine: progress

Tracks the City Activity Engine against its plan in `docs/city-activity-engine-plan.md`. Section numbers below refer to that plan.

Status key (as in `docs/development-progress.md`):
- ✅ **done and verified**: by an automated test or by inspecting screenshots of the real game. The evidence is named.
- 🟡 **partial**: works, with a known gap.
- ⬜ **not started**.

A feature is not marked done just because its UI exists.

Last updated: 2026-10-30 (phase 6).

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
- **The crowded scenario's line changed** (allowed by section 11, "a documented change to its setup"). It was a 14-stop zig-zag chain of nearby stops from Taksim. Under the new model walking or driving beats a line that wanders, so its morning peak reached only 71%. It is now a straight 10-stop line from Taksim to Mecidiyeköy along the main road, with the same two Mini 8 buses, headway, reputation and fare (`crowdedLine` in `test/helpers.ts`). Automation scenario 3 and the Simulation Lab test use the same line. **Approved by the owner on 2026-10-30.** Two tests that wait for "a bus with passengers on board" now wait up to 3 game hours instead of 15–30 minutes: they test commands, not demand.
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

## Phase 3. Places come alive 🟡

Built and tested. 🟡 until the owner has played it: a line now carries different people on different days, and the city's metro, tram and ferries compete with your buses.

| Item | Status | Evidence |
|---|---|---|
| Calendar rules as data per country (`calendar.ts`): the default 12-week layout (school terms with a holiday week in week 5, a short break early in week 7 and the summer off; university teaching with exams in weeks 6 and 9 and a summer break; a festive week), public holidays at fixed positions (TR 3, ES 3, JP 4, GB, DE and others 2 a year), Sunday and holiday trading. All labelled "typical pattern"; no real dates | ✅ | `places-alive.test.ts` "the calendar" (3 tests, including a 24-week year) |
| Tour volumes by weekday and calendar rule instead of one weekend factor: nights out on Fridays and Saturdays, errands and business on working days, public holidays like a Sunday, school days only for pupils, teaching weeks for students (exams 0.6 and more spread, breaks 0.15), shops by the Sunday rule with a festive peak | ✅ | `places-alive.test.ts` "place profiles" |
| Activity profiles as data (`activity/profiles.ts`): a tour's timing and volume come from the place at its activity end. Hospitals (shifts at 07, 15, 23 every day; outpatients 08–16 on weekdays; visitors 14–20 every day), airports by size (traveller waves from about 04:30; staff shifts at 05, 13, 21), universities, malls (every day, evenings), bazaars (shut on Sundays), street markets (a market day chosen from the place id and labelled "assumed"), stadiums (quiet on ordinary days), stations. Industrial and city shifts change at 06, 14, 22, mostly on weekdays | ✅ | `places-alive.test.ts`: shift hours by place, airport waves (a hub has at least 5, a small airport at most 3), market days, the Sunday rule, festive shopping |
| Schools: arrival 07:30–08:15, home time 15:00–16:00, school days only | ✅ | `places-alive.test.ts` simulates a school day and a holiday on the reference line: 88% of pupil trips fall in 07:00–08:30 and 15:00–16:30 (test: at least 60%); the holiday has under 5% of the school day's pupils |
| Residential and commuter campuses: students who live on a campus (residents inside its outline) walk to class, so fewer come from elsewhere | ✅ | `places-alive.test.ts`: a campus with housing draws under 70% of the students of the same campus without |
| Seasons for outdoor places: beaches (summer ×2.2, winter ×0.2), parks and sights | ✅ | `params.ts` `OUTDOOR_SEASON`; zones are rebuilt each season |
| Station gateways by kind: main stations send travellers with luggage through the day (more visitors), regional rail, metro and ferries mostly commuters, coach stations mostly visitors | ✅ | `params.ts` `GATEWAY_MIX` |
| Space on board and boarding time by traveller type: an air traveller with luggage takes 1.6 places and 2 extra seconds to board, visitors 1.2 and 1 s, shoppers and patients 1.1 and 0.5 s. Bus fullness, crowding, load factors and automation's occupancy count space, not heads | ✅ | `places-alive.test.ts`: a City 12 takes 90 commuters but 56 air travellers, and their stop takes longer; the vehicle card says when luggage takes the space |
| The city's existing transit from the map's tracks (`world/transitBuilder.ts`): stations snapped to rail, metro, tram, funicular and ferry lines, linked to their neighbours along the track; yards and sidings left out; a mode with a broken graph is switched off with a reason | ✅ | `transit.test.ts` (18 tests): M2 Taksim–Şişhane–Haliç, F1 Kabataş–Taksim, T1 Karaköy–Eminönü–Sirkeci–Sultanahmet, Marmaray Yenikapı–Üsküdar, ferry piers, caps, determinism, a mode switched off. İstanbul: rail 9 stations and 9 links, metro 22 and 21, tram 38 and 42, funicular 2 and 1, ferry 23 and 40; cable cars off (no track on the map). Built in about 2 ms |
| Existing transit as a choice (`activity/transit.ts`): walk to a station (up to 800 m), wait by mode, ride at the assumed speed, changes (also on foot between stations within 320 m), walk at the end. Assumed service: metro 32 km/h every 4 min, tram 18 and 6, rail 45 and 8, ferry 20 and 12, funicular 15 and 5; 06:00 to midnight, waits ×1.5 off-peak. A tour whose way home falls after midnight counts as stranded, as for your buses | ✅ | `places-alive.test.ts`: transit carries over 5% of the city's trips (about 10% on the reference company), and without it those trips go back to taxis and cars |
| Line inspector, "how the line is used": who rides (traveller types), through the day by direction with its peaks, where they go and where they come from, fares by time of day, load by direction, punctuality. Shown before Network Control unlocks. Boardings by hour and direction are recorded from now on (`RouteDay.bp`) | ✅ | `line-character.test.ts` (3 tests: nothing before a full day; direction sums equal the line's boardings; older days without directions still show); screenshots `line-character.png`, `line-character-scrolled.png` |
| Place card, "When it's busy": modelled trips to and from the place by hour today, with the current hour marked, the place's typical pattern and what today means for it (school day, exam week, market day, Sunday closing). Stations list their links on the city's network with the assumed service, and any mode switched off with why | ✅ | screenshots `place-card-busy-*.png` |
| Estimated demand and the place card show "Metro, tram, ferry" as a mode | ✅ | screenshot `nc-estimated-transit.png` |
| Calibration within ±10% | ✅ | table below |

Screenshots in `docs/screenshots/city-activity/` come from a company simulated for 31 days with this phase's code (`scripts/capture-network.mjs sim`, then `scripts/capture-places.mjs`). Day 31 falls in winter week 2, the school holiday week, which the cards show.

**Calibration** (`pnpm calibrate`, baseline = the earlier model):

| Figure | Now | Baseline | Change | Limit |
|---|---|---|---|---|
| Reference riders, weekday | 3,459 | 3,611 | −4.2% | ±10% |
| Reference riders, weekend | 2,858 | 3,076 | −7.1% | ±15% |
| Reference boardings a day | 3,259 | 3,432 | −5.1% | ±10% |
| Reference result a day | 3,717 | 4,032 | −7.8% | ±20% |
| Reference satisfaction | 0.74 | 0.77 | | above 0.6 |
| Thin line result, day 2 | −2,112 | −2,190 | | below 0 |
| Crowded line peak load | 0.97 | 0.97 | | above 0.8 |

Before retuning, the city's transit and the new weekday patterns took the reference line to −7.3% on weekdays and −11.0% at weekends. Your network's constant moved from +1 to +0.5 minutes per journey.

**Changes from the plan, and why:**
- **Station lines are not grouped into named lines.** The map tiles carry no line names or route relations for rail, so a station's "lines" are its links to the next stations along each mode's track (shown on the place card). The choice does not need line names; changes are counted between modes and on foot between stations.
- **Changes on one mode are not counted** (two metro lines crossing count as one ride), for the same reason. On foot between stations within 320 m is a change.
- **The way home by transit** uses the same journey as the way out; it is a stranded trip when the return falls after midnight.
- **Length of stay stays per tour kind**, not per place (a hospital's 12-hour shifts use the shift kind's mix of 8- and 12-hour stays).
- **Holidays and terms are weeks of a 12-week template** that scales to other year lengths. A public holiday falls in the first real week of its template week.
- **A ferry "crossing" under 300 m** between piers side by side (one pier mapped twice) counts as a walk, and the place card leaves it out.

**Effect on play (measured):**
- On the reference company, the city's metro, tram and ferries carry about 10% of all modelled trips; taxis fall from about 24% to 13% of the estimate.
- The reference line carries about 4% fewer riders on weekdays and 7% fewer at weekends than the earlier model. Friday and Saturday nights are busier and Sundays quieter.
- In the school holiday week, school trips almost stop (pupils were 3% of a city-centre line's riders). University lines lose about 85% of students in the summer break.
- Buses to the airport fill up sooner: a City 12 takes 56 air travellers with luggage instead of 90 commuters.

**Known gaps:**
- The city's own buses and minibuses (İETT, dolmuş) are not modelled. Long trips far from a station fall to cars, taxis and, for students, bikes (İstanbul Üniversitesi shows 23% by bike).
- The map's Sirkeci rail station sits on the old surface line, so Marmaray does not link Sirkeci and Yenikapı. One rail link (Ayrılık Çeşmesi to Cerrahpaşa, 11.5 km) is probably a track-joining artefact. Cable cars have no track on the map and are switched off; only one funicular (F1) is linked.
- Weather, events and service plans come in phases 4 and 5. Stadiums are quiet until match days exist.
- Your passengers cannot change between your buses and the city's transit yet (phase 7).


## Phase 4. Weather 🟡

Built and tested. 🟡 until the owner has played it: each day has its own weather from the city's climate, a forecast at 18:00, and rain or snow changes how people travel and how fast buses run.

| Item | Status | Evidence |
|---|---|---|
| Climate data baked at build time (`scripts/data/build-climate.mjs` → `src/data/climate.json`, 152 KB): monthly statistics (wet days, wet-day persistence, heavy-rain share, mean rain, snow days, daily high and low with their spread, hot and cold days, day-to-day persistence of the high) for the five presets at their centres and 204 cities for searched places, 1995–2024. Source: **NASA POWER** daily data (CC BY 4.0, "no restrictions on use"); never fetched at runtime | ✅ | `climate-data.test.ts` (3 tests); `weather.test.ts` "climate data and the game year" |
| The game year follows the climate year: autumn week 1 is early September north of the equator and early March south of it; months are never shown | ✅ | `weather.test.ts`: İstanbul's winter weeks are wetter and over 8 °C colder than its summer weeks; Sydney's autumn is warmer than its winter |
| Generator (`weather.ts`): a wet/dry Markov chain from the month's statistics; heavy rain and snow in their shares, snow only on the coldest wet days; showers mostly in the afternoon, rain as a front of 4–16 hours; highs and lows with persistent anomalies. Every draw is a hash of (seed, day); today and two days ahead are saved, so a running game is never rewritten | ✅ | `weather.test.ts` (5 tests over 20,000 generated days): wet share, persistence, heavy and snow shares, mean, spread and persistence of the high, afternoon showers, purity |
| Forecast at 18:00 for tomorrow: right in about 82% of days, otherwise a near miss (showers for rain); temperatures within a couple of degrees; chance of rain shown. Warnings for heavy rain and snow, and a notice for heat (32 °C and above) | ✅ | `weather.test.ts`: accuracy between 79% and 86%, misses only to neighbouring kinds; forecast issued at 18:00; screenshot `weather-warning.png` (a real forecast on day 40) |
| Effects per hour (`activity/conditions.ts`, settings in `params.ts` `WEATHER`): walking and cycling put people off more in rain (cycling more than walking), waiting less than walking (stops have shelters), taxis harder to find, outings cancelled (leisure, nights out, sightseeing, some shopping; snow cancels some work trips rather than sending them to buses), parks and beaches empty and malls fill, heat fills beaches and empties parks at midday, pleasant days bring people out | ✅ | `weather.test.ts` "rain against clear weather" (4 tests, plan section 17): walking and cycling shares fall; your share rises on walkable trips of 1–3 km; park and sight areas lose more trips than the city; buses run later and at least one traveller type rides less |
| Roads slower in bad weather (−8% rain, −18% heavy rain, −30% snow) for moving buses and their arrival estimates, not for timetables: buses run late unless the player plans for it | ✅ | `weather.test.ts`: road conditions below 1 only in rain; more lateness per departure over a rainy day |
| No new draws from the shared random stream; reload carries on identically; older saves get weather from the day they are loaded | ✅ | `weather.test.ts` "weather in the game" (3 tests) |
| Top bar: weather chip (icon, temperature now, "Tomorrow: showers" once the forecast is out) and a popover with today's rain by hour, what it does to travel, tomorrow's forecast and its accuracy, yesterday's forecast for today, and the source ("generated from the city's climate, not live weather") | ✅ | screenshots `weather-chip.png`, `weather-popover.png`, `weather-popover-rain.png` |
| Each day's weather (kind, high, low, rain) kept with the day's figures, for comparisons later | ✅ | `weather.test.ts`; `DayStats.wx` |
| Calibration within the limits | ✅ | table below |

Screenshots come from the company simulated for phase 3, played on by `scripts/capture-weather.mjs` until the generated weather gave each case (nothing staged).

**Calibration** (`pnpm calibrate`; the reference week is autumn week 1 in İstanbul: six dry days around 25–30 °C and one rainy day):

| Figure | Now | Baseline | Change | Limit |
|---|---|---|---|---|
| Reference riders, weekday | 3,467 | 3,611 | −4.0% | ±10% |
| Reference riders, weekend | 2,889 | 3,076 | −6.1% | ±15% |
| Reference boardings a day | 3,274 | 3,432 | −4.6% | ±10% |
| Reference result a day | 3,747 | 4,032 | −7.1% | ±20% |
| Reference satisfaction | 0.74 | 0.77 | | above 0.6 |
| Thin line result, day 2 | −2,112 | −2,190 | | below 0 |
| Crowded line peak load | 0.97 | 0.97 | | above 0.8 |

**Changes from the plan, and why:**
- **Climate source: NASA POWER instead of ERA5** (owner's decision, 2026-10-30). ERA5 needs a Copernicus account and key. NOAA GHCN-Daily was built first and rejected: NCEI's documentation says that for non-US locations "the data or any derived product shall not be provided to other users or be used for the re-export of commercial services" (WMO Resolution 40). Nothing derived from it ships.
- **"Your share up on short trips"** holds on walkable trips of 1–3 km (in a day of steady rain: 4.5% → 4.6% at 1–2 km, 11.1% → 11.9% at 2–3 km). Under 1 km people still walk, because the walk to the stop is nearly as long. The test checks the 1–3 km band.
- **Rain weighs on cycling more than on walking**, and on walking more than on waiting. The first settings made cycling rise in rain (walking lost more); in a day of steady rain cycling now falls 21% (published: 8–25% of cyclists deterred) and walking 5%.
- **Road conditions are a speed factor on moving buses**, not a rise in the congestion figure: the effect the plan asks for (buses late against typical-traffic timetables) without changing the traffic overlay.
- **The day's weather is saved with its figures now** (part of phase 6's day labels), so rainy and dry days can be compared once phase 6 shows them.

**Effect on play (measured on the reference company, a day of steady rain against a dry day):** about 5% fewer trips in the city, walking −5%, cycling −21%, taxis −3%, the city's transit −7% (walk to the station and the wait). Your buses gain on 1–3 km trips and lose slightly under 1 km; parks and sights lose more than the city as a whole; buses run later. In İstanbul's autumn weeks most days are dry; the winter weeks bring rain on about two days in five.

**Known gaps:**
- NASA POWER is gridded (about 50 km): it has more light-rain days and fewer downpours than a rain gauge. Durham is wet on about half its days against about a third at a station; the heavy-rain share is roughly half a station's. Light rain changes little in the model, so the effect on play is small. North of about 45° the rain is mostly the model's own.
- Weather is the same across the city (no local showers).
- The forecast is for tomorrow only.
- There is no credits screen yet; the climate credit is in the weather popover.
- Network Control's weather markers and the line inspector's rainy-against-dry comparison come in phase 6. Air-conditioned buses are a later option.

## Phase 5. Events 🟡

Built and tested. 🟡 until the owner has played it: matches, concerts, festivals, public gatherings and rail disruptions are scheduled from the map's venues, announced days ahead, and bring crowds that travel there and home again; lines get service plans; automation can react to events, the forecast and the weather.

| Item | Status | Evidence |
|---|---|---|
| Event templates as data (`src/game/events.ts`): arrival and leaving curves, length, local traffic, parking and taxi difficulty, outdoor or not. The schedule is a pure function of (seed, venue, day), generated ten days ahead and saved; no draws from the shared random stream | ✅ | `events.test.ts` "the schedule" (3 tests): the same for the same seed over 168 days, venues and seats respected, generated ten days ahead, no shared draws |
| Kinds: **football** (grounds of 800+ seats; big grounds at home every other week, smaller ones weekly; not in summer; 8% go to extra time), **concerts** (halls of 1,000+ seats, up to two a week, fewer in summer; summer concerts in stadiums of 20,000+), **festivals** (one of the three largest parks, about two weekends a year), **public gatherings** (public holidays, the festive Sunday, and rare short-notice ones with a reason), **rail disruptions** (1–3 links of the metro, train or tram network for 1–4 hours, about one day in twelve) and **flight disruptions** (only where an airport is on the map). In İstanbul's 84-day year: 54 concerts at 5 venues, 19 matches at 3 grounds, 8 gatherings, 1 three-day festival, 4 rail disruptions, no flight disruptions | ✅ | `events.test.ts`; counts measured on the bundled İstanbul map |
| Announcements 3–10 days ahead at 09:00 (short-notice gatherings the day before, disruptions when they begin), with a notification that opens the venue | ✅ | `events.test.ts` "is generated ten days ahead, saved, and announced with a notice"; screenshots `event-announced.png`, `event-place-card.png` |
| Crowd travel: a new traveller type, from homes across the map (half; distance decay 9 km), through stations and piers (a quarter), the rest from beyond the map. To the venue's stops within 800 m, with parking and taxis penalised near it; home again on linked returns timed by the end and the leaving curve | ✅ | `events.test.ts` "a match day at the stadium" (plan section 17, stadium). Measured on a line to Tüpraş Stadyumu, 30,000 at the match: 97% of the bus trips there start in the three hours before kick-off; 73% of those who came by bus have their ride home within 45 minutes of the end; returns never exceed arrivals; the stadium stop's 21:00–24:00 boardings are 199 against 40 on an ordinary evening; the line's day is 8% busier |
| Roads near the venue slower as crowds arrive and leave (through the traffic model's local additions), not elsewhere and not in timetables | ✅ | `events.test.ts` "slows roads near the stadium…" |
| No event money: only the fares of attendees who board | ✅ | `events.test.ts` "charges only the fares…" (ledger audit, plan section 17 economy) |
| Rail disruption closes its stretch of the background transit network; journeys through it look for other ways, and your line gains riders where it runs | ✅ | `events.test.ts` "a rail disruption closes its stretch…" (Taksim–Şişhane metro) |
| Flight disruption: arrivals held back and then bunched | 🟡 | Built; not reachable in İstanbul (both airports are beyond the bundled map), so no test of its own yet |
| Outdoor events called off when heavy rain or snow is forecast; indoor ones go ahead | ✅ | `events.test.ts` "outdoor events are called off…" |
| Place card **Events** section (on now, coming, called off, and past events with "N journeys on your buses" and how many gave up or were stranded); a flag on the venue's map marker ("On now", "Today 19:30", "Tomorrow 20:00", the weekday) | ✅ | screenshots `event-place-card.png`, `event-on-now.png`, `event-after.png` |
| **Service plans** on a line's timetable (up to 8): for a season, school holidays, university breaks, public holidays, event days near the line, or switched by hand or by automation; the first that applies wins; trips already run are kept | ✅ | `service-plans.test.ts` (8 tests); `events.test.ts` "a match-day service plan…" (applies on match day only, and only once the match is announced); screenshot `timetable-service-plans.png` |
| Objectives: **Match day** (1,000 journeys for one event, few giving up), **Night network** (250 trips between midnight and 05:00), **Airport link** (300 air travellers in a day; offered only where an airport is on the map) | ✅ | `events.test.ts` "objectives for events, nights and airports" (3 tests) |
| **Automation** (owner's request, brought forward from phase 6): triggers *Tomorrow's forecast*, *The weather changes*, *An event is announced*, *Before an event starts*, *When an event ends*, *A kind of day*; data nodes *Weather*, *Calendar*, *Events*; action *Switch a service plan* (a big change, so it needs permission); ready-made workflows *Extra buses for big events*, *Rain plan when a storm is forecast*, *Extra bus when heavy rain starts*, *Cover a rail disruption*, *Events in the next three days*. All act through the normal command layer | ✅ | `automation-city.test.ts` (7 tests); `docs/automation-api.md` (reference regenerated); screenshots `automation-city-templates.png`, `automation-event-flow.png`, `automation-storm-flow.png` |
| Determinism: two runs through a match day are identical; a reload during the match carries on the same (no duplicated events) | ✅ | `events.test.ts` "determinism"; `automation-city.test.ts` reload check |
| Calibration within the limits | ✅ | table below |

Screenshots come from a company simulated for a month by `scripts/capture-network.mjs sim`, played on by `scripts/capture-events.mjs` until the generated calendar announced an event (nothing staged). That company has no stop near the concert hall, so its card honestly shows 0 journeys on your buses; the stadium test line above shows a served match.

**Calibration** (`CALIBRATE=check pnpm calibrate`; events on):

| Figure | Now | Baseline | Change | Limit |
|---|---|---|---|---|
| Reference riders, weekday | 3,469 | 3,611 | −3.9% | ±10% |
| Reference riders, weekend | 2,897 | 3,076 | −5.8% | ±15% |
| Reference boardings a day | 3,278 | 3,432 | −4.5% | ±10% |
| Reference result a day | 3,755 | 4,032 | −6.9% | ±20% |
| Reference satisfaction | 0.74 | 0.77 | | above 0.6 |
| Thin line result, day 2 | −2,110 | −2,190 | | below 0 |
| Crowded line peak load | 0.97 | 0.97 | | above 0.8 |

Events add a handful of riders to the reference week (weekday 3,467 → 3,469, weekend 2,889 → 2,897): its line does not pass a venue.

**Changes from the plan, and why:**
- **Automation for events and the weather came in this phase**, at the owner's request; the plan had it in phase 6. The `applyServicePlan` of the plan is the *Switch a service plan* action (the `service_plan` command). Phase 6 keeps the rest: Network Control groupings, weekly roll-ups, panel additions and MCP tools.
- **Festivals are a city-wide draw** (a weekly chance of 25% in spring and 35% in summer, about two weekends a year, in one of the three largest parks), not a per-park rate: per-park rates gave 27 festival days a year, many in small courtyards.
- **Event-day plans wait for the announcement**, so a timetable never gives an event away before its notice.
- **A trigger's "Lines nearby" output stops the branch when no line is near** (like "First item" with an empty list), so a workflow is not switched off for failed runs at venues the company does not serve.

**Known gaps:**
- The estimate (Network Control's estimated demand and the place card's hourly pattern) does not include event trips yet.
- Visitors arriving through stations and piers walk from the gateway; they do not ride the background transit network to the venue.
- Flight disruptions need an airport on the map: none in İstanbul, so Airport link is not offered there.
- Football fixtures name no opponents (by design, plan section 9.3).
- ~~Event days are not yet labelled in Network Control's day records or compared in the line inspector~~: done in phase 6.

## Phase 6. Network Control and automation 🟡

Built and tested. 🟡 until the owner has played it: every recorded day now keeps its season, kind of day, weather and events, so Network Control can filter, group and compare by them; weeks roll up for three game years; the line inspector compares rainy and dry days and shows event riders; automation gains a demand forecast, places and unserved trips.

| Item | Status | Evidence |
|---|---|---|
| **Day labels** on each recorded day (and its 120-day summary): game year, season, week, weekend, public holiday, school day or holidays, university term, festive day, the day's weather (kind, rain in mm, high and low), and the events that started that day and touched your network, with their final results (crowds go home after midnight, so the label is brought up to date the next day). Flags are stored only when true; a day record grows by under 30% with everything the activity engine added | ✅ | `day-labels.test.ts` (7 tests): labels match the calendar and the weather row; event results updated after midnight; record size |
| **Weekly roll-ups**: per game week, each line's boardings, fares and boardings by traveller type; the network's journeys, gave-ups, satisfaction and fares; journeys on dry, wet and stormy days. Kept for 36 weeks (three game years) | ✅ | `day-labels.test.ts` "weeks roll up whole game weeks" (sums checked against the day records) |
| **New groupings and filters** in the query layer (Network Control, `data.analytics`, MCP): group by weather, kind of day, event day or traveller type; filter days by weather, kind of day or event day. Days recorded before labels were kept are left out of a filtered query and counted in its coverage, with a note | ✅ | `day-labels.test.ts`: groupings split the network's totals exactly; weather filters add up to the whole; boardings by type add up band by band to the line's day |
| **"Days" filter** in every Network Control tab: grouped options for days of the week, kind of day (working days in term, school holidays, public holidays), weather (dry, showers or rain, heavy rain or snow) and event days. The coverage line says how many days match ("5 matching days of 7") | ✅ | screenshot `nc-filter-rain.png` |
| **Weather and event marks** on the Overview's daily trend: a ring for showers or rain, a filled dot for heavy rain or snow, a triangle for an event your buses carried a crowd to; pointing at a mark gives the day's weather or event results | ✅ | screenshot `nc-trend-marks.png` |
| **Journeys by traveller type**: a *Who travels* table (journeys, share, boardings, left behind by type) and a *Who* filter on the journeys table and map. Who gave up is not kept by type, so it shows a dash with that reason | ✅ | `day-labels.test.ts` (one type's journeys between stops add up to its total); screenshots `nc-who-travels.png`, `nc-journeys-by-type.png` |
| **A line's riders by type and time of day** (Lines tab, under the selected line): boardings by traveller type in each of the five time bands | ✅ | screenshot `nc-line-types.png` |
| **Seasons and weather** report (Reports tab): the same season year on year from the weekly roll-ups (it says what is missing until a season has been played twice), and the last 35 days by weather and by kind of day, per day | ✅ | screenshot `nc-seasons.png` |
| Line inspector **Weather** section: riders a day, trips on time and average delay on rainy against dry days of the same kind (working days, or weekends), once there are two of each in the last 35 days; until then it says how many more are needed. **Events** section: event riders on the line in the last 35 days, by day, with the events | ✅ | screenshot `line-weather-events.png` (in that company rain barely changes Line 1's riders: 200 dry, 201 rain) |
| **MCP tools** `places`, `weather_calendar`, `events`, `line_character` (read-only, from the save) | ✅ | `mcp/server.test.ts` (8 tests); README tool table |
| Automation **Demand forecast**: expected boardings per line for each of the next 1, 3 or 6 hours (not past midnight), from the model's hourly rates for the lines running then, today's weather (which the player sees hour by hour), announced events only, people already out who are due home and the expected returns of trips starting in the window; with timetabled departures and boardings per departure. Labelled an estimate. Never changes the simulation | ✅ | `automation-forecast.test.ts` (8 tests): within a third of what follows, line by line, over a weekday's 09:00–12:00 (measured figures below); identical simulation with and without forecasts, through a rail closure; an unannounced match is not counted, an announced one is; stops at midnight |
| Automation **Places**: places of a kind (airport, station, hospital, university, stadium…), largest first, with your nearest stop, the lines within 400 m, and the model's trips today and busyness this hour; a *Lines at the largest* output that stops the branch when no line stops there | ✅ | `automation-forecast.test.ts` "lists places of a kind…" |
| Automation **Unserved trips**: the busiest connections between two of your areas that no line links (the model's trips a day, every mode and purpose), and whether a stop or a line is missing | ✅ | `automation-forecast.test.ts`; capture run: "Busiest: Laleli → Mahmutpaşa, about 43,853 a day; missing a stop" |
| Ready-made workflows: **School holidays check** (on the first holiday day, how many lines run their term-time timetable), **Early-morning airport boost** (an extra departure at 05:15 on lines at the largest airport; suggest mode), **Busy hour ahead** (hourly from 06:00, warns of lines expecting more than 50 boardings per departure next hour), **Unserved corridors report** (weekdays at 06:00). Line records gain `plan`, `plans` and `holidayPlan` | ✅ | `automation-forecast.test.ts` (templates validate; the school-holidays check counts the right lines; the airport boost does nothing where no line stops at the airport); screenshots `automation-insight-templates.png`, `automation-forecast-flow.png` |
| Report text groups thousands in large whole numbers ("30,000"), not in fleet or day numbers | ✅ | `automation-city.test.ts` |
| Calibration unchanged (phase 6 reads; it does not change the simulation) | ✅ | same figures as phase 5 |

Screenshots come from the company simulated by `scripts/capture-network.mjs sim`, played on 16 days by `scripts/capture-insights.mjs` until it had labelled rainy and dry working days (10 of 10 checks pass; nothing staged). That company's lines pass no venue, so it has no event days and its Events sections show the empty state.

**How close the demand forecast comes** (two lines on the İstanbul test map, forecast then played; boardings per line):

| Forecast made at | Window | Line 1 | Line 2 |
|---|---|---|---|
| Weekday 09:00 | 09–15 | 220 vs 254 (−13%) | 201 vs 221 (−9%) |
| Weekday 15:15 | 15–21 | 214 vs 191 (+12%) | 211 vs 188 (+12%) |
| Saturday 09:00 | 09–15 | 277 vs 284 (−2%) | 251 vs 248 (+1%) |
| Weekday 06:30 | 06–12 | 251 vs 171 (+47%) | 207 vs 159 (+30%) |

The early-morning forecast runs high because the model rates lines by their punctuality so far that day, and at 06:30 nothing has run late yet; once the morning's lateness is known, riders choose other ways and the forecast follows.

**Changes from the plan, and why:**
- **"Columns by type and time band" in Lines** became a table under the selected line (traveller types × the five bands): ten types × five bands as columns in the lines table would not fit the panel.
- **A dedicated airport filter in Passengers** was not added: Estimated demand by *Places* and the airport's place card (phase 3) already show travel to and from it, and on the İstanbul map both airports are beyond the edge.
- **The school-holiday timetable template checks rather than switches**: service plans for school holidays (phase 5) already switch by themselves, so the workflow tells you which lines lack one.
- **Two blocks beyond the plan**: *Unserved trips* (needed by the unserved-corridors template) and a fourth template, *Busy hour ahead*, so the demand forecast has a ready-made use.

**Known gaps:**
- Who gave up is kept per day and pair, not by traveller type.
- Year-on-year comparisons need a season played twice (a game year is 12 weeks).
- The forecast does not yet carry tomorrow (it stops at midnight) and does not foresee the day's lateness.

**Tests:** the full suite ran with 230 passed, 4 skipped and 4 timing tests failed while the game app was using the machine (the hourly-choice test took 67 ms against its 30 ms limit, and 74 ms on the phase 5 commit at the same time, so not a regression). Re-run one file at a time on a quiet machine, all four pass (activity 10/10, perf 1/1, network-control 21/21, progression 2/2). The files touched by the last fixes were re-run afterwards (automation, automation-city, automation-forecast, day-labels: 44 passed). Build OK.

## Phase 7. Depth and balancing ⬜
