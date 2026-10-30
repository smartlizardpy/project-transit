// City Activity Engine QA screenshots (phase 3): place cards with "When it's busy" and city
// transit links, the line inspector's character sections, and estimated demand with the existing
// transit column, from a genuinely simulated company. Run `node scripts/capture-network.mjs sim`
// first (it simulates until Network Control unlocks and saves), with the dev server on port
// 5182, then:
//
//   NC_PROFILE=<same profile> node scripts/capture-places.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.URL || 'http://localhost:5182/';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots/city-activity';
const PROFILE = process.env.NC_PROFILE || join(tmpdir(), 'pt-network-control-profile');
mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  viewport: { width: 1920, height: 1080 },
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const ui = (fn, arg) => page.evaluate(fn, arg);
const settle = async (extra = 900) => {
  await page.waitForFunction(() => window.__map?.areTilesLoaded() && !window.__city?.busy, null, { timeout: 30000 }).catch(() => console.warn('  tiles timeout'));
  await page.waitForTimeout(extra);
};
const shot = async (name, extra) => { await settle(extra); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('  shot', name); };
// a long simulated save opens on the "Network Control is open" card: dismiss it as a player would
const clearScrims = () => ui(() => window.__game?.setNetworkIntro?.({ seen: true }));

await page.goto(URL);
await page.waitForFunction(() => window.__session && window.__map?.loaded(), null, { timeout: 30000 });
await ui(async () => { await window.__session.refreshSaves(); await window.__session.continueLatest(); });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await ui(() => window.__game.setSpeed(0));
await clearScrims();

// place cards: pick real places of each kind from the registry
const picks = await ui(() => {
  const g = window.__game;
  const all = [...g.geo.places.byId.values()].filter((p) => p.reachable);
  const best = (cat, pref) => {
    const list = all.filter((p) => p.category === cat).sort((a, b) => a.scale.tier - b.scale.tier || a.id.localeCompare(b.id));
    return (pref && list.find((p) => pref.test(p.name))) || list[0] || null;
  };
  const out = {};
  for (const [name, cat, pref] of [
    ['university', 'university', /İstanbul Üniversitesi|Mimar Sinan|Galatasaray/],
    ['station', 'metro_station', /Şişhane|Taksim/],
    ['pier', 'ferry_pier', /Karaköy|Eminönü/],
    ['school', 'school', null],
    ['hospital', 'hospital', null],
    ['market', 'market', /Kapalı|Grand|Mısır/],
  ]) {
    const p = best(cat, pref);
    if (p) out[name] = { id: p.id, name: p.name, at: p.lngLat };
  }
  return out;
});
console.log('  places', JSON.stringify(Object.fromEntries(Object.entries(picks).map(([k, v]) => [k, v.name]))));
for (const [key, p] of [...Object.entries(picks), ['airport', { id: 'iata:IST', at: null }]]) {
  await ui(({ id, at }) => {
    window.__ui.getState().select({ kind: 'place', id });
    if (at) window.__map.jumpTo({ center: at, zoom: 15.6, pitch: 40 });
  }, p);
  await page.waitForTimeout(800);
  await shot(`place-card-busy-${key}`, 900);
}

// the line inspector: character sections, all open
const line = await ui(() => Object.keys(window.__game.state.routes).sort()[0]);
await ui((id) => window.__ui.getState().select({ kind: 'line', id }), line);
await page.waitForTimeout(700);
await clearScrims();
// open every section (the list of closed ones shrinks as each opens)
for (let i = 0; i < 10 && (await page.locator('.lc-head[aria-expanded="false"]').count()); i++) await page.locator('.lc-head[aria-expanded="false"]').first().click();
await page.waitForTimeout(400);
await page.locator('.lc-fold').first().evaluate((el) => {
  const body = el.closest('.p-body');
  if (body) body.scrollTop = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 8;
});
await shot('line-character', 700);
await page.locator('.p-body').first().evaluate((el) => el.scrollTo(0, el.scrollHeight));
await shot('line-character-scrolled', 600);
await page.keyboard.press('Escape');

// Network Control → Passengers → estimated demand, with the metro, tram and ferry column
await ui(() => window.__ui.getState().openPanel('network'));
await page.waitForTimeout(600);
await page.locator('.nc-tabs .seg button', { hasText: 'Passengers' }).click();
await page.waitForTimeout(500);
await page.getByRole('button', { name: 'Estimated demand' }).click();
await page.waitForTimeout(900);
await shot('nc-estimated-transit', 900);
console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no page errors');
await ctx.close();
