// Automation Studio screenshots and interaction checks, from a genuinely simulated company.
// It reuses the save made by `scripts/capture-network.mjs sim` (a month of play, Network Control
// unlocked), creates workflows through the game's own API, lets the real simulation run, then
// drives the real UI with Playwright. Nothing is faked: proposals, runs, traces and the Lab
// comparison all come from the engine.
//
//   pnpm exec vite --port 5183 --strictPort &
//   URL=http://localhost:5183/ NC_PROFILE=<profile from the sim step> node scripts/capture-automation.mjs
import { chromium } from 'playwright';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://localhost:5183/';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots/network-control';
const SRC = process.env.NC_PROFILE || join(tmpdir(), 'pt-network-control-profile');
const WORK = join(tmpdir(), 'pt-automation-profile');
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
const shot = async (name, wait = 500) => { await page.waitForTimeout(wait); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('  shot', name); };
const top = (name) => page.locator('.st-top button', { hasText: new RegExp(`^${name}$`) });

await page.goto(URL);
await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
await ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await ui(() => window.__game.setSpeed(0));
await ui(() => {
  const g = window.__game, pts = Object.values(g.state.stops).map((s) => s.lngLat);
  const w = Math.min(...pts.map((p) => p[0])), e = Math.max(...pts.map((p) => p[0])), s = Math.min(...pts.map((p) => p[1])), n = Math.max(...pts.map((p) => p[1]));
  window.__map.fitBounds([[w, s], [e, n]], { padding: { left: 720, right: 420, top: 120, bottom: 90 }, maxZoom: 16, duration: 0, pitch: 48 });
});

// ───────────────────────── set up the company's workflows through the game's API
const setup = await ui(async () => {
  const g = window.__game;
  const { fromTemplate } = await import('/src/game/automation/templates.ts');
  const out = {};
  // a spare bus in the depot, so "find a free bus" has something to find
  const depot = Object.keys(g.state.depots)[0];
  const buy = g.buyVehicle('mini8', depot);
  out.spare = buy.ok ? 'bought' : buy.error;
  // A: the crowding template exactly as shipped (Observe mode, 80% threshold)
  const a = fromTemplate(g, 'crowding');
  // B: the same graph with a low threshold, because this demo company is quiet (1% instead of 80%), in Suggest mode
  const b = fromTemplate(g, 'crowding');
  const wb = g.state.automation.workflows[b.value];
  const cmp = wb.nodes.find((n) => n.type === 'logic.compare');
  g.updateWorkflow(b.value, {
    name: 'Extra bus when a line is busy (1% test threshold)',
    nodes: wb.nodes.map((n) => (n.id === cmp.id ? { ...n, label: 'More than 1% full?', config: { ...n.config, b: 1 } } : n)),
    mode: 'suggest', enabled: true,
  });
  const late = fromTemplate(g, 'late');
  g.updateWorkflow(late.value, { enabled: true });
  const daily = fromTemplate(g, 'daily');
  g.updateWorkflow(daily.value, { enabled: true });
  out.ids = { a: a.value, b: b.value, late: late.value, daily: daily.value };
  // let the real simulation run until a suggestion is waiting
  for (let i = 0; i < 60; i++) {
    g.run(900);
    if (g.state.automation.proposals.some((p) => p.status === 'open')) break;
  }
  out.proposals = g.state.automation.proposals.map((p) => [p.summary, p.status]);
  out.runs = g.state.automation.runs.length;
  out.clock = g.t;
  g.setSpeed(0);
  g.emit('changed', 0);
  return out;
});
console.log('  setup', JSON.stringify(setup));
const ID = setup.ids;
if (!setup.proposals.length) console.log('  WARNING: no proposal appeared');

// ───────────────────────── 1. the Automation tab
// the unlock card is showing on a fresh save: open Network Control from it, as a player would
await page.getByRole('button', { name: 'Open Network Control' }).click();
await page.waitForTimeout(600);
await page.locator('.nc-tabs .seg button', { hasText: 'Automation' }).click();
await page.waitForTimeout(500);
await ui(() => { document.querySelector('.p-body').scrollTop = 0; });
await shot('automation-tab', 700);

// ───────────────────────── 2. open the crowding template in the Studio
await ui(() => { document.querySelector('.p-body').scrollTop = 0; });
await ui((n) => { const row = [...document.querySelectorAll('.st-wf')].find((r) => r.querySelector('.st-wf-name button')?.textContent === n); row.querySelector('.st-wf-foot button').click(); }, 'Extra bus when a line is crowded');
await page.waitForSelector('.studio .react-flow__node', { timeout: 10000 });
await page.waitForTimeout(900);
await shot('automation-studio', 400);
check('studio opens with the template graph', (await page.locator('.react-flow__node').count()) === 6);

// ── interaction checks on this workflow (real UI)
const nodes0 = await page.locator('.react-flow__node').count();
await page.locator('.st-lib-item', { hasText: 'Send a notification' }).first().click();
await page.waitForTimeout(300);
check('click adds a node from the library', (await page.locator('.react-flow__node').count()) === nodes0 + 1);
check('unsaved indicator appears', await page.locator('.st-dirty').isVisible());
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
check('undo removes it', (await page.locator('.react-flow__node').count()) === nodes0);
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(300);
check('redo brings it back', (await page.locator('.react-flow__node').count()) === nodes0 + 1);
await page.keyboard.press('Control+d');
await page.waitForTimeout(300);
check('duplicate (ctrl+D) copies the selected node', (await page.locator('.react-flow__node').count()) === nodes0 + 2);
await page.keyboard.press('Delete');
await page.waitForTimeout(200);
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
check('undo back to the saved graph', (await page.locator('.react-flow__node').count()) === nodes0 && !(await page.locator('.st-dirty').count()) );

// drag-connect: refused connection explains why (boolean result into a line input is not allowed)
const handle = (nodeText, side, port) => page.locator('.react-flow__node', { hasText: nodeText }).first().locator(`.react-flow__handle.${side === 'out' ? 'source' : 'target'}`, { has: page.locator('xpath=.') }).nth(port);
const box = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
// drag the compare node's yes/no result (Result) onto the "Line" input of "Find a free bus": a type mismatch, refused with a reason
const cmpNode = page.locator('.react-flow__node', { hasText: 'More than 80% full?' }).first();
const findNode = page.locator('.react-flow__node', { hasText: 'Find a free bus' }).first();
const p1 = await box(cmpNode.locator('.react-flow__handle.source').first()), p2 = await box(findNode.locator('.react-flow__handle.target').first());
await page.mouse.move(p1.x, p1.y); await page.mouse.down(); await page.mouse.move((p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 80, { steps: 6 }); await page.mouse.move(p2.x, p2.y, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(300);
const hintText = await page.locator('.st-hintbar').textContent().catch(() => '');
check('a refused connection says why', /cannot go|already has a connection|loop/.test(hintText ?? ''), JSON.stringify(hintText));
check('and nothing was added', !(await page.locator('.st-dirty').count()));

// ───────────────────────── 3. library search
await page.locator('.st-search input').fill('bus');
await page.waitForTimeout(300);
await page.locator('.react-flow__node', { hasText: 'More than 80% full?' }).click({ position: { x: 100, y: 16 } });
await shot('automation-library-search', 400);
check('library search filters nodes', (await page.locator('.st-lib-item').count()) < 40);
await page.locator('.st-search input').fill('');

// ───────────────────────── 4. validation: remove a connection
const midOfFirstEdgeTo = (target) => ui((t) => {
  const edges = [...document.querySelectorAll('.react-flow__edge')];
  const el = edges.find((e) => e.getAttribute('aria-label')?.includes(t)) ?? edges[0];
  const path = el.querySelector('.react-flow__edge-interaction') ?? el.querySelector('path');
  const p = path.getPointAtLength(path.getTotalLength() / 2);
  const bb = path.getBBox(), r = path.getBoundingClientRect();
  return { x: r.left + ((p.x - bb.x) / (bb.width || 1)) * r.width, y: r.top + ((p.y - bb.y) / (bb.height || 1)) * r.height };
}, target);
const pt = await midOfFirstEdgeTo('n5');
await page.mouse.click(pt.x, pt.y);
await page.keyboard.press('Delete');
await page.waitForTimeout(400);
check('deleting a connection raises a problem', await page.locator('.st-issuebtn.bad').isVisible());
await page.locator('.st-issuebtn').click();
await shot('automation-validation', 400);
await page.keyboard.press('Escape');
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
check('undo restores the connection', await page.locator('.st-issuebtn.good').isVisible());

// ───────────────────────── 5. group, save, rename (on A)
await page.keyboard.press('Control+a');
await page.keyboard.press('Control+g');
await page.waitForTimeout(300);
check('group frame created', (await page.locator('.st-group').count()) === 1);
await page.locator('#st-g').fill('Crowding check');
await page.keyboard.press('Control+s');
await page.waitForTimeout(400);
check('save commits the group and name', await ui((id) => { const w = window.__game.state.automation.workflows[id]; return w.groups.length === 1 && w.groups[0].label === 'Crowding check' && w.nodes.every((n) => n.group === w.groups[0].id); }, ID.a));

// ───────────────────────── 6. test B and show the path
await page.locator('.st-top button', { hasText: 'Workflows' }).click();
await page.waitForTimeout(300);
await ui((n) => { [...document.querySelectorAll('.st-wf')].find((r) => r.querySelector('.st-wf-name button')?.textContent === n).querySelector('.st-wf-name button').click(); }, 'Extra bus when a line is busy (1% test threshold)');
await page.waitForSelector('.react-flow__node');
await page.waitForTimeout(800);
await top('Test').click();
await page.waitForSelector('.st-run', { timeout: 8000 }).catch(async () => { await page.screenshot({ path: `${OUT}/_debug.png` }); throw new Error('no run panel'); });
await page.waitForTimeout(500);
await page.locator('.react-flow__node', { hasText: '1% full' }).first().click({ position: { x: 100, y: 16 } });
await shot('automation-test-trace', 500);
const wouldDo = await page.locator('.st-run .st-act b').first().textContent().catch(() => '');
check('test shows what it would do and changes nothing', /Would do/.test(wouldDo ?? '') && (await ui((id) => window.__game.state.automation.runs.filter((r) => r.wf === id && r.test).length, ID.b)) === 0, JSON.stringify(wouldDo));

// ───────────────────────── 7. history
await page.locator('.studio .seg button', { hasText: 'History' }).click();
await page.waitForTimeout(500);
await page.locator('.studio .st-run-row > button').first().click();
await shot('automation-history', 500);

// ───────────────────────── 8. Simulation Lab
await page.locator('.studio .seg button', { hasText: 'Simulation Lab' }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Run the Lab' }).click();
await page.waitForSelector('.st-cmp', { timeout: 120000 });
await page.waitForTimeout(500);
check('lab produced a comparison', (await page.locator('.st-cmp tbody tr').count()) === 12);
await shot('automation-lab', 400);

// ───────────────────────── Run now, new workflow and function, leaving with unsaved changes
await page.locator('.studio .seg button', { hasText: 'Editor' }).click();
await page.waitForTimeout(300);
await top('Run now').click();
await page.waitForSelector('.st-confirm');
await page.locator('.st-confirm button', { hasText: 'Run now' }).click();
await page.waitForSelector('.st-run b:has-text("Run now")');
check('Run now (saved workflow, Suggest mode) asks first and runs for real', await ui((id) => window.__game.state.automation.runs.some((r) => r.wf === id && !r.test && r.triggerLabel.startsWith('Run by hand')), ID.b));
await page.locator('.st-title input').fill('Renamed in the Studio');
await page.locator('.studio .st-top button', { hasText: 'Workflows' }).click();
check('leaving with unsaved changes asks', await page.locator('.st-confirm').isVisible());
await page.locator('.st-confirm button', { hasText: 'Discard changes' }).click();
await page.waitForTimeout(300);
check('discarding keeps the saved name', (await ui((id) => window.__game.state.automation.workflows[id].name, ID.b)).startsWith('Extra bus'));
const wfCount = await ui(() => window.__game.workflowList().length);
await page.locator('.studio').getByRole('button', { name: 'New workflow' }).click();
await page.waitForSelector('.react-flow__node');
check('a new workflow starts with a trigger placed', (await page.locator('.react-flow__node').count()) === 1 && (await ui(() => window.__game.workflowList().length)) === wfCount + 1);
await page.locator('.st-top button', { hasText: 'Workflows' }).click();
await page.waitForTimeout(300);
await page.locator('.studio').getByRole('button', { name: 'New function' }).click();
await page.waitForSelector('.react-flow__node');
check('a new function starts with input and result nodes, no triggers', (await page.locator('.react-flow__node').count()) === 2 && !(await page.locator('.st-lib-item', { hasText: 'Every few minutes' }).count()));
await page.locator('.st-top button', { hasText: 'Workflows' }).click();
await page.waitForTimeout(300);
// the same list is the home of the Studio when nothing is open
check('studio home lists the workflows', (await page.locator('.studio .st-wf').count()) === wfCount + 2);

// ───────────────────────── close
await page.getByRole('button', { name: 'Close Automation Studio' }).click();
await page.waitForTimeout(300);
check('closing a saved workflow does not ask', !(await page.locator('.st-confirm').count()));
check('studio closed', !(await page.locator('.studio').count()));
console.log(`  ${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
if (errors.length) console.log('  page errors:\n   ', [...new Set(errors)].slice(0, 10).join('\n    '));
await ctx.close();
