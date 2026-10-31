// Automation QA screenshots: the grouped template gallery, a trigger's live status and its
// "When it may fire" settings, and two of the new starter workflows. From a genuinely simulated
// company: the script plays the game on and drives the real UI. The one custom workflow
// ("Reputation slipping") watches reputation below the next round ten above it at the time, so
// its trigger is building up in the shot; the caption in the progress notes says so.
// Run `node scripts/capture-network.mjs sim` first (it simulates a company and saves), with the
// dev server on port 5182, then:
//
//   NC_PROFILE=<same profile> node scripts/capture-triggers.mjs
import { chromium } from 'playwright';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://localhost:5182/';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots/network-control';
const SRC = process.env.NC_PROFILE || join(tmpdir(), 'pt-network-control-profile');
const WORK = join(tmpdir(), 'pt-triggers-profile');
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

// ───────────────────────── 1. the end of the next weekday morning peak, with the new workflows switched on
const setup = await ui(async () => {
  const g = window.__game;
  const { fromTemplate } = await import('/src/game/automation/templates.ts');
  const { defaultConfig } = await import('/src/game/automation/registry.ts');
  const DAY = 86400, H = 3600;
  // next weekday, 08:40
  let d = Math.floor(g.t / DAY) + 1;
  while (((g.state.clock.startWeekday + d) % 7) >= 5) d++;
  g.run(d * DAY + 8 * H + 40 * 60 - g.t);
  const ids = {};
  for (const id of ['short-of-buses', 'unreliable-line', 'stop-overflow', 'reputation-guard', 'weekly-report', 'morning-briefing', 'rebalance']) {
    const r = fromTemplate(g, id);
    ids[id] = r.ok ? r.value : r.error;
    if (r.ok) g.updateWorkflow(r.value, { enabled: true });
  }
  // a custom watch: reputation below the next round ten above it, for half an hour
  const rep = g.state.company.reputation;
  const thr = Math.ceil((rep + 1) / 10) * 10;
  const mk = (type, x, y, config = {}, label) => ({ id: g.newNodeId(), type, x, y, config: { ...defaultConfig(type), ...config }, label });
  const t = mk('trigger.watch', 80, 120, { figure: 'company.reputation', op: 'below', value: thr, for: 30, from: 6, to: 22 });
  const n = mk('action.notify', 420, 120, { title: 'Reputation has slipped to {event.reading}', body: 'It has been below {event.threshold} for half an hour. Check missed departures and crowding in Network Control.', tone: 'warn' });
  const r = g.createWorkflow({ name: 'Reputation slipping', description: 'When reputation stays below the value for half an hour, tell me.', nodes: [t, n], edges: [{ id: 'e1', from: t.id, out: 'item', to: n.id, in: 'value' }] });
  ids.custom = r.ok ? r.value : r.error;
  if (r.ok) g.updateWorkflow(r.value, { enabled: true, mode: 'automatic' });
  g.run(12 * 60);
  g.setSpeed(0);
  g.emit('changed', 0);
  return { ids, thr, reputation: Math.round(rep * 10) / 10, time: `${Math.floor((g.t % DAY) / H)}:${String(Math.floor((g.t % H) / 60)).padStart(2, '0')}`, runs: g.state.automation.runs.slice(-6).map((x) => x.triggerLabel) };
});
console.log('  setup', JSON.stringify(setup));
check('workflows created', Object.values(setup.ids).every((v) => typeof v === 'string' && v.startsWith('w')), JSON.stringify(setup.ids));

// ───────────────────────── 2. the grouped template gallery
await ui(() => window.__ui.getState().openPanel('network'));
await page.waitForTimeout(800);
await tab('Automation');
await page.locator('.section-head', { hasText: 'Start from a template' }).getByRole('button', { name: 'Show' }).click();
await page.waitForTimeout(300);
await ui(() => { const el = document.querySelector('.st-tpl-group'); el?.scrollIntoView({ block: 'start' }); });
await shot('automation-template-groups', 500);
const heads = await ui(() => [...document.querySelectorAll('.st-tpl-head b')].map((b) => b.textContent));
check('six template groups', heads.length === 6, heads.join(' | '));

// ───────────────────────── 3. a trigger's live state and timing settings
const openWf = async (name) => {
  await tab('Automation');
  await ui((n) => { const row = [...document.querySelectorAll('.st-wf')].find((r) => r.querySelector('.st-wf-name button')?.textContent === n); row.querySelector('.st-wf-foot button').click(); }, name);
  await page.waitForSelector('.studio .react-flow__node', { timeout: 10000 });
  await page.waitForTimeout(900);
};
await openWf('Reputation slipping');
await page.locator('.react-flow__node', { hasText: 'Watch a figure' }).first().click();
await page.waitForTimeout(500);
await shot('automation-trigger-live', 400);
const live = await ui(() => document.querySelector('.st-node-live')?.textContent ?? '');
check('trigger is building up', /Building up: \d+ of 30 min/.test(live), live);
check('inspector has "When it may fire"', await ui(() => [...document.querySelectorAll('.st-sec h4')].some((h) => h.textContent === 'When it may fire')));
await page.keyboard.press('Escape');

await page.locator('.studio button', { hasText: 'Workflows' }).first().click().catch(() => {});
await page.waitForTimeout(500);
await ui(() => window.__ui.getState().setStudio({ open: false, workflow: null, peek: false }));
await page.waitForTimeout(400);
await ui(() => window.__ui.getState().openPanel('network'));
await openWf('Find out why reputation is falling');
await shot('automation-reputation-flow', 400);
const n = await page.locator('.react-flow__node').count();
check('reputation flow has eight nodes', n === 8, String(n));

await ui(() => window.__ui.getState().setStudio({ open: false, workflow: null, peek: false }));
await page.waitForTimeout(400);
await ui(() => window.__ui.getState().openPanel('network'));
await openWf('Move a bus from a quiet line to a busy one');
await shot('automation-rebalance-flow', 400);
const statuses = await ui(() => [...document.querySelectorAll('.st-node-live')].map((x) => x.textContent));
check('schedule trigger shows its next run', statuses.some((s) => /^Next \d\d:\d\d/.test(s)), statuses.join(' | '));

console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no page errors');
console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
await ctx.close();
rmSync(WORK, { recursive: true, force: true });
