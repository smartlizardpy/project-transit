// "Build a company": the operating-areas view, drawn. Owned squares show the city, the
// squares next to them sit under a veil with their licence price, and the map beyond is
// blank. When it scrolls into view the cheapest square is licensed and the map grows.
// Names and prices are from a real Barcelona game (Eixample start).
import { useEffect, useState } from 'react';
import { useInView } from '../components/hooks.ts';

const COLS = 5;
const ROWS = 4;
const CW = 112;
const CH = 96;
const W = COLS * CW;
const H = ROWS * CH;

const START_OWNED = ['1,1', '2,1', '3,1', '1,2', '2,2', '3,2'];
const LABELS: Record<string, { name: string; price: string }> = {
  '1,0': { name: 'Font del Mont', price: '€21.0k' },
  '2,0': { name: 'la Teixonera', price: '€45.0k' },
  '3,0': { name: 'el Guinardó', price: '€58.0k' },
  '0,2': { name: 'les Corts', price: '€89.0k' },
};
const LICENSE = '1,0';

const key = (c: number, r: number) => `${c},${r}`;
const near = (c: number, r: number) => [key(c - 1, r), key(c + 1, r), key(c, r - 1), key(c, r + 1)];

// the city under the squares
const BLOCKS: { x: number; y: number; w: number; h: number; fill: string }[] = [];
for (let x = 0; x < W; x += 28) {
  for (let y = 0; y < H; y += 24) {
    const n = (x * 7 + y * 13) % 11;
    BLOCKS.push({ x: x + 3, y: y + 3, w: 22, h: 18, fill: n < 2 ? '#d8c6b6' : n < 6 ? '#dcd6ca' : '#e3ded3' });
  }
}
const SEA = 'M318 400 C 392 352 478 318 570 300 V400 Z';

export function MapSquares() {
  const [ref, seen] = useInView<HTMLDivElement>(0.45, true);
  const [licensed, setLicensed] = useState(false);

  useEffect(() => {
    if (!seen) return;
    const id = setTimeout(() => setLicensed(true), 1200);
    return () => clearTimeout(id);
  }, [seen]);

  const owned = new Set(licensed ? [...START_OWNED, LICENSE] : START_OWNED);
  const cells: { c: number; r: number; k: string; state: 'owned' | 'veil' | 'blank' }[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const k = key(c, r);
      const state = owned.has(k) ? 'owned' : near(c, r).some((n) => owned.has(n)) ? 'veil' : 'blank';
      cells.push({ c, r, k, state });
    }
  }
  // outline of the company's territory: every owned edge that faces a square it does not own
  const edges: string[] = [];
  for (const { c, r, k } of cells) {
    if (!owned.has(k)) continue;
    const x = c * CW;
    const y = r * CH;
    if (!owned.has(key(c, r - 1))) edges.push(`M${x} ${y} H${x + CW}`);
    if (!owned.has(key(c, r + 1))) edges.push(`M${x} ${y + CH} H${x + CW}`);
    if (!owned.has(key(c - 1, r))) edges.push(`M${x} ${y} V${y + CH}`);
    if (!owned.has(key(c + 1, r))) edges.push(`M${x + CW} ${y} V${y + CH}`);
  }

  return (
    <div className="squares" ref={ref} data-licensed={licensed}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Drawing of the operating areas map: six owned map squares around the depot, neighbouring squares under a veil with licence prices such as Font del Mont for €21.0k, and blank map beyond. Font del Mont is then licensed and the map grows.">
        <defs>
          <clipPath id="squares-clip">
            <rect width={W} height={H} rx={20} />
          </clipPath>
          <pattern id="squares-dots" width={9} height={9} patternUnits="userSpaceOnUse">
            <circle cx={4.5} cy={4.5} r={1} fill="#cbc6b9" />
          </pattern>
        </defs>
        <g clipPath="url(#squares-clip)">
          <rect width={W} height={H} fill="#ebe8e0" />
          {BLOCKS.map((b, i) => (
            <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={2} fill={b.fill} />
          ))}
          <rect x={150} y={118} width={50} height={40} rx={8} fill="#c9dbbb" />
          <rect x={372} y={214} width={44} height={60} rx={8} fill="#c9dbbb" />
          <path d="M-10 350 L570 62" stroke="#fbfaf6" strokeWidth={9} />
          <path d="M-10 214 H570" stroke="#fbfaf6" strokeWidth={7} />
          <path d={SEA} fill="#a4cad6" />

          {cells.map(({ c, r, k, state }) => (
            <g key={k}>
              <rect x={c * CW} y={r * CH} width={CW} height={CH} fill="#ebe8e0" className="sq-veil" opacity={state === 'veil' ? 0.6 : 0} />
              <rect x={c * CW} y={r * CH} width={CW} height={CH} fill="#ebe8e0" className="sq-veil" opacity={state === 'blank' ? 1 : 0} />
              <rect x={c * CW} y={r * CH} width={CW} height={CH} fill="url(#squares-dots)" className="sq-veil" opacity={state === 'blank' ? 1 : 0} />
            </g>
          ))}
          <g stroke="rgba(31, 116, 113, 0.28)" strokeWidth={1}>
            {Array.from({ length: COLS - 1 }, (_, i) => (
              <line key={`c${i}`} x1={(i + 1) * CW} x2={(i + 1) * CW} y1={0} y2={H} />
            ))}
            {Array.from({ length: ROWS - 1 }, (_, i) => (
              <line key={`r${i}`} y1={(i + 1) * CH} y2={(i + 1) * CH} x1={0} x2={W} />
            ))}
          </g>
          <path d={edges.join(' ')} stroke="#2f9e9a" strokeWidth={3.5} strokeLinecap="round" fill="none" />

          {cells.map(({ c, r, k, state }) =>
            LABELS[k] ? (
              <g key={k} className="sq-label" opacity={state === 'veil' ? 1 : 0}>
                <text x={c * CW + CW / 2} y={r * CH + CH / 2 - 3} textAnchor="middle" className="sq-name">
                  {LABELS[k].name}
                </text>
                <text x={c * CW + CW / 2} y={r * CH + CH / 2 + 17} textAnchor="middle" className="sq-price">
                  {LABELS[k].price}
                </text>
              </g>
            ) : null,
          )}

          {/* the depot, at home */}
          <g transform={`translate(${2 * CW + CW / 2} ${2 * CH + CH / 2})`}>
            <rect x={-15} y={-15} width={30} height={30} rx={8} fill="#e0573e" />
            <path d="M-8 8 V-3 L0 -9 L8 -3 V8 Z M-4 8 V2 H4 V8" fill="none" stroke="#fff" strokeWidth={2} strokeLinejoin="round" />
          </g>

          <g className="sq-chip" opacity={licensed ? 1 : 0} transform={`translate(${1 * CW + CW / 2} ${CH / 2})`}>
            <rect x={-72} y={-18} width={144} height={36} rx={10} fill="#161c19" />
            <text x={0} y={5} textAnchor="middle" className="sq-chip-text">
              Licensed, €21.0k
            </text>
          </g>
        </g>
      </svg>
    </div>
  );
}
