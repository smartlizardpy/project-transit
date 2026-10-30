# Project Transit website

The game's public website: one static page, built with Vite, React and TypeScript, and published to GitHub Pages. The design rationale is in [`docs/website-research.md`](../docs/website-research.md).

It is separate from the game: it has its own `package.json`, lockfile and `node_modules`, and nothing in the game imports it. It does read three files from the game, so the page never drifts from it:
- `src/game/content.ts`: the six bus models (names, sizes, unlocks).
- `src/ui/BusArt.tsx`: the game's own bus illustrations.
- `src/styles/board.css`: the LED arrival board's styles.

## Develop

```sh
cd website
pnpm install
pnpm dev        # http://127.0.0.1:5180/project-transit/
```

The dev server uses the same `/project-transit/` base path as the published site, so broken asset paths show up locally.

```sh
pnpm build      # type-check, build, prerender → dist/
pnpm preview    # serve dist/ at http://127.0.0.1:4180/project-transit/
```

`pnpm build` also prerenders the page into `dist/index.html` (`src/entry-server.tsx`, `scripts/prerender.mjs`). The content is in the HTML before any script runs, which helps first paint and link previews. React then takes over in the browser.

## Where things are

| Path | What |
|---|---|
| `src/content/site.ts` | links, the current release, hero settings, navigation |
| `src/content/cities.ts` | the five cities in the city switcher |
| `src/content/devlog.ts` | milestones, dated updates and what's next |
| `src/content/gallery.ts` | the screenshot strip: order, captions, alt text (interface-free shots only) |
| `src/content/media.json` | generated image sizes (do not edit by hand) |
| `src/sections/` | one component per page section |
| `src/illustrations/` | the drawn, animated pieces: the route being built, the arrival board, the map squares |
| `src/styles/site.css` | all styles; colours come from the game's palette |
| `public/media/` | optimised images and video (generated) |
| `media.config.json` | which raw capture becomes which image, with crops and widths |
| `scripts/capture-media.mjs` | captures fresh screenshots from the running game |
| `scripts/optimize-media.mjs` | turns raw captures into AVIF/WebP, the social card and favicons |

## Updating the page

- **A new release:** update `RELEASE` in `src/content/site.ts`, and add an entry at the top of `UPDATES` in `src/content/devlog.ts`. Download buttons link to the latest release, so they need no change.
- **Development status:** keep `devlog.ts` in step with `docs/development-progress.md`.
  - Only list what is in the game.
  - Mark anything else `planned`.
  - Use the date of the commit or release an update describes.
- **New screenshots:**
  1. Start the game's dev server from the repository root (`pnpm dev`).
  2. Capture: `node website/scripts/capture-media.mjs <raw-dir>` (see the comment at the top of that script).
  3. Point `media.config.json` at the files you want. `crop` is an ImageMagick geometry such as `1100x825+2060+380`, in source pixels.
  4. Run `pnpm media <raw-dir>`. It needs ImageMagick 7 with AVIF and WebP (`brew install imagemagick`).
  5. Add or edit captions in `gallery.ts`. Captions must say what is on screen.

  Only use images rendered by the game itself, and hide the interface (F10) for screenshots on the page: the drawings carry the interface ideas instead.
- **Drawings:** the illustrations in `src/illustrations/` are drawn for the page in the game's colours and are labelled as drawings. Names and prices in them come from real games; keep it that way. They animate once when they scroll into view and show their finished state with reduced motion or without JavaScript.

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` builds and deploys the site:
- when `main` changes anything under `website/` (or the two game files above);
- when run by hand from the Actions tab (Website → Run workflow).

The workflow uses the official Pages actions:
- `configure-pages` supplies the base path and URL;
- `upload-pages-artifact` uploads `website/dist`;
- `deploy-pages` publishes it.

**One-time setup** (repository admin): Settings → Pages → Build and deployment → Source: **GitHub Actions**. Until then, the deploy job fails with "Get Pages site failed".

The site is served at `https://smartlizardpy.github.io/project-transit/`. For a custom domain, set it in Settings → Pages. The workflow then builds with the root base path and the new canonical URL automatically. To build for another location by hand:

```sh
BASE_PATH=/ SITE_URL=https://example.org/ pnpm build
```

It is a single page with hash links (`#routes`), so there is no client-side routing to break on refresh.
