// City Activity Engine, phase 4: weather (docs/city-activity-engine-plan.md, sections 9.2 and 17).
// The generator against its climate statistics, the forecast's accuracy, determinism and reload,
// and the effects scenario: the same seed and day in rain and in clear weather.
import { describe, expect, it } from 'vitest';
import { newGame, region } from './helpers.ts';
import { referenceLine } from './calibration.ts';
import { reload, simState } from './determinism.ts';
import { DAY, HOUR } from '../content.ts';
import { Game } from '../engine.ts';
import { climateAt, forecastFor, generateDay, hourCondition, probit, WEATHER_GEN, type ClimateMonth, type DayWeather, type WeatherKind } from '../weather.ts';
import { climateFor } from '../climate.ts';
import { weatherEffect } from '../activity/conditions.ts';
import { TYPE } from '../activity/params.ts';

// A made-up month for testing the generator's statistics (not a real place's climate).
const MONTH: ClimateMonth = { wet: 0.3, ww: 0.55, heavy: 0.2, rain: 7, snow: 0.04, tx: 6, txSd: 4, tn: 1, tnSd: 3.5, hot: 0, cold: 0.15, ar: 0.65 };

function chain(m: ClimateMonth, n: number, seed = 7): DayWeather[] {
  const out: DayWeather[] = [];
  let prev: DayWeather | null = null;
  for (let d = 0; d < n; d++) out.push((prev = generateDay(seed, d, m, prev)));
  return out;
}
const isWet = (w: DayWeather) => w.kind !== 'clear' && w.kind !== 'cloudy';

describe('the weather generator keeps to its climate', () => {
  const days = chain(MONTH, 20000);
  const wet = days.map(isWet);

  it('wet days as often as the climate, and as persistent', () => {
    const share = wet.filter(Boolean).length / wet.length;
    expect(share).toBeGreaterThan(MONTH.wet - 0.02);
    expect(share).toBeLessThan(MONTH.wet + 0.02);
    let ww = 0, w = 0;
    for (let i = 1; i < wet.length; i++) if (wet[i - 1]) (w++, wet[i] && ww++);
    expect(ww / w).toBeGreaterThan(MONTH.ww - 0.03);
    expect(ww / w).toBeLessThan(MONTH.ww + 0.03);
  });

  it('heavy rain and snow in the right shares; snow only on cold days', () => {
    const n = (k: WeatherKind) => days.filter((d) => d.kind === k).length / days.length;
    expect(n('snow')).toBeGreaterThan(MONTH.snow * 0.75);
    expect(n('snow')).toBeLessThan(MONTH.snow * 1.25);
    for (const d of days.filter((x) => x.kind === 'snow')) expect(d.hi).toBeLessThanOrEqual(WEATHER_GEN.snowMaxC + 0.05);
    // heavy among wet days that are not snow
    const rainy = days.filter((d) => isWet(d) && d.kind !== 'snow');
    const heavy = rainy.filter((d) => d.kind === 'heavy').length / rainy.length;
    expect(heavy).toBeGreaterThan(MONTH.heavy - 0.03);
    expect(heavy).toBeLessThan(MONTH.heavy + 0.03);
    for (const d of days.filter((x) => x.kind === 'heavy')) expect(d.mm.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(9.5);
    for (const d of days.filter((x) => !isWet(x))) expect(Math.max(...d.mm)).toBe(0);
  });

  it('temperatures: mean, spread and day-to-day persistence of the high', () => {
    const hi = days.map((d) => d.hi);
    const mean = hi.reduce((a, b) => a + b, 0) / hi.length;
    const sd = Math.sqrt(hi.reduce((a, b) => a + (b - mean) ** 2, 0) / hi.length);
    expect(Math.abs(mean - MONTH.tx)).toBeLessThan(0.3);
    expect(Math.abs(sd - MONTH.txSd)).toBeLessThan(0.5);
    let num = 0, den = 0;
    for (let i = 1; i < hi.length; i++) num += (hi[i] - mean) * (hi[i - 1] - mean);
    for (const h of hi) den += (h - mean) ** 2;
    expect(num / den).toBeGreaterThan(MONTH.ar - 0.08);
    expect(num / den).toBeLessThan(MONTH.ar + 0.05);
    for (const d of days) expect(d.lo).toBeLessThan(d.hi);
  });

  it('showers fall mostly in the afternoon; fronts last hours', () => {
    const warm = chain({ ...MONTH, tx: 24, tn: 15, snow: 0 }, 4000, 3);
    let pm = 0, all = 0;
    for (const d of warm.filter((x) => x.kind === 'showers'))
      d.mm.forEach((v, h) => {
        if (v > 0) (all++, h >= 12 && h < 20 && pm++);
      });
    expect(pm / all).toBeGreaterThan(0.6);
    const fronts = warm.filter((x) => x.kind === 'rain').map((d) => d.mm.filter((v) => v > 0).length);
    expect(Math.min(...fronts)).toBeGreaterThanOrEqual(3);
  });

  it('is a pure function of seed, day and yesterday', () => {
    const a = generateDay(11, 40, MONTH, null), b = generateDay(11, 40, MONTH, null);
    expect(b).toEqual(a);
    const other = Array.from({ length: 20 }, (_, d) => generateDay(12, d, MONTH, null).hi);
    expect(other).not.toEqual(Array.from({ length: 20 }, (_, d) => generateDay(11, d, MONTH, null).hi));
    expect(probit(0.975)).toBeCloseTo(1.96, 2);
  });
});

describe('the forecast', () => {
  it('is right about four days in five; misses are near ones', () => {
    const days = chain(MONTH, 6000, 5);
    let right = 0;
    const near: Record<WeatherKind, WeatherKind[]> = { clear: ['cloudy'], cloudy: ['clear', 'showers'], showers: ['cloudy', 'rain'], rain: ['showers', 'heavy'], heavy: ['rain'], snow: ['rain'] };
    days.forEach((a, d) => {
      const f = forecastFor(5, d, a, 0);
      if (f.kind === a.kind) right++;
      else expect(near[a.kind]).toContain(f.kind);
      expect(Math.abs(f.hi - a.hi)).toBeLessThan(8);
    });
    expect(right / days.length).toBeGreaterThan(0.79);
    expect(right / days.length).toBeLessThan(0.86);
  });
});

describe('climate data and the game year', () => {
  it('each preset city has a station close by', () => {
    for (const [id, centre] of [
      ['istanbul-galata', [28.97, 41.03]],
      ['durham', [-1.57, 54.78]],
      ['barcelona-eixample', [2.16, 41.39]],
      ['hamburg-altstadt', [9.99, 53.55]],
      ['tokyo-shibuya', [139.7, 35.66]],
    ] as [string, [number, number]][]) {
      const c = climateFor({ id, centre });
      expect(c.km, id).toBeLessThan(60);
      expect(c.months).toHaveLength(12);
    }
  });

  it('the game year follows the climate year: İstanbul is wetter and colder in winter than in summer', () => {
    const c = climateFor({ id: 'istanbul-galata', centre: [28.97, 41.03] });
    const winter = climateAt(c, 4.5 / 12), summer = climateAt(c, 10.5 / 12);
    expect(winter.wet).toBeGreaterThan(summer.wet);
    expect(winter.tx).toBeLessThan(summer.tx - 8);
  });

  it('a searched place uses the nearest station; the south starts autumn in March', () => {
    const c = climateFor({ id: 'searched', centre: [151.2, -33.87] });
    expect(c.lat).toBeLessThan(0);
    expect(c.km).toBeLessThan(400);
    // autumn week 1 in Sydney is warmer than winter
    expect(climateAt(c, 0.5 / 12).tx).toBeGreaterThan(climateAt(c, 4.5 / 12).tx);
  });
});

describe('weather in the game', () => {
  it('keeps today and two days ahead, saved, and never draws from the shared random stream', () => {
    const g = newGame();
    const rng = g.state.rng;
    const w = g.state.world.weather!;
    expect(w.days.map((d) => d.day)).toEqual([0, 1, 2]);
    g.run(2 * DAY);
    expect(g.state.world.weather!.days.map((d) => d.day)).toEqual([2, 3, 4]);
    expect(g.state.stats.days.find((d) => d.day === 1)?.wx).toBeDefined();
    // only breakdowns draw from rng; with no buses there are none
    expect(g.state.rng).toBe(rng);
  });

  it('issues tomorrow’s forecast at 18:00, and a reloaded game carries on identically', () => {
    const g = newGame({ seed: 9 });
    g.run(17 * HOUR - g.t);
    expect(g.weatherDay(1)?.forecast).toBeUndefined();
    g.run(HOUR);
    const f = g.weatherDay(1)?.forecast;
    expect(f).toBeDefined();
    expect(f!.t).toBe(18 * HOUR);
    const copy = reload(g);
    g.run(DAY);
    copy.run(DAY);
    expect(simState(copy).world).toEqual(simState(g).world);
  });

  it('an older save without weather gets it on load, from that day on', () => {
    const g = newGame({ seed: 3 });
    g.run(DAY + 10 * HOUR - g.t);
    const s = JSON.parse(g.serialize());
    delete s.world.weather;
    const up = new Game(s, region());
    expect(up.state.world.weather!.days.map((d) => d.day)).toEqual([1, 2, 3]);
  });
});

// ───────────────────────────────────────────── effects (plan section 17, "Weather")

const DRY: DayWeather = { v: 1, kind: 'clear', hi: 20, lo: 12, z: 0, mm: new Array(24).fill(0) };
const RAIN: DayWeather = { v: 1, kind: 'rain', hi: 15, lo: 11, z: 0, mm: new Array(24).fill(2.5) };

/** The reference line at 05:00 on day 1, with today's weather set. */
function withWeather(base: Game, w: DayWeather): Game {
  const s = structuredClone(base.state);
  s.world.weather!.days.find((d) => d.day === 1)!.actual = structuredClone(w);
  return new Game(s, region());
}

describe('rain against clear weather: the same seed and day', () => {
  const { game: base, route } = referenceLine(8, 4);
  base.run(DAY);
  const dry = withWeather(base, DRY), wet = withWeather(base, RAIN);

  it('the hour is wet, and roads are slower only in the rain', () => {
    expect(hourCondition(RAIN, 8)).toBe(2);
    expect(dry.traffic.conditions(dry.t + 3 * HOUR)).toBe(1);
    expect(wet.traffic.conditions(wet.t + 3 * HOUR)).toBeLessThan(0.95);
    expect(weatherEffect(RAIN, 8).walk).toBeGreaterThan(1);
  });

  /** Today's modelled trips by mode (everyone), your share on walkable served trips (1–3 km), and trips to park and sight zones. */
  const est = (g: Game) => {
    const e = g.demand.estimateDay(g, () => true)!;
    const zs = g.demand.activity.zones!;
    const byMode = new Float64Array(6);
    let total = 0, shortAll = 0, shortNet = 0, toParks = 0;
    for (const [key, v] of e.trips) {
      const i = Math.floor(key / e.Z), j = key % e.Z;
      const sum = v.reduce((a, b) => a + b, 0);
      v.forEach((x, m) => (byMode[m] += x));
      total += sum;
      const zi = zs.list[i], zj = zs.list[j];
      const d = Math.hypot(zi.x - zj.x, zi.y - zj.y);
      if (e.served.has(key) && d >= 1000 && d < 3000) (shortAll += sum, (shortNet += v[4]));
      if (zs.park[j] > 0.3) toParks += sum;
    }
    return { byMode, total, shortNetworkShare: shortAll > 0 ? shortNet / shortAll : 0, toParks };
  };
  const share = (e: ReturnType<typeof est>, i: number) => e.byMode[i] / e.total;

  it('fewer people walk or cycle; your share rises on walkable trips of 1–3 km (under 1 km people still walk)', () => {
    const a = est(dry), b = est(wet);
    expect(share(b, 0)).toBeLessThan(share(a, 0));
    expect(share(b, 1)).toBeLessThan(share(a, 1) * 0.92);
    expect(b.shortNetworkShare).toBeGreaterThan(a.shortNetworkShare);
  });

  it('fewer go to parks and sights outdoors: their areas lose more trips than the city as a whole', () => {
    const a = est(dry), b = est(wet);
    expect(a.toParks).toBeGreaterThan(0);
    expect(b.toParks / a.toParks).toBeLessThan(b.total / a.total - 0.05);
  });

  it('over the day: buses run later, and some riders are lost', () => {
    dry.run(DAY);
    wet.run(DAY);
    const rd = (g: Game) => g.state.analytics.days.at(-1)!.routes[route];
    const late = (g: Game) => {
      const r = rd(g);
      return r.dl.reduce((a, b) => a + b, 0) / Math.max(1, r.dp.reduce((a, b) => a + b, 0));
    };
    expect(late(wet)).toBeGreaterThan(late(dry));
    // at least one traveller type rides less in the rain (leisure and visitors stay in)
    const byType = (g: Game, ty: number) => {
      const k = rd(g).k ?? [];
      const bands = k.length / 10;
      let s = 0;
      for (let b = 0; b < bands; b++) s += k[ty * bands + b] ?? 0;
      return s;
    };
    const lost = [TYPE.leisure, TYPE.visitor, TYPE.shopper].filter((ty) => byType(wet, ty) < byType(dry, ty));
    expect(lost.length).toBeGreaterThan(0);
  });
});
