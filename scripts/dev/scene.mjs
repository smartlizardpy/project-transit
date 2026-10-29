// Sets up a running network through the game API (fast), then screenshots close-up and far views.
// Usage: node scripts/dev/scene.mjs <outDir> [presetIndex] [hour]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const [out = 'shots', preset = '0', hour = '8'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('pageerror', (e) => logs.push('pageerror ' + e.message));
page.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
await page.goto('http://127.0.0.1:5173/');
await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
const info = await page.evaluate(async ([preset, hour]) => {
  const { PRESETS, presetSpec } = await import('/src/app/presets.ts');
  const { routeWithFallback } = await import('/src/game/world/graph.ts');
  const t0 = performance.now();
  await window.__session.beginNew(presetSpec(PRESETS[+preset]));
  const tRegion = performance.now() - t0;
  const reg = window.__session.region;
  const c = reg.spec.centre;
  const z = [...reg.zones].sort((a, b) => (b.residents + b.jobs) / (1 + Math.hypot(b.centroid[0] - c[0], b.centroid[1] - c[1]) * 80) - (a.residents + a.jobs) / (1 + Math.hypot(a.centroid[0] - c[0], a.centroid[1] - c[1]) * 80))[0];
  window.__session.startNew({ name: 'Test Transit', colour: '#2f7fd6', logo: 1 }, z.id);
  const g = window.__game;
  // generous test funds so the scene can be built; posted through the ledger
  g.state.territory.owned.push(...z.neighbours);
  const gr = g.region.graph;
  const owned = new Set(g.state.territory.owned);
  const [cx, cy] = g.geo.P.toXY(z.centroid[0], z.centroid[1]);
  const main = [];
  for (let e = 0; e < gr.m; e++) {
    if (gr.cls[e] < 2 || gr.cls[e] > 4 || (gr.flags[e] & 6)) continue;
    const v = gr.ea[e];
    if (!owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]]).id)) continue;
    main.push(v);
  }
  main.sort((a, b) => Math.hypot(gr.x[a] - cx, gr.y[a] - cy) - Math.hypot(gr.x[b] - cx, gr.y[b] - cy));
  let depot = null;
  for (const v of main.slice(0, 300)) { const r = g.buildDepot([gr.lng[v], gr.lat[v]]); if (r.ok) { depot = r.value; break; } }
  let best = null;
  const a = main[0];
  for (const b of main) {
    const d = Math.hypot(gr.x[b] - gr.x[a], gr.y[b] - gr.y[a]);
    if (d < 1800 || d > 3200) continue;
    const l = routeWithFallback(gr, a, b);
    if (!l || l.contraflow.length) continue;
    const inside = l.nodes.filter((v) => owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]]).id)).length / l.nodes.length;
    if (inside < 0.95) continue;
    const ratio = l.metres / d;
    if (!best || ratio < best.ratio) best = { l, ratio };
    if (ratio < 1.2) break;
  }
  const stops = [];
  let acc = 1e9;
  for (let i = 1; i < best.l.nodes.length; i++) {
    const p = best.l.nodes[i - 1], q = best.l.nodes[i];
    acc += Math.hypot(gr.x[q] - gr.x[p], gr.y[q] - gr.y[p]);
    if (acc >= 380) { const r = g.placeStop([gr.lng[q], gr.lat[q]]); if (r.ok) { stops.push(r.value); acc = 0; } }
  }
  const route = g.createRoute({ stops, kind: 'linear', name: 'Test line' });
  const buses = [];
  for (let i = 0; i < 5; i++) { const r = g.buyVehicle(i < 4 ? 'city12' : 'midi10', depot); if (r.ok) { buses.push(r.value); g.assignVehicle(r.value, route.value); } }
  g.run(Math.max(0, +hour * 3600 - (g.t % 86400)));
  g.emit('changed', 0);
  g.setSpeed(1);
  return { tRegion: Math.round(tRegion), zone: z.name, stops: stops.length, route: route.ok ? route.value : route.error, buses: buses.length, balance: Math.round(g.state.finance.balance), statuses: Object.values(g.state.vehicles).map((v) => v.status), audit: g.audit() };
}, [preset, hour]);
console.log(info);
const wait = async () => { await page.waitForFunction(() => window.__map.areTilesLoaded() && !window.__city.busy, null, { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1200); };
// close-up on a bus in service
await page.evaluate(() => {
  const g = window.__game;
  const v = Object.values(g.state.vehicles).find((x) => x.status === 'in_service' || x.status === 'at_stop') ?? Object.values(g.state.vehicles)[0];
  const p = g.pose(v);
  const ll = p ? g.geo.P.toLngLat(p.x, p.y) : g.state.depots[v.depot].lngLat;
  window.__map.jumpTo({ center: ll, zoom: 17.8, pitch: 60, bearing: -20 });
});
await wait();
await page.screenshot({ path: `${out}/a-close.png` });
await page.evaluate(() => {
  const g = window.__game;
  const v = Object.values(g.state.vehicles).find((x) => x.status === 'in_service' || x.status === 'at_stop') ?? Object.values(g.state.vehicles)[0];
  window.__ui.getState().select({ kind: 'vehicle', id: v.id });
});
await wait();
await page.screenshot({ path: `${out}/b-bus-selected.png` });
await page.evaluate(() => { window.__ui.getState().select(null); const g = window.__game; const r = Object.values(g.state.routes)[0]; window.__ui.getState().select({ kind: 'line', id: r.id }); });
await page.evaluate(() => window.__map.jumpTo({ zoom: 15.2, pitch: 50 }));
await wait();
await page.screenshot({ path: `${out}/c-line.png` });
await page.evaluate(() => { window.__ui.getState().select(null); window.__map.jumpTo({ zoom: 14.1, pitch: 40 }); });
await wait();
await page.screenshot({ path: `${out}/d-far.png` });
await page.evaluate(() => { window.__ui.getState().toggleOverlay('traffic'); window.__map.jumpTo({ zoom: 14.8 }); });
await wait();
await page.screenshot({ path: `${out}/e-traffic.png` });
await page.evaluate(() => { window.__ui.getState().toggleOverlay('traffic'); window.__ui.getState().toggleOverlay('demand'); });
await wait();
await page.screenshot({ path: `${out}/f-demand.png` });
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
