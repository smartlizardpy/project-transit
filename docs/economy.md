# Economy and balance

All values are game-design estimates, not official data. They live in code, mainly `src/game/content.ts` (`ECON`, `MODELS`, `SERVICE`, `STOP_RULES`). This document explains them and must be updated when they change.

## Currency

The game works in a neutral **base currency (roughly euros)**. The UI shows money in the local currency of the chosen city. It uses a fixed game factor that also roughly reflects local price levels (`src/game/currency.ts`). These are not live exchange rates.

| Country | Shown as | Factor |
|---|---|---|
| Türkiye | ₺ | × 17 |
| United Kingdom | £ | × 0.88 |
| Japan | ¥ | × 130 |
| Eurozone and unknown | € | × 1 |

Examples in this document are in the base currency.

## Starting position

| Item | Value |
|---|---|
| Starting funds | 400,000 |
| Starting reputation | 30 / 100 |
| Licensed areas | the home area chosen at company creation |

The starting money buys one depot, three or four standard buses, a handful of stops and a line registration. A new player cannot build a large network on day one; growth comes from earnings, grants and loans.

## Capital costs

| Item | Cost | Notes |
|---|---|---|
| Depot | 60,000 | holds 8 buses |
| Depot expansion | 40,000 | +6 spaces, +120/day upkeep |
| Stop | 1,800 | |
| Line registration | 2,500 | charged once when a line is created |
| Area licence | `(18,000 + 0.25 × (residents + jobs)) × (1 + 0.12 × (areas owned − 1))`, rounded to 1,000 | needs an adjacent owned area and reputation `34 + 6 × (areas owned − 1)` (max 88) |

### Vehicles

Prices are about a third of real prices, so a well-used bus pays for itself in weeks of game time rather than years.

| Model | Price | Capacity (seats) | Energy / km | Doors | Unlock |
|---|---|---|---|---|---|
| Hopper 8 (minibus) | 36,000 | 34 (16) | 0.27 | 1 | — |
| Midi 10 | 52,000 | 58 (26) | 0.36 | 2 | — |
| City 12 | 75,000 | 90 (34) | 0.46 | 3 | — |
| eCity 12 (electric) | 128,000 | 84 (32) | 0.17 × 0.75 price | 3 | reputation 45 |
| Decker 11 | 104,000 | 104 (78) | 0.55 | 2 | reputation 40 |
| Artic 18 | 132,000 | 145 (46) | 0.62 | 4 | reputation 60, or the *Mass transit* objective |

Resale value starts at 72% of the price and falls with age and wear.

## Running costs

Running costs accrue every simulated second and are posted to the ledger once per game hour, per line.

| Cost | Rate | When |
|---|---|---|
| Driver wages | 24 per staffed hour | any bus that is preparing, running, on layover, returning or broken down |
| Fuel | 1.0 per energy unit | per km driven |
| Electricity | 0.75 per energy unit | per km driven |
| Fleet fixed (insurance, licensing, cleaning) | 45 per bus per day | |
| Depot upkeep | 240 per depot per day | +120 per expansion |
| Stop upkeep | 3 per stop per day | |
| Maintenance | `price × serviceCost × (1 − condition) + 150` per service | City 12 at 70% condition ≈ 1,500 |

Buses wear by about 0.01% of condition per km. Below 45% condition they can break down on the road, and the chance grows as condition falls. Auto-service sends a bus to the depot below 70% by default. This is configurable, and a service takes about 3.2 minutes per condition point, at least 45 minutes.

## Fares and ridership

- **Fare:** one flat fare per journey, including transfers. The suggested fare is **1.8**, adjustable from 0.4 to 4.5 in Finances.
- **Who travels:** journeys come from the demand model (`src/game/passengers.ts`).
  - Residents, jobs, schools, shops and leisure are estimated from OpenStreetMap buildings and land use, then served within a 450 m walk of a stop.
  - Trip rates vary by purpose and by hour, and differ on weekdays and weekends.
- **Choosing the bus:** each traveller compares the bus with walking, and some also with a car or taxi, using a logit choice on *generalised time*. Generalised time is in-vehicle time, plus waiting, plus crowding and unreliability penalties, plus the fare.
  - Every 0.15 above the reference fare adds a minute of perceived journey time, so raising the fare earns more per rider but loses riders.
  - The car alternative slows with simulated traffic, so the bus wins more riders at rush hour.
- **Satisfaction:** each completed journey is scored on waiting (30%), journey time compared with a car (25%), crowding (15%), reliability (15%) and price (15%). There is a small penalty for each transfer. Passengers who give up waiting score very low.

## Reputation

Reputation (0–100) unlocks area licences and larger vehicles. At the end of every service day (03:00):
- It drifts towards the day's average satisfaction × 100. The drift is faster with more riders: 3–12% of the gap per day.
- It drops by 0.04 per missed departure, up to 4 points a day.
- Objectives can add a few points.

## Objectives and grants

| Objective | Reward |
|---|---|
| Open your first line (3+ stops, a bus) | +2 rep |
| First hundred passengers | 10,000 start-up grant |
| A busy day (1,000 journeys in a day) | 25,000 and +3 rep |
| Happy passengers (75% satisfaction, 300+ journeys) | +5 rep |
| Three profitable lines (yesterday) | 40,000 |
| Campus connection (university served by a line with 300 riders/day) | 15,000 and +2 rep |
| Health access (hospital served by a line with 300 riders/day) | 15,000 and +2 rep |
| Rush-hour reliability (85% on time, 60+ departures) | +4 rep |
| Room to grow (second area) | +2 rep |
| Across the city (stops in 3 areas) | 30,000 |
| A proper fleet (10 buses) | +2 rep |
| Mass transit (5,000 journeys in a day) | 80,000, +4 rep, unlocks the Artic 18 |

Grants are one-off income. They are **not** counted as operating income, so the operating result and line profitability only reflect fares and running costs.

## Loans, overdraft and bankruptcy

| Item | Value |
|---|---|
| Loan limit | 400,000 |
| Loan interest | 0.028% per day (~10% a year), charged daily |
| Overdraft | down to −200,000, at 0.12% per day |
| Warning | any day that ends in the red; the player is told how many days are left |
| Insolvency | after 7 days in the red, or below the overdraft limit. No new investment or loans; selling buses and earning fares still work |
| Recovery | ending a day with a positive balance clears the warning or insolvency |
| Bankruptcy | still insolvent 7 days after that (14 days in the red), or declared by the player. The game ends with a summary screen |

## What a line earns (reference runs)

These come from `src/game/test/balance.test.ts`: real Istanbul streets, the default fare, 4 × City 12, the timetable fitted to the fleet.

| Network | Riders/day | Operating result/day |
|---|---|---|
| 8 stops, Taksim → Karaköy, 4 buses, about 14 min headway | ~4,300 (weekday ~4,700) | **about +6,000** |
| 3 stops, same 4 buses | ~170 | **about −2,100** |
| Progression bot: 2 average lines, 6 buses, 2 areas (see `progression.test.ts`) | ~3,200 weekdays, ~2,300 weekends | **about +2,000** |

A strong line repays a 75,000 bus in about two weeks of game time, before grants. An average network grows slowly, and loans (at about 10% a year) are the intended way to speed up. A badly planned line burns money quickly, and that is the main pressure on the player.

At the fastest speed a game day takes about 2 minutes (`SPEEDS` in `content.ts`), so a strong line pays for a bus in about half an hour of play.

The balance tests guard these properties:
- a sensible first line is operationally profitable every full day;
- an oversized fleet on a thin line loses money;
- the ledger reconciles.

## Known tuning questions

- Early growth leans on grants and loans. The progression test shows a scripted player expanding on day 0 (with a loan) and then growing steadily rather than stalling. If playtesting shows expansion still feels slow, the first levers are demand (`RATE` in `passengers.ts`) and vehicle prices, not the fare.
- History: on 2026-10-30 trip rates were raised 25% (to about 2.7 trips per person per day, all modes) and driver wages cut from 27 to 24 an hour. Before that, average lines barely covered their costs and the scripted player stalled after its first expansion.
- Weekend demand is lower (shopping and leisure up, work down). Lines tuned for weekday peaks run emptier on weekends, which is intended.
