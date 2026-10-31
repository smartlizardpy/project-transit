// How an hour's weather changes travel (docs/city-activity-engine-plan.md, section 9.2, effects
// table). The multipliers are game settings (WEATHER in params.ts). They change trip making,
// destinations (parks and beaches against malls), the weight of walking and waiting, cycling,
// and road speeds. Your buses are not favoured directly: they gain where people stop walking
// short distances and lose where the walk to the stop, the wait or slower roads count against them.

import { KINDS, KIND_COUNT, WEATHER } from './params.ts';
import { hourCondition, hourTemp, type DayWeather, type HourCondition } from '../weather.ts';

export interface WeatherEffect {
  cond: HourCondition;
  /** temperature, °C */
  temp: number;
  /** multipliers on walking, waiting and riding time, minutes added to cycling, road speed, extra taxi wait */
  walk: number;
  wait: number;
  bikeRide: number;
  bike: number;
  road: number;
  taxiWait: number;
  /** trip making per tour kind */
  trips: Float64Array;
  /** visitors and leisure at parks and at beaches; shoppers and leisure at malls */
  park: number;
  beach: number;
  mall: number;
}

const ones = () => new Float64Array(KIND_COUNT).fill(1);

/** No weather effect (a mild dry hour): every multiplier 1. */
export const NO_WEATHER: WeatherEffect = { cond: 0, temp: 15, walk: 1, wait: 1, bikeRide: 1, bike: 0, road: 1, taxiWait: 0, trips: ones(), park: 1, beach: 1, mall: 1 };

const cache = new Map<string, WeatherEffect>();

/** The effect of the weather in hour `h` of a day. */
export function weatherEffect(w: DayWeather | null | undefined, h: number): WeatherEffect {
  if (!w) return NO_WEATHER;
  const cond = hourCondition(w, h);
  const temp = hourTemp(w, h);
  const hot = temp >= WEATHER.hotC;
  const cold = temp <= WEATHER.coldC;
  const pleasant = cond === 0 && h >= 8 && h < 21 && temp >= WEATHER.pleasantC[0] && temp <= WEATHER.pleasantC[1];
  const key = `${cond}|${hot ? 1 : cold ? 2 : pleasant ? 3 : 0}|${hot && h >= 11 && h < 17 ? 1 : 0}`;
  let e = cache.get(key);
  if (e) return { ...e, temp };
  const trips = ones();
  KINDS.forEach((k, i) => (trips[i] = WEATHER.trips[k.attr]?.[cond] ?? 1));
  e = {
    cond,
    temp,
    walk: WEATHER.walk[cond],
    wait: WEATHER.wait[cond],
    bikeRide: WEATHER.bikeRide[cond],
    bike: WEATHER.bike[cond],
    road: WEATHER.road[cond],
    taxiWait: WEATHER.taxiWait[cond],
    trips,
    park: WEATHER.park[cond],
    beach: WEATHER.beach[cond],
    mall: WEATHER.mall[cond],
  };
  if (hot) {
    e.walk *= WEATHER.hot.walk;
    e.wait *= WEATHER.hot.wait;
    e.bike += WEATHER.hot.bike;
    e.beach *= WEATHER.hot.beach;
    // parks empty in the midday heat
    if (h >= 11 && h < 17) e.park *= WEATHER.hot.park;
  } else if (cold) {
    e.walk *= WEATHER.cold.walk;
    e.wait *= WEATHER.cold.wait;
    e.bike += WEATHER.cold.bike;
    e.park *= WEATHER.cold.park;
  } else if (pleasant) {
    e.bike += WEATHER.pleasant.bike;
    e.park *= WEATHER.pleasant.park;
    e.beach *= WEATHER.pleasant.beach;
    KINDS.forEach((k, i) => k.attr === 'leisure' && (trips[i] *= WEATHER.pleasant.leisure));
  }
  cache.set(key, e);
  return { ...e, temp };
}

/**
 * How many of a tour kind's tours to a zone are made this hour: trip making, and the move from
 * parks and beaches indoors (`park` and `beach`: the zone's share of visitors from each; `mall`:
 * the zone is a mall).
 */
export function tripFactor(e: WeatherEffect, k: number, park: number, beach: number, mall: boolean): number {
  let f = e.trips[k];
  const attr = KINDS[k].attr;
  if (attr === 'visit' || attr === 'leisure') f *= 1 + park * (e.park - 1) + beach * (e.beach - 1);
  if (mall && (attr === 'shopping' || attr === 'leisure')) f *= e.mall;
  return f;
}
