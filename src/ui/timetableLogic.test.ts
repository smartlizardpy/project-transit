import { describe, expect, it } from 'vitest';
import { addBandAt, splitBand, setBandTimes, applyPreset } from './timetableLogic.ts';

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
