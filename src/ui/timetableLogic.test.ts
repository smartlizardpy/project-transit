import { describe, expect, it } from 'vitest';
import { addBandAt, splitBand, setBandTimes, applyPreset, newPlan } from './timetableLogic.ts';

describe('timetable logic', () => {
  it('adds within a gap', () => {
    const r = addBandAt([{ from: 420, to: 600, headway: 10 }], 630);
    expect(r.bands[r.index]).toMatchObject({ from: 630, to: 690 });
  });
  it('splits', () => {
    expect(splitBand([{ from: 420, to: 600, headway: 10 }], 0)).toHaveLength(2);
  });
  it('clamps to neighbours', () => {
    const b = [{ from: 420, to: 600, headway: 10 }, { from: 600, to: 700, headway: 10 }];
    expect(setBandTimes(b, 0, 420, 900)[0].to).toBe(600);
  });
  it('night owl keeps existing', () => {
    expect(applyPreset([{ from: 360, to: 1380, headway: 10 }], 'night')).toHaveLength(2);
  });
});

describe('service plan presets', () => {
  const tt = { weekday: { bands: [{ from: 360, to: 1380, headway: 10 }] }, weekend: { bands: [{ from: 420, to: 1380, headway: 20 }] }, layover: 4 };
  it('copies the normal timetable and picks a free id', () => {
    const p = newPlan({ ...tt, plans: [{ ...newPlan(tt, 'manual')! }] }, 'holidays')!;
    expect(p.id).toBe('plan2');
    expect(p.when).toEqual({ kind: 'school_holidays' });
    expect(p.weekday).toEqual(tt.weekday);
    expect(p.weekday).not.toBe(tt.weekday);
    expect(newPlan(tt, 'nope')).toBeNull();
  });
});
