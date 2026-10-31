// Automation QA screenshots for peak hours and sharing buses: the gallery group, the "Bring in
// buses before a line's peak" flow with its trigger's live state, and a test run of "Today's peak
// hours" with what each node found. From a genuinely simulated company, driven through the real
// UI. If the company's timetables run the same all day (no timetable peaks), the script gives its
// busiest line a two-peak weekday timetable first, as a player would; the progress notes say so.
// Run `node scripts/capture-network.mjs sim` first (it simulates a company and saves), with the
// dev server on port 5182, then:
//
//   NC_PROFILE=<same profile> node scripts/capture-peaks.mjs
import { chromium } from 'playwright';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://localhost:5182/';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots/network-control';
const SRC = process.env.NC_PROFILE || join(tmpdir(), 'pt-network-control-profile');
const WORK = join(tmpdir(), 'pt-peaks-profile');
mkdirSync(OUT, { recursive: true });
rmSync(WORK, { recursive: true, force: true });
cpSync(SRC, WORK, { recursive: true }); // never touch the original save

const ctx = await chromium.launchPersistentContext(WORK, {
  viewport: { width: 1920, height: 1080 },
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const ui = (fn, arg) => page.evaluate(fn, arg);
const checks = [];
const check = (name, ok, extra = '') => { checks.push({ name, ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const settle = async (extra = 900) => {
  await page.waitForFunction(() => window.__map?.areTilesLoaded() && !window.__city?.busy, null, { timeout: 30000 }).catch(() => console.warn('  tiles timeout'));
  await page.waitForTimeout(extra);
};
const shot = async (name, extra) => { await settle(extra); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('  shot', name); };
const tab = async (name) => { await page.locator('.nc-tabs .seg button', { hasText: name }).click(); await page.waitForTimeout(600); };

await page.goto(URL);
await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
await ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await ui(() => { window.__game.setSpeed(0); window.__game.setNetworkIntro?.({ seen: true }); });

// ───────────────────────── 1. a weekday at 05:30, with the peak workflows switched on
const setup = await ui(async () => {
  const g = window.__game;
  const { fromTemplate } = await import('/src/game/automation/templates.ts');
  const { timetablePeaks } = await import('/src/game/automation/peaks.ts');
  const DAY = 86400, H = 3600;
  let d = Math.floor(g.t / DAY) + 1;
  while (((g.state.clock.startWeekday + d) % 7) >= 5) d++;
  g.run(d * DAY + 5 * H + 30 * 60 - g.t);
  const lines = Object.values(g.state.routes).filter((r) => !r.suspended);
  let changed = null;
  if (!lines.some((r) => timetablePeaks(g, r.id).length)) {
    const r = lines.sort((a, b) => b.vehicles.length - a.vehicles.length)[0];
    const base = r.timetable.weekday.bands[0]?.headway ?? 15;
    const peak = Math.max(4, Math.round(base / 2));
    const tt = { ...r.timetable, weekday: { bands: [{ from: 360, to: 420, headway: base }, { from: 420, to: 540, headway: peak }, { from: 540, to: 960, headway: base }, { from: 960, to: 1080, headway: peak }, { from: 1080, to: 1380, headway: base }] } };
    const res = g.setTimetable(r.id, tt);
    changed = res.ok ? `Line ${r.number}: every ${base} min, every ${peak} min 07–09 and 16–18` : res.error;
  }
  const ids = {};
  for (const id of ['peak-bring-in', 'peak-park', 'peak-warning', 'peak-report']) {
    const r = fromTemplate(g, id);
    ids[id] = r.ok ? r.value : r.error;
    if (r.ok) g.updateWorkflow(r.value, { enabled: true });
  }
  g.run(60);
  g.setSpeed(0);
  g.emit('changed', 0);
  const peaks = Object.values(g.state.routes).map((r) => `Line ${r.number}: ${timetablePeaks(g, r.id).map((p) => `${p.from / 60}-${p.to / 60}h need ${p.need}`).join(', ') || 'none'}`);
  return { ids, changed, peaks, spares: Object.values(g.state.vehicles).filter((v) => v.route === null).length };
});
console.log('  setup', JSON.stringify(setup));
check('workflows created', Object.values(setup.ids).every((v) => typeof v === 'string' && v.startsWith('wf')), JSON.stringify(setup.ids));

// ───────────────────────── 2. the gallery group
await ui(() => window.__ui.getState().openPanel('network'));
await page.waitForTimeout(800);
await tab('Automation');
await page.locator('.section-head', { hasText: 'Start from a template' }).getByRole('button', { name: 'Show' }).click();
await page.waitForTimeout(300);
await ui(() => { const el = [...document.querySelectorAll('.st-tpl-group')].find((g) => g.textContent.includes('Peak hours and sharing buses')); el?.scrollIntoView({ block: 'start' }); });
await shot('automation-peaks-gallery', 500);
check('peak group in the gallery', await ui(() => [...document.querySelectorAll('.st-tpl-head b')].some((b) => b.textContent === 'Peak hours and sharing buses')));

// ───────────────────────── 3. the bring-in flow, its trigger's live state and settings
const openWf = async (name) => {
  await tab('Automation');
  await ui((n) => { const row = [...document.querySelectorAll('.st-wf')].find((r) => r.querySelector('.st-wf-name button')?.textContent === n); row.querySelector('.st-wf-foot button').click(); }, name);
  await page.waitForSelector('.studio .react-flow__node', { timeout: 10000 });
  await page.waitForTimeout(900);
};
await openWf('Bring in buses before a line’s peak');
await page.locator('.react-flow__node', { hasText: 'Peak hours start or end' }).first().click();
await page.waitForTimeout(500);
await shot('automation-peaks-bring-in', 400);
const live = await ui(() => document.querySelector('.st-node-live')?.textContent ?? '');
check('trigger shows the next peak', /^Next \d\d:\d\d: line \S+, peak \d\d:\d\d–\d\d:\d\d/.test(live), live);
await page.keyboard.press('Escape');

// ───────────────────────── 4. a test run of "Today's peak hours"
await ui(() => window.__ui.getState().setStudio({ open: false, workflow: null, peek: false }));
await page.waitForTimeout(400);
await ui(() => window.__ui.getState().openPanel('network'));
await openWf('Today’s peak hours');
await page.locator('.studio button', { hasText: 'Test' }).first().click();
await page.waitForTimeout(1200);
await page.locator('.react-flow__node', { hasText: 'Peak hours' }).nth(1).click().catch(() => {});
await page.waitForTimeout(500);
await shot('automation-peaks-report', 400);
const note = await ui(() => [...document.querySelectorAll('.st-node-note')].map((x) => x.textContent).join(' | '));
check('peak hours node says what it found', /Line \S+: \d\d:\d\d–\d\d:\d\d/.test(note), note.slice(0, 200));

console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no page errors');
console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
await ctx.close();
rmSync(WORK, { recursive: true, force: true });
