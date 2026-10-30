# Website research and direction

Research behind the Project Transit website (`website/`). It covers what other game sites do well, what makes Project Transit different, and the decisions that follow.

Method: on 2026-10-30 we captured each reference site at 1440×900 (hero and full page) and 390×844 (mobile hero) with Playwright, and inspected the screenshots. Fonts were read from computed styles.

## Revision, 30 October 2026: illustrated, fewer screenshots

The first build leaned on about thirty screenshots, and most of them had the game's interface on top. Feedback: too many screenshots, and the interface hides the city. The page now:

- keeps screenshots for what only the game can show: the moving hero, the city switcher and one short strip, all with the interface hidden;
- explains the systems with drawings in the game's colours instead of interface captures: a line being built stop by stop (teal band), the LED arrival board counting down (dark band), map squares being licensed and the six buses (amber band), and a bus waiting at the terminus (coral band);
- drops the rail down the left gutter; the colour bands give the page its rhythm, and the route drawing carries the bus-line idea.

The earlier sections of this document describe the first direction and are kept for the record.

## Reference sites

| Site | What it does | Take | Avoid |
|---|---|---|---|
| [City Transport Manager](https://citytransportmanager.com/) | Dark navy page. A wordmark underlined with coloured line-and-stop strokes. Tagline "Your city. Your lines. Your transit network." A phone frame of looping gameplay. Features sit on a vertical line with a coloured stop dot each, with no icons or cards. Real captions ("Double-decker in London"). A gallery strip bleeds off the right edge. A one-line footer with the OSM credit. | The transit line as the page's structure. Captions that name real places. Image strips that bleed off the edge. | Portrait phone framing (we are a desktop game). Its tagline, which the brief's draft headline nearly repeats. A crowded nav that wraps on mobile. |
| Mini Motorways | A pale, full-bleed hero of faded game footage. One bold sentence, two calls to action. Then a hand-cut wavy edge into a band of colour taken straight from the game. | Colour bands taken from the game's palette. Very little copy. | Centred, logo-first composition; ours leads with the place. |
| Dorfromantik | A single painted diorama bleeds off the right and bottom edges and *is* the layout. A hand-lettered logo, a short paragraph, a burger menu only. | Letting one image carry the hero, with art bleeding off the edge. | Five platform buttons plus a row of social icons. |
| Townscaper | A white bar, a full-width game image, a six-line manifesto paragraph, a uniform 3×2 screenshot grid, press quotes, then an illustrated row-house footer. | Confident, short copy. A calm, uniform gallery. A hand-made ending. | Large dead gaps where lazy sections had not loaded yet. |
| Terra Nil | Painted key art, a huge wordmark, six platform buttons and a cookie banner. | (nothing new) | Too many calls to action. |
| Cities: Skylines II | Photoreal key art, nine uppercase nav items, an amber "Buy now", and a cookie modal covering the hero. | (nothing new) | Loud AAA chrome; it fights a calm game. |
| Transport Fever 2 | A boxed 1080 px column, nav in coloured tabs, a newsletter field in the header. | (nothing new) | Box-in-box layouts. |
| NIMBY Rails | Only the Steam page was reachable. | A game needs its own site to carry its mood. | |

Islanders' domain is parked, so it was skipped.

**What separates the premium sites from the generic ones:**
- **Premium:** one dominant, art-directed image; a page palette lifted from the game; few words; one clear group of calls to action; captions that say what is on screen; something hand-made.
- **Generic:** icon-card grids, gradient blobs, six or more buttons, dense navigation, and cookie walls.

## What is specific to Project Transit

- **The world is a pale paper map.** Land is `#ebe8e0`, roads `#c6ced1`, water `#a4cad6`, parks `#c9dbbb` (`src/map/palette.ts`). Only the transport network is saturated.
- **Unlicensed land is blank paper.** Only owned map squares render in full; the next ones sit under a veil with their price. "The city appears where your buses go" is the game's own visual metaphor.
- **The UI is dark green-charcoal floating cards** (`#161c19`), with warm white text and Figtree throughout.
- **The brand mark is a coral (`#e0573e`) square with bridge arches over water.** The same coral is the default bus livery.
- **The game has its own line language:** teal line badges, hollow stop rings on a vertical line in the line inspector, and LED arrival boards.
- **It is a desktop game.** Wide, cinematic crops are the honest format.

## Direction: the page is a bus line

The page sits on the game's map paper. A single teal line (Line 1, badge and all) runs down the left side. Each section is a stop: its heading sits beside a stop ring, the ring fills once you pass it, and a small bus rides the line as you scroll. The final section is the terminus. This is where the boldness goes. Everything else stays quiet so the screenshots carry the page.

How the direction was checked against generic defaults, and what changed:
- **Cream and terracotta (the most common generated look).** We use the game's own grey-green map paper, which makes screenshots melt into the page. Coral appears only in the logo and on the little bus. The action colour is the game's signal blue.
- **Eyebrow labels above every heading.** None. The stop ring carries the structure, and it means something: where you are on the line.
- **Identical rounded cards.** Content is screenshots and text, not cards. The one card on the page, the development status, is a deliberate copy of the game's inspector.
- **Numbered markers.** Used only where the content is a real sequence: the five steps of building a line.
- **The brief's draft headline** ("Your city. Your routes. Your transport empire.") is very close to City Transport Manager's tagline. We use the game's own start-menu line instead: **"Build the bus network your city deserves."**

## Typography

- **Figtree only** (variable, 300–900, SIL OFL), the typeface of the game's UI and map labels. The site speaks in the same voice as the game. The type does the work through scale and weight, not extra families.
- **Display** (hero): 800 weight, −0.045em tracking, line height 0.93, up to about 122 px.
- **Section headings:** 780 weight, −0.038em, up to 80 px. Each ends with a full stop, like a sign.
- **Lead:** about 19–22 px at 450 weight in a 40–46 character measure. **Body:** 17 px, line height 1.6, at most 62 characters.
- Labels are sentence case, never tracked capitals.

## Colour

| Token | Hex | Use |
|---|---|---|
| paper | `#ebe8e0` | page (the map's land) |
| paper-deep | `#e2ded3` | the company section |
| ink | `#18201b` | text (13.6:1 on paper) |
| ink-2 / ink-3 | `#3f4a44` / `#59635d` | secondary and caption text (7.5:1 and 5.1:1) |
| card | `#161c19` | nav, the living-city section, the status card, the footer |
| line | `#2f9e9a` | the page's bus line |
| signal | `#4fa3e0` on `#0c2233` | primary buttons, focus rings (the game's primary button) |
| amber, violet | `#e3a33b`, `#8b6fd6` | secondary line colours, only in the progression line |
| brand | `#e0573e` | logo and livery only |

## Layout

```
┌ [■ Project Transit]                   [The game Features Screenshots Development | GitHub  Download] ┐
│                                                                                    │
│  Build the bus                  ░░░ real İstanbul render, full-bleed, fading ░░░   │
│  network your                   ░░░ into blank map paper on the left/bottom ░░░   │
│  city deserves.                                                                    │
│  lead · [Download the early build] [Follow on GitHub]                             │
├────────────────────────────────────────────────────────────────────────────────────┤
│ 1                                                                                  │
│ ●  Play in real places.                     lead                                   │
│ │  [ city image, crossfades ]  ● İstanbul  ○ Tokyo  ○ Barcelona  ○ Hamburg ○ Durham │
│ │  Real / Estimated / Simulated legend                                             │
│ ●  Every route is your decision.   [screens]  1–5 steps                            │
│ ●  A city that never stops. (dark band)  [wide still bleeding right] [3 crops]     │
│ ●  Build a company, not just a network.  progression line · six buses · screens    │
│ ●  Straight from the game.  editorial grid → lightbox                             │
│ ●  In development.  [status card]  dated updates · next                            │
│ ◉  A whole city is waiting for your first route.  (territory view fading to paper) │
└ footer: brand, links, OSM attribution ─────────────────────────────────────────────┘
```

- Content is left-aligned, beside the line. The widest media bleed off the right edge, as if the map carried on.
- Mobile keeps the same order in one column. The line narrows to 30 px and the nav collapses to a menu.

## Motion

- **One orchestrated moment.** On load, the hero city fades in from paper, as buildings grow in the game, and the headline settles.
- **Everything else answers the visitor.**
  - The bus rides the line with scroll. It is CSS `position: sticky`, so there is no animation loop.
  - Stops fill once passed.
  - Cities crossfade when picked.
  - The lightbox fades in.
- **No fade-up-on-scroll for every section.**
- **`prefers-reduced-motion`** removes the load animation and hides the bus. The hero video (if present) is never loaded for those visitors or with Data Saver on, and it always has a pause button.

## Screenshots and media

- **Only real captures** from the running game, made with `website/scripts/capture-media.mjs`. Scenes are built through the game's own command API (the same commands the UI calls), then framed with the camera. No compositing, no painted-over UI.
- **Two kinds of shot:**
  - "world" shots with the interface hidden (F10), for the hero and city switcher;
  - interface shots at 1600×900, rendered at 2× so the UI cards can be cropped sharply.
- **Captions say exactly what is on screen.** Simulated traffic is captioned as simulated.
- **Formats:** AVIF with a WebP fallback, at 3–4 widths per image, with explicit width and height. Every image is lazy-loaded except the hero. The social card is a crop of a real screenshot.
- **Coverage claims stay modest.** Five cities are shown because they were checked by hand. "Search for your own town" is qualified: places look as good as their OpenStreetMap data.
