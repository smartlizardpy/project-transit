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
  { title: 'Trams and metro', status: 'planned', body: 'In the design document, not yet in the game.' },
  { title: 'Deeper depots and economics', status: 'planned', body: 'More to manage once the bus game is balanced.' },
];
