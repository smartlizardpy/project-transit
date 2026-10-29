# PRODUCT REQUIREMENTS DOCUMENT
# Project Transit — Real-World Transport Management Game

**Status:** Initial PRD  
**Platforms:** macOS and Windows  
**Initial mode:** Single-player  
**Priority:** Visual fidelity → Core interactions → Real-world geography → Simulation depth  
**Primary inspiration:** City Transport Manager by PeDePe

---

## 1. Vision

Create a beautiful, relaxing but strategically challenging desktop public transport management game where players can start a transport company in real-world locations.

Players should be able to select their hometown, a major city, or a small village and build a functioning public transport network using the actual streets and geography.

The visual aesthetic should take strong inspiration from City Transport Manager: miniature-looking, simplified 3D buildings, muted map colours, colourful transport networks, small animated vehicles, and clean, elegant management interfaces.

However, the game must be designed for desktop computers from the beginning. It must provide more precise controls, deeper planning tools, better timetables, and more meaningful transport-company management.

The application should feel like a premium desktop strategy game, not a mobile game stretched onto a larger screen.

**Core philosophy: The map is the game. Everything else should exist elegantly on top of it.**

### Product principles

1. Design quality is non-negotiable.
2. Real-world geography is fundamental.
3. Keep the miniature-map aesthetic rather than pursuing photorealism.
4. Use elegant floating cards, not conventional dashboard layouts.
5. Give the player deep control without overwhelming them.
6. Build a challenging economy with meaningful progression, not an unlimited-money sandbox.
7. Prioritise an excellent single-player experience.
8. Keep simulation architecture modular so multiplayer can be added later.

---

# 2. MANDATORY PHASE ZERO — VISUAL RESEARCH

**CRITICAL INSTRUCTION TO THE DEVELOPMENT AGENT:**

Do not immediately begin implementing the game.

First, conduct detailed visual research using the official City Transport Manager website, press kit and screenshots.

The visual result is central to the project. A functioning transport game with a generic map, ordinary UI or unattractive buildings does not satisfy this PRD.

## 2.1 Primary references

Official website:

https://citytransportmanager.com/

Official press kit:

https://citytransportmanager.com/presskit/

App Store listing:

https://apps.apple.com/gb/app/city-transport-manager/id6811033778

The press kit contains full-resolution screenshots. The agent must open and inspect these images, not merely read their filenames or rely on textual descriptions.

### Essential screenshots

**A. Hamburg — close-up 3D bus scene**

https://citytransportmanager.com/presskit/files-screens/iPhone/ctm-hamburg-04-bus-nah.png

Study:
- Building shape and height
- Roof styling
- Road widths and pavement colours
- Tree models
- Vehicle proportions
- Camera pitch
- Shadows and lighting
- Visual detail density

**B. London — stylised 3D city**

https://citytransportmanager.com/presskit/files-screens/iPhone/ctm-london-03-doppeldecker-nah.png

Study:
- How recognisable city streets are retained
- Building footprints
- How structures overlap visually
- How buses are represented
- Street labels and POI indicators
- Colour saturation and contrast

**C. Hamburg — route construction**

https://citytransportmanager.com/presskit/files-screens/UI-English/ctm-hamburg-08-linienbau.png

Study:
- Route line rendering
- Stop markers and numbering
- Catchment circles
- Demand overlays
- On-map interaction controls
- Colour-coded network visualisation

**D. Network management**

https://citytransportmanager.com/assets/img/ui/hamburg-10-linien-en.webp

Study:
- Panel colours
- Typography
- Spacing
- Tabs
- Rounded corners
- Status indicators
- Hierarchy between important and secondary information

**E. Vehicle market**

https://citytransportmanager.com/assets/img/ui/hamburg-15-fahrzeugmarkt-en.webp

Study:
- Vehicle previews
- Purchase controls
- Vehicle statistics
- Segmented controls
- Information grouping
- Button styles

**F. Financial management**

https://citytransportmanager.com/assets/img/ui/hamburg-13-finanzen-en.webp

Study:
- Financial hierarchy
- Colour use
- Summary presentation
- Tabs
- Card dimensions

**G. Passenger satisfaction**

https://citytransportmanager.com/presskit/files-screens/UI-English/ctm-hamburg-17-zufriedenheit.png

Study:
- Satisfaction metrics
- Progress bars
- Icons
- Positive and negative status colours
- Density of information within a compact panel

The agent must additionally review the available iPad screenshots, as their wider composition is particularly useful for understanding how the visual language might adapt to desktop.

## 2.2 Required research deliverables

Before writing application code, produce:

**`docs/design/reference-analysis.md`**

A structured visual analysis of the game with observations and evidence for:
- Map aesthetic
- Buildings and environment
- Vehicles
- Lighting and camera
- Colours
- Typography
- Floating panels
- Information hierarchy
- Route construction tools
- Animation and interaction behaviour

**`docs/design/reference-board.md`**

An organised reference board containing screenshot links, descriptions, and annotations highlighting design elements worth adapting.

**`docs/design/design-system.md`**

A proposed original design system including:
- Colour palette
- Typography
- Layout and spacing
- Card styles
- Button styles
- Iconography
- Vehicle visual conventions
- Map styling
- Motion language
- Interaction states

**`docs/design/desktop-layouts.md`**

Desktop interface concepts for:
1. Normal city view
2. Route construction
3. Line inspection
4. Vehicle purchasing
5. Finances
6. Company overview

Include at least three distinct visual directions for the desktop UI, all compatible with the reference game's overall aesthetic. Explain their trade-offs and recommend one.

**`docs/design/visual-validation.md`**

Describe how the chosen UI and world renderer will be compared against the research references.

### Research gate

Implementation must not begin until these documents and visual concepts have been produced and the selected visual direction is approved.

Use browser screenshots or direct image inspection to ground every important design claim.

Do not invent details about the reference game that have not been observed.

Do not copy the reference game's copyrighted screenshots, models, logos or interface assets into the new product. Create original assets and components inspired by the underlying design principles.

---

# 3. Visual Art Direction

## 3.1 World aesthetic

The city should resemble a detailed miniature model placed on top of a real-world map.

Buildings must follow real geographic footprints wherever data is available.

The art style should be low-poly or simplified geometric 3D.

### Buildings

- Primarily neutral beige, warm grey, off-white and subdued taupe.
- Simple facades without excessive windows or texture.
- Flat or gently sloped roofs.
- Realistic heights when the data is trustworthy.
- Sensible inferred heights when data is missing.
- No exaggerated randomly generated skyscrapers.
- Soft shadows and restrained ambient lighting.
- Do not add decorative details simply to demonstrate rendering capabilities.

Different building types may have subtle colour variation, but the overall city should maintain a cohesive and visually quiet aesthetic.

At wide zoom levels, buildings can become simple shapes or footprints to maintain clarity.

### Streets

- Light grey and blue-grey surfaces.
- Roads should remain distinguishable from buildings without becoming visually dominant.
- Real road layouts, including one-way systems, junctions, bridges and roundabouts.
- Road arrows and direction indicators shown contextually.
- Simplified intersections that remain geographically accurate enough for transport routing.
- Appropriate visual treatment of pedestrian-only and restricted roads.

### Vegetation and terrain

- Muted pastel greens.
- Small, rounded or geometric trees.
- Parks and forests represented with simplified vegetation.
- Rivers and lakes rendered in desaturated blue.
- Avoid overly saturated lawns and forests.
- Terrain elevation may be introduced later, but accurate street geography takes precedence.

### Vehicles

- Small but visually recognisable 3D models.
- Simple geometry with clear silhouettes.
- Customisable company colours.
- Correct orientation on roads.
- Smooth movement and believable turning.
- Appropriate vehicle scale relative to buildings and road widths.
- No excessive model detail.

The scene should feel alive through moving vehicles and subtle animations rather than visual clutter.

## 3.2 Camera

Support a continuous, smooth 3D map camera.

Required interactions:
- Pan with mouse drag.
- Zoom with scroll wheel.
- Rotate using a mouse gesture or keyboard shortcut.
- Adjust pitch.
- Double-click to focus.
- Select a vehicle and follow it.
- Reset to a comfortable isometric view.
- Smooth transitions between saved locations.

The default camera should show enough building height to create the miniature-city effect while preserving road and route legibility.

Avoid excessively steep angles that make route planning difficult.

## 3.3 Lighting

Use soft daytime lighting as the visual baseline.

Requirements:
- Gentle shadows.
- Neutral-to-warm ambient light.
- Buildings remain readable at different angles.
- No strong reflections or realistic atmospheric effects.
- Minimal harsh colour grading.

A simplified evening mode may be considered later. Day/night rendering must never undermine the established pastel art direction.

---

# 4. Desktop UI and UX

## 4.1 Primary layout

The map must occupy the entire application window, including the space behind floating UI elements.

Avoid traditional permanently docked dashboard layouts.

The normal gameplay screen should keep approximately 75–85% of the map visually unobstructed, with the UI adjusting depending on the selected task.

### Top-left

A compact cluster containing:
- Company identity
- City name
- Main navigation launcher

### Top-centre

A floating simulation control:
- In-game time
- Date
- Pause/play
- Simulation speed

### Top-right

Compact economic and operational indicators:
- Available funds
- Daily profit/loss
- Passenger satisfaction
- Notifications

### Left edge

A compact tool rail for:
- Select
- Build bus stop
- Create route
- Edit network
- Traffic overlay
- Demand overlay

Tools should use recognisable icons with clear hover tooltips.

### Right side

A contextual floating inspector.

It opens when an object is selected and displays information relevant to that object.

For example:
- Selected bus: vehicle status, route, occupancy, next stop
- Selected line: stops, profitability, frequency, vehicles
- Selected stop: passenger demand, waiting passengers, served lines

The inspector should not permanently occupy space when nothing is selected.

### Bottom area

A compact context-sensitive tray for detailed operations such as:
- Timetable editing
- Vehicle assignment
- Route construction
- Financial analysis

It should be collapsible and should leave the map visible wherever practical.

## 4.2 Cards and panels

Use compact, refined, floating cards.

Inspired by the reference game's panels, the desktop UI should use dark charcoal and very deep green surfaces with slightly lighter internal sections.

Suggested starting tokens, to be refined through visual research:

- Primary card: `#19211E`
- Secondary surface: `#26322C`
- Primary text: `#F4F5F1`
- Secondary text: `#ACB8B0`
- Accent blue: `#55AAE5`
- Success green: `#83D4A5`
- Warning amber: `#E8B954`
- Error coral: `#E98579`

These are provisional colours, not claimed exact matches to the reference.

Cards should have:
- Subtle rounded corners
- Consistent internal spacing
- Clear information hierarchy
- Carefully chosen type sizes
- Soft, minimal shadows
- No excessive glassmorphism
- No unnecessary gradients
- No oversized mobile-style controls

Use small icons, concise labels and meaningful visual indicators.

## 4.3 Interaction design

Every major action needs thoughtful feedback.

Examples:
- Hovering a stop highlights its catchment area.
- Hovering a route highlights all of its segments.
- Selecting a vehicle smoothly moves the camera to it.
- Dragging a route waypoint previews the new path before committing.
- Changing a schedule previews expected fleet and frequency changes.
- Invalid operations explain why the action is not permitted.
- Purchasing a vehicle updates the relevant company information visibly.

Transitions should be smooth and understated, not theatrical.

### UX principle

Progressive disclosure: show essential controls immediately; reveal detailed management information when requested.

The player should be able to observe the city without constant panels covering it.

---

# 5. Real-World Map System

## 5.1 Worldwide location selection

The player can search for any sufficiently mapped location.

Examples:
- Istanbul
- London
- Durham
- Tokyo
- A small village
- Their own neighbourhood

Search results should include enough location information to disambiguate places with similar names.

Before creating a game, inspect the available mapping coverage.

Display meaningful coverage indicators:
- Road network available
- Building geometry available
- Points of interest available
- Traffic data available or unavailable

Do not falsely imply that all locations have equivalent source-data coverage.

## 5.2 Data sources

Investigate:
- OpenStreetMap for streets, restrictions and points of interest
- Overture Maps for building footprints and attributes
- A suitable vector-tile provider or legally compliant self-hosted tile system
- A geocoding provider capable of supporting desktop-game search

Use local and provider caching only where licensing permits.

Preserve required source attribution.

Do not depend on the public OpenStreetMap tile or Nominatim servers for heavy game use, bulk extraction or unsupported autocomplete.

## 5.3 Building generation

The map renderer must transform real building footprints into simplified 3D objects.

Algorithm:
1. Load building polygons for the visible area.
2. Determine available building height or floor count.
3. Use height data when credible.
4. Infer conservative height ranges when missing.
5. Apply the original stylised building materials.
6. Optimise geometry and cull invisible features.
7. Transition smoothly between building detail levels while zooming.

The world must remain geographically recognisable.

## 5.4 Rendering performance

The map renderer should support large urban areas without excessive draw calls or memory usage.

Use:
- Vector tiles
- Dynamic area loading
- Geometry simplification
- Level-of-detail transitions
- Instancing where appropriate
- Appropriate GPU and CPU profiling

Evaluate performance in both dense city centres and rural areas.

---

# 6. Core Gameplay

## 6.1 Starting a company

The player selects a city and establishes a transport company.

Initial decisions:
- Company name
- Brand colour
- Starting operating area
- Initial depot location
- First vehicle purchases

The game starts with limited funds and an achievable operating area.

This is a management game, not an unrestricted sandbox.

The player must create useful services, attract passengers, generate income and expand their company sustainably.

## 6.2 Bus stop placement

Players place stops along valid roads.

Stop placement must consider:
- Road direction
- Road access
- Pedestrian accessibility
- Distance to nearby destinations
- Proximity to other stops
- Road restrictions

When placing a stop, show an approximate walking catchment area.

Demand previews should help the player understand what nearby destinations might be served.

## 6.3 Route construction

The route editor must be substantially more powerful than a typical mobile route tool.

Players can:
- Create named and coloured lines
- Add and remove stops
- Reorder stops
- Add intermediate waypoints
- Drag route segments
- Inspect individual street choices
- Construct one-way loops
- Create outbound and inbound variants
- Adjust a route without rebuilding it
- Undo and redo edits
- Save and discard drafts

Routes must follow valid connected road geometry.

A route cannot cut through buildings, cross a river without a valid crossing, or travel against a one-way restriction without authorisation.

### Route editing experience

1. Activate the route creation tool.
2. Choose an origin stop.
3. Select additional stops.
4. The system proposes a valid path along the road network.
5. Drag the path to modify the chosen streets.
6. View predicted distance, journey time and initial operating requirements.
7. Confirm the route.
8. Assign vehicles and operating hours.

The entire process should happen visually on the map.

## 6.4 Vehicles

Start with:
- Minibuses
- Standard buses
- Double-deckers
- Articulated buses in later progression

Vehicles have:
- Purchase cost
- Operating cost
- Capacity
- Speed characteristics
- Maintenance requirements
- Company livery

Allow individual vehicle assignment and reassignment.

Vehicles must visibly travel along their actual routes.

## 6.5 Timetables

Provide a basic frequency editor first, followed by advanced timetable controls.

Basic controls:
- Start/end service times
- Service interval
- Vehicle allocation
- Weekday/weekend variations

Advanced controls:
- Individual departures
- Peak and off-peak schedules
- Timetable grid
- Layover times
- Vehicle circulation
- Schedule conflict warnings

A visual timeline should allow departures to be moved and adjusted.

The simulator must account for traffic-induced delays.

---

# 7. Real Traffic and Congestion

Traffic is a major differentiating feature.

The objective is to make the real road network behave believably across different times of day.

For example, a bus in Istanbul should not experience identical travel times at 06:00 and 17:30.

## 7.1 Traffic modes

### Historical traffic profile

Preferred standard gameplay mode.

The simulator uses typical traffic conditions based on:
- Local time of day
- Day of week
- Road segment
- Available historical speed information

As the game clock advances, traffic conditions change.

### Live traffic

Future enhancement.

Where a suitable licensed service is available, real-time conditions can influence gameplay.

Live traffic must be clearly labelled.

### Simulated traffic fallback

When measured traffic data is unavailable, estimate congestion using:
- Road class
- Population and land use
- Typical commuting hours
- Junction density
- Road capacity
- Local trip demand

Do not describe estimates as real measurements.

## 7.2 Effects on gameplay

Congestion should affect:
- Travel time
- Delays
- Timetable reliability
- Vehicle requirements
- Fuel or energy usage
- Operating costs
- Passenger satisfaction
- Route attractiveness

The player should be able to inspect traffic visually using a clear map overlay.

## 7.3 Data investigation

Research TomTom and HERE, including:
- Historical traffic coverage
- Segment-level speed data
- Live data availability
- Licensing for game use
- Storage and caching restrictions
- Pricing and API usage
- Coverage differences between locations

Do not integrate a paid provider without evaluating usage costs and licensing.

Build a traffic-provider abstraction so data sources can be changed without rewriting the simulation.

---

# 8. Passenger Simulation

Passengers must have meaningful travel purposes rather than simply spawning at random stops.

Use available land-use and point-of-interest data to model:
- Residential origins
- Employment destinations
- Schools and universities
- Shopping
- Healthcare
- Leisure destinations

Create time-of-day demand patterns.

Passengers evaluate:
- Walking distance
- Expected waiting time
- In-vehicle travel time
- Transfers
- Ticket price
- Crowding
- Service reliability

Initially, passenger groups may be simulated statistically rather than as individual animated characters.

The player should be able to inspect why a line is successful or unsuccessful.

The demand model must distinguish estimates from genuine source data.

---

# 9. Economy and Progression

The financial system should be understandable but challenging.

## Revenue
- Ticket sales
- Passenger passes
- Appropriate public-service contracts or subsidies
- Later business opportunities

## Expenses
- Vehicle purchases
- Operating costs
- Maintenance
- Depot costs
- Infrastructure investments
- Staffing costs in later versions

## Management decisions
- Ticket prices
- Fleet capacity
- Service frequency
- Route profitability
- Expansion decisions
- Infrastructure priorities

The player starts small and expands through successful operation.

Avoid unnecessary grinding, artificial timers and arbitrary resource currencies.

Progression should reward intelligent planning rather than repeated clicking.

Trams and metro infrastructure should become available through technological, financial and operational progression.

Bankruptcy, financial restructuring or emergency assistance can be introduced after the initial economy is balanced.

---

# 10. Management Screens

All management views must preserve the same design language.

### Company overview
A compact, visually appealing summary of finances, passenger demand, network health and current challenges.

### Lines
A searchable list with line colour, stops, frequency, vehicles, profitability, occupancy and passenger satisfaction.

Selecting a line should highlight it on the map.

### Fleet
Vehicle cards with stylised 3D previews, specifications, costs, assignment and condition.

### Finances
Compact summaries with optional detailed graphs and comparisons.

### Timetables
A powerful desktop editor using tables and a visual timeline without sacrificing map context.

### Stops
Catchment, demand, waiting passengers, served lines and accessibility.

### Traffic
Map overlay with congestion levels, time selection and segment inspection.

All these screens should use floating cards, inspectors or expandable trays rather than navigating away from the city to unrelated full-screen dashboards.

---

# 11. Desktop Controls

Recommended default controls:

| Input | Action |
|---|---|
| Left click | Select |
| Left drag on empty map | Pan |
| Scroll | Zoom |
| Right drag | Rotate/tilt |
| WASD / arrows | Move camera |
| Q / E | Rotate |
| Esc | Cancel tool or close panel |
| Ctrl/Cmd + Z | Undo |
| Ctrl/Cmd + Shift + Z | Redo |
| Space | Pause/resume |
| F | Follow selected vehicle |

Controls should be remappable where practical.

Ensure that route construction tools do not conflict with ordinary map navigation.

Support standard desktop window resizing and high-DPI displays.

---

# 12. Technical Direction

Recommended initial stack:

- **Tauri:** Native desktop application wrapper
- **React + TypeScript:** User interface
- **MapLibre GL JS:** Map rendering and 3D building extrusion
- **Custom WebGL/Three.js layer if needed:** Stylised moving vehicles
- **OpenStreetMap / Overture:** Geographic data
- **Custom routing graph:** Road-following network design
- **Dedicated simulation module:** Transport, demand, traffic and economy
- **Local database:** Saved companies and game state

The agent must research alternatives and justify the final choice, especially the map renderer's ability to support the required visual style and moving 3D vehicles.

Separate these systems:
1. Geographic data ingestion
2. Map rendering
3. Transport graph and routing
4. Vehicles and movement
5. Passenger demand
6. Economy
7. UI and interaction
8. Persistence

Simulation code must not depend on React component state.

Use clear interfaces between systems so that a future multiplayer server could eventually run the simulation independently.

No multiplayer implementation is required now.

---

# 13. Future Multiplayer — Not in Initial Scope

The eventual vision includes:

**Cooperative companies:** Multiple friends manage one transport company, with roles such as Director, Network Planner, Economist and Operations Manager.

**Rival companies:** Multiple businesses compete within the same geographic market.

The current architecture should avoid unnecessarily preventing these capabilities.

However, do not implement multiplayer, authentication, invitations, shared sessions or server infrastructure during the initial development phases.

Single-player quality takes precedence.

---

# 14. Development Phases and Deliverables

## Phase 0 — Visual research and design approval

Deliver:
- Screenshot analysis
- Reference board
- Original design system
- Three desktop UI directions
- Selected design concept
- Visual validation criteria

Do not begin main application implementation until this phase is complete.

## Phase 1 — Beautiful interactive city

Deliver:
- Desktop application shell
- Real-world location search
- Simplified 3D buildings
- Stylised roads, parks and water
- Smooth camera
- Original floating UI
- Basic points of interest
- Performance-conscious map rendering

This phase must already look like a transport management game, not a generic mapping website.

## Phase 2 — First operational bus line

Deliver:
- Bus stop placement
- Route creation
- Road-following paths
- One simple vehicle model
- Vehicle animation
- Basic game clock
- Saving and loading

Required demonstration: select Istanbul, construct a short bus route and watch a vehicle complete the journey along actual roads.

## Phase 3 — Playable company

Deliver:
- Starting funds
- Vehicle purchasing
- Line and fleet management
- Frequency settings
- Passenger demand
- Ticket revenue
- Operating costs
- Basic company progression

## Phase 4 — Traffic and deeper management

Deliver:
- Time-of-day congestion
- Traffic overlays
- More advanced demand modelling
- Peak/off-peak timetables
- Traffic-affected vehicle movement
- Improved financial analysis

## Phase 5 — Expansion

Deliver:
- Improved depot management
- Trams
- Metro planning
- Deeper transport economics
- Additional strategic challenges

Multiplayer remains a later, separate project.

---

# 15. Visual Quality Acceptance Criteria

The game is not ready for approval merely because its functions work.

For every milestone, the agent must capture screenshots of the implementation and compare them with the visual reference board.

The review must check:

- Does the map resemble a cohesive miniature 3D city?
- Are building heights, colours and proportions convincing?
- Are the real streets geographically recognisable?
- Is the overall colour balance muted and attractive?
- Do the vehicles fit naturally into the environment?
- Are the interface cards polished and consistently styled?
- Does the map remain the main visual focus?
- Are labels, routes and controls readable?
- Is the UI genuinely designed for desktop?
- Are animations restrained, smooth and purposeful?
- Does the city look good both with and without UI panels?

Perform visual reviews at 1920×1080 and 2560×1440, plus at least one smaller desktop size.

Use side-by-side screenshot comparison and record specific discrepancies.

A generic default MapLibre map is not considered visually complete.

---

# 16. Functional Acceptance Criteria

The first major playable milestone must support:

1. Launching the native desktop application.
2. Searching for a real location.
3. Loading a corresponding geographic map.
4. Displaying appropriate simplified 3D buildings.
5. Smoothly navigating the city.
6. Placing valid bus stops.
7. Constructing a road-following route.
8. Assigning a vehicle.
9. Watching the vehicle travel along the route.
10. Saving, quitting and reloading the game without losing progress.

Test in at least two geographically different places: one dense urban location such as Istanbul and one smaller town.

Map gaps, provider failures and missing height data must have understandable fallback behaviour.

Vehicle routes must not visibly cross unrelated buildings or waterways without valid connections.

---

# 17. Performance and Quality

Target smooth 60 FPS city navigation on the chosen baseline desktop hardware, subject to profiling and realistic supported map sizes.

Monitor:
- Frame time
- Memory consumption
- Tile loading
- Visible building count
- Vehicle rendering
- Simulation update cost
- Camera responsiveness

Avoid unnecessary dependency installations and overly elaborate infrastructure in the earliest phases.

Use automated tests for routing geometry, financial calculations, save/load integrity and simulation timing.

Use visual regression tests for important desktop UI screens where practical.

---

# 18. AI Agent Implementation Workflow

The coding agent must approach this as a design-led game development project, not simply a feature implementation exercise.

Use specialised research and implementation subagents when available.

### Design Research Agent
Inspect the official website, full-resolution screenshots and supporting references. Produce a detailed description of the visual language.

### Map and Rendering Research Agent
Investigate the best rendering architecture, 3D building generation, map styling, vehicle rendering and performance strategies.

### UX Design Agent
Translate the mobile-inspired design into an original desktop interaction system with floating cards, contextual panels and precise mouse controls.

### Simulation Architecture Agent
Plan the geographic road graph, routing, vehicle movement, traffic, passenger simulation and economy independently of the UI.

### Implementation Agent
Build the approved visual direction and required functionality in small, testable increments.

### Visual QA Agent
Capture screenshots of the implementation, compare them against the reference analysis, identify differences and verify corrections.

Agents should share written research findings rather than operate from unsupported assumptions.

**Mandatory quality loop: Research → Design → Review → Implement → Screenshot → Compare → Refine.**

The team must not claim to have visually inspected something unless it actually retrieved and viewed the image or rendered screen.

The team must not mark visual tasks complete solely because the code compiles.

---

# 19. Explicit Non-Goals

For the first release, do not build:

- Multiplayer
- Rival-company servers
- Employee role permissions
- User accounts
- Complex online social features
- Unrestricted sandbox mode
- Photorealistic city environments
- Detailed interiors
- Individually modelled pedestrians
- Global real-time traffic subscriptions without a cost/licence review
- Every transport mode at once
- An elaborate online backend before it is needed

Do not let speculative future features distract from the core experience.

---

# 20. Definition of Success

The game succeeds when a player can open the desktop application, choose somewhere familiar in the real world, immediately recognise the geography, and enjoy interacting with a beautifully stylised miniature city.

They should be able to start a modest transport business, create useful routes, watch their vehicles operate, respond to passenger demand, and improve their network through real decisions.

The map, moving vehicles and management interface should feel like one cohesive premium product.

**The essential goal is to capture the charm, clarity and visual appeal of City Transport Manager while creating a deeper, more precise and genuinely desktop-native transport management experience.**

### Immediate instruction to the agent

Start with Phase 0.

Inspect every linked reference image and the official screenshot gallery. Produce the research documents, three desktop UI concepts and an original design system. Recommend the visual direction most faithful to the desired miniature-map aesthetic.

Do not skip visual research. Do not implement the full game before the visual direction has been established and approved.
