// Life behind the start menu: a small bus company runs on the real streets of the menu city,
// using the real simulation, and the camera drifts slowly after its buses. It is never saved,
// never shown in the game UI, and stops the moment a game is loaded or a new one is set up.
import type { Map as MlMap, MapLibreEvent } from 'maplibre-gl';
import type { CityLayer } from './cityLayer.ts';
import type { VehicleLayer } from './vehicles3d.ts';
import type { Overlays } from './overlays.ts';
import { session, useSession } from '../app/session.ts';
import { PRESETS, presetSpec } from '../app/presets.ts';
import { Game, newGameState } from '../game/engine.ts';
import { post } from '../game/finance.ts';
import { flatTimetable } from '../game/timetable.ts';
import { checkStop } from '../game/network.ts';
import { distanceM, nearestNode, route, type LngLat } from '../game/world/graph.ts';
import type { Region } from '../game/world/region.ts';
import { useNewCompanyFlow } from '../ui/NewCompany.tsx';

const LIVERY = '#e0573e';
/** line directions through the centre, with the bus model each one runs */
const LINES: { angle: number; model: string }[] = [
  { angle: 0.2, model: 'city12' },
  { angle: 0.72, model: 'artic18' },
  { angle: 1.25, model: 'deck11' },
  { angle: 1.78, model: 'midi10' },
  { angle: 2.3, model: 'ecity12' },
  { angle: 2.82, model: 'city12' },
];
const TOUR = { zoom: 16.9, pitch: 60, turn: 2.2 /* degrees per second */, hold: 22 /* seconds per bus */ };

/** Build the showcase company: six lines crossing the centre, four buses each. */
export function buildShowcase(region: Region): Game | null {
  const zones = [...region.zones].sort((a, b) => b.residents + b.jobs - (a.residents + a.jobs));
  if (!zones.length) return null;
  const state = newGameState({ region, company: { name: 'Showcase', colour: LIVERY, logo: 0 }, homeZone: zones[0].id, startHour: 7, seed: 11 });
  state.territory.owned = region.zones.map((z) => z.id);
  state.company.reputation = 100; // every model unlocked
  post(state, { amt: 1e9, cat: 'grant', memo: 'Showcase' });
  const g = new Game(state, region);
  const gr = region.graph;
  const [cx, cy] = g.geo.xy(region.spec.centre);
  const b = region.bounds;
  const radius = Math.min(1300, 0.36 * Math.min(distanceM([b.w, b.s], [b.e, b.s]), distanceM([b.w, b.s], [b.w, b.n])));
  for (const { angle, model } of LINES) {
    const dx = Math.cos(angle) * radius, dy = Math.sin(angle) * radius;
    const a = nearestNode(gr, region.index, cx + dx, cy + dy, 400);
    const z = nearestNode(gr, region.index, cx - dx, cy - dy, 400);
    if (a < 0 || z < 0) continue;
    const leg = route(gr, a, z);
    if (!leg) continue;
    // stops every ~420 m; a stop that already exists nearby (another line's) is shared
    const stops: string[] = [];
    let acc = 1e9;
    for (let i = 0; i < leg.nodes.length; i++) {
      if (i > 0) acc += gr.len[leg.dedges[i - 1] >> 1];
      if (acc < 420) continue;
      const v = leg.nodes[i];
      const ll: LngLat = [gr.lng[v], gr.lat[v]];
      const c = checkStop(g.state, region, g.geo, ll);
      let id = c.clash ?? null;
      if (c.ok) {
        const placed = g.placeStop(ll);
        id = placed.ok ? placed.value : null;
      }
      if (id && !stops.includes(id)) {
        stops.push(id);
        acc = 0;
      }
    }
    if (stops.length < 3) continue;
    const r = g.createRoute({ stops, kind: 'linear', timetable: flatTimetable(6) });
    if (!r.ok) continue;
    let depot: string | null = null;
    for (let i = 0; i < leg.nodes.length && !depot; i += 3) {
      const v = leg.nodes[i];
      const d = g.buildDepot([gr.lng[v] + 0.0012, gr.lat[v] + 0.0008]);
      if (d.ok) depot = d.value;
    }
    if (!depot) continue;
    for (let i = 0; i < 4; i++) {
      const bus = g.buyVehicle(model, depot);
      if (bus.ok) g.assignVehicle(bus.value, r.value);
    }
  }
  if (!Object.keys(g.state.vehicles).length) return null;
  g.run(5400); // spread the buses along their lines
  g.setSpeed(1);
  return g;
}

export interface Showcase {
  frame(dt: number): void;
}

export function installShowcase(map: MlMap, city: CityLayer, vehicles: VehicleLayer, overlays: Overlays): Showcase {
  let game: Game | null = null;
  let gen = 0;
  let target: string | null = null;
  let held = 0;
  let pausedUntil = 0;
  let padded = false;
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const wanted = () => useSession.getState().phase === 'menu' && !session.game;
  const touring = () => !calm && !useNewCompanyFlow.getState().open && performance.now() > pausedUntil;

  const start = async () => {
    const token = ++gen;
    try {
      const region = session.region ?? (await session.loadRegion(presetSpec(PRESETS[0]), { quiet: true }));
      if (token !== gen || !wanted()) return;
      const g = buildShowcase(region);
      if (!g || token !== gen || !wanted()) return;
      city.setDynamicOrigin(region.spec.centre);
      game = g;
      target = null;
      vehicles.show(g);
      overlays.setShowcase(g);
    } catch {
      /* another area is loading, or the map data is unavailable: the menu just stays still */
    }
  };

  const stop = () => {
    gen++;
    if (game) vehicles.release(game);
    if (game) overlays.setShowcase(null);
    game = null;
    if (padded) {
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      padded = false;
    }
  };

  let busy = false;
  const sync = () => {
    if (wanted()) {
      if (!game && !busy) {
        busy = true;
        void start().finally(() => (busy = false));
      }
    } else if (game || busy) stop();
  };
  useSession.subscribe((s, p) => s.phase !== p.phase && sync());
  session.onGame(() => sync());
  sync();

  // a player moving the map takes over the camera for a while
  const takeOver = (e: MapLibreEvent<unknown>) => {
    if ((e as { originalEvent?: unknown }).originalEvent) pausedUntil = performance.now() + 12_000;
  };
  for (const ev of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'] as const) map.on(ev, takeOver);

  const busAt = (id: string): LngLat | null => {
    const v = game?.state.vehicles[id];
    const p = v && game!.pose(v);
    return p ? game!.geo.P.toLngLat(p.x, p.y) : null;
  };

  /** a bus out on the road, preferably near where the camera already is */
  const pickBus = (): string | null => {
    if (!game) return null;
    const c = map.getCenter();
    const live = game.vehicleList().filter((v) => v.id !== target && (v.status === 'in_service' || v.status === 'at_stop') && busAt(v.id));
    if (!live.length) return null;
    const near = live.filter((v) => distanceM(busAt(v.id)!, [c.lng, c.lat]) < 900);
    const pool = near.length ? near : live;
    return pool[Math.floor(Math.random() * pool.length)].id;
  };

  return {
    frame(dt: number) {
      if (!game) return;
      game.advance(dt);
      if (!touring() || map.isMoving()) return;
      held += dt;
      if (!target || held > TOUR.hold || !busAt(target)) {
        target = pickBus();
        held = 0;
      }
      const at = target ? busAt(target) : null;
      if (!at) return;
      if (!padded) {
        // keep the action to the right of the menu column
        const w = map.getContainer().clientWidth;
        map.setPadding({ top: 0, bottom: 0, right: 0, left: Math.round(Math.min(w * 0.42, 620)) });
        padded = true;
      }
      const k = 1 - Math.exp(-dt / 3.2);
      const c = map.getCenter();
      map.jumpTo({
        center: [c.lng + (at[0] - c.lng) * k, c.lat + (at[1] - c.lat) * k],
        bearing: map.getBearing() + dt * TOUR.turn,
        zoom: map.getZoom() + (TOUR.zoom - map.getZoom()) * k * 0.6,
        pitch: map.getPitch() + (TOUR.pitch - map.getPitch()) * k * 0.6,
      });
    },
  };
}
