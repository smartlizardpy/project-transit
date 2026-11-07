// Deterministic math for the simulation. The engines (JavaScriptCore, V8) agree bit-for-bit on
// + - * / and sqrt but not on sin/exp/log/pow/atan2/hypot..., so lockstep co-op must never call
// those from src/game. Everything here is plain arithmetic, sqrt, bit views and literal constants
// (ported from fdlibm), so every engine computes identical results.
// Accuracy is a few ulp (rel. error < 1e-15 on the game's ranges), not correct rounding.

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
f64[0] = 1;
const HI = u32[1] === 0x3ff00000 ? 1 : 0; // index of the high word (little-endian: 1)

export const sq = (x: number): number => x * x;

/** Euclidean length. */
export function hypot(x: number, y: number): number {
  const s = x * x + y * y;
  if (s === Infinity || s !== s) {
    if (x === Infinity || x === -Infinity || y === Infinity || y === -Infinity) return Infinity;
    const m = Math.max(Math.abs(x), Math.abs(y)); // overflowed squares: rescale
    const a = x / m, b = y / m;
    return m * Math.sqrt(a * a + b * b);
  }
  return Math.sqrt(s);
}

// 2^k for k in [-1075, 1023] (0 below 2^-1074): each entry is an exact doubling/halving, so the table is identical everywhere.
const T = new Float64Array(2099);
for (let i = 1075, v = 1; i < 2099; i++, v *= 2) T[i] = v;
for (let i = 1074, v = 0.5; i >= 1; i--, v *= 0.5) T[i] = v;
const OFF = 1075;

const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e+00;
// 2^(j/32), j = 0..31, as literals
const E32 = new Float64Array([1, 1.0218971486541166, 1.0442737824274138, 1.0671404006768237, 1.0905077326652577, 1.1143867425958924, 1.1387886347566916, 1.1637248587775775, 1.189207115002721, 1.215247359980469, 1.241857812073484, 1.2690509571917332, 1.2968395546510096, 1.3252366431597413, 1.3542555469368927, 1.383909881963832, 1.4142135623730951, 1.4451808069770467, 1.4768261459394993, 1.5091644275934228, 1.5422108254079407, 1.5759808451078865, 1.6104903319492543, 1.645755478153965, 1.681792830507429, 1.718619298122478, 1.7562521603732995, 1.7947090750031072, 1.8340080864093424, 1.8741676341103, 1.9152065613971474, 1.9571441241754002]);
const LN2_32_HI = LN2_HI / 32, LN2_32_LO = LN2_LO / 32; // power-of-two scaling: still exact
const INV_LN2_32 = 46.16624130844683; // 32 / ln 2

export function exp(x: number): number {
  if (!(x >= -745.1332191019412 && x <= 709.782712893384)) return x !== x ? NaN : x > 0 ? Infinity : 0;
  const n = Math.floor(x * INV_LN2_32 + 0.5);
  const r = (x - n * LN2_32_HI) - n * LN2_32_LO; // |r| <= ln2/64
  const p = r + r * r * (0.5 + r * (0.16666666666666666 + r * (0.041666666666666664 + r * (0.008333333333333333 + r * 0.001388888888888889))));
  const t = E32[n & 31];
  const y = t + t * p, k = n >> 5;
  return k > 1023 ? y * 2 * T[1023 + OFF] : y * T[k + OFF];
}

const Lg1 = 6.666666666666735130e-01, Lg2 = 3.999999999940941908e-01, Lg3 = 2.857142874366239149e-01, Lg4 = 2.222219843214978396e-01, Lg5 = 1.818357216161805012e-01, Lg6 = 1.531383769920937332e-01, Lg7 = 1.479819860511658591e-01;

export function log(x: number): number {
  let k = 0;
  if (!(x >= 2.2250738585072014e-308 && x < Infinity)) { // slow path: NaN, <= 0, subnormal, Infinity
    if (!(x >= 0)) return NaN;
    if (x === 0) return -Infinity;
    if (x === Infinity) return Infinity;
    x *= 18014398509481984; k = -54; // subnormal: scale by 2^54
  }
  f64[0] = x;
  const hx = u32[HI];
  const e = (hx >>> 20) - 1023 + (((hx & 0xfffff) + 0x95f64) >>> 20); // +1 when the mantissa is above sqrt(2)
  k += e;
  const f = x * T[OFF - e] - 1, // exact scaling to [sqrt(1/2), sqrt(2)), branch-free
    s = f / (2 + f), z = s * s, w = z * z;
  const R = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7))) + w * (Lg2 + w * (Lg4 + w * Lg6));
  const hfsq = 0.5 * f * f;
  return k * LN2_HI - ((hfsq - (s * (hfsq + R) + k * LN2_LO)) - f);
}

export const log2 = (x: number): number => log(x) * INV_LN2;
export const log10 = (x: number): number => log(x) * 0.4342944819032518;

const PIO2_1 = 1.57079632673412561417e+00, PIO2_2 = 6.07710050630396597660e-11, PIO2_3 = 2.02226624871116645580e-21, PIO2_3T = 8.47842766036889956997e-32;
const TWO_OVER_PI = 6.36619772367581382433e-01;
const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

const ksin = (r: number): number => {
  const z = r * r;
  return r + r * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
};
const kcos = (r: number): number => {
  const z = r * r;
  return 1 - (0.5 * z - z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6))))));
};

// quadrant (0..3) in `quad`, remainder returned in [-pi/4, pi/4]
let quad = 0;
function reduce(x: number): number {
  if (x > 1e9 || x < -1e9) x %= 6.283185307179586; // huge angles: exact fmod, phase is approximate but deterministic
  const n = Math.round(x * TWO_OVER_PI);
  quad = n - 4 * Math.floor(n / 4);
  return ((x - n * PIO2_1) - n * PIO2_2) - n * PIO2_3 - n * PIO2_3T;
}

export function sin(x: number): number {
  if (x === 0) return x;
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  if (Math.abs(x) < 0.7853981633974483) return ksin(x);
  const r = reduce(x);
  switch (quad) {
    case 0: return ksin(r);
    case 1: return kcos(r);
    case 2: return -ksin(r);
    default: return -kcos(r);
  }
}

export function cos(x: number): number {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  if (Math.abs(x) < 0.7853981633974483) return kcos(x);
  const r = reduce(x);
  switch (quad) {
    case 0: return kcos(r);
    case 1: return -ksin(r);
    case 2: return -kcos(r);
    default: return ksin(r);
  }
}

export const tan = (x: number): number => sin(x) / cos(x);

const ATAN_HI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];

export function atan(x: number): number {
  if (x !== x) return NaN;
  const neg = x < 0;
  let a = neg ? -x : x;
  if (a >= 7.378697629483821e19) return neg ? -(ATAN_HI[3] + ATAN_LO[3]) : ATAN_HI[3] + ATAN_LO[3];
  let id = -1;
  if (a >= 0.4375) {
    if (a < 1.1875) {
      if (a < 0.6875) { id = 0; a = (2 * a - 1) / (2 + a); } else { id = 1; a = (a - 1) / (a + 1); }
    } else if (a < 2.4375) { id = 2; a = (a - 1.5) / (1 + 1.5 * a); } else { id = 3; a = -1 / a; }
  }
  const z = a * a, w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  const r = id < 0 ? a - a * (s1 + s2) : ATAN_HI[id] - ((a * (s1 + s2) - ATAN_LO[id]) - a);
  return neg ? -r : r;
}

const PI_HI = 3.14159265358979311600e+00, PI_LO = 1.22464679914735317723e-16;

export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN;
  const yneg = y < 0 || (y === 0 && 1 / y < 0), xneg = x < 0 || (x === 0 && 1 / x < 0);
  if (y === 0) return xneg ? (yneg ? -PI_HI : PI_HI) : y; // atan2(+-0, -0) = +-pi
  if (x === 0) return yneg ? -1.5707963267948966 : 1.5707963267948966;
  if (x === Infinity || x === -Infinity) {
    if (y === Infinity || y === -Infinity) return (xneg ? 3 : 1) * 0.7853981633974483 * (yneg ? -1 : 1);
    return xneg ? (yneg ? -PI_HI : PI_HI) : yneg ? -0 : 0;
  }
  if (y === Infinity || y === -Infinity) return yneg ? -1.5707963267948966 : 1.5707963267948966;
  const a = atan(Math.abs(y / x));
  const r = xneg ? PI_HI - (a - PI_LO) : a;
  return yneg ? -r : r;
}

export function asin(x: number): number {
  if (!(Math.abs(x) <= 1)) return NaN;
  return atan2(x, Math.sqrt((1 - x) * (1 + x)));
}

export function acos(x: number): number {
  if (!(Math.abs(x) <= 1)) return NaN;
  return atan2(Math.sqrt((1 - x) * (1 + x)), x);
}

/** x^y with JS semantics (pow(x, 0) = 1, even for NaN). */
export function pow(x: number, y: number): number {
  if (y === 0) return 1;
  const yInt = Math.floor(y) === y;
  if (yInt && y >= -64 && y <= 64) { // small integers: repeated squaring (exact where representable)
    let n = y < 0 ? -y : y, b = x, r = 1;
    while (n > 0) { if (n & 1) r *= b; b *= b; n = n >> 1; }
    return y < 0 ? 1 / r : r;
  }
  if (x > 0 && x < Infinity && y > -Infinity && y < Infinity) return exp(y * log(x));
  if (x !== x || y !== y) return NaN;
  const odd = yInt && Math.abs(y) < 9007199254740992 && y % 2 !== 0;
  if (y === Infinity || y === -Infinity) {
    const a = Math.abs(x);
    if (a === 1) return NaN;
    return (a > 1) === (y > 0) ? Infinity : 0;
  }
  if (x === 0 || x === Infinity || x === -Infinity) {
    const neg = (x < 0 || (x === 0 && 1 / x < 0)) && odd;
    const big = (x === 0) === (y < 0); // 0^neg and inf^pos are infinite
    return big ? (neg ? -Infinity : Infinity) : neg ? -0 : 0;
  }
  // x < 0
  if (!yInt) return NaN;
  const r = exp(y * log(-x));
  return odd ? -r : r;
}

/** Code-unit string order: identical on every engine, unlike locale collation. */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
