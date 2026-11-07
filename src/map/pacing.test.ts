import { describe, expect, it } from 'vitest';
import { createPacer, gpuKind, gpuLabel } from './pacing.ts';

/** frames drawn in 3 s of a screen at `hz`, after the first second (the estimate settles) */
function drawnPerSecond(hz: number, limit: number) {
  const pace = createPacer();
  let drawn = 0;
  for (let i = 0; i < hz * 4; i++) {
    const now = (i * 1000) / hz;
    if (pace(now, limit) && now >= 1000) drawn++;
  }
  return drawn / 3;
}

describe('frame pacing', () => {
  it('keeps a 60 Hz screen at every frame', () => expect(drawnPerSecond(60, 60)).toBeCloseTo(60, 0));
  it('halves 120 Hz and 144 Hz', () => {
    expect(drawnPerSecond(120, 60)).toBeCloseTo(60, 0);
    expect(drawnPerSecond(144, 60)).toBeCloseTo(72, 0);
  });
  it('draws every 4th frame at 240 Hz', () => expect(drawnPerSecond(240, 60)).toBeCloseTo(60, 0));
  it('draws every frame with no limit', () => expect(drawnPerSecond(240, 0)).toBeCloseTo(240, 0));
  it('never skips frames on a slow PC', () => expect(drawnPerSecond(40, 60)).toBeCloseTo(40, 0));
  it('limits to 30', () => expect(drawnPerSecond(144, 30)).toBeCloseTo(28.8, 0));
});

describe('graphics card label', () => {
  it('reads WebView2 / Chrome on Windows', () => {
    const nv = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 (0x00002F04) Direct3D11 vs_5_0 ps_5_0, D3D11)';
    expect(gpuLabel(nv)).toBe('NVIDIA GeForce RTX 5070');
    expect(gpuKind(nv)).toBe(null);
    const intel = 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)';
    expect(gpuLabel(intel)).toBe('Intel(R) UHD Graphics 620');
    expect(gpuKind(intel)).toBe('integrated');
    expect(gpuKind('ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('integrated');
    expect(gpuKind('ANGLE (AMD, AMD Radeon RX 7800 XT (0x0000747E) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(null);
    expect(gpuKind('ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('software');
    expect(gpuKind('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe('software');
  });
  it('reads Chrome on a Mac and WebKit', () => {
    expect(gpuLabel('ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)')).toBe('Apple M3 Pro');
    expect(gpuLabel('Apple GPU')).toBe('Apple GPU');
  });
});
