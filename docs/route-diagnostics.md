# Route diagnostics

Every route warning in the line inspector and in the line editor's tray can be clicked. A click opens a **route check** in the right-hand inspector card. The check:

- frames the problem leg on the map;
- draws the road path the buses take now, plus a dashed straight line for reference;
- names the streets that block the short way;
- explains the cause;
- offers concrete fixes, each with a before/after comparison.

Nothing changes until the player presses **Apply change**. Undo and redo follow.

Screenshots: `docs/screenshots/network-control/route-diagnostic-{warning,selected,before-after}.png` (Barcelona, El Born → Placeta del Comerç).

## Pieces

| File | Role |
| --- | --- |
| `src/game/diagnostics.ts` | `Diagnostic` type, cause analysis (counterfactual routing), fix engine (`suggestFixes`, `lineStats`, `tradeoffs`, `applyFix`), map geometry (`legGeometry`) |
| `src/game/network.ts` | `buildPatterns` attaches `diagnostics` to every `Pattern` (alongside the unchanged `warnings` strings) and records `stopIdx` |
| `src/ui/RouteCheck.tsx` | the route check view, plus `DiagnosticButton` (the clickable `.issue` row) |
| `src/map/diagnosticsLayer.ts` | map layers and markers. It is driven by `useUI().routeCheck` and by the small `useCheckOverlay` store |
| `src/styles/diagnostics.css` | `dg-` styles, which use existing tokens only |
| `src/game/test/diagnostics.test.ts` | İstanbul tests, plus Barcelona tests that are skipped when the tiles are absent |

### The `Diagnostic` type

```ts
interface Diagnostic {
  id; kind: 'detour' | 'contraflow' | 'no-connection' | 'insufficient-buses';
  severity; route; pat; leg; stops: [from, to]; span: [i0, i1];   // path node indices of the leg
  measure: { directM, roadM, extraM, ratio } | null;               // real, measured on the graph
  cause: LegCause | null;                                          // see below
  title; text;            // `text` is the legacy warning string, unchanged
  explanation; fixes: FixKind[];
}
```

`lineDiagnostics(game, routeId)` returns the diagnostics of every pattern plus a line-level `insufficient-buses` diagnostic. That diagnostic opens the timetable.

To add a new kind:

1. add it to `DiagnosticKind`;
2. produce it in `patternDiagnostics` (for a leg or pattern) or in `lineDiagnostics` (for the whole line);
3. list its `fixes`.

The UI renders any diagnostic as a button. Kinds that have a `measure` and a `span` get the full map view.

## How the cause is found

`analyseLeg` reroutes the leg on the real road graph under relaxed rules. It does this with a distance-based, directed-edge Dijkstra (`shortestPath`) and with `buildPatterns` itself. The checks run in this order:

1. **contraflow**: the only way found drives against a one-way street.
2. **waypoints**: the line's own waypoints force the detour. The legal route without them is much shorter.
3. **wrong-side**: the halt on the other carriageway (`stop.alt`) makes the whole pattern much shorter. This is measured by rebuilding the pattern with that halt forced, including the reposition at the terminus.
4. **route-choice**: a legal path that is much shorter exists, but the router avoids it because of sharp turns or minor streets. The text says this honestly.
5. **no-uturn**: buses keep their heading through a stop, and allowing a U-turn there would shorten the leg.
6. **oneway**: ignoring one-way rules gives a much shorter leg. The blocking one-way runs are grouped, named (`geo.streetNear`) and reversed into their permitted direction, with a compass direction.
7. **data-gap / geography**: even unrestricted, no short road connection exists. Dead ends near the straight line suggest missing map data. Motorways, rail, water, or bridges and tunnels suggest real geography.

"Much shorter" means a saving of at least `max(180 m, 25% of the road distance)`. The straight-line distance is only ever drawn as a reference and labelled that way.

## Fixes

`suggestFixes` evaluates candidates on the graph (`routeShape` → `buildPatterns`). It keeps a fix only if it saves at least `max(150 m, 25% of the extra distance)`. The candidates are:

- moving either stop of the leg to nearby positions, validated with `checkStop`;
- swapping a stop for another existing stop or for a free stop spot;
- skipping the stop in one direction only (`returnStops`);
- removing the stop, always ranked last because it loses coverage.

The player can also drag a stop or a waypoint on the map (`Route.via`), or open the line editor on the return route.

For each candidate, the before/after card shows:

- line length;
- run time at the current hour (`previewRoute` profiles);
- residents and jobs within the walking catchment;
- the number of stops;
- trade-offs: catchment change, other lines that share a moved stop (`moveStop` moves it for every line), build cost, and remaining warnings.

When nothing helps, the card says so.

Commits go through `game.placeStop`, then `game.moveStop`, then `game.updateRoute` for committed lines, or `editDraft` for the line editor. Undo and redo restore the exact previous shape and stop position. A stop built for a fix is kept on undo, because demolishing it would refund nothing and could hit other lines.

## Defects found and fixed

1. **Halt choice ignored the next leg** (`network.ts`, `buildPatterns`). When a stop has two halts (one on each carriageway), the halt was picked by the cost of reaching it alone. A halt that is cheap to reach but leads only onto a long one-way loop won, and the line drove a detour that a smarter choice avoids. The leg now also counts the best cost of the following leg (a one-step lookahead). This includes the start-halt choice of the return pattern, which pays for the reposition. Regression test: Pertevniyal, İstanbul.
2. **Stop positions were wrong with waypoints** (`network.ts`). `stopS` came from the first occurrence of a stop's node in the path. When a waypoint takes the leg past the stop and back, that put the stop at the first pass. On the regression case it was 494 m instead of 1452 m, which skewed dwell positions and leg lengths. The assembly now records `stopIdx` directly.

## Observations, not changed

- `pairedHalt` pairs a stop with the opposite carriageway only within 45 m. Some real OSM stop pairs are 45 to 90 m apart (10 found in Beyoğlu, 12 in El Born), so they get one halt. This is a tuning choice, not a defect.
- The router's turn and street-class preferences can legitimately make a leg longer than the shortest legal one. These cases show as "route choice" rather than as a hidden bug.
- The Barcelona El Born case is a genuine one-way detour under the OSM data. Passeig de Picasso is one-way south-east, and El Born - Ciutadella - Zoo sits on that carriageway. The best fixes shorten the leg but do not always remove the warning entirely. The card shows the remaining warnings.

## Tests

```sh
node scripts/dev/fetch-test-tiles.mjs   # optional: Barcelona El Born tiles
pnpm exec vitest run src/game/test/diagnostics.test.ts
```

The fetch script writes 9 OpenFreeMap z14 tiles (about 5.7 MB) to `src/game/test/tiles/14/x/y.pbf`. The Barcelona tests are skipped (`it.skipIf`) when the tiles are absent.

## Limitations

- Only `detour`, `contraflow`, `no-connection` and `insufficient-buses` are diagnostics. Other warnings stay as plain text.
- Fix search covers one stop at a time and one leg at a time. It does not search waypoint placements automatically; the player places those.
- The catchment figure is a union of demand cells within the walking radius. It is not a ridership forecast.
- Undo and redo for committed lines live in the route check session. They end when the check is closed.
