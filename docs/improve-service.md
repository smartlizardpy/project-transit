# Improve service

**Satisfaction → Improve service** looks at why passengers are unhappy and proposes changes to fix it. You can test the changes on copies of your company, then apply them or undo them. Every change is one you could make yourself (moving or buying buses, timetables, route fixes), with the same rules. Nothing changes until you press **Apply**.

Screenshots of the owner's Barcelona company (day 69, 54% satisfaction) are in `docs/screenshots/improve-service/`.

## What it looks at

`diagnose(game)` reads the last 7 complete days, or today so far for a new company, and finds:

- **Satisfaction and its five parts**: waiting, journey time, space on board, reliability and fares. The weights are in [economy.md](economy.md#fares-and-ridership).
- **The causes that cost the most**, in order:
  - travellers stranded with no bus home, and whether that happened while buses were running or after service stopped;
  - long waits (the network's average wait and its typical headways);
  - slow journeys;
  - passengers left behind by full buses, and on which line;
  - missed departures;
  - loop lines;
  - the fare.
- **Each line**:
  - its buses, and how many its timetable needs;
  - riders a day and the average wait;
  - how many gave up, were left behind, or missed a departure;
  - its headways today.

## The plan

`planService(game)` builds a list of steps. You can switch each step off before testing or applying.

| Step | What it does | Rules |
|---|---|---|
| **More buses on a line** | Gives buses to the line where one more bus saves the most waiting. | Spare buses come first. Next, a bus from a line that does not need it: a line gives a bus only if no part of its day then runs less often, and lines with an active service plan never give one. Last, a new bus, of the model the line already runs (one size up if its buses are full at the busiest hour). The plan buys only if a week of running costs, or at least 60,000, stays in the bank, and only if a depot has room. Bought buses are parked at the depot nearest the line. |
| **Use the buses it has** | Fits a line's timetable to its buses and riders. | It runs the line more often in bands where people travel, never more than the buses can keep up. It runs the line less often only where the timetable needs more buses than the line has, which would miss departures anyway. It never goes below every 4 minutes, and adds no departures where they would carry fewer than about 10 riders. |
| **A shorter route** | The best fix from the [route check](route-diagnostics.md) for a detour or a one-way problem, if it saves at least 200 m per round trip. | It is switched off by default if it moves or builds a stop, because other lines use the stops too. Look at it in the route check first. |

Moving a bus uses the normal handover: the bus finishes the trips it has, then joins its new line. Timetables keep their service plans. A change the plan makes counts as your own, so automations do not undo it for 24 game hours ([automation-api.md](automation-api.md#safety-rules)).

The plan's estimate of "fewer minutes of waiting a day" is a model, not a measurement. It uses half the headway as the expected wait for buses every 12 minutes or more often. For less frequent buses it uses 4 + headway / 8, because people time their arrival. It averages 5 weekdays and 2 weekend days, using the last 7 days' riders by hour. The test below measures the result.

### Tuning (assumed values)

These numbers are judgement calls, not measurements, except where the table says otherwise. Change them in `src/game/optimise.ts`.

| Value | Setting | Why |
|---|---|---|
| Shortest headway proposed | 4 min | Shorter headways bunch. |
| Spare time in a new or repaired timetable | 10% of the round trip | **Measured:** a timetable fitted exactly to Line 4's three buses in the Barcelona save missed 2–4 departures an hour. With busier buses, stops take longer, buses arrive late and miss the next departure. A timetable that already works is left alone. |
| Riders per departure before adding departures | about 10 | Departures that carry almost nobody cost money and help little. |
| Least saving to move a bus | 60 waiting minutes a day | Below that, the change is noise. |
| Least saving to buy a bus | 400 waiting minutes a day | Buying costs money. |
| Most buses bought in one plan | 6 | |
| Money kept back when buying | the larger of 60,000 and 7 days of running costs | |
| History read | 7 days | |

## Try it first

**Test on a copy** plays the next 6 or 24 game hours twice on copies of the company: once as it is, and once with the chosen steps. It compares:

- satisfaction, the waiting score and the journey-time score;
- the average wait;
- journeys completed;
- passengers who gave up or were stranded;
- passengers left behind by full buses;
- missed departures;
- the operating result;
- each line's riders and average wait.

Your company is not touched (`improve.test.ts` checks that). As in the [Simulation Lab](automation-api.md#simulation-lab), the result is one possible future, measured, and not a forecast.

## Apply and undo

**Apply** checks each step against the company as it is now. If something changed since the plan was made, for example a bus was moved or sold, that step is refused and says why. **Undo** puts back the timetables, the routes and where the buses were. Buses bought for the plan stay in your fleet.

New timetables start at once. For about an hour, buses that are still getting into place can miss some departures. The panel says so.

## Measured results

From `improve.test.ts`, a test company with a busy line on two small buses, a loop line with a bus it does not use, and two spare buses. The plan moves both spares and the loop's idle bus to the busy line. Next 24 hours:

| | Without | With |
|---|---|---|
| Average wait | 7.7 min | 6.0 min |
| Satisfaction | 60.6% | 70.4% |
| Waiting score | 56.9 | 65.2 |
| Journey-time score | 35.5 | 57.2 |
| Journeys completed | 2,568 | 4,205 |
| Operating result | 2,042 | 3,257 |

The owner's Barcelona save, day 69 at 22:10, in the production build. The plan gives Line 7 the three spare buses, and fits the other lines' timetables to their buses. Next 24 hours:

| | Without | With |
|---|---|---|
| Satisfaction | 62% | 74% |
| Average wait | 6.6 min | 4.2 min |
| Journeys completed | 5,911 | 12,318 |
| Gave up or stranded | 447 | 402 |
| Left behind by full buses | 556 | 1,808 |
| Departures missed | 9 | 23 (most of them in the first hour) |
| Operating result | €2,343 | €11,100 |

Line 7 carries almost four times as many riders, so more of them are left behind at the busiest hour. Larger buses would help, once a larger model is unlocked.

The save showed 54% before this update. The "without" column already includes the loop-line fix below, which is why it starts at 62%.

## Loop lines (fixed in the same update)

On a loop line (stops A → B → … → A), a traveller going from a later stop back to an earlier one had no itinerary. People who rode a loop out were stranded on the way home. In the Barcelona save that was about 1,800–2,000 people a day, mostly between 10:00 and 18:00, and each one scored almost zero for waiting and journey time. Travellers can now stay on the bus through the terminus and round the loop. This counts as one journey with no change, and the journey planner shows it as "round the loop through …" (`passengers.ts`, `computeItineraries`). `loops.test.ts` checks this: a loop now strands about as few people as a two-way line on the same streets (3, against 40 before the fix).

## AI agents

With live access on (Settings → AI agents), `live_improve_service` gives an agent the same diagnosis and plan. It is read-only: an agent cannot apply a plan. See the README.

## Files

| File | Role |
|---|---|
| `src/game/optimise.ts` | `diagnose`, `planService`, `applyPlan` (with undo), `testPlan` |
| `src/ui/ImproveService.tsx` | the panel |
| `src/ui/TopBar.tsx` | the **Improve service** button in the satisfaction popover |
| `src/game/automation/lab.ts` | `labTotals` and `labMetrics`, shared with the Simulation Lab |
| `src/game/test/improve.test.ts` | plan, apply, undo, fitting, buying only with money to spare, the test on copies |
| `src/game/test/loops.test.ts` | the loop-line fix |
