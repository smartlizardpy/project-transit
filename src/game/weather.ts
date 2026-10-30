// Weather (docs/city-activity-engine-plan.md, section 9.2).
//
// Each city's weather is generated from its climate: monthly statistics from NASA POWER daily
// data (src/data/climate.json, built by scripts/data/build-climate.mjs), mapped onto the game
// year so each game week stands for a point in the real climate year. The game never shows months.
//
// A day's weather is a Markov chain: whether it is wet depends on yesterday; temperature
// anomalies persist from day to day. Every draw is a stateless hash of the world seed and the
// day, never the shared random stream. Days are generated two days ahead and saved, so a later
// change to this code cannot rewrite a running game. A forecast for tomorrow is issued at 18:00
// from the saved weather plus a hashed error, so it is usually right but not always.

import { mix, unit } from './hash.ts';

export const WEATHER_VERSION = 1;

export const WEATHER_KINDS = ['clear', 'cloudy', 'showers', 'rain', 'heavy', 'snow'] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];
export const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: 'Clear', cloudy: 'Cloudy', showers: 'Showers', rain: 'Rain', heavy: 'Heavy rain', snow: 'Snow',
};

/** One month of climate statistics (the fields of climate.json, in its order). */
export interface ClimateMonth {
  /** share of days with ≥ 1 mm, P(wet | wet yesterday), P(≥ 10 mm | wet), mean mm on wet days */
  wet: number; ww: number; heavy: number; rain: number;
  /** share of days with snow */
  snow: number;
  /** daily high and low: mean and standard deviation, °C */
  tx: number; txSd: number; tn: number; tnSd: number;
  /** share of days with a high ≥ 30 °C and ≤ 3 °C */
  hot: number; cold: number;
  /** day-to-day persistence of the high's anomaly (lag-1 autocorrelation) */
  ar: number;
}
export const CLIMATE_FIELDS = ['wet', 'ww', 'heavy', 'rain', 'snow', 'tx', 'txSd', 'tn', 'tnSd', 'hot', 'cold', 'ar'] as const;

/** A place's climate: the station it comes from and its twelve months (January first). */
export interface Climate {
  station: string;
  name: string;
  lat: number;
  lon: number;
  /** distance from the city centre to the station, km */
  km: number;
  months: ClimateMonth[];
}

/** The weather of one day (saved). */
export interface DayWeather {
  /** generator version */
  v: number;
  kind: WeatherKind;
  /** daily high and low, °C */
  hi: number;
  lo: number;
  /** the high's anomaly in standard deviations, carried to the next day */
  z: number;
  /** rain or snow (as water) per hour, mm */
  mm: number[];
}

/** Tomorrow's forecast, issued at 18:00 (saved). */
export interface DayForecast {
  kind: WeatherKind;
  hi: number;
  lo: number;
  /** chance of rain or snow, % */
  pop: number;
  /** game time it was issued */
  t: number;
}

export interface WeatherDay {
  day: number;
  actual: DayWeather;
  forecast?: DayForecast;
}

/** Saved weather: today and the next two days. */
export interface WeatherState {
  /** the climate data point the weather is generated from */
  station: string;
  days: WeatherDay[];
}

/** Game settings for the generator and the forecast. */
export const WEATHER_GEN = {
  /** share of forecasts in the right category (plan: about 80–85%) */
  forecastRight: 0.82,
  /** forecast temperature error, standard deviation °C */
  forecastSd: 1.5,
  /** chance of rain shown for each forecast kind, % */
  pop: { clear: 5, cloudy: 20, showers: 50, rain: 80, heavy: 90, snow: 80 } as Record<WeatherKind, number>,
  /** dry days are cloudy with this chance, plus this much per unit of the month's wet share */
  cloudyBase: 0.2,
  cloudyWet: 0.6,
  /** snow falls only when the day's high is at most this, °C */
  snowMaxC: 2.5,
};

// ───────────────────────────────────────────── climate

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * The climate for a point in the game year (`phase` 0–1 from the start of autumn). Autumn starts
 * in September north of the equator and in March south of it; months are interpolated between
 * their middles.
 */
export function climateAt(c: Climate, phase: number): ClimateMonth {
  const start = c.lat < 0 ? 2 : 8;
  const m = (((start + 12 * phase - 0.5) % 12) + 12) % 12;
  const i = Math.floor(m), f = m - i;
  const a = c.months[i], b = c.months[(i + 1) % 12];
  const out = {} as ClimateMonth;
  for (const k of CLIMATE_FIELDS) out[k] = a[k] + (b[k] - a[k]) * f;
  return out;
}

/** Kilometres between two points. */
export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ───────────────────────────────────────────── the generator

const STREAM_WEATHER = 0x77e7;
const STREAM_FORECAST = 0xf0ca;

/** A standard normal draw from two uniforms (Box–Muller). */
function normal(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
}

/** Inverse of the standard normal CDF (Acklam's rational approximation, error below 1e-8). */
export function probit(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q0 = clamp(p, 1e-9, 1 - 1e-9);
  if (q0 < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(q0));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (q0 > 1 - 0.02425) return -probit(1 - q0);
  const q = q0 - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Chance that a day is wet after a dry day, so the long-run wet share matches the climate. */
function dryToWet(m: ClimateMonth): number {
  return m.wet >= 1 ? 1 : clamp((m.wet * (1 - m.ww)) / (1 - m.wet), 0, 1);
}

/**
 * One day's weather. `prev` is yesterday's saved weather (null for the first day of a game or of
 * an upgraded save, which starts from the climate's averages).
 */
export function generateDay(seed: number, day: number, m: ClimateMonth, prev: DayWeather | null): DayWeather {
  const u = (k: number) => unit(seed, STREAM_WEATHER, day, k);
  const prevWet = prev ? prev.kind !== 'clear' && prev.kind !== 'cloudy' : false;
  const pWet = prev ? (prevWet ? m.ww : dryToWet(m)) : m.wet;
  const wet = u(1) < pWet;
  // the high's anomaly persists from day to day (AR(1)); wet days are cooler, dry days a little warmer
  const ar = clamp(m.ar, 0, 0.95);
  const z = prev ? ar * clamp(prev.z, -4, 4) + Math.sqrt(1 - ar * ar) * normal(u(2), u(3)) : normal(u(2), u(3));
  const wetShift = wet ? -0.35 : (0.35 * m.wet) / Math.max(0.05, 1 - m.wet);
  const hi = m.tx + m.txSd * (z + wetShift);
  let lo = m.tn + m.tnSd * (0.7 * z + 0.71 * normal(u(4), u(5)) + (wet ? 0.2 : (-0.2 * m.wet) / Math.max(0.05, 1 - m.wet)));
  lo = Math.min(lo, hi - 1);
  const mm = new Array<number>(24).fill(0);
  let kind: WeatherKind;
  if (!wet) {
    kind = u(6) < WEATHER_GEN.cloudyBase + WEATHER_GEN.cloudyWet * m.wet + (prevWet ? 0.15 : 0) ? 'cloudy' : 'clear';
  } else {
    // snow on the coldest wet days, as often as the climate has snow days
    const snowShare = m.wet > 0 ? m.snow / m.wet : 0;
    const snowBelow = snowShare > 0.002 ? Math.min(WEATHER_GEN.snowMaxC, m.tx - 0.35 * m.txSd + m.txSd * probit(Math.min(0.98, snowShare))) : -Infinity;
    if (hi <= snowBelow) kind = 'snow';
    else if (u(7) < m.heavy) kind = 'heavy';
    else kind = u(8) < 0.3 + 0.4 * clamp((m.tx - 12) / 14, 0, 1) ? 'showers' : 'rain';
    // the day's total: at least 10 mm on heavy days, 1–10 mm otherwise
    const mean = Math.max(1.5, m.rain);
    const total =
      kind === 'heavy' ? 10 - Math.max(3, mean * 0.8) * Math.log(1 - u(9)) : clamp(1 - Math.min(5, mean * 0.55) * Math.log(1 - u(9)), 1, 9.9);
    spread(mm, kind, total, u);
  }
  return { v: WEATHER_VERSION, kind, hi: round1(hi), lo: round1(lo), z: Math.round(z * 1000) / 1000, mm };
}

/** Spreads a day's rain over its hours: afternoon showers, or a front of rain lasting some hours. */
function spread(mm: number[], kind: WeatherKind, total: number, u: (k: number) => number) {
  const w = new Array<number>(24).fill(0);
  if (kind === 'showers') {
    // one to three showers, mostly in the afternoon
    const n = 1 + Math.floor(u(10) * 3);
    for (let s = 0; s < n; s++) {
      const centre = Math.floor(clamp(15 + 4.5 * normal(u(11 + s * 2), u(12 + s * 2)), 0, 23));
      w[centre] += 1;
      if (centre + 1 < 24) w[centre + 1] += 0.5 * u(17 + s);
    }
  } else {
    // a front: rain for 4–16 hours (downpours are shorter), heaviest in the middle
    const dur = kind === 'heavy' ? 4 + Math.floor(u(10) * 8) : 5 + Math.floor(u(10) * 12);
    const start = Math.floor(u(11) * (25 - dur));
    for (let h = 0; h < dur; h++) w[start + h] = Math.sin((Math.PI * (h + 0.5)) / dur);
  }
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  for (let h = 0; h < 24; h++) mm[h] = round1((total * w[h]) / sum);
}

// ───────────────────────────────────────────── the forecast

/** The categories a forecast can mistake each kind for (near misses). */
const NEAR: Record<WeatherKind, WeatherKind[]> = {
  clear: ['cloudy'],
  cloudy: ['clear', 'showers'],
  showers: ['cloudy', 'rain'],
  rain: ['showers', 'heavy'],
  heavy: ['rain'],
  snow: ['rain'],
};

/** Tomorrow's forecast from its saved weather: right about four times in five, otherwise a near miss. */
export function forecastFor(seed: number, day: number, a: DayWeather, t: number): DayForecast {
  const u = (k: number) => unit(seed, STREAM_FORECAST, day, k);
  let kind = a.kind;
  if (u(1) >= WEATHER_GEN.forecastRight) {
    const near = NEAR[a.kind];
    kind = near[Math.floor(u(2) * near.length)];
    // snow forecast as rain only when it is not far below freezing
    if (a.kind === 'snow' && a.hi < -1) kind = 'snow';
  }
  const pop = clamp(WEATHER_GEN.pop[kind] + Math.round((u(3) - 0.5) * 20), 0, 100);
  const err = WEATHER_GEN.forecastSd * normal(u(4), u(5));
  return { kind, hi: Math.round(a.hi + err), lo: Math.round(a.lo + err * 0.8), pop: Math.round(pop / 10) * 10, t };
}

// ───────────────────────────────────────────── hours

/** The weather in one hour: 0 dry, 1 light rain, 2 rain, 3 heavy rain, 4 snow. */
export type HourCondition = 0 | 1 | 2 | 3 | 4;
export const CONDITION_LABEL = ['Dry', 'Light rain', 'Rain', 'Heavy rain', 'Snow'];

export function hourCondition(w: DayWeather, h: number): HourCondition {
  const x = w.mm[h] ?? 0;
  if (x < 0.1) return 0;
  if (w.kind === 'snow') return 4;
  if (w.kind === 'heavy') return x >= 0.5 * Math.max(...w.mm) ? 3 : 2;
  return x >= 1 ? 2 : 1;
}

/** Temperature in an hour, °C: the low near dawn (05:00), the high mid-afternoon (15:00). */
export function hourTemp(w: DayWeather, h: number): number {
  const x = h + 0.5;
  // rising from 05 to 15, falling from 15 to 05 the next day
  const f = x >= 5 && x <= 15 ? (1 - Math.cos((Math.PI * (x - 5)) / 10)) / 2 : (1 + Math.cos((Math.PI * ((x + 24 - 15) % 24)) / 14)) / 2;
  return w.lo + (w.hi - w.lo) * f;
}

/** The world seed's weather stream for a city (so two cities with one seed differ). */
export function weatherSeed(worldSeed: number, station: string): number {
  let h = 0;
  for (let i = 0; i < station.length; i++) h = (Math.imul(h, 31) + station.charCodeAt(i)) | 0;
  return mix(worldSeed, h);
}

/**
 * Makes sure the saved weather covers `today` and the next two days, generating any missing day
 * from the day before it, then drops days before `today`.
 */
export function advanceWeather(w: WeatherState, seed: number, today: number, climate: (day: number) => ClimateMonth) {
  for (let d = today; d <= today + 2; d++) {
    if (w.days.some((x) => x.day === d)) continue;
    const prev = w.days.find((x) => x.day === d - 1)?.actual ?? null;
    w.days.push({ day: d, actual: generateDay(seed, d, climate(d), prev) });
  }
  w.days = w.days.filter((x) => x.day >= today && x.day <= today + 2).sort((a, b) => a.day - b.day);
}
