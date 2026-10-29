import type { Band } from '../game/types.ts';

export const MIN = 180;
export const MAX = 1620;
export const STEP = 15;

export const sortBands = (b: Band[]) => [...b].sort((a, c) => a.from - c.from);

/** Add a 1h band around `minute`, fitted into the surrounding gap. Returns new bands and the index of the new band. */
export function addBandAt(bands: Band[], minute: number, headway = 12): { bands: Band[]; index: number } {
  const s = sortBands(bands);
  let lo = MIN, hi = MAX;
  for (const b of s) {
    if (b.to <= minute) lo = Math.max(lo, b.to);
    if (b.from > minute) { hi = Math.min(hi, b.from); break; }
  }
  const from = Math.max(lo, Math.min(Math.floor(minute / STEP) * STEP, hi - STEP));
  const to = Math.min(hi, from + 60);
  if (to - from < STEP) return { bands: s, index: -1 };
  const nb = sortBands([...s, { from, to, headway }]);
  return { bands: nb, index: nb.findIndex((b) => b.from === from) };
}

/** Split band `i` at its midpoint (rounded to 15 min). */
export function splitBand(bands: Band[], i: number): Band[] {
  const b = bands[i];
  if (!b) return bands;
  const mid = Math.round((b.from + b.to) / 2 / STEP) * STEP;
  if (mid - b.from < STEP || b.to - mid < STEP) return bands;
  const out = [...bands];
  out.splice(i, 1, { ...b, to: mid }, { ...b, from: mid });
  return out;
}

/** Move a band's edges, clamped against neighbours and a minimum length of 15 min. */
export function setBandTimes(bands: Band[], i: number, from: number, to: number): Band[] {
  const b = bands[i];
  if (!b) return bands;
  const lo = i > 0 ? bands[i - 1].to : MIN;
  const hi = i < bands.length - 1 ? bands[i + 1].from : MAX;
  let f = Math.max(lo, Math.min(from, hi - STEP));
  let t = Math.min(hi, Math.max(to, f + STEP));
  f = Math.min(f, t - STEP);
  return bands.map((x, k) => (k === i ? { ...x, from: f, to: t } : x));
}

export function raiseHeadways(bands: Band[], min: number): Band[] {
  return bands.map((b) => ({ ...b, headway: Math.max(b.headway, min) }));
}

export const PRESETS: { id: string; label: string; hint: string; bands: Band[]; additive?: boolean }[] = [
  { id: 'all', label: 'All day', hint: '06:00–23:00 every 12', bands: [{ from: 360, to: 1380, headway: 12 }] },
  { id: 'peaks', label: 'Commuter peaks', hint: '8 min at peaks, 15 between', bands: [
    { from: 360, to: 420, headway: 15 }, { from: 420, to: 600, headway: 8 }, { from: 600, to: 960, headway: 15 },
    { from: 960, to: 1170, headway: 8 }, { from: 1170, to: 1410, headway: 20 } ] },
  { id: 'freq', label: 'Frequent', hint: '05:30–00:30 every 6', bands: [{ from: 330, to: 1470, headway: 6 }] },
  { id: 'night', label: 'Night owl', hint: 'Adds 00:00–03:00 every 30', additive: true, bands: [{ from: 1440, to: 1620, headway: 30 }] },
];

export function applyPreset(current: Band[], id: string): Band[] {
  const p = PRESETS.find((x) => x.id === id)!;
  if (!p.additive) return p.bands.map((b) => ({ ...b }));
  const kept = current.filter((b) => b.to <= p.bands[0].from);
  const last = kept[kept.length - 1];
  if (last && last.to > p.bands[0].from) last.to = p.bands[0].from;
  return [...kept, ...p.bands.map((b) => ({ ...b }))];
}
