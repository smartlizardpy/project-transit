# Automation API

How Automation Studio workflows run, what they can read and do, and the rules that keep them safe. The node and function tables at the end are generated from the code (`node scripts/dev/automation-reference.mjs`).

Engine code: `src/game/automation/` (types, registry, validate, executor, manage, templates, lab, live, events) and `src/game/expr.ts`. Commands: `src/game/commands.ts`. Tests: `src/game/test/automation.test.ts`, `src/game/test/commands.test.ts`.

## How a workflow runs

- A workflow is a graph of nodes saved with the company (`state.automation`). Connections carry values from an output to an input; each input takes one connection.
- **Game time only.** Schedules and conditions are checked once per game minute, inside the simulation step. Pausing the game pauses automation; faster speeds run it faster. Nothing uses wall-clock timers.
- **Simulation events** (a bus arrives, departs, breaks down; a departure is missed; the day ends) are queued in the save and handled at the next game minute, so a reload neither loses nor repeats them. Events are only recorded when an enabled workflow listens for that kind.
- **One run** evaluates every enabled node in a fixed topological order. Nodes hanging off a trigger that did not fire receive *not active* and are skipped, as are nodes on the branch an If did not take. Nodes not attached to any trigger (shared data) run on every trigger. Data nodes have an optional **After** input: connect a trigger to it and the node reads its figures only when that trigger fired (the templates do this, so the canvas shows what starts what). The same state always gives the same result; runs are part of the deterministic simulation and continue identically after a reload (tested).
- **Validation** (`validate.ts`) runs before every run and live in the editor: required inputs, port types, loops, unknown or deleted lines/stops/buses/depots, expression syntax, size limits. An enabled workflow with problems records a failed run instead of acting.

## Values and records

Values are numbers, yes/no, text, records and lists. Records are plain objects with a `kind`.

| Record | Fields |
|---|---|
| line | `id`, `number`, `name`, `colour`, `buses`, `needed` (peak requirement), `running`, `occupancy` (% average of buses on a trip now), `waiting`, `delay` (min, average), `headway` (min, now), `suspended`, `onTime3h` (%), `load3h` (%), `boardingsToday`, `tripsToday`, `missedToday`, `congestion` (% simulated traffic along the line) |
| stop | `id`, `name`, `waiting`, `longestWait` (min), `lines` (numbers), `boardingsToday`, `gaveUpToday`, `avgWaitToday` (min) |
| bus (`vehicle`) | `id`, `fleetNo`, `model`, `capacity`, `line`, `lineNumber`, `status`, `statusLabel`, `load`, `occupancy` (%), `condition` (%), `delay` (min), `depot`, `depotName`, `spare`, `free` (could start an extra trip now), `carrying` |
| company | `balance`, `reputation`, `level`, `fare`, `resultToday`, `buses`, `lines` |
| time | `t`, `time` (HH:MM), `hour`, `minute`, `weekday`, `weekend`, `day` |
| event | depends on the trigger, e.g. `vehicle`, `fleetNo`, `line`, `lineNumber`, `stop`, `stopName`, `load`, `occupancy`, `delay`, `trip`; the end-of-day event carries the day's `boardings`, `journeys`, `gaveUp`, `trips`, `missed`, `onTime`, `satisfaction`, `fares`, `costs`, `result` |

All figures are read from the live simulation or from Network Control's recorded analytics; none are invented. When a figure is unavailable it is `null`, and comparisons with `null` are false.

## Actions and the shared command layer

Every action node asks for a **command** (`commands.ts`): `assign_vehicle`, `dispatch_extra`, `set_headway`, `suspend_line`, `set_fare`, `service_vehicle`, `move_depot`. The player's own buttons use the same game methods, and `checkCommand` is a pure dry run that explains in plain words what would happen (for example: a bus carrying passengers finishes its trip, returns to its depot and then joins the new line). Automations cannot do anything the player could not do, and they never bypass the simulation's rules: an extra departure is a real trip that a real bus prepares for, drives to and runs.

## Modes

| Mode | What actions do |
|---|---|
| Observe | Nothing changes. The run records what each action would have done. |
| Suggest | Each action becomes a suggestion in Network Control → Automation. It is checked again when you approve it, and expires after 30 game minutes. |
| Automatic | Actions run within the limits below. **Big changes** (frequency, fare, suspending a line) still become suggestions unless the workflow is allowed to make big changes. |

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
- **Your own changes win**: a change you make by hand (bus assignment, depot, timetable, suspension, fare) blocks automations from undoing it for 24 game hours.
- **History**: the latest 300 runs are kept; the node-by-node trace (inputs, outputs, and why a condition was true or false) is kept for each workflow's latest 3 runs.

## Simulation Lab

`lab.ts` copies the saved company twice in memory, runs one copy without the workflow and one with it for 2–24 game hours, and compares journeys, boardings, abandoned journeys, trips, missed departures, punctuality, waiting, load, satisfaction, passengers left behind, fares and the change in balance. The live game is untouched (tested). Both copies use the same random seed, and other workflows run in both. The figures are measured in the copies, but they are one possible future: once the workflow changes something the copies drift apart, so small differences can be chance. It is not a forecast.

## Expressions (Expression API v1)

Used by the Expression, Filter and Calculate-for-each nodes and by custom metrics.

- Numbers, `"text"`, `true`, `false`, `null`; arithmetic `+ - * / % **`; comparisons `== != < <= > >=`; `and`, `or`, `not` (also `&& || !`); `condition ? a : b`; parentheses; field access `line.occupancy` and `list[0]`, list literals `[1, 2]`; function calls from the table below.
- Dividing by zero gives `null`. Comparisons involving `null` are false. Missing fields are `null`.
- **Sandbox**: expressions are parsed by the game's own interpreter. There is no `eval` or `Function`, and no route to JavaScript objects, the file system, the network, Tauri commands or the page. `__proto__`, `prototype` and `constructor` are refused. Every evaluation has a step budget and size limits (below), so an expression cannot hang the game.

## Reference (generated)

<!-- generated: node scripts/dev/automation-reference.mjs -->

### Nodes

#### Triggers

Start a workflow: on a schedule or when something happens in the game.

| Node | What it does | Inputs | Outputs | Settings |
|---|---|---|---|---|
| Every few minutes `trigger.every` | Runs on a regular game-time schedule, e.g. every 15 minutes. Pauses and speeds up with the game. | – | Event (event) | Every, From, Until |
| At a time of day `trigger.time` | Runs once a day at a set time. | – | Event (event) | At, On |
| End of the day `trigger.day` | Runs at midnight with the day that just ended: boardings, journeys, fares and costs. | – | Event (event), Day summary (record) | – |
| A bus arrives at a stop `trigger.arrive` | Runs every time a bus on a trip reaches a stop (filter by line and stop). | – | Event (event), Bus (bus), Line (line), Stop (stop) | Line, Stop |
| A crowded bus leaves `trigger.crowded` | Runs when a bus leaves a stop at or above a load. | – | Event (event), Bus (bus), Line (line), Stop (stop) | Load at least, Line |
| A bus is running late `trigger.late` | Runs once per trip when a bus leaves a stop later than the threshold. | – | Event (event), Bus (bus), Line (line) | Late by at least, Line |
| A departure is missed `trigger.missed` | Runs when a timetabled departure does not run. | – | Event (event), Line (line) | Line |
| A bus breaks down `trigger.breakdown` | Runs when a bus breaks down. | – | Event (event), Bus (bus), Line (line) | Line |
| Many people waiting `trigger.waiting` | Runs when the number waiting at a stop rises above a threshold (again only after it has dropped well below). | – | Event (event), Stop (stop) | At least, On line |
| Balance falls below `trigger.balance` | Runs when the bank balance drops below an amount. | – | Event (event), Company (record) | Below |
| Run by hand `trigger.manual` | Runs when you press Run in Automation Studio. | – | Event (event) | – |

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
| Company `data.company` | Balance, reputation, level, fare and today’s result. | After (anything, optional) | Company (record), Balance (number) | – |
| Time `data.time` | The game clock: time, hour, weekday, weekend. | After (anything, optional) | Time (record), Hour (number) | – |
| Network Control figure `data.analytics` | A measure from Network Control’s recorded history, e.g. average wait per stop over the last 7 days. | After (anything, optional) | Rows (list), Total (number) | Measure, For each, Days |

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
| Move bus to line `action.assign` | Moves a bus to a line. A bus with passengers finishes its trip and goes via the depot first. | When (anything, optional), Bus (bus or list), Line (line, optional) | Result (record), Done (yes/no) | Line |
| Take bus off line `action.release` | Makes a bus a spare. It finishes any trip first, then returns to its depot. | When (anything, optional), Bus (bus or list) | Result (record), Done (yes/no) | – |
| Send for maintenance `action.service` | Sends a bus to the workshop when it has finished its current work. | When (anything, optional), Bus (bus or list) | Result (record), Done (yes/no) | – |
| Move bus to depot `action.moveDepot` | Bases a bus at another depot. A parked bus drives there on the road; a working bus goes there next time it returns. | When (anything, optional), Bus (bus or list) | Result (record), Done (yes/no) | Depot |
| Change frequency `action.headway` | Sets how often a line runs. High impact: needs your approval unless the workflow is allowed to make big changes. **Big change.** | When (anything, optional), Line (line, optional), Every (min) (number, optional) | Result (record), Done (yes/no) | Line, Every, Timetable |
| Suspend or resume line `action.suspend` | Stops or restarts a line’s timetable. High impact. **Big change.** | When (anything, optional), Line (line, optional) | Result (record), Done (yes/no) | Line, Action |
| Change the fare `action.fare` | Sets the fare for every new journey. High impact. **Big change.** | When (anything, optional), Fare (number, optional) | Result (record), Done (yes/no) | Fare |
| Send a notification `action.notify` | Adds a notification for you. Use {value} or {event.fleetNo} in the text to include values. | When (anything, optional), Value (anything, optional) | Result (record) | Title, Message, Tone |
| Add to report `action.report` | Writes a line to this workflow’s report (shown in its history). Use {value} to include a value. | Value (anything, optional) | – | Text |

#### Advanced

Reusable functions and notes.

| Node | What it does | Inputs | Outputs | Settings |
|---|---|---|---|---|
| Use a function `adv.function` | Runs one of your function workflows with inputs a, b, c and gives back its result. | a (anything, optional), b (anything, optional), c (anything, optional) | Result (anything) | Function |
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
