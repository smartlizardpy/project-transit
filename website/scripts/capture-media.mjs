// Captures the marketing-site media from the real running game (no compositing).
// Requires the dev server (pnpm dev, http://127.0.0.1:5173/), Playwright Chromium with a GPU (Metal on macOS)
// and, for the video, ffmpeg at /opt/homebrew/bin/ffmpeg.
//
//   node website/scripts/capture-media.mjs <outDir> [groups]
//   groups (comma separated, default all but video): hero,hud,world,plan,close,stop,mgmt,flow,video
//   e.g. node website/scripts/capture-media.mjs /tmp/site-media/raw hero,world
//
// Each run builds its scene through the same game commands the UI uses (depot, stops, lines, buses),
// simulates a full day plus the Tuesday morning rush, then frames shots with the map camera.
// A manifest.json describing the shots is merged into <outDir>/../manifest.json.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const OUT = process.argv[2] || 'site-media/raw';
const GROUPS = (process.argv[3] || 'hero,hud,world,plan,close,stop,mgmt,flow').split(',');
const URL = process.env.URL || 'http://127.0.0.1:5173/';
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
mkdirSync(OUT, { recursive: true });
const MANIFEST = join(dirname(OUT), 'manifest.json');

// ---- per-city set-up ------------------------------------------------------------------------------------------
const CITIES = [
  {
    idx: 0, key: 'istanbul', city: 'İstanbul', company: { name: 'Harbour Lines', colour: '#e0573e' },
    // anchor chains (lng,lat): the lines are routed through these on real streets
    lines: [
      [[28.9855, 41.0369], [28.9745, 41.0232], [28.9705, 41.0172], [28.9780, 41.0062]],
      [[28.9930, 41.0340], [28.9745, 41.0225], [28.9640, 41.0225]],
      [[28.9705, 41.0172], [28.9600, 41.0215], [28.9500, 41.0290]],
    ],
    view: { zoom: 15.5, pitch: 58, bearing: -28 },
  },
  { idx: 1, key: 'durham', city: 'Durham', company: { name: 'Wear Valley Buses', colour: '#e0573e' }, angles: [20, 140, 260], view: { zoom: 15.5, pitch: 58, bearing: 12 } },
  { idx: 2, key: 'barcelona', city: 'Barcelona', company: { name: 'Eixample Express', colour: '#e0573e' }, angles: [315, 20, 250], view: { zoom: 15.5, pitch: 58, bearing: -45, center: [2.1620, 41.3930] } },
  { idx: 3, key: 'hamburg', city: 'Hamburg', company: { name: 'Hanse Lines', colour: '#e0573e' }, angles: [30, 150, 270], view: { zoom: 15.5, pitch: 58, bearing: -18 } },
  { idx: 4, key: 'tokyo', city: 'Tokyo', company: { name: 'Shibuya Lines', colour: '#e0573e' }, angles: [30, 150, 270], view: { zoom: 15.5, pitch: 58, bearing: 20 } },
];

// Istanbul hero candidates, pitch 55-65, zoom 15.8-16.6. `best` indexes are picked after viewing the contact sheet.
const GALATA = [28.9738, 41.0196];
const HERO = [
  { id: 'a', center: GALATA, zoom: 16.0, pitch: 60, bearing: -30 },
  { id: 'b', center: GALATA, zoom: 16.2, pitch: 58, bearing: 20 },
  { id: 'c', center: GALATA, zoom: 15.9, pitch: 62, bearing: 55 },
  { id: 'd', center: [28.9715, 41.0180], zoom: 16.4, pitch: 60, bearing: -60 },
  { id: 'e', center: [28.9760, 41.0215], zoom: 16.0, pitch: 56, bearing: 150 },
  { id: 'f', center: [28.9700, 41.0200], zoom: 16.3, pitch: 64, bearing: 100 },
];
const HERO_BEST = process.env.HERO_BEST || 'e';

// ---- helpers --------------------------------------------------------------------------------------------------
const log = (...a) => console.log(...a);
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : [];
function rec(file, city, what, hud, w, h, notes = '') {
  const e = { file, city, what, hud, width: w, height: h, notes };
  const i = manifest.findIndex((m) => m.file === file);
  if (i >= 0) manifest[i] = e; else manifest.push(e);
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
}

async function settle(page, extra = 1300) {
  await page.waitForFunction(() => window.__map?.loaded(), null, { timeout: 30000 }).catch(() => log('  map missing'));
  await page.waitForFunction(() => window.__map?.areTilesLoaded() && !window.__city?.busy, null, { timeout: 60000 }).catch(() => log('  tiles timeout'));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(extra);
}

async function openGame(vw, vh, dsf) {
  const page = await browserCtx.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: dsf });
  page.hud = true;
  page.vw = vw; page.vh = vh; page.dsf = dsf;
  page.on('pageerror', (e) => log('  pageerror', e.message));
  page.on('framenavigated', (f) => log('  navigated', f.url()));
  await page.goto(URL);
  await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 40000 });
  return page;
}
async function setHud(page, on) {
  if (page.hud !== on) { await page.keyboard.press('F10'); page.hud = on; await page.waitForTimeout(250); }
}
const view = async (page, v, extra) => { await page.waitForFunction(() => window.__map, null, { timeout: 30000 }); await page.evaluate((v) => { window.__map.jumpTo(v); }, v); await settle(page, extra); };
const visibleBuses = (page) => page.evaluate(() => {
  const g = window.__game, m = window.__map; let n = 0;
  if (!g?.state) return 0;
  for (const v of Object.values(g.state.vehicles)) {
    const p = g.pose(v); if (!p) continue;
    const q = m.project(g.geo.P.toLngLat(p.x, p.y));
    if (q.x > 0 && q.y > 0 && q.x < innerWidth && q.y < innerHeight) n++;
  }
  return n;
});
async function shot(page, name, city, what, hud, notes = '', extra) {
  await settle(page, extra);
  const n = await visibleBuses(page);
  await page.screenshot({ path: join(OUT, name + '.png') });
  if (!name.startsWith('_cand')) rec(name + '.png', city, what, hud, page.vw * page.dsf, page.vh * page.dsf, `${notes} (buses in frame: ${n})`.trim());
  log('  shot', name, 'buses in frame', n);
}

// Build the city + company + network inside the page.
async function setup(page, c) {
  const info = await page.evaluate(async ([c]) => {
    const { PRESETS, presetSpec } = await import('/src/app/presets.ts');
    const { routeWithFallback } = await import('/src/game/world/graph.ts');
    await window.__session.beginNew(presetSpec(PRESETS[c.idx]));
    const reg = window.__session.region;
    const ctr = reg.spec.centre;
    const z = [...reg.zones].sort((a, b) => (b.residents + b.jobs) / (1 + Math.hypot(b.centroid[0] - ctr[0], b.centroid[1] - ctr[1]) * 80) - (a.residents + a.jobs) / (1 + Math.hypot(a.centroid[0] - ctr[0], a.centroid[1] - ctr[1]) * 80))[0];
    window.__session.startNew({ name: c.company.name, colour: c.company.colour, logo: 1 }, z.id);
    const g = window.__game;
    g.state.onboarding.active = false;
    { const { post } = await import('/src/game/finance.ts'); post(g.state, { amt: 1400000, cat: 'equity', memo: 'Investor capital' }); }
    window.__ownedSmall = [...g.state.territory.owned, ...z.neighbours.filter((n) => !g.state.territory.owned.includes(n))];
    const P = g.geo.P, gr = g.region.graph;
    const [cx, cy] = P.toXY(z.centroid[0], z.centroid[1]);
    // own every zone within 3.6 km of the home zone so the camera can roam in fully rendered territory
    for (const q of reg.zones) {
      const [qx, qy] = P.toXY(q.centroid[0], q.centroid[1]);
      if (Math.hypot(qx - cx, qy - cy) < 3600 && !g.state.territory.owned.includes(q.id)) g.state.territory.owned.push(q.id);
    }
    const owned = new Set(g.state.territory.owned);
    const main = [];
    for (let e = 0; e < gr.m; e++) {
      if (gr.cls[e] < 2 || gr.cls[e] > 4 || (gr.flags[e] & 6)) continue;
      const v = gr.ea[e];
      if (owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]]).id)) main.push(v);
    }
    const nearest = (ll) => { const [x, y] = P.toXY(ll[0], ll[1]); let b = main[0], bd = 1e12; for (const v of main) { const d = (gr.x[v] - x) ** 2 + (gr.y[v] - y) ** 2; if (d < bd) { bd = d; b = v; } } return b; };
    const hub = nearest(z.centroid);
    let depot = null;
    const byHub = [...main].sort((a, b) => Math.hypot(gr.x[a] - gr.x[hub], gr.y[a] - gr.y[hub]) - Math.hypot(gr.x[b] - gr.x[hub], gr.y[b] - gr.y[hub]));
    for (const v of byHub.slice(120, 600)) { const r = g.buildDepot([gr.lng[v], gr.lat[v]]); if (r.ok) { depot = r.value; break; } }
    const depots = [depot];
    const chain = (nodes) => {
      let out = [];
      for (let i = 1; i < nodes.length; i++) {
        const l = routeWithFallback(gr, nodes[i - 1], nodes[i]);
        if (!l || l.contraflow.length) return null;
        out = out.concat(i === 1 ? l.nodes : l.nodes.slice(1));
      }
      return out;
    };
    const genericLine = (ang) => {
      let best = null;
      const cands = main.filter((v) => {
        const dx = gr.x[v] - gr.x[hub], dy = gr.y[v] - gr.y[hub], d = Math.hypot(dx, dy);
        if (d < 1700 || d > 3000) return false;
        let a = (Math.atan2(dx, dy) * 180) / Math.PI - ang; a = ((a + 540) % 360) - 180;
        return Math.abs(a) < 22;
      });
      cands.sort((a, b) => Math.abs(Math.hypot(gr.x[a] - gr.x[hub], gr.y[a] - gr.y[hub]) - 2400) - Math.abs(Math.hypot(gr.x[b] - gr.x[hub], gr.y[b] - gr.y[hub]) - 2400));
      for (const b of cands.filter((_, i) => i % 3 === 0).slice(0, 40)) {
        const l = routeWithFallback(gr, hub, b);
        if (!l || l.contraflow.length) continue;
        const d = Math.hypot(gr.x[b] - gr.x[hub], gr.y[b] - gr.y[hub]);
        const ratio = l.metres / d;
        if (!best || ratio < best.ratio) best = { nodes: l.nodes, ratio };
        if (ratio < 1.25) break;
      }
      return best?.nodes ?? null;
    };
    const stopNear = (ll) => { const [x, y] = P.toXY(ll[0], ll[1]); let b = null, bd = 160; for (const s of Object.values(g.state.stops)) { const [sx, sy] = P.toXY(s.lngLat[0], s.lngLat[1]); const d = Math.hypot(sx - x, sy - y); if (d < bd) { bd = d; b = s.id; } } return b; };
    const stopsAlong = (nodes) => {
      const stops = []; let acc = 1e9;
      for (let i = 1; i < nodes.length; i++) {
        const p = nodes[i - 1], q = nodes[i];
        acc += Math.hypot(gr.x[q] - gr.x[p], gr.y[q] - gr.y[p]);
        if (acc >= 380 || i === nodes.length - 1) {
          const ll = [gr.lng[q], gr.lat[q]];
          const r = g.placeStop(ll);
          const id = r.ok ? r.value : stopNear(ll);
          if (id && !stops.includes(id)) { stops.push(id); acc = 0; }
        }
      }
      return stops;
    };
    const lineDefs = c.lines ? c.lines.map((a) => chain(a.map(nearest))) : c.angles.map(genericLine);
    const made = [];
    for (let li = 0; li < lineDefs.length; li++) {
      let nodes = lineDefs[li] ?? genericLine((li * 120 + 30) % 360);
      if (!nodes) { made.push('line ' + li + ' failed'); continue; }
      const stops = stopsAlong(nodes);
      const r = g.createRoute({ stops, kind: 'linear' });
      if (!r.ok) { made.push('route fail ' + r.error); continue; }
      let nb = 0;
      for (let i = 0; i < 4; i++) {
        const model = i === 3 && li > 0 ? 'midi10' : 'city12';
        let b = null;
        for (const d of depots) { b = g.buyVehicle(model, d); if (b.ok) break; }
        if (!b.ok) {
          const far = byHub.slice(0, 1500).find((v) => depots.every((d) => Math.hypot(gr.x[v] - gr.x[hub], gr.y[v] - gr.y[hub]) > 0 && P.toXY(...g.state.depots[d].lngLat).every((q, k) => Math.abs(q - (k ? gr.y[v] : gr.x[v])) < 1e9)) && depots.every((d) => { const [dx, dy] = P.toXY(...g.state.depots[d].lngLat); return Math.hypot(dx - gr.x[v], dy - gr.y[v]) > 500; }));
          if (far !== undefined) { const nd = g.buildDepot([gr.lng[far], gr.lat[far]]); if (nd.ok) { depots.push(nd.value); b = g.buyVehicle(model, nd.value); } }
        }
        if (b.ok) { g.assignVehicle(b.value, r.value); nb++; }
      }
      made.push(`${stops.length} stops ${nb} buses`);
    }
    // an extra, not yet registered, corridor for the route-planning shot
    window.__spare = null;
    const spareNodes = genericLine(((c.angles ? c.angles[0] : 315) + 75) % 360) ?? null;
    if (spareNodes) {
      const ids = []; let acc = 1e9;
      for (let i = 1; i < spareNodes.length; i++) {
        const p = spareNodes[i - 1], q = spareNodes[i];
        acc += Math.hypot(gr.x[q] - gr.x[p], gr.y[q] - gr.y[p]);
        if (acc >= 420) { const r = g.placeStop([gr.lng[q], gr.lat[q]]); if (r.ok) { ids.push(r.value); acc = 0; } }
      }
      window.__spare = ids.slice(0, 6);
    }
    g.run(86400 + 8.5 * 3600 - (g.t % 86400));
    g.emit('changed', 0);
    g.setSpeed(0);
    const pts = Object.values(g.state.stops).map((s) => s.lngLat);
    const mean = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    return { zone: z.name, made, balance: Math.round(g.state.finance.balance), mean, spare: window.__spare?.length ?? 0, audit: g.audit(), stops: pts.length };
  }, [c]);
  log(' setup', c.key, JSON.stringify(info));
  return info;
}

// ---- main -----------------------------------------------------------------------------------------------------
const browserCtx = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const has = (g) => GROUPS.includes(g);
const IST = CITIES[0];

if (['hero', 'hud', 'plan', 'close', 'stop', 'mgmt'].some(has) || has('video')) {
  // ---- İstanbul session at 1600x900 @2x ----
  if (['hero', 'hud', 'plan', 'close', 'stop', 'mgmt'].some(has)) {
    const page = await openGame(1600, 900, 2);
    const info = await setup(page, IST);
    await setHud(page, false);
    if (has('hero')) {
      log('hero candidates');
      for (const h of HERO) {
        await view(page, { center: h.center, zoom: h.zoom, pitch: h.pitch, bearing: h.bearing });
        await shot(page, `hero-istanbul-${h.id}`, 'İstanbul', `Golden Horn and Galata Bridge area at zoom ${h.zoom}, pitch ${h.pitch}, bearing ${h.bearing}, morning, three coloured lines with buses, interface hidden.`, false, 'hero candidate');
      }
    }
    if (has('hud') || has('hero')) {
      const h = HERO.find((x) => x.id === HERO_BEST) ?? HERO[0];
      await view(page, { center: h.center, zoom: h.zoom, pitch: h.pitch, bearing: h.bearing });
      await setHud(page, true);
      await page.evaluate(() => window.__game.setSpeed(1));
      await shot(page, 'hero-istanbul-hud', 'İstanbul', 'Same hero scene with the interface visible: top bar with clock and balance, tool rail.', true, `balance ${info.balance}`);
      await page.evaluate(() => window.__game.setSpeed(0));
      await setHud(page, false);
    }
    if (has('close')) {
      log('closeups');
      await page.evaluate(() => {
        const g = window.__game;
        for (let i = 0; i < 900 && !Object.values(g.state.vehicles).some((v) => v.status === 'at_stop'); i++) g.run(1);
        g.emit('changed', 0);
      });
      const target = await page.evaluate(() => {
        const g = window.__game;
        const at = Object.values(g.state.vehicles).find((v) => v.status === 'at_stop');
        const mv = Object.values(g.state.vehicles).find((v) => v.status === 'in_service') ?? at;
        const ll = (v) => { const p = g.pose(v); return g.geo.P.toLngLat(p.x, p.y); };
        return { at: at ? { id: at.id, ll: ll(at) } : null, mv: { id: mv.id, ll: ll(mv) } };
      });
      await view(page, { center: target.mv.ll, zoom: 18.2, pitch: 64, bearing: -25 });
      await shot(page, 'closeup-bus-street', 'İstanbul', 'A bus in service on a city street, close-up at zoom 18.2 and pitch 64, interface hidden.', false);
      if (target.at) {
        await view(page, { center: target.at.ll, zoom: 18.3, pitch: 55, bearing: 200 });
        await shot(page, 'closeup-bus-stop', 'İstanbul', 'A bus standing at a stop, close-up at zoom 18.5, interface hidden.', false);
      }
      await view(page, { center: target.mv.ll, zoom: 17.8, pitch: 62, bearing: -25 });
      await setHud(page, true);
      await page.evaluate((id) => window.__ui.getState().select({ kind: 'vehicle', id }), target.mv.id);
      await shot(page, 'closeup-bus-selected', 'İstanbul', 'A bus selected with the vehicle inspector open, interface visible.', true);
      await page.evaluate(() => window.__ui.getState().select(null));
      await setHud(page, false);
    }
    if (has('plan')) {
      log('plan');
      await setHud(page, true);
      await page.evaluate(async () => {
        const { startDrafting, computePreview, appendStop } = await import('/src/ui/routeDraft.ts');
        startDrafting(null);
        const ui = window.__ui.getState();
        for (const id of (window.__spare ?? [])) ui.editDraft((d) => { const r = appendStop(d, id); return typeof r === 'string' ? {} : r; });
        computePreview(window.__ui.getState().draft);
        const g = window.__game, ids = window.__ui.getState().draft.stops;
        const pts = ids.map((id) => g.state.stops[id].lngLat);
        const lng = pts.map((p) => p[0]), lat = pts.map((p) => p[1]);
        window.__map.fitBounds([[Math.min(...lng), Math.min(...lat)], [Math.max(...lng), Math.max(...lat)]], { padding: { top: 140, bottom: 300, left: 200, right: 200 }, pitch: 50, bearing: -20, maxZoom: 16.2, duration: 0 });
      });
      await shot(page, 'plan-route-draft', 'İstanbul', 'The route tool mid-draft: dashed draft line, numbered stops and the bottom route tray.', true, '', 1800);
      await page.evaluate(() => { window.__ui.getState().setTool('select'); window.__ui.getState().select(null); });
      await page.evaluate(() => { const r = Object.values(window.__game.state.routes)[0]; window.__ui.getState().select({ kind: 'line', id: r.id }); const g = window.__game; const pts = r.stops.map((id) => g.state.stops[id].lngLat); const lng = pts.map((p) => p[0]), lat = pts.map((p) => p[1]); window.__map.fitBounds([[Math.min(...lng), Math.min(...lat)], [Math.max(...lng), Math.max(...lat)]], { padding: { top: 120, bottom: 120, left: 120, right: 460 }, pitch: 50, bearing: -28, maxZoom: 16, duration: 0 }); });
      await shot(page, 'plan-line-inspector', 'İstanbul', 'A line selected with its inspector card open and catchment rings around its stops.', true);
      await page.evaluate(() => window.__ui.getState().select(null));
    }
    if (has('stop')) {
      log('stop board');
      await setHud(page, true);
      await page.evaluate(() => {
        const g = window.__game, r = Object.values(g.state.routes)[0];
        const id = r.stops[Math.floor(r.stops.length / 2)];
        window.__ui.getState().select({ kind: 'stop', id });
        window.__map.jumpTo({ center: g.state.stops[id].lngLat, zoom: 17.2, pitch: 58, bearing: -20 });
      });
      await shot(page, 'ui-stop-board', 'İstanbul', 'A stop selected so its LED arrival board is shown.', true);
      await page.evaluate(() => window.__ui.getState().select(null));
    }
    if (has('mgmt')) {
      log('management');
      await setHud(page, true);
      const net = info.mean;
      await view(page, { center: net, zoom: 15.2, pitch: 52, bearing: -28 });
      await page.evaluate(() => window.__game.setSpeed(1));
      const m = (n, w, t) => shot(page, n, 'İstanbul', w, true, t);
      await page.evaluate(() => window.__ui.getState().openPanel('fleet'));
      await page.getByRole('button', { name: 'Buy', exact: true }).first().click().catch(() => log('  no Buy button'));
      await m('ui-fleet-buy', 'Fleet panel on the Buy tab: choosing a vehicle model to purchase.', '');
      await page.evaluate(() => window.__ui.getState().openPanel(null));
      await page.evaluate(() => window.__ui.getState().openPanel('fleet'));
      await m('ui-fleet-list', 'Fleet panel listing the company buses.', '');
      await page.evaluate(() => window.__ui.getState().openPanel('lines'));
      await m('ui-lines', 'Lines panel listing the registered lines.', '');
      await page.evaluate(() => window.__ui.getState().openPanel('finance'));
      await m('ui-finances', 'Finances panel with daily results and chart after a simulated day.', '');
      await page.evaluate(() => window.__ui.getState().openPanel('company'));
      await m('ui-company', 'Company panel with objectives and reputation.', '');
      await page.evaluate(() => { window.__ui.getState().openPanel(null); const r = Object.values(window.__game.state.routes)[0]; window.__ui.getState().openModal({ kind: 'timetable', route: r.id }); });
      await m('ui-timetable', 'Timetable editor for one line.', '');
      await page.evaluate(() => window.__ui.getState().openModal(null));
      await page.evaluate(() => window.__ui.getState().toggleOverlay('traffic'));
      await view(page, { zoom: 14.8, pitch: 45 });
      await m('ui-overlay-traffic', 'Traffic overlay: street congestion colouring during the morning rush.', '');
      await page.evaluate(() => { window.__ui.getState().toggleOverlay('traffic'); window.__ui.getState().toggleOverlay('demand'); });
      await m('ui-overlay-demand', 'Demand overlay: where passengers want to travel.', '');
      await page.evaluate(() => {
        window.__ui.getState().toggleOverlay('demand');
        const g = window.__game; g.state.territory.owned = [...window.__ownedSmall]; g.emit('changed', 0);
        window.__ui.getState().toggleOverlay('areas');
        window.__map.jumpTo({ zoom: 13.6, pitch: 30, bearing: 0 });
      });
      await m('ui-overlay-areas', 'Operating areas overlay: owned squares and veiled licensable squares with prices.', 'territory reset to the home zone and its neighbours for this shot');
      await page.evaluate(() => window.__ui.getState().toggleOverlay('areas'));
    }
    await page.close();
  }
}

if (has('hero') || has('world')) {
  // ---- ultra-wide hero (2400x1000 @1.5) ----
  if (has('hero')) {
    const page = await openGame(2400, 1000, 1.5);
    await setup(page, IST);
    await setHud(page, false);
    const h = HERO.find((x) => x.id === HERO_BEST) ?? HERO[0];
    await view(page, { center: h.center, zoom: h.zoom - 0.2, pitch: h.pitch, bearing: h.bearing });
    await shot(page, 'hero-istanbul-wide', 'İstanbul', 'Ultra-wide variant of the hero scene (2400x1000 viewport at 1.5x), interface hidden.', false);
    await page.close();
  }
  if (has('world')) {
    for (const c of CITIES.filter((c) => !process.env.ONLY || process.env.ONLY.split(',').includes(c.key))) {
      log('world', c.key);
      const page = await openGame(1600, 900, 2);
      const info = await setup(page, c);
      await setHud(page, false);
      const v = { center: info.mean, ...c.view };
      await view(page, v);
      await shot(page, `city-${c.key}`, c.city, `${c.city} from above at zoom ${v.zoom}, pitch ${v.pitch}, with three coloured bus lines drawn and buses running, interface hidden.`, false, '', 4500);
      await page.close();
    }
  }
}

if (has('terr')) {
  log('territory');
  const page = await openGame(1600, 900, 2);
  await setup(page, IST);
  await page.evaluate(() => { const g = window.__game; g.state.territory.owned = [...window.__ownedSmall]; g.emit('changed', 0); window.__ui.getState().toggleOverlay('areas'); });
  await setHud(page, false);
  await view(page, { center: [28.9739, 41.0248], zoom: 13.9, pitch: 40, bearing: -10 }, 2200);
  await shot(page, 'territory-wide-nohud', 'İstanbul', 'Operating areas overlay with the interface hidden: owned squares in colour, veiled licensable squares with prices, blank land beyond.', false, 'overlay stays visible without HUD if prices show; check');
  await page.close();
}

if (has('flow')) {
  log('flow');
  const page = await openGame(1600, 900, 2);
  await settle(page, 2500);
  await page.screenshot({ path: join(OUT, 'flow-start-menu.png') });
  rec('flow-start-menu.png', '-', 'The start menu with the live map behind it.', true, 3200, 1800);
  await page.getByRole('button', { name: /New company/i }).first().click();
  await settle(page, 1200);
  await page.screenshot({ path: join(OUT, 'flow-new-1-place.png') });
  rec('flow-new-1-place.png', '-', 'New company flow, first step: choosing where to start.', true, 3200, 1800);
  await page.evaluate(async () => { const { PRESETS, presetSpec } = await import('/src/app/presets.ts'); await window.__session.beginNew(presetSpec(PRESETS[0])); });
  await page.waitForSelector('.mn-panel.setup', { timeout: 40000 }).catch(() => {});
  await settle(page, 1500);
  await page.screenshot({ path: join(OUT, 'flow-new-2-home-area.png') });
  rec('flow-new-2-home-area.png', 'İstanbul', 'New company flow: choosing a home area on the map.', true, 3200, 1800);
  await page.getByRole('button', { name: /^Next/ }).click().catch(() => {});
  await settle(page, 1500);
  await page.screenshot({ path: join(OUT, 'flow-new-3-details.png') });
  rec('flow-new-3-details.png', 'İstanbul', 'New company flow: company name, colour and logo.', true, 3200, 1800);
  await page.close();
}

if (has('video')) {
  log('video');
  const FRAMES = Number(process.env.FRAMES || 300);
  const dir = join(OUT, '_frames');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const DSF = Number(process.env.VIDEO_DSF || 4 / 3), XF = Number(process.env.VIDEO_XFADE ?? 20);
  const page = await openGame(1920, 1080, DSF);
  await setup(page, IST);
  await setHud(page, false);
  const h = HERO.find((x) => x.id === (process.env.VIDEO_VIEW || HERO_BEST)) ?? HERO[0];
  const cam = (f) => {
    const u = f / FRAMES, s = 0.5 - 0.5 * Math.cos(u * 2 * Math.PI); // closed loop: returns to the start
    return { center: [h.center[0] + 0.0012 * s, h.center[1] + 0.0004 * s], zoom: h.zoom, pitch: h.pitch, bearing: h.bearing + 6 * s };
  };
  // pre-warm tiles along the camera path, then freeze the automatic clock
  for (let f = 0; f <= FRAMES; f += 50) await view(page, cam(f), 400);
  await view(page, cam(0), 800);
  await page.evaluate(() => { const g = window.__game; window.__adv = g.advance.bind(g); g.advance = () => 0; g.setSpeed(1); });
  for (let f = 0; f < FRAMES + XF; f++) { // the extra XF frames are cross-faded into the first XF to hide the loop jump
    await page.evaluate((c) => { window.__adv(1 / 30); window.__map.jumpTo(c); window.__map.triggerRepaint(); }, cam(f));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    if (f % 25 === 0) await page.waitForFunction(() => !window.__city?.busy && window.__map.areTilesLoaded(), null, { timeout: 20000 }).catch(() => {});
    await page.screenshot({ path: join(dir, String(f).padStart(4, '0') + '.png') });
    if (f % 50 === 0) log('  frame', f, 'size', page.dsf);
  }
  await page.close();
  const run = (a) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...a]);
  const fr = (n) => join(dir, String(n).padStart(4, '0') + '.png');
  // output = [cross-fade of frames FRAMES..FRAMES+XF-1 (out) into 0..XF-1 (in)] + frames XF..FRAMES-1, so the last frame flows into the first
  const seq = XF > 0
    ? ['-framerate', '30', '-start_number', String(FRAMES), '-i', join(dir, '%04d.png'), '-framerate', '30', '-start_number', '0', '-i', join(dir, '%04d.png'), '-framerate', '30', '-start_number', String(XF), '-i', join(dir, '%04d.png'),
       '-filter_complex', `[0:v]trim=end_frame=${XF},setpts=PTS-STARTPTS[o];[1:v]trim=end_frame=${XF},setpts=PTS-STARTPTS[i];[o][i]blend=all_expr='A*(1-N/${XF})+B*(N/${XF})'[x];[2:v]trim=end_frame=${FRAMES - XF},setpts=PTS-STARTPTS[r];[x][r]concat=n=2:v=1[v]`, '-map', '[v]']
    : ['-framerate', '30', '-i', join(dir, '%04d.png')];
  const pre = ['-r', '30'];
  run([...seq, ...pre, '-c:v', 'libx264', '-profile:v', 'high', '-crf', process.env.CRF || '24', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', join(OUT, 'video-istanbul.mp4')]);
  run([...seq, ...pre, '-c:v', 'libvpx-vp9', '-crf', process.env.CRFW || '40', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-an', join(OUT, 'video-istanbul.webm')]);
  run(['-i', fr(FRAMES), '-frames:v', '1', '-q:v', '2', join(OUT, 'video-istanbul-poster.jpg')]);
  const W = Math.round(1920 * DSF), H = Math.round(1080 * DSF);
  rec('video-istanbul.mp4', 'İstanbul', 'Ten-second seamlessly looping camera drift over the Golden Horn with buses moving along their lines, rendered frame by frame at 8x speed, interface hidden.', false, W, H, `H.264 high CRF 19, no audio; last ${XF} frames cross-faded into the first so the loop point is smooth (camera path is closed)`);
  rec('video-istanbul.webm', 'İstanbul', 'WebM (VP9) version of the same video.', false, W, H);
  rec('video-istanbul-poster.jpg', 'İstanbul', 'Poster frame of the video.', false, W, H);
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
}

// Route-tool clip: Barcelona / Eixample, ~16.5 s. A real line is drafted with the game's own route tool (placeStop +
// the draft store), confirmed, given buses and a timetable through the normal commands, then a bus is followed.
// Deterministic frame-by-frame like `video`. The F10 HUD toggle hides the in-game interface (the draft line and
// numbered draft stops are map layers/markers, so they stay); a CSS rule hides toasts/attribution that sit outside the HUD.
//   node website/scripts/capture-media.mjs <outDir> video-route      (STILLS=f1,f2,.. dumps only those frames)
if (has('video-route')) {
  log('video-route');
  const FPS = 30, FR = Number(process.env.FRAMES || 495);
  const STILLS = process.env.STILLS ? process.env.STILLS.split(',').map(Number) : null;
  const dir = join(OUT, '_frames_route');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const BASE = [2.1620, 41.3930], SX = 0.0018, SY = 0.0013;
  const gp = (i, j) => [BASE[0] + i * SX, BASE[1] + j * SY];
  const STOPS = (process.env.ROUTE_GRID ? JSON.parse(process.env.ROUTE_GRID) : [[-2, 1], [-1, 0], [0, -1], [1, 0], [2, 1]]).map(([i, j]) => gp(i, j));
  const T = { start: 2.0, add: [2.4, 3.2, 4.0, 4.8, 5.6], commit: 7.0, assign: [7.5, 7.7, 7.9, 8.1], tt: 8.6, ramp: 8.7, follow: 8.8 };
  const c = CITIES[2];
  const page = await openGame(1920, 1080, 1);
  await page.addStyleTag({ content: '.toast,.attrib,.update-banner,.maplibregl-ctrl-bottom-right,.maplibregl-ctrl-bottom-left{display:none !important}' });
  // bare city: company, territory, a depot and four parked buses, but no lines
  const info = await page.evaluate(async ([c, STOPS]) => {
    const { PRESETS, presetSpec } = await import('/src/app/presets.ts');
    await window.__session.beginNew(presetSpec(PRESETS[c.idx]));
    const reg = window.__session.region, ctr = reg.spec.centre;
    const sc = (z) => (z.residents + z.jobs) / (1 + Math.hypot(z.centroid[0] - ctr[0], z.centroid[1] - ctr[1]) * 80);
    const z = [...reg.zones].sort((a, b) => sc(b) - sc(a))[0];
    window.__session.startNew({ name: c.company.name, colour: c.company.colour, logo: 1 }, z.id);
    const g = window.__game;
    g.state.onboarding.active = false;
    { const { post } = await import('/src/game/finance.ts'); post(g.state, { amt: 1400000, cat: 'equity', memo: 'Investor capital' }); }
    const P = g.geo.P, gr = g.region.graph;
    const [cx, cy] = P.toXY(z.centroid[0], z.centroid[1]);
    for (const q of reg.zones) { const [qx, qy] = P.toXY(q.centroid[0], q.centroid[1]); if (Math.hypot(qx - cx, qy - cy) < 3600 && !g.state.territory.owned.includes(q.id)) g.state.territory.owned.push(q.id); }
    const owned = new Set(g.state.territory.owned);
    const main = [];
    for (let e = 0; e < gr.m; e++) {
      if (gr.cls[e] < 2 || gr.cls[e] > 4 || (gr.flags[e] & 6)) continue;
      const v = gr.ea[e];
      if (owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]]).id)) main.push(v);
    }
    // depot: a main-road node 350-650 m from the first stop, nearest to a point beside it
    const [fx, fy] = P.toXY(STOPS[0][0], STOPS[0][1]);
    const want = [fx - 190, fy - 190];
    const cand = main.filter((v) => { const d = Math.hypot(gr.x[v] - fx, gr.y[v] - fy); return d > 170 && d < 330; })
      .sort((a, b) => Math.hypot(gr.x[a] - want[0], gr.y[a] - want[1]) - Math.hypot(gr.x[b] - want[0], gr.y[b] - want[1]));
    let depot = null, dll = null;
    for (const v of cand.slice(0, 200)) { const r = g.buildDepot([gr.lng[v], gr.lat[v]]); if (r.ok) { depot = r.value; dll = [gr.lng[v], gr.lat[v]]; break; } }
    const buses = [];
    for (let i = 0; i < 4; i++) { const b = g.buyVehicle('city12', depot); if (b.ok) buses.push(b.value); }
    g.run(86400 + 8.5 * 3600 - (g.t % 86400));
    g.emit('changed', 0);
    g.setSpeed(0);
    return { zone: z.name, depot, dll, buses: buses.length };
  }, [c, STOPS]);
  log(' bare city', JSON.stringify(info));
  await setHud(page, false);
  // ---- camera: Hermite keyframes (smooth velocity), bus follow blended in on top ----
  const cx = (STOPS.reduce((a, p) => a + p[0], 0) / STOPS.length), cy = (STOPS.reduce((a, p) => a + p[1], 0) / STOPS.length);
  const mid = [(cx * 2 + info.dll[0]) / 3, (cy * 2 + info.dll[1]) / 3]; // between the route and the depot
  const KEYS = [
    { t: 0, c: [(mid[0] + info.dll[0]) / 2, (mid[1] + info.dll[1]) / 2], z: 15.7, p: 50, b: -52 },
    { t: 2.2, c: mid, z: 16.15, p: 52, b: -49 },
    { t: 5.0, c: [cx, cy], z: 16.55, p: 52, b: -43 },
    { t: 8.5, c: [cx, cy], z: 16.6, p: 54, b: -20 },
    { t: 11, c: [cx, cy], z: 16.9, p: 58, b: 15 },
    { t: 16.5, c: [cx, cy], z: 17.5, p: 62, b: 40 },
  ];
  const cfg = { KEYS, T, FPS, STOPS };
  const camFns = () => {
    const lerp = (a, b, t) => a + (b - a) * t;
    const ss = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
    const dims = (k) => [k.c[0], k.c[1], k.z, k.p, k.b];
    const base = (t) => {
      const K = window.__cfg.KEYS, n = K.length;
      if (t <= K[0].t) return dims(K[0]);
      if (t >= K[n - 1].t) return dims(K[n - 1]);
      let i = 0; while (t > K[i + 1].t) i++;
      const a = dims(K[i]), b = dims(K[i + 1]), h = K[i + 1].t - K[i].t, u = (t - K[i].t) / h;
      const tan = (j, d) => { const lo = Math.max(0, j - 1), hi = Math.min(n - 1, j + 1); return (dims(K[hi])[d] - dims(K[lo])[d]) / (K[hi].t - K[lo].t); };
      return a.map((_, d) => {
        const m0 = tan(i, d) * h, m1 = tan(i + 1, d) * h, u2 = u * u, u3 = u2 * u;
        return (2 * u3 - 3 * u2 + 1) * a[d] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * b[d] + (u3 - u2) * m1;
      });
    };
    window.__base = base;
    window.__ss = ss; window.__lerp = lerp;
  };
  await page.evaluate(([cfg, src]) => { window.__cfg = cfg; new Function('return (' + src + ')')()(); }, [cfg, camFns.toString()]);
  // pre-warm tiles along the whole path (base path, plus the route corridor at follow zoom)
  const cam0 = (t) => page.evaluate((t) => { const v = window.__base(t); return { center: [v[0], v[1]], zoom: v[2], pitch: v[3], bearing: v[4] }; }, t);
  for (let t = 0; t <= 16.5; t += 1.5) await view(page, await cam0(t), 300);
  const corridor = [info.dll, ...STOPS];
  for (let k = 0; k < corridor.length; k++) await view(page, { center: corridor[k], zoom: 17.6, pitch: 62, bearing: -30 }, 500);
  await view(page, await cam0(0), 1200);
  await page.evaluate(() => { const g = window.__game; window.__adv = g.advance.bind(g); g.advance = () => 0; g.setSpeed(1); window.__follow = null; window.__sm = null; window.__route = null; });
  const act = {
    start: async () => page.evaluate(async () => { const { startDrafting } = await import('/src/ui/routeDraft.ts'); startDrafting(null); }),
    add: (i) => page.evaluate(async ([ll]) => {
      const { appendStop } = await import('/src/ui/routeDraft.ts');
      const g = window.__game, ui = window.__ui.getState();
      let r = g.placeStop(ll), k = 0;
      while (!r.ok && k++ < 6) r = g.placeStop([ll[0] + 0.00015 * k, ll[1] + 0.0001 * k]);
      if (!r.ok) throw new Error('placeStop ' + r.error);
      ui.editDraft((d) => { const x = appendStop(d, r.value); return typeof x === 'string' ? {} : x; });
    }, [STOPS[i]]),
    commit: () => page.evaluate(async () => {
      const { commitDraft } = await import('/src/ui/routeDraft.ts');
      const ok = commitDraft();
      window.__route = Object.keys(window.__game.state.routes)[0];
      window.__ui.getState().select(null);
      return ok;
    }),
    assign: (i) => page.evaluate((i) => { const g = window.__game; const v = Object.values(g.state.vehicles)[i]; return g.assignVehicle(v.id, window.__route).ok; }, i),
    timetable: () => page.evaluate(() => {
      const g = window.__game, bands = [{ from: 360, to: 1380, headway: 3 }];
      const r = g.setTimetable(window.__route, { weekday: { bands }, weekend: { bands }, layover: 3 });
      if (!r.ok) return r.error;
      // buses stand still in the depot while the clock waits for the first departure: skip that dead time invisibly
      for (let i = 0; i < 2400 && !Object.values(g.state.vehicles).some((v) => ['to_route', 'in_service', 'at_stop'].includes(v.status)); i++) g.run(1);
      g.run(10); g.emit('changed', 0);
      return 'ok';
    }),
  };
  const frame = (f, scale) => page.evaluate(([f, scale]) => {
    const g = window.__game, cfg = window.__cfg, t = f / cfg.FPS;
    window.__adv(scale / cfg.FPS);
    let v = window.__base(t);
    // follow: pick the first bus that is out on the road, ease the camera on to it
    if (t >= cfg.T.follow) {
      if (!window.__follow) {
        const vs = Object.values(g.state.vehicles).filter((x) => x.route === window.__route && ['to_route', 'in_service', 'at_stop'].includes(x.status));
        vs.sort((a, b) => a.id.localeCompare(b.id));
        if (vs[0]) window.__follow = vs[0].id;
      }
      const bus = window.__follow && g.state.vehicles[window.__follow];
      const p = bus && g.pose(bus);
      if (p) {
        const ll = g.geo.P.toLngLat(p.x, p.y);
        if (!window.__sm) window.__sm = [...ll];
        const k = 1 - Math.exp(-(1 / cfg.FPS) / 0.4);
        window.__sm = [window.__sm[0] + (ll[0] - window.__sm[0]) * k, window.__sm[1] + (ll[1] - window.__sm[1]) * k];
        // chase bearing: direction of travel from the last ~0.8 s of motion, low-passed on the angle
        const hist = (window.__hist ||= []);
        hist.push(p.x, p.y); if (hist.length > 50) hist.splice(0, 2);
        if (hist.length >= 20) {
          const dx = p.x - hist[0], dy = p.y - hist[1];
          if (Math.hypot(dx, dy) > 4) {
            const tb = (Math.atan2(dx, dy) * 180) / Math.PI;
            if (window.__hb === undefined) window.__hb = v[4];
            let dd = tb - window.__hb; dd = ((dd + 540) % 360) - 180;
            window.__hb += dd * (1 - Math.exp(-(1 / cfg.FPS) / 0.9));
          }
        }
        const hb = window.__hb ?? v[4];
        let db = hb - v[4]; db = ((db + 540) % 360) - 180;
        const w = window.__ss((t - cfg.T.follow) / 3.6);
        const e = [window.__lerp(v[0], window.__sm[0], w), window.__lerp(v[1], window.__sm[1], w), window.__lerp(v[2], 18.1, w), window.__lerp(v[3], 57, w), v[4] + db * w];
        v = e; window.__pad = 260 * w;
      }
    }
    window.__map.jumpTo({ center: [v[0], v[1]], zoom: v[2], pitch: v[3], bearing: v[4], padding: { top: window.__pad || 0, bottom: 0, left: 0, right: 0 } });
    window.__map.triggerRepaint();
    const bus = window.__follow && g.state.vehicles[window.__follow];
    return { z: +window.__map.getZoom().toFixed(2), p: +window.__map.getPitch().toFixed(1), b: +window.__map.getBearing().toFixed(0), st: bus?.status ?? null, gt: Math.round(g.t % 86400), vs: Object.values(g.state.vehicles).map((x) => x.status.slice(0, 2)).join(' ') };
  }, [f, scale]);
  let sc = 0.125; // 1x until the buses are assigned, then ramp to ~6x
  const events = [[T.start, () => act.start()], ...T.add.map((t, i) => [t, () => act.add(i)]), [T.commit, async () => log(' commit', await act.commit())],
    ...T.assign.map((t, i) => [t, () => act.assign(i)]), [T.tt, async () => log(' timetable', await act.timetable())]];
  const done = new Set();
  for (let f = 0; f < FR; f++) {
    const t = f / FPS;
    events.forEach(([et, fn], i) => { if (t >= et && !done.has(i)) { done.add(i); events[i].p = fn(); } });
    for (const e of events) if (e.p) { await e.p; e.p = null; }
    if (t >= T.ramp) sc = 0.125 + (1.25 - 0.125) * Math.min(1, (t - T.ramp) / 1.2) ** 2 * (3 - 2 * Math.min(1, (t - T.ramp) / 1.2));
    const st = await frame(f, sc);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForFunction(() => !window.__city?.busy && window.__map.areTilesLoaded() && !document.body.innerText.includes('Loading more'), null, { timeout: 20000 }).catch(() => log('  tiles timeout at', f));
    if (!STILLS || STILLS.includes(f)) await page.screenshot({ path: join(dir, String(f).padStart(4, '0') + '.png') });
    if (f % 30 === 0) log('  frame', f, JSON.stringify(st));
  }
  await page.close();
  if (!STILLS) {
    const run = (a) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...a]);
    const inp = ['-framerate', String(FPS), '-i', join(dir, '%04d.png')];
    run([...inp, '-c:v', 'libx264', '-crf', process.env.CRF || '31', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', join(OUT, 'video-route.mp4')]);
    run([...inp, '-c:v', 'libvpx-vp9', '-crf', process.env.CRFW || '60', '-b:v', '0', '-row-mt', '1', '-an', join(OUT, 'video-route.webm')]);
    run(['-ss', '13', '-i', join(OUT, 'video-route.mp4'), '-frames:v', '1', '-q:v', '3', join(OUT, 'video-route-poster.jpg')]);
    const picks = Array.from({ length: 8 }, (_, i) => Math.round(((i + 0.5) / 8) * (FR - 1)));
    run([...picks.flatMap((f) => ['-i', join(dir, String(f).padStart(4, '0') + '.png')]), '-filter_complex', '[0][1][2][3]hstack=4[a];[4][5][6][7]hstack=4[b];[a][b]vstack,scale=2400:-1', '-frames:v', '1', '-q:v', '4', join(OUT, 'video-route-sheet.jpg')]);
    const n = 'Barcelona / Eixample, 1920x1080 30 fps, ~16.5 s, rendered frame by frame from the game (no compositing); interface hidden with F10 plus a CSS rule for toasts/attribution.';
    rec('video-route.mp4', 'Barcelona', `Route tool in real gameplay: five stops added one by one, the draft grows along the streets, the line is confirmed, four buses assigned, a timetable set, then a bus is followed. ${n}`, false, 1920, 1080, 'H.264, no audio. Timeline: 0-2 s establishing, 2-7 s stops/draft, 7 s confirm, 7.5-8.1 s assign buses, 8.6 s timetable, 8.9+ s sim ramps to ~6x, 10.2 s follow camera');
    rec('video-route.webm', 'Barcelona', 'WebM (VP9) version of video-route.mp4.', false, 1920, 1080);
    rec('video-route-poster.jpg', 'Barcelona', 'Poster: frame at 13 s of video-route, finished line with buses.', false, 1920, 1080);
    rec('video-route-sheet.jpg', 'Barcelona', 'Contact sheet of eight evenly spaced frames, for review only.', false, 2400, 675);
    if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
  }
}

if (has('close2')) {
  log('close2');
  const page = await openGame(1600, 900, 2);
  await setup(page, IST);
  await setHud(page, false);
  // run the clock until 3+ buses are bunched together, then frame them
  const cl = await page.evaluate(() => {
    const g = window.__game;
    let best = null;
    for (let i = 0; i < 400; i++) {
      g.run(10);
      const ps = Object.values(g.state.vehicles).map((v) => g.pose(v)).filter(Boolean);
      for (const a of ps) {
        const near = ps.filter((b) => Math.hypot(a.x - b.x, a.y - b.y) < 45);
        if (near.length >= 3 && (!best || near.length > best.n)) {
          const x = near.reduce((s, b) => s + b.x, 0) / near.length, y = near.reduce((s, b) => s + b.y, 0) / near.length;
          best = { n: near.length, ll: g.geo.P.toLngLat(x, y) };
        }
      }
      if (best && best.n >= 3) break;
    }
    g.emit('changed', 0);
    return best;
  });
  log(' cluster', JSON.stringify(cl));
  if (cl) {
    await view(page, { center: cl.ll, zoom: 18.4, pitch: 64, bearing: -30 });
    await shot(page, 'closeup-a', 'İstanbul', 'Several buses bunched together on a street close to the camera (zoom 18.4, pitch 64), interface hidden.', false);
    await view(page, { center: cl.ll, zoom: 18.6, pitch: 62, bearing: 60 });
    await shot(page, 'closeup-b', 'İstanbul', 'The same buses seen from another side (zoom 18.6, pitch 62), interface hidden.', false);
  }
  await page.close();
}

// Close-ups for the other cities (interface hidden, zoom ~18.5, pitch ~63). Run:
//   URL=http://127.0.0.1:4199/ node website/scripts/capture-media.mjs <outDir> close-cities
// Without CLOSE_PICK it writes candidates to <outDir>/_cand/<key>-<cluster>-<bearing>.png (several clusters x bearings).
// With CLOSE_PICK="tokyo=1:2,hamburg=0:1,..." (cluster:bearing indexes) it writes the final closeup-<key>.png instead.
if (has('close-cities')) {
  log('close-cities');
  const NEAR = { // preferred landmark per city: clusters near it score higher
    tokyo: [139.7005, 35.6595, 'Shibuya'], hamburg: [9.9990, 53.5575, 'Binnenalster'],
    barcelona: [2.1620, 41.3930, 'Eixample'], durham: [-1.5750, 54.7755, 'the River Wear'],
  };
  const BEARINGS = [-30, 60, 150, 240];
  const PICK = Object.fromEntries((process.env.CLOSE_PICK || '').split(',').filter(Boolean).map((s) => { const [k, v] = s.split('='); const [c, b] = v.split(':').map(Number); return [k, { c, b }]; }));
  mkdirSync(join(OUT, '_cand'), { recursive: true });
  for (const c of CITIES.filter((c) => NEAR[c.key] && (!process.env.ONLY || process.env.ONLY.split(',').includes(c.key)))) {
    log('close-cities', c.key);
    const page = await openGame(1600, 900, 2);
    await setup(page, c);
    await setHud(page, false);
    const near = NEAR[c.key];
    near[3] = Number(process.env.CLUSTER_R || 55); near[4] = process.env.MOVING === "1"; // MOVING=1: only count buses driving, not parked at stops
    const clusters = await page.evaluate((near) => {
      const g = window.__game, P = g.geo.P, found = [];
      const [nx, ny] = P.toXY(near[0], near[1]);
      for (let i = 0; i < 700 && found.length < 6; i++) {
        g.run(12);
        const vs = Object.values(g.state.vehicles).filter((v) => g.pose(v) && (!near[4] || v.v > 2));
        const ps = vs.map((v) => ({ r: v.route, ...g.pose(v) }));
        let best = null;
        for (const a of ps) {
          const nb = ps.filter((b) => Math.hypot(a.x - b.x, a.y - b.y) < near[3]);
          const routes = new Set(nb.map((b) => b.r)).size;
          if (nb.length < 2) continue;
          const x = nb.reduce((s, b) => s + b.x, 0) / nb.length, y = nb.reduce((s, b) => s + b.y, 0) / nb.length;
          const score = routes * 3 + nb.length - Math.hypot(x - nx, y - ny) / 400;
          if (!best || score > best.score) best = { score, n: nb.length, routes, x, y };
        }
        if (best && best.n >= 2 && found.every((f) => Math.hypot(f.x - best.x, f.y - best.y) > 250)) found.push({ ...best, ll: P.toLngLat(best.x, best.y), t: g.t });
      }
      found.sort((a, b) => b.score - a.score);
      return found.slice(0, 4);
    }, near);
    log(' clusters', JSON.stringify(clusters.map((f) => ({ n: f.n, routes: f.routes, ll: f.ll.map((x) => +x.toFixed(4)) }))));
    // each cluster's moment is gone once the clock moves on, so frame the clusters in the order found
    // (the clock has run past them; re-find the nearest bunch to each saved position instead)
    const cands = [];
    for (let ci = 0; ci < clusters.length; ci++) {
      if (PICK[c.key] && PICK[c.key].c !== ci) continue;
      for (let bi = 0; bi < BEARINGS.length; bi++) {
        if (PICK[c.key] && PICK[c.key].b !== bi) continue;
        cands.push([ci, bi]);
      }
    }
    for (const [ci, bi] of cands) {
      const f = clusters[ci];
      // wind the clock until two or more buses sit at this spot again (they are periodic), else frame the spot anyway
      await page.evaluate(({ ll }) => {
        const g = window.__game, P = g.geo.P, [x0, y0] = P.toXY(ll[0], ll[1]);
        const cnt = () => Object.values(g.state.vehicles).map((v) => g.pose(v)).filter((p) => p && Math.hypot(p.x - x0, p.y - y0) < 60).length;
        for (let i = 0; i < 400 && cnt() < 2; i++) g.run(8);
        g.emit('changed', 0);
      }, f);
      const bearing = BEARINGS[bi] + (c.key === 'barcelona' ? -45 + 45 : 0);
      await view(page, { center: f.ll, zoom: 18.5, pitch: 63, bearing });
      await page.waitForFunction(() => !document.body.innerText.includes("Loading more of the map"), null, { timeout: 60000 }).catch(() => log("  toast still up"));
      const name = PICK[c.key] ? `closeup-${c.key}` : `_cand/${c.key}-${ci}-${bi}`;
      await shot(page, name, c.city, `${c.city} close-up near ${near[2]} at zoom 18.5, pitch 63, bearing ${bearing}: buses of several lines bunched on one street, interface hidden.`, false, PICK[c.key] ? 'chosen from several clusters and bearings' : 'candidate');
    }
    await page.close();
  }
}

await browserCtx.close();
log('done');
