// HTML markers: the company's stops (with served lines and waiting passengers), depots,
// notable destinations, numbered stops of the line being drafted, and the placement ghost.
import { Marker, type Map as MlMap } from 'maplibre-gl';
import { useUI } from '../state/store.ts';
import { session, useSession } from '../app/session.ts';
import type { Game } from '../game/engine.ts';
import type { LngLat } from '../game/world/graph.ts';
import type { Poi, PoiKind } from '../game/world/region.ts';
import { waitingAt } from '../game/passengers.ts';

export const BUS_GLYPH = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="1.8" width="10" height="10.6" rx="2.4" fill="#2a5d45"/><rect x="4.4" y="3.4" width="7.2" height="4.2" rx="0.9" fill="#fff"/><circle cx="5.7" cy="10.1" r="0.95" fill="#fff"/><circle cx="10.3" cy="10.1" r="0.95" fill="#fff"/><rect x="4.1" y="12.2" width="2" height="2" rx=".6" fill="#2a5d45"/><rect x="9.9" y="12.2" width="2" height="2" rx=".6" fill="#2a5d45"/></svg>`;
const DEPOT_GLYPH = `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2.5 7.6 9 3l6.5 4.6V15h-13Z" fill="#fff"/><rect x="5" y="9" width="8" height="6" rx="1" fill="var(--c)"/><path d="M5 11h8M5 13h8" stroke="#fff" stroke-width="1"/></svg>`;

type Glyph = 'culture' | 'shopping' | 'education' | 'hub' | 'health';
const KIND_GLYPH: Partial<Record<PoiKind, Glyph>> = {
  university: 'education', school: 'education', hospital: 'health', mall: 'shopping', market: 'shopping',
  station: 'hub', ferry: 'hub', culture: 'culture', civic: 'culture', worship: 'culture',
};
const GLYPH_COLOUR: Record<Glyph, string> = { culture: '#b0745a', shopping: '#c98a3a', education: '#5f7fc4', hub: '#3f8a8e', health: '#d0605a' };
const GLYPH: Record<Glyph, string> = {
  culture: `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1.2 9.2 4.4H8.4V12H5.6V4.4H4.8Z" fill="#fff"/><rect x="3.4" y="11.4" width="7.2" height="1.6" rx=".5" fill="#fff"/></svg>`,
  shopping: `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 5h8l-.6 7.2H3.6Z" fill="#fff"/><path d="M5.2 5V4a1.8 1.8 0 0 1 3.6 0v1" stroke="#fff" stroke-width="1.3" fill="none"/></svg>`,
  education: `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 2.4 13 5.4 7 8.4 1 5.4Z" fill="#fff"/><path d="M3.8 7v2.6c0 .9 1.4 1.8 3.2 1.8s3.2-.9 3.2-1.8V7L7 8.6Z" fill="#fff"/></svg>`,
  hub: `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 8.6h10l-1.4 2.6H3.4Z" fill="#fff"/><rect x="4" y="5" width="6" height="3" rx=".8" fill="#fff"/><rect x="6.3" y="2.6" width="1.4" height="2.6" fill="#fff"/></svg>`,
  health: `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M5.6 2.4h2.8v3.2h3.2v2.8H8.4v3.2H5.6V8.4H2.4V5.6h3.2Z" fill="#fff"/></svg>`,
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface MarkerCallbacks {
  stop: (id: string, e: MouseEvent) => void;
  depot: (id: string) => void;
}

export class MarkerLayer {
  private stops = new Map<string, { m: Marker; el: HTMLDivElement; key: string }>();
  private depots = new Map<string, { m: Marker; el: HTMLDivElement }>();
  private draftMarkers: Marker[] = [];
  private pois: Marker[] = [];
  private poiKey = '';
  private ghost: Marker;
  private ghostEl: HTMLDivElement;
  private game: Game | null = null;
  private offs: (() => void)[] = [];

  constructor(private map: MlMap, private cb: MarkerCallbacks) {
    this.ghostEl = document.createElement('div');
    this.ghostEl.className = 'ghost-mk';
    this.ghost = new Marker({ element: this.ghostEl, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat([0, 0]);
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
    session.onGame((g) => this.attach(g));
    useSession.subscribe((s, p) => s.phase !== p.phase && this.rebuildPois());
    this.attach(session.game);
  }

  private attach(g: Game | null) {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.game = g;
    if (g)
      this.offs.push(
        g.on('changed', () => {
          this.rebuild();
          // landmarks follow the visible territory (a new licence reveals more)
          if (g.state.territory.owned.join() !== this.poiKey) this.rebuildPois();
        }),
      );
    this.rebuild();
    this.rebuildPois();
  }

  private rebuildPois() {
    this.pois.forEach((m) => m.remove());
    this.pois = [];
    const region = this.game?.region ?? (useSession.getState().phase === 'setup' ? session.region : null);
    if (!region) return;
    const g = this.game;
    this.poiKey = g ? g.state.territory.owned.join() : '';
    // only in the area the company can see: its own areas and those it can license next
    const owned = new Set(g?.state.territory.owned ?? []);
    const visible = (p: Poi) => {
      if (!g) return true;
      const z = g.geo.zoneAt(p.lngLat);
      return owned.has(z.id) || z.neighbours.some((n) => owned.has(n));
    };
    const picked: Poi[] = [];
    const sorted = region.pois.filter((p) => KIND_GLYPH[p.kind] && p.name && visible(p)).sort((a, b) => b.weight - a.weight);
    const near = (a: LngLat, b: LngLat) => Math.abs(a[0] - b[0]) < 0.0035 && Math.abs(a[1] - b[1]) < 0.0025;
    for (const p of sorted) {
      if (picked.length >= 28) break;
      if (picked.some((q) => near(q.lngLat, p.lngLat))) continue;
      picked.push(p);
    }
    for (const p of picked) {
      const glyph = KIND_GLYPH[p.kind]!;
      const el = document.createElement('div');
      el.className = 'dest-mk';
      el.style.setProperty('--c', GLYPH_COLOUR[glyph]);
      el.innerHTML = `<div class="badge">${GLYPH[glyph]}</div><div class="dname">${esc(p.name)}</div>`;
      el.title = `${p.name} · draws passenger trips (estimate)`;
      this.pois.push(new Marker({ element: el, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat(p.lngLat).addTo(this.map));
    }
  }

  rebuild() {
    const g = this.game;
    const seen = new Set<string>();
    if (g) {
      for (const s of Object.values(g.state.stops)) {
        seen.add(s.id);
        const lines = g.routesUsing(s.id);
        const key = `${s.name}|${s.lngLat.join()}|${lines.map((r) => `${r.number}${r.colour}`).join()}`;
        let entry = this.stops.get(s.id);
        if (entry && entry.key === key) continue;
        if (!entry) {
          const el = document.createElement('div');
          el.className = 'stop-mk';
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            this.cb.stop(s.id, e);
          });
          el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.cb.stop(s.id, e);
          });
          el.addEventListener('mouseenter', () => useUI.getState().setHover({ kind: 'stop', id: s.id }));
          el.addEventListener('mouseleave', () => useUI.getState().hover?.kind === 'stop' && useUI.getState().setHover(null));
          const m = new Marker({ element: el, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat(s.lngLat).addTo(this.map);
          entry = { m, el, key: '' };
          this.stops.set(s.id, entry);
        }
        entry.key = key;
        entry.m.setLngLat(s.lngLat);
        entry.el.classList.toggle('unserved', !lines.length);
        const pips = lines.map((r) => `<i style="--c:${r.colour}">${esc(r.number)}</i>`).join('');
        entry.el.innerHTML = `<div class="foot"></div><div class="stem"></div><div class="pin">${BUS_GLYPH}</div><div class="pips">${pips}</div><div class="name">${esc(s.name)}<span class="waiting"></span></div>`;
      }
    }
    for (const [id, e] of this.stops)
      if (!seen.has(id)) {
        e.m.remove();
        this.stops.delete(id);
      }
    // depots
    const dseen = new Set<string>();
    if (g)
      for (const d of Object.values(g.state.depots)) {
        dseen.add(d.id);
        let entry = this.depots.get(d.id);
        if (!entry) {
          const el = document.createElement('div');
          el.className = 'depot-mk';
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            this.cb.depot(d.id);
          });
          const m = new Marker({ element: el, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat(d.lngLat).addTo(this.map);
          entry = { m, el };
          this.depots.set(d.id, entry);
        }
        entry.el.style.setProperty('--c', g.state.company.colour);
        const use = g.depotUse(d.id);
        entry.el.innerHTML = `<div class="dp-badge">${DEPOT_GLYPH}</div><div class="dp-name">${esc(d.name)}<span>${use}/${d.capacity}</span></div>`;
      }
    for (const [id, e] of this.depots)
      if (!dseen.has(id)) {
        e.m.remove();
        this.depots.delete(id);
      }
    this.syncSelection();
    this.syncDraft();
    this.refreshWaiting();
  }

  private syncSelection() {
    const sel = useUI.getState().selection;
    for (const [id, { el }] of this.stops) el.classList.toggle('sel', sel?.kind === 'stop' && sel.id === id);
    for (const [id, { el }] of this.depots) el.classList.toggle('sel', sel?.kind === 'depot' && sel.id === id);
  }

  refreshWaiting() {
    const g = this.game;
    if (!g) return;
    for (const [id, { el }] of this.stops) {
      const w = el.querySelector('.waiting');
      if (!w) continue;
      const n = waitingAt(g.state, id);
      const txt = n ? String(n) : '';
      if (w.textContent !== txt) w.textContent = txt;
      el.classList.toggle('crowded', n >= 40);
    }
  }

  private syncDraft() {
    const draft = useUI.getState().draft;
    this.draftMarkers.forEach((m) => m.remove());
    this.draftMarkers = [];
    for (const [, { el }] of this.stops) el.classList.remove('in-draft');
    const g = this.game;
    if (!draft || !g) return;
    const seq = draft.editingReturn && draft.returnStops ? draft.returnStops : draft.stops;
    const labels = new Map<string, string[]>();
    seq.forEach((id, i) => {
      const l = labels.get(id) ?? [];
      l.push(String(i + 1));
      labels.set(id, l);
    });
    for (const [id, nums] of labels) {
      const s = g.state.stops[id];
      if (!s) continue;
      this.stops.get(id)?.el.classList.add('in-draft');
      const el = document.createElement('div');
      el.className = 'draft-num';
      el.style.setProperty('--c', draft.colour);
      const first = nums[0] === '1';
      const last = nums.includes(String(seq.length)) && seq.length > 1;
      el.innerHTML = `<span class="${first ? 'start' : last ? 'end' : ''}">${nums.join('·')}</span>`;
      this.draftMarkers.push(new Marker({ element: el, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport', offset: [0, -56] }).setLngLat(s.lngLat).addTo(this.map));
    }
  }

  /** Placement preview for the stop and depot tools. */
  showGhost(at: LngLat | null, ok: boolean, label: string, kind: 'stop' | 'depot' = 'stop') {
    if (!at) {
      this.ghost.remove();
      return;
    }
    this.ghostEl.className = `ghost-mk ${ok ? 'ok' : 'bad'} ${kind}`;
    const html = `<div class="foot"></div><div class="stem"></div><div class="pin">${kind === 'depot' ? DEPOT_GLYPH : BUS_GLYPH}</div><div class="tip">${label}</div>`;
    if (this.ghostEl.innerHTML !== html) this.ghostEl.innerHTML = html;
    this.ghost.setLngLat(at);
    if (!this.ghost.getElement().isConnected) this.ghost.addTo(this.map);
  }
}
