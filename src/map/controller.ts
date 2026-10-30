// Glue between the map, the 3D layer, the game and the UI: the simulation loop, picking,
// hover states, the follow camera and the build tools (stops, lines, depots).
import type { Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import type { CityLayer } from './cityLayer.ts';
import { installOverlays } from './overlays.ts';
import { VehicleLayer } from './vehicles3d.ts';
import { MarkerLayer } from './markers.ts';
import { useUI, type Selection } from '../state/store.ts';
import { session, useSession } from '../app/session.ts';
import type { Game } from '../game/engine.ts';
import { checkDepot, checkStop } from '../game/network.ts';
import { routeWithFallback, type LngLat } from '../game/world/graph.ts';
import { ECON } from '../game/content.ts';
import { activeSeq, addWaypoint, appendStop, computePreview, useDraftPreview } from '../ui/routeDraft.ts';
import { focusPoint, fitPoints } from '../ui/camera.ts';
import { installShowcase } from './showcase.ts';
import { stopSpots, type StopSpot } from '../game/spots.ts';

export interface Controller {
  vehicles: VehicleLayer;
  markers: MarkerLayer;
}

const same = (a: Selection, b: Selection) => a?.kind === b?.kind && a?.id === b?.id;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function installController(map: MlMap, city: CityLayer): Controller {
  const overlays = installOverlays(map);
  overlays.watchMask((m) => city.setMask(m));
  const container = map.getContainer();
  const vehicles = new VehicleLayer(city, container);
  const markers = new MarkerLayer(map, { stop: (id, e) => onStopClick(id, e), depot: (id) => onDepotClick(id) });
  const showcase = installShowcase(map, city, vehicles, overlays);
  let game: Game | null = session.game;

  // ───────────────────────── session → map
  const onGame = (g: Game | null, info?: { grown?: boolean }) => {
    game = g;
    if (info?.grown) return; // the same game on a bigger map: keep the camera and the open panels
    useUI.getState().reset();
    if (!g) return;
    city.setDynamicOrigin(g.region.spec.centre);
    // open on the company's home: depots and stops if any, else the home area
    const pts: LngLat[] = [...Object.values(g.state.depots).map((d) => d.lngLat), ...Object.values(g.state.stops).map((s) => s.lngLat)];
    if (pts.length) fitPoints(pts, 16.4);
    else {
      const z = g.geo.zone(g.state.territory.home);
      if (z) fitPoints(z.ring, 16);
    }
  };
  session.onGame(onGame);
  if (game) city.setDynamicOrigin(game.region.spec.centre);

  // ───────────────────────── simulation loop
  let last = performance.now();
  let raf = 0;
  let waitingTick = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.5, (now - last) / 1000);
    last = now;
    const g = game;
    if (g && useSession.getState().phase === 'playing') {
      const modal = useUI.getState().modal;
      if (!(modal && modal.kind === 'menu')) g.advance(dt);
      const ui = useUI.getState();
      if (ui.following) {
        const v = g.state.vehicles[ui.following];
        const pose = v && g.pose(v);
        if (pose && !map.isMoving()) {
          const at = g.geo.P.toLngLat(pose.x, pose.y);
          const c = map.getCenter();
          const k = Math.min(1, dt * 3.2);
          map.jumpTo({ center: [c.lng + (at[0] - c.lng) * k, c.lat + (at[1] - c.lat) * k] });
        }
      }
      if ((waitingTick += dt) > 0.5) {
        waitingTick = 0;
        markers.refreshWaiting();
      }
    } else showcase.frame(dt);
    map.triggerRepaint();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  map.on('remove', () => cancelAnimationFrame(raf));
  map.on('dragstart', () => useUI.getState().following && useUI.getState().follow(null));

  // ───────────────────────── store → map
  const syncTool = () => {
    const { tool, overlays: o } = useUI.getState();
    for (const t of ['route', 'stop', 'depot']) container.classList.toggle(`tool-${t}`, tool === t);
    city.setNetworkView(o.network ? 1 : o.traffic || o.demand ? 0.62 : 0);
    if (tool !== 'stop' && tool !== 'depot' && tool !== 'route') markers.showGhost(null, false, '');
  };
  syncTool();
  let previewFrame = 0;
  useUI.subscribe((s, p) => {
    if (s.tool !== p.tool || s.overlays !== p.overlays) syncTool();
    if (s.draft !== p.draft) {
      cancelAnimationFrame(previewFrame);
      previewFrame = requestAnimationFrame(() => {
        computePreview(useUI.getState().draft);
        drawDraft();
      });
    }
  });

  // ───────────────────────── line drafting
  let hoverTarget: number | null = null; // road node the next leg would go to
  let hoverLeg: LngLat[] | null = null;
  const nodeLL = (n: number): LngLat => [game!.region.graph.lng[n], game!.region.graph.lat[n]];
  const patternCoords = (i: number) => {
    const p = useDraftPreview.getState().preview?.patterns[i];
    return p?.valid ? Array.from(p.path.nodes, nodeLL) : null;
  };
  const drawDraft = () => {
    const d = useUI.getState().draft;
    if (!d || !game) return overlays.setDraft('#4fa3e0', {});
    const pv = useDraftPreview.getState().preview;
    const via = Object.values(d.via).flat();
    const outIdx = d.editingReturn ? 1 : 0;
    overlays.setDraft(d.colour, {
      out: pv ? patternCoords(outIdx) : null,
      ret: pv && pv.patterns.length > 1 ? patternCoords(outIdx === 0 ? 1 : 0) : null,
      preview: hoverLeg,
      via,
    });
  };
  /** last halt node of the sequence being edited */
  const lastNode = (): number | null => {
    const d = useUI.getState().draft;
    if (!d || !game) return null;
    const seq = activeSeq(d);
    const id = seq[seq.length - 1];
    const s = id ? game.state.stops[id] : null;
    return s ? s.node : null;
  };
  const setHoverTarget = (node: number | null) => {
    if (node === hoverTarget) return;
    hoverTarget = node;
    const from = lastNode();
    hoverLeg = null;
    if (game && from !== null && node !== null && from !== node) {
      const l = routeWithFallback(game.region.graph, from, node);
      if (l) hoverLeg = l.nodes.map(nodeLL);
    }
    drawDraft();
  };

  const addToDraft = (id: string) => {
    const ui = useUI.getState();
    const d = ui.draft;
    if (!d) return;
    const res = appendStop(d, id);
    if (typeof res === 'string') return ui.notify(res, 'warn');
    ui.editDraft(() => res);
    hoverTarget = null;
    hoverLeg = null;
  };

  /** Shift-click: force the nearest drafted leg through this point. */
  const addVia = (pt: { x: number; y: number }, at: LngLat) => {
    const ui = useUI.getState();
    const d = ui.draft;
    const pv = useDraftPreview.getState().preview;
    if (!d || !pv || !game) return;
    let best = { dist: 40, pat: -1, leg: -1 };
    pv.patterns.forEach((p, pi) => {
      if (!p.valid) return;
      const n = p.path.nodes;
      let prev = map.project(nodeLL(n[0]));
      for (let k = 1; k < n.length; k++) {
        const cur = map.project(nodeLL(n[k]));
        const dx = cur.x - prev.x, dy = cur.y - prev.y;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((pt.x - prev.x) * dx + (pt.y - prev.y) * dy) / len2));
        const dist = Math.hypot(prev.x + dx * t - pt.x, prev.y + dy * t - pt.y);
        if (dist < best.dist) {
          const s = p.path.cum[k - 1];
          let leg = 0;
          while (leg + 1 < p.stopS.length - 1 && p.stopS[leg + 1] <= s) leg++;
          best = { dist, pat: pi, leg };
        }
        prev = cur;
      }
    });
    if (best.pat < 0) return ui.notify('Shift-click on the drafted line to route it through a particular street.', 'info');
    const key = `${best.pat === 0 ? 'o' : 'r'}:${best.leg}`;
    ui.editDraft((dd) => addWaypoint(dd, key, at));
  };

  // ───────────────────────── tools
  const onStopClick = (id: string, e: MouseEvent) => {
    const ui = useUI.getState();
    if (!game || useSession.getState().phase !== 'playing') return;
    if (ui.tool === 'route') {
      if (e.type === 'contextmenu') return;
      return addToDraft(id);
    }
    if (e.type === 'contextmenu') return;
    ui.select({ kind: 'stop', id });
    if (ui.tool !== 'select') ui.setTool('select');
  };
  const onDepotClick = (id: string) => {
    const ui = useUI.getState();
    if (ui.tool === 'route') return;
    ui.setTool('select');
    ui.select({ kind: 'depot', id });
  };

  const stopLabel = (c: ReturnType<typeof checkStop>) =>
    c.ok ? `<b>${esc(c.name)}</b><span>${c.road ? `${esc(c.road)} · ` : ''}${game!.money(ECON.stopCost)}</span>` : `<em>${esc(c.reason ?? 'Not possible here')}</em>`;

  /** The stop spot under the pointer (stops can only be built on spots). */
  const spotAt = (pt: { x: number; y: number }) => {
    if (!game) return null;
    const fs = map.queryRenderedFeatures([[pt.x - 14, pt.y - 14], [pt.x + 14, pt.y + 14]], { layers: ['osm-stops-dot'] });
    let best: { id: number; stop: StopSpot } | null = null, bestD = Infinity;
    const spots = stopSpots(game.region);
    for (const f of fs) {
      const id = Number(f.properties?.id);
      const s = spots[id - 1];
      if (!s) continue;
      const p = map.project(s.lngLat);
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestD) {
        bestD = d;
        best = { id, stop: s };
      }
    }
    return best;
  };
  let lastSpotHint = 0;
  const spotHint = () => {
    if (performance.now() - lastSpotHint < 4000) return;
    lastSpotHint = performance.now();
    useUI.getState().notify('Stops can only be built on the stop spots: the round markers along the streets. Faded spots are outside your licensed area.', 'info');
  };

  /** Build a stop where the player clicked (snapped to the street), or explain why not. */
  const buildStopAt = (at: LngLat, name?: string): { id: string; built: boolean } | null => {
    if (!game) return null;
    const ui = useUI.getState();
    const c = checkStop(game.state, game.region, game.geo, at);
    if (!c.ok && c.clash) return { id: c.clash, built: false };
    const res = game.placeStop(at, name);
    if (!res.ok) {
      ui.notify(res.error, 'warn');
      if (!c.ok && c.zone && !game.state.territory.owned.includes(c.zone)) ui.select({ kind: 'zone', id: c.zone });
      return null;
    }
    ui.notify(`Stop built: ${game.state.stops[res.value].name} (−${game.money(ECON.stopCost)})`, 'good');
    return { id: res.value, built: true };
  };

  // ───────────────────────── pointer
  let hoverFrame = 0;
  map.on('mousemove', (e: MapMouseEvent) => {
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      const ui = useUI.getState();
      const phase = useSession.getState().phase;
      const at: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (phase === 'setup') {
        const f = useSession.getState().setupStep === 'area' ? map.queryRenderedFeatures(e.point, { layers: ['zones-fill'] })[0] : undefined;
        overlays.setZoneHover((f?.properties?.id as string) ?? null);
        container.classList.toggle('hovering', !!f);
        return;
      }
      if (phase !== 'playing' || !game) return;
      overlays.setZoneHover(null);
      if (ui.tool === 'route' || ui.tool === 'stop') {
        const hoveredStop = ui.hover?.kind === 'stop' ? game.state.stops[ui.hover.id] : null;
        const spot = hoveredStop ? null : spotAt(e.point);
        overlays.setStopHover(spot?.id ?? null);
        if (hoveredStop) {
          markers.showGhost(null, false, '');
          if (ui.tool === 'route') setHoverTarget(hoveredStop.node);
          container.classList.add('hovering');
          return;
        }
        if (!spot) {
          // only stop spots (and existing stops) can be picked
          markers.showGhost(null, false, '');
          if (ui.tool === 'route') setHoverTarget(null);
          container.classList.remove('hovering');
          return;
        }
        const c = checkStop(game.state, game.region, game.geo, spot.stop.lngLat);
        const near = c.clash ? game.state.stops[c.clash] : null;
        if (near && ui.tool === 'route') {
          markers.showGhost(null, false, '');
          setHoverTarget(near.node);
        } else {
          const what = spot.stop.osm ? 'Real stop location' : (c.road ?? 'Stop spot');
          const label = near ? `<em>${esc(c.reason ?? '')}</em>` : c.ok ? `<b>${esc(spot.stop.name || c.name)}</b><span>${esc(what)} · ${game.money(ECON.stopCost)}</span>` : stopLabel(c);
          markers.showGhost(c.node >= 0 ? c.lngLat : spot.stop.lngLat, c.ok, label);
          if (ui.tool === 'route') setHoverTarget(c.ok ? c.node : null);
        }
        container.classList.toggle('hovering', c.ok || !!near);
        return;
      }
      if (ui.tool === 'depot') {
        const c = checkDepot(game.state, game.region, game.geo, at);
        markers.showGhost(c.node >= 0 ? c.lngLat : at, c.ok, c.ok ? `<b>New depot</b><span>${ECON.depotCapacity} buses · ${game.money(ECON.depotCost)}</span>` : `<em>${esc(c.reason ?? '')}</em>`, 'depot');
        return;
      }
      // select tool
      let hover: Selection = ui.hover?.kind === 'stop' ? ui.hover : null;
      if (!hover) {
        const vid = vehicles.pick(e.point.x, e.point.y, map.getZoom() > 16.5 ? 22 : 15);
        if (vid) hover = { kind: 'vehicle', id: vid };
        else {
          const f = map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], { layers: ['lines-hit'] })[0];
          if (f?.properties?.id) hover = { kind: 'line', id: f.properties.id as string };
        }
      }
      if (!same(hover, ui.hover)) ui.setHover(hover);
      container.classList.toggle('hovering', !!hover);
    });
  });
  map.on('mouseout', () => {
    overlays.setStopHover(null);
    overlays.setZoneHover(null);
    markers.showGhost(null, false, '');
    if (useUI.getState().hover?.kind !== 'stop') useUI.getState().setHover(null);
  });

  map.on('contextmenu', (e: MapMouseEvent) => {
    const ui = useUI.getState();
    e.preventDefault();
    if (ui.tool === 'route' && ui.draft) ui.undoDraft();
    else if (ui.tool !== 'select') ui.setTool('select');
  });

  // keep the camera over the area you can see: panning out into the blank paper eases back
  map.on('moveend', (e) => {
    if (!game || useSession.getState().phase !== 'playing' || !(e as { originalEvent?: unknown }).originalEvent) return;
    const owned = game.state.territory.owned;
    let w = Infinity, s = Infinity, east = -Infinity, n = -Infinity;
    for (const z of game.region.zones) {
      if (!owned.includes(z.id) && !z.neighbours.some((id) => owned.includes(id))) continue;
      for (const [lng, lat] of z.ring) {
        w = Math.min(w, lng);
        east = Math.max(east, lng);
        s = Math.min(s, lat);
        n = Math.max(n, lat);
      }
    }
    if (!Number.isFinite(w)) return;
    const c = map.getCenter();
    const lng = Math.min(east, Math.max(w, c.lng)), lat = Math.min(n, Math.max(s, c.lat));
    if (lng !== c.lng || lat !== c.lat) map.easeTo({ center: [lng, lat], duration: 600 });
  });

  map.on('click', (e: MapMouseEvent) => {
    const ui = useUI.getState();
    const phase = useSession.getState().phase;
    const at: LngLat = [e.lngLat.lng, e.lngLat.lat];
    if (phase === 'setup') {
      const f = map.queryRenderedFeatures(e.point, { layers: ['zones-fill'] })[0];
      if (f?.properties?.id && useSession.getState().setupStep === 'area') useSession.setState({ homeZone: f.properties.id as string });
      return;
    }
    if (phase !== 'playing' || !game) return;
    if (ui.tool === 'select') {
      const vid = vehicles.pick(e.point.x, e.point.y, map.getZoom() > 16.5 ? 24 : 16);
      if (vid) return ui.select({ kind: 'vehicle', id: vid });
      const f = map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: ['lines-hit'] })[0];
      if (f?.properties?.id) return ui.select({ kind: 'line', id: f.properties.id as string });
      if (game.geo.inBounds(at, 0)) {
        const z = game.geo.zoneAt(at);
        const owned = game.state.territory.owned;
        // an area offered for licence (under the light veil) opens its licence card
        const offered = !z.water && !owned.includes(z.id) && z.neighbours.some((n) => owned.includes(n));
        if (offered || ui.overlays.areas || ui.selection?.kind === 'zone') return ui.select({ kind: 'zone', id: z.id });
      }
      if (ui.selection) ui.select(null);
      return;
    }
    if (ui.tool === 'stop') {
      const spot = spotAt(e.point);
      if (!spot) return spotHint();
      const res = buildStopAt(spot.stop.lngLat, spot.stop.name || undefined);
      if (res && !res.built) ui.select({ kind: 'stop', id: res.id });
      return;
    }
    if (ui.tool === 'route') {
      if (e.originalEvent.shiftKey || e.originalEvent.altKey) return addVia(e.point, at);
      const spot = spotAt(e.point);
      if (!spot) return spotHint();
      const res = buildStopAt(spot.stop.lngLat, spot.stop.name || undefined);
      if (res) addToDraft(res.id);
      return;
    }
    if (ui.tool === 'depot') {
      const res = game.buildDepot(at);
      if (!res.ok) return ui.notify(res.error, 'warn');
      ui.notify(`${game.state.depots[res.value].name} built (−${game.money(ECON.depotCost)}). Buy buses in the Fleet panel.`, 'good');
      ui.setTool('select');
      ui.select({ kind: 'depot', id: res.value });
      markers.showGhost(null, false, '');
      focusPoint(game.state.depots[res.value].lngLat, 16.2);
    }
  });

  Object.assign(window as object, { __ui: useUI, __session: session });
  return { vehicles, markers };
}
