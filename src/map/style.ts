import type { ExpressionSpecification, StyleSpecification, LayerSpecification } from 'maplibre-gl';
import { OFM_TILEJSON } from '../geo/tiles.ts';
import { WORLD } from './palette.ts';

const SRC = 'omt';

/** Width in pixels for a road that is `m` metres wide, with sensible minimums when zoomed out. */
function roadWidth(m: number, min = 0.6): ExpressionSpecification {
  // metres-per-pixel at ~41°N: 118146 / 2^z
  const at = (z: number) => Math.max(min, m / (118146 / 2 ** z));
  return ['interpolate', ['exponential', 2], ['zoom'], 11, Math.max(min * 0.6, at(11)), 14, Math.max(min, at(14)), 16, at(16), 18, at(18), 20, at(20)];
}

/** Zoom-interpolated width whose per-stop value depends on the road class. */
function classWidth(w: { major: [number, number]; mid: [number, number]; other: [number, number] }): ExpressionSpecification {
  const at = (m: number, min: number, z: number) => Math.max(min, m / (118146 / 2 ** z));
  const stop = (z: number): ExpressionSpecification => [
    'match', ['get', 'class'],
    ['motorway', 'trunk', 'primary'], at(w.major[0], w.major[1], z),
    ['secondary', 'tertiary'], at(w.mid[0], w.mid[1], z),
    at(w.other[0], w.other[1], z),
  ];
  return ['interpolate', ['exponential', 2], ['zoom'], 13, stop(13), 16, stop(16), 18, stop(18), 20, stop(20)];
}

const name: ExpressionSpecification = ['coalesce', ['get', 'name:latin'], ['get', 'name']];

const MAJOR = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];

export function buildStyle(origin: string): StyleSpecification {
  const roadClasses: [string, string[], number, number, string][] = [
    // id, classes, metres, min px, colour
    ['service', ['service', 'track'], 5, 0.4, WORLD.road],
    ['minor', ['minor', 'raceway', 'busway', 'bus_guideway'], 8.5, 0.6, WORLD.road],
    ['tertiary', ['tertiary'], 12, 0.9, WORLD.road],
    ['secondary', ['secondary'], 14, 1.0, WORLD.roadMajor],
    ['primary', ['primary', 'trunk'], 17, 1.2, WORLD.roadMajor],
    ['motorway', ['motorway'], 22, 1.4, WORLD.roadMajor],
  ];

  const layers: LayerSpecification[] = [
    { id: 'ground', type: 'background', paint: { 'background-color': WORLD.ground } },
    {
      id: 'landuse-campus', type: 'fill', source: SRC, 'source-layer': 'landuse',
      filter: ['in', ['get', 'class'], ['literal', ['school', 'university', 'college', 'kindergarten', 'library']]],
      paint: { 'fill-color': WORLD.campus },
    },
    {
      id: 'landuse-hospital', type: 'fill', source: SRC, 'source-layer': 'landuse',
      filter: ['==', ['get', 'class'], 'hospital'],
      paint: { 'fill-color': WORLD.hospital },
    },
    {
      id: 'landuse-cemetery', type: 'fill', source: SRC, 'source-layer': 'landuse',
      filter: ['==', ['get', 'class'], 'cemetery'],
      paint: { 'fill-color': WORLD.cemetery },
    },
    {
      id: 'landcover-grass', type: 'fill', source: SRC, 'source-layer': 'landcover',
      filter: ['in', ['get', 'class'], ['literal', ['grass', 'farmland']]],
      paint: { 'fill-color': WORLD.park, 'fill-opacity': ['match', ['get', 'class'], 'farmland', 0.5, 1] },
    },
    {
      id: 'landcover-wood', type: 'fill', source: SRC, 'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'wood'],
      paint: { 'fill-color': WORLD.wood },
    },
    {
      id: 'landuse-pitch', type: 'fill', source: SRC, 'source-layer': 'landuse',
      filter: ['in', ['get', 'class'], ['literal', ['pitch', 'playground', 'stadium']]],
      paint: { 'fill-color': WORLD.pitch },
    },
    {
      id: 'water', type: 'fill', source: SRC, 'source-layer': 'water',
      filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      paint: { 'fill-color': WORLD.water, 'fill-antialias': true },
    },
    {
      id: 'water-shallows', type: 'line', source: SRC, 'source-layer': 'water',
      filter: ['!=', ['get', 'class'], 'swimming_pool'],
      minzoom: 13,
      paint: {
        'line-color': WORLD.waterEdge,
        'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, 1, 16, 4, 19, 18],
        'line-blur': ['interpolate', ['exponential', 2], ['zoom'], 13, 1, 16, 4, 19, 16],
        'line-opacity': 0.9,
      },
    },
    {
      id: 'waterway', type: 'line', source: SRC, 'source-layer': 'waterway',
      filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      paint: { 'line-color': WORLD.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 17, 6] },
    },
    {
      id: 'pedestrian-area', type: 'fill', source: SRC, 'source-layer': 'transportation',
      filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['in', ['get', 'class'], ['literal', ['path', 'pedestrian', 'pier']]]],
      paint: { 'fill-color': WORLD.pedestrian },
    },
    {
      id: 'ferry', type: 'line', source: SRC, 'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'ferry'],
      minzoom: 11,
      paint: { 'line-color': WORLD.ferry, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 17, 1.8], 'line-dasharray': [3, 3], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 14, 0.3, 15.2, 0] },
    },
    {
      id: 'path', type: 'line', source: SRC, 'source-layer': 'transportation',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['in', ['get', 'class'], ['literal', ['path', 'pedestrian']]], ['!=', ['get', 'brunnel'], 'tunnel']],
      minzoom: 14.5,
      paint: { 'line-color': WORLD.path, 'line-width': roadWidth(2.6, 0.5) },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    },
    // bridge casings sit under every road so bridges read clearly over water
    {
      id: 'bridge-casing', type: 'line', source: SRC, 'source-layer': 'transportation',
      filter: ['all', ['==', ['get', 'brunnel'], 'bridge'], ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'path', 'pedestrian']]]],
      minzoom: 13,
      paint: {
        'line-color': WORLD.roadBridgeCasing,
        'line-width': classWidth({ major: [21, 2.4], mid: [17, 2], other: [10, 1.4] }),
      },
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
    },
    ...roadClasses.map(([id, classes, m, min, colour]): LayerSpecification => ({
      id: `road-${id}`, type: 'line', source: SRC, 'source-layer': 'transportation',
      filter: ['all', ['in', ['get', 'class'], ['literal', classes]], ['!=', ['get', 'brunnel'], 'tunnel'], ['==', ['geometry-type'], 'LineString']],
      minzoom: id === 'service' ? 14 : id === 'minor' ? 12 : 8,
      paint: { 'line-color': colour, 'line-width': roadWidth(m, min) },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })),
    {
      id: 'rail', type: 'line', source: SRC, 'source-layer': 'transportation',
      filter: ['all', ['in', ['get', 'class'], ['literal', ['rail', 'transit']]], ['!=', ['get', 'brunnel'], 'tunnel']],
      paint: { 'line-color': WORLD.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 17, 2.6] },
    },
    {
      id: 'rail-ties', type: 'line', source: SRC, 'source-layer': 'transportation',
      filter: ['all', ['in', ['get', 'class'], ['literal', ['rail', 'transit']]], ['!=', ['get', 'brunnel'], 'tunnel']],
      minzoom: 15,
      paint: { 'line-color': WORLD.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 4, 18, 9], 'line-dasharray': [0.18, 1.6] },
    },
    {
      id: 'building-flat', type: 'fill', source: SRC, 'source-layer': 'building',
      minzoom: 12.5,
      paint: {
        'fill-color': WORLD.buildingFlat,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13.2, 0.9, 14.1, 0.9, 14.6, 0],
      },
    },
    // ---- labels sit above the 3D city (the custom layer is inserted before 'oneway-arrows')
    {
      id: 'oneway-arrows', type: 'symbol', source: SRC, 'source-layer': 'transportation',
      filter: ['all', ['in', ['get', 'oneway'], ['literal', [1, -1]]], ['in', ['get', 'class'], ['literal', [...MAJOR, 'minor']]], ['!=', ['get', 'brunnel'], 'tunnel']],
      minzoom: 16.3,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 150,
        'icon-image': 'oneway',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 16.3, 0.45, 19, 0.8],
        'icon-rotate': ['match', ['get', 'oneway'], -1, 180, 0],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-padding': 4,
      },
      paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 16.3, 0, 16.8, 0.85] },
    },
    {
      id: 'street-labels', type: 'symbol', source: SRC, 'source-layer': 'transportation_name',
      filter: ['all', ['!', ['in', ['get', 'class'], ['literal', ['rail', 'transit', 'ferry', 'path', 'track']]]], ['has', 'name']],
      minzoom: 14.6,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 320,
        'text-field': name,
        'text-font': ['Figtree-SemiBold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 14.6, 10, 16, 11.5, 18, 14, 20, 17],
        'text-letter-spacing': 0.04,
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'map',
        'text-max-angle': 32,
        'text-padding': 6,
      },
      paint: {
        'text-color': WORLD.streetLabel,
        'text-halo-color': 'rgba(198, 206, 209, 0.85)',
        'text-halo-width': 1.1,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 14.6, 0, 15.1, 1],
      },
    },
    {
      id: 'water-labels', type: 'symbol', source: SRC, 'source-layer': 'water_name',
      layout: {
        'text-field': name,
        'text-font': ['Figtree-Medium'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 12, 16, 17],
        'text-letter-spacing': 0.32,
        'text-transform': 'uppercase',
        'text-max-width': 8,
      },
      paint: { 'text-color': WORLD.waterLabel, 'text-halo-color': 'rgba(164, 202, 214, 0.6)', 'text-halo-width': 1 },
    },
    {
      id: 'place-labels', type: 'symbol', source: SRC, 'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['suburb', 'quarter']]],
      minzoom: 12.5,
      maxzoom: 16.6,
      layout: {
        'text-field': name,
        'text-font': ['Figtree-Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 12.5, 11, 15, 13, 16.6, 14],
        'text-letter-spacing': 0.24,
        'text-transform': 'uppercase',
        'text-max-width': 9,
        'text-padding': 110,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: {
        'text-color': WORLD.placeLabel,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, 0.9, 15.6, 0.62, 16.6, 0],
        'text-halo-color': 'rgba(235, 232, 224, 0.75)',
        'text-halo-width': 1.4,
      },
    },
    {
      id: 'city-labels', type: 'symbol', source: SRC, 'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
      maxzoom: 12.5,
      layout: {
        'text-field': name,
        'text-font': ['Figtree-Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 6, 13, 12, 22],
        'text-letter-spacing': 0.06,
      },
      paint: { 'text-color': '#5b636c', 'text-halo-color': 'rgba(235, 232, 224, 0.85)', 'text-halo-width': 1.6 },
    },
  ];

  return {
    version: 8,
    name: 'Project Transit — Miniature',
    glyphs: `${origin}fonts/{fontstack}/{range}.pbf`,
    sources: {
      [SRC]: { type: 'vector', url: OFM_TILEJSON },
    },
    sky: {
      'sky-color': '#dfe7ea',
      'horizon-color': '#eeece6',
      'fog-color': '#ebe8e0',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.8,
      'fog-ground-blend': 0.85,
      'atmosphere-blend': 0,
    },
    layers,
  };
}
