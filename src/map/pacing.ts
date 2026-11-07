// Frame pacing for fast screens. The map is redrawn on every k-th screen frame so the rate stays
// near the limit with even spacing: 144 Hz with a 60 limit draws every 2nd frame (72 fps),
// 240 Hz every 4th (60 fps), and a 60 Hz screen draws every frame as before.

export interface Pacer {
  /** Call once per animation frame; true when this frame should be drawn. */
  (now: number, limit: number): boolean;
}

export function createPacer(): Pacer {
  let screenGap = 1000 / 60; // typical time between screen frames, ms (median of the last 30)
  const gaps: number[] = [];
  let prev = 0;
  let frameNo = 0;
  return (now, limit) => {
    if (prev) gaps.push(now - prev);
    prev = now;
    if (gaps.length >= 30) {
      screenGap = gaps.sort((a, b) => a - b)[15];
      gaps.length = 0;
    }
    const every = limit > 0 ? Math.max(1, Math.round(1000 / limit / screenGap)) : 1;
    return ++frameNo % every === 0;
  };
}

/** "ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 (0x00002F04) Direct3D11 vs_5_0 ps_5_0, D3D11)" → "NVIDIA GeForce RTX 5070". */
export function gpuLabel(raw: string): string {
  const m = /^ANGLE \(([^,]*),\s*(.*)\)$/.exec(raw.trim());
  const name = (m ? m[2] : raw)
    .replace(/^ANGLE [^:]*Renderer:\s*/i, '')
    .replace(/\s*\(0x[0-9a-f]+\)/gi, '')
    .replace(/\s+(Direct3D|OpenGL|Vulkan)\S*.*$/i, '')
    .replace(/,\s*(D3D1\d|OpenGL|Vulkan|Metal|Unspecified Version).*$/i, '');
  return name.trim() || raw;
}

/** What kind of graphics the renderer string points to, when it is not a dedicated card. */
export function gpuKind(raw: string): 'software' | 'integrated' | null {
  if (/swiftshader|basic render|llvmpipe|software|\bwarp\b/i.test(raw)) return 'software';
  if (/intel/i.test(raw) && !/\barc\b/i.test(raw)) return 'integrated';
  if (/radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|\b(680|740|760|780|880|890)m\b/i.test(raw)) return 'integrated';
  return null;
}
