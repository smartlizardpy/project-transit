// Line editor state helpers: build a draft from a line, edit stop sequences (keeping waypoints
// attached to the right legs), and a live preview computed by the simulation's own routing.

import { create } from 'zustand';
import { session } from '../app/session.ts';
import type { Game, RouteDef } from '../game/engine.ts';
import type { Pattern } from '../game/network.ts';
import type { RunProfile } from '../game/timetable.ts';
import type { LngLat } from '../game/world/graph.ts';
import { useUI, type RouteDraft } from '../state/store.ts';

export function newDraft(game: Game, editing: string | null = null): RouteDraft {
  const r = editing ? game.state.routes[editing] : null;
  return {
    editing,
    number: r?.number ?? game.nextRouteNumber(),
    name: r?.name ?? '',
    colour: r?.colour ?? game.nextRouteColour(),
    kind: r?.kind ?? 'linear',
    stops: r ? [...r.stops] : [],
    returnStops: r?.returnStops ? [...r.returnStops] : null,
    via: r ? structuredClone(r.via) : {},
    editingReturn: false,
    history: [],
    future: [],
  };
}

export function draftDef(d: RouteDraft): RouteDef {
  return {
    number: d.number,
    name: d.name,
    colour: d.colour,
    kind: d.kind,
    stops: d.stops,
    returnStops: d.kind === 'linear' && d.returnStops && d.returnStops.length >= 2 ? d.returnStops : null,
    via: d.via,
  };
}

/** Insert or remove a stop and shift the waypoint keys of the affected direction. */
function remapVia(via: Record<string, LngLat[]>, dir: 'o' | 'r', fn: (i: number) => number | null): Record<string, LngLat[]> {
  const out: Record<string, LngLat[]> = {};
  for (const [k, v] of Object.entries(via)) {
    const [d, n] = k.split(':');
    if (d !== dir) {
      out[k] = v;
      continue;
    }
    const m = fn(Number(n));
    if (m !== null) out[`${d}:${m}`] = v;
  }
  return out;
}

/** Sequence being edited (outbound or custom return). */
export function activeSeq(d: RouteDraft): string[] {
  return d.editingReturn && d.returnStops ? d.returnStops : d.stops;
}

function withSeq(d: RouteDraft, seq: string[], via: Record<string, LngLat[]>): Partial<RouteDraft> {
  return d.editingReturn && d.returnStops ? { returnStops: seq, via } : { stops: seq, via };
}

export function appendStop(d: RouteDraft, id: string): Partial<RouteDraft> | string {
  const seq = activeSeq(d);
  if (seq[seq.length - 1] === id) return 'That stop is already the last one.';
  if (seq.includes(id)) {
    if (d.kind === 'loop' && seq[0] === id) return 'A loop returns to its first stop automatically.';
    return 'Each stop can only appear once per direction.';
  }
  return withSeq(d, [...seq, id], d.via);
}

export function removeStopAt(d: RouteDraft, i: number): Partial<RouteDraft> {
  const seq = activeSeq(d);
  const dir = d.editingReturn && d.returnStops ? 'r' : 'o';
  // the legs into and out of the removed stop merge; their waypoints are dropped
  const via = remapVia(d.via, dir, (n) => (n === i || n === i - 1 ? null : n > i ? n - 1 : n));
  return withSeq(d, seq.filter((_, k) => k !== i), via);
}

export function moveStop(d: RouteDraft, i: number, delta: -1 | 1): Partial<RouteDraft> | null {
  const seq = [...activeSeq(d)];
  const j = i + delta;
  if (j < 0 || j >= seq.length) return null;
  [seq[i], seq[j]] = [seq[j], seq[i]];
  const dir = d.editingReturn && d.returnStops ? 'r' : 'o';
  const lo = Math.min(i, j);
  const via = remapVia(d.via, dir, (n) => (n >= lo - 1 && n <= lo + 1 ? null : n));
  return withSeq(d, seq, via);
}

export function addWaypoint(d: RouteDraft, key: string, at: LngLat): Partial<RouteDraft> {
  const list = d.via[key] ? [...d.via[key], at] : [at];
  return { via: { ...d.via, [key]: list.slice(-4) } };
}

// ─────────────────────────────────────────── live preview

export interface DraftPreview {
  rev: number;
  patterns: Pattern[];
  profiles: RunProfile[];
  problems: string[];
  warnings: string[];
  /** km per direction */
  lengths: number[];
  /** typical one-way run time now (minutes), per direction */
  minutes: number[];
}

export const useDraftPreview = create<{ preview: DraftPreview | null }>(() => ({ preview: null }));

let rev = 0;
export function computePreview(d: RouteDraft | null) {
  const game = session.game;
  if (!game || !d) {
    useDraftPreview.setState({ preview: null });
    return null;
  }
  const res = game.previewRoute(draftDef(d), d.editing ?? undefined);
  const weekend = game.isWeekend(game.t) ? 1 : 0;
  const hour = Math.floor((game.t % 86400) / 3600);
  const preview: DraftPreview = {
    rev: ++rev,
    patterns: res.patterns,
    profiles: res.profiles,
    problems: res.problems,
    warnings: res.warnings,
    lengths: res.patterns.map((p) => (p.valid ? p.path.length / 1000 : 0)),
    minutes: res.profiles.map((pr) => (pr.total[weekend]?.[hour] ?? 0) / 60),
  };
  useDraftPreview.setState({ preview });
  return preview;
}

export function startDrafting(editing: string | null = null) {
  const game = session.game;
  if (!game) return;
  const ui = useUI.getState();
  ui.setTool('route');
  ui.setDraft(newDraft(game, editing));
  ui.select(null);
}

/** Save the draft: create a new line or update the edited one. */
export function commitDraft(): boolean {
  const game = session.game;
  const ui = useUI.getState();
  const d = ui.draft;
  if (!game || !d) return false;
  const def = draftDef(d);
  if (d.editing) {
    const res = game.updateRoute(d.editing, def);
    if (!res.ok) {
      ui.notify(res.error, 'bad');
      return false;
    }
    ui.notify(`Line ${d.number} updated. Buses on it will finish at the next stop and follow the new route.`, 'good');
    const id = d.editing;
    ui.setTool('select');
    ui.select({ kind: 'line', id });
    return true;
  }
  const res = game.createRoute(def);
  if (!res.ok) {
    ui.notify(res.error, 'bad');
    return false;
  }
  ui.setTool('select');
  ui.select({ kind: 'line', id: res.value });
  const buses = Object.values(game.state.vehicles).length;
  ui.notify(buses ? `Line ${d.number} registered. Assign buses to it to start service.` : `Line ${d.number} registered. Buy a bus in the Fleet panel, then assign it to the line.`, 'good');
  return true;
}
