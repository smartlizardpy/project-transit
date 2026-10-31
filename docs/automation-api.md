# Automation API

How Automation Studio workflows run, what they can read and do, and the rules that keep them safe. The node and function tables at the end are generated from the code (`node scripts/dev/automation-reference.mjs`).

Engine code: `src/game/automation/` (types, registry, validate, executor, manage, templates, lab, live, events, city, watch, peaks, baseline) and `src/game/expr.ts`. Commands: `src/game/commands.ts`. Tests: `src/game/test/automation.test.ts`, `src/game/test/automation-city.test.ts`, `src/game/test/automation-forecast.test.ts`, `src/game/test/automation-triggers.test.ts`, `src/game/test/automation-peaks.test.ts`, `src/game/test/automation-programming.test.ts`, `src/game/test/commands.test.ts`.

## How a workflow runs

- A workflow is a graph of nodes saved with the company (`state.automation`). Connections carry values from an output to an input; each input takes one connection.
- **Game time only.** Schedules and conditions are checked once per game minute, inside the simulation step. Pausing the game pauses automation; faster speeds run it faster. Nothing uses wall-clock timers.
- **Simulation events** (a bus arrives, departs, breaks down; a full bus leaves people behind; a departure is missed; the day or the game week ends; tomorrow's forecast comes out at 18:00; the weather changes on the hour; an event is announced) are queued in the save and handled at the next game minute, so a reload neither loses nor repeats them. Events are only recorded when an enabled workflow listens for that kind.
- **One run** evaluates every enabled node in a fixed topological order. Nodes hanging off a trigger that did not fire receive *not active* and are skipped, as are nodes on the branch an If did not take. Nodes not attached to any trigger (shared data) run on every trigger. Data nodes have an optional **After** input: connect a trigger to it and the node reads its figures only when that trigger fired (the templates do this, so the canvas shows what starts what). The same state always gives the same result; runs are part of the deterministic simulation and continue identically after a reload (tested).
- **Validation** (`validate.ts`) runs before every run and live in the editor: required inputs, port types, loops, unknown or deleted lines/stops/buses/depots, expression syntax, size limits. An enabled workflow with problems records a failed run instead of acting.

## Trigger timing

Triggers that watch a condition (*Watch a figure*, *Many people waiting*, *People give up waiting*, *A line is short of buses*, *Balance falls below*) work like alert rules:

- **For at least N minutes**: the condition must hold that long before the trigger fires (0: straight away). While it builds up, the node on the canvas says so ("Building up: 6 of 10 min").
- **Fires once, then waits to clear**: after firing it fires again for the same line, stop or bus only once the condition has cleared. *Watch a figure* clears once the figure is back by a tenth of the value (or, if chosen, as soon as it is back); people waiting and giving up clear below 70% of the threshold; a line short of buses clears once it is covered; the balance clears a tenth (at least 1,000) above the amount.
- **From / Until / On**: hours of the day and every day, weekdays or weekends. Outside them nothing builds up and nothing fires.
- Half-built conditions start again when the workflow is switched off, all automation is paused, or the trigger's settings change (moving the node does not count). The state is saved, so a reload carries on at the same minute (tested).

Event triggers (*A bus arrives*, *A crowded bus leaves*, *A bus is running late*, *A departure is missed*, *A bus breaks down*, *People left behind*) take the same hours and days, and **At most once every N minutes** for each stop (arrivals, people left behind), line (crowded, late, missed) or bus (breakdowns). 0: every time.

Workflows saved before these settings existed behave as before: missing settings mean "straight away, all day, every time" (tested).

**Live status.** Each trigger on the canvas shows what it is doing in the running game: the current reading for condition triggers (for many lines or stops, the one closest to firing), *Watching*, *Building up*, *Fired, waits to clear*, the next time for schedules, when it last fired and how many times today. It reads the saved workflow, so it is the real state, not a preview.

### Watch a figure

One trigger for any figure the game keeps, checked every minute for each line, stop or bus (or the company), optionally only one line, its stops or its buses:

| Lines | Stops | Buses | The company |
|---|---|---|---|
| average load, last 3 hours; how full its buses are now; trips on time, last 3 hours; average delay now; people waiting for it; departures missed today; buses short of its timetable now; road traffic along it | people waiting; longest wait now; people who gave up, last hour | condition; how late it is; how full it is | reputation; passenger satisfaction today; balance; today's result so far |

Its outputs are the event, the line, stop or bus (or company) record with its live figures, and the figure. The event carries `figure`, `figureLabel`, `name`, `value`, `reading` (formatted), `threshold`, `op`, `for`, and `line`, `lineNumber`, `stop`, `stopName`, `vehicle`, `fleetNo` where they apply.

## Peak hours and sharing buses

Lines that are busy at different times can share buses: a spare waits at the depot, joins a line before its rush and parks again afterwards. The blocks for this (`peaks.ts`):

- **Peak hours** come from one of two sources. *Timetable*: the stretches of today's timetable that need clearly more buses than its quietest part (more than halfway from the fewest to the most); a timetable that needs the same buses all day has none. *Riders*: runs of hours clearly busier than the line's average hour, from the boardings recorded on the last 5 weekdays or 4 weekend days (whichever today is; all recent days if none of today's kind is recorded yet). Riders peaks need at least one full recorded day.
- **Peak hours start or end** (`trigger.peak`) fires once for each line and peak, a set time before it starts or after it ends, on the chosen days. A game loaded up to 15 minutes late still catches it. Its outputs: the event, the line, the peak and **buses to add or free** (before the start: buses the peak needs beyond those working; after the end: buses the line can spare for the next hour). The node on the canvas shows the next time it fires and for which line.
- **Peak hours** (`data.peaks`) lists each line's peaks with times and buses needed, the riders and buses needed hour by hour (from 03:00), and a sentence naming lines whose peaks never overlap ("Lines 1 and 4 peak at different times, so they could share buses").
- **Compare peaks** (`logic.comparePeaks`) says whether two lines' peaks overlap, by how long, and how many buses line B could lend line A during all of A's peaks without falling below its own timetable.
- **Buses to borrow** (`data.borrow`) finds buses that could join a line now and stay until its peak ends (or for the next hour): spares parked at a depot first, then buses of other lines that those lines will not need before then, soonest first. A line lends only what it can spare until then; a bus carrying passengers between trips is never taken.
- **Buses** has two more choices: *Spare and parked at a depot* and *Not needed by their line for the next hour* (at most as many as the line can spare: parked first, then idle, then the ones whose trips end soonest).
- **After the trips it already has.** A bus on a line usually already has its next trip or two. *Move bus to line* and *Park bus at its depot* wait for those by default: the bus takes no new trips, runs the ones it was given, then moves. Moving it straight away instead hands its unstarted trips back to the line, which can miss departures if the buses that stay cannot reach them in time (measured: parking four buses straight away after a peak cost 4 missed departures in the next two hours; after their trips, none). The bus panel says when a bus is waiting to move and which workflow asked. Moving the bus by hand cancels the wait. Saved with the game.

Tested in `automation-peaks.test.ts`: peaks from a two-peak timetable; riders peaks after a recorded day; the trigger fires once per line and peak at the right minute, after the end and only on its days; borrowing takes the parked spare first and then a bus from a line with a different peak, and that line misses nothing; parking after the peak leaves exactly what the timetable needs and no departure is missed; comparing peaks; the move after a bus's trips survives a save.

## Building your own strategies

Small blocks that combine, rather than one block that decides for you: read what is unusual, where people travel and what the forecast says, combine lists, then plan capacity ahead.

- **Compare with a normal day** (`data.baseline`, `baseline.ts`) compares a figure over the last full hour, the last three hours or today so far with the same clock hours on comparable recorded days: the same day of the week (the last 4 within 28 days), the same kind of day, weekday or weekend (the last 5 within 14 days), or every day of the last week. Figures: boardings, how full the buses were, average delay, missed departures and fares on a line; boardings, people waiting at the end of the hour and people giving up at a stop; journeys and people giving up on the whole network. Outputs `change` (% above normal, negative below; nothing when it is normally zero), `now`, `normal`, and with no line or stop chosen every one, most above normal first. *Skip when normally below* leaves out small figures, where 2 boardings becoming 6 would read as +200%. Days recorded part-way (the first day after an update) are left out. With nothing recorded yet it says so ("No Monday recorded yet to compare with").
- **Passenger journeys** (`data.journeys`) reads Network Control's recorded journeys from origin to destination (`odMatrix`), between stops or between areas, a day on average over yesterday, the last 7 or 28 days, or today so far; optionally only the same kind of day as today, one time band, journeys using one line, or from or to a stop or an area. Each journey row has the people a day, how many gave up, the average journey and wait, the share who changed bus and the lines most of them used. *Where they start* and *Where they go* list stops (connectable wherever a stop is wanted) or areas.
- **Group by** (`logic.groupBy`) sorts a list into groups that share a field (buses by line or depot, stops by `area`, journeys by `to`), with a count, total, average, smallest or largest of another field, biggest first. A key that is one of your lines, depots or stops is named, and a group of a line stands for that line.
- **Join lists** (`logic.join`) matches two lists on a field (a record in that field matches by its `id`) and adds the match to each item of list A under a name, `match` by default; it can keep items without a match. **Dotted field names** (`match.riders`, `now.capacity`) now work in Sort, Pick the highest or lowest, Summarise list, Group by, Join lists and Get field.
- **Schedule extra departure** (`action.scheduleExtra`, command `schedule_extra`) plans an extra trip for a time of day (the next one) or a number of minutes from now, from 10 minutes to 24 hours ahead, moved earlier or later by a set number of minutes. A time can also come from a connected text ("17:30"), a number (minutes from now) or a peak (its start). Up to 12 can be planned on one line. At most one bus is asked for; otherwise:
  - The timetable is dispatched first, and an extra only takes a bus that is free (no trip and none to come): the bus asked for if it is free in time (waited for until 20 minutes before), else the line's own free bus or a spare, whichever can be there first (a spare counts as two minutes slower). So an extra never takes a bus the timetable needs (tested on a line whose two buses are always busy: the extra is dropped, and the line misses exactly the same timetable departures as the same game without it).
  - With no free bus by its time it is dropped, the player is told, and it is not counted as a missed departure. A spare returns to its depot afterwards.
  - It stays through timetable changes and saves. At the same minute as another departure in that direction it leaves a minute later and says so, so the timetable's own departure is not merged away.
  - The line panel lists planned extras with who asked and the bus on its way; cancelling one by hand stops automations planning that departure again for 24 game hours. Each departure time is its own target, so two workflows planning different times on one line do not count as disagreeing; planning a time that is already planned changes nothing.
- New fields: a line's `capacity` (average places on its buses), a stop's `area` and `areaId`, and in the demand forecast each line's `busiestIn` (minutes until its busiest hour, 0 when it is this hour) and `busiestPerDeparture`, with `in` in each hour.

Worked example, the starter workflow *Predictive extra departures*: Every hour → Demand forecast (3 hours) and All lines → Join lists (`id` = `id`, as `now`) → Calculate for each `round(pct(item.busiestPerDeparture, item.now.capacity))` → Filter `item.value >= 90` → Pick the highest → Schedule extra departure in `max(15, a.busiestIn + 10)` minutes. Measured on the busy test line (seed 21) at 06:00: the forecast gives 48.8 boardings for each departure in the 07:00 hour against buses of 34 places, 144%, so it plans an extra at 07:10; run again at 05:30 or 06:00 it is the same departure and nothing is added. The formula is the player's to change.

Tested in `automation-programming.test.ts`: an extra runs at its time with the bus asked for, survives a timetable change and a save, and the spare goes home; with no free bus it is dropped without a missed departure; notice and range checks; two workflows plan different times on one line; times from text, minutes and a peak with a shift, tomorrow once passed, and a cancelled extra is blocked; the baseline worked by hand on recorded days (same weekday, same kind of day, last week, a ratio, nothing recorded yet); journeys between stops and areas, busiest first, narrowed to one stop; Group by and Join lists with dotted names; the six new starter workflows validate, and the predictive one's figures match its formula.

## Values and records

Values are numbers, yes/no, text, records and lists. Records are plain objects with a `kind`.

| Record | Fields |
|---|---|
| line | `id`, `number`, `name`, `colour`, `buses`, `needed` (peak requirement), `running`, `capacity` (average places on its buses, or `null` with none), `occupancy` (% average of buses on a trip now), `waiting`, `delay` (min, average), `headway` (min, now), `suspended`, `onTime3h` (%), `load3h` (%), `boardingsToday`, `tripsToday`, `missedToday`, `plan` (the service plan running today, or `null` for the normal timetable), `plans` (names of the enabled plans), `holidayPlan` (has an enabled school-holidays plan), `congestion` (% simulated traffic along the line), `neededNow` (buses the timetable needs at this moment), `working` (buses on the line not under maintenance, broken down or leaving), `short` (buses short of the timetable now; 0 when suspended), `neededSoon` (most buses needed in the next hour), `neededMax` (most today), `spareNow` (working buses it can do without for the next hour), `peakHours` (timetable peaks today in words, e.g. "07:00–09:00 and 16:00–18:00"), `inPeak`, `nextPeak` (HH:MM, or empty), `nextPeakIn` (min, or `null`), `busiestHours` (riders peaks in words) |
| stop | `id`, `name`, `area` (its area's name), `areaId`, `waiting`, `longestWait` (min), `lines` (numbers), `boardingsToday`, `gaveUpToday`, `avgWaitToday` (min), `gaveUpHour` (people who gave up here in the last 60 minutes), `leftBehindToday` |
| bus (`vehicle`) | `id`, `fleetNo`, `model`, `capacity`, `line`, `lineNumber`, `status`, `statusLabel`, `load`, `occupancy` (%), `condition` (%), `delay` (min), `depot`, `depotName`, `spare`, `free` (could start an extra trip now), `carrying` |
| peak (`trigger.peak`, `data.peaks`) | `line`, `lineNumber`, `name`, `from`, `to` (HH:MM), `period`, `minutes`, `need` (buses), `has` (working now), `short`, `riders` (average boardings an hour, riders peaks), `source`, `now` (under way), `startsIn` (min). Connected where a line is wanted, it stands for its line. |
| hour (`data.peaks` hour by hour) | `hour`, `time`, `riders` (average boardings), `need` (buses the timetable needs) |
| company | `balance`, `reputation`, `level`, `fare`, `resultToday`, `buses`, `lines`, `satisfactionToday` (% of today's finished journeys, or `null`), `spareBuses` (buses with no line) |
| week summary (end-of-week trigger) | `week`, `year`, `season`, `days`, `journeys`, `gaveUp`, `fares`, `satisfaction` (%), `journeysPerDay`, `journeysChange` and `faresChange` (% a day on the week before, `null` for the first week), `changeText` (the change in words), `wetDays`, `busiestLine`, `busiestLineBoardings` |
| time | `t`, `time` (HH:MM), `hour`, `minute`, `weekday`, `weekend`, `day` |
| event | depends on the trigger, e.g. `vehicle`, `fleetNo`, `line`, `lineNumber`, `stop`, `stopName`, `load`, `occupancy`, `delay`, `trip`; the left-behind event carries `leftBehind`; the give-up event `gaveUp`; the short-of-buses event `short`, `needed`, `buses`; the end-of-day event carries the day's `boardings`, `journeys`, `gaveUp`, `trips`, `missed`, `onTime`, `satisfaction`, `fares`, `costs`, `result`; city event triggers carry `event`, `eventKind`, `eventTitle`, `venue`, `people`, `start`, `end`, `when`, `reason`; the forecast trigger carries the forecast fields below; the weather trigger carries `from`, `to` (0 dry, 1 light rain, 2 rain, 3 heavy rain, 4 snow), `label`, `wasLabel`, `time`, `temp` |
| event details (`event` record from the event triggers and `data.events`) | `id`, `type` (football, concert, festival, gathering, rail, flight), `label`, `title`, `venue`, `place`, `people` (expected), `day`, `start`, `end` (HH:MM, with extra time once known), `when`, `startsIn`, `endsIn` (min), `underWay`, `over`, `cancelled`, `reason`, `lines` (how many of your lines are within 1 km; for a rail disruption, within 600 m of the closed stations) |
| weather now | `condition` (0–4 as above), `label`, `raining`, `heavy`, `snow`, `temp` (°C), `rain` (mm this hour) |
| weather today | `type`, `label`, `high`, `low`, `rain` (mm in the day), `wet` |
| forecast (tomorrow, from 18:00) | `type`, `label`, `high`, `low`, `chanceOfRain` (%), `wet`, `storm` (heavy rain or snow), `hot` (32 °C or more). About 8 forecasts in 10 are right. |
| calendar | `season`, `week` (of the 12-week year), `seasonWeek`, `year`, `weekend`, `publicHoliday`, `schoolDay`, `schoolHolidays`, `university` (teaching, exams, break), `festive`, `label`. The calendar is a typical pattern, not real dates. |
| place (`data.place`) | `id`, `name`, `category`, `size` (with its source's wording, e.g. "about 1,200 beds"), `tier` (1 largest … 5), `nearestStop`, `nearestStopId`, `walk` (m to your nearest stop), `served` (a stop within 400 m), `lines` (ids of your lines stopping within 400 m), `tripsToday` and `byYourNetwork` (the model's estimate of trips to and from it today), `thisHour` (modelled arrivals and departures this hour), `busyNow` (% of its busiest hour), `estimate` (true) |
| forecast line (`data.demandForecast`) | `id`, `number`, `name`, `label`, `riders` (expected boardings in the window), `busiestHour`, `busiest`, `busiestIn` (min until that hour, 0 when it is this hour), `busiestPerDeparture`, `hours` (per hour: `time`, `in` (min from now), `riders`, `departures` timetabled, `perDeparture`), `estimate` (true). The network output `hours` has `time`, `boardings`, `journeys`, `goingHome` |
| journey (`data.journeys`) | `from`, `to`, `fromId`, `toId`, `label` ("A → B", or "Within A" for trips inside one area), `within`, `journeys` (a day), `gaveUp` (a day), `journeyMin`, `waitMin` (average), `changedPct` (% who changed bus), `usual` (the lines and transfer most took, in words), `lines` (their numbers), `value` (= `journeys`) |
| journey end (`data.journeys` origins and destinations) | `kind` `stop` or `area`, `id`, `name`, `journeys` (a day) |
| compared (`data.baseline`) | the line or stop record (or `network`) with `now`, `normal`, `change` (%), `compared` (days), `hours` (e.g. "17:00–18:00"), `baseline` (in words, e.g. "Taksim: 150 boardings 17:00–18:00, 50% more than a normal Monday (100 boardings on average over 2 days)") |
| group (`logic.groupBy`) | `key`, `name`, `count`, `value` (the count, or the total, average, smallest or largest asked for), `items`; a group of a line also has `line` and `lineNumber`, of a depot `depot` |
| unserved connection (`data.unserved`) | `from`, `to`, `label`, `trips` (a day, every mode and purpose), `missing` (`stop`: no stop within a walk of one end; `line`: stops at both ends but no line between them), `estimate` (true) |

## Control room

Blocks for running the service minute by minute: where the buses are relative to each other, who is about to miss a connection, how full the next departures will be, and actions that change what a bus or a departure does. Each action is a command with a plain-language dry run (`operations.ts`), carried out by the vehicle and timetable simulation itself; nothing is a relabelled figure.

**Reading the network** (`automation/ops.ts`)

- **Gaps between buses** (`data.gaps`) and the trigger **Buses bunch or a gap opens** (`trigger.bunching`): the buses on trips on a line, ordered along each direction, with the gap to the bus ahead and behind in *timetable* minutes (where each bus is on its schedule, so a slow road on its own does not count as bunching), the line's timetable gap, and `hold`: the minutes that would put a bus half way between its neighbours (0–10). *Close together* is under a share of the timetable gap (35% by default), a *big gap* over a share (160%). `turnBacks` lists late buses (3+ min) going the other way that could turn back at a stop lying inside the gap. The trigger fires per line once the condition has held for its *for at least* time and again only once the line is back to normal (a gap under 85% of the setting).
- **Connections at risk** (`data.connections`): people on board now whose own journey plan changes to another of your lines at a stop ahead, with the bus's predicted arrival there (`eta.ts`, the same times as the stop boards) against the connecting line's predicted departures. `missed` when the departure they want leaves before they can get across (30 s), `margin` in minutes, `holdNeeded` (minutes the connecting bus would have to wait), `connectingBus` and `waitIfMissed`. An estimate: traffic changes the times.
- **How full departures will be** (`data.occupancyForecast`): the line's next departures (time, bus, direction, `moved` if a departure was moved) with expected boardings and `occupancy` at the fullest point. The demand forecast for each hour is split by direction as people rode in that hour on recent days, shared between that hour's departures in that direction, and scaled by the line's recorded peak load against its boardings per trip (a typical 0.6 is assumed, and said, until six trips are recorded). An estimate.
- **Stops nearby** (`data.nearbyStops`) near a place, stop, bus, event or any record with `lng` and `lat` (stop, place and event records now carry them); the walk is the straight line plus a quarter. **Road route between** (`data.roadRoute`): the router's quickest legal route between two places, at free-flow speed and in the traffic and weather now. **Coverage** (`data.coverage`): the share of residents and jobs in your areas (from the map's land-use grid) within a walk of your stops or a line's stops, and the biggest grid cells left out with their area and position. **Where lines meet** (`data.transfers`): pairs of lines at the same stop or stops a short walk apart, with the average wait for the second line (half its timetable gap now) and the changes people made there a day over the last week (from recorded journeys).

**Actions**

| Block | Command | What happens in the simulation |
|---|---|---|
| Hold a bus (`action.hold`) | `hold_vehicle` | After its normal stop at the chosen (or next) stop on its current or coming trip, the bus keeps its doors open for 1–10 min, boarding anyone who arrives, then carries on. A bus from *Gaps between buses* brings its `hold`; a connection holds the connecting bus at the connection's stop for `holdNeeded`. Capped by *Never longer than* (5 min by default). The bus panel shows it, with *Call off*. |
| Turn a bus back early (`action.shortTurn`) | `short_turn` | On a two-way line, the bus ends its trip at a stop ahead (everyone gets off; those going further are re-planned from that stop with the fare they already paid), the trip counts as run, the bus's next reserved trip is released for another bus, and it runs back in the other direction from that stop as an extra trip that starts part-way, leaving at the next whole minute it can be ready. Refused on loops, for stops behind the bus or at the end, and for stops the other direction does not serve. *Only if at most* N people would have to change (15). |
| Move a departure (`action.adjustDeparture`) | `adjust_departure` | One timetable departure leaves up to 15 min from its timetable time, earlier or later, not sooner than 5 min from now, not within a minute of another departure in that direction, and earlier only if the bus given it is back in time. Its timetable slot is not filled again; a timetable change puts it back. |
| Temporary detour (`action.detour`) | `detour`, `end_detour` | Every stretch of the line between two stops that passes within 100–800 m of a centre (a place, event or stop) takes the router's quickest road between the same two stops that stays out of the area, pinned with two waypoints. Stops stay the same (a bus may use the stop's other side of the road, as people wait by stop); a stretch is left as it is if a stop is inside the area, no other road links the stops, or the way round takes over three times as long (+5 min). Each stretch switches over only once no bus is driving it, and back when the 15 min–6 h are up or it is ended; buses on the line keep their place. While on a detour, editing the line's route is refused with the reason. The line panel shows it, with *End now*. |
| Suggest a route change (`action.proposeRoute`) | `change_route` | Add a stop to a line where it adds the least distance (every position is tried with the line's waypoints kept), take a stop off a line, or a new line through a list of stops. A connection from *Unserved trips* now carries `fromStop`, `toStop` and `stops`: your stops along the quickest road between the two areas' best-placed stops (within 150 m of it, at least 300 m apart). The dry run gives the kilometres, minutes a trip and buses needed at the busiest time before and after. **Always a suggestion**, whatever the workflow's mode, open for 3 game days. |

**Timing and choosing**

- **Wait** (`logic.wait`) pauses the workflow at the node: for a number of minutes (1–720), or until a figure from *Watch a figure* for the line, stop or bus passed in is above or below a value (checked each minute, giving up after 5–720 min down *Gave up*). If the figure is already there it carries straight on. When it carries on, only the nodes after it run, plus data and logic nodes they read that do not come before it; nothing before it runs again, so no action is repeated. Lines, stops and buses passed through come out with fresh figures. The state is saved (`automation.pending`), so a reload carries on exactly where it was; at most 30 waits per workflow and 200 in all; switching a workflow off ends its waits. A test run carries straight on and says how long a real run would wait. Not allowed inside functions.
- **One at a time** (`logic.queue`) keeps a queue in the workflow's memory and passes on 1–10 items at most once every N minutes, carrying on by itself (like a Wait) until none are left; an item already queued, or passed on within *Do not take the same one again for*, is not added again. At most 50 queued.
- **Best pairs** (`logic.assign`) pairs list A with list B for the lowest (or highest) total of a score expression with `a`, `b` and `km` (the distance between them; to a line, the distance to its nearest stop), with the Hungarian method: all pairs are chosen together, so it does not take a cheap first pair that makes the rest expensive. At most 30 × 30 items. A pair stands for its bus, line or stop where one is wanted, so it connects straight to *Move bus to line*.

Tested in `automation-operations.test.ts` (26 tests): a held bus stays at least the hold and less than three minutes more; a bus turned back ends its trip at that stop, runs the other direction from there and finishes, with no missed departure; a departure moved by +5 runs then and its slot is not refilled, and a total over 15 min is refused; a detour keeps the stops, keeps the changed stretch more than the radius from the centre, blocks route edits and restores the line's waypoints afterwards, with no missed departure; a route change from an automatic workflow allowed big changes is still only suggested, open for three days, and approving it changes the line; a seven-minute hold makes the bus behind bunch, which *Gaps between buses* and the trigger see, and the trigger's workflow holds that bus; Wait carries on after 20 min without running the action before it again, *until* gives up on time, and One at a time passes three buses on one by one; Best pairs beats the greedy answer; and the new starter workflows validate and work (*Even out bunched buses* holds for at most 4 min; *Service worn buses one at a time* sends one bus at 09:00, none more by 09:40, two or three by 11:00; *Send spare buses…* moves a parked bus to a line with none at 06:00; *Check back after an extra bus* carries on 30 min after each extra without running another, measured on the busy test line on day 2).

All figures are read from the live simulation or from Network Control's recorded analytics; none are invented. The three estimate blocks (`data.place`'s trips and busyness, `data.demandForecast`, `data.unserved`) come from the demand model and say so: the forecast uses the lines running in each hour, today's weather (which the player sees hour by hour), events already announced, people already out who are due home and the expected returns of trips starting in the window. It stops at midnight and never changes the simulation (tested). Measured against what then happened on a two-line network: within about 15% over three hours once the day's punctuality is known, high by up to a half on a weekday morning forecast before 07:00 (the model does not yet know the buses will run late). When a figure is unavailable it is `null`, and comparisons with `null` are false.

## Actions and the shared command layer

Every action node asks for a **command** (`commands.ts`): `assign_vehicle`, `dispatch_extra`, `schedule_extra`, `set_headway`, `suspend_line`, `service_plan`, `set_fare`, `service_vehicle`, `move_depot`, `hold_vehicle`, `adjust_departure`, `short_turn`, `detour`, `end_detour`, `change_route`. The player's own buttons use the same game methods, and `checkCommand` is a pure dry run that explains in plain words what would happen (for example: a bus carrying passengers finishes its trip, returns to its depot and then joins the new line; or, moved after its trips, "runs the trips it already has on Line 1 (until about 09:52), so none is missed, then parks at its depot as a spare"). Automations cannot do anything the player could not do, and they never bypass the simulation's rules: an extra departure is a real trip that a real bus prepares for, drives to and runs.

## Modes

| Mode | What actions do |
|---|---|
| Observe | Nothing changes. The run records what each action would have done. |
| Suggest | Each action becomes a suggestion in Network Control → Automation. It is checked again when you approve it, and expires after 30 game minutes. |
| Automatic | Actions run within the limits below. **Big changes** (frequency, fare, suspending a line, switching a service plan) still become suggestions unless the workflow is allowed to make big changes. **Route changes** (`change_route`) are always suggestions, open for 3 game days. |

A **test run** from the editor never changes the game or the workflow's memory; it describes what the actions would do.

## Safety rules

| Rule | Default |
|---|---|
| Runs per game hour, per workflow | 60 (adjustable 1–120); further runs that hour are recorded as limited |
| Actions per game day, per workflow | 40 |
| Spending per game day, per workflow (extra departures, maintenance) | 2,000 in the company's currency |
| Cooldown on the same action and target, per workflow | 30 game minutes |
| Actions per run | 10 |
| Work per run (node evaluations and list items) | 5,000 steps; the run stops with a message beyond that |
| Workflow runs per game minute, all workflows | 30 |
| Notifications per workflow per game hour | 6 |
| Function calls nested | 3 deep |
| Workflow size | 200 nodes, 400 connections; 60 workflows |
| Failed runs in a row before a workflow switches itself off (with a notification saying why) | 5 |

- **Duplicates**: the same request twice in one run, the same action another workflow took in the last 30 game minutes, or an identical open suggestion is recorded as *already done* instead of repeated.
- **Conflicts**: if another workflow changed the same thing in the opposite way (for example moved the same bus to a different line) within the last 24 game hours, the action is blocked, both workflows' history says why, and the player gets one notification per pair per hour (the throttle is saved, so a reload sends exactly the same notices). The first workflow in the list wins, so the result is always the same.
- **Your own changes win**: a change you make by hand (bus assignment, depot, timetable, suspension, fare, cancelling a planned extra departure) blocks automations from undoing it for 24 game hours.
- **History**: the latest 300 runs are kept; the node-by-node trace (inputs, outputs, and why a condition was true or false) is kept for each workflow's latest 3 runs.

## Simulation Lab

`lab.ts` copies the saved company twice in memory, runs one copy without the workflow and one with it for 2–24 game hours, and compares journeys, boardings, abandoned journeys, trips, missed departures, punctuality, waiting, load, satisfaction, passengers left behind, fares and the change in balance. The live game is untouched (tested). Both copies use the same random seed, and other workflows run in both. The figures are measured in the copies, but they are one possible future: once the workflow changes something the copies drift apart, so small differences can be chance. It is not a forecast.

## Expressions (Expression API v1)

Used by the Expression, Filter and Calculate-for-each nodes and by custom metrics.

- Numbers, `"text"`, `true`, `false`, `null`; arithmetic `+ - * / % **`; comparisons `== != < <= > >=`; `and`, `or`, `not` (also `&& || !`); `condition ? a : b`; parentheses; field access `line.occupancy` and `list[0]`, list literals `[1, 2]`; function calls from the table below.
- Dividing by zero gives `null`. Comparisons involving `null` are false. Missing fields are `null`.
- **Sandbox**: expressions are parsed by the game's own interpreter. There is no `eval` or `Function`, and no route to JavaScript objects, the file system, the network, Tauri commands or the page. `__proto__`, `prototype` and `constructor` are refused. Every evaluation has a step budget and size limits (below), so an expression cannot hang the game.

## Starter workflows

Automation Studio offers 49 starter workflows (`templates.ts`), grouped in the gallery. Each is an ordinary workflow built from the nodes below and can be changed freely. They start in the mode shown and switched off.

| Group | Workflows |
|---|---|
| Crowding and waiting | Extra bus when a line is crowded (observe) · Watch every line for crowding (suggest) · Busy hour ahead (automatic) · Extra bus when people are left behind (suggest) · Crowded stop alert (automatic) · People giving up at a stop (automatic) · Move a bus from a quiet line to a busy one (suggest) |
| Reliability | Tell me when a bus runs late (automatic) · Warn me when a line is short of buses (automatic) · Send a spare bus to a line that is short (suggest) · Unreliable line alert (automatic) · Tell me when a whole line runs late (automatic) · Missed departures at the end of the day (automatic) |
| Control room | Even out bunched buses (observe) · Hold for people changing lines (observe) · Turn a late bus back into a gap (observe) · Extra bus before a crowded departure (observe) · Wait for the crowd after an event (observe) · Drive round a big event (observe) · Send spare buses to lines short of buses (observe) · Check back after an extra bus (observe) · Service worn buses one at a time (observe) · Suggest a line for an unserved corridor (suggest) · Weekly coverage report (automatic) |
| Peak hours and sharing buses | Bring in buses before a line's peak (suggest) · Park buses after a line's peak (suggest) · Warn me before a peak a line cannot cover (automatic) · Today's peak hours (automatic) · Extra trip as each busy hour starts (suggest) |
| Forecasts, normal days and journeys | Stops busier than a normal day (automatic) · Extra departure when a line is unusually busy (suggest) · Predictive extra departures (suggest) · Where passengers travel (automatic) |
| Fleet and maintenance | Cover a breakdown (suggest) · Service worn buses between the peaks (suggest) · Where buses are free at midday (automatic) |
| Money and reputation | Low balance warning (automatic) · Find out why reputation is falling (automatic) |
| Events, weather and the calendar | Extra buses for big events (suggest) · Rain plan when a storm is forecast (observe) · Extra bus when heavy rain starts (suggest) · Cover a rail disruption (suggest) · Events in the next three days (automatic) · School holidays check (automatic) · Early-morning airport boost (suggest) |
| Reports and briefings | Daily summary (automatic) · Unserved corridors report (automatic) · Weekly report (automatic) · Morning briefing (automatic) |

Tested (`automation-triggers.test.ts`): every template validates and test-runs without failing on a two-line company; *Move a bus from a quiet line to a busy one* only takes a free bus from a line with more working buses than its timetable needs (measured: one move, at 17:00 on the first day of the crowded test line); *Service worn buses between the peaks* sends a bus below 78% only from 09:00 (the game's own automatic service is at 70%).

## Reference (generated)

<!-- generated: node scripts/dev/automation-reference.mjs -->

### Nodes

#### Triggers

Start a workflow: on a schedule or when something happens in the game.

| Node | What it does | Inputs | Outputs | Settings |
|---|---|---|---|---|
| Every few minutes `trigger.every` | Runs on a regular game-time schedule, e.g. every 15 minutes. Pauses and speeds up with the game. | – | Event (event) | Every, From, Until, On |
| At a time of day `trigger.time` | Runs once a day at a set time. | – | Event (event) | At, On |
| End of the day `trigger.day` | Runs at midnight with the day that just ended: boardings, journeys, fares and costs. | – | Event (event), Day summary (record) | – |
| End of the week `trigger.week` | Runs at midnight when a game week ends, with the week’s journeys, fares and satisfaction and the change on the week before. | – | Event (event), Week summary (record) | – |
| A bus arrives at a stop `trigger.arrive` | Runs every time a bus on a trip reaches a stop (filter by line and stop). | – | Event (event), Bus (bus), Line (line), Stop (stop) | Line, Stop, At most once every, From, Until, On |
| A crowded bus leaves `trigger.crowded` | Runs when a bus leaves a stop at or above a load. | – | Event (event), Bus (bus), Line (line), Stop (stop) | Load at least, Line, At most once every, From, Until, On |
| A bus is running late `trigger.late` | Runs once per trip when a bus leaves a stop later than the threshold. | – | Event (event), Bus (bus), Line (line) | Late by at least, Line, At most once every, From, Until, On |
| A departure is missed `trigger.missed` | Runs when a timetabled departure does not run. | – | Event (event), Line (line) | Line, At most once every, From, Until, On |
| A bus breaks down `trigger.breakdown` | Runs when a bus breaks down. | – | Event (event), Bus (bus), Line (line) | Line, At most once every, From, Until, On |
| Many people waiting `trigger.waiting` | Runs when the number waiting at a stop rises above a threshold (again only after it has dropped well below). | – | Event (event), Stop (stop) | At least, On line, For at least, From, Until, On |
| Balance falls below `trigger.balance` | Runs when the bank balance drops below an amount. | – | Event (event), Company (record) | Below, For at least |
| Watch a figure `trigger.watch` | Runs when a figure goes above or below a value and stays there: a line’s load or punctuality, people waiting at a stop, a bus’s condition, your reputation… Checked every minute, for each line, stop or bus. It fires again only once the figure is back to normal. | – | Event (event), Line, stop or bus (record), Figure (number) | Watch, Only on line, When it goes, Value, For at least, Fire again, From, Until, On |
| A line is short of buses `trigger.shortBuses` | Runs when a line has fewer working buses than its timetable needs right now (buses under maintenance or broken down do not count). Every departure it cannot run is missed, and missed departures cost reputation. Fires again only once the line is covered. | – | Event (event), Line (line), Buses short (number) | Line, For at least, From, Until, On |
| Peak hours start or end `trigger.peak` | Runs for each line a set time before its peak hours start, or after they end. Peak hours come from its timetable (when it needs the most buses) or its riders (its busiest hours over the last week). Use it to bring in a spare bus before the rush and park it again afterwards. | – | Event (event), Line (line), Peak (record), Buses to add or free (number) | Line, When, How long, Peak hours from, On |
| People left behind `trigger.leftBehind` | Runs when a full bus leaves people behind at a stop. | – | Event (event), Bus (bus), Line (line), Stop (stop) | At least, Line, At most once every, From, Until, On |
| People give up waiting `trigger.gaveUp` | Runs when people waiting at a stop give up and travel another way: at least this many at one stop within the last hour. Fires again for that stop only once it has calmed down. | – | Event (event), Stop (stop) | At least, On line, For at least, From, Until, On |
| Tomorrow’s forecast `trigger.forecast` | Runs at 18:00 when tomorrow’s weather forecast comes out. About 8 forecasts in 10 are right; a miss is usually close. | – | Event (event), Forecast (record) | When it says |
| The weather changes `trigger.weather` | Runs on the hour when the weather changes: rain starts, heavy rain or snow starts, or it dries up. Roads are slower in rain and fewer people walk or cycle. | – | Event (event), Weather now (record) | When, From, Until |
| An event is announced `trigger.eventAnnounced` | Runs when a match, concert, festival or gathering is announced (usually 3 to 10 days ahead, short-notice ones the day before), or when a rail or flight disruption begins. | – | Event (event), Event details (record), Lines nearby (list) | Events, At least, Near line |
| Before an event starts `trigger.eventStart` | Runs a set time before an announced event starts, once per event. Crowds arrive over the three hours before a match. | – | Event (event), Event details (record), Lines nearby (list) | Minutes before, Events, At least, Near line |
| When an event ends `trigger.eventEnd` | Runs a set time before or after an event ends, once per event. Most people leave within half an hour of the end; a match may go to extra time. | – | Event (event), Event details (record), Lines nearby (list) | Minutes after the end, Events, At least, Near line |
| A kind of day `trigger.calendar` | Runs at a set time on days of a kind: school holidays, public holidays, exam weeks, weekends or a season. The calendar is a typical pattern, not real dates. | – | Event (event), Calendar (record) | On, At, Only the first day of a run |
| Run by hand `trigger.manual` | Runs when you press Run in Automation Studio. | – | Event (event) | – |
| Buses bunch or a gap opens `trigger.bunching` | Runs when two buses on a line run close together, or a big gap opens between two buses, measured in timetable minutes between them (so slow traffic on its own does not set it off). The bus that has caught up comes out with how long to hold it to even out the gaps, and any late bus going the other way that could turn back early to fill a gap. Fires again only once the line is back to normal. | – | Event (event), Line (line), Buses to hold (list), Could turn back (list), Timetable gap (number) | Line, When, Close together: under, Big gap: over, For at least, From, Until, On |

#### Data

Read live lines, stops, buses, the company and Network Control analytics.

| Node | What it does | Inputs | Outputs | Settings |
|---|---|---|---|---|
| All lines `data.lines` | Every line with its live figures: occupancy, waiting, buses, delay, on time. | After (anything, optional) | Lines (list) | – |
| Line `data.line` | One line and its live figures (pick it, or connect one). | After (anything, optional), Line (line, optional) | Line (line), Occupancy % (number), Waiting (number) | Line |
| Stops `data.stops` | Stops with the people waiting now and today’s figures (optionally one line’s stops). | After (anything, optional), Line (line, optional) | Stops (list) | Line |
| Stop `data.stop` | One stop: waiting now, longest wait, today’s boardings. | After (anything, optional), Stop (stop, optional) | Stop (stop), Waiting (number) | Stop |
| Buses `data.buses` | Buses with their status, load and condition. Filter by line or by what they are doing. | After (anything, optional), Line (line, optional) | Buses (list) | Line, Which |
| Bus `data.bus` | One bus: its line, what it is doing, load and condition (pick it, or connect one). | After (anything, optional), Bus (bus, optional) | Bus (bus), Passengers (number) | Bus |
| Find a free bus `data.findBus` | The bus that could start an extra trip on a line soonest: one of the line’s own idle buses, or a spare at a depot. Buses carrying passengers are never chosen. | Line (line, optional) | Bus (bus), Found (yes/no) | Line, Take from |
| Peak hours `data.peaks` | When lines are busiest today, from the timetable (the hours a line needs the most buses) or from riders (its busiest hours on recent days of the same kind). Each peak comes with its times and the buses it needs, plus riders and buses needed hour by hour, and a summary that points out lines whose peaks are at different times (they can share buses). | After (anything, optional), Line (line, optional) | Peaks (list), Biggest peak (record), Hour by hour (list), In words (text) | Line, Peak hours from |
| Buses to borrow `data.borrow` | Buses that could join a line now and stay until its peak is over: spare buses parked at a depot first, then buses other lines will not need until then (lines whose own peak is at another time). Never a bus carrying passengers, and never one its line still needs. | After (anything, optional), Line (line, optional), How many (number, optional) | Buses (list), First bus (bus), Lines that can lend (list), Found (yes/no) | Line, How many, Take from, Needed until |
| Company `data.company` | Balance, reputation, level, fare and today’s result. | After (anything, optional) | Company (record), Balance (number) | – |
| Time `data.time` | The game clock: time, hour, weekday, weekend. | After (anything, optional) | Time (record), Hour (number) | – |
| Weather `data.weather` | The weather now (rain, temperature), today’s weather and tomorrow’s forecast once it is out at 18:00. | After (anything, optional) | Now (record), Today (record), Tomorrow (forecast) (record), Raining now (yes/no), Temperature (number) | – |
| Calendar `data.calendar` | Today’s season and week, and the kind of day: weekend, public holiday, school day or holidays, university teaching, exams or break (a typical pattern). | After (anything, optional) | Calendar (record), School holidays (yes/no), Public holiday (yes/no) | – |
| Events `data.events` | Announced events under way or coming up, soonest first: matches, concerts, festivals, gatherings and disruptions. | After (anything, optional) | Events (list), Next event (record), How many (number) | Within, Events, Near line |
| Places `data.place` | Airports, stations, hospitals, universities, stadiums and other places of a kind, largest first: your nearest stop, the lines there, and the model’s estimate of trips today and how busy the place is this hour. | After (anything, optional) | Places (list), Largest (record), Lines at the largest (list), Not served (list), How many (number) | Kind, Near line, At most |
| Unserved trips `data.unserved` | The busiest connections between two of your areas that your network does not link today, from the demand model: trips a day by every mode and purpose, and whether a stop or a line is missing. | After (anything, optional) | Connections (list), Busiest (record), How many (number), Trips (number) | Busiest (estimate) |
| Demand forecast `data.demandForecast` | Expected riders per line for each of the next few hours, from the demand model: the lines running then, today’s weather, announced events and people due home. An estimate: riders also depend on how your buses perform. | After (anything, optional) | Lines (list), By hour (list), Busiest line (record), Riders (number) | Estimate for, Line |
| Network Control figure `data.analytics` | A measure from Network Control’s recorded history, e.g. average wait per stop over the last 7 days. | After (anything, optional) | Rows (list), Total (number) | Measure, For each, Days |
| Passenger journeys `data.journeys` | Where your passengers travel: recorded journeys from one stop or area to another (origin to destination), a day on average, with how many gave up, the average journey and wait, how many changed bus and the lines they used. Narrow it to journeys from or to a stop, on a line, on the same kind of day as today or at one time of day. | After (anything, optional), From (anything, optional), To (anything, optional), Using line (line, optional) | Journeys (list), Busiest (record), Where they start (list), Where they go (list), Journeys a day (number) | Between, From stop, To stop, Using line, Days, Kind of day, Setting off, Busiest |
| Compare with a normal day `data.baseline` | Is a figure unusual for the time of day? Compares the last hour (or three, or today so far) with the same hours on comparable recorded days: the same day of the week, the same kind of day, or every day last week. E.g. 140 boardings at a stop 17:00–18:00 against 92 on a normal Saturday is 52% more. With no line or stop chosen it compares each one, most unusual first. | After (anything, optional), Line or stop (anything or list, optional) | % above normal (number), Now (number), Normal (number), Each one (list), Most above normal (record), In words (text) | Figure, Line, Stop, Over, Against, Skip when normally below |
| Gaps between buses `data.gaps` | The buses on a line now, in order along each direction, with the time to the bus ahead and behind (in timetable minutes), the timetable gap, and how long each would have to wait to even out the gaps. Also late buses going the other way that could turn back early to fill a big gap. | After (anything, optional), Line (line, optional) | Buses (list), To hold (list), Could turn back (list), Timetable gap (number), Longest gap (number) | Line, Close together: under, Big gap: over |
| Connections at risk `data.connections` | People on your buses now who change to another of your lines at a stop ahead, and whether the bus they want leaves before they get there, from their own journey plans and the buses’ predicted times. `holdNeeded`: how many minutes the connecting bus would have to wait for them. An estimate: traffic can change it. | After (anything, optional), Arriving on line (line, optional) | Connections (list), Most people (record), People (number), How many (number) | Arriving on line, Arriving within, Show |
| How full departures will be `data.occupancyForecast` | A line’s next departures with the expected boardings and how full each bus will be at its fullest point: the demand forecast for each hour shared between that hour’s departures, scaled by how the line’s riders have been spread along it on recent days. An estimate: use it to spot a crowded departure before it leaves. | After (anything, optional), Line (line or list, optional) | Departures (list), Fullest (record), How many (number) | Line, Next, Within |
| Stops nearby `data.nearbyStops` | Your stops within a walk of a place, stop, bus or event, nearest first, with the lines at each and the people waiting. The walk is estimated as a quarter longer than the straight line. | After (anything, optional), Near (anything) | Stops (list), Nearest (record), Lines there (list), How many (number) | Within a walk of, At most |
| Road route between `data.roadRoute` | The quickest legal road route a bus could take between two places: distance, minutes at free-flow speed, and minutes in the traffic and weather now. Use it to check whether a detour or a new link is worth it. | After (anything, optional), From (anything), To (anything) | Route (record), Minutes now (number), Distance (number) | – |
| Coverage `data.coverage` | How many of the residents and jobs in your areas are within a walk of your stops (or one line’s stops), and the biggest places left out, each with lng and lat (connect one to “Stops nearby”). From the map’s land use: an estimate. | After (anything, optional), Line (line or list, optional) | Coverage (record), Residents reached (number), Jobs reached (number), Left out (list) | Only the stops of line, Within a walk of |
| Where lines meet `data.transfers` | Places where two of your lines meet, at the same stop or stops a short walk apart, with the average wait for the second line (half its timetable gap) and how many people changed there a day over the last week. | After (anything, optional), From line (line, optional) | Changes (list), Busiest (record), How many (number) | From line, Stops at most, At most |

#### Logic

Compare, branch and work with lists.

| Node | What it does | Inputs | Outputs | Settings |
|---|---|---|---|---|
| Compare `logic.compare` | Is a number above, below or equal to another (or a threshold)? | Value (number), Compared with (number, optional) | Result (yes/no) | Test, Threshold |
| If / else `logic.if` | Sends the value down “Yes” when the condition is true, otherwise down “No”. Nodes on the other branch do not run. | Condition (yes/no), Value (anything, optional) | Yes (anything), No (anything) | – |
| All of `logic.and` | True when every connected input is true. | A (yes/no), B (yes/no), C (yes/no, optional) | Result (yes/no) | – |
| Any of `logic.or` | True when at least one connected input is true. | A (yes/no), B (yes/no), C (yes/no, optional) | Result (yes/no) | – |
| Not `logic.not` | Turns true into false and false into true. | Value (yes/no) | Result (yes/no) | – |
| Either `logic.either` | Passes on whichever input is active (A first). Joins two branches back together. | A (anything, optional), B (anything, optional) | Value (anything) | – |
| Only during `logic.during` | Passes the value on only between two hours (and on chosen days). | Value (anything, optional) | Value (anything) | From, Until, On |
| Filter `logic.filter` | Keeps the items of a list for which the condition is true. Use `item` for each item, e.g. item.occupancy > 80. | List (list) | Kept (list), Count (number) | Keep when |
| Sort `logic.sort` | Orders a list by a field, e.g. occupancy, highest first. | List (list) | Sorted (list) | By field, Order |
| First few `logic.take` | Keeps the first N items of a list. | List (list) | List (list) | How many |
| First item `logic.first` | The first item of a list. If the list is empty, nothing after it runs. | List (list) | Item (anything), Found (yes/no) | – |
| Pick the highest or lowest `logic.pick` | The item of a list with the highest (or lowest) value of a field, e.g. the line with the highest load3h. Items without that figure are skipped. If none has it, nothing after it runs. | List (list) | Item (anything), Its value (number), Found (yes/no) | Field, Pick |
| Group by `logic.groupBy` | Sorts the items of a list into groups that share a field, e.g. buses by line or depot, stops by area, journeys by where they go. Each group has its key, how many items it has, the items, and a total, average, smallest or largest of another field. Biggest group first. A group of buses by line stands for that line. | List (list) | Groups (list), Biggest group (record), How many groups (number) | Group by field, For each group, Of field |
| Join lists `logic.join` | Matches the items of two lists on a shared field and adds each match to the item of list A, under one name: e.g. your lines (id) with a demand forecast (id), then item.match.riders. Combines figures from different blocks so you can filter, sort or calculate with both. | List A (list), List B (list) | Joined (list), A without a match (list), Matched (number) | Field in A, Matches field in B, Add the match as, Keep |
| Compare peaks `logic.comparePeaks` | Compares two lines’ peak hours: whether they overlap, by how long, and how many buses line B could lend line A during A’s peaks without missing its own departures. Lines that peak at different times can share buses. | Line A (line, optional), Line B (line, optional) | Overlap (yes/no), Overlap (min) (number), B can lend A (number), In words (text) | Line A, Line B, Peak hours from |
| Wait `logic.wait` | Pauses here and carries on later: after a number of minutes, or once a figure for the line, stop or bus passed in crosses a value (e.g. until line 3’s buses are under 80% full, giving up after an hour). Then only the steps after it run, with fresh figures for the line, stop or bus; nothing before it runs again. Use it to check whether an action worked. | Value (anything) | Then (anything), Gave up (anything), Minutes waited (number) | Wait, For, Until, Is, Value, Give up after |
| One at a time `logic.queue` | Lines items up and passes them on one (or a few) at a time, at most once every so many minutes, and carries on by itself until none are left: e.g. send worn buses for maintenance one by one so no line is left short. An item already waiting, or passed on recently, is not added again. | Items (anything) | Next (anything), Passed on (list), Still waiting (number) | How many at a time, At most once every, Do not take the same one again for |
| Best pairs `logic.assign` | Pairs items of list A with items of list B so the total score is as low (or as high) as possible, choosing every pair together rather than one at a time. E.g. spare buses (A) to lines short of buses (B), scored by `km`, the distance from the bus to the line. Each item is used at most once; a pair whose score is empty (null) is never made. | A (list), B (list) | Pairs (list), Best pair (record), A left over (list), B left over (list) | Score, Best is, At most |

#### Maths

Calculate with numbers and expressions.

| Node | What it does | Inputs | Outputs | Settings |
|---|---|---|---|---|
| Expression `math.expr` | Calculates with up to three inputs (a, b, c), e.g. round(a / b * 100, 1). Also available: event, time, memory. | a (anything, optional), b (anything, optional), c (anything, optional) | Result (anything) | Expression |
| Calculate `math.arith` | Adds, subtracts, multiplies or divides two numbers. | A (number), B (number, optional) | Result (number) | Operation, B |
| Summarise list `math.aggregate` | Total, average, smallest, largest or count of a field across a list. | List (list) | Result (number) | Calculate, Of field |
| Get field `math.field` | Reads one field of a record, e.g. a line’s occupancy. | Record (record) | Value (anything) | Field |
| Calculate for each `math.map` | Adds a field `value` to every item of a list from an expression with `item`. | List (list) | List (list) | Value |

#### Memory

Remember values between runs, count, and avoid repeating yourself.

| Node | What it does | Inputs | Outputs | Settings |
|---|---|---|---|---|
| Remembered value `state.get` | Reads a value this workflow remembered in an earlier run. | – | Value (anything) | Name, If nothing yet |
| Remember `state.set` | Stores a value for later runs of this workflow and passes it on. | Value (anything) | Value (anything) | Name |
| Counter `state.counter` | Counts how often it runs (optionally restarting each day). | Count when (anything, optional) | Count (number) | Name, Restart each day |
| Has it changed? `state.changed` | Compares a value with the one from the previous run. | Value (anything) | Changed (yes/no), Previous (anything) | Name |
| Wait before repeating `state.cooldown` | Passes the value on, then blocks it for a number of game minutes (per line, stop or bus when connected to one). | Value (anything) | Value (anything) | Wait |
| Once a day `state.once` | Passes the value on only the first time each day (per line, stop or bus when connected to one). | Value (anything) | Value (anything) | – |

#### Actions

Change the game, with the same rules as when you do it yourself.

| Node | What it does | Inputs | Outputs | Settings |
|---|---|---|---|---|
| Extra departure `action.dispatch` | Runs an extra trip on a line now with a free bus (the one connected, or the best free one). It follows every normal rule: the bus prepares, drives to the first stop and runs the trip. | When (anything, optional), Line (line or list, optional), Bus (bus, optional) | Result (record), Done (yes/no) | Line |
| Schedule extra departure `action.scheduleExtra` | Plans an extra trip on a line for a set time later, up to 24 hours ahead: e.g. 10 minutes before a peak starts or a match ends. When it is due, the bus connected runs it if it is free then, or else one of the line’s free buses or a spare. If no bus is free it is dropped and you are told; it never counts as a missed departure. Timetable changes keep it, and you can cancel it on the line. | When (anything, optional), Line (line or list, optional), Time (anything, optional), Bus (bus, optional) | Result (record), Done (yes/no) | Line, When, At, In, Earlier (−) or later (+) by, Direction |
| Move bus to line `action.assign` | Moves a bus to a line. A bus with passengers finishes its trip and goes via the depot first. | When (anything, optional), Bus (bus or list), Line (line, optional) | Result (record), Done (yes/no) | Line, When |
| Park bus at its depot `action.release` | Takes a bus off its line and parks it at its depot as a spare, ready for any line. By default it first runs the trips it already has, so no departure is missed. Pair it with Buses set to “Not needed by their line” to park only buses a line can do without. | When (anything, optional), Bus (bus or list) | Result (record), Done (yes/no) | When |
| Send for maintenance `action.service` | Sends a bus to the workshop when it has finished its current work. | When (anything, optional), Bus (bus or list) | Result (record), Done (yes/no) | – |
| Base bus at another depot `action.moveDepot` | Bases a bus at another depot. A parked bus drives there on the road; a working bus goes there next time it returns. | When (anything, optional), Bus (bus or list) | Result (record), Done (yes/no) | Depot |
| Change frequency `action.headway` | Sets how often a line runs. High impact: needs your approval unless the workflow is allowed to make big changes. **Big change.** | When (anything, optional), Line (line, optional), Every (min) (number, optional) | Result (record), Done (yes/no) | Line, Every, Timetable |
| Suspend or resume line `action.suspend` | Stops or restarts a line’s timetable. High impact. **Big change.** | When (anything, optional), Line (line, optional) | Result (record), Done (yes/no) | Line, Action |
| Switch a service plan `action.servicePlan` | Switches one of a line’s manual service plans on or off (made in the line’s timetable, for example a "Rain" or "Match day" plan). Departures not yet given to buses follow it. High impact. **Big change.** | When (anything, optional), Line (line or list, optional) | Result (record), Done (yes/no) | Line, Plan name, Switch |
| Change the fare `action.fare` | Sets the fare for every new journey. High impact. **Big change.** | When (anything, optional), Fare (number, optional) | Result (record), Done (yes/no) | Fare |
| Send a notification `action.notify` | Adds a notification for you. Use {value} or {event.fleetNo} in the text to include values. | When (anything, optional), Value (anything, optional) | Result (record) | Title, Message, Tone |
| Add to report `action.report` | Writes a line to this workflow’s report (shown in its history). Use {value} to include a value. | Value (anything, optional) | – | Text |
| Hold a bus `action.hold` | Keeps a bus at a stop for a few minutes after its normal stop, doors open, then it carries on. Use it to even out bunched buses (hold the one that has caught up) or to wait for people changing from a late bus. A bus from “Gaps between buses” is held for the minutes that even out the gaps; a connection from “Connections at risk” holds the connecting bus as long as needed. | When (anything, optional), Bus (anything or list), At stop (stop, optional), Minutes (number, optional) | Result (record), Done (yes/no) | For, Never longer than |
| Turn a bus back early `action.shortTurn` | Ends a bus’s trip at a stop before the end of the line and runs it back the other way from there. Everyone going further gets off for the next bus (they have already paid). The usual way to get a late bus back on time, or to fill a big gap going the other way. Connect a suggestion from “Gaps between buses” (it says where), or a bus and a stop. Lines that go both ways only. | When (anything, optional), Bus (anything or list), At stop (stop, optional) | Result (record), Done (yes/no) | Only if at most |
| Move a departure `action.adjustDeparture` | Moves one departure a few minutes earlier or later (at most 15 from its timetable time) without changing the rest of the timetable: e.g. spread two crowded departures apart, or leave a little later for people off a late train. Connect a departure from “How full departures will be”. A timetable change puts it back. | When (anything, optional), Departure (anything or list), Minutes (number, optional) | Result (record), Done (yes/no) | By |
| Temporary detour `action.detour` | Sends a line round an area for a while (a busy event, a jam, a closure) on the quickest other roads between the same stops. The stops stay the same; a stop inside the area is still served. Each changed stretch switches over once no bus is driving it, and back when the time is up. Choose “End the detour” to end one early. | When (anything, optional), Line (line or list, optional), Around (anything, optional) | Result (record), Done (yes/no) | Line, Do, Avoid within, For |
| Suggest a route change `action.proposeRoute` | Prepares a change to your network for you to review: add a stop to a line (where it adds the least distance), take a stop off a line, or a new line through a list of stops (e.g. a corridor from “Unserved trips”). It never changes anything by itself: each suggestion waits for your approval in Network Control → Automation for 3 days, with the distance, time and buses it would add. **Big change.** | When (anything, optional), Line (line, optional), Stop (stop or list, optional), Stops of a new line (list, optional) | Result (record), Done (yes/no) | Suggest, Line |

#### Advanced

Reusable functions and notes.

| Node | What it does | Inputs | Outputs | Settings |
|---|---|---|---|---|
| Use a function `adv.function` | Runs one of your function workflows with inputs a, b, c and gives back its result. | a (anything, optional), b (anything, optional), c (anything, optional) | Result (anything) | Function |
| For each item, use a function `adv.forEach` | Runs one of your functions once for every item of a list (at most 20): the item is its input a, its position (1, 2, …) is b, and whatever is connected to c is c. Gives back the results as a list. Actions inside the function run once per item. | List (list), c (anything, optional) | Results (list), Count (number) | Function, At most |
| Function inputs `adv.input` | In a function: the values a, b and c it was called with. | – | a (anything), b (anything), c (anything) | – |
| Function result `adv.output` | In a function: the value it gives back. | Value (anything) | – | – |
| Note `adv.note` | A note on the canvas. It does nothing. | – | – | Text |

### Expression functions

| Function | Arguments | What it does |
|---|---|---|
| `min` | 1–20 | Smallest number (of the values, or of a list). |
| `max` | 1–20 | Largest number (of the values, or of a list). |
| `abs` | 1 | Absolute value. |
| `round` | 1–2 | Round, optionally to a number of decimals: round(x, 1). |
| `floor` | 1 | Round down. |
| `ceil` | 1 | Round up. |
| `sqrt` | 1 | Square root. |
| `clamp` | 3 | Keep x between lo and hi: clamp(x, lo, hi). |
| `ratio` | 2 | a / b, or null when b is 0. |
| `pct` | 2 | a as a percentage of b. |
| `sum` | 1 | Total of a list of numbers. |
| `avg` | 1 | Average of a list of numbers. |
| `count` | 1 | Number of items in a list. |
| `len` | 1 | Length of a text or list. |
| `pluck` | 2 | A field from every record of a list: pluck(lines, "occupancy"). |
| `first` | 1 | First item of a list (or null). |
| `last` | 1 | Last item of a list (or null). |
| `contains` | 2 | Whether a list or text contains a value. |
| `coalesce` | 1–10 | The first value that is not null. |
| `if` | 3 | if(condition, then, else). |
| `text` | 1–2 | A number as text, optionally with decimals: text(x, 1). |
| `concat` | 1–10 | Join texts together. |
| `join` | 1–2 | A list as text, separated by a comma or your own separator: join(pluck(lines, "number"), ", "). |
| `upper` | 1 | Upper-case text. |
| `lower` | 1 | Lower-case text. |
| `number` | 1 | Text as a number (or null). |
| `isnull` | 1 | Whether a value is null. |

### Expression limits

| Limit | Value |
|---|---|
| source | 2000 |
| nodes | 400 |
| steps | 20000 |
| list | 500 |
| string | 1000 |
| depth | 40 |

<!-- end generated -->
