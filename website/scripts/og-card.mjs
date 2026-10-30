// Renders the social-share card (public/og.jpg, 1200×630) from a real game screenshot with
// the name set in the site's typeface. Run after optimize-media.mjs:
//   node scripts/og-card.mjs <raw captures dir> [source file]
// Needs Playwright with Chromium (installed in the repository root).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(pathToFileURL(join(root, '../node_modules/playwright/index.mjs')).href);
const src = join(resolve(process.argv[2]), process.argv[3] ?? 'hero-istanbul-e.png');
const img = `data:image/png;base64,${readFileSync(src).toString('base64')}`;
const font = `data:font/woff2;base64,${readFileSync(join(root, 'node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2')).toString('base64')}`;
const mark = `data:image/png;base64,${readFileSync(join(root, 'public/mark-96.png')).toString('base64')}`;

const html = `<!doctype html><html><head><style>
@font-face { font-family: Figtree; src: url(${font}) format('woff2'); font-weight: 300 900; }
* { margin: 0; box-sizing: border-box; }
body { width: 1200px; height: 630px; overflow: hidden; background: #ebe8e0; font-family: Figtree; }
.img { position: absolute; inset: 0; background: url(${img}) 70% 45% / 175% auto no-repeat;
  -webkit-mask-image: linear-gradient(90deg, transparent 8%, rgba(0,0,0,.35) 34%, #000 58%); }
.copy { position: absolute; left: 64px; top: 0; bottom: 0; display: grid; align-content: center; gap: 26px; width: 560px; }
.brand { display: flex; align-items: center; gap: 14px; font-size: 26px; font-weight: 760; color: #18201b; letter-spacing: -0.01em; }
.brand img { width: 52px; height: 52px; border-radius: 12px; }
h1 { font-size: 74px; line-height: .95; font-weight: 800; letter-spacing: -0.045em; color: #18201b; }
p { font-size: 24px; font-weight: 500; color: #3f4a44; }
</style></head><body><div class="img"></div><div class="copy">
<div class="brand"><img src="${mark}">Project Transit</div>
<h1>Build the bus network your city deserves.</h1>
<p>A desktop game about running buses in real cities.</p>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(root, 'public/og.jpg'), type: 'jpeg', quality: 86 });
await browser.close();
console.log('wrote public/og.jpg');
