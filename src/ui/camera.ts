import { LngLatBounds } from 'maplibre-gl';
import { mapRuntime } from '../map/runtime.ts';
import { sim } from '../sim/sim.ts';
import { useUI } from '../state/store.ts';

function padding() {
  const ui = useUI.getState();
  const panel = ui.panel ? 420 : 0;
  return { top: 110, bottom: ui.draft ? 130 : 70, left: 90 + panel, right: ui.selection ? 400 : 60 };
}

export function focusVehicle(id: string) {
  const map = mapRuntime.map;
  const v = sim.vehicle(id);
  const pose = v && sim.pose(v);
  if (!map || !pose) return;
  map.easeTo({ center: pose.at, zoom: Math.max(map.getZoom(), 17.5), padding: padding(), duration: 950 });
}

export function focusStop(id: string) {
  const map = mapRuntime.map;
  const s = sim.stops.get(id);
  if (!map || !s) return;
  map.easeTo({ center: s.lngLat, zoom: Math.max(map.getZoom(), 16.8), padding: padding(), duration: 900 });
}

export function focusLine(id: string) {
  const map = mapRuntime.map;
  const l = sim.line(id);
  if (!map || !l) return;
  const b = new LngLatBounds();
  for (const s of l.stops) b.extend(sim.stops.get(s.stopId)!.lngLat);
  const cam = map.cameraForBounds(b, { padding: padding(), bearing: map.getBearing(), maxZoom: 16.6 });
  if (!cam) return;
  const zoom = Math.max(15.1, Math.min(16.6, (cam.zoom ?? 15.5) - 0.15));
  map.easeTo({ center: cam.center, zoom, pitch: Math.max(map.getPitch(), 48), bearing: map.getBearing(), padding: padding(), duration: 1100 });
}
