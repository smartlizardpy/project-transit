// Start screen and new-company steps, as a player sees them (needs pnpm dev).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] || 'menu-shots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto('http://127.0.0.1:5173/');
await page.waitForFunction(() => window.__map?.loaded(), null, { timeout: 30000 });
const live = () => page.evaluate(() => {
  const c = window.__map.getCenter();
  return { centre: [+c.lng.toFixed(4), +c.lat.toFixed(4)], zoom: +window.__map.getZoom().toFixed(2), bearing: +window.__map.getBearing().toFixed(1), game: !!window.__game };
});
for (const t of [2, 8, 16]) {
  await page.waitForTimeout(t === 2 ? 2000 : 6000);
  await page.screenshot({ path: `${out}/start-${t}s.png` });
  console.log(`start ${t}s`, await live());
}
await page.getByRole('button', { name: /New company/i }).first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/step1.png` });
await page.locator('.mn-preset').first().click();
await page.waitForSelector('.mn-zone', { timeout: 60000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/step2.png` });
await page.locator('.mn-zone').nth(2).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/step2-picked.png` });
await page.getByRole('button', { name: /^Next/ }).click();
await page.waitForTimeout(1600);
await page.screenshot({ path: `${out}/step3.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
console.log('after Esc on step 3:', await page.locator('.mn-panel-head h2').innerText());
await page.getByRole('button', { name: /^Next/ }).click();
await page.getByRole('textbox', { name: 'Company name' }).fill('Bosphorus Lines');
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__game, null, { timeout: 10000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/playing.png` });
console.log('playing:', await page.evaluate(() => ({ company: window.__game.state.company.name, home: window.__game.state.territory.home, buses: Object.keys(window.__game.state.vehicles).length })));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
