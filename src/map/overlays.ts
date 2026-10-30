// MapLibre overlay layers driven by the game: lines, catchments, simulated traffic, estimated
// demand, operating areas (licences), the game-area boundary and the line being drafted.

import type { Map as MlMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, MultiLineString, Point, Polygon } from 'geojson';
import { useUI } from '../state/store.ts';
import { session, useSession } from '../app/session.ts';
import type { Game } from '../game/engine.ts';
import type { Pattern } from '../game/network.ts';
import { nearestNode, projector, type LngLat } from '../game/world/graph.ts';
import { latToMercY, lngToMercX } from '../geo/tiles.ts';
import { PAPER } from './palette.ts';
import { stopSpots } from '../game/spots.ts';
import type { Region } from '../game/world/region.ts';
import { STOP_RULES } from '../game/content.ts';
import { licenceInfo, startingZones } from '../game/progress.ts';
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

/** blank paper with a faint dot grid: everything outside the area you can operate in */
function paperImage() {
  const r = 2, s = 14;
  const c = document.createElement('canvas');
  c.width = c.height = s * r;
  const ctx = c.getContext('2d')!;
  ctx.scale(r, r);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#d9d3c5';
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, 1.1, 0, Math.PI * 2);
  ctx.fill();
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** What the player can see: 0 operable, 1 offered (can be licensed next), 2 hidden. */
export interface TerritoryMask {
  /** mercator rectangle the canvas covers: x0, y0 (north-west), x1, y1 (south-east) */
  rect: [number, number, number, number];
  /** red channel: 0 operable, 128 offered, 255 hidden */
  canvas: HTMLCanvasElement;
}

function drawMask(region: Region, level: Map<string, number>): TerritoryMask {
  const b = region.bounds;
  const rect: [number, number, number, number] = [lngToMercX(b.w), latToMercY(b.n), lngToMercX(b.e), latToMercY(b.s)];
  const aspect = (rect[3] - rect[1]) / (rect[2] - rect[0]);
  const W = 1024, H = Math.max(64, Math.round(W * aspect));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  const px = (ll: LngLat): [number, number] => [((lngToMercX(ll[0]) - rect[0]) / (rect[2] - rect[0])) * W, ((latToMercY(ll[1]) - rect[1]) / (rect[3] - rect[1])) * H];
  for (const lv of [1, 0]) {
    const col = lv === 0 ? '#000' : '#808080';
    ctx.fillStyle = ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    for (const z of region.zones) {
      if (level.get(z.id) !== lv) continue;
      ctx.beginPath();
      z.ring.forEach((ll, i) => (i ? ctx.lineTo(...px(ll)) : ctx.moveTo(...px(ll))));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  return { rect, canvas: c };
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
  /** Draw the start-menu showcase's lines while no game is played (null to stop). */
  setShowcase(g: Game | null): void;
  setDraft(colour: string, parts: { out?: LngLat[] | null; ret?: LngLat[] | null; preview?: LngLat[] | null; via?: LngLat[] }): void;
  setStopHover(id: number | null): void;
  refreshAll(): void;
  setZoneHover(id: string | null): void;
  /** Receive the visible territory now and whenever it changes (null: show everything). */
  watchMask(fn: (m: TerritoryMask | null) => void): void;
}

export function installOverlays(map: MlMap): Overlays {
  const before = 'city-3d';
  let sideSign = 1; // +1 drive on the right, −1 on the left
  const lineOffset = () => zw((w) => ['*', sideSign, ['+', w * 0.62, ['*', ['get', 'lane'], w * 1.08]]] as ExpressionSpecification);

  // ── territory: only the area you operate in is shown. Areas you can license next sit under
  // a light veil; everything else, beyond them and outside the mapped region, is blank paper.
  // (moved above the ground overlays once those exist, see below)
  map.addImage('paper', paperImage(), { pixelRatio: 2 });
  map.addSource('region-mask', { type: 'geojson', data: EMPTY });
  map.addSource('veil-offer', { type: 'geojson', data: EMPTY });
  map.addSource('territory-edge', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'region-mask', type: 'fill', source: 'region-mask', paint: { 'fill-pattern': 'paper', 'fill-antialias': false } }, before);
  map.addLayer({ id: 'veil-offer', type: 'fill', source: 'veil-offer', paint: { 'fill-color': PAPER, 'fill-opacity': 0.62, 'fill-antialias': false } }, before);
  map.addLayer({
    id: 'territory-edge', type: 'line', source: 'territory-edge', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['match', ['get', 'kind'], 'own', '#2f9e6e', '#b9b2a2'], 'line-width': ['match', ['get', 'kind'], 'own', 2.6, 1.6], 'line-opacity': 0.9 },
  }, before);

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

  // areas you can license next: name and price, always shown while playing
  map.addLayer({
    id: 'offer-label', type: 'symbol', source: 'zone-labels', filter: ['==', ['get', 'state'], 'available'], layout: {
      visibility: 'none', 'text-field': ['get', 'label'], 'text-font': ['Figtree-SemiBold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 16, 13.5],
      'text-max-width': 10, 'text-allow-overlap': false, 'text-padding': 4,
    },
    paint: { 'text-color': '#7a5418', 'text-halo-color': 'rgba(255,255,255,0.95)', 'text-halo-width': 2 },
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
      // radius is set per region (see setRegion) to ~1.7 grid cells at every zoom
      'heatmap-intensity': 1.0,
      'heatmap-radius': 20,
      'heatmap-opacity': 0.85,
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(70,170,180,0)', 0.12, 'rgba(70,170,180,0.35)', 0.35, 'rgba(150,205,120,0.55)', 0.6, 'rgba(242,198,82,0.65)', 0.82, 'rgba(238,128,84,0.72)', 1, 'rgba(222,86,110,0.8)'],
    },
  }, before);

  // ── catchments
  map.addSource('catchment', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'catchment-fill', type: 'fill', source: 'catchment', paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': ['get', 'fo'] } }, before);
  map.addLayer({ id: 'catchment-line', type: 'line', source: 'catchment', paint: { 'line-color': ['get', 'colour'], 'line-width': 1.6, 'line-opacity': ['get', 'lo'], 'line-dasharray': [3, 2] } }, before);

  // the paper covers the ground overlays (areas, traffic, demand) but not your lines and stops
  for (const id of ['region-mask', 'veil-offer', 'territory-edge']) map.moveLayer(id, before);

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

  // ── stop spots: where stops can be built (real stop locations plus generated ones);
  // spots outside the licensed area are faded
  const hover = ['boolean', ['feature-state', 'hover'], false] as ExpressionSpecification;
  const licensed = ['boolean', ['get', 'licensed'], true] as ExpressionSpecification;
  map.addSource('osm-stops', { type: 'geojson', data: EMPTY, promoteId: 'id' });
  map.addLayer({
    id: 'osm-stops-dot', type: 'circle', source: 'osm-stops', layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, ['case', hover, 6, 4], 16, ['case', hover, 9, 6], 18, ['case', hover, 12, 8]],
      'circle-color': ['case', licensed, 'rgba(255,255,255,0.95)', 'rgba(255,255,255,0.55)'],
      'circle-stroke-color': ['case', hover, '#4fa3e0', licensed, '#3f7fb0', 'rgba(110,125,118,0.6)'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14, ['case', hover, 2.4, 1.6], 17, ['case', hover, 3, 2.2]],
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
  /** the start-menu showcase, drawn while no game is played */
  let showcase: Game | null = null;
  let region: Region | null = null;
  let stopHover: number | null = null;
  let lastTraffic = 0;
  let trafficSlot = -1;
  let routeIds: string[] = [];
  let zoneHover: string | null = null;
  let zoneChosen: string[] = [];
  const src = (id: string) => map.getSource(id) as GeoJSONSource;

  const setRegion = (r: Region | null) => {
    region = r;
    if (!r) {
      for (const s of ['zones', 'zone-labels', 'demand', 'traffic', 'osm-stops']) src(s).setData(EMPTY);
      refreshTerritory();
      return;
    }
    const country = r.spec.country;
    const sign = drivesOnLeft(country) ? -1 : 1;
    if (sign !== sideSign) {
      sideSign = sign;
      for (const id of ['lines-halo', 'lines', 'lines-hit']) map.setPaintProperty(id, 'line-offset', lineOffset());
      for (const lane of [0, 1, 2]) map.setLayoutProperty(`lines-chevrons-${lane}`, 'icon-offset', chevronOffsets(lane));
    }
    // demand: residents + jobs per grid cell (estimates), lightly smoothed so it reads as a
    // field rather than a lattice, and scaled to this area's busy cells (95th percentile)
    // rather than to its single busiest one
    const d = r.demand;
    const proj = projector(r.spec.centre);
    // cells no bus can reach (e.g. across water from the road network) are left out
    const raw = new Float32Array(d.w * d.h);
    for (let j = 0; j < d.h; j++)
      for (let i = 0; i < d.w; i++) {
        const k = j * d.w + i;
        const v = d.residents[k] + d.jobs[k] * 0.8;
        if (v > 0 && nearestNode(r.graph, r.index, d.x0 + (i + 0.5) * d.cell, d.y0 + (j + 0.5) * d.cell, 250) >= 0) raw[k] = v;
      }
    const field = new Float32Array(raw.length);
    for (let j = 0; j < d.h; j++)
      for (let i = 0; i < d.w; i++) {
        let sum = 0, wsum = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= d.w || jj >= d.h) continue;
            const wt = (di ? 1 : 2) * (dj ? 1 : 2);
            sum += raw[jj * d.w + ii] * wt;
            wsum += wt;
          }
        field[j * d.w + i] = sum / wsum;
      }
    // kernel ~1.7 cells wide at every zoom so neighbouring cells merge into one field
    // (MapLibre zoom uses 512 px tiles: metres per pixel = 78271.5 * cos(lat) / 2^zoom)
    const cellPx0 = (1.7 * d.cell) / (78271.5 * Math.cos((r.spec.centre[1] * Math.PI) / 180));
    map.setPaintProperty('demand', 'heatmap-radius', ['interpolate', ['exponential', 2], ['zoom'], 0, cellPx0, 22, cellPx0 * 2 ** 22]);
    const busy = Array.from(field).filter((v) => v > 0).sort((a, b) => a - b);
    const ref = Math.max(1, busy[Math.floor(busy.length * 0.95)] ?? 1);
    const feats: Feature<Point>[] = [];
    for (let j = 0; j < d.h; j++)
      for (let i = 0; i < d.w; i++) {
        const v = field[j * d.w + i];
        if (v < ref * 0.12) continue;
        const ll = proj.toLngLat(d.x0 + (i + 0.5) * d.cell, d.y0 + (j + 0.5) * d.cell);
        feats.push({ type: 'Feature', properties: { w: Math.min(1, v / ref) }, geometry: { type: 'Point', coordinates: ll } });
      }
    src('demand').setData({ type: 'FeatureCollection', features: feats });
    refreshZones();
    refreshOsmStops();
    trafficSlot = -1;
  };

  /** 0 operable, 1 can be licensed next, 2 hidden; while choosing a home area, all of it is shown */
  const zoneLevels = (r: Region): Map<string, number> => {
    const level = new Map<string, number>();
    const owned = new Set(game?.state.territory.owned ?? []);
    const playing = useSession.getState().phase === 'playing' && !!game;
    for (const z of r.zones) level.set(z.id, !playing || owned.has(z.id) ? 0 : z.neighbours.some((n) => owned.has(n)) ? 1 : 2);
    return level;
  };

  // basemap labels (streets, places, water, one-way arrows) only inside what is shown
  const LABEL_LAYERS = ['street-labels', 'water-labels', 'place-labels', 'city-labels', 'oneway-arrows'].filter((id) => map.getLayer(id));
  const baseFilter = new Map(LABEL_LAYERS.map((id) => [id, map.getFilter(id)]));
  let labelArea = '';
  const setLabelArea = (area: Polygon['coordinates'][] | null) => {
    const key = area ? JSON.stringify(area) : '';
    if (key === labelArea) return;
    labelArea = key;
    for (const id of LABEL_LAYERS) {
      const f = baseFilter.get(id);
      const within = area ? (['within', { type: 'MultiPolygon', coordinates: area }] as unknown as ExpressionSpecification) : null;
      map.setFilter(id, within ? (f ? (['all', f, within] as ExpressionSpecification) : within) : (f ?? null));
    }
  };

  let maskKey = '';
  let lastMask: TerritoryMask | null = null;
  let maskSink: ((m: TerritoryMask | null) => void) | null = null;
  const emitMask = (m: TerritoryMask | null) => {
    lastMask = m;
    maskSink?.(m);
  };
  const refreshTerritory = () => {
    const phase = useSession.getState().phase;
    if (!region || (phase !== 'playing' && phase !== 'setup')) {
      for (const s of ['region-mask', 'veil-offer', 'territory-edge']) src(s).setData(EMPTY);
      setLabelArea(null);
      if (maskKey) emitMask(null);
      maskKey = '';
      return;
    }
    const r = region;
    const level = zoneLevels(r);
    const key = `${r.spec.id}|${[...level.values()].join('')}`;
    if (key === maskKey) return;
    maskKey = key;
    const b = r.bounds;
    const world: LngLat[] = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
    const box: LngLat[] = [[b.w, b.s], [b.w, b.n], [b.e, b.n], [b.e, b.s], [b.w, b.s]];
    const poly = (rings: LngLat[][]): Feature<Polygon> => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } });
    const hidden = [poly([world, box])];
    const offered: Feature<Polygon>[] = [];
    const shown: Polygon['coordinates'][] = [];
    for (const z of r.zones) {
      const ring = [...z.ring, z.ring[0]];
      const lv = level.get(z.id);
      if (lv === 2) hidden.push(poly([ring]));
      else {
        shown.push([ring]);
        if (lv === 1) offered.push(poly([ring]));
      }
    }
    src('region-mask').setData({ type: 'FeatureCollection', features: hidden });
    src('veil-offer').setData({ type: 'FeatureCollection', features: offered });
    // outline where the operable area meets the rest: test a point just across each edge
    const P = projector(r.spec.centre);
    const seeds = r.zones.map((z) => ({ id: z.id, xy: P.toXY(z.seed[0], z.seed[1]) }));
    const zoneAtXY = (x: number, y: number) => {
      let best = '', bd = Infinity;
      for (const s of seeds) {
        const d = (s.xy[0] - x) ** 2 + (s.xy[1] - y) ** 2;
        if (d < bd) {
          bd = d;
          best = s.id;
        }
      }
      return best;
    };
    const edges: Feature<LineString>[] = [];
    for (const z of r.zones) {
      const lv = level.get(z.id)!;
      if (lv === 2) continue;
      for (let i = 0; i < z.ring.length; i++) {
        const a = z.ring[i], c = z.ring[(i + 1) % z.ring.length];
        const [ax, ay] = P.toXY(a[0], a[1]), [cx, cy] = P.toXY(c[0], c[1]);
        const len = Math.hypot(cx - ax, cy - ay);
        if (len < 1) continue;
        const mx = (ax + cx) / 2, my = (ay + cy) / 2, nx = -(cy - ay) / len, ny = (cx - ax) / len;
        const p1 = zoneAtXY(mx + nx * 6, my + ny * 6), p2 = zoneAtXY(mx - nx * 6, my - ny * 6);
        const [qx, qy] = p1 === z.id ? [mx - nx * 6, my - ny * 6] : [mx + nx * 6, my + ny * 6];
        const out = p1 === z.id ? p2 : p1;
        const ll = P.toLngLat(qx, qy);
        const inside = ll[0] > b.w && ll[0] < b.e && ll[1] > b.s && ll[1] < b.n;
        const outLv = inside ? level.get(out) ?? 2 : 2;
        // the operable area's own border (green), and the outer edge of the offered areas (faint)
        const kind = lv === 0 && outLv > 0 ? 'own' : lv === 1 && outLv === 2 ? 'offer' : '';
        if (kind) edges.push({ type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: [a, c] } });
      }
    }
    src('territory-edge').setData({ type: 'FeatureCollection', features: edges });
    setLabelArea(shown);
    emitMask(drawMask(r, level));
  };

  const refreshZones = () => {
    refreshTerritory();
    if (!region) return;
    const owned = new Set(game?.state.territory.owned ?? []);
    const setup = useSession.getState().phase === 'setup';
    const level = zoneLevels(region);
    const feats: Feature<Polygon>[] = [];
    const labels: Feature<Point>[] = [];
    for (const z of region.zones) {
      if (level.get(z.id) === 2) continue; // hidden
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

  /** Stop spots (the only places stops can be built), minus those taken by a built stop. */
  const refreshOsmStops = () => {
    if (!region) return;
    const stops = Object.values(game?.state.stops ?? {});
    const owned = new Set(game?.state.territory.owned ?? []);
    const feats: Feature<Point>[] = [];
    stopSpots(region).forEach((o, i) => {
      for (const s of stops) {
        const dx = (s.lngLat[0] - o.lngLat[0]) * 111320 * Math.cos((o.lngLat[1] * Math.PI) / 180);
        const dy = (s.lngLat[1] - o.lngLat[1]) * 110540;
        if (dx * dx + dy * dy < STOP_RULES.minSpacingM ** 2) return;
      }
      const z = game?.geo.zoneAt(o.lngLat);
      const licensed = !z || owned.has(z.id);
      if (z && !licensed && !z.neighbours.some((n) => owned.has(n))) return; // hidden area
      feats.push({ type: 'Feature', id: i + 1, properties: { id: i + 1, name: o.name, licensed }, geometry: { type: 'Point', coordinates: o.lngLat } });
    });
    src('osm-stops').setData({ type: 'FeatureCollection', features: feats });
  };

  const linesGame = () => game ?? showcase;
  /** Lines split into runs with a lane index so lines sharing a street sit side by side. */
  const refreshLines = () => {
    const game = linesGame();
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
    map.setLayoutProperty('offer-label', 'visibility', vis(phase === 'playing' && !zones));
    map.setLayoutProperty('zones-hatch', 'visibility', vis(zones && phase === 'playing'));
    const building = phase === 'playing' && (ui.tool === 'route' || ui.tool === 'stop');
    map.setLayoutProperty('osm-stops-dot', 'visibility', vis(building));
    map.setLayoutProperty('osm-stops-name', 'visibility', vis(building));
    // zone highlight
    const home = phase === 'setup' ? useSession.getState().homeZone : null;
    const chosenNow = home && region ? startingZones(region.zones, home) : sel?.kind === 'zone' ? [sel.id] : [];
    if (chosenNow.join() !== zoneChosen.join()) {
      for (const id of zoneChosen) map.setFeatureState({ source: 'zones', id }, { chosen: false });
      zoneChosen = chosenNow;
      for (const id of zoneChosen) map.setFeatureState({ source: 'zones', id }, { chosen: true });
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
  const api: Overlays = {
    watchMask(fn) {
      maskSink = fn;
      fn(lastMask);
    },
    setStopHover(id) {
      if (id === stopHover) return;
      if (stopHover) map.setFeatureState({ source: 'osm-stops', id: stopHover }, { hover: false });
      stopHover = id;
      if (stopHover) map.setFeatureState({ source: 'osm-stops', id: stopHover }, { hover: true });
    },
    setShowcase(g) {
      showcase = g;
      refreshLines();
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
  attach(session.game);
  return api;
}
