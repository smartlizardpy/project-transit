// Proves src/game/dmath.ts is bit-identical across JavaScript engines: runs every function on the
// same fixed inputs in Node (V8), Playwright chromium (V8) and Playwright webkit (JavaScriptCore,
// the engine behind Tauri's macOS webview) and compares the Float64 bit patterns. For contrast it
// also counts how many native Math.* results differ between the engines.
//   node scripts/check-dmath.mjs        (needs: pnpm exec playwright install webkit chromium)
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { chromium, webkit } from 'playwright';

const src = stripTypeScriptTypes(readFileSync(new URL('../src/game/dmath.ts', import.meta.url), 'utf8')).replace(/^export /gm, '');

// Runs inside each engine: only integer and + - * / arithmetic builds the inputs.
const RUN = `(dmSrc) => {
  const dm = new Function(dmSrc + '; return { sq, hypot, exp, log, log2, log10, sin, cos, tan, atan, atan2, asin, acos, pow };')();
  let s = 12345;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const uni = (lo, hi) => lo + (hi - lo) * rnd();
  const logUni = (lo, hi) => { let m = 1; const k = Math.floor(uni(lo, hi)); for (let i = 0; i < Math.abs(k); i++) m = k < 0 ? m / 2 : m * 2; return m * (1 + rnd()); };
  const N = 2000, un = {}, bin = {};
  const gen = (f) => Array.from({ length: N }, f);
  un.exp = gen((_, i) => (i < 6 ? [0, -0, 1, -1, 709, -745][i] : uni(-745, 709)));
  un.log = gen((_, i) => (i < 4 ? [1, 2, 0.5, 5e-324][i] : logUni(-996, 996)));
  un.log2 = un.log10 = un.log;
  un.sin = un.cos = gen((_, i) => (i < 4 ? [0, -0, 1e5, -1e7][i] : uni(-2000, 2000)));
  un.tan = gen(() => uni(-1.5, 1.5));
  un.atan = gen(() => (rnd() < 0.5 ? -1 : 1) * logUni(-40, 40));
  un.asin = un.acos = gen(() => uni(-1, 1));
  bin.atan2 = gen(() => [uni(-1e4, 1e4), uni(-1e4, 1e4)]);
  bin.hypot = gen(() => [uni(-1e6, 1e6), uni(-1e6, 1e6)]);
  bin.pow = gen((_, i) => (i % 4 === 0 ? [uni(-20, 20), Math.floor(uni(-70, 70))] : i % 4 === 1 ? [logUni(-20, 20), uni(0.1, 1)] : [logUni(-10, 13), uni(-6, 6)]));
  const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
  const hex = (x) => { f64[0] = x; return (u32[1] >>> 0).toString(16).padStart(8, '0') + (u32[0] >>> 0).toString(16).padStart(8, '0'); };
  const out = { dmath: {}, native: {} };
  for (const [set, lib] of [['dmath', dm], ['native', Math]]) {
    for (const [name, xs] of Object.entries(un)) out[set][name] = xs.map((x) => hex(lib[name](x)));
    for (const [name, xs] of Object.entries(bin)) out[set][name] = xs.map(([a, b]) => hex(lib[name](a, b)));
  }
  return out;
}`;

const results = { 'node (V8)': new Function(`return (${RUN})`)()(src) };
for (const [name, type] of [['chromium (V8)', chromium], ['webkit (JSC)', webkit]]) {
  try {
    const browser = await type.launch();
    const page = await browser.newPage();
    await page.goto('about:blank');
    results[name] = await page.evaluate(`(${RUN})(${JSON.stringify(src)})`);
    await browser.close();
  } catch (e) {
    console.error(`${name}: could not run (${e.message.split('\n')[0]}); try: pnpm exec playwright install webkit chromium`);
  }
}

const engines = Object.keys(results);
const ref = results['node (V8)'];
let bad = 0;
console.log(`engines: ${engines.join(', ')}\n`);
console.log('function'.padEnd(8), 'inputs'.padStart(6), ...engines.slice(1).map((e) => `dmath diffs vs node: ${e}`.padStart(40)), ...engines.slice(1).map((e) => `native diffs vs node: ${e}`.padStart(40)));
for (const name of Object.keys(ref.dmath)) {
  const diffs = (set, e) => results[e][set][name].filter((h, i) => h !== ref[set][name][i]).length;
  const d = engines.slice(1).map((e) => diffs('dmath', e)), n = engines.slice(1).map((e) => diffs('native', e));
  bad += d.reduce((a, b) => a + b, 0);
  console.log(name.padEnd(8), String(ref.dmath[name].length).padStart(6), ...d.map((x) => String(x).padStart(40)), ...n.map((x) => String(x).padStart(40)));
}
console.log(bad === 0 ? '\nOK: dmath is bit-identical on every engine.' : `\nFAIL: ${bad} dmath results differ between engines.`);
process.exit(bad === 0 ? 0 : 1);
