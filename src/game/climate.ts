// Climate statistics per place (docs/city-activity-engine-plan.md, section 9.2): monthly
// statistics from NASA POWER daily data (CC BY 4.0), baked at build time into
// src/data/climate.json by scripts/data/build-climate.mjs. Never fetched at runtime.

import data from '../data/climate.json' with { type: 'json' };
import type { RegionSpec } from './world/region.ts';
import { CLIMATE_FIELDS, greatCircleKm, type Climate, type ClimateMonth } from './weather.ts';

type Row = [string, string, number, number, string, number[][]];
const STATIONS = data.stations as unknown as Row[];
const PRESETS = data.presets as Record<string, string>;

/** Where the climate data comes from (shown in the weather popover and the credits). */
export const CLIMATE_CREDIT = 'Climate: NASA POWER (CC BY 4.0)';

function toClimate(r: Row, km: number): Climate {
  const months = r[5].map((v) => Object.fromEntries(CLIMATE_FIELDS.map((f, i) => [f, v[i]])) as unknown as ClimateMonth);
  return { station: r[0], name: r[1], lat: r[2], lon: r[3], km, months };
}

/**
 * The climate for a region: the data point a save already uses, else the preset's point, else
 * the nearest point.
 */
export function climateFor(spec: Pick<RegionSpec, 'id' | 'centre'>, saved?: string): Climate {
  const [lon, lat] = spec.centre;
  const pick = saved ?? PRESETS[spec.id];
  const fixed = pick ? STATIONS.find((r) => r[0] === pick) : undefined;
  if (fixed) return toClimate(fixed, greatCircleKm(lat, lon, fixed[2], fixed[3]));
  let best = STATIONS[0], bestKm = Infinity;
  for (const r of STATIONS) {
    const km = greatCircleKm(lat, lon, r[2], r[3]);
    if (km < bestKm) (best = r), (bestKm = km);
  }
  return toClimate(best, bestKm);
}
