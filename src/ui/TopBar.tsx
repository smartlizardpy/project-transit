import { useEffect, useRef, useState } from 'react';
import { Pause, Play, FastForward, CaretDoubleRight, ListBullets, MapPin, Wallet, TrendUp, TrendDown, Smiley, SmileyMeh, Bell, Bus, ChartLineUp, Path, GearSix, Buildings, Globe } from '@phosphor-icons/react';
import { sim } from '../sim/sim.ts';
import { congestionAt } from '../sim/traffic.ts';
import { useUI } from '../state/store.ts';
import { useSimMinute } from './hooks.ts';
import { clock, money, weekday } from './format.ts';
import { Tip, LoadBar } from './primitives.tsx';
import { CITIES, flyToCity, currentCityId } from './cities.ts';

export function CompanyLogo({ size = 22 }: { size?: number }) {
  // Original mark: two bridge arches over the water line.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 15.5c1.6-4.2 3.6-6.3 6-6.3s4.4 2.1 6 6.3" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M11.5 15.5c1.3-3 2.8-4.5 4.6-4.5 1.8 0 3.3 1.5 4.4 4.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity="0.72" />
      <path d="M2.5 19.2c1.6 0 1.6-1 3.2-1s1.6 1 3.2 1 1.6-1 3.2-1 1.6 1 3.2 1 1.6-1 3.2-1 1.6 1 3 1" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" opacity="0.85" />
    </svg>
  );
}

function useOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => window.addEventListener('mousedown', h), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', h);
    };
  }, [active, onClose, ref]);
}

export function CompanyCard() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const openPanel = useUI((s) => s.openPanel);
  const notify = useUI((s) => s.notify);
  useOutside(menuRef, () => setOpen(false), open);
  const go = (p: 'lines' | 'fleet' | 'finance') => {
    openPanel(p);
    setOpen(false);
  };
  const city = currentCityId();
  return (
    <>
      <div className="card company">
        <div className="company-logo">
          <CompanyLogo />
        </div>
        <div className="company-text">
          <div className="company-name">Haliç Transit</div>
          <div className="company-meta">
            <MapPin size={13} weight="fill" /> İstanbul · Beyoğlu &amp; Eminönü
          </div>
        </div>
        <div className="company-level has-tip">
          <div className="level-ring">
            <svg width="30" height="30" viewBox="0 0 30 30">
              <circle cx="15" cy="15" r="12.5" fill="none" stroke="#2b352f" strokeWidth="3" />
              <circle cx="15" cy="15" r="12.5" fill="none" stroke="var(--mint)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${0.62 * 78.5} 78.5`} />
            </svg>
            <b>4</b>
          </div>
          <div className="level-meta">
            <b>City operator</b>
            62% to level 5
          </div>
          <Tip label="Company level 4" hint="Reputation grows with satisfied passengers and reliable service." side="below" />
        </div>
        <button className="icon-btn has-tip" onClick={() => setOpen((o) => !o)} aria-label="Menu">
          <ListBullets size={18} weight="bold" />
          <Tip label="Company menu" side="below" />
        </button>
      </div>
      {open && (
        <div className="card menu-pop" ref={menuRef}>
          <button className="menu-item" onClick={() => go('lines')}>
            <Path size={18} /> <span className="grow">Lines &amp; stops</span> <kbd className="key">L</kbd>
          </button>
          <button className="menu-item" onClick={() => go('fleet')}>
            <Bus size={18} /> <span className="grow">Fleet</span> <kbd className="key">G</kbd>
          </button>
          <button className="menu-item" onClick={() => go('finance')}>
            <ChartLineUp size={18} /> <span className="grow">Finances</span> <kbd className="key">M</kbd>
          </button>
          <button className="menu-item" disabled>
            <Buildings size={18} /> <span className="grow">Depots &amp; research</span> <span className="meta">Not in demo</span>
          </button>
          <div className="menu-sep" />
          <div className="menu-title label">Explore another city</div>
          {CITIES.map((c) => (
            <button
              key={c.id}
              className="menu-item"
              onClick={() => {
                flyToCity(c.id);
                setOpen(false);
                if (c.id !== 'istanbul') notify(`${c.name}: real 3D city only. The prototype network runs in Istanbul.`);
              }}
            >
              <span className={`city-dot ${city === c.id ? 'on' : ''}`} />
              <span className="grow">{c.name}</span>
              <span className="meta">{c.note}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <button className="menu-item" disabled>
            <GearSix size={18} /> <span className="grow">Settings</span> <span className="meta">Not in demo</span>
          </button>
        </div>
      )}
    </>
  );
}

const SPEEDS = [
  { v: 0, icon: <Pause size={17} weight="fill" />, label: 'Pause', k: 'Space' },
  { v: 1, icon: <Play size={17} weight="fill" />, label: 'Normal speed', k: '1' },
  { v: 2, icon: <FastForward size={18} weight="fill" />, label: 'Fast', k: '2' },
  { v: 4, icon: <CaretDoubleRight size={18} weight="bold" />, label: 'Fastest', k: '3' },
];

function DayBar() {
  // Congestion profile across the day with a "now" marker.
  const w = 132, h = 18;
  const pts: string[] = [];
  for (let i = 0; i <= 48; i++) {
    const hour = (i / 48) * 24;
    const c = congestionAt(hour);
    pts.push(`${(i / 48) * w},${h - c * (h - 2)}`);
  }
  const now = (sim.hour / 24) * w;
  return (
    <div className="daybar has-tip">
      <div className="daybar-track">
        <svg width={w} height={h}>
          <defs>
            <linearGradient id="dbg" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#ef8f7d" stopOpacity="0.55" />
              <stop offset="1" stopColor="#f0c169" stopOpacity="0.08" />
            </linearGradient>
          </defs>
          <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill="url(#dbg)" />
          <polyline points={pts.join(' ')} fill="none" stroke="#c99a66" strokeWidth="1.2" strokeOpacity="0.8" />
        </svg>
        <div className="daybar-now" style={{ left: now - 1 }} />
      </div>
      <div className="daybar-legend">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      <Tip label="Typical traffic today" hint="Simulated profile: morning and evening peaks slow your buses." side="below" />
    </div>
  );
}

export function TimeControls() {
  useSimMinute();
  const idx = SPEEDS.findIndex((s) => s.v === sim.speed);
  const [h, m] = clock(sim.minutes);
  const paused = sim.speed === 0;
  return (
    <div className="card time">
      <div className="speed-seg">
        <div className={`ind ${paused ? 'paused' : ''}`} style={{ transform: `translateX(${idx * 42}px)` }} />
        {SPEEDS.map((s) => (
          <button key={s.v} className={`has-tip ${s.v === sim.speed ? 'on' : ''}`} onClick={() => sim.setSpeed(s.v)} aria-label={s.label}>
            {s.icon}
            <Tip label={s.label} k={s.k} side="below" />
          </button>
        ))}
      </div>
      <div className="time-readout">
        <div className={`clock ${paused ? 'paused' : ''}`}>
          {h}
          <span className="colon">:</span>
          {m}
        </div>
        <div className="date">
          {weekday(sim.day)} · Day {sim.day}
          {paused && <span className="amber"> · Paused</span>}
        </div>
      </div>
      <DayBar />
    </div>
  );
}

export function Stats() {
  useSimMinute();
  const [satOpen, setSatOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  useOutside(popRef, () => setSatOpen(false), satOpen);
  const openPanel = useUI((s) => s.openPanel);
  const daily = sim.lines.reduce((s, l) => s + l.perf.profitPerDay, 0);
  const sat = 0.74;
  return (
    <>
      <div className="stats">
        <div className="card stats-card">
          <button className="stat has-tip" onClick={() => openPanel('finance')}>
            <div className="stat-icon" style={{ background: 'rgba(143,220,174,0.12)', color: 'var(--mint)' }}>
              <Wallet size={17} weight="fill" />
            </div>
            <div>
              <b className="mint">{money(sim.funds)}</b>
              <span>Balance</span>
            </div>
            <Tip label="Open finances" k="M" side="below" />
          </button>
          <button className="stat has-tip hide-sm" onClick={() => openPanel('finance')}>
            <div className="stat-icon" style={{ background: daily >= 0 ? 'rgba(143,220,174,0.12)' : 'rgba(239,143,125,0.12)', color: daily >= 0 ? 'var(--mint)' : 'var(--coral)' }}>
              {daily >= 0 ? <TrendUp size={17} weight="bold" /> : <TrendDown size={17} weight="bold" />}
            </div>
            <div>
              <b>{money(daily, { sign: true })}</b>
              <span>Profit / day</span>
            </div>
            <Tip label="Operating result, last 24 h" side="below" />
          </button>
          <button className="stat has-tip" onClick={() => setSatOpen((o) => !o)}>
            <div className="stat-icon" style={{ background: 'rgba(240,193,105,0.12)', color: 'var(--amber)' }}>
              <Smiley size={18} weight="fill" />
            </div>
            <div>
              <b>{Math.round(sat * 100)}%</b>
              <span>Satisfaction</span>
            </div>
            <Tip label="Passenger satisfaction" side="below" />
          </button>
        </div>
        <button className="card bell has-tip" onClick={() => useUI.getState().notify('Line 32 is losing money at peak hours. Consider a shorter loop.', 'warn')}>
          <Bell size={20} weight="bold" />
          <span className="dot" />
          <Tip label="Notifications" side="left" />
        </button>
      </div>
      {satOpen && (
        <div className="card sat-pop" ref={popRef}>
          <div className="section-head">
            <div>
              <div className="p-title" style={{ fontSize: 15 }}>Passenger satisfaction</div>
              <div className="p-sub">Whole network · last 24 h</div>
            </div>
            <span className="pill good">Good</span>
          </div>
          <div className="list">
            {[
              { k: 'Waiting time', s: 'avg 7.2 min at stops', v: 0.66, c: 'var(--amber)' },
              { k: 'Journey time', s: 'avg 14 min · target 16', v: 0.93, c: 'var(--green)' },
              { k: 'Space on board', s: 'avg occupancy 41%', v: 0.88, c: 'var(--green)' },
              { k: 'Reliability', s: '86% on time', v: 0.58, c: 'var(--amber)' },
            ].map((r) => (
              <div className="section tight" key={r.k}>
                <div className="row" style={{ minHeight: 0 }}>
                  <span>{r.k}</span>
                  <span className="v" style={{ color: r.c }}>{Math.round(r.v * 100)}%</span>
                </div>
                <div className="row" style={{ minHeight: 22 }}>
                  <span className="k" style={{ fontSize: 12 }}>{r.s}</span>
                </div>
                <LoadBar value={r.v} solid colour={r.c} marker={false} />
              </div>
            ))}
          </div>
          <div className="issue" style={{ marginTop: 8 }}>
            <SmileyMeh size={16} weight="fill" />
            Riders on line 32 wait too long at Unkapanı. Prototype data.
          </div>
        </div>
      )}
    </>
  );
}

export function GlobeIcon() {
  return <Globe size={18} />;
}
