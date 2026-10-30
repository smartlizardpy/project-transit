// The editor works on a local draft of the workflow. Undo and redo keep snapshots of the graph
// (nodes, connections, groups); the draft is committed with Save.
import { useCallback, useMemo, useRef, useState } from 'react';
import type { WfEdge, WfGroup, WfNode, Workflow } from '../../game/automation/types.ts';

export interface Snap { nodes: WfNode[]; edges: WfEdge[]; groups: WfGroup[] }
const snapOf = (d: Workflow): Snap => ({ nodes: d.nodes, edges: d.edges, groups: d.groups });

/** What Save writes (the viewport is saved but does not count as a change). */
const content = (d: Workflow) => JSON.stringify([d.name, d.description ?? '', d.mode, d.allowHighImpact, d.limits, d.nodes, d.edges, d.groups]);

export function useDraft(initial: Workflow) {
  const [draft, setDraftState] = useState<Workflow>(() => structuredClone(initial));
  const [baseline, setBaseline] = useState(() => content(initial));
  const [rev, setRev] = useState(0);
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const lastKey = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  const cur = useRef(draft);
  cur.current = draft;
  const [, bump] = useState(0);

  /**
   * Change the draft. `snap`: true pushes an undo step first; a string key does so only if the
   * previous step was not made with the same key a moment ago (typing in a field is one step);
   * false changes nothing in the history (dragging: the step was taken at drag start).
   */
  const update = useCallback((fn: (d: Workflow) => Workflow, snap: boolean | string = true) => {
    const before = cur.current;
    if (snap) {
      const now = performance.now();
      const same = typeof snap === 'string' && lastKey.current.key === snap && now - lastKey.current.at < 1200;
      if (!same) { past.current.push(snapOf(before)); if (past.current.length > 100) past.current.shift(); future.current = []; }
      lastKey.current = { key: typeof snap === 'string' ? snap : '', at: now };
    }
    const next = fn(before);
    cur.current = next;
    setDraftState(next);
    setRev((r) => r + 1);
  }, []);

  /** Take an undo step now (used when a drag starts). */
  const checkpoint = useCallback(() => {
    past.current.push(snapOf(cur.current));
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    lastKey.current = { key: '', at: 0 };
    bump((x) => x + 1);
  }, []);

  const undo = useCallback(() => {
    const s = past.current.pop();
    if (!s) return false;
    future.current.push(snapOf(cur.current));
    cur.current = { ...cur.current, ...s };
    setDraftState(cur.current);
    setRev((r) => r + 1);
    lastKey.current = { key: '', at: 0 };
    return true;
  }, []);
  const redo = useCallback(() => {
    const s = future.current.pop();
    if (!s) return false;
    past.current.push(snapOf(cur.current));
    cur.current = { ...cur.current, ...s };
    setDraftState(cur.current);
    setRev((r) => r + 1);
    lastKey.current = { key: '', at: 0 };
    return true;
  }, []);

  const dirty = useMemo(() => content(draft) !== baseline, [draft, baseline]);
  const markSaved = useCallback(() => setBaseline(content(cur.current)), []);

  return { draft, update, checkpoint, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0, dirty, markSaved, rev };
}
