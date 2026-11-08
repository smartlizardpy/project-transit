// A race over real WebRTC (public Nostr relays introduce the players, so this needs the internet):
// browser A opens a race, browser B joins with the code, A starts it. Both companies must start
// level in the same city; A builds a line, the clock runs to the finish, and both must agree that A
// won. Screenshots of both screens along the way.
// Usage: node scripts/race.mjs <outDir>      (dev server: URL=http://localhost:5173/ by default)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [out = 'race-shots'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const URL = process.env.URL || 'http://localhost:5173/';
// real local addresses instead of mDNS names, so two browsers on one machine can reach each other
const args = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const step = (msg) => console.log(`\n# ${msg}`);
const fail = (msg) => {
  console.log(`FAIL: ${msg}`);
  process.exitCode = 1;
};

async function open(name) {
  const browser = await chromium.launch({ args });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/WebGL|GPU|tile/i.test(m.text()) && console.log(`[${name}] ${m.type()}: ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message}`));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__map?.loaded() && window.__ctl, null, { timeout: 60000 });
  return { browser, page };
}
const info = (page) => page.evaluate(() => {
  const g = window.__game, r = window.__race.state();
  return g ? { t: g.state.clock.t, speed: g.speed, fp: g.region.fingerprint, rng: g.state.rng, balance: g.state.finance.balance, home: g.state.territory.home, owned: g.state.territory.owned.slice().sort().join(' '), company: g.state.company.name, phase: r.phase, players: r.players.map((p) => p.name) } : { phase: r.phase };
});

step('A opens a race');
const A = await open('A');
await A.page.getByRole('button', { name: /^multiplayer/i }).click();
await A.page.getByRole('button', { name: /race a friend/i }).click();
await A.page.locator('.co-field input').fill('Ana');
await A.page.getByRole('button', { name: /open a race/i }).click();
await A.page.waitForSelector('.co-code span', { timeout: 30000 });
const code = (await A.page.locator('.co-code span').textContent()).trim();
console.log('code', code);
// races run 7 days or more; a 1-day race keeps this test short
await A.page.waitForFunction(() => !!window.__race.state().setup, null, { timeout: 30000 });
await A.page.evaluate(() => window.__race.change(window.__race.state().setup.preset, 1));

step('B joins with the code');
const B = await open('B');
await B.page.getByRole('button', { name: /^multiplayer/i }).click();
await B.page.getByRole('button', { name: /join a friend/i }).click();
await B.page.locator('.co-field input').first().fill('Ben');
await B.page.locator('.co-code-in').fill(code);
const t0 = Date.now();
await B.page.getByRole('button', { name: /^join$/i }).click();
await B.page.getByText(/You joined/).waitFor({ timeout: 90000 });
console.log(`in the lobby after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await A.page.getByText('Ben', { exact: true }).waitFor({ timeout: 10000 });
await A.page.screenshot({ path: `${out}/a-lobby.png` });
await B.page.screenshot({ path: `${out}/b-lobby.png` });

step('A starts the race');
await A.page.getByRole('button', { name: /start the race/i }).click();
await Promise.all([A, B].map((p) => p.page.waitForFunction(() => window.__game && window.__race.state().phase === 'racing', null, { timeout: 180000 })));
// the clock starts once B has the map
await A.page.waitForFunction(() => window.__race.state().waiting.length === 0 && window.__game.speed > 0, null, { timeout: 30000 });
const a0 = await info(A.page), b0 = await info(B.page);
console.log('A', a0);
console.log('B', b0);
if (a0.fp !== b0.fp) fail('different maps');
if (a0.home !== b0.home) fail('different home areas');
if (a0.owned !== b0.owned) fail('different starting areas');
if (a0.balance !== b0.balance) fail('different starting money');
if (a0.company === b0.company) fail('the same company name');

step('A builds a line; both race to the finish');
const built = await A.page.evaluate(async () => {
  const { routeWithFallback } = await import('/src/game/world/graph.ts');
  const { flatTimetable } = await import('/src/game/timetable.ts');
  const act = window.__coop.act;
  const g = window.__game, gr = g.region.graph;
  const home = g.geo.zone(g.state.territory.home);
  const owned = new Set(g.state.territory.owned);
  const [cx, cy] = g.geo.P.toXY(home.centroid[0], home.centroid[1]);
  const inOwned = (v) => owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]])?.id);
  const main = [];
  for (let e = 0; e < gr.m; e++) if (gr.cls[e] >= 2 && gr.cls[e] <= 4 && !(gr.flags[e] & 6) && inOwned(gr.ea[e])) main.push(gr.ea[e]);
  main.sort((a, b) => Math.hypot(gr.x[a] - cx, gr.y[a] - cy) - Math.hypot(gr.x[b] - cx, gr.y[b] - cy));
  let depot = null;
  for (const v of main.slice(0, 300)) { const r = await act('buildDepot', [gr.lng[v], gr.lat[v]]); if (r.ok) { depot = r.value; break; } }
  let best = null;
  for (let i = 0; i < main.length; i += 2) {
    const b = main[i], d = Math.hypot(gr.x[b] - gr.x[main[0]], gr.y[b] - gr.y[main[0]]);
    if (d < 900 || d > 1800) continue;
    const l = routeWithFallback(gr, main[0], b);
    if (!l || l.contraflow.length || l.nodes.some((v) => !inOwned(v))) continue;
    if (!best || l.metres / d < best.r) best = { l, r: l.metres / d };
    if (best.r < 1.3) break;
  }
  const stops = [];
  let acc = 1e9;
  for (let i = 1; i < best.l.nodes.length; i++) {
    const p = best.l.nodes[i - 1], q = best.l.nodes[i];
    acc += Math.hypot(gr.x[q] - gr.x[p], gr.y[q] - gr.y[p]);
    if (acc >= 380) { const r = await act('placeStop', [gr.lng[q], gr.lat[q]]); if (r.ok) { stops.push(r.value); acc = 0; } }
  }
  const route = await act('createRoute', { stops, kind: 'linear' });
  if (!route.ok) return route.error;
  await act('setTimetable', route.value, flatTimetable(10, 300, 1380));
  for (let i = 0; i < 3; i++) { const r = await act('buyVehicle', 'mini8', depot); if (r.ok) await act('assignVehicle', r.value, route.value); }
  return { stops: stops.length, buses: Object.keys(g.state.vehicles).length };
});
console.log('A built', built);
await A.page.keyboard.press('4');
// Ana's line reaches Ben's map
await B.page.waitForFunction(() => window.__map.querySourceFeatures('rivals').length > 0, null, { timeout: 20000 }).catch(() => fail('no rival lines on B'));
await A.page.waitForTimeout(4000);
await A.page.locator('.rc-board').click();
await A.page.screenshot({ path: `${out}/a-racing.png` });
await B.page.screenshot({ path: `${out}/b-racing.png` });
await A.page.locator('.rc-board').click();
console.log('mid-race A', await info(A.page), 'B', await info(B.page));
await Promise.all([A, B].map((p) => p.page.waitForFunction(() => window.__race.state().phase === 'finished', null, { timeout: 300000 })));
const res = await Promise.all([A, B].map((p) => p.page.evaluate(() => ({ results: window.__race.state().results, t: window.__game.state.clock.t, speed: window.__game.speed }))));
console.log('A results', JSON.stringify(res[0]));
console.log('B results', JSON.stringify(res[1]));
if (res[0].results[0]?.name !== 'Ana') fail('Ana should have won');
if (JSON.stringify(res[0].results) !== JSON.stringify(res[1].results)) fail('the two computers disagree on the results');
if (res[0].t !== res[1].t) fail('the clocks stopped at different times');
await A.page.screenshot({ path: `${out}/a-finish.png` });
await B.page.screenshot({ path: `${out}/b-finish.png` });

step('After the race the company is a normal game');
await B.page.getByRole('button', { name: /keep playing/i }).click();
await B.page.keyboard.press('2');
await B.page.waitForTimeout(1500);
const after = await info(B.page);
console.log('B after', after);
if (!(after.t > res[1].t)) fail('B’s game did not run on after the race');

await A.browser.close();
await B.browser.close();
console.log(process.exitCode ? '\nRACE E2E FAILED' : '\nRACE E2E OK');
