import { useState } from 'react';
import { CaretDown, CaretRight } from '@phosphor-icons/react';
import type { Game } from '../game/engine.ts';
import { TRAVELLERS } from '../game/activity/params.ts';
import { BANDS } from '../game/analytics/types.ts';
import { CHARACTER_DAYS, lineCharacter, lineWhere, type DirectionCurve } from '../game/analytics/character.ts';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const hh = (h: number) => String(h).padStart(2, '0');
/** One colour per traveller type, in TRAVELLERS order. */
const TYPE_COLOURS = ['#4fa3e0', '#b58cf0', '#f0c169', '#ef8f7d', '#5fd18e', '#e57fb5', '#6fd3d0', '#c9d36a', '#f2a65a', '#9aa7b8'];
const DIR_COLOURS = ['#4fa3e0', '#f0c169'];

function Fold({ title, hint, open: initial = false, children }: { title: string; hint?: string; open?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(initial);
  const Caret = open ? CaretDown : CaretRight;
  return (
    <div className="section tight lc-fold">
      <button className="lc-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Caret size={12} weight="bold" />
        <span className="label">{title}</span>
        {hint && <span className="faint lc-hint">{hint}</span>}
      </button>
      {open && <div className="lc-body">{children}</div>}
    </div>
  );
}

function Curve({ curves }: { curves: DirectionCurve[] }) {
  const W = 312, H = 84, L = 4, R = 4, T = 6, B = 16;
  const max = Math.max(1, ...curves.flatMap((c) => c.hours));
  const x = (h: number) => L + (h / 23) * (W - L - R);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  return (
    <svg className="lc-curve" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Boardings by hour of the day">
      {[0, 0.5, 1].map((f) => <line key={f} x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} stroke="rgba(255,255,255,0.07)" />)}
      {curves.map((c, i) => (
        <path key={c.pat} d={c.hours.map((v, h) => `${h ? 'L' : 'M'}${x(h).toFixed(1)} ${y(v).toFixed(1)}`).join('')} fill="none" stroke={DIR_COLOURS[i % 2]} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {[0, 6, 12, 18, 23].map((h) => <text key={h} x={x(h)} y={H - 3} textAnchor={h === 0 ? 'start' : h === 23 ? 'end' : 'middle'}>{hh(h)}</text>)}
      <text x={W - R} y={T + 6} textAnchor="end">{`up to ${Math.round(max)} / h`}</text>
    </svg>
  );
}

export function LineCharacter({ game, id }: { game: Game; id: string }) {
  const c = lineCharacter(game, id);
  const need = c.days < 1;
  const dirName = (to: string | null) => (to ? `towards ${to}` : 'round the loop');
  const where = need ? null : lineWhere(game, id);
  const types = c.riders ? c.riders.map((n, i) => ({ i, n })).filter((t) => t.n > 0).sort((a, b) => b.n - a.n) : [];
  const total = types.reduce((s, t) => s + t.n, 0);
  const days = `last ${Math.min(CHARACTER_DAYS, c.days)} day${c.days === 1 ? '' : 's'}`;
  const missing = <div className="pn-note">Nothing recorded for this line yet. These sections fill in after the first full day.</div>;
  const none = (what: string) => <div className="pn-note">{what} appears once this line has carried passengers on a recorded day.</div>;

  if (need) {
    return (
      <div className="section tight lc-fold">
        <div className="label" style={{ marginBottom: 4 }}>Who uses this line</div>
        {missing}
      </div>
    );
  }
  return (
    <>
      <Fold title="Who rides" hint={days} open>
        {total > 0 ? (
          <>
            <div className="lc-bar" role="img" aria-label="Riders by traveller type">
              {types.map((t) => <i key={t.i} style={{ flex: t.n, background: TYPE_COLOURS[t.i % TYPE_COLOURS.length] }} title={`${TRAVELLERS[t.i].label}: ${pct(t.n / total)}`} />)}
            </div>
            <div className="lc-legend">
              {types.slice(0, 5).map((t) => (
                <span key={t.i}><i style={{ background: TYPE_COLOURS[t.i % TYPE_COLOURS.length] }} />{TRAVELLERS[t.i].label}<b className="num">{pct(t.n / total)}</b></span>
              ))}
              {types.length > 5 && <span className="faint">+{types.length - 5} more</span>}
            </div>
          </>
        ) : none('The mix of riders')}
      </Fold>
      <Fold title="Through the day" hint="boardings per hour">
        {c.curves.length ? (
          <>
            <Curve curves={c.curves} />
            {c.split && c.curves.length > 1 && (
              <div className="lc-legend">{c.curves.map((d, i) => <span key={d.pat}><i style={{ background: DIR_COLOURS[i % 2] }} />{dirName(d.to)}</span>)}</div>
            )}
            {c.peaks.length > 0 ? (
              <ul className="lc-list">
                {c.peaks.slice(0, 4).map((p) => (
                  <li key={`${p.pat}-${p.hour}`}>
                    <span>{BANDS[p.band].label} {hh(p.hour)}–{hh(p.hour + 1)}{c.split ? ` ${dirName(p.to)}` : ''}</span>
                    <b className="num">{Math.round(p.riders)} riders</b>
                  </li>
                ))}
              </ul>
            ) : <div className="pn-note">No clear peak: riders are spread through the day.</div>}
            {!c.split && <div className="faint lc-foot">Both directions together. Direction detail is recorded from now on.</div>}
          </>
        ) : none('The daily curve')}
      </Fold>
      <Fold title="Where they go" hint={where && where.journeys ? 'areas' : undefined}>
        {where && where.journeys > 0 ? (
          <>
            <div className="lc-sub">Top destinations</div>
            <ul className="lc-list">{where.destinations.map((d) => <li key={d.label}><span>{d.label}</span><b className="num">{pct(d.share)}</b></li>)}</ul>
            <div className="lc-sub">Main starting areas</div>
            <ul className="lc-list">{where.origins.map((d) => <li key={d.label}><span>{d.label}</span><b className="num">{pct(d.share)}</b></li>)}</ul>
          </>
        ) : none('The list of destinations')}
      </Fold>
      <Fold title="Revenue by period" hint="fares per day">
        {c.revenue.some((v) => v > 0) ? (
          <ul className="lc-list">
            {BANDS.map((b, i) => (
              <li key={b.id}>
                <span>{b.label} <span className="faint">{b.short}</span></span>
                <span className="lc-rev"><i style={{ width: `${(c.revenue[i] / Math.max(...c.revenue)) * 100}%` }} /></span>
                <b className="num">{game.money(c.revenue[i])}</b>
              </li>
            ))}
          </ul>
        ) : none('Revenue by period')}
      </Fold>
      <Fold title="Direction" hint="load at departure">
        {c.directions.some((d) => d.average !== null) ? (
          <ul className="lc-list">
            {c.directions.filter((d) => d.average !== null).map((d) => (
              <li key={d.pat}><span>{dirName(d.to)}</span><b className="num">{pct(d.busiest ?? 0)} busiest segment · {pct(d.average ?? 0)} avg</b></li>
            ))}
          </ul>
        ) : none('Occupancy by direction')}
      </Fold>
      <Fold title="Reliability" hint={days}>
        {c.onTime !== null ? (
          <div className="row" style={{ minHeight: 0 }}>
            <span className="k">Trips on time</span>
            <span className={`v num ${c.onTime < 0.75 ? 'amber' : 'mint'}`}>{pct(c.onTime)} of {c.trips.toLocaleString()}</span>
          </div>
        ) : none('On-time performance')}
      </Fold>
    </>
  );
}
