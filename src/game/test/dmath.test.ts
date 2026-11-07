import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as dm from '../dmath.ts';

// seeded uniform [0, 1)
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rel = (a: number, b: number) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(b), 1e-300));
const N = 20000;

function maxErr(f: (r: () => number) => [number, number]): number {
  const r = rng(12345);
  let m = 0;
  for (let i = 0; i < N; i++) { const [a, b] = f(r); m = Math.max(m, rel(a, b)); }
  return m;
}
const uni = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();
const logUni = (r: () => number, lo: number, hi: number) => Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * r());

describe('dmath accuracy vs native Math', () => {
  const T = 1e-14;
  it('exp', () => {
    const e = Math.max(maxErr((r) => { const x = uni(r, -745, 709); return [dm.exp(x), Math.exp(x)]; }), maxErr((r) => { const x = uni(r, -30, 30); return [dm.exp(x), Math.exp(x)]; }));
    console.log('exp max rel err', e); expect(e).toBeLessThan(T);
  });
  it('log', () => {
    const e = Math.max(maxErr((r) => { const x = logUni(r, 1e-300, 1e300); return [dm.log(x), Math.log(x)]; }), maxErr((r) => { const x = uni(r, 0.5, 2); return [dm.log(x), Math.log(x)]; }), maxErr((r) => { const x = uni(r, 0, 1e6); return [dm.log(x), Math.log(x)]; }));
    console.log('log max rel err', e); expect(e).toBeLessThan(T);
  });
  it('log2 / log10', () => {
    const e = maxErr((r) => { const x = logUni(r, 1e-100, 1e100); return [dm.log2(x), Math.log2(x)]; });
    const e10 = maxErr((r) => { const x = logUni(r, 1e-100, 1e100); return [dm.log10(x), Math.log10(x)]; });
    console.log('log2/log10 max rel err', e, e10); expect(Math.max(e, e10)).toBeLessThan(T);
  });
  it('sin / cos / tan', () => {
    const s = maxErr((r) => { const x = uni(r, -1000, 1000); return [dm.sin(x), Math.sin(x)]; });
    const c = maxErr((r) => { const x = uni(r, -1000, 1000); return [dm.cos(x), Math.cos(x)]; });
    const s2 = maxErr((r) => { const x = uni(r, -8, 8); return [dm.sin(x), Math.sin(x)]; });
    const c2 = maxErr((r) => { const x = uni(r, -8, 8); return [dm.cos(x), Math.cos(x)]; });
    const t = maxErr((r) => { const x = uni(r, -1.5, 1.5); return [dm.tan(x), Math.tan(x)]; });
    console.log('sin/cos/tan max rel err', s, c, s2, c2, t); expect(Math.max(s, c, s2, c2, t)).toBeLessThan(T);
  });
  it('atan / atan2 / asin / acos', () => {
    const a = maxErr((r) => { const x = uni(r, -50, 50); return [dm.atan(x), Math.atan(x)]; });
    const a1 = maxErr((r) => { const x = logUni(r, 1e-12, 1e12) * (r() < 0.5 ? -1 : 1); return [dm.atan(x), Math.atan(x)]; });
    const a2 = maxErr((r) => { const y = uni(r, -1e4, 1e4), x = uni(r, -1e4, 1e4); return [dm.atan2(y, x), Math.atan2(y, x)]; });
    const s = maxErr((r) => { const x = uni(r, -1, 1); return [dm.asin(x), Math.asin(x)]; });
    const c = maxErr((r) => { const x = uni(r, -1, 1); return [dm.acos(x), Math.acos(x)]; });
    console.log('atan/atan2/asin/acos max rel err', a, a1, a2, s, c); expect(Math.max(a, a1, a2, s, c)).toBeLessThan(T);
  });
  it('pow', () => {
    const p = maxErr((r) => { const x = logUni(r, 1e-3, 1e4), y = uni(r, -6, 6); return [dm.pow(x, y), Math.pow(x, y)]; });
    const nest = maxErr((r) => { const x = logUni(r, 1e-6, 1e6), y = uni(r, 0.2, 1); return [dm.pow(x, y), Math.pow(x, y)]; });
    const ints = maxErr((r) => { const x = uni(r, -20, 20), y = Math.floor(uni(r, -60, 61)); return [dm.pow(x, y), Math.pow(x, y)]; });
    console.log('pow max rel err', p, nest, ints); expect(Math.max(p, nest, ints)).toBeLessThan(T);
  });
  it('hypot', () => {
    const h = maxErr((r) => { const x = uni(r, -1e6, 1e6), y = uni(r, -1e6, 1e6); return [dm.hypot(x, y), Math.hypot(x, y)]; });
    console.log('hypot max rel err', h); expect(h).toBeLessThan(T);
  });
});

describe('dmath special values', () => {
  const same = (a: number, b: number) => expect(Object.is(a, b), `${a} vs ${b}`).toBe(true);
  it('exp', () => {
    same(dm.exp(NaN), NaN); same(dm.exp(Infinity), Infinity); same(dm.exp(-Infinity), 0); same(dm.exp(0), 1);
    same(dm.exp(710), Infinity); same(dm.exp(-746), 0); expect(dm.exp(-740)).toBeGreaterThan(0); expect(dm.exp(709.7)).toBeLessThan(Infinity);
    expect(rel(dm.exp(-740), Math.exp(-740))).toBeLessThan(1e-9); // subnormal range
  });
  it('log', () => {
    same(dm.log(NaN), NaN); same(dm.log(-1), NaN); same(dm.log(0), -Infinity); same(dm.log(-0), -Infinity); same(dm.log(Infinity), Infinity); same(dm.log(1), 0);
    expect(rel(dm.log(5e-324), Math.log(5e-324))).toBeLessThan(1e-14);
    expect(rel(dm.log(Math.E), 1)).toBeLessThan(1e-15);
  });
  it('sin cos', () => {
    same(dm.sin(NaN), NaN); same(dm.sin(Infinity), NaN); same(dm.cos(-Infinity), NaN); same(dm.sin(0), 0); same(dm.sin(-0), -0); same(dm.cos(0), 1);
    for (const x of [1e5, -3e6, 1e9]) expect(Math.abs(dm.sin(x) - Math.sin(x))).toBeLessThan(1e-6);
    expect(Number.isFinite(dm.sin(1e300))).toBe(true); // garbage-in, but finite and deterministic
  });
  it('atan2', () => {
    const P = Math.PI;
    same(dm.atan2(0, 0), 0); same(dm.atan2(-0, 0), -0); same(dm.atan2(0, -0), P); same(dm.atan2(-0, -0), -P);
    same(dm.atan2(1, 0), P / 2); same(dm.atan2(-1, 0), -P / 2); same(dm.atan2(0, -1), P); same(dm.atan2(-0, -1), -P);
    same(dm.atan2(Infinity, Infinity), P / 4); same(dm.atan2(Infinity, -Infinity), (3 * P) / 4); same(dm.atan2(1, -Infinity), P); same(dm.atan2(1, Infinity), 0);
    same(dm.atan2(NaN, 1), NaN); same(dm.atan2(Infinity, 1), P / 2);
    same(dm.atan(Infinity), P / 2); same(dm.atan(-Infinity), -P / 2); same(dm.atan(NaN), NaN);
  });
  it('asin acos', () => {
    same(dm.asin(2), NaN); same(dm.acos(-1.5), NaN); same(dm.asin(1), Math.PI / 2); same(dm.acos(1), 0); same(dm.acos(-1), Math.PI); same(dm.asin(0), 0);
  });
  it('pow', () => {
    same(dm.pow(5, 0), 1); same(dm.pow(NaN, 0), 1); same(dm.pow(NaN, 2), NaN); same(dm.pow(2, NaN), NaN);
    same(dm.pow(2, 10), 1024); same(dm.pow(2, -2), 0.25); same(dm.pow(-2, 3), -8); same(dm.pow(-2, 20), 1048576); same(dm.pow(-2, 0.5), NaN);
    expect(rel(dm.pow(-3, 21), Math.pow(-3, 21))).toBeLessThan(1e-14);
    same(dm.pow(0, 2), 0); same(dm.pow(0, 0.5), 0); same(dm.pow(0, -1), Infinity); same(dm.pow(-0, -1), -Infinity); same(dm.pow(-0, 3), -0); same(dm.pow(0, -0.5), Infinity); same(dm.pow(-0, -3.5), Infinity);
    same(dm.pow(Infinity, 2), Infinity); same(dm.pow(Infinity, -2), 0); same(dm.pow(-Infinity, 3), -Infinity); same(dm.pow(-Infinity, 0.5), Infinity); same(dm.pow(-Infinity, -3), -0);
    same(dm.pow(2, Infinity), Infinity); same(dm.pow(0.5, Infinity), 0); same(dm.pow(2, -Infinity), 0); same(dm.pow(1, Infinity), NaN); same(dm.pow(-1, Infinity), NaN);
    same(dm.pow(10, 400), Infinity); same(dm.pow(10, -400), 0); same(dm.pow(10, 3), 1000); same(dm.pow(10, 6), 1e6);
    same(dm.pow(1, 0.5), 1);
  });
  it('hypot', () => {
    same(dm.hypot(3, 4), 5); same(dm.hypot(0, 0), 0); same(dm.hypot(Infinity, NaN), Infinity); same(dm.hypot(NaN, 1), NaN); same(dm.hypot(-3, -4), 5);
    expect(rel(dm.hypot(3e200, 4e200), 5e200)).toBeLessThan(1e-15);
  });
  it('cmp', () => {
    expect([dm.cmp('a', 'b'), dm.cmp('b', 'a'), dm.cmp('a', 'a'), dm.cmp('Z', 'a')]).toEqual([-1, 1, 0, -1]);
  });
});

// Walk src/game (not tests), blank comments / strings, then look for engine-dependent calls.
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'test' ? [] : sources(join(dir, e.name))) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}
function blank(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; }
    else if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; }
    else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += c + src.slice(i + 1, j).replace(/[^\n]/g, ' ') + c; i = j + 1; // template ${} bodies are blanked too
    } else { out += c; i++; }
  }
  return out;
}

describe('engine-dependent math is banned from src/game', () => {
  const FORBIDDEN = /\bMath\s*\.\s*(sin|cos|tan|exp|expm1|log|log1p|log2|log10|pow|atan|atan2|asin|acos|atanh|asinh|acosh|hypot|cbrt|sinh|cosh|tanh)\b|\*\*|\blocaleCompare\b|\bMath\s*\[/;
  const files = sources(join(__dirname, '..'));
  it('finds the game sources', () => expect(files.length).toBeGreaterThan(30));
  it('uses dmath instead of Math.sin/exp/pow/hypot..., `**` and localeCompare', () => {
    const bad: string[] = [];
    for (const f of files) {
      if (f.endsWith('dmath.ts')) continue;
      const lines = blank(readFileSync(f, 'utf8')).split('\n');
      lines.forEach((l, i) => { const m = FORBIDDEN.exec(l); if (m) bad.push(`${f.slice(f.indexOf('src/game'))}:${i + 1}: ${m[0]}`); });
    }
    expect(bad).toEqual([]);
  });
  it('dmath itself uses only exact operations', () => {
    const src = blank(readFileSync(join(__dirname, '..', 'dmath.ts'), 'utf8'));
    expect(src.match(/Math\.\w+/g)!.filter((m) => !/^Math\.(sqrt|abs|floor|ceil|round|trunc|min|max|sign)$/.test(m))).toEqual([]);
    expect(src).not.toMatch(/\*\*/);
  });
});
