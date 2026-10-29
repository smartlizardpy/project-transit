import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { buildStyle } from './style.ts';
import { CityLayer } from './cityLayer.ts';
import { addMapImages } from './images.ts';
import { mapRuntime } from './runtime.ts';
import { installController } from './controller.ts';
import { HOME_VIEW, DEMO_ORIGIN } from '../sim/demoCity.ts';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

export function MapView() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const origin = new URL(import.meta.env.BASE_URL, window.location.href).href;
    const map = new maplibregl.Map({
      container: ref.current,
      style: buildStyle(origin),
      center: HOME_VIEW.center,
      zoom: HOME_VIEW.zoom,
      pitch: HOME_VIEW.pitch,
      bearing: HOME_VIEW.bearing,
      maxPitch: 68,
      minZoom: 3,
      maxZoom: 19.5,
      attributionControl: false,
      canvasContextAttributes: { antialias: true, preserveDrawingBuffer: false },
      fadeDuration: 180,
    });
    const city = new CityLayer(DEMO_ORIGIN);
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
