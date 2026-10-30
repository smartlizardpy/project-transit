// Links and facts the whole page uses. Every URL here has been checked to exist.
export const REPO = 'https://github.com/smartlizardpy/project-transit';
export const RELEASES = `${REPO}/releases/latest`;
export const PROGRESS = `${REPO}/blob/main/docs/development-progress.md`;
export const README = `${REPO}#readme`;
export const ISSUES = `${REPO}/issues`;

/** The newest published build. Update with each release (see website/README.md). */
export const RELEASE = {
  version: '0.2.1',
  date: '2026-10-30',
  url: `${REPO}/releases/tag/v0.2.1`,
};

export const BASE = import.meta.env.BASE_URL;

/** The hero picture and, when one has been captured, the gameplay loop that plays over it. */
export const HERO: { image: string; alt: string; video: { mp4: string; webm?: string } | null } = {
  image: 'hero',
  alt: 'İstanbul in Project Transit: the Golden Horn and the Galata Bridge as a pale miniature city, with three coloured bus lines and small buses crossing the bridge.',
  // 10 s of real gameplay, rendered frame by frame from the game (scripts/capture-media.mjs)
  video: { mp4: `${BASE}media/hero.mp4`, webm: `${BASE}media/hero.webm` },
};

/** Stops on the page's line, in order. The ids are section anchors. */
export const STOPS = [
  { id: 'places', name: 'Real places' },
  { id: 'routes', name: 'Routes' },
  { id: 'living', name: 'Living city' },
  { id: 'company', name: 'Company' },
  { id: 'screenshots', name: 'Screenshots' },
  { id: 'development', name: 'Development' },
] as const;

export const NAV = [
  { href: '#places', label: 'The game' },
  { href: '#routes', label: 'Features' },
  { href: '#screenshots', label: 'Screenshots' },
  { href: '#development', label: 'Development' },
] as const;

export const formatDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
