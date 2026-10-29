// MapLibre overlay layers driven by the game: lines, catchments, simulated traffic, estimated
// demand, operating areas (licences), the game-area boundary and the line being drafted.

import type { Map as MlMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, MultiLineString, Point, Polygon } from 'geojson';
import { useUI } from '../state/store.ts';
import { session, useSession } from '../app/session.ts';
import type { Game } from '../game/engine.ts';
import type { Pattern } from '../game/network.ts';
import { projector, type LngLat } from '../game/world/graph.ts';
import type { Region } from '../game/world/region.ts';
import { STOP_RULES } from '../game/content.ts';
import { licenceInfo } from '../game/progress.ts';
import { drivesOnLeft } from '../game/world/locale.ts';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function circle(center: LngLat, radiusM: number, steps = 72): Polygon {
  const coords: LngLat[] = [];
  const k = Math.cos((center[1] * Math.PI) / 180);
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    coords.push([center[0] + (Math.cos(a) * radiusM) / (111320 * k), center[1] + (Math.sin(a) * radiusM) / 111320]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

function chevronImage() {
  const r = 3, w = 12, h = 12;
  const c = document.createElement('canvas');
  c.width = w * r;
  c.height = h * r;
  const ctx = c.getContext('2d')!;
  ctx.scale(r, r);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1.9;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(4.6, 3.2);
  ctx.lineTo(7.6, 6);
  ctx.lineTo(4.6, 8.8);
  ctx.stroke();
  return ctx.getImageData(0, 0, c.width, c.height);
}

function hatchImage(colour: string, alpha: number) {
  const r = 2, s = 10;
  const c = document.createElement('canvas');
  c.width = c.height = s * r;
  const ctx = c.getContext('2d')!;
  ctx.scale(r, r);
  ctx.strokeStyle = colour;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (let o = -s; o <= s; o += 5) {
    ctx.moveTo(o, s);
    ctx.lineTo(o + s, 0);
  }
  ctx.stroke();
  return ctx.getImageData(0, 0, c.width, c.height);
}

const LW_STOPS: [number, number][] = [[12, 2], [15, 3.6], [17, 6], [19, 11]];
function zw(f: (w: number) => ExpressionSpecification | number): ExpressionSpecification {
  const out: unknown[] = ['interpolate', ['exponential', 1.6], ['zoom']];
  for (const [z, w] of LW_STOPS) out.push(z, f(w));
  return out as ExpressionSpecification;
}
const focusCase = (on: number, off: number): ExpressionSpecification => ['case', ['boolean', ['feature-state', 'focus'], false], on, off];

export const routeFid = (id: string) => Number(id.replace(/\D/g, '')) || 0;

export interface Overlays {
  setDraft(colour: string, parts: { out?: LngLat[] | null; ret?: LngLat[] | null; preview?: LngLat[] | null; via?: LngLat[] }): void;
  setStopHover(id: number | null): void;
  refreshAll(): void;
  setZoneHover(id: string | null): void;
}

export function installOverlays(map: MlMap): Overlays {
  const before = 'city-3d';
  let sideSign = 1; // +1 drive on the right, −1 on the left
  const lineOffset = () => zw((w) => ['*', sideSign, ['+', w * 0.62, ['*', ['get', 'lane'], w * 1.08]]] as ExpressionSpecification);

  // ── game area: dim everything outside the mapped region
  map.addSource('region-mask', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'region-mask', type: 'fill', source: 'region-mask', paint: { 'fill-color': '#26302b', 'fill-opacity': 0.34 } }, before);
  map.addLayer({ id: 'region-edge', type: 'line', source: 'region-mask', paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.7, 'line-dasharray': [3, 2] } }, before);

  // ── operating areas
  map.addImage('hatch-locked', hatchImage('#3a4740', 0.32), { pixelRatio: 2 });
  map.addSource('zones', { type: 'geojson', data: EMPTY, promoteId: 'id' });
  const zoneState = (owned: string, avail: string, locked: string, pick: string): ExpressionSpecification =>
    ['match', ['get', 'state'], 'owned', owned, 'available', avail, 'pick', pick, locked];
  const hovered = ['boolean', ['feature-state', 'hover'], false] as ExpressionSpecification;
  const chosen = ['boolean', ['feature-state', 'chosen'], false] as ExpressionSpecification;
  map.addLayer({ id: 'zones-hatch', type: 'fill', source: 'zones', filter: ['==', ['get', 'state'], 'locked'], layout: { visibility: 'none' }, paint: { 'fill-pattern': 'hatch-locked', 'fill-opacity': 0.9 } }, before);
  map.addLayer({
    id: 'zones-fill', type: 'fill', source: 'zones', layout: { visibility: 'none' },
    paint: {
      'fill-color': ['case', chosen, '#2f9e6e', zoneState('#2f9e6e', '#e3a33b', '#56635c', '#4f8fe0')],
      'fill-opacity': ['case', chosen, 0.26, hovered, 0.2, ['match', ['get', 'state'], 'owned', 0.05, 'available', 0.1, 'pick', 0.06, 0.07]],
    },
  }, before);
  map.addLayer({
    id: 'zones-line', type: 'line', source: 'zones', layout: { visibility: 'none', 'line-join': 'round' },
    paint: {
      'line-color': ['case', chosen, '#2f9e6e', zoneState('#2f9e6e', '#d9962c', '#5d6a63', '#4f8fe0')],
      'line-width': ['case', chosen, 3.2, hovered, 2.6, ['match', ['get', 'state'], 'owned', 2.2, 1.4]],
      'line-opacity': 0.85,
      'line-dasharray': ['match', ['get', 'state'], 'owned', ['literal', [1, 0]], ['literal', [2.5, 1.6]]],
    },
  }, before);
  map.addSource('zone-labels', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'zones-label', type: 'symbol', source: 'zone-labels', layout: {
      visibility: 'none', 'text-field': ['get', 'label'], 'text-font': ['Figtree-SemiBold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 11, 16, 14],
      'text-max-width': 10, 'text-allow-overlap': false, 'text-padding': 6, 'text-letter-spacing': 0.02,
    },
    paint: {
      'text-color': ['match', ['get', 'state'], 'owned', '#1f6b4c', 'available', '#8a5a12', 'pick', '#2a5b9c', '#4a5650'],
      'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.8,
    },
  }, 'oneway-arrows');

  // ── traffic (simulated)
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

  // ── demand (estimated from map data)
  map.addSource('demand', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'demand', type: 'heatmap', source: 'demand', layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': ['get', 'w'],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 15, 0.8, 17, 1],
      'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 12, 10, 14, 22, 15, 38, 17, 140, 19, 520],
      'heatmap-opacity': 0.72,
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(70,170,180,0)', 0.12, 'rgba(70,170,180,0.35)', 0.35, 'rgba(150,205,120,0.55)', 0.6, 'rgba(242,198,82,0.65)', 0.82, 'rgba(238,128,84,0.72)', 1, 'rgba(222,86,110,0.8)'],
    },
  }, before);

  // ── catchments
  map.addSource('catchment', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'catchment-fill', type: 'fill', source: 'catchment', paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': ['get', 'fo'] } }, before);
  map.addLayer({ id: 'catchment-line', type: 'line', source: 'catchment', paint: { 'line-color': ['get', 'colour'], 'line-width': 1.6, 'line-opacity': ['get', 'lo'], 'line-dasharray': [3, 2] } }, before);

  // ── lines
  map.addImage('chev', chevronImage(), { pixelRatio: 3 });
  map.addSource('lines', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'lines-halo', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': zw((w) => focusCase(w + 6, w + 2.4)),
      'line-offset': lineOffset(),
      'line-opacity': ['case', ['boolean', ['feature-state', 'dim'], false], 0.25, ['boolean', ['feature-state', 'focus'], false], 1, 0.85],
      'line-blur': ['case', ['boolean', ['feature-state', 'focus'], false], 1.5, 0],
    },
  }, before);
  map.addLayer({
    id: 'lines', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'colour'],
      'line-width': zw((w) => focusCase(w * 1.25, w)),
      'line-offset': lineOffset(),
      'line-opacity': ['case', ['boolean', ['feature-state', 'dim'], false], 0.28, ['==', ['get', 'suspended'], true], 0.45, 1],
    },
  }, before);
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
  const iconSize = (z: number) => (z <= 15 ? 0.5 : z <= 17 ? 0.5 + ((z - 15) / 2) * 0.25 : 0.75 + ((z - 17) / 2) * 0.55);
  const chevronOffsets = (lane: number) => {
    const offset: unknown[] = ['interpolate', ['linear'], ['zoom']];
    for (const z of [15, 16, 17, 18, 19]) offset.push(z, ['literal', [0, (sideSign * (widthAt(z) * 0.62 + lane * widthAt(z) * 1.08)) / iconSize(z)]]);
    return offset as ExpressionSpecification;
  };
  for (const lane of [0, 1, 2]) {
    map.addLayer({
      id: `lines-chevrons-${lane}`, type: 'symbol', source: 'lines', minzoom: 15, filter: ['==', ['get', 'lane'], lane],
      layout: {
        'symbol-placement': 'line', 'symbol-spacing': 110, 'icon-image': 'chev',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 17, 0.75, 19, 1.3],
        'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-offset': chevronOffsets(lane),
      },
      paint: { 'icon-opacity': ['case', ['boolean', ['feature-state', 'dim'], false], 0, 0.95] },
    }, before);
  }
  map.addLayer({ id: 'lines-hit', type: 'line', source: 'lines', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16, 'line-offset': lineOffset() } }, before);

  // ── line being drafted
  map.addSource('draft', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'draft-halo', type: 'line', source: 'draft', filter: ['==', ['get', 'kind'], 'out'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': zw((w) => w + 5), 'line-opacity': 0.95 } }, 'oneway-arrows');
  map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['==', ['get', 'kind'], 'out'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': zw((w) => w * 1.1) } }, 'oneway-arrows');
  map.addLayer({ id: 'draft-return', type: 'line', source: 'draft', filter: ['==', ['get', 'kind'], 'ret'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': zw((w) => w * 0.75), 'line-opacity': 0.6, 'line-dasharray': [1.4, 1.2], 'line-offset': zw((w) => w * 0.9 * 1) } }, 'oneway-arrows');
  map.addLayer({ id: 'draft-preview', type: 'line', source: 'draft', filter: ['==', ['get', 'kind'], 'preview'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': zw((w) => w * 0.9), 'line-opacity': 0.8, 'line-dasharray': [1, 1] } }, 'oneway-arrows');
  map.addLayer({
    id: 'draft-chevrons', type: 'symbol', source: 'draft', minzoom: 14.5, filter: ['==', ['get', 'kind'], 'out'],
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 90, 'icon-image': 'chev', 'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.55, 17, 0.8, 19, 1.3], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
  }, 'oneway-arrows');
  map.addLayer({
    id: 'draft-via', type: 'circle', source: 'draft', filter: ['==', ['get', 'kind'], 'via'],
    paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': ['get', 'colour'], 'circle-stroke-width': 2.5, 'circle-pitch-alignment': 'viewport' },
  }, 'oneway-arrows');

  // ── real-world stop locations nobody serves yet (suggestions while building)
  const hover = ['boolean', ['feature-state', 'hover'], false] as ExpressionSpecification;
  map.addSource('osm-stops', { type: 'geojson', data: EMPTY, promoteId: 'id' });
  map.addLayer({
    id: 'osm-stops-dot', type: 'circle', source: 'osm-stops', layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, ['case', hover, 5.5, 3.4], 16, ['case', hover, 8, 5], 18, ['case', hover, 11, 7]],
      'circle-color': 'rgba(255,255,255,0.9)',
      'circle-stroke-color': ['case', hover, '#4fa3e0', '#7b8a82'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14, 1.2, 17, 2],
      'circle-pitch-alignment': 'viewport',
    },
  }, 'oneway-arrows');
  map.addLayer({
    id: 'osm-stops-name', type: 'symbol', source: 'osm-stops', minzoom: 16, layout: {
      visibility: 'none', 'text-field': ['get', 'name'], 'text-font': ['Figtree-SemiBold'], 'text-size': 11,
      'text-anchor': 'top', 'text-offset': [0, 0.8], 'text-max-width': 9, 'text-padding': 3, 'text-optional': true,
    },
    paint: { 'text-color': '#5c6a63', 'text-halo-color': 'rgba(255,255,255,0.94)', 'text-halo-width': 1.4 },
  }, 'oneway-arrows');

  // ───────────────────────── data
  let game: Game | null = null;
  let region: Region | null = null;
  let stopHover: number | null = null;
  let lastTraffic = 0;
  let trafficSlot = -1;
  let routeIds: string[] = [];
  let zoneHover: string | null = null;
  let zoneChosen: string | null = null;
  const src = (id: string) => map.getSource(id) as GeoJSONSource;

  const setRegion = (r: Region | null) => {
    region = r;
    if (!r) {
      for (const s of ['region-mask', 'zones', 'zone-labels', 'demand', 'traffic', 'osm-stops']) src(s).setData(EMPTY);
      return;
    }
    const country = r.spec.country;
    const sign = drivesOnLeft(country) ? -1 : 1;
    if (sign !== sideSign) {
      sideSign = sign;
      for (const id of ['lines-halo', 'lines', 'lines-hit']) map.setPaintProperty(id, 'line-offset', lineOffset());
      for (const lane of [0, 1, 2]) map.setLayoutProperty(`lines-chevrons-${lane}`, 'icon-offset', chevronOffsets(lane));
    }
    const b = r.bounds;
    src('region-mask').setData({
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], [[b.w, b.s], [b.w, b.n], [b.e, b.n], [b.e, b.s], [b.w, b.s]]] },
    });
    // demand: residents + jobs per grid cell (estimates)
    const d = r.demand;
    const proj = projector(r.spec.centre);
    const feats: Feature<Point>[] = [];
    let max = 1;
    for (let i = 0; i < d.w * d.h; i++) max = Math.max(max, d.residents[i] + d.jobs[i] * 0.8);
    for (let j = 0; j < d.h; j++)
      for (let i = 0; i < d.w; i++) {
        const k = j * d.w + i;
        const v = d.residents[k] + d.jobs[k] * 0.8;
        if (v < max * 0.02) continue;
        const ll = proj.toLngLat(d.x0 + (i + 0.5) * d.cell, d.y0 + (j + 0.5) * d.cell);
        feats.push({ type: 'Feature', properties: { w: Math.min(1, v / (max * 0.6)) }, geometry: { type: 'Point', coordinates: ll } });
      }
    src('demand').setData({ type: 'FeatureCollection', features: feats });
    refreshZones();
    refreshOsmStops();
    trafficSlot = -1;
  };

  const refreshZones = () => {
    if (!region) return;
    const owned = new Set(game?.state.territory.owned ?? []);
    const setup = useSession.getState().phase === 'setup';
    const feats: Feature<Polygon>[] = [];
    const labels: Feature<Point>[] = [];
    for (const z of region.zones) {
      let state = 'locked';
      let label = z.name;
      if (setup) state = 'pick';
      else if (owned.has(z.id)) state = 'owned';
      else if (game) {
        const li = licenceInfo(game, z.id);
        if (li?.adjacent) {
          state = 'available';
          label = `${z.name}\n${game.money(li.cost, { compact: true })}`;
        } else label = `${z.name}\nLocked`;
      }
      const ring = [...z.ring, z.ring[0]];
      feats.push({ type: 'Feature', id: z.id, properties: { id: z.id, state, name: z.name }, geometry: { type: 'Polygon', coordinates: [ring] } });
      labels.push({ type: 'Feature', properties: { label, state }, geometry: { type: 'Point', coordinates: z.centroid } });
    }
    src('zones').setData({ type: 'FeatureCollection', features: feats });
    src('zone-labels').setData({ type: 'FeatureCollection', features: labels });
  };

  const refreshOsmStops = () => {
    if (!region) return;
    const stops = Object.values(game?.state.stops ?? {});
    const feats: Feature<Point>[] = [];
    region.osmStops.forEach((o, i) => {
      for (const s of stops) {
        const dx = (s.lngLat[0] - o.lngLat[0]) * 111320 * Math.cos((o.lngLat[1] * Math.PI) / 180);
        const dy = (s.lngLat[1] - o.lngLat[1]) * 110540;
        if (dx * dx + dy * dy < STOP_RULES.minSpacingM ** 2) return;
      }
      feats.push({ type: 'Feature', id: i + 1, properties: { id: i + 1, name: o.name }, geometry: { type: 'Point', coordinates: o.lngLat } });
    });
    src('osm-stops').setData({ type: 'FeatureCollection', features: feats });
  };

  /** Lines split into runs with a lane index so lines sharing a street sit side by side. */
  const refreshLines = () => {
    if (!game) {
      src('lines').setData(EMPTY);
      routeIds = [];
      return;
    }
    const g = game.region.graph;
    const users = new Map<number, string[]>();
    const routes = Object.values(game.state.routes);
    routeIds = routes.map((r) => r.id);
    const pats: [string, Pattern][] = [];
    for (const r of routes) for (const p of game.patterns.get(r.id) ?? []) if (p.path.nodes.length > 1) pats.push([r.id, p]);
    for (const [rid, p] of pats)
      for (const de of p.path.dedges) {
        const u = users.get(de);
        if (!u) users.set(de, [rid]);
        else if (!u.includes(rid)) u.push(rid);
      }
    const features: Feature<LineString>[] = [];
    for (const [rid, p] of pats) {
      const r = game.state.routes[rid];
      const fid = routeFid(rid);
      const nodes = p.path.nodes;
      let run: LngLat[] = [[g.lng[nodes[0]], g.lat[nodes[0]]]];
      let lane = -1;
      const flush = () => {
        if (run.length > 1) features.push({ type: 'Feature', id: fid, properties: { id: rid, colour: r.colour, number: r.number, lane: Math.max(0, Math.min(2, lane)), suspended: r.suspended }, geometry: { type: 'LineString', coordinates: run } });
      };
      for (let i = 0; i < p.path.dedges.length; i++) {
        const laneHere = users.get(p.path.dedges[i])!.indexOf(rid);
        if (lane !== -1 && laneHere !== lane) {
          flush();
          run = [run[run.length - 1]];
        }
        lane = laneHere;
        run.push([g.lng[nodes[i + 1]], g.lat[nodes[i + 1]]]);
      }
      flush();
    }
    src('lines').setData({ type: 'FeatureCollection', features });
    setTimeout(applyStates, 30);
  };

  /** Simulated congestion, bucketed into a few multi-line features for speed. */
  const refreshTraffic = (force = false) => {
    if (!game || !useUI.getState().overlays.traffic) return;
    const slot = Math.floor(game.t / 600);
    const now = performance.now();
    if (!force && (slot === trafficSlot || now - lastTraffic < 2500)) return;
    trafficSlot = slot;
    lastTraffic = now;
    const g = game.region.graph;
    const tr = game.traffic;
    const buckets = new Map<string, LngLat[][]>();
    const ROAD_W = [2.2, 2.0, 1.8, 1.6, 1.4, 1.0, 0, 1.2];
    const add = (de: number, w: number, o: number) => {
      const c = Math.round(tr.congestion(de, game!.t) * 10) / 10;
      const e = de >> 1;
      const a = (de & 1) === 0 ? g.ea[e] : g.eb[e];
      const b = (de & 1) === 0 ? g.eb[e] : g.ea[e];
      const k = `${c}|${w}|${o}`;
      let list = buckets.get(k);
      if (!list) buckets.set(k, (list = []));
      list.push([[g.lng[a], g.lat[a]], [g.lng[b], g.lat[b]]]);
    };
    for (let e = 0; e < g.m; e++) {
      const cls = g.cls[e];
      if (cls === 6) continue;
      const w = ROAD_W[cls] ?? 1;
      if (g.flags[e] & 1) add(e * 2, w, 0);
      else {
        add(e * 2, Math.round(w * 55) / 100, Math.round(w * 45 * sideSign) / 100);
        add(e * 2 + 1, Math.round(w * 55) / 100, Math.round(w * 45 * sideSign) / 100);
      }
    }
    const features: Feature<MultiLineString>[] = [];
    for (const [k, lines] of buckets) {
      const [c, w, o] = k.split('|').map(Number);
      features.push({ type: 'Feature', properties: { c, w, o }, geometry: { type: 'MultiLineString', coordinates: lines } });
    }
    src('traffic').setData({ type: 'FeatureCollection', features });
  };

  const applyStates = () => {
    const ui = useUI.getState();
    const phase = useSession.getState().phase;
    const sel = ui.selection;
    let focus: string | null = null;
    if (sel?.kind === 'line') focus = sel.id;
    else if (sel?.kind === 'vehicle') focus = game?.state.vehicles[sel.id]?.route ?? null;
    const hoverLine = ui.hover?.kind === 'line' ? ui.hover.id : null;
    const draftActive = !!ui.draft;
    for (const id of routeIds) {
      const isFocus = focus === id || hoverLine === id;
      const dim = draftActive || (focus !== null && focus !== id && hoverLine !== id);
      map.setFeatureState({ source: 'lines', id: routeFid(id) }, { focus: isFocus && !draftActive, dim });
    }
    // catchments
    const feats: Feature[] = [];
    const stops = game?.state.stops ?? {};
    const stopCircle = (id: string, colour: string, strong: boolean) => {
      const s = stops[id];
      if (s) feats.push({ type: 'Feature', properties: { colour, fo: strong ? 0.12 : 0.05, lo: strong ? 0.9 : 0.45 }, geometry: circle(s.lngLat, STOP_RULES.catchmentM) });
    };
    if (sel?.kind === 'stop') stopCircle(sel.id, '#2f9e6e', true);
    if (sel?.kind === 'line' && game?.state.routes[sel.id]) for (const s of game.state.routes[sel.id].stops) stopCircle(s, game.state.routes[sel.id].colour, false);
    if (ui.hover?.kind === 'stop' && !(sel?.kind === 'stop' && sel.id === ui.hover.id)) stopCircle(ui.hover.id, '#2f9e6e', false);
    for (const id of ui.draft?.stops ?? []) stopCircle(id, ui.draft!.colour, false);
    src('catchment').setData({ type: 'FeatureCollection', features: feats });
    // visibility
    const vis = (on: boolean) => (on ? 'visible' : 'none');
    map.setLayoutProperty('traffic', 'visibility', vis(ui.overlays.traffic && phase === 'playing'));
    map.setLayoutProperty('demand', 'visibility', vis(ui.overlays.demand || phase === 'setup'));
    const zones = phase === 'setup' || (phase === 'playing' && (ui.overlays.areas || ui.tool === 'stop' || ui.tool === 'depot' || sel?.kind === 'zone'));
    for (const id of ['zones-fill', 'zones-line', 'zones-label', 'zones-hatch']) map.setLayoutProperty(id, 'visibility', vis(zones));
    map.setLayoutProperty('zones-hatch', 'visibility', vis(zones && phase === 'playing'));
    const building = phase === 'playing' && (ui.tool === 'route' || ui.tool === 'stop');
    map.setLayoutProperty('osm-stops-dot', 'visibility', vis(building));
    map.setLayoutProperty('osm-stops-name', 'visibility', vis(building));
    // zone highlight
    const chosenNow = phase === 'setup' ? useSession.getState().homeZone : sel?.kind === 'zone' ? sel.id : null;
    if (chosenNow !== zoneChosen) {
      if (zoneChosen) map.setFeatureState({ source: 'zones', id: zoneChosen }, { chosen: false });
      zoneChosen = chosenNow;
      if (zoneChosen) map.setFeatureState({ source: 'zones', id: zoneChosen }, { chosen: true });
    }
  };

  // ───────────────────────── wiring
  let offs: (() => void)[] = [];
  const attach = (g: Game | null) => {
    offs.forEach((f) => f());
    offs = [];
    game = g;
    if (g) {
      offs.push(
        g.on('changed', () => {
          refreshLines();
          refreshOsmStops();
          refreshZones();
          applyStates();
        }),
        g.on('minute', () => refreshTraffic()),
      );
      setRegion(g.region);
    } else setRegion(useSession.getState().phase === 'setup' ? session.region : null);
    refreshLines();
    applyStates();
  };
  session.onGame(attach);
  useSession.subscribe((s, p) => {
    if (s.phase !== p.phase) {
      if (s.phase === 'setup') setRegion(session.region);
      else if (s.phase === 'menu') setRegion(null);
      refreshZones();
      applyStates();
    }
    if (s.homeZone !== p.homeZone) applyStates();
  });
  useUI.subscribe((s, p) => {
    if (s.overlays.traffic && !p.overlays.traffic) refreshTraffic(true);
    if (s.selection !== p.selection || s.hover !== p.hover || s.draft !== p.draft || s.overlays !== p.overlays || s.tool !== p.tool) applyStates();
  });
  attach(session.game);

  return {
    setStopHover(id) {
      if (id === stopHover) return;
      if (stopHover) map.setFeatureState({ source: 'osm-stops', id: stopHover }, { hover: false });
      stopHover = id;
      if (stopHover) map.setFeatureState({ source: 'osm-stops', id: stopHover }, { hover: true });
    },
    setDraft(colour, parts) {
      const features: Feature[] = [];
      const line = (kind: string, c?: LngLat[] | null) => c && c.length > 1 && features.push({ type: 'Feature', properties: { kind, colour }, geometry: { type: 'LineString', coordinates: c } });
      line('out', parts.out);
      line('ret', parts.ret);
      line('preview', parts.preview);
      for (const v of parts.via ?? []) features.push({ type: 'Feature', properties: { kind: 'via', colour }, geometry: { type: 'Point', coordinates: v } });
      src('draft').setData({ type: 'FeatureCollection', features });
    },
    refreshAll() {
      refreshLines();
      refreshZones();
      refreshOsmStops();
      applyStates();
    },
    setZoneHover(id) {
      if (id === zoneHover) return;
      if (zoneHover) map.setFeatureState({ source: 'zones', id: zoneHover }, { hover: false });
      zoneHover = id;
      if (zoneHover) map.setFeatureState({ source: 'zones', id: zoneHover }, { hover: true });
    },
  };
}
