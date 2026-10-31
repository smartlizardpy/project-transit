// A small, safe expression language for custom metrics and automation (Expression API v1).
//
// Expressions are parsed into a tree and evaluated by this interpreter: no `eval`, no
// `Function`, no access to JavaScript objects, the file system, the network, Tauri or the DOM.
// Only the values passed in as variables and the functions listed in FUNCTIONS are reachable.
// Every evaluation has a step budget, and strings and lists have size limits, so a player's
// expression cannot hang or bloat the game.
//
//   revenue / vehicleHours            occupancy > 0.8 and waiting >= 20
//   line.number == "12" ? 1 : 0       round(avg(pluck(lines, "occupancy")) * 100, 1)

export type EValue = null | number | string | boolean | EValue[] | { [k: string]: EValue };

export const EXPR_API_VERSION = 1;
export const LIMITS = { source: 2000, nodes: 400, steps: 20_000, list: 500, string: 1000, depth: 40 };

export class ExprError extends Error {
  readonly at: number;
  constructor(message: string, at = -1) {
    super(message);
    this.at = at;
  }
}

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'lit'; v: boolean | null }
  | { k: 'var'; name: string; at: number }
  | { k: 'list'; items: Node[] }
  | { k: 'get'; obj: Node; key: Node; at: number }
  | { k: 'call'; name: string; args: Node[]; at: number }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node; at: number }
  | { k: 'if'; c: Node; a: Node; b: Node };

// ───────────────────────────────────────────── tokenizer

interface Tok { t: 'num' | 'str' | 'id' | 'op' | 'end'; v: string; at: number }

const OPS = ['**', '==', '!=', '<=', '>=', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '!', '(', ')', '[', ']', ',', '.', '?', ':'];

function tokenize(src: string): Tok[] {
  if (src.length > LIMITS.source) throw new ExprError(`Expressions can be at most ${LIMITS.source} characters.`);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const at = i;
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      if (src[j] === 'e' || src[j] === 'E') {
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const text = src.slice(i, j).replace(/_/g, '');
      if (!/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) throw new ExprError(`"${src.slice(i, j)}" is not a number.`, at);
      out.push({ t: 'num', v: text, at });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { j++; s += src[j] === 'n' ? '\n' : src[j]; }
        else s += src[j];
        j++;
      }
      if (j >= src.length) throw new ExprError('A text value is missing its closing quote.', at);
      out.push({ t: 'str', v: s, at });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j), at });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`Unexpected "${c}".`, at);
    out.push({ t: 'op', v: op, at });
    i += op.length;
  }
  out.push({ t: 'end', v: '', at: src.length });
  return out;
}

// ───────────────────────────────────────────── parser (precedence climbing)

const WORD_OPS: Record<string, string> = { and: '&&', or: '||', not: '!' };
const BIN: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '**': 8 };

class Parser {
  private i = 0;
  nodes = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  private peek() { return this.toks[this.i]; }
  private next() { return this.toks[this.i++]; }
  private opOf(t: Tok): string | null {
    if (t.t === 'op') return t.v;
    if (t.t === 'id' && Object.hasOwn(WORD_OPS, t.v)) return WORD_OPS[t.v];
    return null;
  }
  private expect(v: string) {
    const t = this.next();
    if (t.t !== 'op' || t.v !== v) throw new ExprError(t.t === 'end' ? `Expected "${v}" before the end.` : `Expected "${v}" but found "${t.v}".`, t.at);
  }
  private count(depth: number) {
    if (++this.nodes > LIMITS.nodes) throw new ExprError('This expression is too long.');
    if (depth > LIMITS.depth) throw new ExprError('This expression is nested too deeply.');
  }
  parse(): Node {
    const n = this.ternary(0);
    const t = this.peek();
    if (t.t !== 'end') throw new ExprError(`Unexpected "${t.v}".`, t.at);
    return n;
  }
  private ternary(d: number): Node {
    const c = this.binary(0, d);
    if (this.peek().t === 'op' && this.peek().v === '?') {
      this.next();
      const a = this.ternary(d + 1);
      this.expect(':');
      const b = this.ternary(d + 1);
      this.count(d);
      return { k: 'if', c, a, b };
    }
    return c;
  }
  private binary(min: number, d: number): Node {
    let left = this.unary(d);
    for (;;) {
      const t = this.peek();
      const op = this.opOf(t);
      if (!op || !Object.hasOwn(BIN, op) || BIN[op] < min) break;
      this.next();
      const prec = BIN[op];
      // ** is right-associative
      const right = this.binary(op === '**' ? prec : prec + 1, d + 1);
      this.count(d);
      left = { k: 'bin', op, a: left, b: right, at: t.at };
    }
    return left;
  }
  private unary(d: number): Node {
    const t = this.peek();
    const op = this.opOf(t);
    if (op === '!' || op === '-' || op === '+') {
      this.next();
      this.count(d);
      return { k: 'un', op, a: this.unary(d + 1) };
    }
    return this.postfix(d);
  }
  private postfix(d: number): Node {
    let n = this.primary(d);
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && t.v === '.') {
        this.next();
        const name = this.next();
        if (name.t !== 'id') throw new ExprError('Expected a field name after ".".', name.at);
        this.count(d);
        n = { k: 'get', obj: n, key: { k: 'str', v: name.v }, at: name.at };
      } else if (t.t === 'op' && t.v === '[') {
        this.next();
        const key = this.ternary(d + 1);
        this.expect(']');
        this.count(d);
        n = { k: 'get', obj: n, key, at: t.at };
      } else return n;
    }
  }
  private primary(d: number): Node {
    const t = this.next();
    this.count(d);
    if (t.t === 'num') return { k: 'num', v: Number(t.v) };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (Object.hasOwn(WORD_OPS, t.v)) throw new ExprError(`"${t.v}" needs a value on each side.`, t.at);
      if (this.peek().t === 'op' && this.peek().v === '(') {
        this.next();
        const args: Node[] = [];
        if (!(this.peek().t === 'op' && this.peek().v === ')')) {
          for (;;) {
            args.push(this.ternary(d + 1));
            if (this.peek().t === 'op' && this.peek().v === ',') { this.next(); continue; }
            break;
          }
        }
        this.expect(')');
        const fn = Object.hasOwn(FUNCTIONS, t.v) ? FUNCTIONS[t.v] : null;
        if (!fn) throw new ExprError(`There is no function called "${t.v}".`, t.at);
        if (args.length < fn.min || args.length > fn.max) throw new ExprError(`${t.v}() takes ${fn.min === fn.max ? fn.min : `${fn.min} to ${fn.max}`} value${fn.max === 1 ? '' : 's'}.`, t.at);
        return { k: 'call', name: t.v, args, at: t.at };
      }
      return { k: 'var', name: t.v, at: t.at };
    }
    if (t.t === 'op' && t.v === '(') {
      const n = this.ternary(d + 1);
      this.expect(')');
      return n;
    }
    if (t.t === 'op' && t.v === '[') {
      const items: Node[] = [];
      if (!(this.peek().t === 'op' && this.peek().v === ']')) {
        for (;;) {
          items.push(this.ternary(d + 1));
          if (this.peek().t === 'op' && this.peek().v === ',') { this.next(); continue; }
          break;
        }
      }
      this.expect(']');
      return { k: 'list', items };
    }
    throw new ExprError(t.t === 'end' ? 'The expression ends too early.' : `Unexpected "${t.v}".`, t.at);
  }
}

// ───────────────────────────────────────────── functions

interface Ctx { steps: number }
type Fn = { min: number; max: number; doc: string; run: (args: EValue[], ctx: Ctx) => EValue };

const num = (v: EValue): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : null);
const list = (v: EValue, fn: string): EValue[] => {
  if (!Array.isArray(v)) throw new ExprError(`${fn}() needs a list.`);
  return v;
};
const nums = (v: EValue, fn: string) => list(v, fn).map(num).filter((x): x is number => x !== null);
const tick = (ctx: Ctx, n: number) => {
  ctx.steps += n;
  if (ctx.steps > LIMITS.steps) throw new ExprError('This expression took too many steps and was stopped.');
};
const clean = (x: number) => (Number.isFinite(x) ? x : null);

export const FUNCTIONS: Record<string, Fn> = {
  min: { min: 1, max: 20, doc: 'Smallest number (of the values, or of a list).', run: (a, c) => { const v = a.length === 1 && Array.isArray(a[0]) ? nums(a[0], 'min') : a.map(num).filter((x): x is number => x !== null); tick(c, v.length); return v.length ? Math.min(...v) : null; } },
  max: { min: 1, max: 20, doc: 'Largest number (of the values, or of a list).', run: (a, c) => { const v = a.length === 1 && Array.isArray(a[0]) ? nums(a[0], 'max') : a.map(num).filter((x): x is number => x !== null); tick(c, v.length); return v.length ? Math.max(...v) : null; } },
  abs: { min: 1, max: 1, doc: 'Absolute value.', run: ([x]) => { const n = num(x); return n === null ? null : Math.abs(n); } },
  round: { min: 1, max: 2, doc: 'Round, optionally to a number of decimals: round(x, 1).', run: ([x, d]) => { const n = num(x); if (n === null) return null; const k = Math.max(0, Math.min(6, Math.floor(num(d ?? 0) ?? 0))); const f = 10 ** k; return Math.round(n * f) / f; } },
  floor: { min: 1, max: 1, doc: 'Round down.', run: ([x]) => { const n = num(x); return n === null ? null : Math.floor(n); } },
  ceil: { min: 1, max: 1, doc: 'Round up.', run: ([x]) => { const n = num(x); return n === null ? null : Math.ceil(n); } },
  sqrt: { min: 1, max: 1, doc: 'Square root.', run: ([x]) => { const n = num(x); return n === null || n < 0 ? null : Math.sqrt(n); } },
  clamp: { min: 3, max: 3, doc: 'Keep x between lo and hi: clamp(x, lo, hi).', run: ([x, lo, hi]) => { const n = num(x), a = num(lo), b = num(hi); return n === null || a === null || b === null ? null : Math.max(a, Math.min(b, n)); } },
  ratio: { min: 2, max: 2, doc: 'a / b, or null when b is 0.', run: ([a, b]) => { const x = num(a), y = num(b); return x === null || y === null || y === 0 ? null : x / y; } },
  pct: { min: 2, max: 2, doc: 'a as a percentage of b.', run: ([a, b]) => { const x = num(a), y = num(b); return x === null || y === null || y === 0 ? null : (100 * x) / y; } },
  sum: { min: 1, max: 1, doc: 'Total of a list of numbers.', run: ([l], c) => { const v = nums(l, 'sum'); tick(c, v.length); return v.reduce((s, x) => s + x, 0); } },
  avg: { min: 1, max: 1, doc: 'Average of a list of numbers.', run: ([l], c) => { const v = nums(l, 'avg'); tick(c, v.length); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; } },
  count: { min: 1, max: 1, doc: 'Number of items in a list.', run: ([l]) => list(l, 'count').length },
  len: { min: 1, max: 1, doc: 'Length of a text or list.', run: ([v]) => (typeof v === 'string' || Array.isArray(v) ? v.length : null) },
  pluck: { min: 2, max: 2, doc: 'A field from every record of a list: pluck(lines, "occupancy").', run: ([l, k], c) => { const key = String(k); const v = list(l, 'pluck'); tick(c, v.length); return v.map((x) => (x && typeof x === 'object' && !Array.isArray(x) && Object.hasOwn(x, key) ? x[key] : null)); } },
  first: { min: 1, max: 1, doc: 'First item of a list (or null).', run: ([l]) => list(l, 'first')[0] ?? null },
  last: { min: 1, max: 1, doc: 'Last item of a list (or null).', run: ([l]) => { const v = list(l, 'last'); return v[v.length - 1] ?? null; } },
  contains: { min: 2, max: 2, doc: 'Whether a list or text contains a value.', run: ([h, n], c) => { if (typeof h === 'string') return h.includes(String(n)); const v = list(h, 'contains'); tick(c, v.length); return v.some((x) => x === n); } },
  coalesce: { min: 1, max: 10, doc: 'The first value that is not null.', run: (a) => a.find((x) => x !== null) ?? null },
  if: { min: 3, max: 3, doc: 'if(condition, then, else).', run: ([c, a, b]) => (truthy(c) ? a : b) },
  text: { min: 1, max: 2, doc: 'A number as text, optionally with decimals: text(x, 1).', run: ([x, d]) => { const n = num(x); if (n === null) return x === null ? '' : String(x).slice(0, LIMITS.string); const k = Math.max(0, Math.min(6, Math.floor(num(d ?? 0) ?? 0))); return n.toFixed(k); } },
  concat: { min: 1, max: 10, doc: 'Join texts together.', run: (a) => a.map((x) => (x === null ? '' : typeof x === 'object' ? '' : String(x))).join('').slice(0, LIMITS.string) },
  join: { min: 1, max: 2, doc: 'A list as text, separated by a comma or your own separator: join(pluck(lines, "number"), ", ").', run: ([l, sep], c) => { const v = list(l, 'join'); tick(c, v.length); return v.map((x) => (x === null || typeof x === 'object' ? '' : String(x))).join(sep === null || sep === undefined ? ', ' : String(sep)).slice(0, LIMITS.string); } },
  upper: { min: 1, max: 1, doc: 'Upper-case text.', run: ([x]) => String(x ?? '').toUpperCase() },
  lower: { min: 1, max: 1, doc: 'Lower-case text.', run: ([x]) => String(x ?? '').toLowerCase() },
  number: { min: 1, max: 1, doc: 'Text as a number (or null).', run: ([x]) => { const n = typeof x === 'string' ? Number(x) : num(x); return n === null || !Number.isFinite(n) ? null : n; } },
  isnull: { min: 1, max: 1, doc: 'Whether a value is null.', run: ([x]) => x === null },
};

// ───────────────────────────────────────────── evaluation

export function truthy(v: EValue): boolean {
  if (v === null || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

const BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);

function evalNode(n: Node, vars: Record<string, EValue>, ctx: Ctx): EValue {
  tick(ctx, 1);
  switch (n.k) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'lit': return n.v;
    case 'var':
      if (!Object.hasOwn(vars, n.name)) throw new ExprError(`"${n.name}" is not available here.`, n.at);
      return vars[n.name];
    case 'list': {
      if (n.items.length > LIMITS.list) throw new ExprError('That list is too long.');
      return n.items.map((x) => evalNode(x, vars, ctx));
    }
    case 'get': {
      const o = evalNode(n.obj, vars, ctx);
      const k = evalNode(n.key, vars, ctx);
      if (o === null) return null;
      if (Array.isArray(o)) {
        const i = num(k);
        if (i === null) throw new ExprError('A list position must be a number.', n.at);
        const idx = i < 0 ? o.length + Math.floor(i) : Math.floor(i);
        return o[idx] ?? null;
      }
      if (typeof o === 'object') {
        const key = String(k);
        if (BLOCKED.has(key)) throw new ExprError(`"${key}" is not available.`, n.at);
        return Object.hasOwn(o, key) ? o[key] : null;
      }
      throw new ExprError('Only records and lists have fields.', n.at);
    }
    case 'call': {
      // if() evaluates only the branch it needs
      if (n.name === 'if') return truthy(evalNode(n.args[0], vars, ctx)) ? evalNode(n.args[1], vars, ctx) : evalNode(n.args[2], vars, ctx);
      const args = n.args.map((a) => evalNode(a, vars, ctx));
      return FUNCTIONS[n.name].run(args, ctx);
    }
    case 'un': {
      const a = evalNode(n.a, vars, ctx);
      if (n.op === '!') return !truthy(a);
      const x = num(a);
      if (x === null) return null;
      return n.op === '-' ? -x : x;
    }
    case 'if':
      return truthy(evalNode(n.c, vars, ctx)) ? evalNode(n.a, vars, ctx) : evalNode(n.b, vars, ctx);
    case 'bin': {
      if (n.op === '&&') { const a = evalNode(n.a, vars, ctx); return truthy(a) ? truthy(evalNode(n.b, vars, ctx)) : false; }
      if (n.op === '||') { const a = evalNode(n.a, vars, ctx); return truthy(a) ? true : truthy(evalNode(n.b, vars, ctx)); }
      const a = evalNode(n.a, vars, ctx), b = evalNode(n.b, vars, ctx);
      if (n.op === '==') return equal(a, b);
      if (n.op === '!=') return !equal(a, b);
      if (n.op === '+' && (typeof a === 'string' || typeof b === 'string')) return (String(a ?? '') + String(b ?? '')).slice(0, LIMITS.string);
      if (n.op === '<' || n.op === '<=' || n.op === '>' || n.op === '>=') {
        if (typeof a === 'string' && typeof b === 'string') return n.op === '<' ? a < b : n.op === '<=' ? a <= b : n.op === '>' ? a > b : a >= b;
        const x = num(a), y = num(b);
        if (x === null || y === null) return false; // comparisons with missing data are false
        return n.op === '<' ? x < y : n.op === '<=' ? x <= y : n.op === '>' ? x > y : x >= y;
      }
      const x = num(a), y = num(b);
      if (x === null || y === null) return null; // missing data stays missing
      switch (n.op) {
        case '+': return clean(x + y);
        case '-': return clean(x - y);
        case '*': return clean(x * y);
        case '/': return y === 0 ? null : clean(x / y);
        case '%': return y === 0 ? null : clean(x % y);
        case '**': return clean(x ** y);
      }
      throw new ExprError(`Unknown operator ${n.op}.`, n.at);
    }
  }
}

function equal(a: EValue, b: EValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  return false;
}

export interface Compiled {
  src: string;
  /** variable names the expression reads */
  vars: string[];
  run: (vars: Record<string, EValue>) => EValue;
}

const cache = new Map<string, Compiled>();

/** Parse an expression (cached). Throws ExprError with a readable message. */
export function compile(src: string): Compiled {
  const hit = cache.get(src);
  if (hit) return hit;
  const tree = new Parser(tokenize(src)).parse();
  const names = new Set<string>();
  const walk = (n: Node) => {
    switch (n.k) {
      case 'var': names.add(n.name); break;
      case 'list': n.items.forEach(walk); break;
      case 'get': walk(n.obj); walk(n.key); break;
      case 'call': n.args.forEach(walk); break;
      case 'un': walk(n.a); break;
      case 'bin': walk(n.a); walk(n.b); break;
      case 'if': walk(n.c); walk(n.a); walk(n.b); break;
    }
  };
  walk(tree);
  const c: Compiled = { src, vars: [...names], run: (vars) => evalNode(tree, vars, { steps: 0 }) };
  if (cache.size > 500) cache.clear();
  cache.set(src, c);
  return c;
}

/** Evaluate, never throwing: `{ ok: false, error }` for parse or run errors. */
export function evaluate(src: string, vars: Record<string, EValue>): { ok: true; value: EValue } | { ok: false; error: string; at: number } {
  try {
    return { ok: true, value: compile(src).run(vars) };
  } catch (e) {
    if (e instanceof ExprError) return { ok: false, error: e.message, at: e.at };
    return { ok: false, error: 'This expression could not be evaluated.', at: -1 };
  }
}

/** Check an expression without running it; lists variables it needs that are not offered. */
export function checkExpr(src: string, available: string[]): { ok: true; vars: string[] } | { ok: false; error: string; at: number } {
  try {
    const c = compile(src);
    const missing = c.vars.filter((v) => !available.includes(v));
    if (missing.length) return { ok: false, error: `"${missing[0]}" is not available here. You can use: ${available.slice(0, 12).join(', ')}${available.length > 12 ? '…' : ''}.`, at: -1 };
    return { ok: true, vars: c.vars };
  } catch (e) {
    return { ok: false, error: e instanceof ExprError ? e.message : 'Invalid expression.', at: e instanceof ExprError ? e.at : -1 };
  }
}
