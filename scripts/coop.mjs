// Two players over real WebRTC (public Nostr relays introduce them, so this needs the internet):
// browser A founds a company and invites, browser B joins with the code, both act, and the two
// games must stay identical. Screenshots of both screens at the end.
// Usage: node scripts/coop.mjs <outDir>      (dev server: URL=http://localhost:5173/ by default)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [out = 'coop-shots'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const URL = process.env.URL || 'http://localhost:5173/';
// real local addresses instead of mDNS names, so two browsers on one machine can reach each other
const args = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const step = (msg) => console.log(`\n# ${msg}`);

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
  const g = window.__game;
  return g ? { t: g.state.clock.t, speed: g.speed, buses: Object.keys(g.state.vehicles).length, depots: Object.keys(g.state.depots).length, fare: g.state.company.fare, sum: window.__coop.sum(), players: window.__coop.state().players.map((p) => p.name) } : null;
});

step('A founds a company');
const A = await open('A');
await A.page.getByRole('button', { name: /new company/i }).click();
await A.page.locator('.mn-preset').first().click();
await A.page.waitForFunction(() => document.querySelector('.mn-zone'), null, { timeout: 120000 });
await A.page.evaluate(() => {
  const r = window.__session.region;
  const z = [...r.zones].sort((a, b) => b.residents + b.jobs - (a.residents + a.jobs))[0];
  window.__map.jumpTo({ center: z.centroid, zoom: 14.6 });
});
await A.page.waitForTimeout(800);
{
  const c = await A.page.evaluate(() => { const p = window.__map.project(window.__map.getCenter()); return [p.x, p.y]; });
  await A.page.mouse.click(c[0], c[1]);
}
await A.page.getByRole('button', { name: /^Next/ }).click();
await A.page.getByRole('textbox', { name: 'Company name' }).fill('Bosphorus Co-op');
await A.page.getByRole('button', { name: /found company/i }).click();
await A.page.waitForFunction(() => window.__game, null, { timeout: 20000 });
// a depot near the centre, so there is something to buy buses for
const depot = await A.page.evaluate(async () => {
  const g = window.__game;
  const z = g.region.zones.find((q) => q.id === g.state.territory.home);
  const r = await window.__coop.act('buildDepot', z.centroid);
  return r.ok ? r.value : r.error;
});
console.log('depot', depot);

step('A invites');
await A.page.keyboard.press('Escape');
await A.page.getByRole('button', { name: /play with friends/i }).click();
await A.page.locator('.co-field input').fill('Ana');
await A.page.getByRole('button', { name: /invite friends/i }).click();
const code = (await A.page.locator('.co-code span').textContent()).trim();
console.log('code', code);
await A.page.screenshot({ path: `${out}/a-invite.png` });
await A.page.keyboard.press('Escape');
await A.page.keyboard.press('Escape');

step('B joins');
const B = await open('B');
await B.page.getByRole('button', { name: /join a friend/i }).click();
await B.page.locator('.co-field input').first().fill('Ben');
await B.page.locator('.co-code-in').fill(code);
const t0 = Date.now();
await B.page.getByRole('button', { name: /^join$/i }).click();
await B.page.waitForFunction(() => window.__game && window.__coop.state().phase === 'playing', null, { timeout: 90000 });
console.log(`joined in ${((Date.now() - t0) / 1000).toFixed(1)} s`, await info(B.page));

step('Both act while the clock runs');
await A.page.keyboard.press('3');
await A.page.waitForTimeout(1500);
const bought = await B.page.evaluate(async (d) => window.__coop.act('buyVehicle', 'city12', d), depot);
console.log('B bought a bus:', bought);
const fare = await A.page.evaluate(async () => window.__coop.act('setFare', 2.25));
console.log('A set the fare:', fare);
// B moves the mouse over the map: A should see B's cursor
for (let i = 0; i < 12; i++) {
  await B.page.mouse.move(600 + i * 20, 420 + i * 6);
  await B.page.waitForTimeout(60);
}
await A.page.waitForTimeout(800);
const cursorOnA = await A.page.locator('.co-cursor').count();
console.log('cursors on A:', cursorOnA);
await A.page.waitForTimeout(4000);

step('B drifts (forced): the host must send the game again');
const gameBefore = await B.page.evaluate(() => { window.__before = window.__game; window.__game.state.rng = (window.__game.state.rng + 999) >>> 0; return window.__game.state.clock.t; });
await A.page.keyboard.press('4');
await B.page.waitForFunction(() => window.__game !== window.__before, null, { timeout: 60000 }).then(() => console.log('re-synced')).catch(() => console.log('NOT re-synced'));
console.log('B still in the session:', await B.page.evaluate(() => window.__coop.state().phase), 'from t', gameBefore);
await A.page.waitForTimeout(3000);

step('Pause and compare');
await B.page.keyboard.press('Space'); // the guest pauses for everyone
await A.page.waitForTimeout(2000);
const a = await info(A.page), b = await info(B.page);
console.log('A', a);
console.log('B', b);
await A.page.screenshot({ path: `${out}/a-playing.png` });
await B.page.screenshot({ path: `${out}/b-playing.png` });
const same = a && b && a.t === b.t && a.sum === b.sum && a.buses === b.buses && a.fare === b.fare;
console.log(same ? '\nOK: both games are identical' : '\nMISMATCH');
await A.browser.close();
await B.browser.close();
process.exit(same && cursorOnA > 0 ? 0 : 1);
