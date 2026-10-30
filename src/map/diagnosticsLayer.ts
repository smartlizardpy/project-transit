// Route diagnostics on the map: the problem leg, a straight-line reference, blocking one-way
// streets and previews of alternatives. Driven by `useUI().routeCheck` (which leg is open) and the
// small `useCheckOverlay` store below (what to draw), which src/ui/RouteCheck.tsx fills.
import { Marker, type Map as MlMap, type GeoJSONSource, type ExpressionSpecification } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { create } from 'zustand';
import { useUI } from '../state/store.ts';
import { session } from '../app/session.ts';
import { drivesOnLeft } from '../game/world/locale.ts';
import type { LngLat } from '../game/world/graph.ts';

export interface CheckOverlay {
  /** line colour */
  colour: string;
  /** current road path of the leg */
  leg: LngLat[] | null;
  /** straight line between the stops: a visual reference only, never a drivable suggestion */
  direct: [LngLat, LngLat] | null;
  /** one-way streets blocking the short way, each in its permitted direction */
  blocking: LngLat[][];
  /** road ends near the direct line (possible data gaps) */
  gaps: LngLat[];
  /** labelled stops of the leg */
  stops: { at: LngLat; label: string; role: 'from' | 'to' | 'other' }[];
  /** alternative or previewed path (dashed accent) */
  preview: LngLat[] | null;
  /** where a previewed fix puts a stop */
  ghosts: { at: LngLat; label: string }[];
  /** draggable handles: stops being moved and waypoints */
  handles: { id: string; at: LngLat; kind: 'stop' | 'via'; label: string; ok: boolean }[];
}

interface OverlayStore {
  overlay: CheckOverlay | null;
  /** called while a handle is dragged (final = drag ended) */
  onDrag: ((id: string, at: LngLat, final: boolean) => void) | null;
  set: (o: CheckOverlay | null) => void;
}

export const useCheckOverlay = create<OverlayStore>((set) => ({ overlay: null, onDrag: null, set: (overlay) => set({ overlay }) }));

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const ACCENT = '#4fa3e0';
const BLOCK = '#e2a94a';
const LW: [number, number][] = [[12, 2], [15, 3.6], [17, 6], [19, 11]];
function zw(f: (w: number) => number | ExpressionSpecification): ExpressionSpecification {
  const out: unknown[] = ['interpolate', ['exponential', 1.6], ['zoom']];
  for (const [z, w] of LW) out.push(z, f(w));
  return out as ExpressionSpecification;
}
const line = (coords: LngLat[], props: Record<string, unknown> = {}) => ({ type: 'Feature' as const, properties: props, geometry: { type: 'LineString' as const, coordinates: coords } });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function installDiagnosticsLayer(map: MlMap) {
  const before = map.getLayer('oneway-arrows') ? 'oneway-arrows' : undefined;
  let side = 1;
  const offset = () => zw((w) => side * w * 0.62);
  for (const id of ['dg-direct', 'dg-block', 'dg-leg', 'dg-preview', 'dg-gaps']) map.addSource(id, { type: 'geojson', data: EMPTY });
  // straight-line reference: thin, subtle, dashed
  map.addLayer({ id: 'dg-direct', type: 'line', source: 'dg-direct', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#3d4650', 'line-opacity': 0.5, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.1, 17, 1.8], 'line-dasharray': [2.2, 2.2] } }, before);
  // blocking one-way streets: restrained amber with chevrons in the permitted direction
  map.addLayer({ id: 'dg-block', type: 'line', source: 'dg-block', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': BLOCK, 'line-opacity': 0.5, 'line-width': zw((w) => w * 1.5) } }, before);
  map.addLayer({
    id: 'dg-block-chev', type: 'symbol', source: 'dg-block', minzoom: 14.6,
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 46, 'icon-image': 'chev', 'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 17, 0.75, 19, 1.2], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    paint: { 'icon-opacity': 0.95 },
  }, before);
  // current leg: line colour with the white halo of the network lines
  map.addLayer({ id: 'dg-leg-halo', type: 'line', source: 'dg-leg', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': zw((w) => w * 1.25 + 5), 'line-offset': offset(), 'line-opacity': 0.95, 'line-blur': 1 } }, before);
  map.addLayer({ id: 'dg-leg', type: 'line', source: 'dg-leg', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': zw((w) => w * 1.25), 'line-offset': offset() } }, before);
  map.addLayer({
    id: 'dg-leg-chev', type: 'symbol', source: 'dg-leg', minzoom: 14.8,
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 80, 'icon-image': 'chev', 'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 17, 0.8, 19, 1.3], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
  }, before);
  // previewed alternative: dashed accent blue, like the line editor's preview
  map.addLayer({ id: 'dg-preview-halo', type: 'line', source: 'dg-preview', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': zw((w) => w + 3), 'line-opacity': 0.75, 'line-offset': offset() } }, before);
  map.addLayer({ id: 'dg-preview', type: 'line', source: 'dg-preview', layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': ACCENT, 'line-width': zw((w) => w * 0.95), 'line-dasharray': [1.2, 0.9], 'line-offset': offset() } }, before);
  map.addLayer({ id: 'dg-gaps', type: 'circle', source: 'dg-gaps', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 4, 18, 8], 'circle-color': 'rgba(255,255,255,0.85)', 'circle-stroke-color': BLOCK, 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' } }, before);

  const src = (id: string) => map.getSource(id) as GeoJSONSource | undefined;
  let labels: Marker[] = [];
  const handles = new Map<string, { m: Marker; el: HTMLDivElement }>();
  const dragging = new Set<string>();

  const draw = (o: CheckOverlay | null) => {
    const country = session.game?.region.spec.country ?? '';
    side = drivesOnLeft(country) ? -1 : 1;
    for (const id of ['dg-leg-halo', 'dg-leg', 'dg-preview-halo', 'dg-preview']) if (map.getLayer(id)) map.setPaintProperty(id, 'line-offset', offset());
    src('dg-direct')?.setData(o?.direct ? { type: 'FeatureCollection', features: [line(o.direct)] } : EMPTY);
    src('dg-block')?.setData(o ? { type: 'FeatureCollection', features: o.blocking.filter((c) => c.length > 1).map((c) => line(c)) } : EMPTY);
    src('dg-leg')?.setData(o?.leg && o.leg.length > 1 ? { type: 'FeatureCollection', features: [line(o.leg, { colour: o.colour })] } : EMPTY);
    src('dg-preview')?.setData(o?.preview && o.preview.length > 1 ? { type: 'FeatureCollection', features: [line(o.preview)] } : EMPTY);
    src('dg-gaps')?.setData(o ? { type: 'FeatureCollection', features: o.gaps.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } })) } : EMPTY);
    // labels: A / B on the leg's stops, and ghosts where a fix would put a stop
    for (const m of labels) m.remove();
    labels = [];
    if (o) {
      for (const s of o.stops) {
        const el = document.createElement('div');
        el.className = `dg-stop-label ${s.role}`;
        el.style.setProperty('--c', o.colour);
        el.innerHTML = `<span>${esc(s.label)}</span>`;
        labels.push(new Marker({ element: el, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport', offset: [0, -56] }).setLngLat(s.at).addTo(map));
      }
      for (const gh of o.ghosts) {
        const el = document.createElement('div');
        el.className = 'dg-ghost';
        el.innerHTML = `<div class="foot"></div><div class="stem"></div><div class="pin"></div>${gh.label ? `<div class="tag">${esc(gh.label)}</div>` : ''}`;
        labels.push(new Marker({ element: el, anchor: 'bottom', pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat(gh.at).addTo(map));
      }
    }
    // draggable handles: keep the same marker while dragging so the gesture is not interrupted
    const want = new Set(o?.handles.map((h) => h.id) ?? []);
    for (const [id, h] of handles) if (!want.has(id)) {
      h.m.remove();
      handles.delete(id);
    }
    for (const h of o?.handles ?? []) {
      let entry = handles.get(h.id);
      if (!entry) {
        const el = document.createElement('div');
        // a click on a handle must not reach the map (it would select or add a stop)
        el.addEventListener('click', (e) => e.stopPropagation());
        const m = new Marker({ element: el, anchor: 'center', draggable: true, pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat(h.at).addTo(map);
        let frame = 0;
        m.on('dragstart', () => dragging.add(h.id));
        m.on('drag', () => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            const p = m.getLngLat();
            useCheckOverlay.getState().onDrag?.(h.id, [p.lng, p.lat], false);
          });
        });
        m.on('dragend', () => {
          cancelAnimationFrame(frame);
          dragging.delete(h.id);
          const p = m.getLngLat();
          useCheckOverlay.getState().onDrag?.(h.id, [p.lng, p.lat], true);
        });
        entry = { m, el };
        handles.set(h.id, entry);
      }
      entry.el.className = `dg-handle ${h.kind} ${h.ok ? '' : 'bad'} ${dragging.has(h.id) ? 'dragging' : ''}`;
      const html = `<i></i>${h.label ? `<span>${esc(h.label)}</span>` : ''}`;
      if (entry.el.innerHTML !== html) entry.el.innerHTML = html;
      // while the player drags, the marker follows the pointer; afterwards it snaps to the road
      if (!dragging.has(h.id)) entry.m.setLngLat(h.at);
    }
  };
  useCheckOverlay.subscribe((s, p) => {
    if (s.overlay !== p.overlay) draw(s.overlay);
  });

  // the route check closes when its line is deselected or the draft it checks is closed
  useUI.subscribe((s, p) => {
    const rc = s.routeCheck;
    if (!rc) {
      if (p.routeCheck) useCheckOverlay.getState().set(null);
      return;
    }
    if (rc.route !== null && s.selection !== p.selection && !(s.selection?.kind === 'line' && s.selection.id === rc.route)) s.openRouteCheck(null);
    else if (rc.route === null && !s.draft) s.openRouteCheck(null);
    else if (rc.route !== null && s.tool === 'route' && p.tool !== 'route') s.openRouteCheck(null);
  });
}
