// Runs the calibration scenarios and compares them with the recorded baseline.
// Skipped in the normal suite (the balance tests guard the floors there). Run it with
// `pnpm calibrate`, or `CALIBRATE=write pnpm calibrate` to record a new baseline after an
// agreed retune.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FLOORS, SCENARIOS, TOLERANCE, type Metrics } from './calibration.ts';

const mode = process.env.CALIBRATE;
const file = join(import.meta.dirname, 'calibration-baseline.json');

describe.skipIf(!mode)('calibration against the baseline', () => {
  const results: Record<string, Metrics> = {};
  for (const [name, run] of Object.entries(SCENARIOS)) {
    it(name, () => {
      results[name] = run();
    }, 600_000);
  }

  it('stays within the agreed limits', () => {
    const base: Record<string, Metrics> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).scenarios : {};
    const rows: string[] = [];
    const problems: string[] = [];
    for (const [name, m] of Object.entries(results))
      for (const [k, v] of Object.entries(m)) {
        const key = `${name}.${k}`, b = base[name]?.[k];
        const change = b ? (v - b) / Math.abs(b) : null;
        rows.push(`${key.padEnd(30)} ${v.toFixed(2).padStart(10)}   baseline ${b === undefined ? '—' : b.toFixed(2).padStart(10)}   ${change === null ? '' : `${(change * 100).toFixed(1)}%`}`);
        const tol = TOLERANCE[key];
        if (mode !== 'write' && tol !== undefined && change !== null && Math.abs(change) > tol) problems.push(`${key} moved ${(change * 100).toFixed(1)}% (limit ±${tol * 100}%)`);
        const floor = FLOORS[key];
        if (floor && !floor(v)) problems.push(`${key} = ${v.toFixed(2)} fails its floor`);
      }
    console.log(rows.join('\n'));
    if (mode === 'write') writeFileSync(file, JSON.stringify({ recorded: 'see git history', scenarios: results }, null, 2) + '\n');
    expect(problems).toEqual([]);
  });
});
