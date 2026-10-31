// Baked NASA POWER climate statistics (scripts/data/build-climate.mjs).
import { describe, expect, it } from 'vitest';
import climate from '../../data/climate.json';

const F = climate.fields;
const at = (f: string) => F.indexOf(f);
const RANGES: Record<string, [number, number]> = {
  wet: [0, 1], ww: [0, 1], heavy: [0, 1], rain: [0, 120], snow: [0, 1],
  tx: [-50, 55], txSd: [0, 15], tn: [-60, 40], tnSd: [0, 15], hot: [0, 1], cold: [0, 1], ar: [-0.2, 1],
};

describe('climate data', () => {
  it('has the documented shape and licence note', () => {
    expect(F).toEqual(['wet', 'ww', 'heavy', 'rain', 'snow', 'tx', 'txSd', 'tn', 'tnSd', 'hot', 'cold', 'ar']);
    expect(climate.licence).toContain('CC BY 4.0');
    expect(climate.stations.length).toBeGreaterThan(200);
  });

  it('every station has 12 x 12 finite plausible numbers', () => {
    for (const [id, , lat, lon, cc, months] of climate.stations as [string, string, number, number, string, number[][]][]) {
      expect(lat).toBeGreaterThanOrEqual(-90); expect(lat).toBeLessThanOrEqual(90);
      expect(lon).toBeGreaterThanOrEqual(-180); expect(lon).toBeLessThanOrEqual(180);
      expect(typeof cc).toBe('string');
      expect(id.startsWith('power:'), id).toBe(true);
      expect(months, id).toHaveLength(12);
      for (const row of months) {
        expect(row, id).toHaveLength(12);
        F.forEach((f, i) => {
          expect(Number.isFinite(row[i]), `${id} ${f}`).toBe(true);
          expect(row[i], `${id} ${f}`).toBeGreaterThanOrEqual(RANGES[f][0]);
          expect(row[i], `${id} ${f}`).toBeLessThanOrEqual(RANGES[f][1]);
        });
      }
    }
  });

  it('presets point at stations; Istanbul is wetter in January than July', () => {
    const byId = new Map((climate.stations as [string, ...unknown[]][]).map((s) => [s[0], s]));
    for (const id of ['istanbul-galata', 'durham', 'barcelona-eixample', 'hamburg-altstadt', 'tokyo-shibuya']) {
      expect(byId.has((climate.presets as Record<string, string>)[id]), id).toBe(true);
    }
    // Preset points sit at the preset centres (src/app/presets.ts).
    const centres: Record<string, [number, number]> = {
      'istanbul-galata': [41.0262, 28.9766], durham: [54.7745, -1.5752], 'barcelona-eixample': [41.391, 2.165],
      'hamburg-altstadt': [53.549, 9.985], 'tokyo-shibuya': [35.6595, 139.7005],
    };
    for (const [k, [la, lo]] of Object.entries(centres)) {
      const st = byId.get((climate.presets as Record<string, string>)[k])!;
      expect(Math.hypot(st[2] as number - la, st[3] as number - lo), k).toBeLessThan(0.01);
    }
    const ist = byId.get(climate.presets['istanbul-galata'])![5] as number[][];
    expect(ist[0][at('wet')]).toBeGreaterThan(ist[6][at('wet')]);
    expect(ist[6][at('tx')]).toBeGreaterThan(ist[0][at('tx')] + 10);
  });
});
