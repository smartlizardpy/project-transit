// Edge cases a player can hit, checked in the real UI (needs pnpm dev):
// offline city download, stop tool on water / outside the licence, buying without a depot or money.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] || 'edge-cases';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const ready = () => page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
const text = (sel) => page.locator(sel).allInnerTexts().then((t) => t.join(' | ').replace(/\s+/g, ' ').slice(0, 300));

// 1. offline: a city that is not bundled
await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
await page.goto('http://127.0.0.1:5173/');
await ready();
await page.getByRole('button', { name: /New company/i }).first().click();
await page.locator('.mn-preset', { hasText: 'Durham' }).click();
await page.waitForTimeout(6000);
await page.screenshot({ path: `${out}/1-offline.png` });
console.log('offline:', await text('.mn-loading, .mn-error, [role=alert], [role=status]'));
await page.unroute('https://tiles.openfreemap.org/**');

// 2. İstanbul company
await page.goto('http://127.0.0.1:5173/');
await ready();
await page.getByRole('button', { name: /New company/i }).first().click();
await page.locator('.mn-preset', { hasText: 'İstanbul' }).click();
await page.waitForSelector('.mn-panel.setup', { timeout: 30000 });
await page.getByRole('button', { name: /^Next/ }).click();
await page.getByRole('button', { name: /Found company/i }).click();
await page.waitForFunction(() => window.__game, null, { timeout: 20000 });
await page.evaluate(() => window.__game.state.onboarding.active = false);

// 3. buying without a depot
await page.keyboard.press('g');
await page.getByRole('button', { name: 'Buy', exact: true }).first().click();
await page.waitForTimeout(400);
console.log('buy without depot:', await text('.pn-model button'));
await page.screenshot({ path: `${out}/2-no-depot.png` });
await page.keyboard.press('g');

// 4. stop tool over water and outside the licence
const hoverAt = async (ll, name) => {
  await page.evaluate((ll) => window.__map.jumpTo({ center: ll, zoom: 16.2, pitch: 45 }), ll);
  await page.waitForTimeout(1200);
  await page.mouse.move(800, 450);
  await page.mouse.move(801, 451);
  await page.waitForTimeout(500);
  console.log(name + ':', await text('.ghost-mk'));
  await page.screenshot({ path: `${out}/${name}.png` });
};
await page.keyboard.press('b');
await hoverAt([28.9768, 41.0168], '3-water');
const outside = await page.evaluate(() => {
  const g = window.__game, gr = g.region.graph, owned = new Set(g.state.territory.owned);
  for (let e = 0; e < gr.m; e += 7) { const v = gr.ea[e]; if (gr.cls[e] >= 2 && gr.cls[e] <= 4 && !owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]]).id)) return [gr.lng[v], gr.lat[v]]; }
  return null;
});
await hoverAt(outside, '4-outside-licence');
await page.mouse.click(801, 451);
await page.waitForTimeout(600);
console.log('click outside -> selection:', await page.evaluate(() => JSON.stringify(window.__ui.getState().selection)));
await page.screenshot({ path: `${out}/5-outside-click.png` });

// 5. running out of money: buy buses until refused
await page.keyboard.press('Escape');
const refused = await page.evaluate(() => {
  const g = window.__game, gr = g.region.graph, owned = new Set(g.state.territory.owned);
  let depot = null;
  for (let e = 0; e < gr.m && !depot; e++) { const v = gr.ea[e]; if (gr.cls[e] < 2 || gr.cls[e] > 4 || !owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]]).id)) continue; const r = g.buildDepot([gr.lng[v], gr.lat[v]]); if (r.ok) depot = r.value; }
  let last = null;
  for (let i = 0; i < 12; i++) { const r = g.buyVehicle('city12', depot); if (!r.ok) { last = r.error; break; } }
  g.emit('changed', 0);
  return { balance: Math.round(g.state.finance.balance), error: last };
});
console.log('buy until refused:', refused);
await page.keyboard.press('g');
await page.getByRole('button', { name: 'Buy', exact: true }).first().click();
await page.waitForTimeout(400);
console.log('buy buttons when broke:', await text('.pn-model button'));
await page.screenshot({ path: `${out}/6-broke.png` });
console.log('page errors:', errors.length ? errors.join(' / ') : 'none');
await browser.close();
