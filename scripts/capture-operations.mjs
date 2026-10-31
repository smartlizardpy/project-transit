// Automation QA screenshots for the control-room blocks: the gallery group, a bus held by
// "Even out bunched buses" after a real run (bus panel), a line on a temporary detour (line panel
// and map), a Wait holding a workflow (live status on the node), a test run of "Hold for people
// changing lines", and a route change waiting for approval. From a genuinely simulated company,
// driven through the real UI and the game's own commands; nothing is drawn or faked.
// Run `node scripts/capture-network.mjs sim` first (it simulates a company and saves), with the
// dev server on port 5182, then:
//
//   NC_PROFILE=<same profile> node scripts/capture-operations.mjs
import { chromium } from 'playwright';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://localhost:5182/';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots/network-control';
const SRC = process.env.NC_PROFILE || join(tmpdir(), 'pt-network-control-profile');
const WORK = join(tmpdir(), 'pt-operations-profile');
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

// ───────────────────────── 1. the next weekday at 07:30, with the control-room workflows created
const setup = await ui(async () => {
  const g = window.__game;
  const { fromTemplate, TEMPLATES } = await import('/src/game/automation/templates.ts');
  const DAY = 86400, H = 3600;
  let d = Math.floor(g.t / DAY) + 1;
  while (((g.state.clock.startWeekday + d) % 7) >= 5) d++;
  g.run(d * DAY + 6 * H - g.t);
  // a busier line for the control-room shots, set up as the player would: line 1 every 3 minutes
  // from 06:00 to 10:00, with the buses that needs bought (expanding the depot if it is full) and
  // assigned, then 90 minutes of service so they spread out along it
  const l1 = Object.values(g.state.routes).sort((a, b) => b.vehicles.length - a.vehicles.length)[0];
  const tt = structuredClone(l1.timetable);
  tt.weekday.bands = [...tt.weekday.bands.filter((b) => b.to <= 360 || b.from >= 600), { from: 360, to: 600, headway: 3 }];
  for (const b of tt.weekday.bands) { if (b.from < 360 && b.to > 360) b.to = 360; if (b.from < 600 && b.to > 600) b.from = 600; }
  window.__tt = { id: l1.id, tt: structuredClone(l1.timetable) };
  const ttOk = g.setTimetable(l1.id, tt);
  const model = g.state.vehicles[l1.vehicles[0]]?.model ?? 'city12';
  const depot = g.state.vehicles[l1.vehicles[0]]?.depot ?? Object.keys(g.state.depots)[0];
  const need = g.requirement(l1.id)?.peak ?? 0;
  const bought = [], why = [];
  for (let i = 0; l1.vehicles.length < need && i < 16; i++) {
    let b = g.buyVehicle(model, depot);
    if (!b.ok && /is full/.test(b.error)) { const e = g.expandDepot(depot); if (!e.ok) why.push(e.error); b = g.buyVehicle(model, depot); }
    if (!b.ok) { why.push(b.error); break; }
    g.assignVehicle(b.value, l1.id);
    bought.push(b.value);
  }
  g.run(d * DAY + 7 * H + 30 * 60 - g.t);
  const ids = {};
  for (const t of TEMPLATES.filter((x) => x.group === 'control')) {
    const r = fromTemplate(g, t.id);
    ids[t.id] = r.ok ? r.value : r.error;
  }
  g.setSpeed(0);
  g.emit('changed', 0);
  return { ids, lines: Object.values(g.state.routes).map((r) => `${r.number}:${r.vehicles.length}`), bought: bought.length, need, tt: ttOk.ok || ttOk.error, why, t: g.t };
});
console.log('  setup', JSON.stringify(setup));
check('control workflows created', Object.values(setup.ids).every((v) => typeof v === 'string' && v.startsWith('wf')), JSON.stringify(setup.ids));

// ───────────────────────── 2. the gallery group
await ui(() => window.__ui.getState().openPanel('network'));
await page.waitForTimeout(800);
await tab('Automation');
await page.locator('.section-head', { hasText: 'Start from a template' }).getByRole('button', { name: 'Show' }).click();
await page.waitForTimeout(300);
await ui(() => { const el = [...document.querySelectorAll('.st-tpl-group')].find((g) => g.textContent.includes('Control room')); el?.scrollIntoView({ block: 'start' }); });
await shot('automation-control-gallery', 500);
check('control room group in the gallery', await ui(() => [...document.querySelectorAll('.st-tpl-head b')].some((b) => b.textContent === 'Control room')));
await ui(() => window.__ui.getState().openPanel(null));

// ───────────────────────── 3. a route change waiting for approval
const proposed = await ui(async () => {
  const g = window.__game;
  const { defaultConfig } = await import('/src/game/automation/registry.ts');
  const r = Object.values(g.state.routes).sort((a, b) => b.stops.length - a.stops.length)[0];
  const make = (type, config = {}) => ({ id: g.newNodeId(), type, x: 0, y: 0, config: { ...defaultConfig(type), ...config } });
  // the stop of yours nearest to the line that it does not call at
  const on = new Set([...r.stops, ...(r.returnStops ?? [])]);
  const pts = [...on].map((id) => g.state.stops[id].lngLat);
  const d = (a, b) => Math.hypot((a[0] - b[0]) * 84000, (a[1] - b[1]) * 111000);
  const cand = Object.values(g.state.stops).filter((s) => !on.has(s.id)).map((s) => ({ s, m: Math.min(...pts.map((p) => d(p, s.lngLat))) })).sort((a, b) => a.m - b.m)[0];
  if (!cand) return { error: 'every stop is on the line' };
  const t = make('trigger.manual');
  const st = make('data.stop', { stop: cand.s.id });
  const p = make('action.proposeRoute', { op: 'add_stop', line: r.id });
  const wf = g.createWorkflow({ name: 'Suggest a stop for line ' + r.number, nodes: [t, st, p], edges: [{ id: 'e1', from: t.id, out: 'event', to: p.id, in: 'when' }, { id: 'e2', from: st.id, out: 'stop', to: p.id, in: 'stop' }], kind: 'workflow' });
  g.updateWorkflow(wf.value, { enabled: true, mode: 'automatic', allowHighImpact: true });
  g.runWorkflowNow(wf.value, { test: false });
  const run = g.state.automation.runs.filter((x) => x.wf === wf.value).at(-1);
  g.emit('changed', 0);
  return { line: r.number, stop: cand.s.name, metres: Math.round(cand.m), actions: run.actions.map((a) => `${a.outcome}: ${a.summary} (${a.reason ?? ''})`), open: g.state.automation.proposals.filter((x) => x.status === 'open').length };
});
console.log('  proposed', JSON.stringify(proposed));
await ui(() => window.__ui.getState().openPanel('network'));
await page.waitForTimeout(800);
await tab('Automation');
await shot('automation-control-proposal', 500);
const prop = await ui(() => [...document.querySelectorAll('.st-prop')].map((x) => x.textContent).find((t) => /Add .* to line/.test(t)) ?? '');
check('route change waits for approval', /expires in (7\d|6\d) h/.test(prop) && /km/.test(prop), prop.slice(0, 300));
await ui(() => window.__ui.getState().openPanel(null));

// ───────────────────────── 4. bunched buses evened out by a real run
const held = await ui(async () => {
  const g = window.__game;
  const { runCommand } = await import('/src/game/commands.ts');
  const { lineGaps } = await import('/src/game/automation/ops.ts');
  const wf = Object.values(g.state.automation.workflows).find((w) => w.name === 'Even out bunched buses');
  // this company's lines take about 5 minutes end to end, so react after 1 minute of bunching
  // rather than the template's 3 (the setting on the trigger, as a player would change it)
  const nodes = wf.nodes.map((n) => (n.type === 'trigger.bunching' ? { ...n, config: { ...n.config, for: 1 } } : n));
  g.updateWorkflow(wf.id, { enabled: true, mode: 'automatic', nodes });
  // hold a bus early in its trip long enough for the bus behind to catch up
  // wait (minute by minute, at most 90) until a line has two buses going the same way
  let pick = null, lead = null;
  for (let i = 0; i < 90 && !lead; i++) {
    const lines = Object.values(g.state.routes).map((r) => ({ r, gp: lineGaps(g, r.id) }));
    pick = lines.find((x) => x.gp.buses.some((b) => b.run.v.stopIdx === 1 && b.run.v.status === "in_service" && b.run.p.stops.length >= 5)) ?? null;
    lead = pick?.gp.buses.find((b) => b.run.v.stopIdx === 1 && b.run.v.status === "in_service" && b.run.p.stops.length >= 5) ?? null;
    if (!lead) g.run(60);
  }
  if (!lead) return { error: 'no line with two buses in one direction' };
  const r = runCommand(g, { type: 'hold_vehicle', vehicle: lead.run.v.id, minutes: 7 }, 'player');
  let found = null;
  for (let i = 0; i < 40 && !found; i++) {
    g.run(30);
    found = Object.values(g.state.vehicles).find((v) => v.hold && v.hold.src === wf.id && v.trip === v.hold.trip);
  }
  g.setSpeed(0);
  if (found) window.__ui.getState().select({ kind: 'vehicle', id: found.id });
  g.emit('changed', 0);
  const runs = g.state.automation.runs.filter((x) => x.wf === wf.id && !x.test);
  return { line: pick.r.number, lead: lead.run.v.fleetNo, ok: r.ok, bus: found?.fleetNo ?? null, hold: found?.hold ?? null, runs: runs.length, actions: runs.flatMap((x) => x.actions.map((a) => `${a.outcome}: ${a.summary} (${a.reason ?? ""})`)).slice(0, 4) };
});
console.log('  held', JSON.stringify(held));
await page.waitForTimeout(800);
if (held.bus) await ui(async () => { const { focusVehicle } = await import('/src/ui/camera.ts'); const id = window.__ui.getState().selection?.id; if (id) { focusVehicle(id); } });
await shot('automation-control-hold', 600);
const holdNote = await ui(() => [...document.querySelectorAll('.issue')].map((x) => x.textContent).find((t) => /Will wait|Held at/.test(t)) ?? '');
check('bus panel shows the hold and who asked', /Asked by “Even out bunched buses”/.test(holdNote), holdNote);

// ───────────────────────── 5. a temporary detour on a line
const detour = await ui(async () => {
  const g = window.__game;
  const { runCommand } = await import('/src/game/commands.ts');
  const { detourPlan } = await import('/src/game/operations.ts');
  // back to the line's usual timetable first, as the player would after the morning test
  if (window.__tt) g.setTimetable(window.__tt.id, window.__tt.tt);
  // every stretch where a detour is possible; show the shortest way round, the usual kind
  const G = g.region.graph;
  const options = [];
  for (const r of Object.values(g.state.routes)) for (const pat of [0, 1]) {
    const p = g.pattern(r.id, pat);
    if (!p) continue;
    for (let leg = 0; leg + 1 < p.stops.length; leg++) {
      const n = p.path.nodes[Math.round((p.stopIdx[leg] + p.stopIdx[leg + 1]) / 2)];
      const at = g.geo.P.toLngLat(G.x[n], G.y[n]);
      const plan = detourPlan(g, r.id, at, 120, 120);
      if (plan.ok) options.push({ r, at, extra: Math.max(...plan.value.legs.map((l) => l.extra)) });
    }
  }
  options.sort((a, b) => Math.abs(a.extra - 90) - Math.abs(b.extra - 90));
  const o = options[0];
  if (!o) return { error: 'no stretch with another way round' };
  const res = runCommand(g, { type: 'detour', route: o.r.id, at: o.at, radius: 120, minutes: 120, why: 'road works' }, 'player');
  for (let i = 0; i < 30 && (g.state.detours ?? []).some((d) => d.route === o.r.id && d.state === 'start'); i++) g.run(30);
  g.setSpeed(0);
  window.__ui.getState().select({ kind: 'line', id: o.r.id });
  g.emit('changed', 0);
  return { line: o.r.number, id: o.r.id, options: options.length, extra: o.extra, ok: res.ok, text: res.ok ? res.value.effect : res.error, states: (g.state.detours ?? []).map((d) => d.state) };
});
console.log('  detour', JSON.stringify(detour));
await page.waitForTimeout(800);
if (detour.id) await ui(async (id) => { const { focusLine } = await import('/src/ui/camera.ts'); focusLine(id); }, detour.id);
await shot('automation-control-detour', 900);
const detourNote = await ui(() => [...document.querySelectorAll('.issue')].map((x) => x.textContent).find((t) => /temporary detour/.test(t)) ?? '');
check('line panel shows the detour', /On a temporary detour until \d\d:\d\d \(road works\)/.test(detourNote), detourNote);
await ui(() => window.__ui.getState().select(null));

// ───────────────────────── 6. a Wait holding a workflow, shown live on the node
const waiting = await ui(async () => {
  const g = window.__game;
  const { defaultConfig } = await import('/src/game/automation/registry.ts');
  const busiest = Object.values(g.state.routes).sort((a, b) => b.vehicles.length - a.vehicles.length)[0];
  const make = (type, x, y, config = {}, label) => ({ id: g.newNodeId(), type, x, y, config: { ...defaultConfig(type), ...config }, label });
  const t = make('trigger.manual', 80, 120);
  const line = make('data.line', 380, 120, { line: busiest.id });
  const w = make('logic.wait', 680, 120, { mode: 'minutes', minutes: 30 }, 'Check again in 30 min');
  const occ = make('math.field', 980, 40, { field: 'waiting' });
  const yes = make('action.report', 1280, 40, { text: '{value} people waiting for line ' + busiest.number + ' half an hour later' });
  const edges = [
    { id: 'e1', from: t.id, out: 'event', to: line.id, in: 'after' },
    { id: 'e2', from: line.id, out: 'line', to: w.id, in: 'value' },
    { id: 'e3', from: w.id, out: 'then', to: occ.id, in: 'record' },
    { id: 'e4', from: occ.id, out: 'value', to: yes.id, in: 'value' },
  ];
  const r = g.createWorkflow({ name: 'Check back on the busiest line', nodes: [t, line, w, occ, yes], edges, kind: 'workflow' });
  g.updateWorkflow(r.value, { enabled: true, mode: 'automatic' });
  g.runWorkflowNow(r.value, { test: false });
  g.run(120);
  g.setSpeed(0);
  g.emit('changed', 0);
  const run = g.state.automation.runs.filter((x) => x.wf === r.value).at(-1);
  return { line: busiest.number, pending: (g.state.automation.pending ?? []).filter((p) => p.wf === r.value).length, note: run.trace?.find((x) => x.node === w.id)?.note ?? '' };
});
console.log('  waiting', JSON.stringify(waiting));
await openWf('Check back on the busiest line');
await page.locator('.react-flow__node', { hasText: 'Check again in 30 min' }).first().click().catch(() => {});
await page.waitForTimeout(600);
await shot('automation-control-wait', 400);
const live = await ui(() => [...document.querySelectorAll('.st-node-live')].map((x) => x.textContent));
check('Wait node shows what it is holding', live.some((x) => /1 waiting · next \d\d:\d\d \(Line/.test(x)), JSON.stringify(live));
await closeStudio();

// ───────────────────────── 7. a test run of "Hold for people changing lines"
await openWf('Hold for people changing lines');
await page.locator('.studio button', { hasText: 'Test' }).first().click();
await page.waitForTimeout(1500);
await page.locator('.react-flow__node', { hasText: 'Connections at risk' }).first().click().catch(() => {});
await page.waitForTimeout(500);
await shot('automation-control-connections', 400);
const cn = await notes();
console.log('  connections notes:', JSON.stringify(cn).slice(0, 700));
check('connections block says what it found', cn.some((x) => /connections?,|No connection/.test(x)));
await closeStudio();

console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no page errors');
console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
await ctx.close();
rmSync(WORK, { recursive: true, force: true });
