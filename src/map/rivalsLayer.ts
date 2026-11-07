// Races: the rivals' networks, drawn faintly under your own lines in each rival's colour, so you
// can see where they run (and where nobody does yet).

import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { rivals, useRace } from '../net/race.ts';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export function installRivalsLayer(map: MlMap) {
  const before = map.getLayer('lines-halo') ? 'lines-halo' : undefined;
  map.addSource('rivals', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'rivals-lines', type: 'line', source: 'rivals', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'colour'], 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.4, 14, 2.6, 17, 4.5], 'line-dasharray': [2, 1.6] },
  }, before);
  map.addLayer({
    id: 'rivals-stops', type: 'circle', source: 'rivals', filter: ['==', ['geometry-type'], 'Point'], minzoom: 12.5,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 17, 4.5], 'circle-color': '#f4f1ea', 'circle-opacity': 0.7, 'circle-stroke-color': ['get', 'colour'], 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.7 },
  }, before);

  const sync = () => {
    const { players, ghosts, phase } = useRace.getState();
    const features: Feature<Geometry>[] = [];
    if (ghosts && (phase === 'racing' || phase === 'finished')) {
      for (const [id, net] of rivals.nets) {
        const colour = players.find((p) => p.id === id)?.colour;
        if (!colour) continue;
        for (const p of net.lines) features.push({ type: 'Feature', properties: { colour }, geometry: { type: 'LineString', coordinates: p } });
        for (const s of net.stops) features.push({ type: 'Feature', properties: { colour }, geometry: { type: 'Point', coordinates: s } });
      }
    }
    (map.getSource('rivals') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  };
  rivals.listeners.add(sync);
  useRace.subscribe((s, prev) => (s.ghosts !== prev.ghosts || s.players !== prev.players || s.phase !== prev.phase) && sync());
}
