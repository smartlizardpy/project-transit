// Quick single screenshot: node scripts/shot.mjs <out.png> [width] [height] [jsToEval]
import { chromium } from 'playwright';
const [out, w = '1920', h = '1080', js = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(process.env.URL || 'http://127.0.0.1:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__map && window.__map.loaded && window.__map.loaded(), null, { timeout: 30000 }).catch(() => logs.push('map not loaded in time'));
if (js) await page.evaluate(js);
await page.waitForFunction(() => window.__map && window.__map.areTilesLoaded() && !(window.__city && window.__city.busy), null, { timeout: 30000 }).catch(() => logs.push('tiles timeout'));
await page.waitForTimeout(+(process.env.WAIT || 1800));
await page.screenshot({ path: out });
const info = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const d = gl && gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'no-webgl2'; });
console.log('renderer:', info);
console.log(logs.filter((l) => !l.includes('[vite]')).slice(0, 25).join('\n'));
await browser.close();
