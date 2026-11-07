// Friends on the map during co-op: their mouse cursors (with names) and pings. Also sends this
// player's own cursor, and Alt/Option-click (with the select tool) pings a spot for everyone.

import { Marker, type Map as MlMap, type MapMouseEvent } from 'maplibre-gl';
import { presence, sendCursor, sendPing, useCoop } from '../net/coop.ts';
import { useUI } from '../state/store.ts';
import type { LngLat } from '../game/world/graph.ts';

const ARROW = (c: string) => `<svg width="18" height="22" viewBox="0 0 18 22"><path d="M2 1.5v17l4.6-4.3 3.1 6.6 3-1.4-3.1-6.5 6.4-.4z" fill="${c}" stroke="#14181a" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
/** a cursor not heard from for this long is hidden (the friend's mouse left the map) */
const STALE_MS = 6000;

interface Shown {
  m: Marker;
  el: HTMLElement;
  at: LngLat;
  target: LngLat;
  colour: string;
}

export function installCoopLayer(map: MlMap) {
  const shown = new Map<string, Shown>();
  let raf = 0;

  const sync = () => {
    const players = useCoop.getState().players;
    const now = performance.now();
    for (const [id, c] of presence.cursors) {
      const p = players.find((q) => q.id === id);
      if (!p || now - c.seen > STALE_MS) continue;
      let s = shown.get(id);
      if (!s || s.colour !== p.colour) {
        s?.m.remove();
        const el = document.createElement('div');
        el.className = 'co-cursor';
        el.innerHTML = `${ARROW(p.colour)}<b style="background:${p.colour}"></b>`;
        s = { m: new Marker({ element: el, anchor: 'top-left', pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat(c.at).addTo(map), el, at: c.at, target: c.at, colour: p.colour };
        shown.set(id, s);
      }
      s.el.querySelector('b')!.textContent = p.name;
      s.target = c.at;
    }
    for (const [id, s] of shown) {
      const c = presence.cursors.get(id);
      if (!c || now - c.seen > STALE_MS || !players.some((p) => p.id === id)) {
        s.m.remove();
        shown.delete(id);
      }
    }
    // pings: a pulse for each new one
    while (presence.pings.length) {
      const p = presence.pings.shift()!;
      const el = document.createElement('div');
      el.className = 'co-ping';
      el.style.setProperty('--c', p.colour);
      el.innerHTML = '<i></i><i></i>';
      const m = new Marker({ element: el, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat(p.at).addTo(map);
      setTimeout(() => m.remove(), 2600);
    }
    if (shown.size && !raf) raf = requestAnimationFrame(glide);
  };

  // glide towards the latest position (updates arrive ~15 times a second)
  const glide = () => {
    raf = 0;
    let moving = false;
    for (const s of shown.values()) {
      const dx = s.target[0] - s.at[0], dy = s.target[1] - s.at[1];
      if (Math.abs(dx) + Math.abs(dy) < 1e-9) continue;
      s.at = [s.at[0] + dx * 0.4, s.at[1] + dy * 0.4];
      s.m.setLngLat(s.at);
      moving = true;
    }
    if (moving) raf = requestAnimationFrame(glide);
  };

  presence.listeners.add(sync);
  useCoop.subscribe((s, prev) => s.players !== prev.players && sync());
  setInterval(sync, 2000); // hide cursors that went quiet

  map.on('mousemove', (e: MapMouseEvent) => {
    if (useCoop.getState().role) sendCursor([e.lngLat.lng, e.lngLat.lat]);
  });
  map.getCanvas().addEventListener('mouseleave', () => {
    if (useCoop.getState().role) sendCursor(null);
  });
  map.on('click', (e: MapMouseEvent) => {
    if (!useCoop.getState().role || !e.originalEvent.altKey || useUI.getState().tool !== 'select') return;
    sendPing([e.lngLat.lng, e.lngLat.lat]);
  });
}
