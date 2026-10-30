# City Activity Engine: revised plan

Status: **approved plan, being implemented.** Phases 0 to 4 are built (0 to 2 done; 3 and 4 await the owner's play-test); progress, evidence and the changes made during implementation are in [`city-activity-engine-progress.md`](city-activity-engine-progress.md). Written 2026-10-30. The owner's decisions are recorded at the end. It revises the place, weather, calendar and event proposal from the same day, and keeps the research in [`passenger-choice-research.md`](passenger-choice-research.md). That research still supplies the time weights, crowding multipliers and transfer penalties used here.

Labels used in this document:
- **Confirmed**: read in the code or decoded from map data, with the file and line.
- **Proposal**: design in this plan.
- **Assumption**: a value or behaviour not yet verified. Game-setting values are marked as game settings, never as measured data.

---

## 1. Executive summary

Today the game estimates trips between the **bus stops the player has built**. A new stop next to a stadium creates demand, and nobody has a reason to travel beyond "there is activity near that stop". This plan replaces that with a **City Activity Engine**. It decides why people travel, from where, to where, when, and how. Your network is one of the options they weigh.

The main changes:

1. **Demand lives between places and neighbourhoods, not between stops.** Stops only give access. A stop near a stadium does not create match-day crowds. It gives the crowd that already exists a way to reach the stadium.
2. **A unified Place Registry** comes from map data the game already downloads (OpenFreeMap tiles in the OpenMapTiles schema).
   - Airports come from the tiles' airport layer, which the game ignores today. A single extra coarse tile per city finds airports beyond the map.
   - Train, metro and tram stations are merged into one place per station, and ranked by the rail lines that pass through them.
   - Small bundled open datasets add scale: OurAirports (public domain), plus an optional Wikidata extract (CC0) for the preset cities.
   - No paid services are needed.
3. **People make complete journeys within a budget.**
   - Residents, workers, students, visitors and air travellers come from a population and activity budget.
   - Home-based trips are round trips. People who rode your bus out come back on it, and people who never got home are counted.
   - Ten traveller types weigh price, waiting, changes, walking, reliability and space differently.
4. **Travel choice uses the real alternatives:**
   - walking;
   - cycling;
   - a car or taxi;
   - the city's existing rail, metro, tram and ferry network (its lines are in the tiles);
   - your network;
   - for optional trips, staying home.
5. **A game calendar, seeded weather and events.**
   - A game year of seasons and weeks, with **no real dates, months or years** (the game has no calendar today).
   - Weather generated from the seed for each city's climate, with a forecast a day ahead.
   - Generated events at real venues, announced in advance, with crowds that travel there and back.
   - All of it is reproducible from the save.
6. **Line character emerges from recorded journeys.**
   - Riders carry their type and purpose, so analytics can say who rides a line, when and why.
   - This shows in the existing line inspector, a new place card and Network Control. Automation can read the same data.
7. **Eight phases (0–7), each leaving the game playable and balanced** within agreed limits. The save goes to version 3.

**What the player should notice:**
- An airport line is busy from early morning to late evening and fills up faster because of luggage.
- University lines go quiet in summer.
- A stadium is silent until match day, when thousands try to leave within half an hour.
- Rain moves cyclists onto buses and slows the roads, while parks empty.
- A bus that runs alongside the metro struggles.
- Cutting service to a hospital hurts the staff and patients who have no car. They keep riding, but they wait longer and get unhappier.

---

## 2. What the existing proposal got right

These parts stay:
- **The place categories:** airports, hospitals, universities, schools, stadiums, shopping, nightlife, hotels and industry. Train stations are added at the owner's request.
- **Weather with a forecast a day ahead**, so the player can plan.
- **A calendar** with school holidays, university terms and a tourist season.
- **Events** with a surge of crowds.
- **Line character that follows from the places served**, not from labels.
- **From `passenger-choice-research.md`:**
  - segments (captive and choice riders);
  - several alternatives in place of bus-or-walk;
  - a crowding curve in place of a flat penalty;
  - explaining why people skip your bus;
  - seeded determinism;
  - published values: wait 1.5–1.8×, transfer penalty 13–18 min, crowding 1.15–1.7×.
- **Groups of passengers, not individual people.** The simulation already moves aggregated groups with real origins and destinations, and that stays.

## 3. What is currently oversimplified

| Problem | Why it matters |
|---|---|
| Demand is defined between served stops (Confirmed, `passengers.ts:127-131`, `:202-215`). | Adding a stop creates or redistributes demand, so a line can get passengers just by being near something. Unserved demand cannot be shown properly. |
| The proposal gave places daily curves as multipliers. | The curves change *when* trips happen, not *why* or *between which places*. Directional flows, return trips and conservation stay unexplained. |
| Return trips are not linked to outbound trips (Confirmed, `passengers.ts:260`). | The reverse flow is a mirror of the outbound estimate shaped by an evening curve. Someone who rode out never has to get home, and a missing last bus costs nothing. |
| Points of interest are counted several times (Confirmed, `regionBuilder.ts:346-353`). | A hospital adds its building floor area, its point's jobs and its "other" trips, and 100 restaurants each add jobs on top of their buildings. More POIs mean more trips with no limit. |
| Airports were assumed to be on the map. | Airports are in the tiles, but **no preset starting map contains one** (table below). They are an expansion goal, not a feature that exists from day one. |
| Weather mainly "moves walkers onto buses". | Rain also slows roads (so buses run late), cancels outdoor trips and moves leisure from parks to malls. Rain does not simply raise bus demand. |
| A calendar was assumed. | The game has no date at all: just seconds since the start, and Monday as day 0 (Confirmed, `types.ts:328`, `session.ts:259`). |
| Events had no operational tools. | Timetables only have weekday and weekend plans (Confirmed, `types.ts:46-62`). There is no event-day or holiday timetable to switch to. |
| Line character needed data that is not recorded. | Passenger groups carry no purpose or type (Confirmed, `types.ts:183-210`). Network Control's "estimated demand" is the raw gravity estimate, not what people would choose (Confirmed, `analytics/query.ts:676-703`). |
| Bus share is capped at 0.6 × a reputation factor (Confirmed, `passengers.ts:244-276`). | The cap is a ceiling with no mechanism behind it. Trips that do not take the bus are discarded and never counted. |

How far the nearest airport is from each preset city centre (measured; one map square is one z14 tile; preset maps are 5–6 squares across):

| City | Square size | Nearest airports (distance from centre) | Roughly how far past the starting map edge |
|---|---|---|---|
| İstanbul (Beyoğlu & Fatih) | 1.85 km | IST 33.5 km, SAW 31.3 km | ~15 squares |
| Durham | 1.41 km | NCL 30.2 km, MME 31.0 km | ~18 squares |
| Barcelona (Eixample) | 1.84 km | BCN 12.7 km | ~4 squares |
| Hamburg (Altstadt) | 1.45 km | HAM 9.1 km | ~3 squares |
| Tokyo (Shibuya) | 1.99 km | HND 14.2 km | ~4 squares |

---

## 4. Findings from the actual codebase (Confirmed)

### Map data

| Finding | Where | Consequence |
|---|---|---|
| Tiles come from OpenFreeMap (`planet`) in the OpenMapTiles schema; the version URL is resolved each session. | `src/geo/tiles.ts:6`, `src/map/tileSource.ts:7-15` | Free and already licensed and attributed (ODbL). The planet version drifts, and saves do not pin it. `RegionSpec.tileTemplate` is declared but unused (`world/region.ts:19`). |
| The region is built from **z14 tiles only**. İstanbul's 30 tiles are bundled for offline play; other cities need a network on first load, then use the cache. | `regionBuilder.ts:11`, `zoneTiles.ts:7`, `src/app/regionWorker.ts:29-48` | The registry must work from z14 data plus small cached extras. |
| Layers read: `transportation`, `transportation_name`, `poi`, `place`, `landuse`, `building`. Ignored: `aerodrome_label`, `aeroway`, `park`, `water`, `landcover`, `housenumber`, `mountain_peak`. | `regionBuilder.ts:151-304` | Airports, beaches and waterfronts are all available but unused. |
| **Airports at z14 (decoded today):** `aerodrome_label` has `name`, `iata`, `icao`, `ele` and `class`. BCN reads `class: other` and HAM `class: international`, so **class is not a reliable size signal**. `aeroway` has runways, taxiways and aprons, but no terminal class. | live tiles 8286/6125 and 8646/5289 | Size comes from IATA presence, OurAirports type and passenger figures. The landside entrance has to be inferred. |
| **Airports at z8:** one z8 tile (110–150 KB) lists IST and SAW for İstanbul, and NCL for Durham. | live tiles z8 148/95 and 126/80 | Finding airports beyond the map costs one small tile per city. |
| **Rail, metro, tram and ferry lines are in the tiles.** The bundled İstanbul tiles have `transit/subway` (mostly tunnels), `transit/tram`, `rail/rail`, a funicular, a monorail, and **17 named ferry routes** (for example "Kadıköy - Karaköy", "Eminönü - Üsküdar"). | bundled `public/tiles/14`, decoded today | The existing transit network can be built from geometry and become a real competitor. There are no timetables, so service levels would be game settings. |
| `building` has only `render_height`, `render_min_height`, `colour` and `hide_3d`: no type or name. `poi` features are points with `name`, `class`, `subclass`, `rank`, `level`, `layer` and `indoor`, but **no capacity, beds or opening hours**. Every feature has a stable tile feature id. | decoded test tiles | Scale has to come from footprints, floor area or bundled datasets. Opening hours come from category rules. |
| Places today: 17 `PoiKind`s, of which only `notable` named POIs are kept. `Poi.id` is an array index. Duplicates are removed only on an exact `class|name|position` key. | `world/region.ts:22-33`, `regionBuilder.ts:207-218` | There are no stable place ids, and the same hospital can appear as a point, a land-use polygon and buildings. |
| `geo.poisNear` is a linear scan over all POIs. | `world/geo.ts:119-127` | A registry needs a spatial index. |
| Demand grid: 150 m cells. Residents and jobs come from building floor area by land-use mix, and **every** classified POI adds its jobs and attraction to its cell on top. | `regionBuilder.ts:312-355` | This is the double counting to fix (section 6.4). |
| The region (graph, grid, POIs) is **not saved**. It is rebuilt from tiles on load, and a changed planet triggers a resnap. | `engine.ts:89`, `engine.ts:162`, `src/app/session.ts:129-175` | Anything place-based is deterministic only for the same tiles. Events must save a snapshot of their venue. |
| Five presets (İstanbul, Durham, Barcelona, Hamburg, Tokyo), plus any searched place. There is no timezone, climate, hemisphere or language data. | `src/app/presets.ts:25-97` | Climate and calendar data are new, and needed for any location. |

### Simulation

| Finding | Where | Consequence |
|---|---|---|
| A production-constrained gravity model between **served stops**, with 5 purposes. Destination competition `den` runs over all region cells. Return flows mirror the reverse pair. | `passengers.ts:146-215`, `:260` | Replaced by zone and place demand (section 7). The hourly shape helper `shape()` and the per-purpose curves are reused as building blocks. |
| Demand is refreshed once per game hour, or whenever the network changes (`dirty`), and only from saved state and the hour slot. | `engine.ts:196`, `engine.ts:257-270` | The new engine follows the same rule, which is what keeps reloads identical. |
| Itineraries: direct or one change **at the same stop**, from scheduled typical-traffic run times. There is no walking change between nearby stops. | `passengers.ts:289-370`, `timetable.ts:77-90` | Reused as the bus part of travel choice. Walking changes are needed later for multimodal trips. |
| Choice is a binary logit, scale 5.5 min. The car alternative is `9 + d/330 + traffic·d/450`. The bus share is capped by `smax` from reputation, and non-bus trips are discarded. | `passengers.ts:244-276` | Replaced by multinomial choice (section 7.5). The cap is removed only after calibration. |
| Passengers are generated by **deterministic fractional accumulation** per stop pair (`state.pax.acc["o>d"]`), with no random numbers. | `passengers.ts:409-433` | Kept, with a traveller type added to the key. |
| `PaxGroup` has `n, o, d, legs, leg, alt, t0, tl, w, r, cr, dl, fr, lb`: no purpose, type, return link or luggage. Groups merge within 6-minute buckets. | `types.ts:183-210`, `passengers.ts:376-386` | It gains a traveller type, a purpose and a trip link. |
| Boarding uses one capacity number; seat counts exist in the bus models but are unused. Dwell is `10 + max(board·2.4/doors, alight·1.5/doors)`, ×1.3 above 80% load. Patience is `clamp(1.3·headway + 8, 20, 70)` min. | `passengers.ts:523-600`, `vehicles.ts:437-443`, `passengers.ts:436-463` | Luggage changes the space per passenger and the boarding seconds. Patience comes to vary by type. |
| The fare is charged once, at first boarding, to the first line. It accrues hourly into the ledger. | `passengers.ts:579-584`, `finance.ts:67-89` | Unchanged. New demand never credits money directly. |
| Satisfaction is a weighted score for waiting, journey time, crowding, reliability and price, minus transfers; a trip that was given up scores 0.04. Reputation drifts toward satisfaction at 03:00. | `progress.ts:73-91`, `progress.ts:221-255` | Kept. Passengers left stranded on the way home are added. |
| Random numbers: mulberry32 with its state saved. Only breakdowns draw from it. Traffic noise uses a stateless hash. | `engine.ts:324-330`, `vehicles.ts:671`, `world/traffic.ts` | Weather and events use stateless hashes and never draw from the shared stream. |
| Traffic is simulated, behind a `TrafficProvider` interface. City intensity is fixed in the constructor, and there is no weather or local modifier. `typical()` feeds timetables; `congestion()` drives live buses and ETAs. | `world/traffic.ts:11-24`, `:87-138`, `vehicles.ts:415`, `eta.ts:51` | Add a conditions modifier to live congestion only, so buses run late in bad weather unless the player plans for it. |
| Save version 2. `upgradeState` fills missing fields with `??=`, then sets the version. | `types.ts:13`, `game/upgrade.ts`, `src/app/session.ts:83-94` | Version 3 follows the same pattern. `meta.created` exists (`types.ts:325`) for back-dating old saves. |

### Analytics, interface and automation

| Finding | Where | Consequence |
|---|---|---|
| Analytics record from day one: per stop, line and bus by hour; origin–destination by stop pair, itinerary and five time bands. Direction is recorded only for loads and run times. Retention is 35 detailed days and 120 summaries. | `analytics/record.ts`, `analytics/types.ts:16-18`, `:57`, `:160-177` | A traveller-type dimension is cheap (section 12). Comparing a season across game years needs weekly roll-ups. |
| The query layer (`GroupBy` network, line, stop, vehicle, zone, day, hour, weekday) is shared by the panels and automation (`data.analytics`). | `analytics/query.ts:18`, `automation/registry.ts:360-378` | New measures appear in tables, custom metrics and automation automatically. |
| The Network Control lock is UI-only; recording is not gated. | `ui/network/NetworkControl.tsx:29,35`, `ui/ToolRail.tsx:36,74-75` | Data is collected from day one; the advanced views stay locked. |
| The line inspector shows Riders 24 h, On time, Avg load, today's money, timetable, buses and stops. It has no charts or direction split, and reads `state.stats`, not analytics. | `ui/Inspector.tsx:287-437` | The line-character sections are new, built with existing parts (`LineChart`, `ui/network/common.tsx:349-381`). |
| The stop inspector has a "Nearby:" text line with the top 3 POIs. | `ui/Inspector.tsx:458-519` | It becomes links to place cards. |
| Destination markers are DOM markers (at most 28), with a title but **no click handler**. Selection is `vehicle|line|stop|depot|zone`. | `map/markers.ts:92-114`, `state/store.ts:6-12`, `ui/Inspector.tsx:50-62` | A place card needs `{kind:'place'}` in the selection, a click handler and a new inspector case. The card shell is reused. |
| The top bar shows `weekday · Day N` and speed in `.time-readout`. Notifications have tones and an optional ref to a vehicle, route, stop, depot or zone. | `ui/TopBar.tsx:167-217`, `types.ts:313`, `progress.ts:209` | Room for the season and week, and a weather chip. New ref kinds are needed for place and event. |
| Automation has 11 triggers and 10 data nodes. Simulation events are queued in the save (`QUEUE_MAX` 300) and matched to trigger sources each minute. | `automation/registry.ts:94-378`, `automation/events.ts`, `automation/executor.ts:546-590` | Event, forecast and calendar triggers plug into the existing queue. |
| The MCP server is read-only on save files and does not expose analytics. | `mcp/server.ts:105-129`, `mcp/data.ts` | New datasets are reachable through `query_save` once saved. Dedicated tools are optional. |
| Tests that pin ridership: the reference line (>1,500 riders/day; about 3,000 in `docs/economy.md`), automation scenario 3 (peak load above 80% with small buses), the 40-day progression bot, the perf budget (<120 ms CPU per real second at 720×; measured about 12 ms). | `test/balance.test.ts`, `test/automation.test.ts:97-105`, `test/progression.test.ts`, `test/perf.test.ts` | These are the calibration guard rails (section 11). |

---

## 5. Proposed City Activity Engine architecture

```
 Tiles (z14 region, one z8 tile per city)      bundled open data (OurAirports, climate, calendar rules)
                 │                                              │
                 ▼                                              ▼
  [1] Place Registry          world/places.ts       built with the region, in the region worker
      places · activity zones · stations and the transit network · activity budget
                 │
  [2] Activity model           activity/generators.ts, tours.ts
      who travels, why, from where to where, at what time  ◄── calendar · weather · events
      (daily trip tables by traveller type, zone to zone)       activity/calendar.ts, weather.ts, events.ts
                 │
  [3] Travel choice            activity/choice.ts   every game hour, or when the network changes
      walk · bike · car/taxi · existing transit · your network · stay home
      the "your network" leg reuses computeItineraries (passengers.ts)
                 │ demand on your network per stop pair and traveller type
  [4] Passenger simulation     passengers.ts (existing)
      groups now carry a type, a purpose and a trip link; boarding, changes and fares unchanged
                 │
  [5] Analytics                analytics/record.ts, query.ts (existing, new dimensions)
      → line inspector · place card · Network Control · automation · MCP
```

Principles:
- **Mode-neutral demand.** Trips are between zones and places. "Your network" is an abstract service graph built from route patterns (`engine.ts:390-408`). Buses are the only service type today; trams, ferries and metro add service types, not a new demand model.
- **Conservation.** People and activity capacity limit trips. Places claim activity; they do not add to it.
- **Choice responds to service.** Waits, times, changes, crowding, reliability and fares all come from your actual timetable and vehicles.
- **Determinism.** The same saved state, seed and tiles give the same results. No new draws from `game.random()`.
- **Simulation separate from the interface.** The engine lives in `src/game/activity/` and `src/game/world/places.ts`. The interface only reads.

---

## 6. Geographic data ingestion and the Place Registry

### 6.1 Sources

| Source | What it gives | Licence and cost | Use |
|---|---|---|---|
| z14 tiles: `poi`, `landuse`, `building`, `transportation` (rail, transit, ferry), `aerodrome_label`, `aeroway`, `landcover` (sand), `water`, `park`, `place` | Names, categories, footprints, floor area, airports, stations, rail lines, beaches, neighbourhood names | ODbL via OpenFreeMap, already attributed; free | Core |
| One z8 tile per city (more if the city is near a tile edge) | Airports within about 100 km | Same; about 150 KB, cached | Airports beyond the map |
| OurAirports subset, bundled | Airport type (large, medium, small), scheduled service, IATA | Public domain (verified on ourairports.com/data). About 4,500 airports with IATA and scheduled service; the size is an estimate | Airport tier |
| Wikidata extract, bundled for the presets; optional cached lookup for searched places | Airport passengers (P3872, with year), stadium capacity (P1083), university students (P2196), station patronage | CC0 (verified) | Measured scale where present |
| Overture Maps Places | More shops and venues, with confidence scores | Mixed per-source licences (CDLA-Permissive 2.0, Apache 2.0, CC0) | **Not used now.** Little gain for these categories and extra attribution work. Revisit for shop coverage. |

The game must remain fully playable with only the tiles. Bundled data improves scale estimates, and each place says where its numbers came from.

### 6.2 Place model (Proposal)

```ts
interface Place {
  id: string;                 // 'osm:<tile feature id>' of the named element; airports 'iata:BCN'
  name: string;
  category: PlaceCategory;    // airport | rail_station | metro_station | tram_stop | ferry_pier | bus_station
                              // | hospital | university | school | stadium | arena | mall | market
                              // | shopping_street | nightlife | hotel_area | attraction | park | beach
                              // | industrial | office | civic | …   (data-driven, extendable)
  anchor: LngLat;             // where people arrive: entrance, landside or concourse, not the centroid
  footprint?: number[][];     // simplified ring when known
  zone: number;               // activity zone index
  scale: { value: number; unit: 'pax_year' | 'seats' | 'students' | 'm2_floor' | 'lines' | 'jobs';
           tier: 1 | 2 | 3 | 4 | 5 };
  capacity: { staff: number; visitorsPerDay: number; seats?: number; residents?: number };
  profile: string;            // activity profile id (section 8)
  calendar: string;           // calendar profile id (section 9.1)
  events?: string[];          // event template ids, e.g. ['football', 'concert']
  modes?: TransitMode[];      // stations: rail | metro | tram | ferry | bus
  sources: PlaceSource[];     // 'tiles:poi' | 'tiles:landuse' | 'tiles:aerodrome' | 'ourairports' | 'wikidata' | 'estimate'
  quality: { location: 'measured' | 'estimated'; scale: 'measured' | 'estimated'; confidence: number };
  reachable: boolean;         // inside the loaded region
}
```

The registry is rebuilt with the region, like everything else built from the tiles. The save keeps a **compact snapshot of significant places**: id, name, category, position and scale, at most about 300 entries and about 30 KB. The snapshot serves three purposes:
- it detects when a newer map version changed the places;
- it is the venue reference for saved events;
- it lets the read-only MCP server list places without tiles.

### 6.3 Extraction and merging

1. **Candidates:**
   - named POIs of the place-worthy classes;
   - land-use polygons (university, college, school, hospital, stadium, music_venue, theme_park, zoo, retail, commercial, industrial, railway, bus_station; all seen in the decoded tiles);
   - airport labels;
   - stations: railway station or halt, subway entrance, tram stop, ferry terminal, bus station;
   - sand next to water, for beaches.
2. **Merge into one place each:**
   - a POI inside a compatible land-use polygon (the polygon gives the footprint and size, the POI gives the name and id);
   - same-name POIs within 250 m;
   - subway entrances into the station with the same name, or the nearest one within 300 m;
   - a metro station and a rail station sharing a name within 300 m become one **interchange** with several modes.
3. **Restaurants, bars and small shops are not places.** They shape each zone's attraction mix. Only a dense cluster becomes a district place: a nightlife district above a bar and late-venue density threshold, or a shopping street. The district is named from the `place` layer's neighbourhood.
4. **Stable ids:** the tile feature id of the named element; IATA or ICAO for airports. These are stable for the same map version; the snapshot handles drift (section 14).
5. **Spatial index:** a uniform grid of about 300 m over places, replacing the linear `poisNear` scan.

### 6.4 Activity accounting, which fixes the double counting

- **The building stock is the budget.** Floor area by land-use mix gives residents and jobs per cell, as today (`regionBuilder.ts:312-341`).
- **Places claim; they do not add.** A hospital's staff are the jobs in the buildings inside its footprint. Its visitors are derived from that floor area, and there is no extra +650 jobs.
  - A POI's own job and attraction values are used **only when no building footprint is found** (for example, a point with no polygon). That fallback is marked "estimated".
- Small POIs (shops, cafés, bars) change the *kind* of attraction in their cell (shopping, leisure, night) and leave its size alone. One hundred restaurants make a block attractive for evening leisure; they do not multiply its trips.
- **Test:** total trips ≤ residents × the maximum trip rate + visitors and gateway travellers. Adding 500 POIs to a block changes the mix but keeps the total within that cap.

### 6.5 Scale tiers (scale-aware, not one rule per category)

| Category | Measured scale, when available | Estimate otherwise |
|---|---|---|
| Airport | Annual passengers (Wikidata, with year) | OurAirports type → tier (large 1–2, medium 3, small 4–5); then runway count and apron area |
| University | Students (Wikidata) | Campus floor area; residential share from student housing buildings in the footprint |
| Hospital | Beds (Wikidata, sparse) | Floor area in the footprint |
| Stadium or arena | Capacity (Wikidata) | Stand area (stadium polygon minus pitch) × seat density (game setting) |
| Mall or market | — | Floor area (mall) or polygon area (market) |
| Train or metro station | Patronage (Wikidata, sparse) | Rail lines through the station (from geometry), mode mix, `rank` |
| School | — | Floor area; kindergarten vs school subclass |

### 6.6 Airports

- **Found:** from `aerodrome_label` in the z14 region tiles, and from the z8 scan beyond the region. Both are matched to OurAirports by IATA or ICAO.
- **Landside anchor:** the largest building cluster that touches an apron and is within reach of a public road; failing that, the label point. Quality is "estimated". A Barcelona tile test checks that the anchor falls within 1 km of Terminal 1.
- **Out of reach (every preset at the start):**
  - The airport is listed with its distance and direction.
  - Network Control shows the estimated air-traveller demand from your area as **unserved potential**, with no passengers generated and no revenue.
  - An "Airport link" objective rewards reaching it.
- **Activity scales from passengers per year:**
  - travellers per day = annual ÷ 365 × seasonal factor;
  - ground access by origin zone;
  - staff from an assumed jobs-per-million-passengers ratio (an assumption, labelled as a game setting).

### 6.7 Train, metro, tram stations and ferry piers (added at the owner's request)

- **Detection and merging** as in 6.3. Each station gets its **modes** (rail, metro, tram, ferry) and its **lines**: the rail or transit geometry within 150 m, grouped into continuous lines. Ferry routes are named in the tiles.
- **Tiers:**
  1. main or intercity station: many tracks, a large railway land-use polygon;
  2. regional or commuter station;
  3. metro station;
  4. tram stop;
  5. small halt.
  The lines through a station raise its tier, and an interchange is promoted one tier.
- **What stations generate:**
  - **Gateway travellers:** people arriving from outside the region by intercity or regional rail and leaving again. They have luggage on intercity routes, spread through the day, and commuter peaks on regional lines. They replace today's generic hub boost (`passengers.ts:169-184`).
  - **Access points to the existing transit network** (section 7.6). With that network, a journey can be home → your bus → metro → destination. A station's catchment then becomes a feeder market for your lines, and the metro is also a competitor.
  - **Disruptions:** an occasional, explained rail disruption (section 9.3). Passengers on that part of the network look for alternatives, and that is a moment for your buses.

---

## 7. Origin–destination and passenger choice model

### 7.1 Activity zones

- **Zones:** 600 m squares (4×4 demand cells) inside owned territory plus one ring of map squares. Beyond that, one zone per map square. Each significant place (airport, stadium, campus, hospital, mall, main station) gets **its own zone**, so its trips end at the right spot.
  - A preset region starts with about 300–400 zones (estimate). Coarsening outside the territory caps active zones at about 900.
- **Access to your network:** each zone links to the stops within a 600 m walk, up to 4. The walk time is weighted by where the zone's residents and jobs actually are (from cells), and is cached at rebuild.

### 7.2 Population and activity budget

- **Residents** per zone, from buildings as today. A share of people of each type per zone: workers, university students, pupils, retired and other.
  - Car availability is estimated from density and distance to the centre. Both are game settings, labelled "estimated".
- **Participation per person type and day type** (game settings, kept inside the current total of about 2.7 trips per person per day):
  - workers make work tours on working days;
  - pupils make school tours on school days;
  - students make university tours on teaching days;
  - everyone makes shopping, leisure, errand and healthcare tours.
- **Visitors and gateways:**
  - tourists from hotel floor area × a seasonal occupancy curve;
  - air travellers from airport scale;
  - rail travellers from station tier;
  - event attendees from events.
- **Capacity limits:**
  - work tours are attracted by jobs;
  - education by school and university places;
  - shopping by retail floor area;
  - leisure by leisure capacity;
  - healthcare by hospital and clinic floor area.
- **Destination choice:**
  - Work and education are **doubly constrained**: production and attraction totals both match. A few balancing iterations run at rebuild.
  - Shopping and leisure are **singly constrained**. They use a destination logsum that includes your network, so better service to a mall draws a few more shoppers there and fewer elsewhere. The total is bounded (section 7.7).

### 7.3 Journeys: round trips, gateways and linked returns

- **Home-based tours:** home zone → activity → home zone. Each has a **start-time profile** and a **duration profile** from its activity profile (section 8). For example:
  - work: 8–9.5 h;
  - school: about 7 h;
  - nightlife: 3–5 h, returning after midnight;
  - hospital visit: 1–2 h;
  - staff shift: 8 or 12 h.
- **One-way gateway trips:**
  - air travellers departing (zone → airport) and arriving (airport → home or hotel), balanced over days;
  - rail travellers through stations;
  - visitors entering and leaving the region.
- **Trips from work** (lunch, errands, business) stay small, as `NHB_PER_JOB` does today.
- **Linked returns on your network:**
  - When a group finishes the outbound leg of a tour, it joins a saved **away pool** (`pax.away`): a return stop pair, traveller type, count and return-time bucket.
  - At the return time it appears at its destination stop heading home. The rate model does **not** generate those return trips again.
  - If no route home exists then (for example, the last bus has gone), it is recorded as **stranded**. That is a new analytics count, scored like a given-up trip.
- **Tour-level choice:**
  - The choice of how to travel is made **once per tour**, from the outbound and expected return conditions together.
  - Nobody takes your bus to a club if there is no bus home at 02:00. A night service raises demand in both directions.
- The result is directional demand: morning peaks one way, evening peaks the other, quiet counter-peak directions, and changes where lines meet.

### 7.4 Traveller types

Ten types, each with a small parameter set. All values are game settings, anchored on the ranges in `passenger-choice-research.md`.

| Type | Main sources | Fare sensitivity | Wait weight | Change penalty | Walking | Reliability weight | Space and boarding | Car |
|---|---|---|---|---|---|---|---|---|
| Commuter | Homes → jobs | medium | 1.6 | 13 min | normal | high | 1.0 | zone share |
| University student | Homes, halls → campus | **high** | 1.5 | 10 min | tolerant | medium | 1.0 | low |
| Pupil | Homes → schools | high | 1.5 | 15 min | short | medium | 1.0 | as car passenger |
| Shift worker | Homes → hospital, industry, airport | medium | 1.8 | 13 min | normal | **high** | 1.0 | zone share |
| Shopper, errands | Homes → shops, markets, services | medium | 1.8 | 15 min | short | low | 1.1 with bags | zone share |
| Leisure, nightlife | Homes, hotels → venues, districts | medium | 1.8 | 15 min | normal | low | 1.0 | taxi likely late |
| Visitor, tourist | Hotels, stations → sights | low | 1.7 | **20 min** | normal | medium | 1.2 | taxi only |
| Air traveller | Homes, hotels ↔ airport | **low** | 2.0 | **25 min** | short | **very high** | **1.6 space, +2 s boarding** | zone share + taxi |
| Event attendee | Zones → venue | medium | 1.4 | 12 min | tolerant | low | 1.0 | parking penalty |
| Patient or visitor | Homes → hospitals, clinics | medium | 1.8 | 15 min | **short** | medium | 1.1 | zone share |

People without a car (most pupils, many students, and the share of residents without one) are **captive riders**. When service gets worse they keep riding but wait longer, and their satisfaction, and with it reputation, falls. People with a car leave. Cutting hospital service therefore shows both effects.

### 7.5 Choice

**Alternatives,** with utilities in generalised minutes:

| Option | Generalised time | Availability |
|---|---|---|
| Walk | distance × weight ÷ walk speed, by type and weather | under about 3 km |
| Bike | distance ÷ 14 km/h + a weather penalty + a propensity constant | short and medium trips, by type |
| Car | `9 + d/330 + traffic·d/450` (the existing formula) + parking search by destination (centre, event) | car available |
| Taxi | car time + 5 min wait + fare as minutes (expensive) | everyone |
| Existing transit | access + wait (set headway by mode) + ride time on the transit graph + changes + egress | where both ends reach the transit network (section 7.6) |
| **Your network** | access walk + wait × wait weight + ride time × crowding multiplier + changes × penalty + fare ÷ value of time + reliability penalty + egress | where an itinerary exists |
| Stay home | a weather- and calendar-dependent constant | optional tours only (shopping, leisure) |

**The model:**
- A multinomial logit per traveller type, keeping the existing scale of 5.5 minutes. Nesting by public transport, active and private modes comes in phase 7.
- **Crowding** multiplies ride time by the expected load and the standing share. This uses the seat counts already in the bus models: about 1.0 seated below 75%, up to 1.5–1.7 at crush. Luggage types weigh more.
- **Reliability** comes from each line's on-time history (`routeQuality`, `engine.ts:414-420`), weighted by type.
- **Reputation** becomes an "awareness and trust" constant on your network (worth a few minutes) and replaces the 0.6 cap. The cap stays until calibration passes (section 11).

**Output:**
- Demand on your network per (boarding stop, alighting stop, traveller type), using the best access and egress stop pair, or a logit split across pairs within 2 minutes of the best.
- It feeds the existing per-minute accumulators. Each non-bus share is kept as a modelled estimate per zone pair, for "how people travel here".

### 7.6 Existing transit as a background network

- **Built from the tiles' rail, transit and ferry lines** (confirmed present). Sidings and yards are excluded with the `service` attribute. Lines are snapped to stations; ferry routes connect their piers.
- **Service levels are game settings by mode,** labelled "assumed":
  - speeds: metro 32, tram 18, regional rail 45, ferry 20 km/h;
  - waits: metro 4, tram 6, regional rail 8, ferry 12 min at peak.
- It competes with your network, and it combines with it in phase 7 through walking changes at stations.
- **Fallback:** if a graph is broken (disconnected pieces, no stations snapped), that mode is switched off for the city and the place card says so.

### 7.7 How player decisions propagate

| Player action | Effect in the model |
|---|---|
| Higher frequency | Shorter waits → higher utility on your network → people switch modes. Destination logsums rise → a bounded rise in optional trips (at most +15%, game setting). |
| A new direct line to a place | Fewer changes and shorter times. That place's travellers, by type, compare it with their current choice. |
| Unreliable service | Lower reliability utility, strongest for air travellers and shift workers. Choice riders leave; captive riders stay and get unhappier. |
| A higher fare | Utility falls by each type's fare sensitivity, so students and shoppers leave first and air travellers last. |
| Crowding | The ride-time multiplier rises, people are left behind, patience runs out, and satisfaction falls. |
| A late-night service | Night and evening tours become possible in both directions. |

### 7.8 Unserved demand

- **Zone pairs where your network has no useful itinerary** keep their modelled trips by mode.
- They appear as **potential**, labelled "estimated": in Network Control and on the place card ("Airport: about 4,000 trips a day from your area; none by your network").
- They generate no passengers and no revenue.

---

## 8. Place-specific activity profiles

A profile is **data**: a list of composable components. A new category is a new data entry, not new code.

```ts
interface ActivityComponent {
  traveller: TravellerType;
  purpose: Purpose;                       // work | education | shopping | leisure | health | travel | event | other
  volume: { per: 'job' | 'student' | 'seat' | 'pax_year' | 'm2_floor' | 'bed' | 'line'; rate: number };
  start: TimeProfile;                     // mixture of peaks, or shifts([6, 14, 22], width)
  duration: DurationProfile | 'one-way';
  days?: WeekdayMask;
  calendar?: CalendarGate;                // 'school_days' | 'teaching_weeks' | 'open_days' | …
  weather?: WeatherSensitivity;           // e.g. outdoor: rain ×0.6, pleasant ×1.2
  season?: SeasonCurve;                   // factors by position in the game year
}
```

Time profiles reuse the existing `shape()` and Gaussian mixtures (`passengers.ts:35-78`).

| Category | Components |
|---|---|
| **Airport** | **Departing and arriving travellers** in waves by size tier: big hubs have banks, small airports a few peaks, operating about 04:30–23:30. A tourism season curve. **Luggage** (1.6 space, +2 s boarding, game settings). **Very high reliability weight.** **Staff** shifts around 05, 13 and 21. Flight disruptions are explained events that delay or bunch travellers (section 9.3). No real flight schedules are used. |
| **Hospital** | **Staff** shift changes around 07, 15 and 23 (12-hour shift options), every day. **Outpatients** 08–16 on weekdays. **Visitors** 14–20 every day. Demand is steady outside commuting hours, with patients averse to walking. |
| **University** | **Students** in teaching blocks 09–17 with spread arrivals and an evening tail (library, social). Gated by teaching weeks; exam weeks are lower and more spread; breaks are near zero. A **residential campus** (student housing in the footprint) makes fewer trips than a **commuter campus**. Staff come as commuters. |
| **School** | **Pupils**: a sharp arrival 07:30–08:15 and dismissal 15:00–16:00, school days only, scaled by school size. Primary pupils mostly walk. **Staff** come as commuters. Holidays are near zero. |
| **Stadium, arena** | Near zero on ordinary days (tours, a small staff). **Event components** are created only by the event engine (section 9.3). |
| **Shopping, markets** | Opening hours by country rule (for example, Sunday closing where the calendar says so). Weekend and evening peaks. **Market days**: real ones when known, otherwise a fixed weekday chosen from the seed and labelled. A seasonal retail peak in the winter holiday period. Rain shifts some leisure from parks to malls. |
| **Nightlife** | Starts Friday and Saturday 21–01, returns 00–05, smaller on weekdays. Tours cross midnight, which already works: service days run 03:00–03:00 and timetable minutes can exceed 1440. |
| **Hotels, tourism** | Visitor tours from hotels to sights, shopping and nightlife. Gateway trips to the airport and stations. A seasonal curve. A high change penalty (simple journeys preferred). |
| **Industrial, employment** | Shift workers around 06, 14 and 22, mostly weekdays and low at weekends; offices follow normal commuting. |
| **Train, metro stations** | Gateway travellers by tier (luggage on intercity routes); commuter peaks on regional lines; access to the existing transit network. |
| **Parks, beaches, waterfront** | Outdoor leisure that depends strongly on weather and season (heat raises beaches, rain lowers parks). |

Every component's volume comes from **that place's** scale, never from a category constant. A tier 4 airport with 0.5 million passengers a year produces about 1/80th the travellers of a 40-million hub.

---

## 9. Calendar, weather and event systems

### 9.1 Calendar

The game **never shows real dates, months or years** (owner's decision, 2026-10-30). A real date would soon be a future one, and real holiday dates for future years cannot be known. Weekdays stay as they are.

- **Game time:**
  - The top bar shows `Mon · Day 12 · Autumn, week 2`.
  - A game year is **12 weeks (84 days)**: four seasons of 3 weeks each (owner's decision). It takes about 3 hours at the fastest speed. The length is stored as `yearWeeks`, so it can be retuned.
  - History views count game years from the company's founding ("Year 2 · Spring"). They are never calendar years.
  - New games start in week 1 of autumn, the start of the school and university year, so the whole cycle shows. Old saves start there when upgraded.
  - Season names follow the local hemisphere (from latitude), so summer is warm in the south too.
- **Calendar profiles per country, as data, with a generic fallback.** They describe *where in the game year* things happen, as positions, never dates:
  - **School year:** terms over autumn, winter and spring, a short break between terms, and summer off.
  - **University year:** teaching weeks with exam weeks at the end of each block, and a longer summer break.
  - **Public holidays:** a few holiday days per game year, at fixed positions, plus a winter holiday period where the country has one. They are labelled "public holiday", with no names or real dates. The number per country is a game setting, informed by the real count.
  - **Other settings:** the tourism season (a summer peak; a winter peak for festive or winter-sport cities), shop rules (for example Sunday closing where the country has it), and event seasons (football from autumn to spring).
  - All of these are written by hand and labelled "typical pattern". No holiday datasets are needed: `date-holidays` and OpenHolidays are no longer used.
  - **Default layout of the 12-week year** (a game setting; each country's profile can shift it):

    | Weeks | Season | Schools | Universities | Other |
    |---|---|---|---|---|
    | 1–3 | Autumn | Term (start of the school year) | Teaching | Football season starts |
    | 4–6 | Winter | Term; holiday week in week 5 | Teaching; exams in week 6 | Festive shopping and a holiday period in week 5 |
    | 7–9 | Spring | Term; a short break early in week 7 | Teaching; exams in week 9 | Football season ends |
    | 10–12 | Summer | Holidays | Break | Tourist peak; beaches and waterfront |
- **The calendar provides:** day type (working day, weekend, public holiday), school day, teaching week, exams or break, season and week, tourism factor and shop rules.
- **Service plans:**
  - Weekday and weekend timetables gain optional **service plans**: saved variants applied for a season, for school holidays or for an event day, or switched by automation ("holiday timetable", "match-day timetable").
  - The player can thin school routes during holidays and strengthen university routes in autumn.

### 9.2 Weather

- **Climate data, baked at build time and never fetched at runtime:**
  - Monthly statistics per preset city (used internally and mapped onto the game year, so each game week matches a point in the real climate year; months are never shown): wet-day probability, wet-to-wet persistence, heavy-rain share, snow-day probability, mean and spread of daily high and low, and hot-day frequency.
  - For searched places, the same statistics on a coarse global grid (2°), a few hundred KB.
  - **Source: NASA POWER (decided by the owner on 2026-10-30, replacing ERA5, which needs an account and API key).** The AWS Open Data Registry lists POWER as "Creative Commons BY 4.0" and says "There are no restrictions on the use, access, and/or download of data from the NASA POWER Project" (checked 2026-10-30). No key is needed. Temperatures come from MERRA-2 at about 0.5°, so every place has data.
  - The credits cite the dataset (DOI 10.24381/cds.adbb2d47) and say the game "contains modified Copernicus Climate Change Service information".
  - NOAA GHCN-Daily was tried and rejected. NCEI's GHCN documentation says data exchanged under WMO Resolution 40 is "intended for free and unrestricted use in research, education, and other noncommercial activities. For non-U.S. locations data, the data or any derived product shall not be provided to other users or be used for the re-export of commercial services." That rules out shipping statistics for non-US cities in a paid game.
- **Live weather is not proposed.** Open-Meteo's free tier is non-commercial; a paid plan or self-hosting (AGPL) needs the owner's approval. The base game never depends on it.
- **Generator:**
  - A daily state (clear, cloudy, showers, rain, heavy rain, snow; hot or cold flags) from a Markov chain conditioned on the point in the climate year.
  - Temperature anomalies that persist from day to day.
  - An hourly shape (afternoon showers, fronts).
  - Every draw comes from a stateless hash of (seed, 'weather', day, hour) and the previous day's saved state.
  - The actual weather is generated two days ahead and saved.
- **Forecast:**
  - Issued at 18:00 for the next day, from the saved actual weather plus a hashed error: about 80–85% of days in the right category, with near misses such as showers instead of rain (game settings).
  - The player sees the forecast, and the day may turn out differently within those limits.

**Effects** (multipliers are game settings; published ranges are cited where they exist):

| Weather | Trip making | Destination | Travel choice | Roads and buses | Waiting |
|---|---|---|---|---|---|
| Pleasant | Outdoor leisure up | Parks, waterfront up | More walking and cycling | Normal | Normal |
| Rain | Some outdoor leisure cancelled | Parks down, malls up | Cycling down (published: 8–25% of cyclists deterred), walking down for longer distances, some moves to bus, car and taxi | Road speeds lower (game setting, about −8%) → buses late against their typical-traffic timetables | Waiting weighs more |
| Heavy rain | More cancelled | Stronger shift indoors | Strong move away from walking and cycling | About −18% (game setting); more delay | Waiting weighs much more |
| Snow | Optional trips cancelled; some work trips cancelled, **not** moved to buses | Indoors | Cycling nearly gone | About −30% (game setting); widespread lateness | Much worse |
| Heat | Beaches and waterfront up, midday outdoor activity down | Waterfront | Long walks penalised; vehicle comfort matters more (an air-conditioning flag per bus model is a later option) | Normal | Waiting weighs more |

- Published bus ridership changes with weather are single-digit percentages, and they differ by income and climate: Eugene, Oregon found −5.7% on cold weekdays, and +2.7% in low-income areas on heavy-rain days.
- The model must therefore **not** raise bus demand everywhere. A dense short-trip corridor may gain riders on a rainy day while a park-bound or long-distance line loses them.
- Lines can lose riders in bad weather because buses run late, not only because people cancel.

### 9.3 Events

**Venues** come from the registry:
- stadiums and arenas (including `music_venue` land use);
- theatres and exhibition halls;
- large squares and parks for festivals and public gatherings.

**Templates** are data, so new types need no code:

| Template | Timing | Duration | Arrivals | Departures | Attendance | Notes |
|---|---|---|---|---|---|---|
| Football match | Season by calendar profile (typically autumn to spring); weekend afternoons and evenings, sometimes midweek | 2 h (+30 min extra time sometimes) | Ramp over 3 h before kick-off | About 60% within 30 min of the end | Seats × fill 0.6–0.98 | Opponents and fixtures are never named (fixture lists carry rights issues; they are not fabricated either) |
| Concert | Evenings | 2.5–3 h | 3 h | Within about 45 min | Venue capacity × fill | Outdoor concerts can be cancelled by storms |
| Festival | Several days | 12:00–24:00 | All day | All day | Area-based | Seasonal |
| Public gathering | Calendar-driven (for example the end-of-year celebration) or short notice | 2–6 h | 2 h | Concentrated | Area-based | Short-notice ones are explained |
| Rail disruption | Unexpected, rare | 1–4 h | — | — | The affected transit flows | That part of the transit network is unavailable, and passengers look for alternatives |
| Flight disruption | Unexpected, rare | 2–6 h | Arrivals bunch later | — | A share of air travellers | Airport travellers shift in time |

**Schedule:**
- Generated per venue and season from the seed, then saved.
- **Announced 3–10 days ahead** with a notification, a place-card entry and an automation event.
- Unexpected events (extra time, delays, weather cancellations, disruptions) are rare and come with a reason.

**Demand:**
- Attendees are event tours from zones, with long distance decay because people travel far for events, plus visitors arriving through stations and the airport.
- They arrive and leave by the template profiles, and their **returns are linked** through the away pool.
- Parking near the venue is penalised and taxis are limited, so when you provide the capacity, your network wins riders.
- Crowds that cannot board are left behind; people with no way home are stranded.
- **No money is awarded for serving an event.** Revenue comes only from attendees who board.

**Traffic:** congestion rises on roads within about 1–1.5 km of the venue during the arrival and departure windows, through the new traffic modifier.

**What the player can do:**
- extra departures (existing, real operations);
- reassigning spare buses (existing);
- a match-day service plan (new);
- later departures through that plan;
- automation such as "when a major event ends near Stop X, activate the stadium reinforcement plan".

---

## 10. Integration with the existing simulation

| File | Reuse | Change | Add |
|---|---|---|---|
| `world/regionBuilder.ts` | Building, land-use and cell pipeline; POI classification | Read `aerodrome_label`, `aeroway`, `landcover` sand, `water`, `park`, and rail, transit and ferry lines; keep feature ids and polygons for places; stop POIs adding jobs on top of buildings | Calls `buildPlaces()` |
| `world/region.ts` | `RegionData` | Gains `places`, `zones` and `transit`; `PoiKind` stays for markers | — |
| `world/geo.ts` | — | Replace the linear `poisNear` with a grid index | — |
| `world/places.ts`, `activity/*` | — | — | New: registry, zones, generators, tours, choice, calendar, climate, weather, events |
| `passengers.ts` | `computeItineraries`, accumulators, boarding, changes, patience, fares | `DemandModel` becomes a thin adapter fed by the activity engine's per-stop-pair, per-type rates. Accumulator keys gain a type. Arrival feeds the away pool. Patience varies by type | Away-pool release; stranded counting |
| `types.ts` | `PaxGroup`, `GameState` | `PaxGroup` gains `k` (type), `pu` (purpose), `tr?` (return link); `pax.away`; `world` (calendar, weather, events, place snapshot); `Timetable.plans?` | — |
| `vehicles.ts` | Dwell model | Capacity counted in space units (people × the type's space factor); boarding seconds by type | — |
| `world/traffic.ts` | Provider interface, `typical()` for timetables | `congestion()` multiplied by a conditions modifier (global weather, local events); `typical()` unchanged | `conditions(t)` |
| `engine.ts` | Hour slot and `dirty` refresh rule, minute, hour and day hooks | Hour hook advances the weather; day hook issues the forecast and announces events | — |
| `progress.ts` | Satisfaction, reputation, objectives | Stranded passengers scored like given-up trips | Objectives: Airport link, Match day (carry X attendees with few left behind), Night network |
| `analytics/*`, `automation/*`, `mcp/*` | Recording hooks, query layer, executor queue | New dimensions, measures, triggers (section 12) | — |

To keep the game working during the change, the new demand path is developed behind a **development-only switch**. Calibration tests run old and new side by side. Only the new path ships, and the switch is removed before release.

---

## 11. Economy and revenue implications

- **Revenue only from boarded, fare-paying groups**, as today: one fare per journey, charged at first boarding (`passengers.ts:579-584`).
  - Unserved potential, events and weather never credit money.
  - The existing ledger audit stays the guard: fares equal boarded groups × fare.
- **Expected ridership changes:**
  - **conservation:** fewer phantom trips near POI clusters;
  - **linked returns:** lower evening demand where evening service is poor;
  - **seasons:** universities in summer, tourism in summer;
  - **weather:** day-to-day swings;
  - **competing transit:** fewer riders on corridors parallel to the metro, more on feeder lines.
- **Calibration targets before each phase merges:**
  - reference line (Taksim → Karaköy, 4 × City 12): about 3,000 riders a day **±10%**, averaged over term-time weeks with typical weather (decided). Single days and seasons may move further, as far as weather, seasons and events realistically move them;
  - balance test floors (>1,500 riders a day, profitable from day 1);
  - progression bot (about 9,000 riders on weekdays, never stalls);
  - automation scenario 3 (peak load above 80%), or a documented change to its setup if the morning peak moves.
  - The 0.6 cap is removed only when these hold with the trust constant in its place.
- **Costs move with conditions:** bad weather slows buses (more driver hours); events need extra buses (more hours and kilometres).
- **Reputation risk and reward:** stranded and left-behind passengers at events or late at night hurt; good event service lifts satisfaction.
- **Fares:** the flat fare stays. Types differ only in sensitivity. Passes and concessions (PRD §9) are a later topic that this data will inform.
- **Seasonality is intended:** a route that is profitable in autumn and loses money in summer is a reason to use service plans, not a bug.

## 12. Analytics and Network Control integration

**Recorded from day one, through the existing hooks:**
- Per stop and per line, by hour: boardings by traveller type (10 numbers per hour per line, compacted) and by purpose.
- Per line: boardings and revenue by direction (pattern) and time band.
- Per origin–destination key: completed journeys by type (a sparse type vector, only for keys with journeys).
- Stranded and left-behind passengers by type.
- `DayRecord` labels: game year, season and week, day type, holiday and term flags, weather summary (category, rain, temperature), events (venue, attendance, carried, left behind, stranded).
- **Weekly roll-ups** (new; kept for three game years): per line, boardings by type and revenue; per network, by weather category. Needed for comparing the same season across years.
- **Modelled mode shares** per map square and day (6 modes × about 30 squares). These are estimates, labelled so.
- **Size target:** at most 30% more than today's day record. A test measures it.

**Query layer and Network Control:**
- **New groupings or filters:** traveller type, purpose, weather category, day type, event day. They are added to `MEASURES`, so tables, custom metrics, reports and automation's `data.analytics` get them.
- **Estimated demand switches to the activity model:** zone and place OD **by mode**, including an unserved view. Today it is the raw gravity estimate.

**Network Control views** (existing panels, no new screens):

| Panel | Additions |
|---|---|
| Passengers | Origin–destination filtered by type; demand view in three modes: observed / estimated by mode / unserved |
| Lines | Columns by type and time band |
| Overview | Weather and event markers on daily charts |
| Reports | Seasonal comparisons from the weekly roll-ups |
| Airport view | A filter in Passengers on the airport place |

**Automation (new nodes; existing executor and safety rules):**

| Node | Kind | What it does |
|---|---|---|
| `trigger.eventAnnounced`, `trigger.eventStart`, `trigger.eventEnd` | Trigger (event queue) | Venue or stop filter, lead time, size threshold |
| `trigger.forecast` | Trigger (polled, like `trigger.waiting`) | Tomorrow matches a condition |
| `trigger.calendar` | Trigger | Term starts or ends; holiday tomorrow |
| `data.weather`, `data.calendar`, `data.events`, `data.place` | Data | Read the current and coming conditions |
| `data.demandForecast` | Data | Expected riders per line per hour for the next N hours, from the model; labelled "estimate" |
| `action.applyServicePlan` | Action | A big change, so the existing approval rules apply |

Templates: stadium reinforcement, rain frequency boost, school-holiday timetable, early-morning airport boost, unserved commuting corridors report.

- **Before the unlock:** the line inspector's character sections, the place card, weather and announcements are basic information and stay visible. History beyond the inspector's recent days, OD, reports, the Lab and automation stay locked, as today.
- **MCP:** datasets that live in the save (analytics by type, events, weather, the place snapshot) are reachable through `query_save` immediately. Dedicated read-only tools (`places`, `weather_calendar`, `events`, `line_character`) come in phase 6.

## 13. UI changes, using the existing design system

No new theme, no dashboard. Tokens, Figtree, the card shell, `LineChart`, and the rules in `docs/design/design-system.md` apply.

- **Top bar:**
  - The `.time-readout` gains the season and week ("Autumn, week 2") and a weather chip (icon, temperature, "Tomorrow: rain"), following the stat-chip pattern.
  - A popover shows today's hourly strip and tomorrow's forecast, with its uncertainty stated.
- **Notifications:** event announcements (info), weather warnings (warn) and disruptions, with new `ref` kinds `place` and `event` that open the place card.
- **Place card:**
  - **Where it lives:** a new `Inspector` case, 360 px. Destination markers become clickable; out-of-reach airports appear as a small edge chip with the distance.
  - **Header:** name, category, scale with a measured or estimated tag and its source.
  - **When it's busy:** a compact 24-hour strip from the profile, labelled "estimate".
  - **Your network:** stops within a walk, the lines serving it and their next-peak frequency, and coverage.
  - **Events:** coming events.
  - **How people travel here:** modelled trips per day by mode and your share.
- **Line inspector:** compact sections in the existing style, collapsible, using recorded data from the analytics days:
  - **Who rides:** a composition bar over the last 7 days.
  - **Through the day:** a 24-hour boarding curve by direction, with peaks labelled.
  - **Where they go:** top destinations and main origin areas.
  - **Revenue by period:** by time band.
  - **Direction:** occupancy from pattern loads.
  - **Reliability:** on time over 7 days.
  - **Weather:** riders on rainy vs dry days of the same day type, shown only once at least two of each are recorded; otherwise it says what is missing.
  - **Events:** riders from events in the last 35 days.
- **Stop inspector:** the "Nearby:" line becomes links to place cards.
- **Map:** the existing demand overlay gains a traveller-type filter; venue markers show a small badge on event days.
- **Visual QA:** each phase captures screenshots of its interface with the existing capture scripts and reviews them before it is marked done.

## 14. Persistence and determinism

**Save version 3 adds:**

```ts
world: {
  calendar: { yearWeeks: number; startWeek: number; profile: string };
  weather: { days: { day: number; actual: DayWeather; forecast?: DayForecast }[] };  // today + 2 ahead
  events: { nextId: number; scheduled: CityEvent[]; recent: CityEventResult[] };    // venue snapshot inside
  places: { version: string; digest: string; significant: PlaceSnapshot[] };         // ≤ ~300 entries
}
pax.away: Record<string, number[]>   // "from>to>type" → people per return-time bucket (sparse)
pax.acc keys "o>d>type"
Timetable.plans?: ServicePlan[]
```

**Upgrade from version 2:**
- the calendar starts at week 1 of autumn;
- weather is generated for the current day;
- events are scheduled from the upgrade day forward (none in the past);
- existing accumulators drain as a mixed type;
- analytics fields are optional and coverage is reported from the upgrade day.

**Randomness:**
- No new draws from `game.random()`. Weather, forecasts, event schedules and market days use stateless hashes keyed on (seed, stream, day, entity), as traffic noise does.
- Generated weather and events are **saved once generated**, so a later change to the generator code cannot rewrite a running game.
- Generators carry a version number.

**Map version drift:**
- The tile planet version is recorded in the save (`RegionSpec.tileTemplate` is declared and unused today).
- On load, the place snapshot is compared with the rebuilt registry. If an event's venue has gone, the event is cancelled with an explanation.
- A future multiplayer mode would need a pinned tile version for all peers; this design does not prevent it.

**Tests** extend the existing reload scenarios to weather, forecasts, events and the away pool (section 17).

## 15. Performance strategy

| Work | When | Budget (target) | How |
|---|---|---|---|
| Registry, zones, transit graph | Region build (worker), territory growth | ≤ 300 ms extra in the worker | Grid index, merge in one pass, simplified polygons |
| Destination distribution and balancing | Network change, day start | ≤ 150 ms | Sparse top destinations per origin (95% of trips, at most about 60); typed arrays; 4–6 balancing iterations |
| Travel choice | Each game hour or change | ≤ 30 ms for 400 zones and 100 stops | Non-bus utilities computed once per hour slot and weather state; network utilities only for zone pairs with access; cached access and egress |
| Passenger generation | Each game minute | ≤ +30% of today | Sparse per-type accumulators; away pool by time bucket |
| Analytics | Event-driven | ≤ +30% day size | Compact arrays, sparse OD type vectors |
| Perf test | CI | Existing <120 ms CPU per real second at 720× still holds | Plus a new dense-city test: 1,500 places, 900 zones, 300 stops |

Nothing in the engine runs per animation frame. The interface reads cached results.

---

## 16. Implementation phases and dependencies

The proposed order is mostly right. Four adjustments:
- **A small phase 0 comes first.** The game needs a calendar of seasons and weeks, a save version 3 skeleton and a calibration harness before anything seasonal can be built or balanced.
- **Interface work is spread across phases instead of left to the end.** The place card ships with the registry, so the registry can be checked by eye. Line character ships once types are recorded.
- **The double-counting fix moves into phase 2.** It changes demand, so it belongs with the demand change, and phase 1 stays demand-neutral.
- **The existing transit network joins the place profiles in phase 3,** because stations and transit competition depend on each other.

| Phase | Contents | Depends on | Game state after it |
|---|---|---|---|
| **0. Foundations** | Game calendar (seasons and weeks, no real dates) and the season in the top bar; save version 3 skeleton and upgrade; calibration harness (reference scenarios report riders and results); determinism harness (two runs, reload mid-day) | — | Unchanged gameplay, plus seasons |
| **1. Place Registry** | Registry from tiles (airports, z8 scan, OurAirports join, stations with modes and lines, merging, ids, tiers, quality); spatial index; place snapshot in the save; **place card**, clickable markers and stop-inspector links; hub detection reads the registry | 0 | Same demand; places visible and inspectable |
| **2. Journeys and choice** | Zones, population and activity budget (double counting fixed); tours, gateways, linked returns (away pool, stranded); ten traveller types; multinomial choice (walk, bike, car, taxi, your network, stay home); new rates feed the existing generator; types recorded in analytics; estimated demand from the model; unserved view | 1 | New demand, calibrated to ±10%; the cap still present |
| **3. Places come alive** | Activity profiles for every category; calendar gating (terms, holidays, opening rules); background transit network from tile geometry; station gateways; **line inspector character sections** | 2 | Lines differ by what they serve |
| **4. Weather** | Climate bake; generator and forecast; effects on trip making, destinations and choice; traffic conditions modifier; top-bar chip, popover and warnings | 2, 3 for destination shifts | Day-to-day variety; planning by forecast |
| **5. Events** | Event templates and schedule, announcements, event tours with linked returns, local traffic, disruptions (rail and flight); **service plans**; objectives | 2, 3 (transit, for rail disruptions), 1 (venues) | Match days, concerts, disruptions |
| **6. Network Control and automation** | New groupings and measures, panel additions, weekly roll-ups, triggers, data nodes, `applyServicePlan`, templates, MCP tools | 2–5 | Analysis and automation of all of the above |
| **7. Depth and balancing** | Nesting (public transport, active, private); trust constant replaces the cap; habit (optional); walking changes between nearby stops and stations (multimodal readiness); final calibration, performance profiling, full visual QA, save validation | all | Release candidate |

Each phase ends with the full test suite green, the calibration targets met (or a documented, owner-approved change), screenshots reviewed, and the progress document updated.

For each system in this table, sections 6–14 give what is reused, what changes, what is added and how it connects. Section 17 gives the tests that show it works.

## 17. Acceptance criteria and tests

Fixtures: the existing synthetic grid city (`test/fixtures.ts`) extended with configurable places; the bundled İstanbul tiles; Barcelona test tiles (skipped when absent, as now); a dense synthetic city for performance.

| Requirement | Test | Pass condition |
|---|---|---|
| **Airport scale and timing** | Synthetic city with a 40M and a 0.5M passenger airport, both reachable | Large ≥ 30× small in daily travellers. Traveller curve starts by 05:00 with waves; staff peaks at the shift hours; the two curves differ. A bus carries fewer air travellers than commuters (space units), and dwell is longer |
| Airport detection | Live-format tiles (Barcelona fixture with the airport tile) | BCN found with its IATA code; tier from OurAirports; anchor within 1 km of T1; quality "estimated" |
| Airport out of reach | İstanbul preset | IST and SAW listed with distance; unserved potential > 0; no passengers generated; revenue unchanged |
| **University** | Same day number, term vs break | Education trips in the break ≤ 30% of term; exam weeks more spread than teaching weeks; residential campus makes fewer trips than a commuter campus of the same size |
| **School** | School day vs holiday | ≥ 60% of pupil trips in 07:00–08:30 and 15:00–16:30; holiday pupil trips ≈ 0 (staff only) |
| **Stadium** | Match day vs ordinary day | Ordinary day near zero; arrivals concentrated in the 3 h before kick-off; ≥ 50% of departures by your network within 45 min of the end; attendance ≤ capacity; bus returns ≤ bus arrivals (linked) |
| **Origin–destination consistency** | Audit over 7 days | Every group has a valid origin and destination; generated = completed + given up + stranded + in the system; each completed outbound tour creates exactly one return obligation; returns never exceed outbound arrivals |
| **Directional demand** | Radial line from a residential area to a job centre | AM inbound boardings ≥ 2× outbound, reversed in the PM |
| **Weather** | Same seed and day, rain vs clear | Walking and cycling shares down; your share up on short trips in dense zones; park-bound leisure down; road speeds lower and bus delay higher; **at least one line or traveller type loses riders** |
| **Route improvement** | Halve one line's headway | Its share and riders rise; walking and car shares fall for the affected pairs; a bounded rise in optional trips (≤ 15%) |
| **Unserved demand** | Large destination with no stops | Estimated trips > 0 in the unserved view; zero groups; zero fares |
| **Economy** | Existing ledger audit, extended | Fares = boarded groups × fare; no charge at changes; event attendees pay once; no event money |
| **Determinism** | Two runs from the same seed; reload mid-day (extends scenario 7) | Identical weather, forecasts, event schedule, away pool and passengers; the breakdown sequence unchanged (no new shared random draws) |
| **Geographic fallback** | City with buildings but no POIs; a block with 500 restaurants | Playable demand with no NaN; trips ≤ budget; the 500 restaurants change the mix, not the total beyond the cap |
| **Performance** | Existing perf test plus the dense city | Existing budget holds; hourly choice ≤ 30 ms on 400 zones and 100 stops; the dense city stays within budget |
| Hospital service cut | Double a hospital line's headway | Waits up; captive riders' satisfaction down; choice riders shift to car or taxi; reputation falls over days |
| Rail disruption | Disrupt a metro segment | Affected pairs lose the transit option; your share rises where you have a route |
| Calibration | Reference line, balance, progression, scenario 3 | Within the section 11 targets |
| Save migration | Load version 2 saves from the test corpus | Load and continue; no duplicated events after reload; coverage reported from the upgrade day |
| Visual QA | Capture scripts | Screenshots of the place card (airport, university, station), line character, weather chip and popover, event notification, and Network Control by type, all reviewed |

## 18. Technical risks and practical fallbacks

| Risk | Likelihood | Fallback |
|---|---|---|
| Balance moves too far | High | The calibration harness and ±10% targets gate each phase. The 0.6 cap stays until phase 7. Global constants are tuned before per-type ones |
| Performance in large regions | Medium | Zone coarsening outside the territory, sparse top destinations, hourly cadence, budgets in CI |
| Uneven POI coverage in searched places | Medium | The building-based budget always works; places only refine it. A coverage indicator (PRD §5.1) |
| Airport out of reach in every preset | Certain | Shown as out of reach with unserved potential and an objective; the expansion path exists today |
| Airport landside anchor wrong | Medium | Quality flag; Barcelona anchor test; the player can still place stops anywhere |
| Background transit graph broken (yards, gaps, no line identities) | Medium | `service` filter, connectivity checks, per-mode switch-off with an explanation; service levels labelled as assumptions |
| Map version drift changes places | Low–medium | Saved snapshot, version recorded, events cancelled with a reason |
| Licences | — | ODbL: tiles (existing attribution). Public domain: OurAirports. CC0: Wikidata. CC BY 4.0: NASA POWER (climate; confirmed). No holiday datasets, because the calendar is a game calendar. No fixture data. A credits screen lists them all |
| Save size growth | Medium | Sparse away pool and accumulators; size test |
| Too much complexity for the gain | Medium | Profiles are data; each phase is shippable on its own; stop after phase 3 if playtests show no gain |
| Explaining the model | — | Every estimate is labelled; no hard-coded illustrative percentages; the "why" comes from recorded or modelled values only |

## Decisions (owner, 2026-10-30)

1. **No real dates (revised):** the game shows seasons and weeks, never real dates, months or years. A game year is 12 weeks: four seasons of 3 weeks. New games and upgraded saves start in week 1 of autumn.
2. **Calendar data (revised):** none needed. Holidays, terms and seasons are typical patterns written as game settings per country. The earlier choice of `date-holidays` and OpenHolidays is withdrawn.
3. **Climate data:** NASA POWER statistics baked at build time (CC BY 4.0, "no restrictions on use"), with attribution in the credits. Changed from ERA5 on 2026-10-30, after NOAA GHCN-Daily turned out to restrict commercial use of non-US data.
4. **Bundled data:** the OurAirports subset (public domain) and a Wikidata extract (CC0) for the preset cities are approved.
5. **Balance:** ±10% on the reference scenarios, averaged over term-time weeks with typical weather. Days and seasons may vary realistically with weather, seasons and events.
