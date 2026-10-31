// Automation QA screenshots for the blocks that let players build their own strategies: the new
// gallery group, a test run of "Predictive extra departures" (forecast, join, formula, pick,
// schedule) with what each block found, an extra departure planned by a real run of a workflow on
// the line panel, and a test run of "Where passengers travel". From a genuinely simulated company,
// driven through the real UI; nothing is drawn or faked.
// Run `node scripts/capture-network.mjs sim` first (it simulates a company and saves), with the
// dev server on port 5182, then:
//
//   NC_PROFILE=<same profile> node scripts/capture-programming.mjs
import { chromium } from 'playwright';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://localhost:5182/';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots/network-control';
const SRC = process.env.NC_PROFILE || join(tmpdir(), 'pt-network-control-profile');
const WORK = join(tmpdir(), 'pt-programming-profile');
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
const closeStudio = async () => {
  await ui(() => window.__ui.getState().setStudio({ open: false, workflow: null, peek: false }));
  await page.waitForTimeout(400);
};
const openWf = async (name) => {
  await ui(() => window.__ui.getState().openPanel('network'));
  await page.waitForTimeout(600);
  await tab('Automation');
  await ui((n) => { const row = [...document.querySelectorAll('.st-wf')].find((r) => r.querySelector('.st-wf-name button')?.textContent === n); row.querySelector('.st-wf-foot button').click(); }, name);
  await page.waitForSelector('.studio .react-flow__node', { timeout: 10000 });
  await page.waitForTimeout(900);
};
const notes = () => ui(() => [...document.querySelectorAll('.st-node-note')].map((x) => x.textContent));

await page.goto(URL);
await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
await ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await ui(() => { window.__game.setSpeed(0); window.__game.setNetworkIntro?.({ seen: true }); });

// ───────────────────────── 1. the next weekday at 06:00, with the new workflows created
const setup = await ui(async () => {
  const g = window.__game;
  const { fromTemplate } = await import('/src/game/automation/templates.ts');
  const DAY = 86400, H = 3600;
  let d = Math.floor(g.t / DAY) + 1;
  while (((g.state.clock.startWeekday + d) % 7) >= 5) d++;
  g.run(d * DAY + 6 * H - g.t);
  const ids = {};
  for (const id of ['forecast-extra', 'unusual-stops', 'unusual-line-extra', 'journeys-report', 'free-by-depot', 'peak-extra']) {
    const r = fromTemplate(g, id);
    ids[id] = r.ok ? r.value : r.error;
  }
  g.setSpeed(0);
  g.emit('changed', 0);
  return { ids, recordedDays: g.state.analytics.days.length, lines: Object.keys(g.state.routes).length, spares: Object.values(g.state.vehicles).filter((v) => v.route === null).length };
});
console.log('  setup', JSON.stringify(setup));
check('workflows created', Object.values(setup.ids).every((v) => typeof v === 'string' && v.startsWith('wf')), JSON.stringify(setup.ids));

// ───────────────────────── 2. the gallery group
await ui(() => window.__ui.getState().openPanel('network'));
await page.waitForTimeout(800);
await tab('Automation');
await page.locator('.section-head', { hasText: 'Start from a template' }).getByRole('button', { name: 'Show' }).click();
await page.waitForTimeout(300);
await ui(() => { const el = [...document.querySelectorAll('.st-tpl-group')].find((g) => g.textContent.includes('Forecasts, normal days and journeys')); el?.scrollIntoView({ block: 'start' }); });
await shot('automation-programming-gallery', 500);
check('new group in the gallery', await ui(() => [...document.querySelectorAll('.st-tpl-head b')].some((b) => b.textContent === 'Forecasts, normal days and journeys')));

// ───────────────────────── 3. a test run of the predictive workflow
await openWf('Predictive extra departures');
await page.locator('.studio button', { hasText: 'Test' }).first().click();
await page.waitForTimeout(1500);
await page.locator('.react-flow__node', { hasText: 'Join lists' }).first().click().catch(() => {});
await page.waitForTimeout(500);
await shot('automation-programming-predictive', 400);
const pn = await notes();
console.log('  predictive notes:', JSON.stringify(pn).slice(0, 900));
check('join says what it matched', pn.some((x) => /matched on id = id/.test(x)));
check('forecast says what it expects', pn.some((x) => /^Estimate: about/.test(x)));
await closeStudio();

// ───────────────────────── 4. a real run plans an extra; the line panel lists it
const planned = await ui(async () => {
  const g = window.__game;
  const { defaultConfig } = await import('/src/game/automation/registry.ts');
  const wf = Object.values(g.state.automation.workflows).find((w) => w.name === 'Predictive extra departures');
  g.updateWorkflow(wf.id, { enabled: true, mode: 'automatic' });
  g.runWorkflowNow(wf.id, { test: false });
  const run = g.state.automation.runs.filter((r) => r.wf === wf.id && !r.test).at(-1);
  let by = 'Predictive extra departures', actions = run.actions.map((a) => `${a.outcome}: ${a.summary}${a.reason ? ` (${a.reason})` : ''}`);
  let line = Object.values(g.state.routes).find((r) => g.scheduledExtras(r.id).length);
  if (!line) {
    // the forecast found no line over 90%: plan one with the block directly, from a manual run
    const busiest = Object.values(g.state.routes).sort((a, b) => b.vehicles.length - a.vehicles.length)[0];
    const make = (type, config) => ({ id: g.newNodeId(), type, x: 0, y: 0, config });
    const t = make('trigger.manual', {});
    const x = make('action.scheduleExtra', { ...defaultConfig('action.scheduleExtra'), line: busiest.id, mode: 'in', minutes: 45, shift: 0, dir: 'auto', time: '17:00' });
    const r = g.createWorkflow({ name: 'Plan an extra departure', nodes: [t, x], edges: [{ id: 'e1', from: t.id, out: 'event', to: x.id, in: 'when' }], kind: 'workflow' });
    g.updateWorkflow(r.value, { enabled: true, mode: 'automatic' });
    g.runWorkflowNow(r.value, { test: false });
    by = 'Plan an extra departure';
    actions = actions.concat(g.state.automation.runs.filter((q) => q.wf === r.value).at(-1).actions.map((a) => `${a.outcome}: ${a.summary}`));
    line = busiest;
  }
  g.setSpeed(0);
  window.__ui.getState().select({ kind: 'line', id: line.id });
  g.emit('changed', 0);
  return { line: line.number, by, actions, extras: g.scheduledExtras(line.id).map((x) => x.dep) };
});
console.log('  planned', JSON.stringify(planned));
await page.waitForTimeout(800);
await ui(() => { const el = [...document.querySelectorAll('.label')].find((x) => x.textContent === 'Extra departures planned'); el?.scrollIntoView({ block: 'center' }); });
await shot('automation-programming-line-extras', 500);
const row = await ui(() => { const el = [...document.querySelectorAll('.label')].find((x) => x.textContent === 'Extra departures planned'); return el?.nextElementSibling?.textContent ?? ''; });
check('line panel lists the planned extra', /\d\d:\d\d/.test(row) && row.includes('Planned by “'), row);

// ───────────────────────── 5. a test run of "Where passengers travel"
await ui(() => window.__ui.getState().select(null));
await openWf('Where passengers travel');
await page.locator('.studio button', { hasText: 'Test' }).first().click();
await page.waitForTimeout(1500);
await page.locator('.react-flow__node', { hasText: 'Passenger journeys' }).first().click().catch(() => {});
await page.waitForTimeout(500);
await shot('automation-programming-journeys', 400);
const jn = await notes();
console.log('  journeys notes:', JSON.stringify(jn).slice(0, 600));
check('journeys block says what it found', jn.some((x) => /journeys a day, by area|no journeys match|No recorded journeys/.test(x)));

console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no page errors');
console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
await ctx.close();
rmSync(WORK, { recursive: true, force: true });
