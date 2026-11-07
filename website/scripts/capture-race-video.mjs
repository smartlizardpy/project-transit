// The race clip: two copies of the real game in one race over WebRTC (public Nostr relays introduce
// them, so this needs the internet), recorded at the same time and set side by side.
//  - Ana (left) opens a race in İstanbul; Ben (right) joins with the code; Ana starts it. Each
//    builds their own lines from the same home area, Ana's to one side and Ben's to the other.
//  - The clock runs: the scoreboard under the clock counts each company's journeys, and each map
//    shows the rival's lines dashed in their colour. Ben opens the standings.
// Each screen is captured by the browser's screencast at 2x device pixels with real timestamps, and
// a pointer overlay shows each player's own mouse (genuine input only), as in capture-coop-video.mjs.
//
//   pnpm exec vite --port 5191 --strictPort --host 127.0.0.1 &      (from the repo root)
//   URL=http://127.0.0.1:5191/ node website/scripts/capture-race-video.mjs <outDir>
//   cd website && pnpm media <outDir> race && pnpm media <outDir> race-poster
// Writes <outDir>/video-race.mp4, .webm and -poster.jpg.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://127.0.0.1:5191/';
const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node website/scripts/capture-race-video.mjs <outDir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const W = 1280, H = 720, DSF = 2;
// the part of each screen that is shown, in CSS pixels: the map around the action, with the
// scoreboard under the clock (the side toolbars and corner cards are left out)
const CROP = { x: 220, y: 78, w: 840, h: 630 };
const PANE = { w: 960, h: 720 }, GAP = 12;

// each player's own mouse, drawn into the page (it follows only the mouse events the script sends)
const cursorInit = () => {
  const add = () => {
    if (document.getElementById('pt-cursor')) return;
    const st = document.createElement('style');
    st.textContent = `
      #pt-cursor{position:fixed;left:0;top:0;width:26px;height:34px;pointer-events:none;z-index:2147483647;transform:translate(-200px,-200px);filter:drop-shadow(0 3px 5px rgba(0,0,0,.5))}
      #pt-cursor svg{display:block;width:100%;height:100%;transform-origin:3px 2px;transition:transform 110ms ease-out}
      #pt-cursor.down svg{transform:scale(.8)}
      .pt-ripple{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:3px solid rgba(255,255,255,.95);background:rgba(110,180,255,.4);pointer-events:none;z-index:2147483646;animation:pt-rip 560ms ease-out forwards}
      @keyframes pt-rip{to{transform:scale(4.4);opacity:0}}`;
    document.head.appendChild(st);
    const c = document.createElement('div');
    c.id = 'pt-cursor';
    c.innerHTML = '<svg viewBox="0 0 32 42"><path d="M3 2 L3 34 L11 27 L17 40 L24 37 L18 25 L29 25 Z" fill="#fff" stroke="#14181a" stroke-width="2.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const move = (e) => { if (e.clientX || e.clientY) c.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`; };
    for (const t of ['mousemove', 'pointermove']) document.addEventListener(t, move, true);
    document.addEventListener('mousedown', (e) => {
      c.classList.add('down');
      const r = document.createElement('div');
      r.className = 'pt-ripple';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 700);
    }, true);
    document.addEventListener('mouseup', () => c.classList.remove('down'), true);
  };
  if (document.body) add();
  else document.addEventListener('DOMContentLoaded', add);
};

async function player(name) {
  const profile = mkdtempSync(join(tmpdir(), `pt-race-${name}-`));
  const ctx = await chromium.launchPersistentContext(profile, {
    viewport: { width: W, height: H },
    deviceScaleFactor: DSF,
    // real local addresses instead of mDNS names, so two browsers on one machine can reach each other
    // the screencast sends 1x frames unless the device scale is forced as well
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-features=WebRtcHideLocalIpsWithMdns', `--force-device-scale-factor=${DSF}`],
  });
  await ctx.addInitScript(cursorInit);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message}`));
  await page.goto(URL);
  await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 60000 });
  const dir = join(OUT, `rec-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push([file, f.metadata.timestamp]);
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  let cur = { x: W / 2, y: H / 2 };
  const wait = (ms) => page.waitForTimeout(ms);
  // eased, slightly curved pointer travel in real time
  const glide = async (x, y, ms = 800) => {
    const a = cur, dx = x - a.x, dy = y - a.y, d = Math.hypot(dx, dy) || 1;
    const bow = Math.min(40, d * 0.07), nx = -dy / d, ny = dx / d;
    const s = Date.now();
    for (;;) {
      const p = Math.min(1, (Date.now() - s) / ms);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const o = Math.sin(Math.PI * e) * bow;
      await page.mouse.move(a.x + dx * e + nx * o, a.y + dy * e + ny * o);
      if (p >= 1) break;
      await wait(12);
    }
    cur = { x, y };
  };
  const click = async (mods = []) => {
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.down();
    await wait(110);
    await page.mouse.up();
    for (const m of mods) await page.keyboard.up(m);
  };
  return {
    name, ctx, page, frames, wait, glide, click,
    ui: (f, a) => page.evaluate(f, a),
    record: () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W * DSF, maxHeight: H * DSF, everyNthFrame: 1 }),
    stop: () => cdp.send('Page.stopScreencast').catch(() => {}),
  };
}

// Two lines for a player, heading away from the home area in direction `dir` (radians, east = 0),
// with buses on them, built the way capture-coop-video.mjs builds Ana's network.
const build = (ui, dir) => ui(async (dir) => {
  const { routeWithFallback } = await import('/src/game/world/graph.ts');
  const { flatTimetable } = await import('/src/game/timetable.ts');
  const g = window.__game;
  const gr = g.region.graph;
  const home = g.geo.zone(g.state.territory.home);
  for (const z of home.neighbours) if (!g.state.territory.owned.includes(z)) g.state.territory.owned.push(z); // room to build
  const owned = new Set(g.state.territory.owned);
  const [cx, cy] = g.geo.P.toXY(home.centroid[0], home.centroid[1]);
  const inOwned = (v) => owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]])?.id);
  const main = [];
  for (let e = 0; e < gr.m; e++) if (gr.cls[e] >= 2 && gr.cls[e] <= 4 && !(gr.flags[e] & 6) && inOwned(gr.ea[e])) main.push(gr.ea[e]);
  main.sort((a, b) => Math.hypot(gr.x[a] - cx, gr.y[a] - cy) - Math.hypot(gr.x[b] - cx, gr.y[b] - cy));
  const ang = (a, b) => Math.atan2(gr.y[b] - gr.y[a], gr.x[b] - gr.x[a]);
  const angDiff = (p, q) => { let d = Math.abs(p - q) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
  // start a little way out in our direction, so the two networks spread apart
  const start = main.find((v) => { const d = Math.hypot(gr.x[v] - cx, gr.y[v] - cy); return d > 250 && d < 900 && angDiff(Math.atan2(gr.y[v] - cy, gr.x[v] - cx), dir) < 0.7; }) ?? main[0];
  let depot = null;
  for (const v of [start, ...main.slice(0, 300)]) { const r = g.buildDepot([gr.lng[v], gr.lat[v]]); if (r.ok) { depot = r.value; break; } }
  const stopAt = (v) => {
    const r = g.placeStop([gr.lng[v], gr.lat[v]]);
    if (r.ok) return r.value;
    let best = null, bd = 70;
    for (const s of Object.values(g.state.stops)) { const [sx, sy] = g.geo.P.toXY(s.lngLat[0], s.lngLat[1]); const d = Math.hypot(sx - gr.x[v], sy - gr.y[v]); if (d < bd) { bd = d; best = s.id; } }
    return best;
  };
  const makeLine = (from, aim, spread, colour) => {
    let best = null;
    for (let i = 0; i < main.length; i += 2) {
      const b = main[i];
      const d = Math.hypot(gr.x[b] - gr.x[from], gr.y[b] - gr.y[from]);
      if (d < 1200 || d > 2600 || angDiff(ang(from, b), aim) > spread) continue;
      const l = routeWithFallback(gr, from, b);
      if (!l || l.contraflow.length || l.nodes.filter(inOwned).length < l.nodes.length * 0.95) continue;
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
    if (stops.length < 3) return null;
    const route = g.createRoute({ stops, kind: 'linear', colour });
    return route.ok ? route.value : null;
  };
  // each player's own lines in teal and purple: neither looks like a rival's dashed colour
  const line = (aim, colour) => makeLine(start, aim, 0.6, colour) ?? makeLine(start, aim, 1.1, colour) ?? makeLine(main[0], aim, 1.4, colour);
  const first = line(dir + 0.5, '#2f9e9a');
  const lines = [first, line(dir - 0.5, '#8b6fd6')].filter(Boolean);
  for (const l of lines) g.setTimetable(l, flatTimetable(12, 300, 1380));
  for (let round = 0; round < 4; round++) for (const l of lines) {
    const r = g.buyVehicle('mini8', depot);
    if (r.ok) g.assignVehicle(r.value, l);
  }
  g.state.onboarding.active = false;
  g.emit('changed', 0);
  return { lines: lines.length, buses: Object.keys(g.state.vehicles).length, stops: Object.keys(g.state.stops).length };
}, dir);

console.log('# Ana opens a race, Ben joins');
// through the real buttons: a module imported from the page can be a second copy of the app's
const A = await player('ana');
await A.page.getByRole('button', { name: /race a friend/i }).click();
await A.page.locator('.co-field input').fill('Ana');
await A.page.getByRole('button', { name: '1 day' }).click();
await A.page.getByRole('button', { name: /open a race/i }).click();
await A.page.waitForSelector('.co-code span', { timeout: 30000 });
const code = (await A.page.locator('.co-code span').textContent()).trim();
console.log('code', code);
const B = await player('ben');
await B.page.getByRole('button', { name: /join a friend/i }).click();
await B.page.locator('.co-field input').first().fill('Ben');
await B.page.locator('.co-code-in').fill(code);
await B.page.getByRole('button', { name: /^join$/i }).click();
await B.page.getByText(/You joined/).waitFor({ timeout: 90000 });
await A.page.getByText('Ben', { exact: true }).waitFor({ timeout: 10000 });
await A.page.getByRole('button', { name: /start the race/i }).click();
await Promise.all([A, B].map((p) => p.page.waitForFunction(() => window.__game && window.__race.state().phase === 'racing', null, { timeout: 180000 })));
await A.page.waitForFunction(() => window.__race.state().waiting.length === 0 && window.__game.speed > 0, null, { timeout: 30000 });
console.log('# both build');
const setSpeed = async (p, i) => {
  if (i > 0) return p.page.keyboard.press(String(i));
  if (await p.ui(() => window.__game.speed > 0)) await p.page.keyboard.press('Space');
};
await setSpeed(A, 0);
await A.page.waitForFunction(() => window.__game.speed === 0, null, { timeout: 5000 });
console.log('ana', await build(A.ui, Math.PI));
console.log('ben', await build(B.ui, 0));
for (const p of [A, B]) await p.ui(() => window.__ui?.getState().select?.(null));
// run the morning: buses out, people riding
await setSpeed(A, 4);
await A.page.waitForFunction(() => window.__game.state.clock.t % 86400 >= 7.4 * 3600, null, { timeout: 120000 });
await setSpeed(A, 0);
await A.wait(1200);

// one camera for both screens: every stop of both networks, tilted, in the shown part
const pts = [...(await A.ui(() => Object.values(window.__game.state.stops).map((s) => s.lngLat))), ...(await B.ui(() => Object.values(window.__game.state.stops).map((s) => s.lngLat)))];
const cam = await B.ui(({ pts, crop, W, H }) => {
  const m = window.__map;
  m.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  const w = Math.min(...pts.map((p) => p[0])), e = Math.max(...pts.map((p) => p[0])), s = Math.min(...pts.map((p) => p[1])), n = Math.max(...pts.map((p) => p[1]));
  m.fitBounds([[w, s], [e, n]], { padding: { left: crop.x + 50, right: W - crop.x - crop.w + 50, top: crop.y + 120, bottom: H - crop.y - crop.h + 40 }, maxZoom: 15, duration: 0, pitch: 35, bearing: 0 });
  const c = m.getCenter();
  return { center: [c.lng, c.lat], zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing() };
}, { pts, crop: CROP, W, H });
for (const p of [A, B]) await p.ui((c) => { window.__map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); window.__map.jumpTo(c); }, cam);
await Promise.all([A, B].map((p) => p.page.waitForFunction(() => window.__map.areTilesLoaded(), null, { timeout: 30000 }).catch(() => {})));
await setSpeed(A, 3);
await A.wait(2500);

console.log('# recording');
await Promise.all([A.record(), B.record()]);
await A.wait(500);
const t = { start: Date.now() / 1000 };
await A.wait(2600);
// Ben opens the standings, reads them, and closes them again
const board = await B.page.locator('.rc-board').boundingBox();
await B.glide(CROP.x + CROP.w * 0.62, CROP.y + CROP.h * 0.55, 900);
await B.wait(300);
await B.glide(board.x + board.width * 0.62, board.y + board.height / 2, 900);
await B.wait(200);
await B.click();
t.poster = Date.now() / 1000 + 0.6;
await B.wait(3200);
await B.click();
await B.wait(300);
await B.glide(CROP.x + CROP.w * 0.7, CROP.y + CROP.h * 0.62, 900);
await A.wait(2200);
t.end = Date.now() / 1000;
await Promise.all([A.stop(), B.stop()]);
const scores = await A.ui(() => window.__race.state().scores);
console.log('scores', scores);
await A.ctx.close();
await B.ctx.close();

console.log('# render');
const list = (frames, name) => {
  const lines = frames.map(([f, ts], i) => `file '${f}'\nduration ${(i + 1 < frames.length ? frames[i + 1][1] - ts : Math.max(0.05, t.end - ts)).toFixed(4)}`);
  lines.push(`file '${frames.at(-1)[0]}'`);
  const file = join(OUT, `${name}.txt`);
  writeFileSync(file, lines.join('\n'));
  return ['-f', 'concat', '-safe', '0', '-ss', Math.max(0, t.start - frames[0][1]).toFixed(3), '-t', (t.end - t.start).toFixed(3), '-i', file];
};
// the frames' real scale (the screencast may send 1x frames even with a 2x device)
const fw = Number(execFileSync('magick', ['identify', '-format', '%w', A.frames[5][0]]).toString());
const k = fw / W;
console.log('frame scale', k);
const c = { x: Math.round(CROP.x * k), y: Math.round(CROP.y * k), w: Math.round(CROP.w * k), h: Math.round(CROP.h * k) };
const pane = (i, label) => `[${i}:v]fps=30,crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${PANE.w}:${PANE.h}:flags=lanczos${label}`;
const graph = `${pane(0, `,pad=${PANE.w + GAP}:${PANE.h}:0:0:color=0x161c19[a]`)};${pane(1, '[b]')};[a][b]hstack=inputs=2,format=yuv420p`;
const inputs = [...list(A.frames, 'ana'), ...list(B.frames, 'ben')];
const base = join(OUT, 'video-race');
const ff = (...args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
ff(...inputs, '-filter_complex', graph, '-an', '-c:v', 'libx264', '-profile:v', 'high', '-crf', process.env.CRF || '26', '-preset', 'slow', '-movflags', '+faststart', `${base}.mp4`);
ff(...inputs, '-filter_complex', graph, '-an', '-c:v', 'libvpx-vp9', '-crf', process.env.CRFW || '36', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', `${base}.webm`);
ff('-ss', (t.poster - t.start).toFixed(2), '-i', `${base}.mp4`, '-frames:v', '1', '-q:v', '2', `${base}-poster.jpg`);
console.log(`video-race: ${(t.end - t.start).toFixed(1)} s, ${A.frames.length} + ${B.frames.length} frames`);
process.exit(0);
