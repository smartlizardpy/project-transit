// Screen recordings of Automation Studio and Network Control from the real running game, for the website.
// Needs the game's dev server and the save made by `scripts/capture-network.mjs sim` (a month of play with
// Network Control unlocked). The save is copied first; the original is never touched. Playwright records
// the page in real time; each clip's raw .webm and the second at which the action starts are written to
// <outDir> as <clip>.webm and <clip>.start, and are then trimmed and encoded with ffmpeg (see website/README.md).
//
//   pnpm dev --port 5191 --strictPort &
//   URL=http://127.0.0.1:5191/ node website/scripts/capture-automation-video.mjs <outDir> [build,live,lab,flows]
import { chromium } from 'playwright';
import { cpSync, mkdirSync, rmSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://127.0.0.1:5191/';
const OUT = process.argv[2];
const WANT = (process.argv[3] || 'build,live,lab,flows').split(',');
const SRC = process.env.NC_PROFILE || join(tmpdir(), 'pt-network-control-profile');
const W = 1600, H = 900;
mkdirSync(OUT, { recursive: true });

async function session(name, fn) {
  const work = join(tmpdir(), `pt-site-${name}`);
  rmSync(work, { recursive: true, force: true });
  cpSync(SRC, work, { recursive: true });
  const dir = join(OUT, `rec-${name}`);
  rmSync(dir, { recursive: true, force: true });
  const t0 = Date.now();
  const ctx = await chromium.launchPersistentContext(work, {
    viewport: { width: W, height: H },
    recordVideo: { dir, size: { width: W, height: H } },
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ui = (f, a) => page.evaluate(f, a);
  await page.goto(URL);
  await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
  await ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await ui(() => window.__game.setSpeed(0));
  let startAt = 0;
  const mark = () => { startAt = (Date.now() - t0) / 1000; };
  try {
    await fn({ page, ui, mark });
  } catch (e) {
    await page.screenshot({ path: join(OUT, `${name}-error.png`) }).catch(() => {});
    console.log(name, 'FAILED', e.message.split('\n')[0]);
  }
  await page.waitForTimeout(300);
  await ctx.close();
  const f = readdirSync(dir).find((x) => x.endsWith('.webm'));
  renameSync(join(dir, f), join(OUT, `${name}.webm`));
  writeFileSync(join(OUT, `${name}.start`), startAt.toFixed(2));
  console.log(name, 'start', startAt.toFixed(2), errors.length ? 'errors: ' + errors.slice(0, 3).join(' | ') : '');
}

const frame = (ui) => ui(() => {
  const g = window.__game, pts = Object.values(g.state.stops).map((s) => s.lngLat);
  const w = Math.min(...pts.map((p) => p[0])), e = Math.max(...pts.map((p) => p[0])), s = Math.min(...pts.map((p) => p[1])), n = Math.max(...pts.map((p) => p[1]));
  window.__map.fitBounds([[w, s], [e, n]], { padding: { left: 640, right: 120, top: 100, bottom: 80 }, maxZoom: 15.5, duration: 0, pitch: 45 });
});

const openAutomation = async (page) => {
  await page.getByRole('button', { name: 'Open Network Control' }).click().catch(() => {});
  await page.waitForTimeout(500);
  await page.locator('.nc-tabs .seg button', { hasText: 'Automation' }).click();
  await page.waitForTimeout(600);
};

// the company's workflows, made with the game's own API (as scripts/capture-automation.mjs does)
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

export const clips = {
  // a workflow built from nodes by hand: library clicks and dragged connections
  async build({ page, ui, mark }) {
    await frame(ui);
    await openAutomation(page);
    mark();
    await page.waitForTimeout(450);
    await page.getByRole('button', { name: 'New workflow' }).first().click();
    await page.waitForSelector('.react-flow__node');
    await page.waitForTimeout(450);
    const canvas = page.locator('.st-canvas');
    const add = async (label, x, y) => {
      await page.locator('.st-search input').fill(label);
      await page.waitForTimeout(500);
      await page.locator('.st-lib-item', { has: page.locator('b', { hasText: new RegExp(`^${label}$`) }) }).first().dragTo(canvas, { targetPosition: { x, y }, steps: 12 });
      await page.waitForTimeout(450);
    };
    const trig = page.locator('.react-flow__node', { hasText: 'Every few minutes' }).first();
    const tb = await trig.boundingBox();
    const cb = await canvas.boundingBox();
    await page.mouse.move(tb.x + 60, tb.y + 14); await page.mouse.down();
    await page.mouse.move(cb.x + 50, cb.y + 150, { steps: 16 }); await page.mouse.up();
    await page.waitForTimeout(400);
    await add('Line', 330, 215);
    await add('Compare', 560, 215);
    await add('Send a notification', 780, 215);
    await page.locator('.st-search input').fill('');
    await page.waitForTimeout(500);
    const node = (t) => page.locator('.react-flow__node', { hasText: t }).first();
    const centre = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const connect = async (a, ah, b, bh) => {
      const want = (await page.locator('.react-flow__edge').count()) + 1;
      for (let k = 0; k < 3 && (await page.locator('.react-flow__edge').count()) < want; k++) {
        const p1 = await centre(node(a).locator(`.react-flow__handle.source[data-handleid="${ah}"]`));
        const p2 = await centre(node(b).locator(`.react-flow__handle.target[data-handleid="${bh}"]`));
        await page.mouse.move(p1.x, p1.y); await page.mouse.down();
        await page.mouse.move((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, { steps: 14 });
        await page.mouse.move(p2.x, p2.y, { steps: 14 });
        await page.waitForTimeout(200);
        await page.mouse.up();
        await page.waitForTimeout(450);
      }
    };
    await connect('Every', 'event', 'Line', 'after');
    await connect('Line', 'occupancy', 'Compare', 'a');
    await connect('Compare', 'result', 'Send a notification', 'when');
    await page.waitForTimeout(800);
    await node('Line').click({ position: { x: 100, y: 16 } });
    await page.waitForTimeout(800);
    await page.locator('select', { has: page.locator('option', { hasText: 'Choose' }) }).first().selectOption({ index: 1 });
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await page.waitForTimeout(3500);
    await page.screenshot({ path: join(OUT, 'build-end.png') });
  },

  // a running workflow in Suggest mode: a suggestion waits, the player approves it, the extra trip runs
  async live({ page, ui, mark }) {
    await frame(ui);
    await makeWorkflows(ui);
    await ui(() => { const g = window.__game; for (let i = 0; i < 60; i++) { g.run(900); if (g.state.automation.proposals.some((p) => p.status === 'open')) break; } g.setSpeed(0); g.emit('changed', 0); });
    await openAutomation(page);
    mark();
    await page.waitForTimeout(2200);
    await page.getByRole('button', { name: 'Approve' }).first().hover();
    await page.waitForTimeout(450);
    await page.getByRole('button', { name: 'Approve' }).first().click();
    await page.waitForTimeout(1200);
    await ui(() => window.__game.setSpeed(3));
    await page.waitForTimeout(7000);
    await page.screenshot({ path: join(OUT, 'live-end.png') });
  },

  // the Simulation Lab: two copies of the company, with and without the workflow
  async lab({ page, ui, mark }) {
    await frame(ui);
    await makeWorkflows(ui);
    await openAutomation(page);
    await ui((n) => { const row = [...document.querySelectorAll('.st-wf')].find((r) => r.querySelector('.st-wf-name button')?.textContent === n); row.querySelector('.st-wf-name button').click(); }, 'Extra bus when a line is busy (1% test threshold)');
    await page.waitForSelector('.studio .react-flow__node');
    await page.waitForTimeout(800);
    mark();
    await page.waitForTimeout(1500);
    await page.locator('.studio .seg button', { hasText: 'Simulation Lab' }).click();
    await page.waitForTimeout(1800);
    await page.getByRole('button', { name: 'Run the Lab' }).click();
    await page.waitForSelector('.st-cmp', { timeout: 120000 });
    await page.waitForTimeout(3500);
    await page.screenshot({ path: join(OUT, 'lab-end.png') });
  },

  // Network Control's passenger flows drawn on the map
  async flows({ page, ui, mark }) {
    await frame(ui);
    await openAutomation(page);
    await page.locator('.nc-tabs .seg button', { hasText: 'Overview' }).click();
    await page.waitForTimeout(800);
    mark();
    await page.waitForTimeout(1500);
    await page.locator('.nc-tabs .seg button', { hasText: 'Passengers' }).click();
    await page.waitForTimeout(1800);
    await ui(() => document.querySelectorAll('.nc-table tbody tr.click')[0]?.click());
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Estimated demand' }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Observed journeys' }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, 'flows-end.png') });
  },
};

if (process.argv[1].endsWith('capture-automation-video.mjs')) {
  for (const n of WANT) await session(n, clips[n]);
}
