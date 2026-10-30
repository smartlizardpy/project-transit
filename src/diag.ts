// Desktop-only self check. Inert unless the Tauri shell was started with PT_DIAG_DIR.
// Reports in stages so a failure shows how far start-up got.
import { invoke } from '@tauri-apps/api/core';
import { mapRuntime } from './map/runtime.ts';

const errors: string[] = [];
const stages: string[] = [];

function send(extra: Record<string, unknown>, png?: string) {
  const report = { stages, errors, userAgent: navigator.userAgent, location: location.href, ...extra };
  return invoke('diag_report', { report: JSON.stringify(report, null, 2), pngBase64: png ?? null }).catch(() => {});
}

export async function startDiagnostics() {
  if (!('__TAURI_INTERNALS__' in window)) return;
  let enabled = false;
  try {
    enabled = await invoke<boolean>('diag_enabled');
  } catch (e) {
    console.warn('diag unavailable', e);
    return;
  }
  if (!enabled) return;
  const saveMode = await invoke<string | null>('diag_save_mode').catch(() => null);
  if (saveMode) void import('./diagSave.ts').then((m) => m.runSaveCheck(saveMode));
  window.addEventListener('error', (e) => errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => errors.push(`rejection: ${String(e.reason)}`));
  stages.push('boot');
  let frames = 0;
  const countFrames = () => { frames++; requestAnimationFrame(countFrames); };
  requestAnimationFrame(countFrames);
  const started = performance.now();
  const beat = setInterval(() => {
    if (done) return clearInterval(beat);
    send({ ready: false, heartbeat: Math.round((performance.now() - started) / 1000), frames, visibility: document.visibilityState, focused: document.hasFocus(), mapAttached: !!mapRuntime.map, mapLoaded: mapRuntime.map?.loaded() ?? null, tilesLoaded: mapRuntime.map?.areTilesLoaded() ?? null, cityBusy: mapRuntime.city?.busy ?? null });
  }, 2000);
  await send({ ready: false });
  let done = false;
  const final = (ready: boolean) => {
    if (done) return;
    done = true;
    const map = mapRuntime.map;
    if (!map) return void send({ ready: false, note: 'map never attached' });
    map.once('render', () => {
      const gl = map.getCanvas().getContext('webgl2');
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      const extra = {
        ready,
        renderer: gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl ? 'webgl2' : 'none',
        canvas: [map.getCanvas().width, map.getCanvas().height],
        zoom: map.getZoom(),
        mapLoaded: map.loaded(),
        tilesLoaded: map.areTilesLoaded(),
        cityTiles: mapRuntime.city?.tileCount ?? null,
      };
      send(extra, map.getCanvas().toDataURL('image/png').split(',')[1]);
    });
    map.triggerRepaint();
  };
  setTimeout(() => final(false), 22_000);
  mapRuntime.onReady(() => {
    stages.push('map-ready');
    const map = mapRuntime.map!;
    const city = mapRuntime.city!;
    const check = () => {
      if (done) return;
      if (map.loaded() && map.areTilesLoaded() && !city.busy) {
        stages.push('tiles-ready');
        setTimeout(() => final(true), 2500);
      } else setTimeout(check, 300);
    };
    check();
  });
}
