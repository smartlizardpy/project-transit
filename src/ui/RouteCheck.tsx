// Route check: an interactive diagnostic open in the inspector. It measures the problem leg,
// explains its cause, draws it on the map (src/map/diagnosticsLayer.ts) and previews fixes, which
// are only committed when the player accepts them (with undo and redo inside the session).
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { ArrowClockwise, ArrowCounterClockwise, ArrowsLeftRight, ArrowsOutCardinal, CaretLeft, CaretRight, Check, CircleNotch, Crosshair, MapPin, Path, Signpost, Swap, Trash, Warning, X } from '@phosphor-icons/react';
import '../styles/diagnostics.css';
import { useUI, type RouteCheckTarget } from '../state/store.ts';
import { useGameRev } from './hooks.ts';
import { LineBadge, Tip } from './primitives.tsx';
import { fitPoints } from './camera.ts';
import { startDrafting, useDraftPreview } from './routeDraft.ts';
import { useCheckOverlay, type CheckOverlay } from '../map/diagnosticsLayer.ts';
import type { Game } from '../game/engine.ts';
import type { Pattern } from '../game/network.ts';
import type { Id } from '../game/types.ts';
import { distanceM, nearestNode, type LngLat } from '../game/world/graph.ts';
import { CAUSE_LABEL, applyFix, fmtM, legGeometry, lineStats, routeShape, routeTarget, suggestFixes, tradeoffs, type Diagnostic, type FixKind, type FixPlan, type LineShape, type LineStats, type ShapeTarget, type StopPlacement } from '../game/diagnostics.ts';
import { checkStop } from '../game/network.ts';

// ───────────────────────────────────────────── session state (client only)

interface Commit {
  title: string;
  before: LineStats;
  after: LineStats;
  undo: () => string | null;
  redo: () => string | null;
}

type Mode = 'idle' | 'move' | 'via';

interface CheckSession {
  key: string | null;
  plan: FixPlan | null;
  mode: Mode;
  /** a dragged handle was dropped where a stop cannot go */
  note: string | null;
  stats: { before: LineStats; after: LineStats } | null;
  /** the stops of the leg being checked, so the check follows it when the line changes */
  track: Id[] | null;
  applied: Commit | null;
  history: Commit[];
  future: Commit[];
}

const fresh = (key: string | null): CheckSession => ({ key, plan: null, mode: 'idle', note: null, stats: null, track: null, applied: null, history: [], future: [] });
export const useCheckSession = create<CheckSession>(() => fresh(null));
const setSession = (p: Partial<CheckSession>) => useCheckSession.setState(p);

// ───────────────────────────────────────────── helpers

const sumKm = (s: LineStats) => fmtM(s.totalM);
const diff = (m: number) => `${m > 0 ? '+' : m < 0 ? '−' : '±'}${fmtM(Math.abs(m))}`;

/** One line of text for a diagnostic in lists. */
export function diagnosticText(d: Diagnostic): string {
  if (d.kind === 'contraflow') return `${d.title}: drives against a one-way street (probably a gap in the map data).`;
  return d.text;
}

/** A warning row that opens its route check. Styled like the `.issue.info` rows. */
export function DiagnosticButton({ d, onOpen, size = 16 }: { d: Diagnostic; onOpen: () => void; size?: number }) {
  // same tones as before the warnings became clickable: route advice blue, problems coral, fleet amber
  const tone = d.severity === 'bad' ? 'bad' : d.kind === 'insufficient-buses' ? '' : 'info';
  return (
    <button className={`issue ${tone} dg-issue`} onClick={onOpen} aria-label={`${d.kind === 'insufficient-buses' ? 'Open timetable' : 'Check route'}: ${diagnosticText(d)}`}>
      {tone === 'info' ? <Path size={size} weight="bold" /> : <Warning size={size} weight="fill" />}
      <span className="dg-issue-t">{diagnosticText(d)}</span>
      <CaretRight size={13} weight="bold" className="dg-caret" />
    </button>
  );
}

function shapeOfRoute(game: Game, id: Id): LineShape | null {
  const r = game.state.routes[id];
  return r ? { id: r.id, number: r.number, colour: r.colour, kind: r.kind, stops: r.stops, returnStops: r.returnStops, via: r.via } : null;
}

function shapeOfDraft(): LineShape | null {
  const d = useUI.getState().draft;
  return d ? { id: d.editing, number: d.number, colour: d.colour, kind: d.kind, stops: d.stops, returnStops: d.kind === 'linear' ? d.returnStops : null, via: d.via } : null;
}

const defOf = (s: LineShape) => ({ kind: s.kind, stops: s.stops, returnStops: s.kind === 'linear' && s.returnStops && s.returnStops.length >= 2 ? s.returnStops : null, via: s.via });

/** Commit a plan (nothing changes before the player accepts). Draft fixes go through the draft's own undo. */
function commitPlan(game: Game, target: RouteCheckTarget, base: LineShape, plan: FixPlan, stats: { before: LineStats; after: LineStats }): Commit | string {
  const dest: ShapeTarget = target.route !== null
    ? routeTarget(game, target.route, base)
    : {
        apply: (s) => {
          useUI.getState().editDraft(() => ({ kind: s.kind, stops: s.stops, returnStops: s.kind === 'linear' ? s.returnStops : null, via: s.via }));
          return null;
        },
        revert: () => (useUI.getState().undoDraft(), null),
        reapply: () => (useUI.getState().redoDraft(), null),
      };
  const res = applyFix(game, base, plan, dest);
  if (typeof res === 'string') return res;
  return { title: plan.title, before: stats.before, after: stats.after, undo: res.undo, redo: res.redo };
}

const FIX_ICON: Record<FixKind, typeof Path> = {
  'move-stop': ArrowsOutCardinal, waypoint: Signpost, 'return-route': ArrowsLeftRight, 'other-stop': Swap, 'remove-stop': Trash, timetable: Path, 'assign-buses': Path,
};

// ───────────────────────────────────────────── view

export function RouteCheck({ target }: { target: RouteCheckTarget }) {
  const game = useGameRev();
  const draft = useUI((s) => s.draft);
  const preview = useDraftPreview((s) => s.preview);
  const ses = useCheckSession();
  const key = target.route ?? `draft:${draft?.editing ?? 'new'}`;
  useEffect(() => {
    if (useCheckSession.getState().key !== key) useCheckSession.setState(fresh(key));
  }, [key]);

  const shape = game ? (target.route !== null ? shapeOfRoute(game, target.route) : shapeOfDraft()) : null;
  const patterns: Pattern[] = game ? (target.route !== null ? game.patterns.get(target.route) ?? [] : preview?.patterns ?? []) : [];
  const diags = patterns.flatMap((p) => p.diagnostics ?? []);
  let d = diags.find((x) => x.pat === target.pat && x.leg === target.leg) ?? null;
  if (ses.track && (!d || d.stops.join() !== ses.track.join())) d = diags.find((x) => x.stops.join() === ses.track!.join()) ?? null;
  const pat = d?.pat !== null && d?.pat !== undefined ? patterns[d.pat] : patterns[target.pat];
  const shapeKey = shape ? JSON.stringify(defOf(shape)) : '';
  const stopKey = d ? d.stops.map((id) => game?.state.stops[id]?.lngLat.join()).join('|') : '';
  const diagKey = `${key}|${shapeKey}|${d?.id ?? ''}|${stopKey}`;

  // keep tracking the same stops after edits
  useEffect(() => {
    if (d && !ses.track) setSession({ track: d.stops });
  }, [d?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // suggestions are computed off the render path (they route dozens of variants of the line)
  const [sugg, setSugg] = useState<{ key: string; plans: FixPlan[] } | null>(null);
  useEffect(() => {
    if (!game || !shape || !d) return;
    const t = window.setTimeout(() => setSugg({ key: diagKey, plans: suggestFixes(game, shape, d!) }), 40);
    return () => clearTimeout(t);
  }, [diagKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const plans = sugg?.key === diagKey ? sugg.plans : null;

  // before/after numbers of the previewed plan (full run-time profiles; only when it settles)
  useEffect(() => {
    if (!game || !shape || !ses.plan) return setSession({ stats: null });
    const plan = ses.plan;
    const t = window.setTimeout(() => {
      if (useCheckSession.getState().plan !== plan) return;
      setSession({ stats: { before: lineStats(game, shape), after: lineStats(game, plan.shape, plan.moves, plan.builds) } });
    }, 60);
    return () => clearTimeout(t);
  }, [ses.plan, shapeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // camera: frame the leg when the check opens or moves to another leg
  const framed = useRef('');
  useEffect(() => {
    if (!game || !d || framed.current === `${key}|${d.id}`) return;
    framed.current = `${key}|${d.id}`;
    refocus(game, d, pat);
  }, [d?.id, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // map overlay
  const previewPath = useMemo(() => (game && ses.plan && d ? planPath(game, ses.plan, d) : null), [ses.plan, d?.id, game]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!game || !d || !shape) {
      useCheckOverlay.getState().set(null);
      return;
    }
    useCheckOverlay.getState().set(overlayFor(game, d, pat, shape, ses.plan, previewPath, ses.mode));
  }, [diagKey, ses.plan, ses.mode, previewPath]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    useCheckOverlay.getState().set(null);
    useCheckOverlay.setState({ onDrag: null });
  }, []);

  // dragging handles on the map
  useEffect(() => {
    if (!game || !d || !shape) return;
    useCheckOverlay.setState({ onDrag: (id, at, final) => onDrag(game, shape, d!, id, at, final) });
  }, [diagKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc steps back (preview → check → line); ⌘Z undoes fixes made here on a committed line
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const s = useCheckSession.getState();
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (s.plan || s.mode !== 'idle') setSession({ plan: null, mode: 'idle', note: null });
        else useUI.getState().openRouteCheck(null);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && target.route !== null && (s.history.length || s.future.length)) {
        e.stopPropagation();
        e.preventDefault();
        if (e.shiftKey) redo(game);
        else undo(game);
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [target.route, game]);

  if (!game || !shape) return null;
  const close = () => (target.route !== null ? useUI.getState().select(null) : useUI.getState().openRouteCheck(null));
  const back = () => useUI.getState().openRouteCheck(null);
  const dirLabel = shape.kind === 'loop' ? 'Loop' : (d?.pat ?? target.pat) === 0 ? 'Outbound' : 'Return';
  const legCount = pat ? Math.max(0, pat.stops.length - 1) : 0;

  return (
    <>
      <div className="p-head">
        <button className="icon-btn has-tip dg-back" onClick={back} aria-label="Back to the line">
          <CaretLeft size={16} weight="bold" />
          <Tip label={target.route !== null ? 'Back to the line' : 'Back to the line editor'} k="Esc" side="below" />
        </button>
        <LineBadge colour={shape.colour} size="lg">{shape.number}</LineBadge>
        <div className="grow">
          <div className="p-title">Route check</div>
          <div className="p-sub">{dirLabel}{d?.leg !== null && d?.leg !== undefined ? ` · leg ${d.leg + 1} of ${legCount}` : ''}{target.route === null ? ' · draft' : ''}</div>
        </div>
        <button className="close-btn has-tip" onClick={close} aria-label="Close">
          <X size={15} weight="bold" />
          <Tip label="Close" side="left" />
        </button>
      </div>
      <div className="p-body dg-body">
        {d ? <Finding game={game} d={d} colour={shape.colour} compact={!!ses.plan} /> : <Resolved game={game} diags={diags} target={target} />}
        {d && <Fixes game={game} shape={shape} d={d} plans={plans} target={target} />}
        {ses.plan && <Compare game={game} plan={ses.plan} />}
        {!ses.plan && ses.applied && <Applied commit={ses.applied} />}
      </div>
      <div className="p-foot">
        {ses.plan ? (
          <>
            <button className="btn" onClick={() => setSession({ plan: null, note: null })}>Cancel</button>
            <button className="btn primary" style={{ flex: 1 }} disabled={!ses.stats || !ses.stats.after.valid} onClick={() => accept(game, target, shape, d)}>
              <Check size={16} weight="bold" /> Apply change
            </button>
          </>
        ) : (
          <>
            <button className="btn" style={{ flex: 1 }} onClick={back}>
              <CaretLeft size={15} weight="bold" /> {target.route !== null ? 'Back to line' : 'Back to editor'}
            </button>
            <button className="btn has-tip" disabled={!d} onClick={() => d && refocus(game, d, pat)} aria-label="Show leg">
              <Crosshair size={16} weight="bold" />
              <Tip label="Show this leg" side="below" />
            </button>
            <button className="btn has-tip" disabled={!ses.history.length} onClick={() => undo(game)} aria-label="Undo">
              <ArrowCounterClockwise size={16} weight="bold" />
              <Tip label="Undo last fix" k={target.route !== null ? '⌘Z' : undefined} side="below" />
            </button>
            <button className="btn has-tip" disabled={!ses.future.length} onClick={() => redo(game)} aria-label="Redo">
              <ArrowClockwise size={16} weight="bold" />
              <Tip label="Redo" side="below" />
            </button>
          </>
        )}
      </div>
    </>
  );
}

function refocus(game: Game, d: Diagnostic, pat: Pattern | undefined) {
  fitPoints(legGeometry(game.region.graph, game.state, d, pat).frame, 17.2);
}

function Finding({ game, d, colour, compact }: { game: Game; d: Diagnostic; colour: string; compact: boolean }) {
  const m = d.measure;
  const c = d.cause;
  const a = game.state.stops[d.stops[0]], b = game.state.stops[d.stops[1]];
  return (
    <>
      <ol className="dg-leg" style={{ ['--c' as string]: colour }}>
        <li><span className="dg-ab">A</span><span className="dg-leg-name">{a?.name ?? 'Removed stop'}</span></li>
        <li><span className="dg-ab">B</span><span className="dg-leg-name">{b?.name ?? 'Removed stop'}</span></li>
      </ol>
      {m && (
        <div className="grid3">
          <div className="kpi"><b>{fmtM(m.directM)}</b><span>Straight line</span></div>
          <div className="kpi"><b>{fmtM(m.roadM)}</b><span>By road now</span></div>
          <div className="kpi"><b className="amber">+{fmtM(m.extraM)}</b><span>Extra driving</span></div>
        </div>
      )}
      <div className="section dg-cause">
        <div className="row" style={{ minHeight: 0, marginBottom: 6 }}>
          <span className="label">Why</span>
          {c && c.kind !== 'none' && <span className={`pill ${c.kind === 'geography' ? '' : c.kind === 'contraflow' || c.kind === 'data-gap' ? 'info' : 'warn'}`}>{CAUSE_LABEL[c.kind]}</span>}
        </div>
        {compact ? <p className="dg-text dg-clamp">{d.explanation}</p> : <p className="dg-text">{d.explanation}</p>}
        {!compact && c && c.blocking.length > 0 && (
          <ul className="dg-streets">
            {c.blocking.slice(0, 4).map((s, i) => (
              <li key={i}><i className="dg-swatch block" /><span className="grow">{s.name}</span><span className="faint">one-way {s.allowed} · {fmtM(s.metres)}</span></li>
            ))}
          </ul>
        )}
        {!compact && c && c.gaps.length > 0 && <div className="dg-note"><i className="dg-swatch gap" /> {c.gaps.length} road end{c.gaps.length > 1 ? 's' : ''} marked near the straight line.</div>}
        {!compact && m && <div className="dg-note"><i className="dg-swatch direct" /> The dashed line is the straight-line distance, for reference only. Buses cannot drive it.</div>}
      </div>
    </>
  );
}

function Resolved({ game, diags, target }: { game: Game; diags: Diagnostic[]; target: RouteCheckTarget }) {
  const others = diags.filter((x) => x.kind === 'detour' || x.kind === 'contraflow' || x.kind === 'no-connection');
  return (
    <>
      <div className="issue info dg-resolved"><Check size={16} weight="bold" />This leg has no detour warning now.</div>
      {others.length > 0 && (
        <div className="section">
          <div className="label" style={{ marginBottom: 6 }}>Other warnings on this line</div>
          {others.slice(0, 4).map((x) => (
            <DiagnosticButton key={x.id} d={x} size={14} onOpen={() => { setSession({ track: x.stops, plan: null, mode: 'idle' }); useUI.getState().openRouteCheck({ route: target.route, pat: x.pat ?? 0, leg: x.leg ?? 0 }); }} />
          ))}
        </div>
      )}
      {!others.length && <div className="faint" style={{ fontSize: 12 }}>{game.state.routes[target.route ?? '']?.number ? `Line ${game.state.routes[target.route!].number}` : 'The line'} has no other route warnings.</div>}
    </>
  );
}

function Fixes({ game, shape, d, plans, target }: { game: Game; shape: LineShape; d: Diagnostic; plans: FixPlan[] | null; target: RouteCheckTarget }) {
  const ses = useCheckSession();
  const name = (id: Id) => game.state.stops[id]?.name ?? 'the stop';
  const seqAll = [...shape.stops, ...(shape.returnStops ?? [])];
  // the stop that can be removed: an intermediate one first
  const removable = [...d.stops].reverse().find((id) => {
    const left = shape.stops.filter((x) => x !== id).length;
    return seqAll.includes(id) && left >= (shape.kind === 'loop' ? 3 : 2);
  });
  const pick = (p: FixPlan) => setSession({ plan: ses.plan?.id === p.id ? null : p, mode: 'idle', note: null });
  const removePlan = (): FixPlan | null => {
    if (!removable) return null;
    const strip = (seq: Id[]) => seq.filter((x) => x !== removable);
    const s: LineShape = { ...shape, stops: strip(shape.stops), returnStops: shape.returnStops ? strip(shape.returnStops) : null, via: {} };
    // keep waypoints not touching the removed stop
    for (const [k, v] of Object.entries(shape.via)) {
      const [dir, n] = k.split(':');
      const seq = dir === 'o' ? shape.stops : shape.returnStops ?? [...shape.stops].reverse();
      const j = seq.indexOf(removable);
      const i = Number(n);
      if (j < 0) s.via[k] = v;
      else if (i !== j && i !== j - 1) s.via[`${dir}:${i > j ? i - 1 : i}`] = v;
    }
    const ps = routeShape(game, s);
    const total = ps.reduce((a, p) => a + (p.valid ? p.path.length : Infinity), 0);
    const before = routeShape(game, shape).reduce((a, p) => a + p.path.length, 0);
    return { id: `remove:${removable}`, kind: 'remove-stop', title: `Remove ${name(removable)} from the line`, shape: s, moves: {}, builds: {}, focus: null, totalM: total, savedM: before - total };
  };
  const startMode = (m: Mode) => setSession({ mode: ses.mode === m ? 'idle' : m, plan: null, note: null });
  const editReturn = () => {
    if (target.route !== null) startDrafting(target.route);
    const ui = useUI.getState();
    ui.editDraft((x) => ({ editingReturn: true, returnStops: x.returnStops ?? [...x.stops].reverse() }));
    ui.openRouteCheck(null);
    ui.notify('Editing the return direction. Click stops to build a different way back.', 'info');
  };
  return (
    <div className="section dg-fixes">
      <div className="label" style={{ marginBottom: 6 }}>Fix it</div>
      {plans === null ? (
        <div className="dg-wait"><CircleNotch size={14} weight="bold" className="dg-spin" /> Trying nearby stops and streets…</div>
      ) : plans.length ? (
        <div className="dg-plans">
          {plans.map((p) => {
            const Icon = FIX_ICON[p.kind];
            return (
              <button key={p.id} className={`dg-plan ${ses.plan?.id === p.id ? 'on' : ''}`} onClick={() => pick(p)}>
                <Icon size={15} weight="bold" />
                <span className="grow">{p.title}</span>
                <span className="dg-save num">−{fmtM(p.savedM)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="dg-none">{d.kind === 'contraflow' ? 'No nearby stop or street avoids the one-way street.' : 'No better alternative on the road network nearby: moving or swapping a stop within about 400 m does not shorten the line.'}</div>
      )}
      <div className="dg-tools">
        <button className={`btn sm ${ses.mode === 'move' ? 'on' : ''}`} onClick={() => startMode('move')}><ArrowsOutCardinal size={14} weight="bold" /> Move a stop</button>
        <button className={`btn sm ${ses.mode === 'via' ? 'on' : ''}`} onClick={() => startMode('via')}><Signpost size={14} weight="bold" /> Waypoint</button>
        <button className="btn sm has-tip" disabled={shape.kind !== 'linear'} onClick={editReturn}>
          <ArrowsLeftRight size={14} weight="bold" /> Return route
          <Tip label={shape.kind === 'linear' ? 'Edit the return route' : 'A loop has no return route'} hint={shape.kind === 'linear' ? 'Outbound and return may use different stops' : undefined} side="below" />
        </button>
        <button className="btn sm has-tip" disabled={!removable} onClick={() => { const p = removePlan(); if (p) setSession({ plan: p, mode: 'idle', note: null }); }}>
          <Trash size={14} weight="bold" /> Remove stop
          <Tip label={removable ? `Remove ${name(removable)}` : 'A line needs at least two stops'} hint={removable ? 'Preview the line without it' : undefined} side="below" />
        </button>
      </div>
      {ses.mode === 'move' && <div className="dg-hint"><MapPin size={13} weight="fill" /> Drag stop A or B on the map. It snaps to the nearest street where a stop is allowed.</div>}
      {ses.mode === 'via' && <div className="dg-hint"><Signpost size={13} weight="fill" /> Drag the waypoint onto the streets the bus should take.</div>}
      {ses.note && <div className="dg-hint bad"><Warning size={13} weight="fill" /> {ses.note}</div>}
    </div>
  );
}

function Compare({ game, plan }: { game: Game; plan: FixPlan }) {
  const stats = useCheckSession((s) => s.stats);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (stats) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [stats]);
  if (!stats) return <div className="section dg-compare"><div className="dg-wait"><CircleNotch size={14} weight="bold" className="dg-spin" /> Measuring the change…</div></div>;
  const { before, after } = stats;
  const rows: [string, string, string, string, boolean | null][] = [
    ['Line length', sumKm(before), sumKm(after), diff(after.totalM - before.totalM), after.totalM < before.totalM],
    ['Run time now', `${Math.round(before.minutes)} min`, `${Math.round(after.minutes)} min`, `${after.minutes - before.minutes > 0 ? '+' : ''}${Math.round(after.minutes - before.minutes)} min`, after.minutes < before.minutes - 0.5 ? true : after.minutes > before.minutes + 0.5 ? false : null],
    ['Residents nearby', before.residents.toLocaleString(), after.residents.toLocaleString(), '', after.residents > before.residents ? true : after.residents < before.residents ? false : null],
    ['Jobs nearby', before.jobs.toLocaleString(), after.jobs.toLocaleString(), '', after.jobs > before.jobs ? true : after.jobs < before.jobs ? false : null],
    ['Stops', String(before.stops), String(after.stops), '', null],
  ];
  return (
    <div className="section dg-compare" ref={ref}>
      <div className="dg-cmp-head"><span className="label">Before → after</span><span className="faint">{plan.kind === 'move-stop' ? 'moved stop' : 'preview'}</span></div>
      <div className="dg-table" role="table">
        <div className="dg-tr head" role="row"><span /><span>Now</span><span>With fix</span></div>
        {rows.map(([k, a, b, dlt, good]) => (
          <div className="dg-tr" role="row" key={k}>
            <span className="k">{k}</span>
            <span className="num">{a}</span>
            <span className={`num ${good === true ? 'mint' : good === false ? 'coral' : ''}`}>{b}{dlt && <em> {dlt}</em>}</span>
          </div>
        ))}
      </div>
      <ul className="dg-trade">
        {tradeoffs(game, plan, before, after).map((t) => <li key={t}>{t}</li>)}
      </ul>
      {!after.valid && <div className="issue bad"><Warning size={14} weight="fill" />The line cannot be driven like this.</div>}
    </div>
  );
}

function Applied({ commit }: { commit: Commit }) {
  const dm = commit.after.totalM - commit.before.totalM;
  return (
    <div className="section dg-applied">
      <div className="row" style={{ minHeight: 0 }}>
        <span className="label">Applied</span>
        <span className={`v num ${dm < 0 ? 'mint' : ''}`}>{diff(dm)}</span>
      </div>
      <div className="dg-text">{commit.title}. Line length {sumKm(commit.before)} → {sumKm(commit.after)}, run time {Math.round(commit.before.minutes)} → {Math.round(commit.after.minutes)} min.</div>
    </div>
  );
}

// ───────────────────────────────────────────── actions

function accept(game: Game, target: RouteCheckTarget, shape: LineShape, d: Diagnostic | null) {
  const s = useCheckSession.getState();
  if (!s.plan || !s.stats) return;
  const res = commitPlan(game, target, shape, s.plan, s.stats);
  const ui = useUI.getState();
  if (typeof res === 'string') {
    ui.notify(res, 'bad');
    return;
  }
  setSession({ plan: null, mode: 'idle', note: null, applied: res, history: [...s.history, res], future: [], track: s.track ?? d?.stops ?? null });
  ui.notify(`${res.title}. ${target.route !== null ? 'Buses follow the new route from their next stop.' : 'The draft is updated.'}`, 'good');
}

function undo(game: Game | null) {
  const s = useCheckSession.getState();
  const c = s.history[s.history.length - 1];
  if (!game || !c) return;
  const err = c.undo();
  if (err) return useUI.getState().notify(err, 'bad');
  setSession({ history: s.history.slice(0, -1), future: [...s.future, c], applied: null, plan: null });
  useUI.getState().notify(`Undone: ${c.title}`, 'info');
}

function redo(game: Game | null) {
  const s = useCheckSession.getState();
  const c = s.future[s.future.length - 1];
  if (!game || !c) return;
  const err = c.redo();
  if (err) return useUI.getState().notify(err, 'bad');
  setSession({ future: s.future.slice(0, -1), history: [...s.history, c], applied: c, plan: null });
}

/** A handle was dragged on the map: snap it and preview the change. */
function onDrag(game: Game, shape: LineShape, d: Diagnostic, id: string, at: LngLat, final: boolean) {
  const g = game.region.graph;
  if (id.startsWith('stop:')) {
    const sid = id.slice(5);
    const s = game.state.stops[sid];
    if (!s) return;
    const c = checkStop(game.state, game.region, game.geo, at, sid);
    if (!c.ok) {
      setSession({ note: final ? c.reason ?? 'A stop cannot go here.' : null, ...(final ? { plan: null } : {}) });
      return;
    }
    const p: StopPlacement = { lngLat: c.lngLat, node: c.node, alt: c.alt, zone: c.zone, name: c.name };
    const plan = manualPlan(game, shape, 'move-stop', `Move ${s.name} ${fmtM(distanceM(c.lngLat, s.lngLat))}${c.road ? ` to ${c.road}` : ''}`, shape, { [sid]: p }, { stop: sid, at: c.lngLat });
    setSession({ plan, note: null });
    return;
  }
  if (id.startsWith('via:')) {
    const k = Number(id.slice(4));
    const [x, y] = game.geo.xy(at);
    const v = nearestNode(g, game.region.index, x, y, 80);
    if (v < 0) {
      if (final) setSession({ note: 'Waypoints must be on a street.' });
      return;
    }
    const key = `${d.pat === 0 ? 'o' : 'r'}:${d.leg}`;
    const list = [...(shape.via[key] ?? [])];
    list[Math.min(k, list.length)] = [g.lng[v], g.lat[v]];
    const s2: LineShape = { ...shape, via: { ...shape.via, [key]: list } };
    const street = game.geo.streetNear([g.lng[v], g.lat[v]], 30);
    setSession({ plan: manualPlan(game, shape, 'waypoint', `Waypoint on ${street ?? 'this street'}`, s2, {}, null), note: null });
  }
}

function manualPlan(game: Game, base: LineShape, kind: FixKind, title: string, s: LineShape, moves: Record<Id, StopPlacement>, focus: FixPlan['focus']): FixPlan {
  const before = routeShape(game, base).reduce((a, p) => a + p.path.length, 0);
  const ps = routeShape(game, s, moves);
  const total = ps.reduce((a, p) => a + (p.valid ? p.path.length : Infinity), 0);
  return { id: `${kind}:manual`, kind, title, shape: s, moves, builds: {}, focus, totalM: total, savedM: before - total };
}

// ───────────────────────────────────────────── map overlay

/** Path of the previewed plan around the leg being fixed. */
function planPath(game: Game, plan: FixPlan, d: Diagnostic): LngLat[] | null {
  const g = game.region.graph;
  const ps = routeShape(game, plan.shape, plan.moves, plan.builds);
  const p = ps[d.pat ?? 0] ?? ps[0];
  if (!p?.valid || !p.stopIdx.length) return null;
  const want = new Set([...d.stops, ...(plan.focus ? [plan.focus.stop] : [])]);
  const idx = p.stops.map((id, i) => (want.has(id) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return null;
  let lo = Math.min(...idx), hi = Math.max(...idx);
  if (lo === hi) {
    lo = Math.max(0, lo - (plan.kind === 'remove-stop' ? 0 : 1));
    hi = Math.min(p.stops.length - 1, hi + 1);
  }
  if (plan.kind === 'remove-stop') hi = Math.min(p.stops.length - 1, Math.max(hi, lo + 1));
  const out: LngLat[] = [];
  for (let i = p.stopIdx[lo]; i <= p.stopIdx[hi]; i++) out.push([g.lng[p.path.nodes[i]], g.lat[p.path.nodes[i]]]);
  return out;
}

function overlayFor(game: Game, d: Diagnostic, pat: Pattern | undefined, shape: LineShape, plan: FixPlan | null, preview: LngLat[] | null, mode: Mode): CheckOverlay {
  const g = game.region.graph;
  const A = game.state.stops[d.stops[0]], B = game.state.stops[d.stops[1]];
  const geo = legGeometry(g, game.state, d, pat);
  const handles: CheckOverlay['handles'] = [];
  if (mode === 'move') {
    for (const [id, label] of [[d.stops[0], 'A'], [d.stops[1], 'B']] as const) {
      const s = game.state.stops[id];
      if (!s) continue;
      handles.push({ id: `stop:${id}`, at: plan?.moves[id]?.lngLat ?? s.lngLat, kind: 'stop', label: `Drag ${label}`, ok: true });
    }
  }
  if (mode === 'via') {
    const key = `${d.pat === 0 ? 'o' : 'r'}:${d.leg}`;
    const list = plan?.kind === 'waypoint' ? plan.shape.via[key] ?? [] : shape.via[key] ?? [];
    if (list.length) list.forEach((p, i) => handles.push({ id: `via:${i}`, at: p, kind: 'via', label: '', ok: true }));
    else if (A && B) {
      // start the waypoint on the street nearest the middle of the leg
      const mid: LngLat = [(A.lngLat[0] + B.lngLat[0]) / 2, (A.lngLat[1] + B.lngLat[1]) / 2];
      const [x, y] = game.geo.xy(mid);
      const v = nearestNode(g, game.region.index, x, y, 200);
      handles.push({ id: 'via:0', at: v >= 0 ? [g.lng[v], g.lat[v]] : mid, kind: 'via', label: 'Drag', ok: true });
    }
  }
  const ghosts: CheckOverlay['ghosts'] = [];
  if (plan) {
    for (const p of Object.values(plan.builds)) ghosts.push({ at: p.lngLat, label: p.name ? `New: ${p.name}` : 'New stop' });
    if (plan.kind === 'other-stop' || plan.kind === 'return-route') {
      const f = plan.focus;
      if (f && game.state.stops[f.stop]) ghosts.push({ at: f.at, label: game.state.stops[f.stop].name });
    }
    if (mode !== 'move') for (const [id, p] of Object.entries(plan.moves)) ghosts.push({ at: p.lngLat, label: `${game.state.stops[id]?.name ?? 'Stop'} here` });
  }
  return {
    colour: shape.colour,
    leg: geo.leg.length > 1 ? geo.leg : null,
    direct: geo.direct,
    blocking: geo.blocking,
    gaps: geo.gaps,
    stops: geo.stops.map((s) => ({ at: s.at, label: s.label, role: s.label === 'A' ? ('from' as const) : ('to' as const) })),
    preview,
    ghosts,
    handles,
  };
}
