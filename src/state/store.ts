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
  | { kind: 'place'; id: string }
  | null;
export type Panel = 'fleet' | 'finance' | 'lines' | 'company' | 'network' | null;
export type NetworkTab = 'overview' | 'passengers' | 'stops' | 'lines' | 'fleet' | 'reports' | 'automation';

/** A route check (interactive diagnostic) open in the inspector. `route` null = the line being drafted. */
export interface RouteCheckTarget {
  route: string | null;
  /** pattern index (0 outbound / loop, 1 return) */
  pat: number;
  /** leg index: from stop `leg` to stop `leg + 1` of the pattern */
  leg: number;
}

/** Origin–destination flows drawn on the map by Network Control (see src/map/flowsLayer.ts). */
export interface FlowOverlay {
  flows: { id: string; from: LngLat; to: LngLat; value: number; kind: 'observed' | 'estimated'; label: string }[];
  /** the origin (area centroid or stop) the flows start from, drawn as a ring */
  origin?: { at: LngLat; label: string } | null;
  selected?: string | null;
}
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
  /** Network Control: open tab */
  networkTab: NetworkTab;
  /** Automation Studio workspace: open, which workflow, and "peek" (collapsed to show the map) */
  studio: { open: boolean; workflow: string | null; peek: boolean };
  /** interactive route diagnostic open in the inspector */
  routeCheck: RouteCheckTarget | null;
  /** OD flows drawn on the map (null = none) */
  flowOverlay: FlowOverlay | null;
  /** the Network Control unlock card is showing */
  unlockCard: boolean;
  setNetworkTab: (t: NetworkTab) => void;
  setStudio: (s: Partial<UIState['studio']>) => void;
  openRouteCheck: (t: RouteCheckTarget | null) => void;
  setFlowOverlay: (f: FlowOverlay | null) => void;
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
  networkTab: 'overview',
  studio: { open: false, workflow: null, peek: false },
  routeCheck: null,
  flowOverlay: null,
  unlockCard: false,
  setNetworkTab: (networkTab) => set({ networkTab }),
  setStudio: (s) => set({ studio: { ...get().studio, ...s } }),
  openRouteCheck: (routeCheck) => set({ routeCheck }),
  setFlowOverlay: (flowOverlay) => set({ flowOverlay }),
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
  reset: () => set({ tool: 'select', selection: null, hover: null, panel: null, modal: null, following: null, draft: null, studio: { open: false, workflow: null, peek: false }, routeCheck: null, flowOverlay: null, unlockCard: false }),
}));
