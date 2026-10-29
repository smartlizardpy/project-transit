// HTML markers for stops, destinations and drafted stops (original designs).
import { Marker, type Map as MlMap } from 'maplibre-gl';
import { sim } from '../sim/sim.ts';
import { useUI } from '../state/store.ts';
import { DESTINATIONS, type Destination } from '../sim/destinations.ts';

export const BUS_GLYPH = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="1.8" width="10" height="10.6" rx="2.4" fill="#2a5d45"/><rect x="4.4" y="3.4" width="7.2" height="4.2" rx="0.9" fill="#fff"/><circle cx="5.7" cy="10.1" r="0.95" fill="#fff"/><circle cx="10.3" cy="10.1" r="0.95" fill="#fff"/><rect x="4.1" y="12.2" width="2" height="2" rx=".6" fill="#2a5d45"/><rect x="9.9" y="12.2" width="2" height="2" rx=".6" fill="#2a5d45"/></svg>`;

const DEST_GLYPH: Record<Destination['kind'], string> = {
  culture: `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1.2 9.2 4.4H8.4V12H5.6V4.4H4.8Z" fill="#fff"/><rect x="3.4" y="11.4" width="7.2" height="1.6" rx=".5" fill="#fff"/></svg>`,
  shopping: `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 5h8l-.6 7.2H3.6Z" fill="#fff"/><path d="M5.2 5V4a1.8 1.8 0 0 1 3.6 0v1" stroke="#fff" stroke-width="1.3" fill="none"/></svg>`,
  education: `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 2.4 13 5.4 7 8.4 1 5.4Z" fill="#fff"/><path d="M3.8 7v2.6c0 .9 1.4 1.8 3.2 1.8s3.2-.9 3.2-1.8V7L7 8.6Z" fill="#fff"/></svg>`,
  hub: `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 8.6h10l-1.4 2.6H3.4Z" fill="#fff"/><rect x="4" y="5" width="6" height="3" rx=".8" fill="#fff"/><rect x="6.3" y="2.6" width="1.4" height="2.6" fill="#fff"/><path d="M1.6 12.6c1 0 1-.6 2-.6s1 .6 2 .6 1-.6 2-.6 1 .6 2 .6 1-.6 2-.6 1 .6 1.2.6" stroke="#fff" stroke-width="1" fill="none"/></svg>`,
};

export class MarkerLayer {
  private stopMarkers = new Map<string, { m: Marker; el: HTMLDivElement }>();
  private draftMarkers: Marker[] = [];
  private destMarkers: Marker[] = [];

  constructor(private map: MlMap, private onStopClick: (id: string) => void) {
    this.buildDestinations();
    this.rebuildStops();
    sim.onNetwork(() => this.rebuildStops());
    useUI.subscribe((s, p) => {
      if (s.selection !== p.selection) this.syncSelection();
      if (s.draft !== p.draft) this.syncDraft();
    });
    const zoomClass = () => {
      const z = map.getZoom();
      const c = map.getContainer();
      c.classList.toggle('zoom-hidden', z < 13.6);
      c.classList.toggle('zoom-far', z < 15.4);
      c.classList.toggle('zoom-near', z > 16.9);
    };
    map.on('zoom', zoomClass);
    zoomClass();
  }

  private buildDestinations() {
    for (const d of DESTINATIONS) {
      const el = document.createElement('div');
      el.className = 'dest-mk';
      el.style.setProperty('--c', d.colour);
      el.innerHTML = `<div class="badge">${DEST_GLYPH[d.kind]}</div><div class="count">${d.tripsPerHour}</div><div class="dname">${d.name}</div>`;
      el.title = `${d.name} · ~${d.tripsPerHour} trips/h (estimate)`;
      this.destMarkers.push(new Marker({ element: el, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat(d.lngLat).addTo(this.map));
    }
  }

  rebuildStops() {
    for (const { m } of this.stopMarkers.values()) m.remove();
    this.stopMarkers.clear();
    for (const s of sim.stops.values()) {
      const el = document.createElement('div');
      el.className = 'stop-mk';
      const pips = s.lines
        .map((lid) => sim.line(lid))
        .filter(Boolean)
        .map((l) => `<i style="--c:${l!.colour}">${l!.number}</i>`)
        .join('');
      el.innerHTML = `<div class="foot"></div><div class="stem"></div><div class="pin">${BUS_GLYPH}</div><div class="pips">${pips}</div><div class="name">${s.name}<span class="waiting">${s.waiting}</span></div>`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onStopClick(s.id);
      });
      el.addEventListener('mouseenter', () => useUI.getState().tool === 'select' && useUI.getState().setHover({ kind: 'stop', id: s.id }));
      el.addEventListener('mouseleave', () => useUI.getState().setHover(null));
      const m = new Marker({ element: el, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat(s.lngLat).addTo(this.map);
      this.stopMarkers.set(s.id, { m, el });
    }
    this.syncSelection();
    this.refreshWaiting();
  }

  private syncSelection() {
    const sel = useUI.getState().selection;
    for (const [id, { el }] of this.stopMarkers) el.classList.toggle('sel', sel?.kind === 'stop' && sel.id === id);
  }

  refreshWaiting() {
    for (const [id, { el }] of this.stopMarkers) {
      const w = el.querySelector('.waiting');
      const s = sim.stops.get(id);
      if (w && s) w.textContent = String(s.waiting);
    }
  }

  private syncDraft() {
    const draft = useUI.getState().draft;
    this.draftMarkers.forEach((m) => m.remove());
    this.draftMarkers = [];
    if (!draft) return;
    draft.stops.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'stop-mk draft';
      el.innerHTML = `<div class="foot"></div><div class="stem"></div><div class="pin">${BUS_GLYPH}</div><div class="num">${i + 1}</div><div class="name" style="opacity:1;transform:none">${s.name}</div>`;
      this.draftMarkers.push(new Marker({ element: el, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat(s.lngLat).addTo(this.map));
    });
  }
}
