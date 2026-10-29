// Glue between the map, the 3D layer, the simulation and the UI store:
// game loop, picking, hover states, follow camera and the build tools.
import type { Map as MlMap, MapMouseEvent, MapGeoJSONFeature } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import type { CityLayer } from './cityLayer.ts';
import { installOverlays } from './overlays.ts';
import { VehicleLayer } from './vehicles3d.ts';
import { MarkerLayer } from './markers.ts';
import { sim } from '../sim/sim.ts';
import { useUI, type Selection } from '../state/store.ts';
import { snap, legPath, inPlayArea } from '../sim/routeEditor.ts';
import { OSM_STOPS, servedStopFor, type OsmStop } from '../sim/osmStops.ts';
import { newDraft } from '../ui/RouteTray.tsx';

export interface Controller {
  vehicles: VehicleLayer;
  markers: MarkerLayer;
}

const same = (a: Selection, b: Selection) => a?.kind === b?.kind && a?.id === b?.id;

export function installController(map: MlMap, city: CityLayer): Controller {
  const overlays = installOverlays(map);
  const container = map.getContainer();
  const vehicles = new VehicleLayer(city, container);
  const markers = new MarkerLayer(map, (id) => onStopClick(id));

  // ───────────────────────── demand heat from building footprints (worker output)
  let demandTimer = 0;
  city.onDemand = (arrays) => {
    clearTimeout(demandTimer);
    demandTimer = window.setTimeout(() => {
      const fc: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };
      for (const a of arrays)
        for (let i = 0; i < a.length; i += 3)
          fc.features.push({ type: 'Feature', properties: { w: a[i + 2] }, geometry: { type: 'Point', coordinates: [a[i], a[i + 1]] } });
      overlays.setDemand(fc);
    }, 400);
  };

  // ───────────────────────── game loop
  let last = performance.now();
  let raf = 0;
  let waitingTick = 0;
  const loop = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    sim.tick(dt);
    const ui = useUI.getState();
    if (ui.following) {
      const v = sim.vehicle(ui.following);
      const pose = v && sim.pose(v);
      if (pose && !map.isMoving()) {
        const c = map.getCenter();
        const k = Math.min(1, dt * 3.2);
        map.jumpTo({ center: [c.lng + (pose.at[0] - c.lng) * k, c.lat + (pose.at[1] - c.lat) * k] });
      }
    }
    if ((waitingTick += dt) > 1) {
      waitingTick = 0;
      markers.refreshWaiting();
    }
    map.triggerRepaint();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  map.on('remove', () => cancelAnimationFrame(raf));
  map.on('dragstart', () => useUI.getState().following && useUI.getState().follow(null));

  // ───────────────────────── store → map
  const syncTool = () => {
    const { tool, overlays: o } = useUI.getState();
    container.classList.toggle('tool-route', tool === 'route');
    city.setNetworkView(o.network ? 1 : o.traffic || o.demand ? 0.62 : 0);
  };
  syncTool();
  useUI.subscribe((s, p) => {
    if (s.tool !== p.tool || s.overlays !== p.overlays) syncTool();
    if (s.tool === 'route' && !s.draft) useUI.getState().setDraft(newDraft());
    if (s.tool !== 'route' && s.draft) useUI.getState().setDraft(null);
    if (s.draft !== p.draft) drawDraft();
  });

  // ───────────────────────── route drafting
  const legCache = new Map<string, [number, number][] | null>();
  const leg = (a: number, b: number) => {
    const k = `${a}>${b}`;
    if (!legCache.has(k)) legCache.set(k, legPath(a, b));
    return legCache.get(k)!;
  };
  let previewTo: number | null = null;
  const drawDraft = () => {
    const d = useUI.getState().draft;
    if (!d) return overlays.setDraft('#4fa3e0', {});
    const path: [number, number][][] = [];
    for (let i = 1; i < d.stops.length; i++) {
      const p = leg(d.stops[i - 1].node, d.stops[i].node);
      if (p) path.push(p);
    }
    const n = d.stops.length;
    const ret = n >= 2 ? leg(d.stops[n - 1].node, d.stops[0].node) : null;
    const preview = n >= 1 && previewTo !== null && previewTo !== d.stops[n - 1].node ? leg(d.stops[n - 1].node, previewTo) : null;
    overlays.setDraft(d.colour, { path, ret, preview });
  };

  // ───────────────────────── real bus stops (OSM) the player builds lines from
  type StopPick = { name: string; node: number; lngLat: [number, number]; stopId: string };
  let freeStops: OsmStop[] = [];
  const servedNode = new Map<string, number>(); // game stop id → road node of its OSM stop
  const refreshStops = () => {
    freeStops = [];
    servedNode.clear();
    for (const o of OSM_STOPS) {
      const served = servedStopFor(o);
      if (served) servedNode.set(served, o.node);
      else freeStops.push(o);
    }
  };
  refreshStops();
  sim.onNetwork(refreshStops);
  const nodeOfStop = (id: string, lngLat: [number, number]) => servedNode.get(id) ?? snap(lngLat, 90)?.node ?? null;

  /** Nearest bus stop to a screen point (existing line stops and free OSM stops). */
  const pickStop = (pt: { x: number; y: number }, radius = 18): StopPick | null => {
    let best: StopPick | null = null;
    let bestD = radius;
    const consider = (id: string, name: string, lngLat: [number, number], node: number | null) => {
      if (node === null) return;
      const p = map.project(lngLat);
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestD) { bestD = d; best = { name, node, lngLat, stopId: id }; }
    };
    for (const o of freeStops) consider(o.id, o.name, o.lngLat, o.node);
    for (const s of sim.stops.values()) consider(s.id, s.name, s.lngLat, nodeOfStop(s.id, s.lngLat));
    return best;
  };

  const addDraftStop = (p: StopPick) => {
    const d = useUI.getState().draft;
    if (!d) return;
    if (d.stops.length && d.stops[d.stops.length - 1].node === p.node) return;
    if (d.stops.length >= 1 && !leg(d.stops[d.stops.length - 1].node, p.node)) {
      useUI.getState().notify('No drivable connection to that stop from the last one.', 'warn');
      return;
    }
    useUI.getState().setDraft({ ...d, stops: [...d.stops, p], history: [...d.history, d.stops], future: [] });
  };

  const onStopClick = (id: string) => {
    const ui = useUI.getState();
    const s = sim.stops.get(id);
    if (!s) return;
    if (ui.tool === 'route') {
      const node = nodeOfStop(id, s.lngLat);
      if (node !== null) addDraftStop({ name: s.name, node, lngLat: s.lngLat, stopId: id });
      return;
    }
    if (ui.tool === 'select') ui.select({ kind: 'stop', id });
  };

  // ───────────────────────── pointer
  let hoverFrame = 0;
  map.on('mousemove', (e: MapMouseEvent) => {
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      const ui = useUI.getState();
      if (ui.tool === 'route') {
        const p = pickStop(e.point);
        overlays.setStopHover(p?.stopId ?? null);
        container.classList.toggle('hovering', !!p);
        const to = p && ui.draft?.stops.length ? p.node : null;
        if (to !== previewTo) {
          previewTo = to;
          drawDraft();
        }
        return;
      }
      if (ui.tool !== 'select') {
        container.classList.remove('hovering');
        return;
      }
      let hover: Selection = null;
      const vid = vehicles.pick(e.point.x, e.point.y, map.getZoom() > 16.5 ? 22 : 15);
      if (vid) hover = { kind: 'vehicle', id: vid };
      else {
        const f: MapGeoJSONFeature | undefined = map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], { layers: ['lines-hit'] })[0];
        if (f?.properties?.id) hover = { kind: 'line', id: f.properties.id as string };
      }
      if (!same(hover, ui.hover) && !(ui.hover?.kind === 'stop' && !hover)) ui.setHover(hover);
      container.classList.toggle('hovering', !!hover);
    });
  });
  map.on('mouseout', () => {
    previewTo = null;
    overlays.setStopHover(null);
    useUI.getState().setHover(null);
  });

  map.on('click', (e: MapMouseEvent) => {
    const ui = useUI.getState();
    const at: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    if (ui.tool === 'select') {
      const vid = vehicles.pick(e.point.x, e.point.y, map.getZoom() > 16.5 ? 24 : 16);
      if (vid) return ui.select({ kind: 'vehicle', id: vid });
      const f = map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: ['lines-hit'] })[0];
      if (f?.properties?.id) return ui.select({ kind: 'line', id: f.properties.id as string });
      if (ui.selection) ui.select(null);
      return;
    }
    if (ui.tool !== 'route') return;
    const p = pickStop(e.point);
    if (p) return addDraftStop(p);
    if (!inPlayArea(at)) return ui.notify('Lines are limited to the Istanbul prototype area in this demo.', 'warn');
    ui.notify('Pick an existing bus stop: the white dots on the map.', 'warn');
  });

  Object.assign(window as object, { __sim: sim, __ui: useUI, __snap: snap, __freeStops: () => freeStops });
  return { vehicles, markers };
}
