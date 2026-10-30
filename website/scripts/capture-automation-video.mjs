// Product-demo recordings of Automation Studio and Network Control from the real running game.
// Needs the game's dev server and the save made by `scripts/capture-network.mjs sim` (a month of play with
// Network Control unlocked). The save is copied first; the original is never touched.
//
// How a clip is made
//  - The browser's screencast captures the page at 2x device pixels (3200x1800) in real time.
//  - A pointer overlay (a big arrow with a click ripple) is injected into the page. It only follows mouse
//    events the script really sends, so it shows genuine input and nothing else. It is part of the footage.
//  - The script also writes <clip>.json: the start and end seconds, and a list of zoom beats (time,
//    centre, zoom). render-automation-clips.mjs turns those into an eased zoom/pan with ffmpeg, encodes the
//    MP4 and WebM, and takes the poster.
//
//   pnpm dev --port 5191 --strictPort --host 127.0.0.1 &
//   URL=http://127.0.0.1:5191/ NC_PROFILE=<profile from capture-network.mjs sim> \
//     node website/scripts/capture-automation-video.mjs <outDir> [build,live,lab,flows]
//   node website/scripts/render-automation-clips.mjs <outDir>
import { chromium } from 'playwright';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://127.0.0.1:5191/';
const OUT = process.argv[2];
const WANT = (process.argv[3] || 'build,live,lab,flows').split(',');
const SRC = process.env.NC_PROFILE || join(tmpdir(), 'pt-network-control-profile');
const W = 1600, H = 900, DSF = 2;
if (OUT) mkdirSync(OUT, { recursive: true });

// the pointer overlay, injected before the page loads
const cursorInit = () => {
  const add = () => {
    if (document.getElementById('pt-cursor')) return;
    const st = document.createElement('style');
    st.textContent = `
      #pt-cursor{position:fixed;left:0;top:0;width:32px;height:42px;pointer-events:none;z-index:2147483647;transform:translate(-200px,-200px);filter:drop-shadow(0 3px 5px rgba(0,0,0,.5))}
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
    for (const t of ['mousemove', 'pointermove', 'drag', 'dragover']) document.addEventListener(t, move, true);
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

async function session(name, fn) {
  const work = join(tmpdir(), `pt-site-${name}`);
  rmSync(work, { recursive: true, force: true });
  cpSync(SRC, work, { recursive: true });
  const dir = join(OUT, `rec-${name}`);
  rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(work, {
    viewport: { width: W, height: H },
    deviceScaleFactor: DSF,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  await ctx.addInitScript(cursorInit);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  // Playwright's own recorder never exceeds 1x, so the frames come straight from the browser's screencast
  // at 2x device pixels (JPEG, with their timestamps)
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push([file, f.metadata.timestamp]);
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W * DSF, maxHeight: H * DSF, everyNthFrame: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ui = (f, a) => page.evaluate(f, a);
  await page.goto(URL);
  await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
  await ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await ui(() => window.__game.setSpeed(0));

  const now = () => Date.now() / 1000; // epoch seconds, the same clock as the screencast timestamps
  const meta = { start: 0, end: 0, poster: 0, beats: [] };
  let cur = { x: 800, y: 520 };
  const mark = async () => { await page.mouse.move(cur.x, cur.y); meta.start = now(); };
  const wait = (ms) => page.waitForTimeout(ms);
  // eased, slightly curved pointer travel in real time
  const glide = async (x, y, ms = 750) => {
    const a = cur, dx = x - a.x, dy = y - a.y, d = Math.hypot(dx, dy) || 1;
    const bow = Math.min(40, d * 0.07), nx = -dy / d, ny = dx / d;
    const s = Date.now();
    for (;;) {
      const p = Math.min(1, (Date.now() - s) / ms);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const o = Math.sin(Math.PI * e) * bow;
      await page.mouse.move(a.x + dx * e + nx * o, a.y + dy * e + ny * o);
      if (p >= 1) break;
      await wait(8);
    }
    cur = { x, y };
  };
  const centre = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }; };
  const moveTo = async (loc, ms, dx = 0, dy = 0) => { const c = await centre(loc); await glide(c.x + dx, c.y + dy, ms); return c; };
  const click = async (loc, ms = 750) => {
    await moveTo(loc, ms);
    await wait(120);
    await page.mouse.down();
    await wait(110);
    await page.mouse.up();
    await wait(200);
  };
  // zoom beat: ease to a zoom of the region (css px) over `dur` ms; no rect = back to the full view
  let beatEnd = { cx: 0.5, cy: 0.5, z: 1 };
  const zoom = (rect, dur = 800, zmax = 2.1) => {
    let to = { cx: 0.5, cy: 0.5, z: 1 };
    if (rect) {
      const z = Math.max(1.35, Math.min(zmax, W / (rect.w * 1.15), H / (rect.h * 1.15)));
      to = { cx: (rect.x + rect.w / 2) / W, cy: (rect.y + rect.h / 2) / H, z };
    }
    meta.beats.push({ t0: now(), t1: now() + dur / 1000, from: beatEnd, to });
    beatEnd = to;
  };
  const rectOf = async (loc, pad = 0) => { const b = await loc.boundingBox(); return { x: b.x - pad, y: b.y - pad, w: b.width + pad * 2, h: b.height + pad * 2 }; };
  const finish = async (holdMs = 1000) => { await wait(holdMs); meta.end = now(); };

  try {
    await fn({ now, page, ui, mark, wait, glide, click, moveTo, centre, zoom, rectOf, finish, meta, W, H });
  } catch (e) {
    await page.screenshot({ path: join(OUT, `${name}-error.png`) }).catch(() => {});
    console.log(name, 'FAILED', e.message.split('\n')[0]);
  }
  if (!meta.end) meta.end = now();
  await cdp.send('Page.stopScreencast').catch(() => {});
  await ctx.close();
  meta.frames = frames;
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(meta));
  console.log(name, frames.length, 'frames', (meta.end - meta.start).toFixed(1), 's', 'start', meta.start.toFixed(2), errors.length ? 'errors: ' + errors.slice(0, 3).join(' | ') : '');
}

const frame = (ui) => ui(() => {
  const g = window.__game, pts = Object.values(g.state.stops).map((s) => s.lngLat);
  const w = Math.min(...pts.map((p) => p[0])), e = Math.max(...pts.map((p) => p[0])), s = Math.min(...pts.map((p) => p[1])), n = Math.max(...pts.map((p) => p[1]));
  window.__map.fitBounds([[w, s], [e, n]], { padding: { left: 640, right: 120, top: 100, bottom: 80 }, maxZoom: 15.5, duration: 0, pitch: 45 });
});

const openNC = async (page, tab) => {
  await page.getByRole('button', { name: 'Open Network Control' }).click().catch(() => {});
  await page.waitForTimeout(500);
  await page.locator('.nc-tabs .seg button', { hasText: tab }).click();
  await page.waitForTimeout(700);
};

// the company's workflow, made with the game's own API (as scripts/capture-automation.mjs does)
const makeWorkflows = (ui) => ui(async () => {
  const g = window.__game;
  const { fromTemplate } = await import('/src/game/automation/templates.ts');
  const depot = Object.keys(g.state.depots)[0];
  g.buyVehicle('mini8', depot);
  const b = fromTemplate(g, 'crowding');
  const wb = g.state.automation.workflows[b.value];
  const cmp = wb.nodes.find((n) => n.type === 'logic.compare');
  g.updateWorkflow(b.value, {
    name: 'Extra bus when a line is busy (1% test threshold)',
    nodes: wb.nodes.map((n) => (n.id === cmp.id ? { ...n, label: 'More than 1% full?', config: { ...n.config, b: 1 } } : n)),
    mode: 'suggest', enabled: true,
  });
  g.setSpeed(0);
  g.emit('changed', 0);
  return b.value;
});
// let the real simulation run to a time of day (morning, when buses carry people)
const runTo = (ui, hour) => ui((h) => { const g = window.__game; for (let i = 0; i < 80 && (g.t % 86400) < h * 3600; i++) g.run(300); g.setSpeed(0); g.emit('changed', 0); }, hour);

export const clips = {
  // a workflow built from nodes by hand: search, drag, connect, set a threshold, test
  async build({ now, page, ui, mark, wait, glide, click, moveTo, centre, zoom, rectOf, finish, meta }) {
    await frame(ui);
    await runTo(ui, 7.5);
    await openNC(page, 'Automation');
    await mark();
    await wait(600);
    await click(page.getByRole('button', { name: 'New workflow' }).first(), 650);
    await page.waitForSelector('.react-flow__node');
    await wait(300);
    const canvas = page.locator('.st-canvas');
    const cb = await canvas.boundingBox();
    // park the trigger at the left of the canvas
    const trig = page.locator('.react-flow__node', { hasText: 'Every few minutes' }).first();
    const tb = await trig.boundingBox();
    await glide(tb.x + 60, tb.y + 14, 400);
    await page.mouse.down();
    await glide(cb.x + 50 + 60, cb.y + 30 + 14, 450);
    await page.mouse.up();
    await wait(300);
    zoom({ x: 16, y: 80, w: 1000, h: 420 }, 800, 1.6);
    const add = async (label, x, y) => {
      const box = page.locator('.st-search input');
      await click(box, 480);
      await box.fill('');
      await box.pressSequentially(label.split(' ')[0], { delay: 28 });
      await wait(150);
      const item = page.locator('.st-lib-item', { has: page.locator('b', { hasText: new RegExp(`^${label}$`) }) }).first();
      await moveTo(item, 420);
      await wait(100);
      await page.mouse.down();
      await glide(cb.x + x, cb.y + y, 600);
      await wait(120);
      await page.mouse.up();
      await wait(300);
    };
    const lap = (s) => process.env.LAP && console.log(s, (now() - meta.start).toFixed(1));
    lap('parked');
    await add('Line', 330, 215);
    lap('line');
    await add('Compare', 560, 215);
    await page.locator('.st-search input').fill('');
    const node = (t) => page.locator('.react-flow__node', { hasText: t }).first();
    const connect = async (a, ah, b, bh) => {
      const want = (await page.locator('.react-flow__edge').count()) + 1;
      for (let k = 0; k < 3 && (await page.locator('.react-flow__edge').count()) < want; k++) {
        await moveTo(node(a).locator(`.react-flow__handle.source[data-handleid="${ah}"]`), 450);
        await wait(80);
        await page.mouse.down();
        const t = await centre(node(b).locator(`.react-flow__handle.target[data-handleid="${bh}"]`));
        await glide(t.x, t.y, 550);
        await wait(150);
        await page.mouse.up();
        await wait(350);
      }
    };
    lap('compare');
    await connect('Every', 'event', 'Line', 'after');
    lap('c1');
    await connect('Line', 'occupancy', 'Compare', 'a');
    lap('c2');
    // choose the line the workflow reads
    await click(node("Line"), 500);
    const pick = page.locator('select', { has: page.locator('option', { hasText: 'Choose' }) }).first();
    await moveTo(pick, 350);
    await pick.selectOption({ index: 1 });
    await wait(500);
    await click(page.getByRole('button', { name: 'Test', exact: true }), 650);
    await wait(450);
    zoom({ x: 16, y: 600, w: 1568, h: 290 }, 800, 1.7);
    await wait(1700);
    zoom(null, 800);
    await finish(1400);
  },

  // a running workflow in Suggest mode: the suggestion card, the approval, the extra trip on the map
  async live({ page, ui, mark, wait, glide, click, moveTo, zoom, rectOf, finish }) {
    await frame(ui);
    await makeWorkflows(ui);
    await ui(() => { const g = window.__game; for (let i = 0; i < 60; i++) { g.run(900); if (g.state.automation.proposals.some((p) => p.status === 'open')) break; } g.setSpeed(0); g.emit('changed', 0); });
    await openNC(page, 'Automation');
    await mark();
    await wait(1100);
    const card = page.locator('.p-body .section', { hasText: 'Suggestions waiting' }).first();
    zoom(await rectOf(card, 6), 850, 1.9);
    await wait(1700);
    await click(page.getByRole('button', { name: 'Approve' }).first(), 900);
    await wait(2200);
    zoom(null, 850);
    await wait(700);
    await ui(() => window.__game.setSpeed(3));
    await wait(5200);
    await finish(1400);
  },

  // the Simulation Lab: two copies of the company, with and without the workflow
  async lab({ page, ui, mark, wait, glide, click, moveTo, zoom, rectOf, finish }) {
    await frame(ui);
    await makeWorkflows(ui);
    await openNC(page, 'Automation');
    await ui((n) => { const row = [...document.querySelectorAll('.st-wf')].find((r) => r.querySelector('.st-wf-name button')?.textContent === n); row.querySelector('.st-wf-name button').click(); }, 'Extra bus when a line is busy (1% test threshold)');
    await page.waitForSelector('.studio .react-flow__node');
    await wait(900);
    await mark();
    await wait(1000);
    await click(page.locator('.studio .seg button', { hasText: 'Simulation Lab' }), 800);
    await wait(700);
    zoom({ x: 300, y: 90, w: 600, h: 260 }, 800, 1.9);
    await wait(900);
    await click(page.getByRole('button', { name: 'Run the Lab' }), 800);
    await page.waitForSelector('.st-cmp', { timeout: 120000 });
    await wait(500);
    const t = page.locator('.st-cmp').first();
    const b = await t.boundingBox();
    zoom({ x: b.x + b.width * 0.35, y: b.y, w: b.width * 0.65, h: b.height }, 900, 1.7);
    await wait(700);
    const row = page.locator('.st-cmp tbody tr').nth(3).locator('td').last();
    await moveTo(row, 900);
    await wait(1800);
    await moveTo(page.locator('.st-cmp tbody tr').nth(11).locator('td').last(), 800);
    await wait(1500);
    zoom(null, 850);
    await finish(1400);
  },

  // Network Control's passenger flows drawn on the map
  async flows({ page, ui, mark, wait, glide, click, moveTo, zoom, rectOf, finish }) {
    await frame(ui);
    await openNC(page, 'Overview');
    await mark();
    await wait(1200);
    await click(page.locator('.nc-tabs .seg button', { hasText: 'Passengers' }), 800);
    await wait(700);
    zoom({ x: 80, y: 90, w: 620, h: 740 }, 800, 1.5);
    await wait(500);
    await click(page.locator('.nc-table tbody tr.click').first(), 900);
    await wait(900);
    zoom({ x: 760, y: 160, w: 780, h: 620 }, 900, 1.5);
    await ui(() => window.__game.setSpeed(2));
    await wait(2800);
    zoom({ x: 80, y: 90, w: 620, h: 500 }, 850, 1.5);
    await wait(500);
    await ui(() => window.__game.setSpeed(0));
    await click(page.getByRole('button', { name: 'Estimated demand' }), 900);
    await wait(900);
    zoom({ x: 760, y: 160, w: 780, h: 620 }, 900, 1.5);
    await wait(2600);
    zoom(null, 850);
    await finish(1400);
  },
};

if (process.argv[1].endsWith('capture-automation-video.mjs')) {
  for (const n of WANT) await session(n, clips[n]);
}
