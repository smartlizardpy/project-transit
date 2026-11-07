// Improve service: what passengers dislike, a plan of changes made with the player's own tools,
// a test of the plan on copies of the company, and apply / undo.
import { useRef, useState } from 'react';
import { X, Flask, Check, ArrowCounterClockwise, ArrowsClockwise, Bus, Clock, Path } from '@phosphor-icons/react';
import type { Game } from '../game/engine.ts';
import { useUI } from '../state/store.ts';
import { planService, testPlan, TEST_HOURS, type Plan, type PlanTest, type Step } from '../game/optimise.ts';
import type { LabMetrics } from '../game/automation/lab.ts';
import { SAT_COMPONENTS } from '../game/progress.ts';
import { LineBadge, LoadBar, Segmented, Tip } from './primitives.tsx';
import { Switch } from './automation/common.tsx';
import { focusLine } from './camera.ts';
import { actionKey, send } from '../app/act.ts';

const notify = (text: string, tone: 'good' | 'bad' | 'warn' | 'info') => useUI.getState().notify(text, tone);
const tone = (v: number) => (v >= 0.72 ? 'var(--mint)' : v >= 0.55 ? 'var(--amber)' : 'var(--coral)');
const STEP_ICON = { buses: Bus, timetable: Clock, route: Path } as const;

type Row = { key: keyof LabMetrics; label: string; better: 'higher' | 'lower'; fmt: (g: Game, v: number) => string };
const n0 = (_g: Game, v: number) => Math.round(v).toLocaleString('en-GB');
const pc = (_g: Game, v: number) => `${v.toFixed(0)}%`;
const ROWS: Row[] = [
  { key: 'satisfaction', label: 'Satisfaction', better: 'higher', fmt: pc },
  { key: 'waitScore', label: 'Waiting score', better: 'higher', fmt: pc },
  { key: 'journeyScore', label: 'Journey-time score', better: 'higher', fmt: pc },
  { key: 'avgWait', label: 'Average wait', better: 'lower', fmt: (_g, v) => `${v.toFixed(1)} min` },
  { key: 'journeys', label: 'Journeys completed', better: 'higher', fmt: n0 },
  { key: 'abandoned', label: 'Gave up or stranded', better: 'lower', fmt: n0 },
  { key: 'leftBehind', label: 'Left behind (bus full)', better: 'lower', fmt: n0 },
  { key: 'missed', label: 'Departures missed', better: 'lower', fmt: n0 },
  { key: 'operating', label: 'Operating result', better: 'higher', fmt: (g, v) => g.money(v) },
];

function diffCell(g: Game, r: Row, a: number | null, b: number | null) {
  if (a === null || b === null) return { text: '–', cls: 'st-flat' };
  const d = b - a;
  if (Math.abs(d) < 0.05) return { text: 'same', cls: 'st-flat' };
  const good = r.better === 'higher' ? d > 0 : d < 0;
  const body = r.fmt === pc ? `${Math.abs(d).toFixed(0)} pts` : r.key === 'operating' ? g.money(Math.abs(d)) : r.key === 'avgWait' ? `${Math.abs(d).toFixed(1)} min` : n0(g, Math.abs(d));
  return { text: `${d > 0 ? '+' : '−'}${body}`, cls: good ? 'st-good' : 'st-bad' };
}

export function ImproveService({ game }: { game: Game }) {
  const [plan, setPlan] = useState<Plan>(() => planService(game));
  const [on, setOn] = useState<Set<string>>(() => new Set(plan.steps.filter((s) => s.on).map((s) => s.id)));
  const [hours, setHours] = useState<number>(24);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [res, setRes] = useState<PlanTest | null>(null);
  const [applied, setApplied] = useState<{ done: string[]; problems: string[]; key: string } | null>(null);
  const stop = useRef(false);
  const d = plan.diagnosis;
  const chosen = plan.steps.filter((s) => on.has(s.id));
  const cost = chosen.reduce((p, s) => p + s.cost, 0);
  const tooDear = cost > game.state.finance.balance;
  const tested = res && res.from === plan.at ? res : null;

  const replan = () => {
    const p = planService(game);
    setPlan(p);
    setOn(new Set(p.steps.filter((s) => s.on).map((s) => s.id)));
    setRes(null);
    setApplied(null);
  };
  const toggle = (id: string, v: boolean) => {
    const next = new Set(on);
    if (v) next.add(id); else next.delete(id);
    setOn(next);
    setRes(null);
  };
  const runTest = async () => {
    stop.current = false; setBusy(true); setPct(0);
    try {
      const r = await testPlan(game, plan, on, hours, setPct, () => stop.current);
      if (r) setRes(r);
    } catch (e) { notify(e instanceof Error ? e.message : 'The test could not run.', 'bad'); }
    setBusy(false);
  };
  const apply = async () => {
    const key = actionKey();
    const r = (await send({ m: 'applyPlan', args: [plan, [...on], key] })) as { done: string[]; problems: string[] };
    setApplied({ ...r, key });
    if (r.done.length) notify(`${r.done.length} change${r.done.length === 1 ? '' : 's'} made. Buses join their new lines once they have run the trips they have.`, 'good');
    for (const p of r.problems) notify(p, 'bad');
  };
  const undo = async () => {
    if (!applied) return;
    const errs = (await send({ m: 'undoApplied', args: [applied.key] })) as string[];
    if (errs.length) for (const e of errs) notify(e, 'bad');
    else notify('Changes undone. Buses bought for the plan stay in your fleet.', 'info');
    replan();
  };

  return (
    <>
      <div className="p-head">
        <div className="grow">
          <div className="p-title" style={{ fontSize: 19 }}>Improve service</div>
          <div className="p-sub">What passengers dislike, and changes that would help</div>
        </div>
        <button className="close-btn has-tip" onClick={() => useUI.getState().openPanel(null)} aria-label="Close panel">
          <X size={15} weight="bold" />
          <Tip label="Close" k="Esc" side="left" />
        </button>
      </div>
      <div className="p-body">
        <div className="section">
          <div className="section-head">
            <div>
              <div className="label">Satisfaction, last 24 h</div>
              <div className="num" style={{ fontSize: 28, fontWeight: 800, marginTop: 4, color: d.satisfaction === null ? undefined : tone(d.satisfaction) }}>{d.satisfaction === null ? '–' : `${Math.round(d.satisfaction * 100)}%`}</div>
            </div>
            <div className="faint" style={{ fontSize: 12, textAlign: 'right' }}>{d.journeys.toLocaleString('en-GB')} journeys rated<br />{d.abandoned.toLocaleString('en-GB')} gave up</div>
          </div>
          {d.satisfaction !== null && (
            <div className="improve-comps">
              {SAT_COMPONENTS.map((k, i) => (
                <div key={k}>
                  <div className="row" style={{ minHeight: 0 }}><span className="k">{k}</span><span className="v" style={{ color: tone(d.comp[i]) }}>{Math.round(d.comp[i] * 100)}%</span></div>
                  <LoadBar value={d.comp[i]} solid colour={tone(d.comp[i])} marker={false} />
                </div>
              ))}
            </div>
          )}
        </div>

        {d.causes.length > 0 && (
          <div className="section">
            <div className="section-head"><span style={{ fontWeight: 800, fontSize: 14 }}>What hurts most</span><span className="faint" style={{ fontSize: 12 }}>{d.window}</span></div>
            <div className="list">
              {d.causes.map((c) => (
                <div key={c.key}>
                  <div style={{ fontWeight: 700 }}>{c.title}</div>
                  <div className="pn-note">{c.text}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="section">
          <div className="section-head">
            <span style={{ fontWeight: 800, fontSize: 14 }}>Suggested changes</span>
            <button className="btn sm has-tip" onClick={replan} disabled={busy}><ArrowsClockwise size={13} weight="bold" />Plan again<Tip label="Make a new plan from the company as it is now" side="left" /></button>
          </div>
          {plan.steps.length === 0 && <div className="pn-note">{plan.notes[0] ?? 'Nothing to change.'}</div>}
          <div className="list">
            {plan.steps.map((s) => <StepCard key={s.id} game={game} step={s} on={on.has(s.id)} disabled={busy || !!applied} onChange={(v) => toggle(s.id, v)} />)}
          </div>
          {plan.steps.length > 0 && plan.notes.map((n, i) => <div className="pn-note" key={i} style={{ marginTop: 6 }}>{n}</div>)}
        </div>

        {plan.steps.length > 0 && !applied && (
          <div className="section">
            <div className="section-head"><span style={{ fontWeight: 800, fontSize: 14 }}>Try it first</span></div>
            <div className="pn-note">Plays the next hours twice on copies of your company, without these changes and with them. Your company is not touched. It is one possible future, measured, not a promise.</div>
            <div className="pn-actions" style={{ marginTop: 8 }}>
              <Segmented value={String(hours)} onChange={(v) => { setHours(Number(v)); setRes(null); }} options={TEST_HOURS.map((h) => ({ value: String(h), label: `${h} h`, disabled: busy }))} />
              <button className="btn" disabled={busy || !on.size} onClick={runTest}><Flask size={15} weight="bold" />Test on a copy</button>
              {busy && <button className="btn" onClick={() => { stop.current = true; }}>Cancel</button>}
            </div>
            {busy && <div className="pn-bar" style={{ marginTop: 8 }}><i style={{ width: `${pct * 100}%` }} /></div>}
            {tested && <TestResult game={game} res={tested} />}
          </div>
        )}

        {applied ? (
          <div className="section">
            {applied.done.length > 0 && <div className="pn-note"><Check size={13} weight="bold" style={{ color: 'var(--mint)', verticalAlign: -2 }} /> Done: {applied.done.join('; ')}. New timetables start now; for the next hour or so, buses getting into place may miss a few departures.</div>}
            {applied.problems.map((p, i) => <div className="pn-warn bad" key={i} style={{ marginTop: 6 }}>{p}</div>)}
            <div className="pn-actions" style={{ marginTop: 8 }}>
              {applied.done.length > 0 && <button className="btn" onClick={() => void undo()}><ArrowCounterClockwise size={14} weight="bold" />Undo</button>}
              <button className="btn" onClick={replan}><ArrowsClockwise size={14} weight="bold" />Plan again</button>
            </div>
          </div>
        ) : plan.steps.length > 0 && (
          <div className="pn-actions">
            <button className="btn primary" disabled={busy || !on.size || tooDear} onClick={apply}>
              <Check size={15} weight="bold" />Apply {on.size} change{on.size === 1 ? '' : 's'}{cost ? ` · ${game.money(cost)}` : ''}
            </button>
            {tooDear && <span className="pn-note">Not enough money for the buses.</span>}
          </div>
        )}
      </div>
    </>
  );
}

function StepCard({ game, step, on, disabled, onChange }: { game: Game; step: Step; on: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  const Icon = STEP_ICON[step.kind];
  return (
    <div className={`pn-card improve-step ${on ? '' : 'off'}`}>
      <div className="improve-step-head">
        <Icon size={16} weight="bold" />
        <span className="grow" style={{ fontWeight: 700 }}>{step.title}</span>
        {step.cost > 0 && <span className="pn-tag warn">{game.money(step.cost)}</span>}
        <Switch on={on} onChange={onChange} label={`Include: ${step.title}`} disabled={disabled} />
      </div>
      <div className="improve-lines">
        {step.lines.map((id) => {
          const r = game.state.routes[id];
          return r ? (
            <button key={id} className="improve-line" onClick={() => { useUI.getState().select({ kind: 'line', id }); focusLine(id); }}
              onMouseEnter={() => useUI.getState().setHover({ kind: 'line', id } as never)} onMouseLeave={() => useUI.getState().setHover(null)}>
              <LineBadge colour={r.colour} size="sm">{r.number}</LineBadge>
            </button>
          ) : null;
        })}
        {step.saves >= 30 && <span className="faint" style={{ fontSize: 11.5 }}>about {Math.round(step.saves).toLocaleString('en-GB')} fewer minutes of waiting a day (estimate)</span>}
      </div>
      <div className="pn-note">{step.why}</div>
      <ul className="improve-details">{step.details.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}

function TestResult({ game, res }: { game: Game; res: PlanTest }) {
  return (
    <div style={{ marginTop: 10 }}>
      <table className="pn-table">
        <thead><tr><th>Next {res.hours} h</th><th>As now</th><th>With changes</th><th /></tr></thead>
        <tbody>
          {ROWS.map((r) => {
            const a = res.baseline[r.key] as number | null, b = res.variant[r.key] as number | null;
            const c = diffCell(game, r, a, b);
            return <tr key={r.key}><td>{r.label}</td><td>{a === null ? '–' : r.fmt(game, a)}</td><td>{b === null ? '–' : r.fmt(game, b)}</td><td className={c.cls}>{c.text}</td></tr>;
          })}
        </tbody>
      </table>
      {res.lines.length > 0 && (
        <table className="pn-table" style={{ marginTop: 8 }}>
          <thead><tr><th>Line</th><th>Riders</th><th>Average wait</th></tr></thead>
          <tbody>
            {res.lines.map((l) => (
              <tr key={l.route}>
                <td><LineBadge colour={game.state.routes[l.route]?.colour ?? '#888'} size="sm">{l.number}</LineBadge></td>
                <td>{l.before.boardings.toLocaleString('en-GB')} → {l.after.boardings.toLocaleString('en-GB')}</td>
                <td>{l.before.wait === null ? '–' : `${l.before.wait.toFixed(1)}`} → {l.after.wait === null ? '–' : `${l.after.wait.toFixed(1)} min`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {res.problems.map((p, i) => <div className="pn-warn" key={i} style={{ marginTop: 6 }}>{p}</div>)}
      {(res.variant.missed ?? 0) > (res.baseline.missed ?? 0) && <div className="pn-note" style={{ marginTop: 6 }}>New timetables start at once, so some departures in the first hour are missed while buses get into place.</div>}
      <div className="pn-note" style={{ marginTop: 6 }}>Operating result is fares minus running costs; buses bought are not in it. Took {(res.wallMs / 1000).toFixed(1)} s.</div>
    </div>
  );
}
