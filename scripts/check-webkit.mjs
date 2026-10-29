// Loads the app in WebKit (the engine behind Tauri's macOS webview) and saves a screenshot.
//   pnpm build && pnpm preview --port 4173 &   then:   node scripts/check-webkit.mjs out.png
import { webkit } from 'playwright';
const [out = 'webkit-check.png', url = 'http://127.0.0.1:4173/'] = process.argv.slice(2);
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
await page.goto(url);
const ok = await page.waitForFunction(() => window.__map && window.__map.loaded() && window.__map.areTilesLoaded() && window.__city && !window.__city.busy, null, { timeout: 40000 }).then(() => true).catch(() => false);
await page.waitForTimeout(2500);
const info = await page.evaluate(() => ({ ua: navigator.userAgent, tiles: window.__city?.tileCount, gl: (() => { const gl = document.createElement('canvas').getContext('webgl2'); return gl ? gl.getParameter(gl.VERSION) : 'none'; })() }));
console.log('ready', ok, JSON.stringify(info));
await page.screenshot({ path: out });
console.log(logs.slice(0, 30).join('\n'));
await browser.close();
