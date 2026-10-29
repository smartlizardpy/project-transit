import { MODEL } from '../game/content.ts';

function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** Original side-view illustration of the company's buses, in its livery. */
export function BusArt({ model, line, lineColour, livery = '#e0573e', width = 280 }: { model: string; line?: string; lineColour?: string; livery?: string; width?: number }) {
  const m = MODEL[model] ?? MODEL.city12;
  const body = m.body;
  const artic = body === 'artic';
  const dd = body === 'dd';
  const L = body === 'mini' ? 168 : body === 'midi' ? 205 : artic ? 300 : dd ? 236 : 248;
  const vb = 320;
  const x0 = (vb - L) / 2;
  const top = dd ? 6 : body === 'mini' ? 32 : 26, bottom = 92, skirt = 74;
  const wheels = artic ? [x0 + 36, x0 + 150, L + x0 - 40] : body === 'mini' ? [x0 + 30, L + x0 - 36] : [x0 + 40, L + x0 - 46];
  const winTop = 38, winBot = 62;
  const joint = artic ? x0 + L * 0.52 : null;
  const doors = artic ? [x0 + L - 58, x0 + L * 0.36, x0 + L * 0.68] : body === 'mini' ? [x0 + L - 52] : m.doors >= 3 ? [x0 + L - 58, x0 + L * 0.45, x0 + 30] : [x0 + L - 58, x0 + L * 0.45];
  const blocked = (a: number, b: number) => doors.some((d) => b > d - 3 && a < d + 23) || (joint !== null && b > joint - 9 && a < joint + 9);
  const windows: [number, number][] = [];
  const winW = 24, gap = 5;
  for (let x = x0 + 34; x + 10 < x0 + L - 62; ) {
    let w = winW;
    while (w > 9 && blocked(x, x + w)) w -= 3;
    if (w > 9 && !blocked(x, x + w)) { windows.push([x, w]); x += w + gap; } else x += 4;
  }
  return (
    <svg width={width} height={width * 0.4} viewBox={`0 0 ${vb} 128`} aria-hidden>
      <defs>
        <linearGradient id="bodyg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e9e6de" />
        </linearGradient>
      </defs>
      {/* roof units */}
      {!dd && <rect x={x0 + L * 0.2} y={top - 7} width={L * 0.24} height={9} rx={3} fill={m.electric ? '#cfe3d8' : '#cfd3cf'} />}
      {artic && <rect x={x0 + L * 0.62} y={top - 6} width={L * 0.16} height={8} rx={3} fill="#cfd3cf" />}
      {m.electric && <rect x={x0 + L * 0.5} y={top - 6} width={L * 0.2} height={8} rx={3} fill="#cfe3d8" />}
      {/* body */}
      <rect x={x0} y={top} width={L} height={bottom - top} rx={10} fill="url(#bodyg)" />
      <path d={`M${x0} ${skirt} H${x0 + L} V${bottom - 8} a8 8 0 0 1 -8 8 H${x0 + 8} a8 8 0 0 1 -8 -8 Z`} fill={livery} />
      <rect x={x0} y={skirt - 3} width={L} height={3} fill={shade(livery, 0.82)} opacity={0.55} />
      {dd && (
        <g>
          <rect x={x0} y={top + 22} width={L} height={5} fill={livery} />
          {Array.from({ length: Math.floor((L - 40) / 29) }, (_, i) => (
            <rect key={i} x={x0 + 10 + i * 29} y={top + 6} width={24} height={14} rx={3} fill="#34444d" />
          ))}
          <path d={`M${x0 + L - 22} ${top + 6} H${x0 + L - 4} a3 3 0 0 1 3 3 V${top + 20} H${x0 + L - 22} Z`} fill="#2f3d45" />
        </g>
      )}
      {/* windscreen + rear */}
      <path d={`M${x0 + L - 30} ${winTop - 6} H${x0 + L - 4} a4 4 0 0 1 4 4 V${skirt - 6} H${x0 + L - 30} Z`} fill="#2f3d45" />
      <rect x={x0 + 6} y={winTop} width={20} height={winBot - winTop} rx={3} fill="#2f3d45" />
      {/* side windows */}
      {windows.map(([x, w]) => (
        <rect key={x} x={x} y={winTop} width={w} height={winBot - winTop} rx={3} fill="#34444d" />
      ))}
      {/* doors */}
      {doors.map((x) => (
        <g key={x}>
          <rect x={x} y={winTop - 2} width={20} height={skirt - winTop - 1} rx={2} fill="#3b4b54" />
          <line x1={x + 10} x2={x + 10} y1={winTop} y2={skirt - 3} stroke="#5d6e77" strokeWidth={1.2} />
        </g>
      ))}
      {joint && <rect x={joint - 6} y={top + 2} width={12} height={bottom - top - 4} rx={3} fill="#2b3136" />}
      {/* destination sign */}
      <rect x={x0 + L - 24} y={top + 3} width={20} height={8} rx={2} fill="#1d2326" />
      {line && <text x={x0 + L - 14} y={top + 9.6} fontSize={7} fontWeight={800} textAnchor="middle" fill="#f6c45a" fontFamily="Figtree">{line}</text>}
      {line && lineColour && (
        <g>
          <rect x={x0 + 34} y={top + 3} width={30} height={8} rx={2} fill="#1d2326" />
          <rect x={x0 + 35.5} y={top + 4.5} width={8} height={5} rx={1} fill={lineColour} />
          <text x={x0 + 54} y={top + 9.4} fontSize={6.5} fontWeight={800} textAnchor="middle" fill="#f6c45a" fontFamily="Figtree">{line}</text>
        </g>
      )}
      {/* lights */}
      <rect x={x0 + L - 5} y={skirt + 4} width={4} height={5} rx={1.5} fill="#ffe8a3" />
      <rect x={x0 + 1} y={skirt + 4} width={4} height={5} rx={1.5} fill="#ff8a6b" />
      {/* wheels */}
      {wheels.map((x) => (
        <g key={x}>
          <circle cx={x} cy={bottom + 2} r={12} fill="#1f2427" />
          <circle cx={x} cy={bottom + 2} r={5.5} fill="#8d969b" />
        </g>
      ))}
    </svg>
  );
}
