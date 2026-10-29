# Visual research: City Transport Manager (CTM) as a reference

Purpose: identify which concrete visual choices make CTM read as calm despite dense information, and what to adapt (not copy) for Project Transit on desktop.

## Method

Source: official press-kit screenshots (https://citytransportmanager.com/presskit/), stored locally outside the repo. No images are copied into the project. Paths below are relative to the press-kit folders (iPad 2064x2752, iPhone 1320x2868, UI 1320x2868 English, web).

**Inspected by the lead designer (notes taken as given; two re-verified by the research agent):**
iPad hamburg-04, london-03, muenchen-06, aichhalden-05, hamburg-05; UI hamburg-08, -10, -13, -15, -17. Colour values in the Colour table marked "lead" were measured by the lead (median patches / k-means), not re-measured by the research agent.

**Inspected by the research agent (viewed at reduced size, ~900 px wide):**
iPad ulm-02-hauptbahnhof; iPad hamburg-07-u-bahn-ebene; iPad aichhalden-tram-ins-gruene; iPhone muenchen-03-tram-nah; UI hamburg-14-betriebshof, -16-forschung, -18-sammelkarten, -19-ziele; web/ctm-map.png. Re-verified from the lead's list: iPad london-03 and iPad aichhalden-05.

**Not inspected by anyone:** iPhone duplicates of the iPad set (assumed same content, different crop), web/map.webp and the hamburg webp files (assumed duplicates of UI shots). Colours were estimated by eye only where marked "est."; no new pixel sampling was done. Screens were downscaled, so fine detail (small type, tiny vehicles) is uncertain.

## Map aesthetic

- The map is a muted, low-saturation 3D city on a warm off-white ground; the only saturated things are things the player cares about: route lines, pins, buttons (ulm-02, web/ctm-map).
- Three distinct render treatments appear across the screenshots, not one:
  1. **Close 3D city** (london-03, muenchen-03, muenchen-06): extruded flat-shaded buildings, trees, road casings.
  2. **Mid 3D city** (ulm-02, web/ctm-map): same style, buildings dense and tiny; the cathedral in Ulm is a recognisable landmark mass; a rail yard drawn as a bundle of hairline tracks.
  3. **Flat 2D regional / zoomed out** (aichhalden-05, hamburg-07): no building extrusion; desaturated cartographic base. Aichhalden is flat beige-yellow terrain; hamburg-07 is grey-green with water in blue-grey. (Contrast with the lead's note: the camera is not always tilted 3D; level of detail switches to flat map at distance.)
- Water in the flat views is a darker, greyer blue than the pale water in the 3D close view (hamburg-07 vs web/ctm-map). Est.

## Buildings & environment

- Buildings are plain extrusions with flat shading: lighter top, two wall tones (london-03, ulm-02). Confirms lead.
- Many roofs are flat; a minority of small buildings have hipped/pyramid roofs (london-03 lower left, muenchen-03 left centre). Some are stepped/terraced blocks (london-03 centre-right). Large landmark masses are just taller extrusions with subtle detail.
- Warm taupe/pink-beige buildings are a minority colour variant that breaks monotony (london-03, muenchen-03). Confirms lead.
- Building edges have no outlines; separation comes only from tone differences between top and walls. Dense blocks therefore merge into a soft grey texture (ulm-02).
- Shadows: not observed as cast shadows on ground in any 3D shot (london-03, muenchen-03, aichhalden-tram). Trees in aichhalden-tram sit directly on ground with no visible shadow blob. Uncertain at downscale but consistent with the lead.
- Roads in 3D: pale blue-grey ribbons with lighter casing, tiny grey one-way arrows on the road surface (muenchen-03, london-03). Rail corridors are drawn as thin dark hairlines (ulm-02).
- Parks are pastel green flat patches with scattered trees; small ponds are pale blue (muenchen-03 bottom left).

## Vegetation

- Low-poly faceted trees in two types: dark cone conifers and lumpy round deciduous on brown trunks, with 3-4 green shades (aichhalden-tram close-up). Faceting is subtle (a few lighter/darker planes), not a hard-edged gem look.
- Variation in size and green is the main source of life; placement is clumped in parks and thinned elsewhere (muenchen-03). Trees are far smaller than a bus at mid zoom (london-03 park lower right), i.e. drawn at roughly real scale.
- Forest ground is a flat mid-sage green (#aacaa6 est.) in aichhalden-tram, darker than city parks.

## Water

- Flat, no waves or reflections, a single pale blue with soft darker shoreline (web/ctm-map river, muenchen-03 pond, hamburg-14/16 lake in the dimmed backdrop). No visible shoreline foam or depth gradient.

## Roads & labels

- Street names: small grey text in a light sans following the road, often truncated at screen edge (muenchen-03, london-03). Very low contrast; it recedes.
- POI/place names: large rounded sans in dark slate on a semi-opaque white rounded rectangle (london-03 "Lyceum Theatre", "Virgin Active"). The backing plate is what lets text sit above busy buildings.
- District / city names ("Ulm", "Hamburg", "St. Georg", "Neustadt", "HafenCity") are large grey letters with slight transparency, drawn over the map without a plate; they are intentionally partially occluded by pins (ulm-02, hamburg-07). Uppercase for sub-district (HAFENCITY, hamburg-07).
- Stop names appear on small white rounded labels under the pin with a type prefix ("B • Neutorstraße", "U • Embankment"); the line name sits in a second small label ("Linie 6"). At clusters these labels overlap (ulm-02 left side) -- CTM does not fully de-collide labels; this is the one place the map gets messy.
- Major roads in the 3D views are the same blue-grey with a slightly salmon tint where a route runs along them (lead: salmon #e59b82).

## Vehicles

- Vehicles are small, real-scale 3D models: red/white articulated bus, red/white three-section tram with dark windows and roof panels, double-decker (aichhalden-tram, muenchen-03, ulm-02). Livery is white body with a single red accent, so it stands out on grey and green.
- Overhead catenary lines are drawn as hairlines beside the tram track (aichhalden-tram). Cute and cheap detail.
- Each vehicle has a tiny white label plate with line + load: "T • T7 73/160", "B • 58 5/140", "B • 11 23/107" (muenchen-03, aichhalden-tram, london-03). A small coloured capacity bar floats above it (aichhalden-tram, amber bar). In ulm-02 vehicles are mostly too small to read; only labels and bars show.
- When the vehicle is not the focus, it shrinks to a white bar on the line (ulm-02 "Schillerstraße 6" bus with white body on the orange line).
- Floating money pop-ups: "+12,00 EUR" in mint with up/down arrow counts (green up 3, red down 4) beside a stop (muenchen-03 left). Feedback is non-modal and rendered in-world.
- Tram route lines on track render as 2-3 parallel coloured bands (blue and pink) so a shared track shows several lines side by side (aichhalden-tram).

## Lighting & camera

- Perspective camera, pitched roughly 45-55 deg, north-up; close views (london-03) show strong convergence. Flat views (aichhalden-05, hamburg-07) look near top-down.
- Uniform light, no time-of-day tint visible on the map in any screenshot. The HUD clock reads 17:37 / 18:03 in UI shots and the map is still full day brightness: no night mode seen. (Uncertain; not claimed absent from the game.)
- Whole map is tonally compressed: the darkest map tone is the dark wall grey; there is nothing near black except UI chrome and the circular count badges.

## Colour (measured values)

| Role | Hex | Source / by |
|---|---|---|
| Ground | #eceae2 / #f1f0ea | map shots, lead |
| Building top | #d5d2c9 / #dcdbd3 | iPad hamburg-04, london-03, lead |
| Building walls | #cfccc4, #c0beb4; dark wall #a2a39d | lead |
| Warm buildings | #d1c8bd / #d5c7ba | lead |
| Park | #c6d8b9 / #cddbc0 | lead |
| Road casing | #c2cbcd | lead |
| Water (3D) | #a2c9d3 | lead |
| Tree greens | #6c8858, #5f9c6f | lead |
| Major road salmon / red | #e59b82 / #db6657 | lead |
| Panel / inner section | #181e1a / #222b26 | UI shots, lead |
| Selected segment / finance tab | #314348 / #3b4c41 | UI-16 (agent confirms blue-grey "Buses" tab) |
| Highlight row, bar track, close btn | #223028, #39453e, #323834 | lead |
| Primary blue | #4fa3e0 | UI-14 "Enlarge" / "Connect" buttons look like this (est.) |
| Mint text, green bar | #9fdab1, #5fd48f | lead |
| Amber / coral | #f5c76b (#e6aa46) / #f09480 (#ea9c99) | lead |
| Gold card/reward panel | dark olive-brown with gold border, #3a3220 est. | UI-18 |

Pin colours (agent, by eye): hospital red-pink, entertainment/happy green, shopping blue, education teal, church/home teal-green, food orange, hotel/leisure purple, train station blue, bus stop white with yellow-green ring, U-Bahn white with navy "U" disc (ulm-02, web/ctm-map, hamburg-07). Route line colours are saturated and distinct: purple, orange, green, red, blue, olive (ulm-02).

## Typography

- UI: rounded geometric sans, bold headings, medium-weight body, grey secondary lines (UI-14, -16, -18, -19). Looks like Rubik; unconfirmed.
- Numbers: tabular-looking in the HUD (clock 18:03, 2,226,765 EUR). Money is rendered mint and sized larger than the rest of the HUD.
- Map labels: same family for POI plates, lighter grey weight for streets. District names are large, bold, letter-spaced, and semi-transparent grey.

## Floating panels & HUD

- Top bar (UI-14, -16, -18, -19): left, pause/play/fast-forward segmented control with play highlighted blue, clock above; centre, "Day 149" and a satisfaction pill "75 %" with a smiley; right, money in mint, then two gold/olive chips (cards count "21" and stars "125"). Chips are semi-transparent dark so the map shows through.
- Bottom sheets (UI-14, -16, -18): dark panel, big rounded top corners, bold title left, circular close button right, content rows as inset darker rounded rectangles. The map behind is dimmed, not hidden, so the player keeps spatial context.
- UI-19 "Goals" is a floating card (not a sheet) anchored mid-screen: tabs "Goals / Milestones / Districts - 31", title, description, thin blue progress bar with percent, reward chips (28,500 EUR and 4 stars). Active tab is blue-grey; "Districts" is amber.
- Depot panel (UI-14): name field, capacity text, one blue primary action ("Enlarge to 175 spaces 50 star"), rail links with secondary "Connect"/"Change" buttons, vehicle list grouped by line with small coloured line tab, count chip, chevron, "Move".
- Research (UI-16): vertical timeline with green check nodes joined by a green line; each row an inset card; "Researched" pill in dark green. Complete state is quiet.
- Collector cards (UI-18) are the one decorative screen: silver/gold bordered cards with trophy icons. That mechanic is CTM-specific; do not copy.

## Information hierarchy

1. Route lines and pins (saturated, on top).
2. Stop pins with white plates and numeric demand badges.
3. Vehicle labels and load bars.
4. POI plates and district names.
5. Buildings, roads and street names as backdrop.
Money and clock are top bar only; everything else is a modal-ish sheet opened on demand. Numeric badges next to pins (e.g. "2", "13", "25" in hamburg-07; "40", "90" shopping in web/ctm-map) encode demand without drawing individual people; there are also tiny dot clusters (waiting passengers) at stops in ulm-02 and web/ctm-map.

## Route construction tools

- aichhalden-05 (lead plus agent view): route drawn as a single thin green line with small white-ringed chevron discs; numbered stop pins ("H" with small number badge 1-7); stops have thin dark-green circle outlines for catchment; a red selection highlight on the active stop; a dark depot icon at the bottom. The base map is flat and dimmed so the line dominates.
- UI-08 (lead): linienbau sheet; not re-inspected.
- Line names and colours are assigned as chips; vehicles are moved between lines with a "Move" action (UI-14).

## Overlays

- **Demand heat** (aichhalden-05): soft blurred blotches over a flat map. Colours go from teal/blue (low) through yellow-green to orange and red-pink (high), with the strongest red-pink patch top-left. It is a multiplied/overlay wash, not additive glow. Legend not visible.
- **Catchment** (aichhalden-05): thin dark-green circles around each stop; overlapping circles show coverage. In UI-19 the goal "network coverage 67.9 % / 75 %" refers to the same concept.
- **Network / underground layer** (hamburg-07): map desaturates further, 3D buildings drop away, metro lines draw as thin straight coloured polylines (navy, dark red, yellow, teal) with U pins and station pins; this layer is schematic and clean.
- Satisfaction and goal pins (smiley pins green; faded/ghost pins when not yet served, e.g. london-03 pale pins) show unserved destinations at reduced opacity.

## Why it looks calm

1. **Desaturated, tonally compressed base**: all geometry is within a narrow light grey range, so nothing competes except coloured data.
2. **Colour is reserved for data**: lines, pins, vehicles and UI actions only. Nothing decorative on the map is saturated.
3. **No outlines, no shadows, no textures**: shape comes from two wall tones; zero high-frequency detail.
4. **Backing plates on text**: semi-opaque white rounded plates keep labels legible without making them loud; street names are low-contrast grey.
5. **Hierarchy through scale**: pins are the largest objects, vehicles tiny and real-scale, so the network reads at a glance.
6. **Counts instead of crowds**: numeric badges and small bars summarise demand rather than drawing everything.
7. **Level of detail switches**: the 3D city gives way to a flat map when zoomed out; layers (underground, demand) replace rather than stack.
8. **Dark UI over light map**: a single dark rounded system, minimal colours, one blue action per panel; map dimmed under sheets.
9. **Rounded forms everywhere**: pins, plates, buttons, panels share the same soft geometry.
10. **Restraint in UI colour**: mint = money/good, amber = warning/special, coral = bad; each used consistently.

Counter-evidence: label collisions in dense stop clusters (ulm-02 left) and heavy pin overlap show the calm breaks down at network density; CTM lives with it.

## Implications for a desktop version

- Landscape and mouse: the top bar can stay but the clock/money cluster should be less touch-sized; the map gets much more width, so more of the network is visible and label collision will worsen.
- Replace bottom sheets with right-side or floating dockable panels (keep the dimmed map idea only for modal tasks); keep rounded dark panels and inset rows.
- Hover states replace tap: hover a pin to reveal its plate and catchment; keep the minimal default state. Add tooltips with the vehicle label (line, load) rather than always-on labels at far zoom.
- Keyboard and right-click: mouse wheel zoom drives the level-of-detail switch (3D close, 2D far); layer toggles (demand, catchment, underground) belong in a small toolbar.
- Route drawing becomes click-to-add-stop with a live line preview and snapping; touch needs big chips, mouse can use small handles.
- Higher resolution: building detail, tree variety and label type can be crisper; allow label de-collision (priority by pin importance) that CTM lacks.
- Optional: day/night tint is untested in the references; treat as a later extension, not a baseline.
- Do not rely on pinch/rotate; consider fixed or limited rotation to keep labels upright.
