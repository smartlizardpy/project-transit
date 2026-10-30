// End-to-end play-through against the dev server, driving the real UI with mouse and keyboard:
// new company → depot → bus → stops and a line → assign → run → save/load. Screenshots each step.
// Usage: node scripts/play.mjs <outDir> [width] [height] [presetIndex]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [out = 'shots', w = '1920', h = '1080', presetIdx = '0'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
const shot = async (name, wait = 900) => {
  await page.waitForFunction(() => window.__map?.areTilesLoaded() && !window.__city?.busy, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name);
};
const step = (msg) => console.log(`\n# ${msg}`);
const state = () => page.evaluate(() => {
  const g = window.__game;
  if (!g) return null;
  const s = g.state;
  return { t: s.clock.t, balance: Math.round(s.finance.balance), stops: Object.keys(s.stops).length, routes: Object.keys(s.routes).length, depots: Object.keys(s.depots).length, buses: Object.keys(s.vehicles).length, trips: s.stats.total.trips, rep: s.company.reputation.toFixed(1), audit: g.audit() };
});

await page.goto(process.env.URL || 'http://127.0.0.1:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__map?.loaded() && window.__ctl, null, { timeout: 30000 });
await shot('01-start-menu', 1500);

step('New company');
await page.getByRole('button', { name: /new company/i }).click();
await shot('02-location', 400);
await page.locator('.mn-preset').nth(+presetIdx).click();
await page.waitForFunction(() => document.querySelector('.mn-zone'), null, { timeout: 120000 });
await shot('03-setup', 2500);
// pick the busiest neighbourhood near the centre by clicking it on the map
const zonePt = await page.evaluate(() => {
  const r = window.__session.region;
  const c = r.spec.centre;
  const zs = [...r.zones].sort((a, b) => (b.residents + b.jobs) / (1 + Math.hypot(b.centroid[0] - c[0], b.centroid[1] - c[1]) * 60) - (a.residents + a.jobs) / (1 + Math.hypot(a.centroid[0] - c[0], a.centroid[1] - c[1]) * 60));
  const z = zs[0];
  window.__map.jumpTo({ center: z.centroid, zoom: 14.6 });
  return { id: z.id, name: z.name };
});
await page.waitForTimeout(700);
const centre = await page.evaluate(() => { const p = window.__map.project(window.__map.getCenter()); return [p.x, p.y]; });
await page.mouse.click(centre[0], centre[1]);
await page.waitForTimeout(300);
const chosen = await page.evaluate(() => window.__ptSession?.() ?? null);
console.log('zone', zonePt, chosen);
await shot('04-setup-chosen', 600);
await page.getByRole('button', { name: /^Next/ }).click();
await page.getByRole('textbox', { name: 'Company name' }).fill('Haliç Transit');
await shot('04b-company', 900);
await page.getByRole('button', { name: /found company/i }).click();
await page.waitForFunction(() => window.__game, null, { timeout: 10000 });
await shot('05-hud', 2500);
console.log(await state());

// helpers: find a drivable street node inside the licensed area, ≥ minDist from given points
const findSpots = (n, spacing) => page.evaluate(([n, spacing]) => {
  const g = window.__game;
  const gr = g.region.graph;
  const owned = new Set(g.state.territory.owned);
  const z = g.geo.zone(g.state.territory.home);
  const out = [];
  const cands = [];
  for (let v = 0; v < gr.n; v += 3) {
    const ll = [gr.lng[v], gr.lat[v]];
    if (!owned.has(g.geo.zoneAt(ll).id)) continue;
    const d = Math.hypot((ll[0] - z.centroid[0]) * 84000, (ll[1] - z.centroid[1]) * 111000);
    cands.push({ ll, d });
  }
  cands.sort((a, b) => a.d - b.d);
  return cands.map((c) => c.ll).slice(0, 4000);
}, [n, spacing]);

step('Build a depot with the depot tool');
await page.keyboard.press('Shift+D');
const cands = await findSpots();
let depotOk = false;
for (const ll of cands.slice(0, 400).filter((_, i) => i % 7 === 0)) {
  await page.evaluate((ll) => window.__map.jumpTo({ center: ll, zoom: 16.2 }), ll);
  await page.waitForTimeout(120);
  const p = await page.evaluate((ll) => { const q = window.__map.project(ll); return [q.x, q.y]; }, ll);
  await page.mouse.move(p[0], p[1]);
  await page.waitForTimeout(80);
  await page.mouse.click(p[0], p[1]);
  await page.waitForTimeout(150);
  if ((await state()).depots > 0) { depotOk = true; break; }
}
console.log('depot built:', depotOk);
await shot('06-depot', 1200);

step('Buy buses in the Fleet panel');
await page.keyboard.press('Escape');
await page.keyboard.press('g');
await page.waitForTimeout(300);
await page.getByRole('button', { name: /^buy$/i }).first().click().catch(() => page.getByText('Buy', { exact: true }).first().click());
await page.waitForTimeout(300);
await shot('07-fleet-buy', 500);
const buyButtons = page.getByRole('button', { name: /^Buy · / });
const nBuy = await buyButtons.count();
console.log('buy buttons', nBuy);
for (let i = 0; i < 3; i++) await buyButtons.nth(Math.min(2, nBuy - 1)).click().catch((e) => console.log('buy click failed', e.message));
console.log(await state());
await page.keyboard.press('g');

step('Draw a line with the line tool (click streets to build stops)');
await page.keyboard.press('r');
await page.waitForTimeout(200);
// pick a corridor: route between two main-road nodes ~2.5 km apart and take points every ~420 m
const corridor = await page.evaluate(async () => {
  const { routeWithFallback } = await import('/src/game/world/graph.ts');
  const g = window.__game;
  const gr = g.region.graph;
  const owned = new Set(g.state.territory.owned);
  const z = g.geo.zone(g.state.territory.home);
  const [cx, cy] = g.geo.P.toXY(z.centroid[0], z.centroid[1]);
  const main = [];
  for (let e = 0; e < gr.m; e++) {
    if (gr.cls[e] < 2 || gr.cls[e] > 4 || (gr.flags[e] & 6)) continue;
    const v = gr.ea[e];
    if (!owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]]).id)) continue;
    main.push(v);
  }
  main.sort((a, b) => Math.hypot(gr.x[a] - cx, gr.y[a] - cy) - Math.hypot(gr.x[b] - cx, gr.y[b] - cy));
  const a = main[0];
  let best = null;
  for (const b of main) {
    const d = Math.hypot(gr.x[b] - gr.x[a], gr.y[b] - gr.y[a]);
    if (d < 700 || d > 1700) continue;
    const l = routeWithFallback(gr, a, b);
    if (!l || l.contraflow.length) continue;
    if (l.nodes.filter((v) => owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]]).id)).length < l.nodes.length * 0.85) continue;
    const ratio = l.metres / d;
    if (!best || ratio < best.ratio) best = { l, ratio };
    if (ratio < 1.25) break;
  }
  if (!best) return [];
  const pts = [];
  let acc = 1e9;
  for (let i = 1; i < best.l.nodes.length; i++) {
    const p = best.l.nodes[i - 1], q = best.l.nodes[i];
    acc += Math.hypot(gr.x[q] - gr.x[p], gr.y[q] - gr.y[p]);
    if (acc >= 330) { pts.push([gr.lng[q], gr.lat[q]]); acc = 0; }
  }
  return pts;
});
console.log('corridor points', corridor.length);
for (const ll of corridor) {
  await page.evaluate((ll) => window.__map.jumpTo({ center: ll, zoom: 16 }), ll);
  await page.waitForTimeout(150);
  const p = await page.evaluate((ll) => { const q = window.__map.project(ll); return [q.x, q.y]; }, ll);
  await page.mouse.move(p[0], p[1]);
  await page.waitForTimeout(100);
  await page.mouse.click(p[0], p[1]);
  await page.waitForTimeout(250);
}
const draft = await page.evaluate(() => window.__ui.getState().draft?.stops.length ?? -1);
console.log('draft stops', draft, await state());
await page.evaluate(() => {
  const g = window.__game;
  const d = window.__ui.getState().draft;
  if (!d || d.stops.length < 2) return;
  const pts = d.stops.map((id) => g.state.stops[id].lngLat);
  const lng = pts.map((p) => p[0]), lat = pts.map((p) => p[1]);
  window.__map.fitBounds([[Math.min(...lng), Math.min(...lat)], [Math.max(...lng), Math.max(...lat)]], { padding: 160, pitch: 50, duration: 0 });
});
await shot('08-line-draft', 1500);
await page.getByRole('button', { name: /register line/i }).click();
await page.waitForTimeout(400);
console.log(await state());
await shot('09-line-created', 900);

step('Assign buses to the line');
const rid = await page.evaluate(() => Object.keys(window.__game.state.routes)[0]);
for (let i = 0; i < 4; i++) {
  const b = page.getByRole('button', { name: /assign spare bus/i });
  if (await b.count()) await b.first().click();
  await page.waitForTimeout(150);
}
console.log('assigned', await page.evaluate((rid) => window.__game.state.routes[rid]?.vehicles.length, rid));
await shot('10-line-assigned', 600);

step('Timetable editor');
await page.getByRole('button', { name: /^timetable$/i }).click();
await shot('11-timetable', 700);
await page.keyboard.press('Escape');

step('Run the simulation');
await page.keyboard.press('3');
await page.waitForTimeout(6000);
await page.evaluate(() => window.__ui.getState().select(null));
await shot('12-running', 800);
await page.evaluate(() => {
  const g = window.__game;
  const v = Object.values(g.state.vehicles).find((x) => x.status === 'in_service' || x.status === 'at_stop');
  if (v) { window.__ui.getState().select({ kind: 'vehicle', id: v.id }); const p = g.pose(v); const ll = g.geo.P.toLngLat(p.x, p.y); window.__map.jumpTo({ center: ll, zoom: 17.6, pitch: 58 }); }
});
await shot('13-bus', 1200);
await page.evaluate(() => {
  const g = window.__game;
  const r = Object.values(g.state.routes)[0];
  const id = r.stops[Math.floor(r.stops.length / 2)];
  window.__ui.getState().select({ kind: 'stop', id });
  window.__map.jumpTo({ center: g.state.stops[id].lngLat, zoom: 16.8 });
});
await shot('14-stop-board', 1200);
await page.evaluate(() => { window.__ui.getState().select(null); window.__map.jumpTo({ zoom: 14.2 }); });
await shot('15-zoomed-out', 1200);

step('Fast-forward two days and check the books');
await page.keyboard.press(' ');
const ff = await page.evaluate(() => { const t0 = performance.now(); window.__game.run(2 * 86400); window.__game.emit('changed', 0); return Math.round(performance.now() - t0); });
console.log('2 days simulated in', ff, 'ms', await state());
await page.keyboard.press('m');
await shot('16-finance', 600);
await page.keyboard.press('m');
await page.keyboard.press('c');
await shot('17-company', 600);
await page.keyboard.press('c');
await page.keyboard.press('o');
await page.evaluate(() => window.__map.jumpTo({ zoom: 13.6 }));
await shot('18-areas', 1200);
await page.keyboard.press('o');

step('Save, quit to menu, load');
const before = await state();
await page.keyboard.press('Meta+s');
await page.waitForTimeout(800);
await page.evaluate(() => window.__session.quitToMenu());
await page.waitForTimeout(800);
await shot('19-menu-with-save', 800);
await page.getByRole('button', { name: /continue/i }).first().click();
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
const after = await state();
console.log('before', before, '\nafter', after);
await shot('20-loaded', 1500);

console.log('\nlogs:\n' + logs.filter((l) => !l.includes('[vite]') && !l.includes('DevTools')).slice(0, 40).join('\n'));
await browser.close();
