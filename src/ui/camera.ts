import { LngLatBounds } from 'maplibre-gl';
import { mapRuntime } from '../map/runtime.ts';
import { session } from '../app/session.ts';
import { useUI } from '../state/store.ts';
import type { LngLat } from '../game/world/graph.ts';

function padding() {
  const ui = useUI.getState();
  const panel = ui.panel ? 420 : 0;
  return { top: 110, bottom: ui.draft ? 150 : 70, left: 90 + panel, right: ui.selection ? 400 : 60 };
}

/** World position of a vehicle (null when it is inside a depot). */
export function vehicleLngLat(id: string): LngLat | null {
  const g = session.game;
  const v = g?.state.vehicles[id];
  if (!g || !v) return null;
  const pose = g.pose(v);
  if (pose) return g.geo.P.toLngLat(pose.x, pose.y);
  const d = g.state.depots[v.depot];
  return d ? d.lngLat : null;
}

export function focusPoint(at: LngLat, zoom = 16.8) {
  const map = mapRuntime.map;
  if (!map) return;
  map.easeTo({ center: at, zoom: Math.max(map.getZoom(), zoom), padding: padding(), duration: 900 });
}

export function focusVehicle(id: string) {
  const at = vehicleLngLat(id);
  if (at) focusPoint(at, 17.5);
}

export function focusStop(id: string) {
  const s = session.game?.state.stops[id];
  if (s) focusPoint(s.lngLat, 16.8);
}

export function focusDepot(id: string) {
  const d = session.game?.state.depots[id];
  if (d) focusPoint(d.lngLat, 16.6);
}

export function fitPoints(points: LngLat[], maxZoom = 16.6) {
  const map = mapRuntime.map;
  if (!map || !points.length) return;
  const b = new LngLatBounds();
  for (const p of points) b.extend(p);
  const cam = map.cameraForBounds(b, { padding: padding(), bearing: map.getBearing(), maxZoom });
  if (!cam) return;
  const zoom = Math.max(13.2, Math.min(maxZoom, (cam.zoom ?? 15.5) - 0.15));
  map.easeTo({ center: cam.center, zoom, pitch: Math.max(map.getPitch(), 45), bearing: map.getBearing(), padding: padding(), duration: 1100 });
}

export function focusLine(id: string) {
  const g = session.game;
  const r = g?.state.routes[id];
  if (!g || !r) return;
  const pts: LngLat[] = [];
  for (const p of g.patterns.get(id) ?? []) for (let i = 0; i < p.path.nodes.length; i += 4) pts.push([g.region.graph.lng[p.path.nodes[i]], g.region.graph.lat[p.path.nodes[i]]]);
  if (!pts.length) for (const s of r.stops) if (g.state.stops[s]) pts.push(g.state.stops[s].lngLat);
  fitPoints(pts);
}

export function focusZone(id: string) {
  const z = session.game?.geo.zone(id) ?? session.region?.zones.find((x) => x.id === id);
  if (z) fitPoints(z.ring as LngLat[], 16);
}

/** Camera overview of the whole game region. */
export function flyToRegion(duration = 1800) {
  const region = session.region;
  const map = mapRuntime.map;
  if (!region || !map) return;
  const b = region.bounds;
  const cam = map.cameraForBounds(new LngLatBounds([b.w, b.s], [b.e, b.n]), { padding: 60 });
  map.flyTo({ center: cam?.center ?? region.spec.centre, zoom: Math.min(15.4, (cam?.zoom ?? 14) + 1.2), pitch: 50, bearing: map.getBearing(), duration, essential: true });
}
