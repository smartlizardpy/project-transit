import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { buildStyle } from './style.ts';
import { CityLayer } from './cityLayer.ts';
import { addMapImages } from './images.ts';
import { mapRuntime } from './runtime.ts';
import { installController } from './controller.ts';
import { PRESETS } from '../app/presets.ts';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

/** The bundled (offline) city is shown behind the start menu. */
const MENU_CITY = PRESETS[0];

export function MapView() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const origin = new URL(import.meta.env.BASE_URL, window.location.href).href;
    const map = new maplibregl.Map({
      container: ref.current,
      style: buildStyle(origin),
      center: MENU_CITY.centre,
      zoom: MENU_CITY.view.zoom,
      pitch: MENU_CITY.view.pitch,
      bearing: MENU_CITY.view.bearing,
      maxPitch: 68,
      minZoom: 3,
      maxZoom: 19.5,
      attributionControl: false,
      canvasContextAttributes: { antialias: true, preserveDrawingBuffer: false },
      fadeDuration: 180,
    });
    const city = new CityLayer(MENU_CITY.centre);
    map.on('load', () => {
      addMapImages(map);
      map.addLayer(city, 'oneway-arrows');
      const ctl = installController(map, city);
      Object.assign(window as object, { __ctl: ctl });
      mapRuntime.attach(map, city);
    });
    map.on('style.load', () => addMapImages(map));
    map.on('styleimagemissing', () => addMapImages(map));
    Object.assign(window as object, { __map: map, __city: city });
    return () => {
      mapRuntime.detach();
      map.remove();
    };
  }, []);

  return <div ref={ref} className="map-root" />;
}
