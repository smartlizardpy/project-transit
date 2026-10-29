export function money(n: number, opts: { sign?: boolean; compact?: boolean } = {}): string {
  const { sign = false, compact = true } = opts;
  const s = n < 0 ? '−' : sign ? '+' : '';
  const a = Math.abs(n);
  let body: string;
  if (compact && a >= 1_000_000) body = `${(a / 1_000_000).toFixed(a >= 10_000_000 ? 2 : 2)}M`;
  else if (compact && a >= 10_000) body = `${(a / 1000).toFixed(1)}k`;
  else body = Math.round(a).toLocaleString('en-GB');
  return `${s}₺${body}`;
}

export function clock(minutes: number): [string, string] {
  const m = Math.floor(minutes) % (24 * 60);
  return [String(Math.floor(m / 60)).padStart(2, '0'), String(m % 60).padStart(2, '0')];
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function weekday(day: number): string {
  return DAYS[(day + 1) % 7];
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function km(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
