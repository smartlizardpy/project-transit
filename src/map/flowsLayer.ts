// Network Control: origin–destination flows on the map (a few aggregated arcs, never thousands).
// Driven by `useUI().flowOverlay`, which the analytics UI sets and clears.
// Observed journeys are solid accent arcs; model estimates are dashed teal arcs. Width follows volume.
import { Marker, type Map as MlMap, type GeoJSONSource, type ExpressionSpecification, type MapMouseEvent } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { useUI, type FlowOverlay } from '../state/store.ts';
import type { LngLat } from '../game/world/graph.ts';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const ACCENT = '#4fa3e0';
const TEAL = '#7fd3c4';

/** A shallow quadratic arc between two points; the bend is on the right of the direction of travel. */
function arc(a: LngLat, b: LngLat, steps = 28): LngLat[] {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dx = (b[0] - a[0]) * k, dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1e-9;
  const bend = 0.16 * len;
  const mx = (a[0] + b[0]) / 2 + (dy / len) * bend / k;
  const my = (a[1] + b[1]) / 2 - (dx / len) * bend;
  const out: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * mx + t * t * b[0], u * u * a[1] + 2 * u * t * my + t * t * b[1]]);
  }
  return out;
}

const zoomW = (mul: number, add = 0): ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], 11, ['+', ['*', ['get', 'w'], 0.55 * mul], add], 16, ['+', ['*', ['get', 'w'], 1.35 * mul], add]];

export function installFlowsLayer(map: MlMap) {
  map.addSource('flows', { type: 'geojson', data: EMPTY });
  map.addSource('flows-pts', { type: 'geojson', data: EMPTY });
  const dim: ExpressionSpecification = ['case', ['==', ['get', 'dim'], 1], 0.28, 0.95];
  map.addLayer({ id: 'flows-halo', type: 'line', source: 'flows', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': zoomW(1, 3), 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.35, 0.9] } });
  map.addLayer({ id: 'flows-obs', type: 'line', source: 'flows', filter: ['==', ['get', 'kind'], 'observed'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ACCENT, 'line-width': zoomW(1), 'line-opacity': dim } });
  map.addLayer({ id: 'flows-est', type: 'line', source: 'flows', filter: ['==', ['get', 'kind'], 'estimated'], layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': TEAL, 'line-width': zoomW(0.8), 'line-opacity': dim, 'line-dasharray': [2, 1.6] } });
  map.addLayer({ id: 'flows-hit', type: 'line', source: 'flows', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 } });
  map.addLayer({ id: 'flows-end', type: 'circle', source: 'flows-pts', filter: ['==', ['get', 'role'], 'end'], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.6, 16, 5], 'circle-color': ['case', ['==', ['get', 'kind'], 'estimated'], TEAL, ACCENT], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.6, 'circle-opacity': dim, 'circle-stroke-opacity': dim } });
  map.addLayer({ id: 'flows-origin', type: 'circle', source: 'flows-pts', filter: ['==', ['get', 'role'], 'origin'], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 7, 16, 12], 'circle-color': 'rgba(255,255,255,0.35)', 'circle-stroke-color': ACCENT, 'circle-stroke-width': 2.4 } });

  let label: Marker | null = null;
  const drop = () => { label?.remove(); label = null; };

  const render = (o: FlowOverlay | null) => {
    drop();
    const flows = o?.flows ?? [];
    const max = Math.max(1, ...flows.map((f) => f.value));
    const sel = o?.selected ?? null;
    const lines: Feature[] = [], pts: Feature[] = [];
    // weakest first so the busiest flows sit on top
    for (const f of [...flows].sort((a, b) => a.value - b.value)) {
      const coords = arc(f.from, f.to);
      lines.push({ type: 'Feature', properties: { id: f.id, kind: f.kind, w: 1.6 + 5.4 * Math.sqrt(f.value / max) + (f.id === sel ? 1.6 : 0), dim: sel && f.id !== sel ? 1 : 0 }, geometry: { type: 'LineString', coordinates: coords } });
      pts.push({ type: 'Feature', properties: { role: 'end', kind: f.kind, dim: sel && f.id !== sel ? 1 : 0 }, geometry: { type: 'Point', coordinates: f.to } });
    }
    if (o?.origin) pts.push({ type: 'Feature', properties: { role: 'origin' }, geometry: { type: 'Point', coordinates: o.origin.at } });
    (map.getSource('flows') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lines });
    (map.getSource('flows-pts') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pts });
    const chosen = flows.find((f) => f.id === sel);
    if (chosen) {
      const mid = arc(chosen.from, chosen.to)[14];
      const el = document.createElement('div');
      el.className = `nc-flow-label ${chosen.kind}`;
      el.textContent = chosen.label;
      label = new Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat(mid).addTo(map);
    }
  };
  useUI.subscribe((s, p) => { if (s.flowOverlay !== p.flowOverlay) render(s.flowOverlay); });
  render(useUI.getState().flowOverlay);

  map.on('mouseenter', 'flows-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'flows-hit', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', 'flows-hit', (e: MapMouseEvent & { features?: { properties?: Record<string, unknown> }[] }) => {
    const id = e.features?.[0]?.properties?.id as string | undefined;
    const ui = useUI.getState();
    if (!id || !ui.flowOverlay) return;
    const before = ui.selection;
    ui.setFlowOverlay({ ...ui.flowOverlay, selected: ui.flowOverlay.selected === id ? null : id });
    // the general map click handler also runs for this click and would clear the inspector; keep it as it was
    setTimeout(() => { const now = useUI.getState().selection; if (now !== before && (now === null || now.kind === 'zone')) useUI.getState().select(before); }, 0);
  });
}
