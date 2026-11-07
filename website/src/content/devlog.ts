// Development status. Keep this honest: only list work that is in the game, and mark
// anything else as planned. Dates are the dates of the commits or releases they describe.
// Source of truth: docs/development-progress.md and the git history.

export type Status = 'done' | 'partial' | 'planned';

export interface Milestone {
  name: string;
  status: Status;
  summary: string;
}

/** The milestones from docs/development-progress.md, in order. */
export const MILESTONES: Milestone[] = [
  { name: 'A real bus service', status: 'done', summary: 'Stops, road-following lines, timetables, and buses that carry passengers and earn fares.' },
  { name: 'A real company', status: 'done', summary: 'Six bus models, depots, running costs, a full ledger, loans, and saves you can trust.' },
  { name: 'A real challenge', status: 'partial', summary: 'Demand from real geography, simulated traffic, reputation, objectives and expansion. The pace still needs human playtesting.' },
  { name: 'The desktop experience', status: 'partial', summary: 'Start menu, new-company flow, arrival boards, inspectors, line editor and shortcuts.' },
  { name: 'Quality and balancing', status: 'partial', summary: 'End-to-end play tests, performance budgets and an economy retune. Balancing continues.' },
];

export interface Update {
  date: string;
  title: string;
  body: string;
  /** link to the release or source, if there is one */
  href?: string;
}

/** Newest first. */
export const UPDATES: Update[] = [
  {
    date: '2026-11-07',
    title: '0.6.0: Race a friend',
    body: 'Choose Race a friend on the start screen, pick a city and a length, and send the code. Everyone founds a company in the same home area, with the same money, at the same moment, and one clock runs for all. A scoreboard under the clock counts each company’s journeys, your rivals’ lines show dashed on your map, and whoever has carried the most when time runs out wins. This is also the first download with playing together: the 0.5.0 build never reached the downloads page.',
    href: 'https://github.com/smartlizardpy/project-transit/releases/tag/v0.6.0',
  },
  {
    date: '2026-11-07',
    title: '0.5.0: Play together',
    body: 'Up to four people can now run one company in the same game. The host chooses Play with friends in the menu and sends a code; friends choose Join a friend and type it in. Everyone sees each other’s mouse on the map, anyone can build, buy or change anything, and Option-click (Alt-click) points at a spot for everyone. Computers connect directly, with no accounts or game server. To keep every copy identical, the simulation now does its maths the same way on every computer, Mac and Windows alike.',
  },
  {
    date: '2026-11-07',
    title: '0.4.2: Smoother on fast screens, and the interface stays put',
    body: 'On 144 Hz and 240 Hz screens the map was redrawn on every screen frame, which made the game lag on some gaming PCs. It now draws at about 60 frames a second by default, while moving the map stays as smooth as your screen. Settings has a new Graphics section: a frame rate limit, a lower resolution for slower graphics, and a frame rate readout that names the graphics card the game is using, so you can tell when Windows runs it on the integrated chip. Also fixed: typing a capital U in the company name hid the whole interface (F10 or Shift+U brings it back), and panning with WASD was too fast on fast screens.',
    href: 'https://github.com/smartlizardpy/project-transit/releases/tag/v0.4.2',
  },
  {
    date: '2026-11-01',
    title: '0.4.1: Improve service, and AI agents in the running game',
    body: 'A new Improve service button in the satisfaction popover finds why passengers are unhappy (long waits, slow journeys, full buses, people with no bus home) and proposes changes you could make yourself: spare buses moved to where people wait, timetables fitted to the buses, and shorter routes. Try them on a copy of your company first, then apply or undo them. Loop lines now take people home: riders going back to an earlier stop stay on the bus round the loop. With live access switched on, AI agents can read the running game and its analytics, and build and test Automation Studio workflows. Their workflows suggest changes for you to approve; only you can make one automatic.',
    href: 'https://github.com/smartlizardpy/project-transit/releases/tag/v0.4.1',
  },
  {
    date: '2026-10-31',
    title: '0.4.0: A city that moves by itself',
    body: 'People now make whole days of trips: work, school, university, shopping, hospitals, the airport, nights out and events. Ten kinds of traveller choose between walking, cycling, car, taxi, the city’s own metro, trams, rail and ferries, and your buses. Airports, stations, universities and other places have opening hours, busy hours and a place card. Weather follows each city’s climate, with forecasts, and matches, concerts and rail closures change who travels. Riders can change lines on foot, or take your bus to a station and carry on by metro. Automation Studio gets control-room blocks such as holding buses for connections and lending buses between lines, plus 49 starter workflows.',
    href: 'https://github.com/smartlizardpy/project-transit/releases/tag/v0.4.0',
  },
  {
    date: '2026-10-30',
    title: '0.3.0: Network Control and Automation Studio',
    body: 'After 30 operating days at level 3, Network Control opens: passenger flows on the map, origin and destination tables, line and fleet figures, and reports. Automation Studio lets you build workflows from nodes that watch the network and suggest or make changes, with safety limits and a lab to test them on a copy of your company. Also new: clickable route warnings with fixes, and moving buses between depots.',
    href: 'https://github.com/smartlizardpy/project-transit/releases/tag/v0.3.0',
  },
  {
    date: '2026-10-30',
    title: 'First public build: 0.2.1',
    body: 'Downloads for macOS, Windows and Linux. Installed copies update themselves. Also new: a read-only connection for AI agents to look at your saved games, and a clearer new-company form.',
    href: 'https://github.com/smartlizardpy/project-transit/releases/tag/v0.2.1',
  },
  {
    date: '2026-10-30',
    title: 'The map grows with the company',
    body: 'Operating areas became map squares about 2 km across. License a neighbouring square and more of the city loads around you.',
  },
  {
    date: '2026-10-30',
    title: 'Stop spots and the territory view',
    body: 'Stops snap to real bus stops from OpenStreetMap, plus generated spots along main roads. A new overlay shows what you own and what you can license next.',
  },
  {
    date: '2026-10-30',
    title: 'Five cities checked by hand',
    body: 'Durham, Barcelona, Hamburg and Tokyo join İstanbul. Buses keep left where traffic does.',
  },
  {
    date: '2026-10-29',
    title: 'The first playable loop',
    body: 'Start menu, company setup, saves, the line editor, timetables, LED arrival boards and the finance screens.',
  },
  {
    date: '2026-10-29',
    title: 'A miniature city on real streets',
    body: 'The renderer that turns OpenStreetMap streets and buildings into a calm model city, and the simulation core underneath it.',
  },
];

/** What comes next. "planned" means designed but not started. */
export const NEXT: { title: string; status: Status; body: string }[] = [
  { title: 'Playtesting the pace', status: 'partial', body: 'How quickly a new company reaches its second and third areas, tuned with real players.' },
  { title: 'Your own trams and metro', status: 'planned', body: 'In the design document, not yet in the game. The city’s own metro, trams, rail and ferries already carry people and compete with your buses.' },
  { title: 'Deeper depots and economics', status: 'planned', body: 'More to manage once the bus game is balanced.' },
];
