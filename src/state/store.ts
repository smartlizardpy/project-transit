import { create } from 'zustand';
import type { LngLat } from '../game/world/graph.ts';
import type { RouteKind } from '../game/types.ts';

export type Tool = 'select' | 'stop' | 'route' | 'depot';
export type Selection =
  | { kind: 'vehicle'; id: string }
  | { kind: 'line'; id: string }
  | { kind: 'stop'; id: string }
  | { kind: 'depot'; id: string }
  | { kind: 'zone'; id: string }
  | null;
export type Panel = 'fleet' | 'finance' | 'lines' | 'company' | null;
export type Modal = { kind: 'timetable'; route: string } | { kind: 'menu' } | { kind: 'settings' } | { kind: 'save' } | { kind: 'notifications' } | null;

/** A line being created or edited. Stops are game stop ids. */
export interface RouteDraft {
  /** id of the line being edited, or null for a new line */
  editing: string | null;
  number: string;
  name: string;
  colour: string;
  kind: RouteKind;
  stops: string[];
  /** custom return stops for linear lines (null = outbound reversed) */
  returnStops: string[] | null;
  /** waypoints per leg, keyed like Route.via */
  via: Record<string, LngLat[]>;
  /** which sequence clicks edit */
  editingReturn: boolean;
  history: DraftSnapshot[];
  future: DraftSnapshot[];
}

export type DraftSnapshot = Pick<RouteDraft, 'stops' | 'returnStops' | 'via' | 'kind'>;

export const snapshotOf = (d: RouteDraft): DraftSnapshot => ({ stops: d.stops, returnStops: d.returnStops, via: d.via, kind: d.kind });

interface UIState {
  tool: Tool;
  overlays: { traffic: boolean; demand: boolean; network: boolean; areas: boolean };
  selection: Selection;
  hover: Selection;
  panel: Panel;
  modal: Modal;
  following: string | null;
  draft: RouteDraft | null;
  toast: { id: number; text: string; tone?: 'info' | 'warn' | 'good' | 'bad' } | null;
  setTool: (t: Tool) => void;
  toggleOverlay: (k: keyof UIState['overlays']) => void;
  select: (s: Selection) => void;
  setHover: (s: Selection) => void;
  openPanel: (p: Panel) => void;
  openModal: (m: Modal) => void;
  follow: (id: string | null) => void;
  setDraft: (d: RouteDraft | null) => void;
  /** apply a change to the draft and record it for undo */
  editDraft: (fn: (d: RouteDraft) => Partial<RouteDraft>) => void;
  undoDraft: () => void;
  redoDraft: () => void;
  notify: (text: string, tone?: 'info' | 'warn' | 'good' | 'bad') => void;
  reset: () => void;
}

export const useUI = create<UIState>((set, get) => ({
  tool: 'select',
  overlays: { traffic: false, demand: false, network: false, areas: false },
  selection: null,
  hover: null,
  panel: null,
  modal: null,
  following: null,
  draft: null,
  toast: null,
  setTool: (tool) => {
    const cur = get();
    if (cur.tool === tool) return;
    set({ tool, ...(tool !== 'select' ? { following: null } : {}), ...(tool !== 'route' ? { draft: null } : {}) });
  },
  toggleOverlay: (k) => set({ overlays: { ...get().overlays, [k]: !get().overlays[k] } }),
  select: (selection) => set({ selection, following: selection?.kind === 'vehicle' ? get().following : null }),
  setHover: (hover) => {
    const h = get().hover;
    if (h?.kind === hover?.kind && h?.id === hover?.id) return;
    set({ hover });
  },
  openPanel: (panel) => set({ panel }),
  openModal: (modal) => set({ modal }),
  follow: (following) => set({ following }),
  setDraft: (draft) => set({ draft }),
  editDraft: (fn) => {
    const d = get().draft;
    if (!d) return;
    const patch = fn(d);
    set({ draft: { ...d, ...patch, history: [...d.history.slice(-60), snapshotOf(d)], future: [] } });
  },
  undoDraft: () => {
    const d = get().draft;
    const prev = d?.history[d.history.length - 1];
    if (!d || !prev) return;
    set({ draft: { ...d, ...prev, history: d.history.slice(0, -1), future: [...d.future, snapshotOf(d)] } });
  },
  redoDraft: () => {
    const d = get().draft;
    const next = d?.future[d.future.length - 1];
    if (!d || !next) return;
    set({ draft: { ...d, ...next, history: [...d.history, snapshotOf(d)], future: d.future.slice(0, -1) } });
  },
  notify: (text, tone = 'info') => set({ toast: { id: Date.now() + Math.random(), text, tone } }),
  reset: () => set({ tool: 'select', selection: null, hover: null, panel: null, modal: null, following: null, draft: null }),
}));
