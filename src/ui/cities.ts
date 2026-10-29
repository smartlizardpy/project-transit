import { mapRuntime } from '../map/runtime.ts';
import { HOME_VIEW } from '../sim/demoCity.ts';

export const CITIES = [
  { id: 'istanbul', name: 'İstanbul', note: 'Prototype network', center: HOME_VIEW.center, zoom: HOME_VIEW.zoom, bearing: HOME_VIEW.bearing, pitch: HOME_VIEW.pitch },
  { id: 'london', name: 'London', note: 'Covent Garden', center: [-0.1225, 51.5117] as [number, number], zoom: 16.4, bearing: 28, pitch: 55 },
  { id: 'hamburg', name: 'Hamburg', note: 'HafenCity', center: [9.9937, 53.5413] as [number, number], zoom: 16.2, bearing: -18, pitch: 55 },
  { id: 'durham', name: 'Durham', note: 'Peninsula', center: [-1.5752, 54.7745] as [number, number], zoom: 16.3, bearing: 12, pitch: 55 },
  { id: 'tokyo', name: 'Tokyo', note: 'Shibuya', center: [139.7005, 35.6595] as [number, number], zoom: 16.4, bearing: -10, pitch: 55 },
];

let current = 'istanbul';

export function currentCityId() {
  return current;
}

export function flyToCity(id: string) {
  const c = CITIES.find((x) => x.id === id);
  const map = mapRuntime.map;
  if (!c || !map) return;
  current = id;
  const far = id !== 'istanbul' || map.getCenter().distanceTo({ lng: c.center[0], lat: c.center[1] } as never) > 30_000;
  if (far) map.jumpTo({ center: c.center, zoom: c.zoom - 2.5, bearing: c.bearing, pitch: 30 });
  map.flyTo({ center: c.center, zoom: c.zoom, bearing: c.bearing, pitch: c.pitch, duration: far ? 2200 : 1400, essential: true });
}
