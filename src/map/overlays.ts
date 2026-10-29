// MapLibre overlay layers: transport lines, catchments, traffic estimates,
// demand heat and the draft route. All driven from the sim + UI store.

import type { Map as MlMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
import type { FeatureCollection, Feature, LineString, Point, Polygon } from 'geojson';
import { OSM_STOPS, servedStopFor } from '../sim/osmStops.ts';
import { sim } from '../sim/sim.ts';
import { useUI } from '../state/store.ts';
import graphData from '../data/istanbul/graph.json';
import { edgeCongestion } from '../sim/traffic.ts';
import type { RoadGraph } from '../sim/roadGraph.ts';

export const GRAPH = graphData as RoadGraph;

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function circle(center: [number, number], radiusM: number, steps = 72): Polygon {
  const coords: [number, number][] = [];
  const k = Math.cos((center[1] * Math.PI) / 180);
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    coords.push([center[0] + (Math.cos(a) * radiusM) / (111320 * k), center[1] + (Math.sin(a) * radiusM) / 111320]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

function chevronImage(_colour: string) {
  // A small white chevron that sits inside the coloured line.
  const r = 3, w = 12, h = 12;
  const c = document.createElement('canvas');
  c.width = w * r; c.height = h * r;
  const ctx = c.getContext('2d')!;
  ctx.scale(r, r);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 1.9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(4.6, 3.2); ctx.lineTo(7.6, 6); ctx.lineTo(4.6, 8.8); ctx.stroke();
  return { image: ctx.getImageData(0, 0, c.width, c.height), pixelRatio: r };
}

const LW_STOPS: [number, number][] = [[12, 2], [15, 3.6], [17, 6], [19, 11]];
/** Zoom-scaled line width; `f` maps the base width at each stop (zoom must stay top-level). */
function zw(f: (w: number) => ExpressionSpecification | number): ExpressionSpecification {
  const out: unknown[] = ['interpolate', ['exponential', 1.6], ['zoom']];
  for (const [z, w] of LW_STOPS) out.push(z, f(w));
  return out as ExpressionSpecification;
}
const lineOffset = zw((w) => ['+', w * 0.62, ['*', ['get', 'lane'], w * 1.08]] as ExpressionSpecification);
const focusCase = (on: number, off: number): ExpressionSpecification => ['case', ['boolean', ['feature-state', 'focus'], false], on, off];

export function installOverlays(map: MlMap) {
  const before = 'city-3d'; // ground overlays sit under buildings, trees and buses
  // ---------------- traffic (simulated estimates)
  map.addSource('traffic', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'traffic', type: 'line', source: 'traffic', layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': ['interpolate', ['linear'], ['get', 'c'], 0, '#62c98d', 0.38, '#9fd35f', 0.55, '#f0c04f', 0.72, '#ee8b55', 0.88, '#de5a5a'],
      'line-width': ['interpolate', ['exponential', 1.7], ['zoom'], 12, ['*', 1.4, ['get', 'w']], 15, ['*', 3.4, ['get', 'w']], 17, ['*', 6.4, ['get', 'w']], 19, ['*', 13, ['get', 'w']]],
      'line-offset': ['interpolate', ['exponential', 1.7], ['zoom'], 12, ['*', 0.5, ['get', 'o']], 15, ['*', 1.6, ['get', 'o']], 17, ['*', 3.5, ['get', 'o']], 19, ['*', 9, ['get', 'o']]],
      'line-opacity': 0.92,
    },
  }, before);

  // ---------------- demand heat (prototype estimate from building density)
  map.addSource('demand', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'demand', type: 'heatmap', source: 'demand', layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': ['get', 'w'],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 15, 0.62, 17, 0.8],
      'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 12, 9, 15, 27, 17, 95, 19, 340],
      'heatmap-opacity': 0.78,
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(70,170,180,0)', 0.12, 'rgba(70,170,180,0.35)', 0.35, 'rgba(150,205,120,0.55)', 0.6, 'rgba(242,198,82,0.65)', 0.82, 'rgba(238,128,84,0.72)', 1, 'rgba(222,86,110,0.8)'],
    },
  }, before);

  // ---------------- catchments
  map.addSource('catchment', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'catchment-fill', type: 'fill', source: 'catchment', paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': ['get', 'fo'] } }, before);
  map.addLayer({ id: 'catchment-line', type: 'line', source: 'catchment', paint: { 'line-color': ['get', 'colour'], 'line-width': 1.6, 'line-opacity': ['get', 'lo'], 'line-dasharray': [3, 2] } }, before);

  // ---------------- lines
  for (const l of sim.lines) map.addImage(`chev-${l.id}`, chevronImage(l.colour).image, { pixelRatio: 3 });
  map.addImage('chev-draft', chevronImage('#4fa3e0').image, { pixelRatio: 3 });
  map.addSource('lines', { type: 'geojson', data: linesGeoJSON() });
  map.addLayer({
    id: 'lines-halo', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': zw((w) => focusCase(w + 6, w + 2.4)),
      'line-offset': lineOffset,
      'line-opacity': ['case', ['boolean', ['feature-state', 'dim'], false], 0.25, ['boolean', ['feature-state', 'focus'], false], 1, 0.85],
      'line-blur': ['case', ['boolean', ['feature-state', 'focus'], false], 1.5, 0],
    },
  }, before);
  map.addLayer({
    id: 'lines', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'colour'],
      'line-width': zw((w) => focusCase(w * 1.25, w)),
      'line-offset': lineOffset,
      'line-opacity': ['case', ['boolean', ['feature-state', 'dim'], false], 0.28, 1],
    },
  }, before);
  // direction chevrons, one layer per lane so they sit inside the offset line
  const iconSize = (z: number) => (z <= 15 ? 0.5 : z <= 17 ? 0.5 + ((z - 15) / 2) * 0.25 : 0.75 + ((z - 17) / 2) * 0.55);
  const widthAt = (z: number) => {
    for (let i = 1; i < LW_STOPS.length; i++) {
      const [z0, w0] = LW_STOPS[i - 1], [z1, w1] = LW_STOPS[i];
      if (z <= z1) {
        const t = (Math.pow(1.6, z - z0) - 1) / (Math.pow(1.6, z1 - z0) - 1);
        return w0 + (w1 - w0) * Math.max(0, t);
      }
    }
    return LW_STOPS[LW_STOPS.length - 1][1];
  };
  for (const lane of [0, 1, 2]) {
    const offset: unknown[] = ['interpolate', ['linear'], ['zoom']];
    for (const z of [15, 16, 17, 18, 19]) offset.push(z, ['literal', [0, (widthAt(z) * 0.62 + lane * widthAt(z) * 1.08) / iconSize(z)]]);
    map.addLayer({
      id: `lines-chevrons-${lane}`, type: 'symbol', source: 'lines', minzoom: 15, filter: ['==', ['get', 'lane'], lane],
      layout: {
        'symbol-placement': 'line', 'symbol-spacing': 110,
        'icon-image': ['concat', 'chev-', ['get', 'id']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 17, 0.75, 19, 1.3],
        'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-offset': offset as ExpressionSpecification,
      },
      paint: { 'icon-opacity': ['case', ['boolean', ['feature-state', 'dim'], false], 0, 0.95] },
    }, before);
  }
  // invisible fat hit area for hover / click
  map.addLayer({ id: 'lines-hit', type: 'line', source: 'lines', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16, 'line-offset': lineOffset } }, before);

  // ---------------- draft route
  map.addSource('draft', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'draft-halo', type: 'line', source: 'draft', filter: ['==', ['get', 'kind'], 'path'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': zw((w) => w + 5), 'line-opacity': 0.95 } }, 'oneway-arrows');
  map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['==', ['get', 'kind'], 'path'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': zw((w) => w * 1.1) } }, 'oneway-arrows');
  map.addLayer({ id: 'draft-return', type: 'line', source: 'draft', filter: ['==', ['get', 'kind'], 'return'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': zw((w) => w * 0.7), 'line-opacity': 0.55, 'line-dasharray': [1.4, 1.2] } }, 'oneway-arrows');
  map.addLayer({ id: 'draft-preview', type: 'line', source: 'draft', filter: ['==', ['get', 'kind'], 'preview'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': zw((w) => w * 0.9), 'line-opacity': 0.8, 'line-dasharray': [1, 1] } }, 'oneway-arrows');

  // ---------------- real OSM bus stops that no line serves yet (shown while drawing a route)
  const hover = ['boolean', ['feature-state', 'hover'], false] as ExpressionSpecification;
  map.addSource('osm-stops', { type: 'geojson', data: freeStopsGeoJSON(), promoteId: 'id' });
  map.addLayer({
    id: 'osm-stops-dot', type: 'circle', source: 'osm-stops', layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, ['case', hover, 6.5, 4.4], 16, ['case', hover, 10, 7], 18, ['case', hover, 13, 9.5]],
      'circle-color': '#ffffff',
      'circle-stroke-color': ['case', hover, '#4fa3e0', '#2a5d45'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14, 1.6, 17, 2.6],
      'circle-pitch-alignment': 'viewport',
    },
  }, 'oneway-arrows');
  map.addLayer({
    id: 'osm-stops-name', type: 'symbol', source: 'osm-stops', minzoom: 15.4, layout: {
      visibility: 'none', 'text-field': ['get', 'name'], 'text-font': ['Figtree-SemiBold'], 'text-size': 11.5,
      'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-max-width': 9, 'text-padding': 3, 'text-optional': true,
    },
    paint: { 'text-color': '#24332c', 'text-halo-color': 'rgba(255,255,255,0.94)', 'text-halo-width': 1.6 },
  }, 'oneway-arrows');
  let stopHover: string | null = null;
  let stopColour = '';
  let drafted = '';

  let lastFocus: string | null = null;
  sim.onNetwork(() => {
    for (const l of sim.lines) if (!map.hasImage(`chev-${l.id}`)) map.addImage(`chev-${l.id}`, chevronImage(l.colour).image, { pixelRatio: 3 });
    (map.getSource('lines') as GeoJSONSource).setData(linesGeoJSON());
    (map.getSource('osm-stops') as GeoJSONSource).setData(freeStopsGeoJSON());
    setTimeout(applyLineStates, 50);
  });
  const applyLineStates = () => {
    const ui = useUI.getState();
    const sel = ui.selection;
    let focus: string | null = null;
    if (sel?.kind === 'line') focus = sel.id;
    else if (sel?.kind === 'vehicle') focus = sim.vehicle(sel.id)?.lineId ?? null;
    const hoverLine = ui.hover?.kind === 'line' ? ui.hover.id : null;
    const draftActive = !!ui.draft;
    for (const [i, l] of sim.lines.entries()) {
      const fid = i + 1;
      const isFocus = focus === l.id || hoverLine === l.id;
      const dim = (focus !== null && focus !== l.id && hoverLine !== l.id) || draftActive;
      map.setFeatureState({ source: 'lines', id: fid }, { focus: isFocus, dim });
    }
    if (focus !== lastFocus) lastFocus = focus;
    // catchments for the selected stop / line
    const feats: Feature[] = [];
    const stopCircle = (id: string, colour: string, strong: boolean) => {
      const s = sim.stops.get(id);
      if (!s) return;
      feats.push({ type: 'Feature', properties: { colour, fo: strong ? 0.12 : 0.05, lo: strong ? 0.9 : 0.45 }, geometry: circle(s.lngLat, s.catchmentM) });
    };
    if (sel?.kind === 'stop') stopCircle(sel.id, '#2f9e6e', true);
    if (sel?.kind === 'line') for (const ls of sim.line(sel.id)?.stops ?? []) stopCircle(ls.stopId, sim.line(sel.id)!.colour, false);
    if (ui.hover?.kind === 'stop' && ui.hover.id !== (sel?.kind === 'stop' ? sel.id : '')) stopCircle(ui.hover.id, '#2f9e6e', false);
    for (const d of ui.draft?.stops ?? []) {
      feats.push({ type: 'Feature', properties: { colour: '#4fa3e0', fo: 0.07, lo: 0.7 }, geometry: circle(d.lngLat, 300) });
    }
    (map.getSource('catchment') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
    // overlays
    map.setLayoutProperty('traffic', 'visibility', ui.overlays.traffic ? 'visible' : 'none');
    map.setLayoutProperty('demand', 'visibility', ui.overlays.demand ? 'visible' : 'none');
    const drawing = ui.tool === 'route' ? 'visible' : 'none';
    map.setLayoutProperty('osm-stops-dot', 'visibility', drawing);
    map.setLayoutProperty('osm-stops-name', 'visibility', drawing);
    const ids = (ui.draft?.stops ?? []).map((d) => d.stopId);
    if (ids.join() !== drafted) {
      drafted = ids.join();
      const filter: ExpressionSpecification = ['!', ['in', ['get', 'id'], ['literal', ids]]];
      map.setFilter('osm-stops-dot', filter);
      map.setFilter('osm-stops-name', filter);
    }
    if (ui.draft && ui.draft.colour !== stopColour) {
      stopColour = ui.draft.colour;
      map.setPaintProperty('osm-stops-dot', 'circle-stroke-color', ['case', hover, stopColour, '#2a5d45']);
    }
  };
  applyLineStates();
  useUI.subscribe(applyLineStates);

  // traffic refresh each in-game 10 minutes while visible
  let lastTrafficSlot = -1;
  const refreshTraffic = () => {
    if (!useUI.getState().overlays.traffic) return;
    const slot = Math.floor(sim.minutes / 10);
    if (slot === lastTrafficSlot) return;
    lastTrafficSlot = slot;
    (map.getSource('traffic') as GeoJSONSource).setData(trafficGeoJSON(sim.hour));
  };
  sim.onMinute(refreshTraffic);
  useUI.subscribe((s, p) => { if (s.overlays.traffic && !p.overlays.traffic) { lastTrafficSlot = -1; refreshTraffic(); } });

  return {
    /** Highlight the OSM stop under the pointer while drawing a route. */
    setStopHover(id: string | null) {
      if (id === stopHover) return;
      if (stopHover) map.setFeatureState({ source: 'osm-stops', id: stopHover }, { hover: false });
      stopHover = id && id.startsWith('O') ? id : null;
      if (stopHover) map.setFeatureState({ source: 'osm-stops', id: stopHover }, { hover: true });
    },
    setDemand(data: FeatureCollection<Point>) {
      (map.getSource('demand') as GeoJSONSource).setData(data);
    },
    setDraft(colour: string, parts: { path?: [number, number][][]; ret?: [number, number][] | null; preview?: [number, number][] | null }) {
      const features: Feature[] = [];
      for (const p of parts.path ?? []) if (p.length > 1) features.push({ type: 'Feature', properties: { kind: 'path', colour }, geometry: { type: 'LineString', coordinates: p } });
      if (parts.ret && parts.ret.length > 1) features.push({ type: 'Feature', properties: { kind: 'return', colour }, geometry: { type: 'LineString', coordinates: parts.ret } });
      if (parts.preview && parts.preview.length > 1) features.push({ type: 'Feature', properties: { kind: 'preview', colour }, geometry: { type: 'LineString', coordinates: parts.preview } });
      (map.getSource('draft') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    },
  };
}

/**
 * Lines split into runs with a "lane" index: where several lines travel the same street
 * in the same direction they are drawn side by side instead of on top of each other.
 */
function linesGeoJSON(): FeatureCollection<LineString> {
  const key = (a: [number, number], b: [number, number]) => `${a[0].toFixed(5)},${a[1].toFixed(5)}>${b[0].toFixed(5)},${b[1].toFixed(5)}`;
  const users = new Map<string, string[]>();
  for (const l of sim.lines)
    for (let i = 1; i < l.path.length; i++) {
      const k = key(l.path[i - 1], l.path[i]);
      const u = users.get(k);
      if (!u) users.set(k, [l.id]);
      else if (!u.includes(l.id)) u.push(l.id);
    }
  const features: Feature<LineString>[] = [];
  sim.lines.forEach((l, li) => {
    let run: [number, number][] = [l.path[0]];
    let lane = -1;
    const flush = () => {
      if (run.length > 1) features.push({ type: 'Feature', id: li + 1, properties: { id: l.id, colour: l.colour, number: l.number, lane: Math.max(0, lane) }, geometry: { type: 'LineString', coordinates: run } });
    };
    for (let i = 1; i < l.path.length; i++) {
      const laneHere = users.get(key(l.path[i - 1], l.path[i]))!.indexOf(l.id);
      if (lane !== -1 && laneHere !== lane) {
        flush();
        run = [l.path[i - 1]];
      }
      lane = laneHere;
      run.push(l.path[i]);
    }
    flush();
  });
  return { type: 'FeatureCollection', features };
}

const ROAD_W = [2.2, 2.0, 1.8, 1.6, 1.4, 1.0, 0, 1.2];

function trafficGeoJSON(hour: number): FeatureCollection<LineString> {
  const g = GRAPH;
  const features: Feature<LineString>[] = [];
  for (let e = 0, id = 0; e < g.edges.length; e += 4, id++) {
    const cls = g.edges[e + 2];
    if (cls === 6) continue; // service roads
    const a = g.edges[e], b = g.edges[e + 1], oneway = g.edges[e + 3];
    const coords: [number, number][] = [[g.nodes[a * 2], g.nodes[a * 2 + 1]], [g.nodes[b * 2], g.nodes[b * 2 + 1]]];
    const w = ROAD_W[cls] ?? 1;
    if (oneway) {
      features.push({ type: 'Feature', properties: { c: edgeCongestion(id, cls, hour), w, o: 0 }, geometry: { type: 'LineString', coordinates: coords } });
    } else {
      // two directions, each offset to its side of the carriageway
      features.push({ type: 'Feature', properties: { c: edgeCongestion(id * 2 + 1, cls, hour), w: w * 0.55, o: w * 0.45 }, geometry: { type: 'LineString', coordinates: coords } });
      features.push({ type: 'Feature', properties: { c: edgeCongestion(id * 2 + 7, cls, hour + 0.7), w: w * 0.55, o: w * 0.45 }, geometry: { type: 'LineString', coordinates: [coords[1], coords[0]] } });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Real OSM stops that no line serves yet. */
function freeStopsGeoJSON(): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: OSM_STOPS.filter((o) => !servedStopFor(o)).map((o) => ({ type: 'Feature', properties: { id: o.id, name: o.name }, geometry: { type: 'Point', coordinates: o.lngLat } })),
  };
}
