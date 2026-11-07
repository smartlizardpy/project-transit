// The co-op clip: two copies of the real game, joined with a code over WebRTC (public Nostr relays
// introduce them, so this needs the internet), recorded at the same time and set side by side.
//  - Ana (left) founds a company with three lines and invites. Ben (right) joins with the code.
//  - Ben moves his mouse: his named cursor glides over Ana's map. He builds a stop: it appears in
//    both games, and Ana's screen says "Ben built a stop". Ana Option-clicks a spot: the ping shows
//    on Ben's map.
// Each screen is captured by the browser's screencast at 2x device pixels with real timestamps, and
// a pointer overlay shows each player's own mouse (genuine input only), as in capture-automation-video.mjs.
//
//   pnpm exec vite --port 5191 --strictPort --host 127.0.0.1 &      (from the repo root)
//   URL=http://127.0.0.1:5191/ node website/scripts/capture-coop-video.mjs <outDir>
//   cd website && pnpm media <outDir> coop && pnpm media <outDir> coop-poster
// Writes <outDir>/video-coop.mp4, .webm and -poster.jpg.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://127.0.0.1:5191/';
const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node website/scripts/capture-coop-video.mjs <outDir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const W = 1280, H = 720, DSF = 2;
// the part of each screen that is shown, in CSS pixels: the map around the action, with the
// "2 playing" strip under the clock (the side toolbars and corner cards are left out)
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
  const profile = mkdtempSync(join(tmpdir(), `pt-coop-${name}-`));
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

// Ana's company: three lines with buses, the way scripts/capture-network.mjs builds them
async function found(ui) {
  await ui(async () => { const { PRESETS, presetSpec } = await import('/src/app/presets.ts'); await window.__session.beginNew(presetSpec(PRESETS[0])); });
  await ui(() => new Promise((ok) => { const t = setInterval(() => window.__session.region && (clearInterval(t), ok()), 200); }));
  await ui(() => {
    const reg = window.__session.region;
    const c = reg.spec.centre;
    const score = (z) => (z.residents + z.jobs) / (1 + Math.hypot(z.centroid[0] - c[0], z.centroid[1] - c[1]) * 80);
    const z = [...reg.zones].sort((a, b) => score(b) - score(a))[0];
    window.__session.startNew({ name: 'Haliç Hat', colour: '#2f7fd6', logo: 1 }, z.id);
  });
  await ui(() => new Promise((ok) => { const t = setInterval(() => window.__game && (clearInterval(t), ok()), 200); }));
  return ui(async () => {
    const { routeWithFallback } = await import('/src/game/world/graph.ts');
    const { flatTimetable } = await import('/src/game/timetable.ts');
    const g = window.__game;
    const gr = g.region.graph;
    const home = g.geo.zone(g.state.territory.home);
    for (const z of home.neighbours) if (!g.state.territory.owned.includes(z)) g.state.territory.owned.push(z); // room to build
    const owned = new Set(g.state.territory.owned);
    const [cx, cy] = g.geo.P.toXY(home.centroid[0], home.centroid[1]);
    const inOwned = (v) => owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]]).id);
    const main = [];
    for (let e = 0; e < gr.m; e++) if (gr.cls[e] >= 2 && gr.cls[e] <= 4 && !(gr.flags[e] & 6) && inOwned(gr.ea[e])) main.push(gr.ea[e]);
    main.sort((a, b) => Math.hypot(gr.x[a] - cx, gr.y[a] - cy) - Math.hypot(gr.x[b] - cx, gr.y[b] - cy));
    let depot = null;
    for (const v of main.slice(0, 300)) { const r = g.buildDepot([gr.lng[v], gr.lat[v]]); if (r.ok) { depot = r.value; break; } }
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
      const route = g.createRoute({ stops, kind: 'linear' });
      return route.ok ? { id: route.value, start, end: best.b, nodes: best.l.nodes } : null;
    };
    const l1 = makeLine(main[0], 0, 7);
    const lines = [l1];
    if (l1) {
      lines.push(makeLine(l1.nodes[Math.floor(l1.nodes.length / 2)], Math.PI / 3, (2 * Math.PI) / 3, ang(l1.start, l1.end)));
      lines.push(makeLine(l1.end, Math.PI / 4, Math.PI, ang(l1.end, l1.start) + Math.PI));
    }
    const live = lines.filter(Boolean);
    for (const l of live) g.setTimetable(l.id, flatTimetable(12, 360, 1320));
    for (let round = 0; round < 4; round++) for (const l of live) {
      const r = g.buyVehicle('mini8', depot);
      if (r.ok) g.assignVehicle(r.value, l.id);
    }
    g.state.onboarding.active = false;
    // run the real simulation to the morning, so buses are out and carrying people
    for (let i = 0; i < 80 && (g.t % 86400) < 7.6 * 3600; i++) g.run(300);
    g.setSpeed(0);
    g.emit('changed', 0);
    return { lines: live.length, buses: Object.keys(g.state.vehicles).length, stops: Object.keys(g.state.stops).length };
  });
}

// the same view on both screens: the network, tilted, in the middle of the shown part
const frameView = (ui) => ui(({ crop, W, H }) => {
  const g = window.__game, pts = Object.values(g.state.stops).map((s) => s.lngLat);
  const w = Math.min(...pts.map((p) => p[0])), e = Math.max(...pts.map((p) => p[0])), s = Math.min(...pts.map((p) => p[1])), n = Math.max(...pts.map((p) => p[1]));
  // a game opened with Continue keeps a padding around the interface; a joined one does not
  window.__map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  window.__map.fitBounds([[w, s], [e, n]], { padding: { left: crop.x + 70, right: W - crop.x - crop.w + 70, top: crop.y + 90, bottom: H - crop.y - crop.h + 50 }, maxZoom: 15.4, duration: 0, pitch: 40, bearing: 0 });
}, { crop: CROP, W, H });

console.log('# Ana founds a company');
const A = await player('ana');
console.log(await found(A.ui));
// save and open it again from the start menu, so the map is in the normal game view
await A.ui(() => window.__session.save('manual'));
await A.page.reload();
await A.page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 60000 });
await A.ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
await A.page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await A.ui(() => window.__game.setSpeed(0));
const code = await A.ui(async () => (await import('/src/net/coop.ts')).hostGame('Ana'));
console.log('code', code);

console.log('# Ben joins');
const B = await player('ben');
await B.ui(async (c) => { await (await import('/src/net/coop.ts')).joinGame(c, 'Ben'); }, code);
await B.page.waitForFunction(() => window.__game && window.__coop.state().phase === 'playing', null, { timeout: 90000 });
for (const p of [A, B]) {
  await frameView(p.ui);
  await p.ui(() => window.__ui?.getState().select?.(null));
}
await A.wait(1500);
// one camera for both screens
await frameView(B.ui);
const cam = await B.ui(() => { const m = window.__map; const c = m.getCenter(); return { center: [c.lng, c.lat], zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing() }; });
for (const p of [A, B]) await p.ui((c) => { window.__map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); window.__map.jumpTo(c); }, cam);
console.log('cameras', await Promise.all([A, B].map((p) => p.ui(() => { const m = window.__map; const c = m.getCenter(); return `${c.lng.toFixed(5)},${c.lat.toFixed(5)} z${m.getZoom().toFixed(2)} p${m.getPitch().toFixed(0)}`; }))));
await A.ui(async () => (await import('/src/app/act.ts')).setSpeed(1));
await Promise.all([A, B].map((p) => p.page.waitForFunction(() => window.__map.areTilesLoaded(), null, { timeout: 30000 }).catch(() => {})));
await A.wait(2500);

// where Ben will build: a stop spot near the middle of the shown part, away from the lines' stops
const target = await B.ui(async ({ crop }) => {
  const { stopSpots } = await import('/src/game/spots.ts');
  const { checkStop } = await import('/src/game/network.ts');
  const g = window.__game, map = window.__map;
  const mid = { x: crop.x + crop.w * 0.5, y: crop.y + crop.h * 0.55 };
  const stops = Object.values(g.state.stops).map((s) => g.geo.xy(s.lngLat));
  let best = null;
  for (const s of stopSpots(g.region)) {
    const p = map.project(s.lngLat);
    if (p.x < crop.x + 120 || p.x > crop.x + crop.w - 160 || p.y < crop.y + 160 || p.y > crop.y + crop.h - 90) continue;
    const [x, y] = g.geo.xy(s.lngLat);
    if (Math.min(...stops.map(([sx, sy]) => Math.hypot(sx - x, sy - y))) < 260) continue;
    if (!checkStop(g.state, g.region, g.geo, s.lngLat).ok) continue;
    const d = Math.hypot(p.x - mid.x, p.y - mid.y);
    if (!best || d < best.d) best = { x: p.x, y: p.y, d };
  }
  return best;
}, { crop: CROP });
console.log('stop target', target);
if (!target) throw new Error('no free stop spot in view');

console.log('# recording');
await Promise.all([A.record(), B.record()]);
await A.wait(500);
const t = { start: Date.now() / 1000 };
await A.wait(900);
// Ben looks around the map, then heads for the spot
await B.glide(CROP.x + CROP.w * 0.78, CROP.y + CROP.h * 0.3, 1100);
await B.wait(350);
await B.glide(target.x + 70, target.y - 60, 1000);
await B.page.keyboard.press('b'); // the stop tool: the street's stop spots appear
await B.wait(700);
await B.glide(target.x, target.y, 600);
await B.wait(250);
const before = await B.ui(() => Object.keys(window.__game.state.stops).length);
await B.click();
await B.page.waitForFunction((n) => Object.keys(window.__game.state.stops).length > n, before, { timeout: 8000 }).catch(() => console.log('stop NOT built'));
await B.wait(500);
await B.page.keyboard.press('Escape');
await B.glide(target.x + 110, target.y + 70, 900);
await A.wait(900);
// Ana points next to the new stop: Option-click pings the spot for everyone
await A.glide(target.x - 140, target.y + 90, 1);
await A.glide(target.x - 30, target.y + 22, 900);
await A.wait(200);
await A.click(['Alt']);
t.poster = Date.now() / 1000 + 0.55;
await A.wait(2600);
t.end = Date.now() / 1000;
await Promise.all([A.stop(), B.stop()]);
const same = await Promise.all([A, B].map((p) => p.ui(() => ({ t: window.__game.state.clock.t, sum: window.__coop.sum(), stops: Object.keys(window.__game.state.stops).length }))));
console.log('games', same);
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
const base = join(OUT, 'video-coop');
const ff = (...args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
ff(...inputs, '-filter_complex', graph, '-an', '-c:v', 'libx264', '-profile:v', 'high', '-crf', process.env.CRF || '26', '-preset', 'slow', '-movflags', '+faststart', `${base}.mp4`);
ff(...inputs, '-filter_complex', graph, '-an', '-c:v', 'libvpx-vp9', '-crf', process.env.CRFW || '36', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', `${base}.webm`);
ff('-ss', (t.poster - t.start).toFixed(2), '-i', `${base}.mp4`, '-frames:v', '1', '-q:v', '2', `${base}-poster.jpg`);
console.log(`video-coop: ${(t.end - t.start).toFixed(1)} s, ${A.frames.length} + ${B.frames.length} frames`);
process.exit(0);
