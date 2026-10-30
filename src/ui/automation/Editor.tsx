// The editor for one workflow: library, canvas, inspector, test panel, history and Lab.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, useReactFlow, applyEdgeChanges, type Node, type Edge, type NodeChange, type EdgeChange, type Connection,
  type FinalConnectionState, SelectionMode, Background, BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import {
  ArrowUUpLeft, ArrowUUpRight, FloppyDisk, Flask, CaretLeft, X, Copy, Trash, SquaresFour,
  Plus, Minus, CornersOut, Eye, EyeSlash, PlayCircle,
} from '@phosphor-icons/react';
import type { Game } from '../../game/engine.ts';
import type { NodeTrace, RunRecord, WfEdge, WfGroup, WfNode, Workflow } from '../../game/automation/types.ts';
import { NODE, defaultConfig } from '../../game/automation/registry.ts';
import { validateWorkflow, connectionProblem } from '../../game/automation/validate.ts';
import { Segmented } from '../primitives.tsx';
import { useUI } from '../../state/store.ts';
import { useDraft } from './draft.ts';
import { StNode, StGroup, type StNodeData } from './Nodes.tsx';
import { Library } from './Library.tsx';
import { NodeInspector, GroupInspector, WorkflowInspector } from './Inspector.tsx';
import { RunList, TraceList, ActionList } from './Runs.tsx';
import { Lab } from './Lab.tsx';
import { IssueIcon, MODE_INFO, ModeTag, nodeTitle, whenLabel } from './common.tsx';

const nodeTypes = { stNode: StNode, stGroup: StGroup };
const NODE_W = 212;
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};
const sameEdge = (wf: Workflow, e: Omit<WfEdge, 'id'>) => wf.edges.some((x) => x.from === e.from && x.out === e.out && x.to === e.to && x.in === e.in);
const problemOf = (wf: Workflow, e: Omit<WfEdge, 'id'>) => (sameEdge(wf, e) ? 'These two are already connected.' : connectionProblem(wf, e));
const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

type View = 'edit' | 'history' | 'lab';
type Ask = { title: string; body: string; actions: { label: string; kind?: 'primary' | 'danger'; run: () => void }[] } | null;

export function Editor(props: { game: Game; wfId: string; onLeave: () => void; onDirty: (d: boolean) => void }) {
  return <ReactFlowProvider><EditorInner {...props} /></ReactFlowProvider>;
}

function EditorInner({ game, wfId, onLeave, onDirty }: { game: Game; wfId: string; onLeave: () => void; onDirty: (d: boolean) => void }) {
  const saved = game.state.automation.workflows[wfId];
  const rf = useReactFlow();
  const peek = useUI((s) => s.studio.peek);
  const { draft, update, checkpoint, undo, redo, canUndo, canRedo, dirty, markSaved, rev } = useDraft(saved);
  const [view, setView] = useState<View>('edit');
  const [sel, setSel] = useState<string[]>([]);
  const [selEdges, setSelEdges] = useState<string[]>([]);
  const [dims, setDims] = useState<Record<string, { width: number; height: number }>>({});
  const [test, setTest] = useState<{ run: RunRecord; rev: number; live: boolean } | null>(null);
  const [trigger, setTrigger] = useState<string | undefined>();
  const [hint, setHint] = useState<{ text: string; tone: 'bad' | 'info' } | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [ask, setAsk] = useState<Ask>(null);
  const [runOpen, setRunOpen] = useState(true);
  // the results panel takes the bottom of the canvas: re-fit once it opens so no node hides under it
  const panelShown = !!test && runOpen;
  useEffect(() => {
    if (!panelShown) return;
    // after React Flow has measured the smaller canvas (its resize observer runs after layout)
    const id = window.setTimeout(() => rf.fitView({ padding: 0.15, maxZoom: 1, duration: 250 }), 120);
    return () => window.clearTimeout(id);
  }, [panelShown, rf]);
  const [pick, setPick] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const vp = useRef(saved.viewport);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const hintTimer = useRef(0);

  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const say = useCallback((text: string, tone: 'bad' | 'info' = 'info') => {
    setHint({ text, tone });
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), tone === 'bad' ? 4200 : 2200);
  }, []);

  const validation = useMemo(() => validateWorkflow(draft, game.state), [draft, game]);
  const errors = validation.issues.filter((i) => i.level === 'error');
  const warnings = validation.issues.filter((i) => i.level === 'warning');
  const issueOf = useMemo(() => {
    const m = new Map<string, 'error' | 'warning'>();
    for (const i of validation.issues) if (i.node && m.get(i.node) !== 'error') m.set(i.node, i.level);
    return m;
  }, [validation]);

  const fresh = !!test && test.rev === rev;
  const traces = useMemo(() => {
    const m = new Map<string, NodeTrace>();
    if (fresh) for (const t of test!.run.trace ?? []) m.set(t.node, t);
    return m;
  }, [fresh, test]);

  // ── canvas model
  const rfNodes = useMemo<Node[]>(() => {
    const groups: Node[] = draft.groups.map((g) => ({
      id: `g:${g.id}`, type: 'stGroup', position: { x: g.x, y: g.y }, width: g.w, height: g.h, zIndex: -1,
      selected: sel.includes(`g:${g.id}`), data: { group: g, onResize: (id: string, x: number, y: number, w: number, h: number) => update((d) => ({ ...d, groups: d.groups.map((q) => (q.id === id ? { ...q, x, y, w, h } : q)) })) },
    }));
    const wired = new Map<string, Set<string>>();
    for (const e of draft.edges) (wired.get(e.to) ?? wired.set(e.to, new Set()).get(e.to)!).add(e.in);
    const nodes: Node[] = draft.nodes.map((n) => ({
      id: n.id, type: 'stNode', position: { x: n.x, y: n.y }, selected: sel.includes(n.id), measured: dims[n.id],
      data: { node: n, game, trace: traces.get(n.id), issue: issueOf.get(n.id), ran: fresh, wired: wired.get(n.id) } satisfies StNodeData,
    }));
    return [...groups, ...nodes];
  }, [draft.nodes, draft.edges, draft.groups, sel, dims, traces, issueOf, fresh, game, update]);

  const rfEdges = useMemo<Edge[]>(() => draft.edges.map((e) => {
    let cls = '';
    if (fresh) {
      const a = traces.get(e.from), b = traces.get(e.to);
      cls = a?.status === 'ok' && b && b.status !== 'inactive' ? (b.status === 'error' ? 'bad' : 'live') : 'dim';
    }
    return { id: e.id, source: e.from, sourceHandle: e.out, target: e.to, targetHandle: e.in, selected: selEdges.includes(e.id), className: cls, type: 'default' };
  }), [draft.edges, selEdges, fresh, traces]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    let nd: Record<string, { width: number; height: number }> | null = null;
    const moves = new Map<string, { x: number; y: number }>();
    let selNext: Set<string> | null = null;
    for (const c of changes) {
      if (c.type === 'dimensions' && c.dimensions && !c.id.startsWith('g:')) (nd ??= {})[c.id] = { width: c.dimensions.width, height: c.dimensions.height };
      else if (c.type === 'position' && c.position) moves.set(c.id, c.position);
      else if (c.type === 'select') { selNext ??= new Set(sel); if (c.selected) selNext.add(c.id); else selNext.delete(c.id); }
    }
    if (nd) setDims((d) => { const n = { ...d }; let ch = false; for (const [k, v] of Object.entries(nd!)) if (!d[k] || d[k].width !== v.width || d[k].height !== v.height) { n[k] = v; ch = true; } return ch ? n : d; });
    if (selNext) setSel([...selNext]);
    if (moves.size) {
      update((d) => {
        const shift = new Map<string, { dx: number; dy: number }>();
        const groups = d.groups.map((g) => {
          const m = moves.get(`g:${g.id}`);
          if (!m) return g;
          shift.set(g.id, { dx: m.x - g.x, dy: m.y - g.y });
          return { ...g, x: m.x, y: m.y };
        });
        const nodes = d.nodes.map((n) => {
          const m = moves.get(n.id);
          if (m) return { ...n, x: m.x, y: m.y };
          const s = n.group ? shift.get(n.group) : undefined;
          return s ? { ...n, x: n.x + s.dx, y: n.y + s.dy } : n;
        });
        return { ...d, nodes, groups };
      }, false);
    }
  }, [sel, update]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const next = applyEdgeChanges(changes, rfEdges.map((e) => ({ ...e })));
    const s = next.filter((e) => e.selected).map((e) => e.id);
    setSelEdges((cur) => (cur.length === s.length && cur.every((x) => s.includes(x)) ? cur : s));
  }, [rfEdges]);

  // ── editing operations
  const patchNode = useCallback((id: string, fn: (n: WfNode) => WfNode, snap: boolean | string = true) => update((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? fn(n) : n)) }), snap), [update]);

  const addNode = useCallback((type: string, at?: { x: number; y: number }) => {
    const def = NODE[type];
    if (!def) return;
    let pos = at;
    if (!pos) {
      const r = canvasRef.current?.getBoundingClientRect();
      const c = r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 100, y: 100 };
      const k = draftRef.current.nodes.length % 6;
      pos = { x: c.x - NODE_W / 2 + k * 28, y: c.y - 50 + k * 28 };
    }
    const id = game.newNodeId();
    update((d) => ({ ...d, nodes: [...d.nodes, { id, type, x: Math.round(pos!.x), y: Math.round(pos!.y), config: defaultConfig(type) }] }));
    setSel([id]); setSelEdges([]);
  }, [game, rf, update]);

  const removeSelected = useCallback(() => {
    const nodeIds = new Set(sel.filter((s) => !s.startsWith('g:')));
    const groupIds = new Set(sel.filter((s) => s.startsWith('g:')).map((s) => s.slice(2)));
    if (!nodeIds.size && !groupIds.size && !selEdges.length) return;
    update((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => !nodeIds.has(n.id)).map((n) => (n.group && groupIds.has(n.group) ? { ...n, group: undefined } : n)),
      edges: d.edges.filter((e) => !nodeIds.has(e.from) && !nodeIds.has(e.to) && !selEdges.includes(e.id)),
      groups: d.groups.filter((g) => !groupIds.has(g.id)),
    }));
    setSel([]); setSelEdges([]);
  }, [sel, selEdges, update]);

  const duplicate = useCallback(() => {
    const ids = new Set(sel.filter((s) => !s.startsWith('g:')));
    const src = draftRef.current.nodes.filter((n) => ids.has(n.id));
    if (!src.length) return;
    const map = new Map<string, string>();
    const copies: WfNode[] = src.map((n) => { const id = game.newNodeId(); map.set(n.id, id); return { ...structuredClone(n), id, x: n.x + 40, y: n.y + 40, group: undefined }; });
    const edges: WfEdge[] = draftRef.current.edges.filter((e) => map.has(e.from) && map.has(e.to)).map((e) => ({ ...e, id: uid('e'), from: map.get(e.from)!, to: map.get(e.to)! }));
    update((d) => ({ ...d, nodes: [...d.nodes, ...copies], edges: [...d.edges, ...edges] }));
    setSel(copies.map((c) => c.id)); setSelEdges([]);
  }, [sel, game, update]);

  const groupSelected = useCallback(() => {
    const ids = sel.filter((s) => !s.startsWith('g:'));
    const ns = draftRef.current.nodes.filter((n) => ids.includes(n.id));
    if (!ns.length) return;
    const x0 = Math.min(...ns.map((n) => n.x)) - 24, y0 = Math.min(...ns.map((n) => n.y)) - 40;
    const x1 = Math.max(...ns.map((n) => n.x + NODE_W)) + 24, y1 = Math.max(...ns.map((n) => n.y + (dims[n.id]?.height ?? 110))) + 24;
    const g: WfGroup = { id: uid('grp'), label: 'Group', x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    update((d) => ({ ...d, groups: [...d.groups, g], nodes: d.nodes.map((n) => (ids.includes(n.id) ? { ...n, group: g.id } : n)) }));
    setSel([`g:${g.id}`]);
  }, [sel, dims, update]);

  const ungroup = useCallback((gid: string) => {
    update((d) => ({ ...d, groups: d.groups.filter((g) => g.id !== gid), nodes: d.nodes.map((n) => (n.group === gid ? { ...n, group: undefined } : n)) }));
    setSel([]);
  }, [update]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
    const e = { from: c.source, out: c.sourceHandle, to: c.target, in: c.targetHandle };
    const why = problemOf(draftRef.current, e);
    if (why) { say(why, 'bad'); return; }
    update((d) => ({ ...d, edges: [...d.edges, { id: uid('e'), ...e }] }));
  }, [say, update]);

  const isValid = useCallback((c: Connection | Edge) => {
    if (!c.sourceHandle || !c.targetHandle) return false;
    return problemOf(draftRef.current, { from: c.source, out: c.sourceHandle, to: c.target, in: c.targetHandle }) === null;
  }, []);

  const onConnectEnd = useCallback((_: unknown, s: FinalConnectionState) => {
    if (s.isValid !== false || !s.fromHandle || !s.toHandle || !s.fromNode || !s.toNode) return;
    const a = s.fromHandle.type === 'source' ? { n: s.fromNode.id, h: s.fromHandle.id } : { n: s.toNode.id, h: s.toHandle.id };
    const b = s.fromHandle.type === 'source' ? { n: s.toNode.id, h: s.toHandle.id } : { n: s.fromNode.id, h: s.fromHandle.id };
    if (s.fromHandle.type === s.toHandle.type) { say('Connect an output (right side) to an input (left side).', 'bad'); return; }
    const why = problemOf(draftRef.current, { from: a.n, out: a.h ?? '', to: b.n, in: b.h ?? '' });
    if (why) say(why, 'bad');
  }, [say]);

  const onNodeDragStop = useCallback((_: unknown, __: Node, nodes: Node[]) => {
    const moved = new Set(nodes.filter((n) => !n.id.startsWith('g:')).map((n) => n.id));
    if (!moved.size) return;
    update((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        if (!moved.has(n.id)) return n;
        const cx = n.x + NODE_W / 2, cy = n.y + (dims[n.id]?.height ?? 110) / 2;
        const g = d.groups.find((q) => cx >= q.x && cx <= q.x + q.w && cy >= q.y && cy <= q.y + q.h);
        return g?.id === n.group ? n : { ...n, group: g?.id };
      }),
    }), false);
  }, [dims, update]);

  const onDrop = useCallback((e: React.DragEvent) => {
    const type = e.dataTransfer.getData('application/pt-node');
    if (!type) return;
    e.preventDefault();
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNode(type, { x: p.x - NODE_W / 2, y: p.y - 20 });
  }, [addNode, rf]);

  // ── tests, save, run
  const triggers = draft.nodes.filter((n) => !n.disabled && NODE[n.type]?.trigger);
  const runTest = useCallback((trig?: string) => {
    const t = trig ?? trigger;
    setTrigger(t);
    const run = game.testWorkflowDraft(draftRef.current, t);
    setTest({ run, rev: rev, live: false });
    setRunOpen(true); setPick(null);
    if (view !== 'edit') setView('edit');
  }, [game, trigger, rev, view]);

  const doSave = useCallback((): boolean => {
    const d = draftRef.current;
    const r = game.updateWorkflow(wfId, { name: d.name, description: d.description ?? '', nodes: d.nodes, edges: d.edges, groups: d.groups, viewport: vp.current ?? d.viewport, mode: d.mode, allowHighImpact: d.allowHighImpact, limits: d.limits });
    if (!r.ok) { say(r.error, 'bad'); return false; }
    markSaved();
    say(errors.length ? 'Saved. It will not run until the problems are fixed.' : 'Saved.');
    return true;
  }, [game, wfId, markSaved, say, errors.length]);

  const runNow = useCallback(() => {
    const go = () => {
      const r = game.runWorkflowNow(wfId, { test: false, node: trigger });
      if (!r.ok) { say(r.error, 'bad'); return; }
      setTest({ run: r.value, rev, live: true }); setRunOpen(true);
    };
    if (saved.mode === 'observe') go();
    else setAsk({ title: 'Run it now?', body: `This is not a test. In ${MODE_INFO[saved.mode].label} mode it ${saved.mode === 'suggest' ? 'creates suggestions you can approve' : 'acts on the game, with the usual rules'}.`, actions: [{ label: 'Run now', kind: 'primary', run: go }] });
  }, [game, wfId, trigger, rev, saved.mode, say]);

  const requestLeave = useCallback((then: () => void) => {
    if (!dirty) { then(); return; }
    setAsk({ title: 'Discard your changes?', body: 'This workflow has changes that are not saved yet.', actions: [
      { label: 'Save and close', kind: 'primary', run: () => { if (doSave()) then(); } },
      { label: 'Discard changes', kind: 'danger', run: then },
    ] });
  }, [dirty, doSave]);

  // ── keyboard
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (useUI.getState().studio.peek) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (ask) { if (e.key === 'Escape') setAsk(null); return; }
      if (mod && k === 's') { e.preventDefault(); doSave(); return; }
      if (isTyping(e.target)) return;
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); redo(); return; }
      if (mod && k === 'd') { e.preventDefault(); duplicate(); return; }
      if (mod && k === 'a') { e.preventDefault(); setSel(draftRef.current.nodes.map((n) => n.id)); return; }
      if (mod && k === 'g') { e.preventDefault(); groupSelected(); return; }
      if (mod && k === 'k') { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); return; }
      if (e.key === 'Escape') { setSel([]); setSelEdges([]); setIssuesOpen(false); }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [ask, doSave, undo, redo, duplicate, groupSelected, removeSelected]);

  // ── inspector
  const single = sel.length === 1 ? sel[0] : null;
  const selNode = single && !single.startsWith('g:') ? draft.nodes.find((n) => n.id === single) : null;
  const selGroup = single?.startsWith('g:') ? draft.groups.find((g) => g.id === single.slice(2)) : null;
  const edgesIn = useMemo(() => new Set(draft.edges.filter((e) => e.to === selNode?.id).map((e) => e.in)), [draft.edges, selNode]);
  const wfSetter = useCallback((fn: (d: Workflow) => Workflow, key: string) => update(fn, key), [update]);

  const focusNode = (id: string) => { setSel([id]); const n = draftRef.current.nodes.find((x) => x.id === id); if (n) rf.setCenter(n.x + NODE_W / 2, n.y + 60, { zoom: Math.max(rf.getZoom(), 0.9), duration: 300 }); };

  const empty = draft.nodes.length === 0;
  const hasTrace = !!test;
  const lastRuns = game.state.automation.runs.filter((r) => r.wf === wfId).sort((a, b) => b.t - a.t || b.id - a.id);
  const canRun = !dirty && validation.ok && draft.kind === 'workflow';

  return (
    <>
      <div className="st-top">
        <button className="btn sm" onClick={() => requestLeave(onLeave)} title="All workflows"><CaretLeft size={13} weight="bold" /><span className="t">Workflows</span></button>
        <div className="st-title">
          <input value={draft.name} maxLength={60} aria-label="Workflow name" onChange={(e) => update((d) => ({ ...d, name: e.target.value }), 'name')} />
          <small>
            {draft.kind === 'function' ? 'Function' : <ModeTag mode={draft.mode} />}
            {draft.kind === 'workflow' && <span>{saved.enabled ? 'Switched on' : 'Switched off'}</span>}
            {dirty ? <span className="st-dirty">Unsaved changes</span> : <span>All changes saved</span>}
          </small>
        </div>
        <span className="grow" />
        <Segmented<View> value={view} onChange={setView} options={[{ value: 'edit', label: 'Editor' }, { value: 'history', label: 'History' }, { value: 'lab', label: 'Simulation Lab', disabled: draft.kind !== 'workflow' }]} />
        <span className="st-sep" />
        <button className="icon-btn" disabled={!canUndo} onClick={undo} aria-label="Undo" title="Undo (Ctrl/Cmd+Z)"><ArrowUUpLeft size={17} weight="bold" /></button>
        <button className="icon-btn" disabled={!canRedo} onClick={redo} aria-label="Redo" title="Redo (Shift+Ctrl/Cmd+Z)"><ArrowUUpRight size={17} weight="bold" /></button>
        <div className="st-popwrap">
          <button className={`st-issuebtn ${errors.length ? 'bad' : warnings.length ? 'warn' : 'good'}`} onClick={() => { setHint(null); setIssuesOpen(!issuesOpen); }} aria-expanded={issuesOpen}>
            <IssueIcon level={errors.length ? 'error' : warnings.length ? 'warning' : 'ok'} />
            {errors.length ? `${errors.length} problem${errors.length === 1 ? '' : 's'}` : warnings.length ? `${warnings.length} to check` : 'No problems'}
          </button>
          {issuesOpen && (
            <div className="st-pop">
              {validation.issues.length === 0 && <div className="pn-note" style={{ padding: 8 }}>Everything is connected and every setting is valid.</div>}
              {validation.issues.map((i, k) => (
                <button key={k} className={`st-issue ${i.level}`} onClick={() => { if (i.node) { setView('edit'); focusNode(i.node); } setIssuesOpen(false); }}>
                  <IssueIcon level={i.level} /><span>{i.message}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {draft.kind === 'workflow' && (
          <>
            <button className="btn sm" onClick={() => runTest()} title="Run the draft without changing anything"><Flask size={14} weight="bold" /><span className="t">Test</span></button>
            <button className="btn sm" disabled={!canRun} onClick={runNow} title={canRun ? 'Run the saved workflow now, for real' : dirty ? 'Save first: Run now uses the saved workflow' : 'Fix the problems first'}><PlayCircle size={14} weight="bold" /><span className="t">Run now</span></button>
          </>
        )}
        <button className="btn sm primary" disabled={!dirty} onClick={doSave} title="Save (Ctrl/Cmd+S)"><FloppyDisk size={14} weight="bold" /><span className="t">Save</span></button>
        <button className={`icon-btn ${peek ? 'on' : ''}`} onClick={() => useUI.getState().setStudio({ peek: !peek })} aria-label={peek ? 'Show the workspace' : 'Show the map'} title={peek ? 'Show the workspace' : 'Peek at the map'}>{peek ? <EyeSlash size={17} weight="bold" /> : <Eye size={17} weight="bold" />}</button>
        <button className="icon-btn" onClick={() => requestLeave(() => useUI.getState().setStudio({ open: false }))} aria-label="Close Automation Studio"><X size={17} weight="bold" /></button>
      </div>

      {view === 'edit' && (
        <>
          <div className="st-body">
            <Library kind={draft.kind} onAdd={(t) => addNode(t)} searchRef={searchRef} />
            <div className="st-canvas" ref={canvasRef} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={onDrop}>
              <ReactFlow
                nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes}
                onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onConnectEnd={onConnectEnd} isValidConnection={isValid}
                onNodeDragStart={() => checkpoint()} onNodeDragStop={onNodeDragStop}
                onMoveEnd={(_e, v) => { vp.current = v; }}
                defaultViewport={vp.current} fitView={!vp.current} fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                minZoom={0.2} maxZoom={1.8} deleteKeyCode={null} selectionKeyCode="Shift" multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
                selectionMode={SelectionMode.Partial} zoomOnDoubleClick={false} snapToGrid snapGrid={[12, 12]} proOptions={{ hideAttribution: true }}
                onPaneClick={() => { setSel([]); setSelEdges([]); setIssuesOpen(false); }}
              ><Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="#2a3430" /></ReactFlow>
              {empty && <div className="st-empty-canvas"><div><b>An empty canvas</b>Add a trigger from the library on the left to decide when this runs, then connect what it should look at and do.</div></div>}
              {hint && <div className={`st-hintbar ${hint.tone}`} role="status">{hint.text}</div>}
              <div className="st-ctrls">
                <button className="icon-btn" onClick={() => rf.zoomIn({ duration: 150 })} aria-label="Zoom in"><Plus size={16} weight="bold" /></button>
                <button className="icon-btn" onClick={() => rf.zoomOut({ duration: 150 })} aria-label="Zoom out"><Minus size={16} weight="bold" /></button>
                <button className="icon-btn" onClick={() => rf.fitView({ padding: 0.2, maxZoom: 1, duration: 250 })} aria-label="Fit to screen" title="Fit to screen"><CornersOut size={16} weight="bold" /></button>
              </div>
            </div>
            <div className="st-side right">
              <div className="st-scroll">
                {selNode ? (
                  <NodeInspector game={game} node={selNode} edgesIn={edgesIn} trace={traces.get(selNode.id)} stale={hasTrace && !fresh}
                    issues={validation.issues.filter((i) => i.node === selNode.id)}
                    onConfig={(k, v) => patchNode(selNode.id, (n) => ({ ...n, config: { ...n.config, [k]: v } }), `cfg-${selNode.id}-${k}`)}
                    onLabel={(v) => patchNode(selNode.id, (n) => ({ ...n, label: v }), `lbl-${selNode.id}`)}
                    onDisabled={(v) => patchNode(selNode.id, (n) => ({ ...n, disabled: v || undefined }))}
                    onDuplicate={duplicate} onDelete={removeSelected} />
                ) : selGroup ? (
                  <GroupInspector group={selGroup} count={draft.nodes.filter((n) => n.group === selGroup.id).length}
                    onLabel={(v) => update((d) => ({ ...d, groups: d.groups.map((g) => (g.id === selGroup.id ? { ...g, label: v } : g)) }), `grp-${selGroup.id}`)} onUngroup={() => ungroup(selGroup.id)} />
                ) : sel.length > 1 ? (
                  <div className="st-pad"><div className="st-sec">
                    <h4>{sel.length} selected</h4>
                    <div className="st-help">Drag any of them to move them together. Shift-drag on the canvas selects a box; Shift-click adds one.</div>
                    <div className="pn-actions">
                      <button className="btn sm" onClick={duplicate}><Copy size={13} weight="bold" />Duplicate</button>
                      <button className="btn sm" onClick={groupSelected}><SquaresFour size={13} weight="bold" />Group</button>
                      <button className="btn sm danger" onClick={removeSelected}><Trash size={13} weight="bold" />Delete</button>
                    </div>
                  </div></div>
                ) : (
                  <WorkflowInspector game={game} wf={saved} draft={draft} setDraft={wfSetter}
                    onEnabled={(v) => { const r = game.updateWorkflow(wfId, { enabled: v }); if (!r.ok) say(r.error, 'bad'); else if (v && !validation.ok) say('Switched on, but it cannot run until the problems are fixed.', 'bad'); }}
                    onClearMemory={() => { game.clearWorkflowMemory(wfId); say('Memory cleared.'); }} />
                )}
              </div>
              {selNode && <div className="st-hint">Ctrl/Cmd+D duplicates · Delete removes · Ctrl/Cmd+G groups</div>}
            </div>
          </div>

          {hasTrace && runOpen && (
            <RunPanel game={game} test={test!} fresh={fresh} triggers={triggers} trigger={trigger} onTrigger={(t) => runTest(t)} onClose={() => setRunOpen(false)} onRetest={() => runTest()} pick={pick}
              onPick={(id) => { setPick(id); focusNode(id); }} wf={draft} />
          )}
        </>
      )}

      {view === 'history' && (
        <div className="st-view"><div className="st-view-inner">
          <h3>History · {draft.name}</h3>
          <div className="pn-note">Every time this workflow ran, newest first. Open a run to see what each node did. Detailed traces are kept for its latest 3 runs.</div>
          {lastRuns.length === 0 ? <div className="pn-empty">It has not run yet. {saved.enabled ? 'It will appear here the first time its trigger fires.' : 'It is switched off. Switch it on in the workflow settings, or press Run now.'}</div> : <RunList game={game} runs={lastRuns} />}
        </div></div>
      )}
      {view === 'lab' && <Lab game={game} wf={saved} saved={!dirty} />}

      {ask && (
        <div className="st-confirm-scrim" onClick={() => setAsk(null)}>
          <div className="st-confirm" role="dialog" aria-label={ask.title} onClick={(e) => e.stopPropagation()}>
            <b>{ask.title}</b><div className="pn-note">{ask.body}</div>
            <div className="pn-actions">
              <button className="btn" onClick={() => setAsk(null)}>Keep editing</button>
              {ask.actions.map((a) => <button key={a.label} className={`btn ${a.kind ?? ''}`} onClick={() => { setAsk(null); a.run(); }}>{a.label}</button>)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RunPanel({ game, test, fresh, triggers, trigger, onTrigger, onClose, onRetest, pick, onPick, wf }: {
  game: Game; test: { run: RunRecord; live: boolean }; fresh: boolean; triggers: WfNode[]; trigger?: string;
  onTrigger: (id: string) => void; onClose: () => void; onRetest: () => void; pick: string | null; onPick: (id: string) => void; wf: Workflow;
}) {
  const run = test.run;
  const hasEvent = triggers.some((t) => t.type !== 'trigger.manual' && t.type !== 'trigger.every' && t.type !== 'trigger.time');
  return (
    <div className="st-run">
      <div className="st-run-head">
        <b>{test.live ? 'Run now' : 'Test'}</b>
        <span className={`pn-tag ${run.status === 'ok' ? 'good' : run.status === 'error' ? 'bad' : 'warn'}`}>{run.status === 'ok' ? 'Ran' : run.status === 'error' ? 'Failed' : 'Limit reached'}</span>
        <span className="pn-note">{run.triggerLabel} · {run.evaluated} node{run.evaluated === 1 ? '' : 's'} evaluated · {whenLabel(run.t)}</span>
        <span style={{ flex: 1 }} />
        {triggers.length > 1 && (
          <label className="pn-note">Start from{' '}
            <select className="pn-select" value={run.trigger || trigger || triggers[0]?.id} onChange={(e) => onTrigger(e.target.value)}>
              {triggers.map((t) => <option key={t.id} value={t.id}>{nodeTitle(t)}</option>)}
            </select>
          </label>
        )}
        {!fresh && <><span className="pn-tag warn">Edited since</span><button className="btn sm" onClick={onRetest}>Test again</button></>}
        <button className="icon-btn" onClick={onClose} aria-label="Close the results"><X size={15} weight="bold" /></button>
      </div>
      {(run.test || hasEvent) && (
        <div className="pn-note" style={{ padding: '0 12px 8px' }}>
          {run.test ? 'Test run: nothing was changed. ' : ''}{hasEvent ? 'An event trigger is tested with a sample event built from the current game, such as a bus on the chosen line and its next stop.' : ''}
        </div>
      )}
      {run.error && <div className="pn-warn bad" style={{ margin: '0 12px 8px' }}>{run.error}</div>}
      <div className="st-run-cols">
        <div><h5>Path through the workflow</h5><TraceList game={game} run={run} wf={wf} onPick={onPick} picked={pick} /></div>
        <div>
          <h5>{run.test ? 'Would do' : 'Did'}</h5>
          {run.actions.length === 0 ? <div className="pn-note">Nothing needed doing: no action node asked for anything this time.</div> : <ActionList game={game} run={run} />}
          {run.report && run.report.length > 0 && <><h5 style={{ marginTop: 10 }}>Report lines</h5>{run.report.map((l, i) => <div className="pn-note" key={i}>{l}</div>)}</>}
        </div>
      </div>
    </div>
  );
}
