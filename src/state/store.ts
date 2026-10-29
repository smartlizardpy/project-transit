import { create } from 'zustand';

export type Tool = 'select' | 'route';
export type Selection =
  | { kind: 'vehicle'; id: string }
  | { kind: 'line'; id: string }
  | { kind: 'stop'; id: string }
  | null;
export type Panel = 'fleet' | 'finance' | 'lines' | null;

/** A real bus stop picked for a new line, with the road node buses halt at. */
export interface DraftStop {
  name: string;
  node: number;
  lngLat: [number, number];
  stopId: string;
}

export interface RouteDraft {
  colour: string;
  number: string;
  stops: DraftStop[];
  path: [number, number][];
  length: number;
  history: DraftStop[][];
  future: DraftStop[][];
}

interface UIState {
  tool: Tool;
  overlays: { traffic: boolean; demand: boolean; network: boolean };
  selection: Selection;
  hover: Selection;
  panel: Panel;
  following: string | null;
  draft: RouteDraft | null;
  toast: { id: number; text: string; tone?: 'info' | 'warn' | 'good' } | null;
  setTool: (t: Tool) => void;
  toggleOverlay: (k: keyof UIState['overlays']) => void;
  select: (s: Selection) => void;
  setHover: (s: Selection) => void;
  openPanel: (p: Panel) => void;
  follow: (id: string | null) => void;
  setDraft: (d: RouteDraft | null) => void;
  notify: (text: string, tone?: 'info' | 'warn' | 'good') => void;
}

export const useUI = create<UIState>((set, get) => ({
  tool: 'select',
  overlays: { traffic: false, demand: false, network: false },
  selection: null,
  hover: null,
  panel: null,
  following: null,
  draft: null,
  toast: null,
  setTool: (tool) => set({ tool, ...(tool !== 'select' ? { selection: null, following: null } : {}) }),
  toggleOverlay: (k) => set({ overlays: { ...get().overlays, [k]: !get().overlays[k] } }),
  select: (selection) => set({ selection, following: selection?.kind === 'vehicle' ? get().following : null }),
  setHover: (hover) => {
    const h = get().hover;
    if (h?.kind === hover?.kind && h?.id === hover?.id) return;
    set({ hover });
  },
  openPanel: (panel) => set({ panel }),
  follow: (following) => set({ following }),
  setDraft: (draft) => set({ draft }),
  notify: (text, tone = 'info') => set({ toast: { id: Date.now(), text, tone } }),
}));
