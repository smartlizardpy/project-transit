// City Activity Engine QA screenshots (phase 4): the weather chip, its popover with tomorrow's
// forecast, a rainy hour, and a weather warning, from a genuinely simulated company. Nothing is
// staged: the script runs the simulation forward until the generated weather gives each case.
// Run `node scripts/capture-network.mjs sim` first (it simulates a company and saves), with the
// dev server on port 5182, then:
//
//   NC_PROFILE=<same profile> node scripts/capture-weather.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://localhost:5182/';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots/city-activity';
const PROFILE = process.env.NC_PROFILE || join(tmpdir(), 'pt-network-control-profile');
mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  viewport: { width: 1920, height: 1080 },
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const ui = (fn, arg) => page.evaluate(fn, arg);
const settle = async (extra = 900) => {
  await page.waitForFunction(() => window.__map?.areTilesLoaded() && !window.__city?.busy, null, { timeout: 30000 }).catch(() => console.warn('  tiles timeout'));
  await page.waitForTimeout(extra);
};
const shot = async (name, extra) => { await settle(extra); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('  shot', name); };
const closePop = async () => { if (await page.locator('.wx-pop').count()) await page.locator('.wx-chip').click(); };

await page.goto(URL);
await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
await ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await ui(() => { window.__game.setSpeed(0); window.__game.setNetworkIntro?.({ seen: true }); });

/** Runs the simulation to the next time of day `h` (hours). */
const runTo = (h) => ui((hh) => {
  const g = window.__game;
  const day = Math.floor(g.t / 86400);
  let target = day * 86400 + hh * 3600;
  if (target <= g.t) target += 86400;
  g.run(target - g.t);
  return g.t;
}, h);
const weather = () => ui(() => {
  const g = window.__game;
  const d = Math.floor(g.t / 86400);
  return { day: d, hour: Math.floor((g.t % 86400) / 3600), today: g.weatherDay(d)?.actual?.kind, tomorrow: g.weatherDay(d + 1)?.forecast?.kind ?? null };
});

// 1. after 18:00: the chip shows tomorrow's forecast
await runTo(18.5);
console.log('  ', JSON.stringify(await weather()));
await shot('weather-chip', 600);
await page.locator('.wx-chip').click();
await page.waitForTimeout(400);
await shot('weather-popover', 500);
await closePop();

// 2. a rainy hour today (up to 10 days ahead), and 3. a weather warning (up to 20 days ahead)
let rain = false, warned = false;
for (let i = 0; i < 20 * 24 && !(rain && warned); i++) {
  await ui(() => window.__game.run(3600));
  const w = await ui(() => {
    const g = window.__game;
    const d = Math.floor(g.t / 86400), h = Math.floor((g.t % 86400) / 3600);
    const a = g.weatherDay(d)?.actual;
    const warn = g.state.notifications.filter((n) => / forecast for tomorrow$/.test(n.title) && n.t > g.t - 3600).length;
    return { d, h, kind: a?.kind, mm: a?.mm[h] ?? 0, warn };
  });
  if (!rain && i < 10 * 24 && w.mm >= 1 && w.h >= 7 && w.h <= 19) {
    rain = true;
    console.log('   rain', JSON.stringify(w));
    await page.locator('.wx-chip').click();
    await page.waitForTimeout(400);
    await shot('weather-popover-rain', 500);
    await closePop();
  }
  if (!warned && w.warn) {
    warned = true;
    console.log('   warning', JSON.stringify(w));
    await page.locator('.bell').click();
    await page.waitForTimeout(500);
    await shot('weather-warning', 500);
    await page.locator('.bell').click();
  }
}
if (!rain) console.log('   no rainy daytime hour within 10 days');
if (!warned) console.log('   no heavy rain or snow forecast within 20 days');
console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no page errors');
await ctx.close();
