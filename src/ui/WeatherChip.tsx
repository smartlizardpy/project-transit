// The weather chip in the top bar and its popover: now, today's hours and tomorrow's forecast
// (docs/city-activity-engine-plan.md, section 13). The weather is generated from the city's
// climate, not fetched live, and the popover says so.

import { useRef, useState } from 'react';
import { Cloud, CloudMoon, CloudRain, CloudSnow, CloudSun, Moon, Sun } from '@phosphor-icons/react';
import { Tip } from './primitives.tsx';
import { useOutside } from './TopBar.tsx';
import { hourOfDay } from '../game/time.ts';
import { CLIMATE_CREDIT } from '../game/climate.ts';
import { CONDITION_LABEL, hourCondition, hourTemp, WEATHER_GEN, WEATHER_LABEL, type DayWeather, type WeatherKind } from '../game/weather.ts';
import { WEATHER } from '../game/activity/params.ts';
import type { Game } from '../game/engine.ts';

const night = (h: number) => h < 6 || h >= 20;

function WxIcon({ kind, cond, h, size = 17 }: { kind: WeatherKind; cond: number; h: number; size?: number }) {
  if (cond === 4) return <CloudSnow size={size} weight="fill" />;
  if (cond > 0) return <CloudRain size={size} weight="fill" />;
  if (kind === 'clear') return night(h) ? <Moon size={size} weight="fill" /> : <Sun size={size} weight="fill" />;
  if (kind === 'showers') return night(h) ? <CloudMoon size={size} weight="fill" /> : <CloudSun size={size} weight="fill" />;
  return <Cloud size={size} weight="fill" />;
}

/** Colour of the icon for an hour: blue in rain, pale in snow, amber in sun. */
function tone(kind: WeatherKind, cond: number, h: number): { bg: string; fg: string } {
  if (cond === 4) return { bg: 'rgba(220,232,240,0.12)', fg: '#dfe9f1' };
  if (cond > 0) return { bg: 'var(--accent-soft)', fg: cond >= 3 ? 'var(--accent)' : '#8cc6ef' };
  if (kind === 'clear' && !night(h)) return { bg: 'rgba(240,193,105,0.12)', fg: 'var(--amber)' };
  return { bg: 'var(--card-raised)', fg: 'var(--text-2)' };
}

const pct = (f: number) => `${Math.round((1 - f) * 100)}%`;

/** One sentence on how today's weather changes travel. */
function effectLine(w: DayWeather): string {
  let worst = 0;
  for (let h = 0; h < 24; h++) worst = Math.max(worst, hourCondition(w, h));
  switch (worst) {
    case 1: return 'Light rain: a few people stop walking or cycling.';
    case 2: return `Rain: fewer people walk or cycle, roads are about ${pct(WEATHER.road[2])} slower, and parks empty.`;
    case 3: return `Heavy rain: roads are about ${pct(WEATHER.road[3])} slower, so buses run late, and many skip outings.`;
    case 4: return `Snow: roads are about ${pct(WEATHER.road[4])} slower, and some people do not travel at all.`;
  }
  if (w.hi >= WEATHER.hotC) return 'Hot: beaches fill, and long walks and waits in the sun put people off.';
  if (w.hi <= WEATHER.coldC) return 'Cold: waiting at stops feels longer, and fewer people cycle.';
  if (w.hi >= WEATHER.pleasantC[0] && w.hi <= WEATHER.pleasantC[1] + 3) return 'Pleasant: more people out in parks and on bikes.';
  return 'No effect on travel to speak of.';
}

/** "Rain 14:00–19:00" (first to last wet hour), or '' on a dry day. */
function wetHours(w: DayWeather): string {
  let a = -1, b = -1, worst = 0;
  for (let h = 0; h < 24; h++) {
    const c = hourCondition(w, h);
    if (c > 0) {
      if (a < 0) a = h;
      b = h;
      worst = Math.max(worst, c);
    }
  }
  if (a < 0) return '';
  const hh = (x: number) => `${String(x % 24).padStart(2, '0')}:00`;
  return `${CONDITION_LABEL[worst]} ${hh(a)}–${hh(b + 1)}`;
}

export function WeatherChip({ game }: { game: Game }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const day = Math.floor(game.t / 86400);
  const today = game.weatherDay(day);
  if (!today) return null;
  const w = today.actual;
  const h = hourOfDay(game.t);
  const cond = hourCondition(w, h);
  const temp = Math.round(hourTemp(w, h));
  const f = game.weatherDay(day + 1)?.forecast;
  const sub = f ? `Tomorrow: ${WEATHER_LABEL[f.kind].toLowerCase()}` : `Today: ${WEATHER_LABEL[w.kind].toLowerCase()}`;
  const tn = tone(w.kind, cond, h);
  const maxMm = Math.max(2, ...w.mm);
  const wet = wetHours(w);
  const c = game.climate;
  // the forecast's icon: as a daytime hour in that weather
  const fc = f ? (f.kind === 'snow' ? 4 : f.kind === 'rain' || f.kind === 'heavy' ? 2 : 0) : 0;
  const ft = f ? tone(f.kind, fc, 12) : null;
  return (
    <div className="wx" ref={ref}>
      <button className="stat wx-chip has-tip" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <div className="stat-icon" style={{ background: tn.bg, color: tn.fg }}>
          <WxIcon kind={w.kind} cond={cond} h={h} />
        </div>
        <div>
          <b>{temp}°</b>
          <span>{sub}</span>
        </div>
        {!open && <Tip label={`${cond ? CONDITION_LABEL[cond] : WEATHER_LABEL[w.kind]} now, ${temp} °C`} hint="Click for today's hours and tomorrow's forecast." side="below" />}
      </button>
      {open && (
        <div className="card wx-pop">
          <div className="section-head">
            <div>
              <div className="p-title" style={{ fontSize: 15 }}>Weather</div>
              <div className="p-sub">
                Today · {WEATHER_LABEL[w.kind]} · {Math.round(w.hi)}° / {Math.round(w.lo)}°
              </div>
            </div>
            {wet && <span className={`pill ${w.kind === 'heavy' || w.kind === 'snow' ? 'warn' : 'info'}`}>{wet}</span>}
          </div>
          <div className="wx-hours" role="img" aria-label={`Rain by hour today${wet ? `: ${wet}` : ': dry'}`}>
            {w.mm.map((v, i) => (
              <i key={i} className={`${i === h ? 'now' : ''} ${hourCondition(w, i) === 4 ? 'snow' : ''}`} style={{ height: v > 0 ? `${Math.max(10, (v / maxMm) * 100)}%` : undefined }} />
            ))}
          </div>
          <div className="pc-busy-axis faint"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
          <div className="wx-effect">{effectLine(w)}</div>
          <div className="wx-tomorrow">
            <div className="label">Tomorrow</div>
            {f ? (
              <>
                <div className="wx-fc">
                  <div className="stat-icon" style={{ background: ft!.bg, color: ft!.fg }}>
                    <WxIcon kind={f.kind} cond={fc} h={12} />
                  </div>
                  <div className="grow">
                    <b>{WEATHER_LABEL[f.kind]}</b>
                    <span className="faint">
                      {f.hi}° / {f.lo}° · {f.pop}% chance of rain
                    </span>
                  </div>
                  <span className="pn-tag">Forecast</span>
                </div>
                <div className="faint wx-note">Forecasts are right about {Math.round(WEATHER_GEN.forecastRight * 10)} days in 10; a miss is usually close (showers instead of rain).</div>
              </>
            ) : (
              <div className="faint wx-note">The forecast for tomorrow comes out at 18:00.</div>
            )}
            {today.forecast && (
              <div className="faint wx-note">
                Yesterday's forecast for today: {WEATHER_LABEL[today.forecast.kind].toLowerCase()}, {today.forecast.hi}°.
              </div>
            )}
          </div>
          <div className="faint wx-credit">
            Generated from the city's climate, not live weather. {CLIMATE_CREDIT}, {c.name}
            {c.km >= 20 ? ` (${Math.round(c.km)} km away)` : ''}.
          </div>
        </div>
      )}
    </div>
  );
}
