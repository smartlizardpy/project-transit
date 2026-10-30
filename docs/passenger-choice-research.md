# Passenger choice: research and proposed model

Status: **research and proposal only. Nothing here is implemented yet.** Written 2026-10-30 in answer to "we cannot assume everybody just wants to go on the bus".

## What the game does today

`src/game/passengers.ts`, `DemandModel.refresh`:

- A gravity model gives the trips per day **by all modes** between every pair of the company's stops, for five purposes (work, education, shopping, leisure, other), with hourly profiles and a weekend pattern. Rail stations and ferry piers near a stop add trips: they only ever *feed* the bus.
- Every game hour, each pair's best bus itinerary gets a generalised time: 1.8 × wait + in-vehicle time + 6 min per change + 3.5 min walking + the fare as minutes + a flat crowding penalty above 75% load + a reliability penalty.
- **Mode choice** is a binary logit (scale 5.5 min) of the bus against one alternative.
  - The alternative is walking or, for a share of people, the car.
  - That share is a single number for the whole city (25–60%, from traffic intensity).
  - The bus share is then capped at 0.6 × a reputation factor.
- Everybody has the same tastes. Nobody cycles, takes a taxi, or takes the metro *instead of* the bus. The model never says what the people who did not board did instead.

So the game already assumes "not everyone takes the bus": most estimated trips never board. But the alternatives are thin, the player cannot see them, and the 0.6 ceiling is a cap with no mechanism behind it.

## Options considered

| Approach | What it adds | Cost or problem | Verdict |
|---|---|---|---|
| Multinomial logit over several modes (walk, bike, car, taxi, rail/metro/tram/ferry, your bus) | Real competitors; "what did they do instead" has an answer | Cheap: a few exponentials per pair. Plain MNL treats your bus and the metro as unrelated options (the IIA problem) | Yes, with nesting later |
| Nested logit (active / public transport / private) | A new bus line takes riders from the metro more than from cars | About 1.5× MNL; nest parameters need tuning | Phase 2 |
| Population segments (no car, car available, students…) | The biggest realism gain per unit of compute: captive vs choice riders, different values of time | ×3 compute; segment shares only loosely estimable from OpenStreetMap | Yes (phase 1, 3 segments) |
| Mixed logit (random tastes) | Continuous variety | Simulation draws; hard to explain and to keep deterministic | No: segments give most of it |
| Activity or tour-based models (MATSim, ActivitySim, SimMobility) | Whole daily schedules, chained trips | Needs a synthetic population and agent state; built for batch runs, far too heavy for an hourly refresh over all stop pairs | Borrow one idea only: the return trip uses the outbound mode |
| Habit and learning (day-to-day) | Good service builds loyal riders over weeks; a bad week costs you. Gives reputation a mechanism | One saved number per area and segment | Phase 2 |
| Weather and events | "Why was today bad" stories; rain moves walkers and cyclists onto buses | Deterministic from the seed and the day number | Phase 2 |
| Departure-time shifting, induced demand | Peak spreading; better service creates trips | Moderate | Phase 3 |

## Published values worth using

Verified in the source abstracts or summaries:

- **Walk and wait time weights.**
  - The long-standing convention values walk and wait at 2× in-vehicle time.
  - A meta-analysis of 2,872 multipliers from 606 studies (Wardman et al.) supports 1.5–1.75 instead, depending on the weight given to revealed vs stated preference evidence.
  - The game's 1.8 for waiting is within the range.
  - Wardman (2004), *Transport Policy* 11(4), argues that some stated-preference values of walk and wait time are too low.
- **Crowding.**
  - Wardman & Whelan (2011), 17 British rail studies with 208 valuations: seated passengers in a busy vehicle value in-vehicle time at about 1.15–1.2×, rising to about 1.5× above 100% load. Standing passengers value it at about 2.3×.
  - A Paris bus and tram study finds 1.0 with everyone seated, rising to about 1.7 standing at crush capacity.
  - A Dutch tram and bus study (Yap et al. 2020) finds about 1.16 once all seats are taken.
  - The game's flat penalty above 75% could become a multiplier on in-vehicle time that depends on the share of riders standing.
- **Transfer penalty.** A 2022 synthesis (Jara-Díaz et al., *Transport Policy* 125) puts the pure penalty for changing at about 15–18 in-vehicle minutes, with a planning range of 13–18. Older studies range from 4 to 25 minutes. The game uses 6, at the bottom of that range. Raising it would cut transfer journeys and needs a balance check.

Not verified (design values, to be labelled as game settings): mode constants, value-of-time splits by income, car-ownership effects, nest parameters (typically 0.6–0.8), and habit strength and learning rates. No citable numbers were found for the last two.

## Recommendation

**A segmented multinomial logit with explicit alternatives, then nesting and a small habit layer.** It stays aggregated, deterministic and explainable, and keeps the existing itinerary search, which is the expensive part.

### Phase 1 (contained, no new saved state)

1. **Three segments** per area: no car, car available, students.
   - Shares come from area proxies, all labelled *estimated*: density, distance to the centre, residential share, and university buildings.
   - The city-wide car share stays inside the current 25–60% band, so totals barely move.
2. **Explicit alternatives** per stop pair and segment:
   - walk;
   - bike (12–15 km/h, better where OpenStreetMap has cycleways; no hills, since elevation data is not available offline);
   - car (only for the car segment; time from the existing traffic model, plus a parking proxy from `amenity=parking`);
   - taxi (expensive, available to everyone);
   - rail, metro, tram or ferry when both ends are near stations on the same line (from the OpenStreetMap data the game already loads for hubs).
3. **Crowding curve** in place of the flat penalty, using the published multipliers above.
4. **Replace the 0.6 cap** with a per-city mode constant, calibrated so the reference line still carries about 3,000 riders a day (within ±10%).
5. **Explain it in the interface.** The stop inspector and the Network Control *Estimated demand* view gain "How people travel here": mode shares for the area, plus the main reason they do not take your bus. Examples: "waiting 14 min vs 4 for the metro", "the change adds 15 min", "buses are full".

Cost: roughly 5 purposes × 3 segments × 6 modes per pair, about 90 exponentials against about 10 now. For 300 stops (90,000 pairs) that is tens of milliseconds per hourly refresh. Non-bus utilities change only with traffic and weather, so they can be computed once per rebuild.

### Phase 2

- **Nested structure**, so your bus competes mostly with other public transport.
- **Habit:** a satisfaction score per area and segment, updated daily from the journeys passengers actually had (waits, crowding, gave-ups). It gives regular riders an inertia bonus worth a few minutes and feeds word of mouth into reputation.
  - This needs a save migration with neutral starting values.
  - The settings are game design values, and the interface must say so.
- **Weather** from the seed and the day number. Rain lowers walking and cycling and raises bus and car use.

### Phase 3

- Departure-time shifting when the peak is crowded.
- Induced demand from accessibility.
- A few explicit captive groups (schools, hospitals).

## Risks

- **Balance.** The economy is tuned to today's ridership. Phase 1 must land within about ±10% on the reference scenarios before anything else changes. A higher transfer penalty or the crowding curve need an economy check, and scenario 3 of the automation tests depends on peak loads above 80%.
- **Calibration.** Every value is borrowed from British rail, Paris, Dutch tram or general practice, not from these cities. The interface must call mode shares *estimated*, and segment shares and habit *game settings*.
- **Determinism.** No random draws in choice; weather comes from the seeded day index; habit state is saved.

## Sources

- Wardman (2004), Public transport values of time, *Transport Policy* 11(4): https://eprints.whiterose.ac.uk/3393
- Wardman et al., walk and wait multiplier meta-analysis (2,872 multipliers, 606 studies): https://eprints.whiterose.ac.uk/id/eprint/225392/2/TimeRatio%20TRB%20%282%29.pdf
- Wardman & Whelan (2011), crowding valuations: https://econpapers.repec.org/RePEc:taf:transr:v:31:y:2011:i:3:p:379-398
- Paris bus and tram crowding: https://www.worldtransitresearch.info/research/5464
- Yap et al. (2020), Dutch tram and bus crowding: https://www.worldtransitresearch.info/research/7671
- Jara-Díaz et al. (2022), transfer penalty synthesis: https://econpapers.repec.org/RePEc:eee:trapol:v:125:y:2022:i:c:p:48-55
- Chorus & Dellaert (2012), habit as learning under risk aversion: https://repub.eur.nl/pub/81913
- Han, Arentze & Timmermans, reinforcement learning with habit: https://documentserver.uhasselt.be/bitstream/1942/9523/1/strategies.pdf
- Income segmentation in a regional mode-choice model (Metrolina): https://metrolina-regional-model-team.github.io/MRM/3_mode.html
- UK appraisal guidance, TAG unit M3.2 (walk and wait weights not confirmed from it here): https://www.gov.uk/government/publications/webtag-tag-unit-m3-2-public-transport-assignment-modelling
