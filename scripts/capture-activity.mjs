// City Activity Engine QA screenshots (phase 2): estimated demand by mode, the unserved view and
// the place card's "How people travel here", from a genuinely simulated company. Run
// `node scripts/capture-network.mjs sim` first (it simulates until Network Control unlocks and
// saves), with the dev server on port 5182, then:
//
//   NC_PROFILE=<same profile> node scripts/capture-activity.mjs
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

await page.goto(URL);
await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
await ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await ui(() => window.__game.setSpeed(0));
await ui(() => {
  const g = window.__game, pts = Object.values(g.state.stops).map((s) => s.lngLat);
  const w = Math.min(...pts.map((p) => p[0])), e = Math.max(...pts.map((p) => p[0])), s = Math.min(...pts.map((p) => p[1])), n = Math.max(...pts.map((p) => p[1]));
  window.__map.fitBounds([[w - 0.02, s - 0.012], [e + 0.02, n + 0.012]], { padding: { left: 720, right: 120, top: 120, bottom: 90 }, maxZoom: 15, duration: 0, pitch: 40 });
});

// Network Control → Passengers → estimated demand, unserved
await page.getByRole('button', { name: 'Open Network Control' }).click().catch(async () => {
  await ui(() => window.__ui.getState().setPanel?.('network'));
});
await page.waitForTimeout(600);
await page.locator('.nc-tabs .seg button', { hasText: 'Passengers' }).click();
await page.waitForTimeout(500);
await page.getByRole('button', { name: 'Estimated demand' }).click();
await page.waitForTimeout(900);
await shot('nc-estimated-areas', 900);
await page.getByRole('button', { name: 'Places', exact: true }).click();
await page.waitForTimeout(800);
await shot('nc-estimated-places', 900);
await page.getByRole('button', { name: 'Unserved', exact: true }).click();
await page.waitForTimeout(800);
await shot('nc-unserved-places', 900);
await page.getByRole('button', { name: 'Areas', exact: true }).click();
await page.waitForTimeout(800);
await shot('nc-unserved-areas', 900);
await ui(() => window.__ui.getState().setFlowOverlay(null));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// place cards: the busiest place on your network, and the nearest airport beyond the map
const best = await ui(async () => {
  const { placeTravel } = await import('/src/game/analytics/query.ts');
  const g = window.__game;
  const zs = g.demand.activity.zones;
  let top = null;
  for (const z of zs.list) {
    if (z.kind !== 'place' || !z.place) continue;
    const t = placeTravel(g, z.place);
    if (t && (!top || t.modes[4] > top.net)) top = { id: z.place, net: t.modes[4], name: z.name, at: z.lngLat };
  }
  return top;
});
console.log('  busiest place', JSON.stringify(best));
for (const [name, id, at] of [['place-card-travel', best.id, best.at], ['place-card-airport-travel', 'iata:IST', null]]) {
  await ui(({ id, at }) => {
    window.__ui.getState().select({ kind: 'place', id });
    if (at) window.__map.jumpTo({ center: at, zoom: 15.5 });
  }, { id, at });
  await page.waitForTimeout(800);
  await shot(name, 900);
}
console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no page errors');
await ctx.close();
