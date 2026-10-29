import type { Map as MlMap } from 'maplibre-gl';
import type { CityLayer } from './cityLayer.ts';

type Listener = () => void;

/** Holds the live map + 3D layer so non-React systems (sim, overlays) can reach them. */
class MapRuntime {
  map: MlMap | null = null;
  city: CityLayer | null = null;
  private listeners = new Set<Listener>();

  attach(map: MlMap, city: CityLayer) {
    this.map = map;
    this.city = city;
    this.listeners.forEach((l) => l());
  }

  detach() {
    this.map = null;
    this.city = null;
  }

  onReady(fn: Listener): () => void {
    if (this.map) fn();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const mapRuntime = new MapRuntime();
