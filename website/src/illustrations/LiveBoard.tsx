// "A city that never stops": the game's LED arrival board, drawn with the game's own
// stylesheet and fed by a tiny made-up timetable so it counts down on the page. The stop
// and destinations are from a real İstanbul save; the times here are illustrative.
import '../../../src/styles/board.css';
import { useEffect, useState } from 'react';
import { useInView } from '../components/hooks.ts';

const START = 8 * 60 + 30; // 08:30, the morning rush
const MS_PER_MINUTE = 1500;

const LINES = [
  { n: '1', colour: '#2f9e9a', every: 8, first: 2, towards: ['Çözüm Noktasi'] },
  { n: '2', colour: '#e3a33b', every: 11, first: 1, towards: ['Unkapanı Köprülü Kavşağı', 'Kabataş'] },
  { n: '3', colour: '#8b6fd6', every: 6, first: 4, towards: ['Sinemasal House', 'Terminates here'] },
];

type Row = { id: string; line: (typeof LINES)[number]; towards: string; eta: number; late: number; load: number };

function arrivals(now: number): Row[] {
  const rows: Row[] = [];
  for (const l of LINES) {
    for (let k = 0; k < 12; k++) {
      const due = START - 20 + l.first + k * l.every;
      const id = `${l.n}-${k}`;
      // mostly on time, a few running late, loads that vary
      const late = [0, 0, 2, 0, 0, 0, 4, 0, 0, 2, 0, 7][(k + Number(l.n) * 5) % 12];
      const eta = due + late;
      if (eta - now < -0.4 || eta - now > 30) continue;
      rows.push({ id, line: l, towards: l.towards[k % l.towards.length], eta, late, load: [0.3, 0.55, 0.8, 0.45, 0.95, 0.2, 0.65][(k + Number(l.n) * 3) % 7] });
    }
  }
  return rows.sort((a, b) => a.eta - b.eta).slice(0, 6);
}

const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;

/** The page's game clock: runs while the board is on screen. */
export function useBoardClock() {
  const [ref, inView] = useInView<HTMLDivElement>(0.2);
  const [now, setNow] = useState(START);
  useEffect(() => {
    if (!inView) return;
    const id = setInterval(() => setNow((t) => t + 250 / MS_PER_MINUTE), 250);
    return () => clearInterval(id);
  }, [inView]);
  return [ref, now] as const;
}

function Pips({ load }: { load: number }) {
  const lit = 1 + Math.floor(load * 5);
  const tone = load > 0.85 ? 'hot' : load > 0.6 ? 'warm' : '';
  return (
    <span className={`bd-pips ${tone}`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className={i < lit ? 'on' : ''} />
      ))}
    </span>
  );
}

export function LiveBoard({ now }: { now: number }) {
  const rows = arrivals(now);
  const gone = LINES.flatMap((l) => Array.from({ length: 12 }, (_, k) => START - 20 + l.first + k * l.every))
    .filter((t) => t <= now - 0.4)
    .reduce((a, b) => Math.max(a, b), START - 6);
  const waiting = 3 + Math.floor((now - gone) * 2.6);
  return (
    <div className="live-board">
      <section className="board" aria-label="Example arrival board for the Galata Köprüsü stop">
        <header className="bd-head">
          <div className="bd-title">
            <span className="bd-stop">Galata Köprüsü</span>
            <span className="bd-clock">{hhmm(now)}</span>
          </div>
          <div className="bd-sub">
            <span>{waiting} waiting</span>
          </div>
        </header>
        <div className="bd-rows">
          {rows.map((r) => {
            const min = r.eta - now;
            const due = min <= 0.5;
            return (
              <div className="bd-row" key={r.id}>
                <span className="bd-line" style={{ ['--c' as string]: r.line.colour }}>
                  {r.line.n}
                </span>
                <span className="bd-dest">
                  <span className="bd-towards">{r.towards}</span>
                  <span className="bd-meta">
                    {r.late >= 2 && <span className={`bd-note ${r.late >= 5 ? 'bad' : 'warn'}`}>+{r.late} late</span>}
                    <Pips load={r.load} />
                  </span>
                </span>
                <span className={`bd-time ${due ? 'due' : ''}`}>
                  {due ? 'Due' : Math.max(1, Math.round(min))}
                  {!due && <small>min</small>}
                </span>
              </div>
            );
          })}
        </div>
        <footer className="bd-foot">Example times. In the game they are predicted from the running simulation.</footer>
      </section>
    </div>
  );
}

// how busy the roads are across a day: quiet nights, a morning and an evening rush
const peak = (h: number, at: number, w: number) => Math.exp(-((h - at) ** 2) / (2 * w * w));
const busy = (h: number) => 0.12 + 0.82 * peak(h, 8.2, 1.1) + 0.7 * peak(h, 17.6, 1.4) + 0.3 * peak(h, 13, 2.6);
const CURVE = Array.from({ length: 97 }, (_, i) => {
  const h = i / 4;
  return `${i === 0 ? 'M' : 'L'}${((h / 24) * 320).toFixed(1)} ${(64 - busy(h) * 56).toFixed(1)}`;
}).join(' ');

export function DayCurve({ now }: { now: number }) {
  const x = (((now / 60) % 24) / 24) * 320;
  return (
    <svg className="day-curve" viewBox="0 0 320 84" role="img" aria-label="A curve of how busy the roads are over a day, peaking in the morning and evening rush, with a marker at the current time.">
      <path d={`${CURVE} L320 64 L0 64 Z`} fill="rgba(255, 181, 71, 0.14)" />
      <path d={CURVE} fill="none" stroke="#ffb547" strokeWidth={2} />
      <line x1={x} x2={x} y1={0} y2={64} stroke="#f3f2ec" strokeWidth={1.5} />
      <circle cx={x} cy={64 - busy(now / 60) * 56} r={4} fill="#f3f2ec" />
      {[0, 6, 12, 18, 24].map((h) => (
        <text key={h} x={(h / 24) * 320} y={80} textAnchor={h === 0 ? 'start' : h === 24 ? 'end' : 'middle'} className="day-curve-label">
          {String(h).padStart(2, '0')}
        </text>
      ))}
    </svg>
  );
}
