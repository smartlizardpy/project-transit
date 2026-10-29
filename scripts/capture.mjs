// Screenshot every demo state at several desktop sizes, driving the UI with real
// mouse clicks and key presses. Requires the dev server (pnpm dev) to be running.
//
//   node scripts/capture.mjs                 # all sizes, all states
//   node scripts/capture.mjs 1920x1080       # one size
//   SHOTS_DIR=out node scripts/capture.mjs   # custom output folder
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL || 'http://127.0.0.1:5173/';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots';
const SIZES = (process.argv[2] ? [process.argv[2]] : ['1920x1080', '2560x1440', '1366x768']).map((s) => s.split('x').map(Number));
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
mkdirSync(OUT, { recursive: true });

const settle = async (page, extra = 900) => {
  await page.waitForFunction(() => window.__map.areTilesLoaded() && !window.__city.busy, null, { timeout: 30000 }).catch(() => console.warn('  tiles timeout'));
  await page.waitForTimeout(extra);
};
const project = (page, lngLat) => page.evaluate((ll) => { const p = window.__map.project(ll); return { x: p.x, y: p.y }; }, lngLat);
const home = async (page) => {
  await page.evaluate(() => {
    const ui = window.__ui.getState();
    ui.setTool('select');
    window.__ui.setState({ selection: null, hover: null, panel: null, following: null, overlays: { traffic: false, demand: false, network: false }, toast: null });
    window.__sim.setSpeed(1);
    window.__map.jumpTo({ center: [28.9766, 41.0262], zoom: 16.45, pitch: 56, bearing: -28 });
  });
  await page.mouse.move(5, 540);
};

/** A bus that is on screen and clear of the HUD cards. */
const visibleBus = (page, w, h, prefer) =>
  page.evaluate(({ w, h, prefer }) => {
    const ctl = window.__ctl, sim = window.__sim;
    const cands = sim.vehicles.filter((v) => v.status !== 'depot').map((v) => ({ v, p: ctl.vehicles.screenPos(v.id) })).filter(({ p }) => p && p.x > 120 && p.x < w - 420 && p.y > 120 && p.y < h - 140);
    const score = (c) => (c.v.lineId === prefer ? 2 : 0) + (sim.pose(c.v).at[0] > 28.981 ? 1 : 0);
    cands.sort((a, b) => score(b) - score(a));
    const c = cands[0];
    return c ? { id: c.v.id, x: c.p.x, y: c.p.y } : null;
  }, { w, h, prefer });

const STATES = {
  async overview() {},

  async 'clean-map'(page) {
    await page.keyboard.press('Shift+U'); // hide the HUD: the map alone must look good
  },

  async 'bus-selected'(page, w, h) {
    await page.evaluate(() => window.__map.jumpTo({ center: [28.9845, 41.0268], zoom: 16.9, pitch: 56, bearing: -24 }));
    await settle(page, 600);
    await page.evaluate(() => window.__sim.setSpeed(0));
    const bus = await visibleBus(page, w, h, 'L26');
    if (!bus) throw new Error('no bus on screen');
    await page.mouse.move(bus.x, bus.y);
    await page.waitForTimeout(150);
    await page.mouse.click(bus.x, bus.y);
    await page.waitForTimeout(250);
    await page.getByRole('button', { name: /Follow/ }).click();
    await page.evaluate(() => window.__sim.setSpeed(1));
    await page.waitForTimeout(2600);
  },

  async 'route-selected'(page) {
    await page.getByRole('button', { name: 'Lines' }).first().click();
    await page.waitForTimeout(350);
    await page.locator('.panel .lrow', { hasText: 'Sirkeci' }).first().click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Lines' }).first().click(); // close the panel, keep the selection
    await page.mouse.move(960, 700);
    await page.waitForTimeout(1500);
  },

  async 'route-editing'(page, w, h) {
    // click real (OSM) bus stops near three points on screen, then hover a fourth;
    // zoom out step by step until enough stops are in view
    const findPicks = () => page.evaluate(({ w, h }) => {
      const on = window.__freeStops().map((o) => ({ o, p: window.__map.project(o.lngLat) })).filter(({ p }) => p.x > 140 && p.x < w - 140 && p.y > 140 && p.y < h - 170);
      const used = new Set();
      return [[0.62, 0.66], [0.66, 0.34], [0.38, 0.3], [0.3, 0.62]].map(([fx, fy]) => {
        const c = on.filter(({ o }) => !used.has(o.id)).sort((a, b) => Math.hypot(a.p.x - fx * w, a.p.y - fy * h) - Math.hypot(b.p.x - fx * w, b.p.y - fy * h))[0];
        if (!c) return null;
        used.add(c.o.id);
        return { x: c.p.x, y: c.p.y };
      }).filter(Boolean);
    }, { w, h });
    let picks = [];
    for (const zoom of [16.1, 15.7, 15.3]) {
      await page.evaluate((zoom) => window.__map.jumpTo({ center: [28.9792, 41.0272], zoom, pitch: 50, bearing: -20 }), zoom);
      await settle(page, 500);
      picks = await findPicks();
      if (picks.length >= 4) break;
    }
    await page.keyboard.press('r');
    await page.waitForTimeout(300);
    if (picks.length < 4) throw new Error('not enough bus stops on screen');
    for (const p of picks.slice(0, 3)) {
      await page.mouse.move(p.x, p.y, { steps: 4 });
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(250);
    }
    await page.mouse.move(picks[3].x, picks[3].y, { steps: 6 });
    await page.waitForTimeout(700);
  },

  async 'fleet-panel'(page) {
    await page.keyboard.press('g');
    await page.waitForTimeout(700);
  },

  async 'fleet-buy'(page) {
    await page.keyboard.press('g');
    await page.waitForTimeout(300);
    await page.locator('.panel .seg button', { hasText: 'Buy' }).click();
    await page.waitForTimeout(600);
  },

  async 'finance-panel'(page) {
    await page.keyboard.press('m');
    await page.waitForTimeout(700);
  },

  async 'traffic-overlay'(page) {
    await page.evaluate(() => { window.__sim.minutes = 8 * 60 + 15; window.__map.jumpTo({ center: [28.9772, 41.0262], zoom: 15.6, pitch: 48, bearing: -24 }); });
    await settle(page, 300);
    await page.keyboard.press('t');
    await page.waitForTimeout(1200);
  },

  async 'demand-overlay'(page) {
    await page.evaluate(() => window.__map.jumpTo({ center: [28.9772, 41.0262], zoom: 15.4, pitch: 45, bearing: -24 }));
    await settle(page, 600);
    await page.keyboard.press('p');
    await page.waitForTimeout(1400);
  },

  async 'network-view'(page) {
    await page.evaluate(() => window.__map.jumpTo({ center: [28.9772, 41.0262], zoom: 15.6, pitch: 40, bearing: -24 }));
    await settle(page, 300);
    await page.keyboard.press('n');
    await page.waitForTimeout(1600);
  },

  async 'stop-selected'(page) {
    const p = await page.evaluate(() => {
      const s = [...window.__sim.stops.values()].find((x) => x.name.startsWith('Karaköy'));
      window.__map.jumpTo({ center: [s.lngLat[0] + 0.0012, s.lngLat[1] + 0.0006], zoom: 17.3, pitch: 55, bearing: -28 });
      return s.lngLat;
    });
    await settle(page, 600);
    const at = await project(page, p);
    await page.mouse.click(at.x, at.y - 26);
    await page.waitForTimeout(1200);
  },
};

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const [w, h] of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL);
  await page.waitForFunction(() => window.__ctl && window.__map.loaded(), null, { timeout: 30000 });
  await settle(page, 2200);
  for (const [name, run] of Object.entries(STATES)) {
    if (ONLY && !ONLY.includes(name)) continue;
    await home(page);
    await settle(page, 400);
    try {
      await run(page, w, h);
      await page.waitForFunction(() => !window.__city.busy, null, { timeout: 15000 }).catch(() => {});
      const file = `${OUT}/${w}x${h}-${name}.png`;
      await page.screenshot({ path: file });
      console.log('✓', file);
    } catch (e) {
      console.log('✗', name, e.message.split('\n')[0]);
    }
    if (name === 'clean-map') await page.keyboard.press('Shift+U');
  }
  if (errors.length) console.log('page errors:\n ', [...new Set(errors)].slice(0, 10).join('\n  '));
  await page.close();
}
await browser.close();
