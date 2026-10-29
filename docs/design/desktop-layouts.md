# Project Transit: Desktop Layout Directions

Three desktop layouts compatible with the visual language in [`design-system.md`](design-system.md) (pale miniature map, dark compact UI, one blue action). The PRD asks for floating cards rather than a permanently docked dashboard, and for roughly 75-85% of the map to stay visually unobstructed in normal play (PRD 4.1). Direction A is what the prototype implements; B and C are alternatives we considered and did not build.

Percentages below are estimates of the share of a 1920x1080 viewport not covered by UI, measured from the A screenshots and calculated from panel sizes for B and C. They count the full bounding box of every card, including the empty margin around it, so they are slightly pessimistic.

---

## A. Floating cards (implemented)

```
+--------------------------------------------------------------------+
| [Company card]      [ pause play ff fff | 07:44 Fri ]   [Bal|Profit|Sat|bell] |
| +--+                                                                |
| |T |  +--panel 400--+                      +--inspector 360--+      |
| |T |  | Lines/Fleet |      MAP             | selected bus,   |      |
| |T |  | Finances    |                      | stop or line    |      |
| |--|  |             |                      |                 |      |
| |V |  +-------------+                      +-----------------+  [+-]|
| +--+       [ bottom tray: route editing only ]                [cmp]  |
+--------------------------------------------------------------------+
```

Top cards are three separate pills (company, time, money). A 52 px vertical rail holds tools (select, add stop, create route) and views (network, traffic, demand), plus panel buttons for lines, fleet and finances. Panels dock beside the rail at 400 px; the inspector is 360 px on the right; zoom and compass sit bottom-right.

| State | What is on screen |
|---|---|
| Clean map | Three top cards, rail, zoom stack. About 93% clear. |
| Bus selected | Inspector slides in on the right. About 83% clear. |
| Route editing | Rail tool highlighted, blue draft line, numbered stop labels, bottom tray (about 1060 px wide, 70 px tall) with stops, distance, round trip, buses, undo, cancel, create. About 88% clear. |
| Fleet or finance panel | 400 px panel beside the rail, scrolling list. About 77% clear on its own. |
| Panel plus inspector (busiest common state) | List on the left, detail on the right. About 66-70% clear. |

**Strengths**
- Map is visible around and between every card; the miniature city stays the hero, as in the reference game.
- Nothing is permanently docked; the UI grows only for the task in hand.
- List-left, detail-right is a real desktop advantage over the mobile bottom-sheet model.
- Cheapest to build and already working at 1920x1080.

**Risks**
- Panel plus inspector falls below the 75% target. Needs a rule such as auto-collapsing the panel to a 56 px strip when the inspector opens at 1440 px or narrower.
- Three separate top cards cost about 4% but fragment attention; the eye travels corner to corner.
- Floating cards need careful z-order and collision handling (labels, pins and cards can overlap).
- Dense work such as timetables has no natural wide surface; it needs a modal or a widened panel.

---

## B. Command deck (docked right sidebar)

```
+--------------------------------------------------------------------+
| [Company]  [ pause play ff fff | 07:44 ]  [Bal|Profit|Sat]  |  Tabs |
+----------------------------------------------------------+ Lines  |
| [T]                                                      | Fleet  |
| [T]                    MAP                               | Money  |
| [T]                                                      |--------|
|                                                          | detail |
|                                                          | (420)  |
|                                   [+-]                   |        |
+----------------------------------------------------------+--------+
```

One full-height 420 px sidebar on the right with tabs (Lines, Fleet, Finances) and a detail area underneath that shows whatever is selected. A slim 48 px top bar spans the width. Tools stay as a small floating rail on the left.

| State | What is on screen |
|---|---|
| Clean map | Sidebar collapsed to a 48 px tab strip. About 90% clear. |
| Bus selected | Sidebar opens on Fleet with the bus detail. About 72% clear. |
| Route editing | Sidebar shows route settings and stop table; no bottom tray needed. About 72% clear. |
| Fleet or finance panel | Same sidebar, wider tables possible at 520 px. About 65-72% clear. |

Busiest common state: about 70% clear.

**Strengths**
- One predictable place for all detail; low learning cost.
- Space for tables, charts and timetable editing without extra windows.
- Simple to implement responsively.

**Risks**
- Contradicts the PRD's "avoid permanently docked dashboard layouts"; reads as a management app rather than a game.
- Map is cut into a fixed rectangle, so selected objects can end up under the sidebar and the camera must offset for it.
- List and detail cannot be seen side by side without a split inside the sidebar.
- Moves further from the reference game's character.

---

## C. Bottom dock (timeline-centric)

```
+--------------------------------------------------------------------+
| [Company]                     [Bal | Profit | Sat]       [bell]   |
|                                                                    |
|                         MAP                        +--inspector--+ |
|                                                    |    360      | |
| [T]                                                +-------------+ |
|                                                              [+-]  |
+--------------------------------------------------------------------+
| [pause play ff] 07:44  |=====|=====[now]=====|=====|  demand curve |
| [Lines][Fleet][Money]   line rows with vehicles on a shared time axis |
+--------------------------------------------------------------------+
```

A 200-240 px bottom dock holds time controls, a 24-hour timeline with the demand curve, and a swimlane view of lines and vehicles. Tabs on the dock swap between lines, fleet and finance. Inspector stays on the right.

| State | What is on screen |
|---|---|
| Clean map | Dock collapsed to a 64 px time bar. About 88% clear. |
| Bus selected | Right inspector plus a highlighted lane in the dock. About 70% clear. |
| Route editing | Dock becomes the route editor: stop list as columns, timetable below. About 76% clear. |
| Fleet or finance panel | Dock expands to 320 px. About 55-65% clear. |

Busiest common state: about 62% clear.

**Strengths**
- Best fit for timetables, frequency and the PRD's "visual timeline without sacrificing map context" (PRD section 10).
- Time is a first-class object; useful for rush-hour planning.
- Wide screens suit horizontal tables.

**Risks**
- Landscape screens are short; a dock costs height, which hurts a tilted 3D city view most.
- Heaviest build: swimlane and timeline components are non-trivial.
- Dock expands often, so the map is covered more than in A or B.
- Overkill for the early game with three lines.

---

## Comparison

| | A Floating cards | B Command deck | C Bottom dock |
|---|---|---|---|
| Clear map, clean state | ~93% | ~90% | ~88% |
| Clear map, busiest common state | ~66-70% | ~70% | ~62% |
| Matches PRD (floating, not docked) | Yes | No | Partly |
| Matches reference game feel | High | Low | Medium |
| Table and timetable room | Medium (widen panel) | High | High |
| List plus detail together | Yes | Awkward | Partly |
| Build cost | Low (done) | Low-medium | High |
| Fits 1280 px wide | Needs collapses | Good | Good |

## Recommendation

Keep **A**.

1. It is the only direction that follows the PRD's floating-card instruction and keeps the reference game's character.
2. It leaves the most map visible in the states players spend most time in (clean map, bus selected, route editing).
3. List-left, detail-right gives desktop users real advantage without a permanent dashboard.
4. It already exists and renders cleanly at 1920x1080.
5. Its main weakness, the busiest state at about 66-70%, can be fixed cheaply (collapse the panel when the inspector opens, make panels draggable or pinnable) without changing direction.

Borrow from C later: when the timetable editor is built (PRD section 10), open it as a wide, temporary bottom sheet rather than a permanent dock. Borrow from B only on screens at 1280 px or narrower, where the inspector can merge into the panel.

## Open questions for player testing

1. With the fleet panel and inspector both open, do players feel the map is too covered, or do they close one panel quickly? Measure time-to-close and how often both are open.
2. Is one top-left, top-centre, top-right split of cards easier to scan than a single joined top bar? Track how often players miss a balance or satisfaction change.
3. Does the vertical rail with both tools and views confuse people? Test splitting tools (top) from panels (bottom) with labels on hover versus always visible.
4. Where should timetable editing live: a wide temporary sheet at the bottom, a modal, or a widened side panel? Test with a task such as "make line 26 run every 8 minutes at rush hour".
5. Should panels be draggable and pinnable, or fixed beside the rail? Check whether players on 1440 px laptops want to move them.
