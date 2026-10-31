// City Activity Engine QA screenshots (phase 5): an event announcement, the venue's place card
// and map flag, the place card after the event, service plans in the timetable editor, and the
// event and weather workflows in Automation Studio. From a genuinely simulated company: the
// script runs the simulation forward until the generated calendar announces an event, and drives
// the real UI. Nothing is staged.
// Run `node scripts/capture-network.mjs sim` first (it simulates a company and saves), with the
// dev server on port 5182, then:
//
//   NC_PROFILE=<same profile> node scripts/capture-events.mjs
import { chromium } from 'playwright';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://localhost:5182/';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots/city-activity';
const SRC = process.env.NC_PROFILE || join(tmpdir(), 'pt-network-control-profile');
const WORK = join(tmpdir(), 'pt-events-profile');
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

await page.goto(URL);
await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
await ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await ui(() => { window.__game.setSpeed(0); window.__game.setNetworkIntro?.({ seen: true }); });

// ───────────────────────── 1. run until a crowd event is announced
const found = await ui(() => {
  const g = window.__game;
  const seen = new Set(g.state.notifications.map((n) => n.id));
  for (let i = 0; i < 20 * 24; i++) {
    g.run(3600);
    const n = g.state.notifications.find((x) => !seen.has(x.id) && x.ref?.kind === 'place');
    if (!n) continue;
    // the event this notice announced (announced within the last hour)
    const ev = g.eventList().find((e) => e.place === n.ref.id && e.ann <= g.t && e.ann > g.t - 3600 && ['football', 'concert', 'festival', 'gathering'].includes(e.kind));
    if (!ev) { seen.add(n.id); continue; }
    g.setSpeed(0);
    g.emit('changed', 0);
    return { t: g.t, title: n.title, ev: { id: ev.id, kind: ev.kind, venue: ev.venue, start: ev.start, end: ev.end, people: ev.people } };
  }
  return null;
});
console.log('  announced', JSON.stringify(found));
check('a crowd event was announced within 20 days', !!found);

if (found) {
  await page.locator('.bell').click();
  await page.waitForTimeout(500);
  await shot('event-announced', 400);
  // the notification opens the venue: place card and the flag on the map
  await page.locator('.notif', { hasText: found.title }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('.notif-pop').count()) await page.locator('.bell').click();
  await shot('event-place-card', 1200);
  check('place card shows the event', (await page.locator('.inspector', { hasText: 'Coming' }).count()) > 0 || (await page.locator('text=Coming').count()) > 0);
  check('venue flag on the map', (await page.locator('.dest-mk.has-event .ev-flag').count()) > 0);

  // during the event, then after it (journeys counted two hours after the end)
  await ui((at) => { const g = window.__game; g.run(Math.max(0, at - g.t)); g.setSpeed(0); g.emit('changed', 0); }, found.ev.start + 1800);
  await shot('event-on-now', 1200);
  check('flag says on now', (await page.locator('.dest-mk.has-event .ev-flag', { hasText: 'On now' }).count()) > 0);
  await ui((at) => { const g = window.__game; g.run(Math.max(0, at - g.t)); g.setSpeed(0); g.emit('changed', 0); }, found.ev.end + 2 * 3600 + 120);
  await shot('event-after', 1200);
  const result = await ui((id) => { const e = window.__game.eventList().find((x) => x.id === id); return e ? { carried: e.carried ?? 0, lost: e.lost ?? 0 } : null; }, found.ev.id);
  console.log('  event result', JSON.stringify(result));
}

// ───────────────────────── 2. service plans in the timetable editor (made through the UI)
const line = await ui(() => {
  const g = window.__game;
  const r = Object.values(g.state.routes).sort((a, b) => b.vehicles.length - a.vehicles.length)[0];
  window.__ui.getState().select({ kind: 'route', id: r.id });
  window.__ui.getState().openModal({ kind: 'timetable', route: r.id });
  return { id: r.id, number: r.number };
});
await page.waitForTimeout(700);
await page.getByRole('button', { name: 'Add a plan' }).click();
await page.locator('.tt-presets button', { hasText: 'School holidays' }).click();
await page.getByRole('button', { name: 'Add a plan' }).click();
await page.locator('.tt-presets button', { hasText: 'Manual' }).click();
const nameInput = page.getByLabel('Plan name');
if (await nameInput.count()) { await nameInput.fill('Rain'); await nameInput.press('Enter'); }
else {
  await page.getByRole('button', { name: 'Rename Manual plan' }).click();
  await page.getByLabel('Plan name').fill('Rain');
  await page.getByLabel('Plan name').press('Enter');
}
// the rain plan: every 6 minutes all day (the "Frequent" preset)
await page.locator('.tt-toolbar button, .tt-presets button', { hasText: 'Frequent' }).first().click().catch(() => console.log('  no Frequent preset button'));
await page.waitForTimeout(400);
await shot('timetable-service-plans', 300);
await page.getByRole('button', { name: 'Save timetable' }).click();
await page.waitForTimeout(400);
const plans = await ui((id) => (window.__game.state.routes[id].timetable.plans ?? []).map((p) => [p.name, p.when.kind]), line.id);
console.log('  plans', JSON.stringify(plans));
check('plans saved on the line', plans.length === 2 && plans.some(([n]) => n === 'Rain'));

// ───────────────────────── 3. the event and weather workflows in Automation Studio
await ui(() => { window.__ui.getState().openModal(null); window.__ui.getState().select(null); });
const setup = await ui(async () => {
  const g = window.__game;
  const { fromTemplate } = await import('/src/game/automation/templates.ts');
  const ids = {};
  for (const id of ['event-crowds', 'storm-plan', 'disruption-cover', 'events-week']) {
    const r = fromTemplate(g, id);
    ids[id] = r.ok ? r.value : r.error;
    if (r.ok) g.updateWorkflow(r.value, { enabled: true });
  }
  // a day of play, so the workflows have run on real events and forecasts
  g.run(86400);
  g.setSpeed(0);
  g.emit('changed', 0);
  return { ids, runs: g.state.automation.runs.filter((r) => Object.values(ids).includes(r.wf)).map((r) => [r.triggerLabel, r.status, r.actions.length]).slice(-8) };
});
console.log('  workflows', JSON.stringify(setup));
await ui(() => window.__ui.getState().openPanel('network'));
await page.waitForTimeout(600);
await page.locator('.nc-tabs .seg button', { hasText: 'Automation' }).click();
await page.waitForTimeout(500);
await page.locator('.section-head', { hasText: 'Start from a template' }).getByRole('button', { name: 'Show' }).click();
await page.waitForTimeout(300);
await ui(() => { const el = [...document.querySelectorAll('.st-tpl')].find((b) => b.textContent.includes('Extra buses for big events')); el?.scrollIntoView({ block: 'start' }); });
await shot('automation-city-templates', 500);
const openWf = async (name) => {
  await ui((n) => { const row = [...document.querySelectorAll('.st-wf')].find((r) => r.querySelector('.st-wf-name button')?.textContent === n); row.querySelector('.st-wf-foot button').click(); }, name);
  await page.waitForSelector('.studio .react-flow__node', { timeout: 10000 });
  await page.waitForTimeout(900);
};
await openWf('Extra buses for big events');
await shot('automation-event-flow', 400);
check('event flow has six nodes', (await page.locator('.react-flow__node').count()) === 6);
await page.locator('.st-top button', { hasText: 'Workflows' }).click().catch(() => {});
await page.waitForTimeout(500);
await openWf('Rain plan when a storm is forecast');
await shot('automation-storm-flow', 400);
check('storm flow has five nodes', (await page.locator('.react-flow__node').count()) === 5);

console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no page errors');
console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
await ctx.close();
rmSync(WORK, { recursive: true, force: true });
