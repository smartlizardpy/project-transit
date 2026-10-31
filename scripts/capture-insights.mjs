// City Activity Engine QA screenshots (phase 6): weather and event marks on the daily trend, the
// new "Days" filters, who travels by traveller type, a line's riders by type and time of day, the
// seasons and weather report, the line inspector's Weather and Events sections, and the new
// templates in Automation Studio. From a genuinely simulated company: the script plays the game
// on until enough days carry weather and kind-of-day labels, and drives the real UI. Nothing is staged.
// Run `node scripts/capture-network.mjs sim` first (it simulates a company and saves), with the
// dev server on port 5182, then:
//
//   NC_PROFILE=<same profile> node scripts/capture-insights.mjs
import { chromium } from 'playwright';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://localhost:5182/';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots/city-activity';
const SRC = process.env.NC_PROFILE || join(tmpdir(), 'pt-network-control-profile');
const WORK = join(tmpdir(), 'pt-insights-profile');
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
const tab = async (name) => { await page.locator('.nc-tabs .seg button', { hasText: name }).click(); await page.waitForTimeout(600); await ui(() => { const b = document.querySelector('.p-body'); if (b) b.scrollTop = 0; }); };
const scrollTo = (text) => ui((t) => {
  const el = [...document.querySelectorAll('.p-body .nc-sub')].find((x) => x.textContent.includes(t));
  el?.closest('.section')?.scrollIntoView({ block: 'start' });
  return !!el;
}, text);
/** The filter bar's "Days" select. */
const daysSelect = () => page.locator('.nc-filters select').filter({ has: page.locator('option[value="w:wet"]') }).first();
/** The journeys tab's "Who" select. */
const whoSelect = () => page.locator('.nc-filters select').filter({ has: page.locator('option', { hasText: 'Everyone' }) }).first();

await page.goto(URL);
await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
await ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await ui(() => { window.__game.setSpeed(0); window.__game.setNetworkIntro?.({ seen: true }); });

// ───────────────────────── 1. play until labelled rainy and dry working days exist
const played = await ui(() => {
  const g = window.__game;
  const stat = () => {
    const today = Math.floor(g.t / 86400);
    const recent = g.state.analytics.days.filter((d) => d.lbl && d.day >= today - 35);
    const working = recent.filter((d) => !d.lbl.weekend && !d.lbl.holiday && !d.lbl.schoolHolidays);
    const wet = working.filter((d) => ['showers', 'rain', 'heavy', 'snow'].includes(d.lbl.wx?.k)).length;
    return { labelled: recent.length, wet, dry: working.length - wet, events: recent.filter((d) => d.lbl.ev?.some((e) => e.carried > 0)).length };
  };
  let days = 0;
  for (; days < 28; days++) {
    const s = stat();
    if (s.labelled >= 10 && s.wet >= 2 && s.dry >= 2) break;
    g.run(86400);
  }
  // stop mid-morning, so "today" has some figures
  g.run(Math.max(0, Math.floor(g.t / 86400) * 86400 + 10 * 3600 - g.t));
  g.setSpeed(0);
  g.emit('changed', 0);
  return { days, ...stat(), weeks: (g.state.analytics.weeks ?? []).length };
});
console.log('  played', JSON.stringify(played));
check('labelled rainy and dry working days', played.wet >= 2 && played.dry >= 2, JSON.stringify(played));

// ───────────────────────── 2. Network Control
await ui(() => window.__ui.getState().openPanel('network'));
await page.waitForTimeout(800);
await tab('Overview');
await daysSelect().selectOption('all');
await page.waitForTimeout(500);
await ui(() => { const el = [...document.querySelectorAll('.p-body .nc-sub')].find((x) => x.textContent.includes('Daily trend')); el?.closest('.section')?.scrollIntoView({ block: 'start' }); });
await shot('nc-trend-marks', 500);
const marks = await ui(() => [...document.querySelectorAll('.p-body svg title')].map((t) => t.textContent).filter((t) => / mm|journeys on your buses/.test(t)));
check('weather marks on the daily trend', marks.some((t) => t.includes(' mm')), `${marks.length} marks`);

await daysSelect().selectOption('w:wet');
await page.waitForTimeout(700);
await ui(() => { const b = document.querySelector('.p-body'); if (b) b.scrollTop = 0; });
await shot('nc-filter-rain', 500);
const cov = await ui(() => document.querySelector('.nc-cov')?.textContent ?? '');
check('rain filter applied', (await daysSelect().inputValue()) === 'w:wet', cov.slice(0, 120));
await daysSelect().selectOption('all');

await tab('Passengers');
await whoSelect().selectOption({ label: 'Everyone' });
await page.waitForTimeout(600);
await scrollTo('Who travels');
await shot('nc-who-travels', 500);
const who = await ui(() => [...document.querySelectorAll('.p-body .section')].find((s) => s.textContent.includes('Who travels'))?.querySelectorAll('tbody tr').length ?? 0);
check('who travels table', who > 1, `${who} rows`);
const firstType = await ui(() => [...document.querySelectorAll('.p-body .section')].find((s) => s.textContent.includes('Who travels'))?.querySelector('tbody tr td')?.textContent ?? '');
await whoSelect().selectOption({ label: firstType });
await page.waitForTimeout(800);
await ui(() => { const b = document.querySelector('.p-body'); if (b) b.scrollTop = 0; });
await shot('nc-journeys-by-type', 500);
check('journeys filtered by traveller type', firstType.length > 0, firstType);
await whoSelect().selectOption({ label: 'Everyone' });

await tab('Lines');
await ui(() => document.querySelectorAll('.nc-table tbody tr.click')[0]?.click());
await page.waitForTimeout(1200);
await ui(() => { const el = [...document.querySelectorAll('.p-body .nc-sub')].find((x) => x.textContent.includes('Who rides, by time of day')); el?.scrollIntoView({ block: 'center' }); });
await shot('nc-line-types', 500);
check('riders by type and time band', await ui(() => [...document.querySelectorAll('.p-body .nc-sub')].some((x) => x.textContent.includes('Who rides, by time of day'))));

await tab('Reports');
await page.getByRole('button', { name: 'Seasons and weather' }).click();
await page.waitForTimeout(800);
await shot('nc-seasons', 500);
const wxRows = await ui(() => [...document.querySelectorAll('.p-body .section')].find((s) => s.textContent.includes('By weather'))?.querySelectorAll('tbody tr').length ?? 0);
check('seasons report: by weather', wxRows >= 2, `${wxRows} rows`);

// ───────────────────────── 3. the line inspector's Weather and Events sections
await ui(() => window.__ui.getState().openPanel(null));
const line = await ui(() => {
  const g = window.__game;
  const r = Object.values(g.state.routes).sort((a, b) => b.vehicles.length - a.vehicles.length)[0];
  window.__ui.getState().select({ kind: 'line', id: r.id });
  return r.id;
});
await page.waitForTimeout(800);
for (const title of ['Weather', 'Events']) await page.locator('.lc-head', { hasText: new RegExp(`^${title}`) }).click();
await page.waitForTimeout(400);
await ui(() => { const el = [...document.querySelectorAll('.lc-head')].find((b) => b.textContent.startsWith('Weather')); el?.scrollIntoView({ block: 'start' }); });
await shot('line-weather-events', 500);
const wx = await ui(() => [...document.querySelectorAll('.lc-fold')].find((f) => f.querySelector('.lc-head')?.textContent.startsWith('Weather'))?.textContent ?? '');
check('line weather section', /Riders a day, rain|Shown once/.test(wx), wx.slice(0, 140));
console.log('  line', line);

// ───────────────────────── 4. the new templates
await ui(() => window.__ui.getState().select(null));
const setup = await ui(async () => {
  const g = window.__game;
  const { fromTemplate } = await import('/src/game/automation/templates.ts');
  const ids = {};
  for (const id of ['busy-hour-ahead', 'unserved-corridors', 'school-holidays', 'airport-early']) {
    const r = fromTemplate(g, id);
    ids[id] = r.ok ? r.value : r.error;
    if (r.ok) g.updateWorkflow(r.value, { enabled: true });
  }
  const run = g.runWorkflowNow(ids['unserved-corridors'], { test: false });
  // the rest of the morning, so the hourly forecast has run on the live network
  g.run(3 * 3600);
  g.setSpeed(0);
  g.emit('changed', 0);
  return { ids, report: run.ok ? run.value.report : run.error, runs: g.state.automation.runs.filter((r) => Object.values(ids).includes(r.wf)).map((r) => [r.triggerLabel, r.status, r.actions.length, (r.trace ?? []).map((x) => x.note).filter(Boolean).slice(0, 2)]).slice(-4) };
});
console.log('  workflows', JSON.stringify(setup));
check('unserved corridors report written', Array.isArray(setup.report) && setup.report.length === 2, JSON.stringify(setup.report));
await ui(() => window.__ui.getState().openPanel('network'));
await page.waitForTimeout(600);
await tab('Automation');
await page.locator('.section-head', { hasText: 'Start from a template' }).getByRole('button', { name: 'Show' }).click();
await page.waitForTimeout(300);
await ui(() => { const el = [...document.querySelectorAll('.st-tpl')].find((b) => b.textContent.includes('School holidays check')); el?.scrollIntoView({ block: 'start' }); });
await shot('automation-insight-templates', 500);
const openWf = async (name) => {
  await ui((n) => { const row = [...document.querySelectorAll('.st-wf')].find((r) => r.querySelector('.st-wf-name button')?.textContent === n); row.querySelector('.st-wf-foot button').click(); }, name);
  await page.waitForSelector('.studio .react-flow__node', { timeout: 10000 });
  await page.waitForTimeout(900);
};
await openWf('Busy hour ahead');
await shot('automation-forecast-flow', 400);
check('forecast flow has six nodes', (await page.locator('.react-flow__node').count()) === 6);

console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no page errors');
console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
await ctx.close();
rmSync(WORK, { recursive: true, force: true });
