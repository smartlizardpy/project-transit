// Simulated traffic profile. These are ESTIMATES generated from road class and
// time of day — not measured or live traffic data.

const gauss = (x: number, mu: number, sigma: number) => Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));

/** City-wide congestion level 0..1 for an hour of day (0..24). */
export function congestionAt(hour: number): number {
  const morning = 0.62 * gauss(hour, 8.3, 1.15);
  const evening = 0.72 * gauss(hour, 18.1, 1.5);
  const midday = 0.3 * gauss(hour, 13.3, 2.6);
  const night = hour < 5.5 || hour > 23 ? -0.08 : 0;
  return Math.max(0.04, Math.min(1, 0.12 + morning + evening + midday + night));
}

const CLASS_WEIGHT = [1.15, 1.2, 1.12, 1.0, 0.9, 0.62, 0.35, 0.8];

/** Congestion of a single road edge (0 free-flowing .. 1 jammed). */
export function edgeCongestion(edgeId: number, classIndex: number, hour: number): number {
  let h = (edgeId * 2654435761) >>> 0;
  h ^= h >>> 13;
  const noise = (h % 1000) / 1000; // 0..1
  // neighbouring edges are correlated in blocks of ~12
  let b = (Math.floor(edgeId / 12) * 40503) >>> 0;
  b ^= b >>> 7;
  const block = (b % 1000) / 1000;
  const c = congestionAt(hour) * (CLASS_WEIGHT[classIndex] ?? 0.6) * (0.45 + 0.75 * block + 0.3 * noise);
  return Math.max(0, Math.min(1, c));
}

export function congestionLabel(c: number): 'Free flowing' | 'Moderate' | 'Heavy' | 'Standstill' {
  if (c < 0.35) return 'Free flowing';
  if (c < 0.6) return 'Moderate';
  if (c < 0.82) return 'Heavy';
  return 'Standstill';
}
