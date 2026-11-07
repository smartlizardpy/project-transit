// Micro-benchmark: dmath vs native Math.   node --experimental-strip-types scripts/bench-dmath.mjs
import * as dm from '../src/game/dmath.ts';
const N = 1e6, xs = new Float64Array(N), ys = new Float64Array(N);
let s = 1; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
for (let i = 0; i < N; i++) { xs[i] = r() * 8 - 6; ys[i] = r() * 50 + 0.01; }
const time = (name, f) => { let best = 1e9, acc = 0; for (let k = 0; k < 7; k++) { const t = performance.now(); for (let i = 0; i < N; i++) acc += f(i); best = Math.min(best, performance.now() - t); } console.log(name.padEnd(13), best.toFixed(2), 'ms per 1e6', acc === 1 ? '' : ''); };
time('exp native', (i) => Math.exp(xs[i])); time('exp dm', (i) => dm.exp(xs[i]));
time('log native', (i) => Math.log(ys[i])); time('log dm', (i) => dm.log(ys[i]));
time('pow native', (i) => ys[i] ** 0.45); time('pow dm', (i) => dm.pow(ys[i], 0.45));
time('hypot native', (i) => Math.hypot(xs[i], ys[i])); time('hypot dm', (i) => dm.hypot(xs[i], ys[i]));
time('atan2 native', (i) => Math.atan2(xs[i], ys[i])); time('atan2 dm', (i) => dm.atan2(xs[i], ys[i]));
time('sin native', (i) => Math.sin(xs[i])); time('sin dm', (i) => dm.sin(xs[i]));
