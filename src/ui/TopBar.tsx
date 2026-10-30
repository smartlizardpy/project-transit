import { useEffect, useRef, useState } from 'react';
import { Pause, Play, FastForward, CaretDoubleRight, CaretRight, ListBullets, MapPin, Wallet, TrendUp, TrendDown, Smiley, SmileyMeh, SmileySad, Bell, Bus, ChartLineUp, Path, Buildings, FloppyDisk, Trophy, Warning } from '@phosphor-icons/react';
import { useUI } from '../state/store.ts';
import { useGameUpdates } from './hooks.ts';
import { Tip, LoadBar } from './primitives.tsx';
import { CompanyMark } from './logos.tsx';
import { hhmm, weekdayOf, WEEKDAYS_LONG, hourOfDay } from '../game/time.ts';
import { window as statWindow, SAT_COMPONENTS } from '../game/progress.ts';
import { dayTotals } from '../game/finance.ts';
import { session, useSession } from '../app/session.ts';
import { focusDepot, focusLine, focusStop, focusVehicle, focusZone } from './camera.ts';
import type { Game } from '../game/engine.ts';
import type { Notification } from '../game/types.ts';

export function useOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void, active: boolean) {
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

export function repTitle(rep: number) {
  return rep < 25 ? 'New operator' : rep < 45 ? 'Local operator' : rep < 65 ? 'Trusted operator' : rep < 82 ? 'City operator' : 'Metropolitan operator';
}

export function CompanyCard() {
  const game = useGameUpdates(1);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const openPanel = useUI((s) => s.openPanel);
  const openModal = useUI((s) => s.openModal);
  const saving = useSession((s) => s.saving);
  const lastSaved = useSession((s) => s.lastSaved);
  useOutside(menuRef, () => setOpen(false), open);
  if (!game) return null;
  const c = game.state.company;
  const rep = c.reputation;
  const go = (p: 'lines' | 'fleet' | 'finance' | 'company') => {
    openPanel(p);
    setOpen(false);
  };
  const r = game.state.region;
  return (
    <>
      <div className="card company">
        <CompanyMark logo={c.logo} colour={c.colour} size={40} />
        <div className="company-text">
          <div className="company-name">{c.name}</div>
          <div className="company-meta">
            <MapPin size={13} weight="fill" /> {r.city}
            {r.area ? ` · ${r.area}` : ''}
          </div>
        </div>
        <button className="company-level has-tip" onClick={() => go('company')}>
          <div className="level-ring">
            <svg width="30" height="30" viewBox="0 0 30 30">
              <circle cx="15" cy="15" r="12.5" fill="none" stroke="#2b352f" strokeWidth="3" />
              <circle cx="15" cy="15" r="12.5" fill="none" stroke="var(--mint)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${(rep / 100) * 78.5} 78.5`} transform="rotate(-90 15 15)" />
            </svg>
            <b>{Math.floor(rep)}</b>
          </div>
          <div className="level-meta">
            <b>{repTitle(rep)}</b>
            Reputation {Math.floor(rep)}/100
          </div>
          <Tip label="Reputation" hint="Grows with satisfied passengers and reliable service. Unlocks new areas and bus models." side="below" />
        </button>
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
            <Bus size={18} /> <span className="grow">Fleet &amp; depots</span> <kbd className="key">G</kbd>
          </button>
          <button className="menu-item" onClick={() => go('finance')}>
            <ChartLineUp size={18} /> <span className="grow">Finances</span> <kbd className="key">M</kbd>
          </button>
          <button className="menu-item" onClick={() => go('company')}>
            <Trophy size={18} /> <span className="grow">Company, goals &amp; areas</span> <kbd className="key">C</kbd>
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={async () => {
              const ok = await session.save('manual');
              if (ok) useUI.getState().notify('Game saved', 'good');
              setOpen(false);
            }}
          >
            <FloppyDisk size={18} /> <span className="grow">{saving ? 'Saving…' : 'Save game'}</span>
            <span className="meta">{lastSaved ? `saved ${new Date(lastSaved).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
          </button>
          <button
            className="menu-item"
            onClick={() => {
              openModal({ kind: 'menu' });
              setOpen(false);
            }}
          >
            <Buildings size={18} /> <span className="grow">Game menu</span> <kbd className="key">Esc</kbd>
          </button>
        </div>
      )}
    </>
  );
}

const SPEED_BUTTONS = [
  { v: 0, icon: <Pause size={17} weight="fill" />, label: 'Pause', k: 'Space' },
  { v: 1, icon: <Play size={17} weight="fill" />, label: 'Normal speed (1 min ≈ 7.5 s)', k: '1' },
  { v: 2, icon: <CaretRight size={18} weight="bold" />, label: 'Fast (1 h ≈ 2 min)', k: '2' },
  { v: 3, icon: <FastForward size={18} weight="fill" />, label: 'Faster (1 h ≈ 30 s)', k: '3' },
  { v: 4, icon: <CaretDoubleRight size={18} weight="bold" />, label: 'Fastest (1 day ≈ 2 min)', k: '4' },
];

function DayBar({ game }: { game: Game }) {
  const w = 132, h = 18;
  const weekend = game.isWeekend(game.t);
  const pts: string[] = [];
  for (let i = 0; i <= 48; i++) {
    const c = Math.min(1, game.traffic.profile((i / 48) * 24, weekend) * game.trafficIntensity);
    pts.push(`${(i / 48) * w},${h - c * (h - 2)}`);
  }
  const now = (hourOfDay(game.t) / 24) * w;
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
      <Tip label={`Typical traffic, ${weekend ? 'weekend' : 'weekday'}`} hint="Simulated estimate, not live data. Peaks slow your buses down." side="below" />
    </div>
  );
}

export function TimeControls() {
  const game = useGameUpdates(4);
  if (!game) return null;
  const speed = game.speed;
  const paused = speed === 0;
  const [hh, mm] = hhmm(game.t).split(':');
  const day = Math.floor(game.t / 86400) + 1;
  const wd = WEEKDAYS_LONG[weekdayOf(game.state.clock.startWeekday, game.t)];
  return (
    <div className="card time">
      <div className="speed-seg five">
        <div className={`ind ${paused ? 'paused' : ''}`} style={{ transform: `translateX(${speed * 38}px)` }} />
        {SPEED_BUTTONS.map((s) => (
          <button key={s.v} className={`has-tip ${s.v === speed ? 'on' : ''}`} onClick={() => game.setSpeed(s.v)} aria-label={s.label} disabled={game.halted && s.v > 0}>
            {s.icon}
            <Tip label={s.label} k={s.k} side="below" />
          </button>
        ))}
      </div>
      <div className="time-readout">
        <div className={`clock ${paused ? 'paused' : ''}`}>
          {hh}
          <span className="colon">:</span>
          {mm}
        </div>
        <div className="date">
          {wd} · Day {day}
          {paused && <span className="amber"> · Paused</span>}
        </div>
      </div>
      <DayBar game={game} />
    </div>
  );
}

function satTone(v: number | null) {
  return v === null ? 'var(--muted)' : v >= 0.72 ? 'var(--mint)' : v >= 0.55 ? 'var(--amber)' : 'var(--coral)';
}

function SatIcon({ v }: { v: number | null }) {
  if (v !== null && v < 0.55) return <SmileySad size={18} weight="fill" />;
  if (v !== null && v < 0.72) return <SmileyMeh size={18} weight="fill" />;
  return <Smiley size={18} weight="fill" />;
}

const COMP_ADVICE = [
  'Passengers wait too long. Run buses more often or add buses to busy lines.',
  'Trips are slow compared with driving. Use fewer detours and avoid congested streets.',
  'Buses are crowded. Add buses at peak times or use larger models.',
  'Buses are not running to time. Allow more layover or assign enough buses for the timetable.',
  'Passengers find the fare expensive. Consider lowering it in Finances.',
];

export function Stats() {
  const game = useGameUpdates(2);
  const [satOpen, setSatOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  useOutside(popRef, () => setSatOpen(false), satOpen);
  useOutside(bellRef, () => setBellOpen(false), bellOpen);
  const openPanel = useUI((s) => s.openPanel);
  if (!game) return null;
  const s = game.state;
  const today = Math.floor(game.t / 86400);
  const tToday = dayTotals(s, today);
  const tYesterday = today > 0 ? dayTotals(s, today - 1) : null;
  const w = statWindow(s, 24);
  const sat = w.satisfaction;
  const status = s.company.status;
  const unread = s.notifications.filter((n) => !n.read).length;
  const balTone = s.finance.balance < 0 || status === 'insolvent' ? 'coral' : status === 'warning' ? 'amber' : 'mint';
  const worst = w.satisfaction !== null ? w.comp.indexOf(Math.min(...w.comp)) : -1;
  return (
    <>
      <div className="stats">
        <div className="card stats-card">
          <button className="stat has-tip" onClick={() => openPanel('finance')}>
            <div className="stat-icon" style={{ background: balTone === 'mint' ? 'rgba(143,220,174,0.12)' : 'rgba(239,143,125,0.14)', color: `var(--${balTone})` }}>
              {balTone === 'mint' ? <Wallet size={17} weight="fill" /> : <Warning size={17} weight="fill" />}
            </div>
            <div>
              <b className={balTone}>{game.money(s.finance.balance)}</b>
              <span>{status === 'insolvent' ? 'Insolvent' : s.finance.balance < 0 ? 'Overdrawn' : 'Balance'}</span>
            </div>
            <Tip label="Open finances" k="M" hint={s.finance.loan ? `Loan outstanding: ${game.money(s.finance.loan)}` : undefined} side="below" />
          </button>
          <button className="stat has-tip hide-sm" onClick={() => openPanel('finance')}>
            <div className="stat-icon" style={{ background: tToday.result >= 0 ? 'rgba(143,220,174,0.12)' : 'rgba(239,143,125,0.12)', color: tToday.result >= 0 ? 'var(--mint)' : 'var(--coral)' }}>
              {tToday.result >= 0 ? <TrendUp size={17} weight="bold" /> : <TrendDown size={17} weight="bold" />}
            </div>
            <div>
              <b>{game.money(tToday.result, { sign: true })}</b>
              <span>Today</span>
            </div>
            <Tip label="Operating result today" hint={tYesterday ? `Yesterday: ${game.money(tYesterday.result, { sign: true })}. Fares minus running costs; purchases excluded.` : 'Fares minus running costs; purchases excluded.'} side="below" />
          </button>
          <button className="stat has-tip" onClick={() => setSatOpen((o) => !o)}>
            <div className="stat-icon" style={{ background: 'rgba(240,193,105,0.12)', color: satTone(sat) }}>
              <SatIcon v={sat} />
            </div>
            <div>
              <b>{sat === null ? '–' : `${Math.round(sat * 100)}%`}</b>
              <span>Satisfaction</span>
            </div>
            <Tip label="Passenger satisfaction" hint="Last 24 hours. Click for the breakdown." side="below" />
          </button>
        </div>
        <button className="card bell has-tip" onClick={() => setBellOpen((o) => !o)} aria-label="Notifications">
          <Bell size={20} weight="bold" />
          {unread > 0 && <span className="dot" />}
          <Tip label="Notifications" side="left" />
        </button>
      </div>
      {satOpen && (
        <div className="card sat-pop" ref={popRef}>
          <div className="section-head">
            <div>
              <div className="p-title" style={{ fontSize: 15 }}>Passenger satisfaction</div>
              <div className="p-sub">Whole network · last 24 h · {w.trips.toLocaleString()} journeys rated</div>
            </div>
            {sat !== null && <span className={`pill ${sat >= 0.72 ? 'good' : sat >= 0.55 ? 'warn' : 'bad'}`}>{sat >= 0.72 ? 'Good' : sat >= 0.55 ? 'Mixed' : 'Poor'}</span>}
          </div>
          {sat === null ? (
            <div className="empty-note">No completed journeys yet. Satisfaction is measured when passengers finish a trip.</div>
          ) : (
            <>
              <div className="list">
                {SAT_COMPONENTS.map((k, i) => {
                  const v = w.comp[i];
                  const detail = [
                    `avg wait ${(w.avgWait / 60).toFixed(1)} min`,
                    'compared with driving the same trip',
                    w.load !== null ? `avg occupancy ${Math.round(w.load * 100)}%` : 'no load data yet',
                    w.ontime !== null ? `${Math.round(w.ontime * 100)}% of departures on time${w.missed ? ` · ${w.missed} missed` : ''}` : 'no departures yet',
                    `fare ${game.money(s.company.fare, { fine: true })}`,
                  ][i];
                  return (
                    <div className="section tight" key={k}>
                      <div className="row" style={{ minHeight: 0 }}>
                        <span>{k}</span>
                        <span className="v" style={{ color: satTone(v) }}>{Math.round(v * 100)}%</span>
                      </div>
                      <div className="row" style={{ minHeight: 22 }}>
                        <span className="k" style={{ fontSize: 12 }}>{detail}</span>
                      </div>
                      <LoadBar value={v} solid colour={satTone(v)} marker={false} />
                    </div>
                  );
                })}
              </div>
              {worst >= 0 && w.comp[worst] < 0.75 && (
                <div className="issue" style={{ marginTop: 8 }}>
                  <SmileyMeh size={16} weight="fill" />
                  {COMP_ADVICE[worst]}
                </div>
              )}
              {w.abandoned > 0 && <div className="p-sub" style={{ marginTop: 8 }}>{w.abandoned.toLocaleString()} passengers gave up waiting in the last 24 h.</div>}
            </>
          )}
        </div>
      )}
      {bellOpen && (
        <div className="card notif-pop" ref={bellRef}>
          <Notifications game={game} onClose={() => setBellOpen(false)} />
        </div>
      )}
    </>
  );
}

function openRef(n: Notification) {
  const ui = useUI.getState();
  const r = n.ref;
  if (!r) return;
  if (r.kind === 'vehicle') {
    ui.select({ kind: 'vehicle', id: r.id });
    focusVehicle(r.id);
  } else if (r.kind === 'route') {
    ui.select({ kind: 'line', id: r.id });
    focusLine(r.id);
  } else if (r.kind === 'stop') {
    ui.select({ kind: 'stop', id: r.id });
    focusStop(r.id);
  } else if (r.kind === 'depot') {
    ui.select({ kind: 'depot', id: r.id });
    focusDepot(r.id);
  } else if (r.kind === 'zone') {
    ui.select({ kind: 'zone', id: r.id });
    focusZone(r.id);
  }
}

function Notifications({ game, onClose }: { game: Game; onClose: () => void }) {
  const list = [...game.state.notifications].reverse().slice(0, 40);
  useEffect(() => {
    // opening the list marks everything read
    return () => {
      for (const n of game.state.notifications) n.read = true;
    };
  }, [game]);
  return (
    <>
      <div className="section-head">
        <div>
          <div className="p-title" style={{ fontSize: 15 }}>Notifications</div>
          <div className="p-sub">{list.length ? 'Most recent first' : 'Nothing yet'}</div>
        </div>
      </div>
      <div className="notif-list">
        {list.map((n) => (
          <button
            key={n.id}
            className={`notif ${n.tone} ${n.read ? '' : 'unread'}`}
            onClick={() => {
              openRef(n);
              if (n.ref) onClose();
            }}
          >
            <span className="notif-dot" />
            <span className="notif-body">
              <b>{n.title}</b>
              {n.body && <span>{n.body}</span>}
            </span>
            <span className="notif-time">
              {hhmm(n.t)}
              <br />
              Day {Math.floor(n.t / 86400) + 1}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
