// Network Control QA screenshots, from a genuinely simulated company.
// It builds three lines with buses, runs the real simulation for a month of game days (never faking
// data or the unlock), and captures the Network Control screens at 1920x1080.
//
//   pnpm exec vite --port 5182 --strictPort &       # dev server
//   node scripts/capture-network.mjs sim            # build, simulate, save (profile kept in $NC_PROFILE)
//   node scripts/capture-network.mjs shots          # load that save and capture every screen
//   node scripts/capture-network.mjs all            # both
//   node scripts/capture-network.mjs depot          # load the save; move a bus to a second depot
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://localhost:5182/';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots/network-control';
const PROFILE = process.env.NC_PROFILE || join(tmpdir(), 'pt-network-control-profile');
const PRESET = Number(process.env.PRESET || 0);
const MODE = process.argv[2] || 'all';
const MAX_DAYS = Number(process.env.MAX_DAYS || 70);
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
const scrollTo = (text) => ui((t) => {
  const el = [...document.querySelectorAll('.p-body .nc-sub')].find((x) => x.textContent.includes(t));
  el?.closest('.section')?.scrollIntoView({ block: 'start' });
}, text);
const scrollTop = () => ui(() => { document.querySelector('.p-body').scrollTop = 0; });

async function start() {
  await page.goto(URL);
  await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
}

async function build() {
  await ui(async (preset) => { const { PRESETS, presetSpec } = await import('/src/app/presets.ts'); await window.__session.beginNew(presetSpec(PRESETS[preset])); }, PRESET);
  await page.waitForFunction(() => window.__session.region, null, { timeout: 60000 });
  await ui(() => {
    const reg = window.__session.region;
    const c = reg.spec.centre;
    const score = (z) => (z.residents + z.jobs) / (1 + Math.hypot(z.centroid[0] - c[0], z.centroid[1] - c[1]) * 80);
    const z = [...reg.zones].sort((a, b) => score(b) - score(a))[0];
    window.__session.startNew({ name: 'Harbour Lines', colour: '#2f7fd6', logo: 1 }, z.id);
  });
  await page.waitForFunction(() => window.__game, null, { timeout: 30000 });
  return ui(async () => {
    const { routeWithFallback } = await import('/src/game/world/graph.ts');
    const g = window.__game;
    const gr = g.region.graph;
    const home = g.geo.zone(g.state.territory.home);
    for (const z of home.neighbours) if (!g.state.territory.owned.includes(z)) g.state.territory.owned.push(z); // dev convenience: room to build
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
    const log = [];
    const ang = (a, b) => Math.atan2(gr.y[b] - gr.y[a], gr.x[b] - gr.x[a]);
    const angDiff = (p, q) => { let d = Math.abs(p - q) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
    const stopAt = (v) => {
      const r = g.placeStop([gr.lng[v], gr.lat[v]]);
      if (r.ok) return r.value;
      let best = null, bd = 70;
      for (const s of Object.values(g.state.stops)) { const [sx, sy] = g.geo.P.toXY(s.lngLat[0], s.lngLat[1]); const d = Math.hypot(sx - gr.x[v], sy - gr.y[v]); if (d < bd) { bd = d; best = s.id; } }
      return best;
    };
    const makeLine = (start, minA, maxA, avoid) => {
      let best = null;
      for (let i = 0; i < main.length; i += 3) {
        const b = main[i];
        const d = Math.hypot(gr.x[b] - gr.x[start], gr.y[b] - gr.y[start]);
        if (d < 1300 || d > 2300) continue;
        if (avoid !== undefined) { const da = angDiff(ang(start, b), avoid); if (da < minA || da > maxA) continue; }
        const l = routeWithFallback(gr, start, b);
        if (!l || l.contraflow.length) continue;
        if (l.nodes.filter(inOwned).length < l.nodes.length * 0.95) continue;
        const ratio = l.metres / d;
        if (!best || ratio < best.ratio) best = { l, ratio, b };
        if (ratio < 1.25) break;
      }
      if (!best) return null;
      const stops = [];
      let acc = 1e9;
      for (let i = 1; i < best.l.nodes.length; i++) {
        const p = best.l.nodes[i - 1], q = best.l.nodes[i];
        acc += Math.hypot(gr.x[q] - gr.x[p], gr.y[q] - gr.y[p]);
        if (acc >= 380) { const s = stopAt(q); if (s && stops[stops.length - 1] !== s) { stops.push(s); acc = 0; } }
      }
      const route = g.createRoute({ stops, kind: 'linear' });
      if (!route.ok) { log.push(route.error); return null; }
      return { id: route.value, start, end: best.b, nodes: best.l.nodes, stops };
    };
    const l1 = makeLine(main[0], 0, 7);
    const lines = [l1];
    if (l1) {
      const mid = l1.nodes[Math.floor(l1.nodes.length / 2)];
      const l2 = makeLine(mid, Math.PI / 3, (2 * Math.PI) / 3, ang(l1.start, l1.end));
      lines.push(l2);
      const l3 = makeLine(l1.end, Math.PI / 4, Math.PI, ang(l1.end, l1.start) + Math.PI);
      lines.push(l3);
    }
    // a calm 20-minute service on every line, and a fare a little above the suggested one
    const { flatTimetable } = await import('/src/game/timetable.ts');
    for (const l of lines) if (l) g.setTimetable(l.id, flatTimetable(20, 360, 1320));
    g.setFare(2.4);
    // buy buses where the timetable needs them, as far as the opening cash allows (nothing is topped up)
    const live = lines.filter(Boolean);
    const need = live.map((l) => Math.max(1, g.requirement(l.id)?.peak ?? 2));
    log.push('needs ' + need.join(','));
    const have = live.map(() => 0);
    for (let round = 0; round < 6; round++) {
      live.forEach((l, i) => {
        if (have[i] >= need[i]) return;
        if (g.state.finance.balance < 36_000 + 25_000) return;
        const r = g.buyVehicle('mini8', depot);
        if (r.ok && g.assignVehicle(r.value, l.id).ok) have[i]++;
        else if (!r.ok) log.push(r.error);
      });
    }
    log.push('buses ' + have.join(','));
    g.state.onboarding.active = false;
    g.setSpeed(0);
    g.emit('changed', 0);
    return { lines: lines.map((l) => l && l.stops.length), buses: Object.keys(g.state.vehicles).length, balance: g.state.finance.balance, log };
  });
}

const dayInfo = () => ui(() => {
  const process_row = (s) => { const r = s.stats.days[s.stats.days.length - 1]; return r ? { b: r.boardings, ab: r.abandoned, sat: +r.satisfaction.toFixed(2), ot: +r.ontime.toFixed(2), rev: Math.round(r.revenue), cost: Math.round(r.costs) } : null; };
  const g = window.__game, s = g.state;
  return { day: Math.floor(g.t / 86400) + 1, rep: Math.round(s.company.reputation), row: process_row(s), ctl: s.control.days.count, unlocked: s.control.unlocked, balance: Math.round(s.finance.balance), status: s.company.status, recorded: s.analytics.days.length };
});

async function simulate() {
  console.log('  network', await build());
  await ui(() => {
    const g = window.__game, pts = Object.values(g.state.stops).map((s) => s.lngLat);
    const w = Math.min(...pts.map((p) => p[0])), e = Math.max(...pts.map((p) => p[0])), s = Math.min(...pts.map((p) => p[1])), n = Math.max(...pts.map((p) => p[1]));
    window.__map.fitBounds([[w, s], [e, n]], { padding: { left: 720, right: 420, top: 120, bottom: 90 }, maxZoom: 16, duration: 0, pitch: 48 });
  });
  let lockedShot = false;
  for (let i = 0; i < MAX_DAYS * 4; i++) {
    await ui(() => window.__game.run(6 * 3600));
    const d = await dayInfo();
    if (i % 8 === 7) console.log('  ', JSON.stringify(d));
    if (d.status !== 'ok') throw new Error('company went bankrupt: ' + JSON.stringify(d));
    if (!lockedShot && d.recorded >= 4) {
      lockedShot = true;
      await ui(() => window.__ui.getState().openPanel('network'));
      await shot('locked', 700);
      await ui(() => window.__ui.getState().openPanel(null));
    }
    if (d.unlocked) { console.log('  unlocked', JSON.stringify(d)); break; }
  }
  const d = await dayInfo();
  if (!d.unlocked) { console.log('  NOT unlocked after', MAX_DAYS, 'days', JSON.stringify(d)); }
  await ui(async () => { window.__game.setSpeed(0); window.__game.emit('changed', 0); await window.__session.save('manual'); });
  console.log('  saved', JSON.stringify(await dayInfo()));
}

async function shots() {
  if (MODE === 'shots') {
    await ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
    await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  }
  await ui(() => window.__game.setSpeed(0));
  console.log('  state', JSON.stringify(await dayInfo()));
  await ui(() => {
    const g = window.__game, pts = Object.values(g.state.stops).map((s) => s.lngLat);
    const w = Math.min(...pts.map((p) => p[0])), e = Math.max(...pts.map((p) => p[0])), s = Math.min(...pts.map((p) => p[1])), n = Math.max(...pts.map((p) => p[1]));
    window.__map.fitBounds([[w, s], [e, n]], { padding: { left: 720, right: 420, top: 120, bottom: 90 }, maxZoom: 16, duration: 0, pitch: 48 });
  });
  await shot('unlock-card', 800);
  await page.getByRole('button', { name: 'Open Network Control' }).click();
  await page.waitForTimeout(600);
  await shot('overview', 600);

  const tab = async (name) => { await page.locator('.nc-tabs .seg button', { hasText: name }).click(); await page.waitForTimeout(500); await scrollTop(); };
  // passengers
  await tab('Passengers');
  await page.waitForTimeout(500);
  await shot('passengers-od', 700);
  await ui(() => { const rows = document.querySelectorAll('.nc-table tbody tr.click'); rows[0]?.click(); });
  await page.waitForTimeout(1500);
  await shot('flows-map', 900);
  await page.getByRole('button', { name: 'Estimated demand' }).click();
  await page.waitForTimeout(800);
  await shot('flows-estimated', 900);
  await page.getByRole('button', { name: 'Observed journeys' }).click();
  await ui(() => window.__ui.getState().setFlowOverlay(null));

  await tab('Stops');
  await ui(() => document.querySelectorAll('.nc-table tbody tr.click')[0]?.click());
  await page.waitForTimeout(1200);
  await scrollTo('');
  await shot('stops', 800);

  await tab('Lines');
  await ui(() => document.querySelectorAll('.nc-table tbody tr.click')[0]?.click());
  await page.waitForTimeout(1200);
  await shot('lines-table', 600);
  await ui(() => { const el = [...document.querySelectorAll('.p-body .nc-sub')].find((x) => x.textContent.includes('·')); el?.closest('.section')?.scrollIntoView({ block: 'start' }); });
  await shot('lines', 500);
  await scrollTo('Compare two periods');
  await shot('line-compare', 500);

  await tab('Fleet');
  await shot('fleet', 600);

  await tab('Reports');
  await page.getByPlaceholder('Fares per service hour').fill('Fares per bus-hour');
  await page.getByPlaceholder('revenue / busHours').fill('revenue / busHours');
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Save metric' }).click();
  await page.waitForTimeout(400);
  await page.getByPlaceholder('Fares per service hour').fill('Missed share');
  await page.getByPlaceholder('revenue / busHours').fill('missed / (trips + missed) * 100');
  await page.locator('.nc-filters select').first().selectOption('percent');
  await page.waitForTimeout(400);
  await shot('reports-metric', 400);
  await page.getByRole('button', { name: 'Save metric' }).click();
  await page.waitForTimeout(300);
  await ui(() => document.querySelector('.nc-item input[type=checkbox]')?.click());
  await tab('Lines');
  await ui(() => window.__ui.getState().select(null));
  await shot('lines-custom-column', 500);

  await tab('Automation');
  await shot('automation', 500);
  if (errors.length) console.log('  page errors:\n   ', [...new Set(errors)].slice(0, 10).join('\n    '));
}

/** Moving a bus to another depot: the plan in the inspector, then the bus driving there. */
async function depotShots() {
  await ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  const info = await ui(() => {
    const g = window.__game;
    g.setSpeed(0);
    const tried = [];
    if (Object.keys(g.state.depots).length < 2) {
      // a second depot near the far end of the longest line, through the game's own rules
      const r = Object.values(g.state.routes).sort((a, b) => b.stops.length - a.stops.length)[0];
      const far = g.state.stops[r.stops[r.stops.length - 1]].lngLat;
      for (const [dx, dy] of [[0.0015, 0.001], [-0.0015, 0.001], [0.0015, -0.001], [-0.0015, -0.001], [0.003, 0], [0, 0.003], [-0.003, 0], [0, -0.003]]) {
        const d = g.buildDepot([far[0] + dx, far[1] + dy], 'Harbour North Depot');
        tried.push(d.ok ? 'ok' : d.error);
        if (d.ok) break;
      }
    }
    const v = Object.values(g.state.vehicles).find((x) => x.status === 'parked');
    return { depots: Object.keys(g.state.depots).length, vehicle: v?.id ?? null, tried };
  });
  console.log('  depot setup', JSON.stringify(info));
  if (info.depots < 2 || !info.vehicle) throw new Error('could not set up a depot move');
  // this save may still show the "Network Control is open" card: put it away first
  const later = page.getByRole('button', { name: 'Later' });
  if (await later.isVisible().catch(() => false)) { await later.click(); await page.waitForTimeout(400); }
  await ui((id) => { window.__ui.getState().select({ kind: 'vehicle', id }); }, info.vehicle);
  await page.waitForTimeout(600);
  const other = await ui((id) => { const g = window.__game; return Object.keys(g.state.depots).find((d) => d !== g.state.vehicles[id].depot); }, info.vehicle);
  await page.locator('select[aria-label="Home depot"]').selectOption(other);
  await page.waitForTimeout(400);
  await shot('depot-move-plan', 700);
  await page.getByRole('button', { name: 'Move bus' }).click();
  await ui(() => window.__game.run(150));
  // the bus has moved on: follow it so the shot shows it on the road
  await page.getByRole('button', { name: /Follow/ }).click();
  await page.waitForTimeout(2200);
  await shot('depot-move-driving', 900);
}

process.on('exit', () => { if (errors.length) console.log('page errors:', [...new Set(errors)].slice(0, 8).join('\n  ')); });
await start();
if (MODE === 'sim' || MODE === 'all') await simulate();
if (MODE === 'shots' || MODE === 'all') await shots();
if (MODE === 'depot') await depotShots();
await ctx.close();
