// QA screenshots of the real game at several desktop sizes. Requires the dev server (pnpm dev).
// It plays through the menus, then builds a small working network through the game API
// (depot, stops, a line, buses), runs the simulation for a day and captures the main screens.
//
//   pnpm shots                       # 1920x1080, 2560x1440, 1366x768 → docs/screenshots
//   node scripts/capture.mjs 1366x768 # one size
//   SHOTS_DIR=out PRESET=1 node scripts/capture.mjs   # other folder / starting city (index in PRESETS)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL || 'http://127.0.0.1:5173/';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots';
const PRESET = Number(process.env.PRESET || 0);
const SIZES = (process.argv[2] ? [process.argv[2]] : ['1920x1080', '2560x1440', '1366x768']).map((s) => s.split('x').map(Number));
mkdirSync(OUT, { recursive: true });

const settle = async (page, extra = 900) => {
  await page.waitForFunction(() => window.__map?.areTilesLoaded() && !window.__city?.busy, null, { timeout: 30000 }).catch(() => console.warn('  tiles timeout'));
  await page.waitForTimeout(extra);
};

async function buildNetwork(page, preset) {
  return page.evaluate(async (preset) => {
    const { PRESETS, presetSpec } = await import('/src/app/presets.ts');
    const { routeWithFallback } = await import('/src/game/world/graph.ts');
    const reg = window.__session.region ?? (await window.__session.loadRegion(presetSpec(PRESETS[preset])));
    void reg;
    const g = window.__game;
    const gr = g.region.graph;
    // a few licensed neighbours so the line has room (dev convenience, not a game rule)
    const home = g.geo.zone(g.state.territory.home);
    for (const z of home.neighbours) if (!g.state.territory.owned.includes(z)) g.state.territory.owned.push(z);
    const owned = new Set(g.state.territory.owned);
    const [cx, cy] = g.geo.P.toXY(home.centroid[0], home.centroid[1]);
    const inOwned = (v) => owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]]).id);
    const main = [];
    for (let e = 0; e < gr.m; e++) {
      if (gr.cls[e] < 2 || gr.cls[e] > 4 || (gr.flags[e] & 6)) continue;
      if (inOwned(gr.ea[e])) main.push(gr.ea[e]);
    }
    main.sort((a, b) => Math.hypot(gr.x[a] - cx, gr.y[a] - cy) - Math.hypot(gr.x[b] - cx, gr.y[b] - cy));
    let depot = null;
    for (const v of main.slice(0, 300)) { const r = g.buildDepot([gr.lng[v], gr.lat[v]]); if (r.ok) { depot = r.value; break; } }
    let best = null;
    for (const b of main) {
      const d = Math.hypot(gr.x[b] - gr.x[main[0]], gr.y[b] - gr.y[main[0]]);
      if (d < 1800 || d > 3200) continue;
      const l = routeWithFallback(gr, main[0], b);
      if (!l || l.contraflow.length) continue;
      if (l.nodes.filter(inOwned).length < l.nodes.length * 0.95) continue;
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
    const route = g.createRoute({ stops, kind: 'linear' });
    for (let i = 0; i < 4; i++) { const r = g.buyVehicle('city12', depot); if (r.ok) g.assignVehicle(r.value, route.value); }
    g.state.onboarding.active = false;
    g.run(86400 + 8.25 * 3600 - (g.t % 86400)); // a full day of history, then Tuesday 08:15
    g.emit('changed', 0);
    g.setSpeed(1);
    return { stops: stops.length, route: route.ok ? route.value : route.error, buses: Object.keys(g.state.vehicles).length, audit: g.audit() };
  }, preset);
}

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const [w, h] of SIZES) {
  const tag = `${w}x${h}`;
  console.log('size', tag);
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const shot = async (name, extra) => { await settle(page, extra); await page.screenshot({ path: `${OUT}/${tag}-${name}.png` }); console.log('  shot', name); };
  const ui = (fn, arg) => page.evaluate(fn, arg);

  await page.goto(URL);
  await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
  await shot('start-menu', 1500);
  await page.getByRole('button', { name: /New company/i }).first().click();
  await shot('choose-place', 600);
  await ui(async (preset) => { const { PRESETS, presetSpec } = await import('/src/app/presets.ts'); await window.__session.beginNew(presetSpec(PRESETS[preset])); }, PRESET);
  await page.waitForFunction(() => window.__session && document.querySelector('.mn-panel.setup'), null, { timeout: 30000 }).catch(() => {});
  await shot('company-setup', 1200);
  await ui(() => {
    const reg = window.__session.region;
    const c = reg.spec.centre;
    const score = (z) => (z.residents + z.jobs) / (1 + Math.hypot(z.centroid[0] - c[0], z.centroid[1] - c[1]) * 80);
    const z = [...reg.zones].sort((a, b) => score(b) - score(a))[0];
    window.__session.startNew({ name: 'Harbour Lines', colour: '#2f7fd6', logo: 1 }, z.id);
  });
  console.log('  network', await buildNetwork(page, PRESET));

  const firstBus = () => {
    const g = window.__game;
    return Object.values(g.state.vehicles).find((x) => x.status === 'in_service') ?? Object.values(g.state.vehicles)[0];
  };
  await ui((fb) => {
    const g = window.__game;
    const v = eval(`(${fb})`)();
    const p = g.pose(v);
    window.__map.jumpTo({ center: p ? g.geo.P.toLngLat(p.x, p.y) : g.state.depots[v.depot].lngLat, zoom: 17.2, pitch: 58, bearing: -24 });
  }, firstBus.toString());
  await shot('overview', 1500);
  await ui((fb) => { const v = eval(`(${fb})`)(); window.__ui.getState().select({ kind: 'vehicle', id: v.id }); }, firstBus.toString());
  await shot('bus-selected');
  await ui(() => {
    const g = window.__game;
    const r = Object.values(g.state.routes)[0];
    window.__ui.getState().select({ kind: 'stop', id: r.stops[Math.floor(r.stops.length / 2)] });
    const s = g.state.stops[r.stops[Math.floor(r.stops.length / 2)]];
    window.__map.jumpTo({ center: s.lngLat, zoom: 16.8 });
  });
  await shot('stop-board');
  await ui(() => { const g = window.__game; const r = Object.values(g.state.routes)[0]; window.__ui.getState().select({ kind: 'line', id: r.id }); window.__map.jumpTo({ zoom: 15.2, pitch: 48 }); });
  await shot('line-selected');
  await ui(() => { const r = Object.values(window.__game.state.routes)[0]; window.__ui.getState().openModal({ kind: 'timetable', route: r.id }); });
  await shot('timetable', 600);
  await ui(() => window.__ui.getState().openModal(null));
  await ui(async () => { const { startDrafting } = await import('/src/ui/routeDraft.ts'); startDrafting(Object.keys(window.__game.state.routes)[0]); });
  await shot('route-editing', 1200);
  await ui(() => { window.__ui.getState().setTool('select'); window.__ui.getState().select(null); window.__ui.getState().openPanel('finance'); });
  await shot('finance-panel');
  await ui(() => window.__ui.getState().openPanel('fleet'));
  await page.getByRole('button', { name: 'Buy', exact: true }).first().click().catch(() => {});
  await shot('fleet-buy', 600);
  await ui(() => window.__ui.getState().openPanel('company'));
  await shot('company-panel', 600);
  await ui(() => { window.__ui.getState().openPanel(null); window.__ui.getState().toggleOverlay('traffic'); window.__map.jumpTo({ zoom: 14.6, pitch: 45 }); });
  await shot('traffic-overlay');
  await ui(() => { window.__ui.getState().toggleOverlay('traffic'); window.__ui.getState().toggleOverlay('demand'); });
  await shot('demand-overlay');
  await ui(() => { window.__ui.getState().toggleOverlay('demand'); window.__ui.getState().toggleOverlay('areas'); window.__map.jumpTo({ zoom: 13.4, pitch: 30 }); });
  await shot('operating-areas');
  await ui(() => { window.__ui.getState().toggleOverlay('areas'); window.__ui.getState().openModal({ kind: 'menu' }); });
  await shot('game-menu', 500);
  if (errors.length) console.log('  page errors:\n   ', errors.slice(0, 10).join('\n    '));
  await page.close();
}
await browser.close();
