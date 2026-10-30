// Plays a short game in WebKit (the engine behind Tauri's macOS window) against a production build:
// new company → network through the game API → run → save → reload → Continue → compare.
//   pnpm build && pnpm preview --port 4173 &   then:   node scripts/dev/webkit-play.mjs <outDir>
import { webkit } from 'playwright';
import { mkdirSync } from 'node:fs';
const [out = 'webkit-play', url = 'http://127.0.0.1:4173/'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await webkit.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && logs.push(`console: ${m.text()}`));
const ready = () => page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 40000 });
const settle = async (ms = 1500) => { await page.waitForFunction(() => window.__map.areTilesLoaded() && !window.__city?.busy, null, { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(ms); };
const state = () => page.evaluate(() => {
  const g = window.__game;
  if (!g) return null;
  const s = g.state;
  return { t: s.clock.t, balance: Math.round(s.finance.balance), stops: Object.keys(s.stops).length, routes: Object.keys(s.routes).length, buses: Object.keys(s.vehicles).length, owned: s.territory.owned.length, trips: s.stats.total.trips, audit: g.audit() };
});

await page.goto(url);
await ready();
await settle();
await page.screenshot({ path: `${out}/1-start.png` });
await page.getByRole('button', { name: /New company/i }).first().click();
await page.locator('.mn-preset', { hasText: 'İstanbul' }).click();
await page.waitForSelector('.mn-panel.setup', { timeout: 40000 });
await settle(800);
await page.screenshot({ path: `${out}/2-setup.png` });
await page.locator('.mn-zone').first().click();
await page.getByRole('button', { name: /Found company/i }).click();
await page.waitForFunction(() => window.__game, null, { timeout: 20000 });
const built = await page.evaluate(() => {
  const g = window.__game, gr = g.region.graph;
  const owned = new Set(g.state.territory.owned);
  const nodes = [];
  for (let e = 0; e < gr.m; e++) {
    if (gr.cls[e] < 2 || gr.cls[e] > 4) continue;
    const v = gr.ea[e];
    if (owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]]).id)) nodes.push(v);
  }
  let depot = null;
  for (const v of nodes) { const r = g.buildDepot([gr.lng[v], gr.lat[v]]); if (r.ok) { depot = r.value; break; } }
  // greedy chain of stops ~350 m apart
  const d = g.state.depots[depot];
  const chain = [];
  let cur = d.node;
  const used = new Set();
  for (let k = 0; k < 6; k++) {
    let best = -1, bd = Infinity;
    for (const v of nodes) {
      if (used.has(v)) continue;
      const dist = Math.hypot(gr.x[v] - gr.x[cur], gr.y[v] - gr.y[cur]);
      if (dist < 300 || chain.some((c) => Math.hypot(gr.x[v] - gr.x[c], gr.y[v] - gr.y[c]) < 300)) continue;
      const sc = Math.abs(dist - 350);
      if (sc < bd) { bd = sc; best = v; }
    }
    if (best < 0) break;
    used.add(best);
    const r = g.placeStop([gr.lng[best], gr.lat[best]]);
    if (r.ok) { chain.push(best); cur = best; }
  }
  const stops = Object.keys(g.state.stops);
  const route = g.createRoute({ stops, kind: 'linear' });
  const buses = [];
  for (let i = 0; i < 3; i++) { const b = g.buyVehicle('city12', depot); if (b.ok) { buses.push(b.value); if (route.ok) g.assignVehicle(b.value, route.value); } }
  g.run(4 * 3600);
  g.emit('changed', 0);
  return { depot, stops: stops.length, route: route.ok ? route.value : route.error, buses: buses.length };
});
console.log('built', built, await state());
await page.evaluate(() => { const g = window.__game; const v = Object.values(g.state.vehicles)[0]; const p = g.pose(v); window.__map.jumpTo({ center: p ? g.geo.P.toLngLat(p.x, p.y) : g.state.depots[v.depot].lngLat, zoom: 16.8, pitch: 55 }); window.__ui.getState().select({ kind: 'vehicle', id: v.id }); });
await settle();
await page.screenshot({ path: `${out}/3-playing.png` });
await page.keyboard.press('Meta+s');
await page.waitForFunction(() => window.__session && !window.__session.constructor && true, null, { timeout: 500 }).catch(() => {});
await page.waitForTimeout(1500);
const before = await state();
const saves = await page.evaluate(async () => (await window.__session.refreshSaves?.(), JSON.stringify((window.__sessionStore ?? null))));
void saves;
console.log('before reload', before);
await page.reload();
await ready();
await settle(800);
await page.screenshot({ path: `${out}/4-start-with-save.png` });
await page.getByRole('button', { name: /^Continue/i }).first().click();
await page.waitForFunction(() => window.__game, null, { timeout: 40000 });
await settle();
const after = await state();
console.log('after continue', after);
await page.screenshot({ path: `${out}/5-continued.png` });
const same = before && after && ['t', 'balance', 'stops', 'routes', 'buses', 'owned', 'trips'].every((k) => before[k] === after[k]);
console.log(same ? 'PERSISTENCE OK' : 'PERSISTENCE MISMATCH');
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
process.exit(same ? 0 : 1);
