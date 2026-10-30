// "Every route is your decision": a small map in the game's colours with a finished line on
// it: numbered stops, the route along the streets, the depot, two buses and the timetable.
// Drawn, not captured, and static.

const W = 720;
const H = 460;
const VX = [70, 190, 310, 430, 550, 670];
const HY = [90, 200, 310, 410];

// the line, on the streets above
const PTS: [number, number][] = [
  [70, 410],
  [310, 410],
  [310, 200],
  [550, 200],
  [550, 90],
  [670, 90],
];
const ROUTE = 'M70 410 H310 V200 H550 V90 H670';
const SEG = PTS.slice(1).map((p, i) => Math.hypot(p[0] - PTS[i][0], p[1] - PTS[i][1]));
const CUM = SEG.reduce<number[]>((a, l) => [...a, a[a.length - 1] + l], [0]);
const TOTAL = CUM[CUM.length - 1];
const STOP_S = [30, 330, 590, TOTAL - 30];

function at(s: number): [number, number] {
  const c = Math.max(0, Math.min(TOTAL, s));
  for (let i = 0; i < SEG.length; i++) {
    if (c <= CUM[i + 1]) {
      const f = (c - CUM[i]) / SEG[i];
      return [PTS[i][0] + (PTS[i + 1][0] - PTS[i][0]) * f, PTS[i][1] + (PTS[i + 1][1] - PTS[i][1]) * f];
    }
  }
  return PTS[PTS.length - 1];
}

/** Heading in degrees, 0 = up the page, following the line forwards. */
function heading(s: number) {
  const a = at(s - 9);
  const b = at(s + 9);
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 90;
}

const STOPS = STOP_S.map(at);
// stop pins stand at the roadside, to the left of the line going out
const PINS = STOP_S.map((s, i) => {
  const [x, y] = STOPS[i];
  const r = ((heading(s) - 90) * Math.PI) / 180;
  return [x + Math.sin(r) * 28, y - Math.cos(r) * 28] as [number, number];
});

/** A bus on the line at distance `s`, keeping to the right of the road. */
function busAt(s: number, back: boolean) {
  const angle = heading(s) + (back ? 180 : 0);
  const [x, y] = at(s);
  const r = (angle * Math.PI) / 180;
  return { x: x + Math.cos(r) * 6, y: y + Math.sin(r) * 6, angle };
}
const BUSES = [busAt(190, false), busAt(700, true)];
// people waiting at each stop
const WAITING = [2, 1, 3, 0];

export const ROUTE_STEPS = [
  {
    title: 'Place the stops',
    body: 'Click stop spots along the street: real bus stops from OpenStreetMap, plus spots every 300 metres or so on main roads where none are mapped.',
  },
  {
    title: 'Draw the line',
    body: 'The route follows real streets and one-way rules. Shift-click to send it down a particular street, make it a loop, or give it its own way back.',
  },
  {
    title: 'Assign the buses',
    body: 'Buy from six models, from a 34-place minibus to a 145-place articulated bus, and give the line as many as it needs.',
  },
  {
    title: 'Write the timetable',
    body: 'Set how often buses run at each time of day. The editor shows how many buses each frequency needs before you commit.',
  },
  {
    title: 'Watch, then adjust',
    body: 'Every line reports its riders, punctuality, crowding and profit, so you can see what to fix next.',
  },
];

// buildings: a block between each pair of streets, split into a few houses
type Rect = { x: number; y: number; w: number; h: number };
const BLOCKS: { block: Rect; houses: Rect[] }[] = [];
const PARK = { x: 70, y: 200, w: 120, h: 110 };
{
  const xs = [-40, ...VX, W + 40];
  const ys = [-40, ...HY, H + 40];
  let n = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const x0 = xs[i] + 12;
      const y0 = ys[j] + 12;
      const w = xs[i + 1] - xs[i] - 24;
      const h = ys[j + 1] - ys[j] - 24;
      if (xs[i] === PARK.x && ys[j] === PARK.y) continue;
      n++;
      const split = 2 + (n % 3);
      const houses: Rect[] = [];
      const horiz = w > h;
      for (let k = 0; k < split; k++) {
        const g = 5;
        if (horiz) {
          const hw = (w - g * (split + 1)) / split;
          const inset = ((n + k) % 3) * 4;
          houses.push({ x: x0 + g + k * (hw + g), y: y0 + g + inset, w: hw, h: h - 2 * g - inset });
        } else {
          const hh = (h - g * (split + 1)) / split;
          const inset = ((n + k) % 3) * 4;
          houses.push({ x: x0 + g + inset, y: y0 + g + k * (hh + g), w: w - 2 * g - inset, h: hh });
        }
      }
      BLOCKS.push({ block: { x: x0, y: y0, w, h }, houses });
    }
  }
}
const TREES = [
  [96, 232, 11],
  [126, 222, 9],
  [158, 240, 12],
  [104, 270, 10],
  [146, 282, 9],
  [168, 268, 7],
];
const WATER = 'M430 470 C 492 404 586 368 730 346 L 730 470 Z';

function BusShape() {
  return (
    <>
      <rect x={-9} y={-19} width={18} height={38} rx={5} fill="#e0573e" />
      <rect x={-6} y={-14.5} width={12} height={6.5} rx={2} fill="#fff" opacity={0.92} />
      <rect x={-6} y={-4} width={12} height={17} rx={2} fill="#fff" opacity={0.3} />
      <rect x={-9} y={-19} width={18} height={38} rx={5} fill="none" stroke="#a83a26" strokeWidth={1} opacity={0.5} />
    </>
  );
}

export function RouteSketch() {
  return (
    <div className="route-sketch">
      <div className="sketch-card">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Drawing: four numbered stops on a small city map, a teal bus line joining them along the streets from the depot, two buses on it, and a timetable of every 10 minutes.">
          <defs>
            <clipPath id="sketch-clip">
              <rect width={W} height={H} rx={22} />
            </clipPath>
            <filter id="sketch-shadow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="1.5" stdDeviation="1.6" floodColor="#18201b" floodOpacity="0.28" />
            </filter>
          </defs>
          <g clipPath="url(#sketch-clip)">
            <rect width={W} height={H} fill="#ebe8e0" />
            {BLOCKS.map((b, i) => (
              <g key={i}>
                <rect x={b.block.x} y={b.block.y} width={b.block.w} height={b.block.h} rx={5} fill="#e2ddd2" />
                {b.houses.map((h, k) => (
                  <rect key={k} x={h.x} y={h.y} width={h.w} height={h.h} rx={2.5} fill={(i + k) % 4 === 0 ? '#d8c6b6' : '#d6d0c4'} />
                ))}
              </g>
            ))}
            <rect x={PARK.x + 12} y={PARK.y + 12} width={PARK.w - 24} height={PARK.h - 24} rx={10} fill="#c9dbbb" />
            {TREES.map(([x, y, r], i) => (
              <circle key={i} cx={x} cy={y} r={r} fill="#a7c592" />
            ))}
            <g stroke="#fbfaf6" strokeLinecap="round">
              {VX.map((x) => (
                <line key={x} x1={x} y1={-10} x2={x} y2={H + 10} strokeWidth={x === 310 ? 15 : 11} />
              ))}
              {HY.map((y) => (
                <line key={y} x1={-10} y1={y} x2={W + 10} y2={y} strokeWidth={y === 200 ? 15 : 11} />
              ))}
            </g>
            <path d={WATER} fill="#a4cad6" />
            <path d={WATER} fill="none" stroke="#bcd8e1" strokeWidth={3} />

            {/* the line */}
            <path d={ROUTE} fill="none" stroke="#fff" strokeWidth={14} strokeLinejoin="round" strokeLinecap="round" />
            <path d={ROUTE} fill="none" stroke="#2f9e9a" strokeWidth={7} strokeLinejoin="round" strokeLinecap="round" />

            {/* depot and line badge */}
            <rect x={24} y={394} width={32} height={32} rx={9} fill="#e0573e" filter="url(#sketch-shadow)" />
            <path d="M31 418 V406 L40 400 L49 406 V418 Z M35 418 V411 H45 V418" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinejoin="round" />
            <rect x={28} y={356} width={24} height={24} rx={6} fill="#2f9e9a" />
            <text x={40} y={373} textAnchor="middle" className="sk-badge-text">
              1
            </text>

            {/* people waiting */}
            {PINS.map(([x, y], i) =>
              Array.from({ length: WAITING[i] }, (_, k) => <circle key={`${i}-${k}`} cx={x + 22 + k * 9} cy={y} r={3.8} fill="#3f4a44" />),
            )}

            {/* stops, numbered in the order you place them */}
            {PINS.map(([x, y], i) => (
              <g key={i}>
                <line x1={x} y1={y} x2={STOPS[i][0]} y2={STOPS[i][1]} stroke="#18201b" strokeWidth={2} opacity={0.35} />
                <circle cx={x} cy={y} r={14} fill="#fff" stroke="#2f9e9a" strokeWidth={3.5} filter="url(#sketch-shadow)" />
                <text x={x} y={y + 5} textAnchor="middle" className="sk-stop-text">
                  {i + 1}
                </text>
              </g>
            ))}

            {/* buses */}
            {BUSES.map((b, i) => (
              <g key={i} transform={`translate(${b.x.toFixed(1)} ${b.y.toFixed(1)}) rotate(${b.angle.toFixed(1)})`} filter="url(#sketch-shadow)">
                <BusShape />
              </g>
            ))}

            {/* the timetable */}
            <rect x={352} y={334} width={178} height={38} rx={11} fill="#161c19" filter="url(#sketch-shadow)" />
            <rect x={362} y={342} width={22} height={22} rx={5} fill="#2f9e9a" />
            <text x={373} y={358} textAnchor="middle" className="sk-badge-text">
              1
            </text>
            <text x={394} y={358} className="sk-pill-text">
              Every 10 min
            </text>
          </g>
        </svg>
      </div>
      <ol className="steps">
        {ROUTE_STEPS.map((s, i) => (
          <li className="step" key={s.title}>
            <span className="step-n" aria-hidden="true">
              {i + 1}
            </span>
            <h3 className="h3">{s.title}</h3>
            <p>{s.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
