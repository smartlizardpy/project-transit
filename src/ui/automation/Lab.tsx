// Simulation Lab: try the saved workflow on two copies of the company and compare them.
import { useRef, useState } from 'react';
import { Flask } from '@phosphor-icons/react';
import type { Game } from '../../game/engine.ts';
import { runLab, LAB_HOURS, type LabMetrics, type LabResult } from '../../game/automation/lab.ts';
import type { Workflow } from '../../game/automation/types.ts';
import { OUTCOME_LABEL } from '../../game/automation/executor.ts';
import { Segmented } from '../primitives.tsx';
import { RunRow } from './Runs.tsx';
import { ModeTag, Switch, Empty } from './common.tsx';

type Row = { key: keyof LabMetrics; label: string; better: 'higher' | 'lower'; fmt: (g: Game, v: number | null) => string; unit?: string };
const n0 = (_g: Game, v: number | null) => (v === null ? '–' : Math.round(v).toLocaleString());
const pct = (_g: Game, v: number | null) => (v === null ? '–' : `${v.toFixed(1)}%`);
const rows: Row[] = [
  { key: 'journeys', label: 'Journeys completed', better: 'higher', fmt: n0 },
  { key: 'boardings', label: 'Boardings', better: 'higher', fmt: n0 },
  { key: 'abandoned', label: 'Passengers who gave up', better: 'lower', fmt: n0 },
  { key: 'trips', label: 'Trips run', better: 'higher', fmt: n0 },
  { key: 'missed', label: 'Departures missed', better: 'lower', fmt: n0 },
  { key: 'onTime', label: 'On time', better: 'higher', fmt: pct },
  { key: 'avgWait', label: 'Average wait', better: 'lower', fmt: (_g, v) => (v === null ? '–' : `${v.toFixed(1)} min`) },
  { key: 'avgLoad', label: 'Average load', better: 'lower', fmt: pct },
  { key: 'satisfaction', label: 'Satisfaction', better: 'higher', fmt: pct },
  { key: 'leftBehind', label: 'Left behind (bus full)', better: 'lower', fmt: n0 },
  { key: 'fares', label: 'Fares collected', better: 'higher', fmt: (g, v) => (v === null ? '–' : g.money(v)) },
  { key: 'result', label: 'Result after all costs', better: 'higher', fmt: (g, v) => (v === null ? '–' : g.money(v)) },
];

function diff(g: Game, r: Row, a: number | null, b: number | null) {
  if (a === null || b === null) return { text: '–', cls: 'st-flat' };
  const d = b - a;
  if (Math.abs(d) < 1e-9) return { text: 'no change', cls: 'st-flat' };
  const good = r.better === 'higher' ? d > 0 : d < 0;
  const body = r.key === 'fares' || r.key === 'result' ? g.money(Math.abs(d)) : r.key === 'avgWait' ? `${Math.abs(d).toFixed(1)} min` : r.fmt(g, Math.abs(d));
  return { text: r.fmt === pct ? `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} pts` : `${d > 0 ? '+' : '−'}${body}`, cls: good ? 'st-good' : 'st-bad' };
}

export function Lab({ game, wf, saved }: { game: Game; wf: Workflow; saved: boolean }) {
  const [hours, setHours] = useState<number>(4);
  const [as, setAs] = useState<'automatic' | 'current'>('automatic');
  const [approve, setApprove] = useState(true);
  const [high, setHigh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pct_, setPct] = useState(0);
  const [res, setRes] = useState<LabResult | null>(null);
  const [err, setErr] = useState('');
  const stop = useRef(false);
  const val = game.validateWorkflow(wf.id);
  const blocked = wf.kind !== 'workflow' ? 'This is a function. Try the workflow that uses it.' : !saved ? 'Save your changes first: the Lab tries the saved workflow.' : val && !val.ok ? 'Fix the problems in this workflow first.' : '';

  const run = async () => {
    stop.current = false; setBusy(true); setErr(''); setPct(0);
    try {
      const r = await runLab(game, wf.id, { hours, mode: as, approveSuggestions: approve, allowHighImpact: high }, setPct, () => stop.current);
      if (r) setRes(r);
    } catch (e) { setErr(e instanceof Error ? e.message : 'The lab could not run.'); }
    setBusy(false);
  };

  return (
    <div className="st-view"><div className="st-view-inner">
      <div className="st-sec">
        <h4>Simulation Lab · {wf.name}</h4>
        <div className="pn-note">The Lab copies your company as it is now and plays the next few hours twice on the copies: once without this workflow, once with it. Your real company is not touched. It shows <b>one possible future</b>, not a forecast.</div>
        <div className="st-formrow">
          <div className="st-field"><span className="lbl">Game hours to play</span>
            <Segmented value={String(hours)} onChange={(v) => setHours(Number(v))} options={LAB_HOURS.map((h) => ({ value: String(h), label: `${h} h`, disabled: busy }))} />
          </div>
          <div className="st-field"><span className="lbl">How it acts</span>
            <Segmented value={as} onChange={setAs} options={[{ value: 'automatic', label: 'Try as if Automatic', disabled: busy }, { value: 'current', label: 'Use its own mode', disabled: busy }]} />
          </div>
        </div>
        <div className="st-formrow">
          <label className="st-check"><Switch on={approve} onChange={setApprove} label="Approve suggestions" disabled={busy} />Approve suggestions in the copy</label>
          <label className="st-check"><Switch on={high} onChange={setHigh} label="Allow big changes" disabled={busy} />Allow big changes in the copy</label>
        </div>
        <div className="pn-actions">
          <button className="btn primary" disabled={busy || !!blocked} onClick={run}><Flask size={15} weight="bold" />Run the Lab</button>
          {busy && <button className="btn" onClick={() => { stop.current = true; }}>Cancel</button>}
          {busy && <div className="st-prog" style={{ flex: 1 }}><div className="pn-bar"><i style={{ width: `${pct_ * 100}%` }} /></div><span className="faint num">{Math.round(pct_ * 100)}%</span></div>}
        </div>
        {blocked && <div className="pn-note">{blocked}</div>}
        {err && <div className="pn-warn bad">{err}</div>}
      </div>

      {!res && !busy && <Empty>No comparison yet. Run the Lab to see what this workflow would have changed over the next {hours} game hours.</Empty>}
      {res && (
        <>
          <div className="st-sec">
            <h4>Without the workflow and with it · {res.label}</h4>
            <div className="pn-actions"><ModeTag mode={res.mode} /><span className="pn-note">{res.runs} run{res.runs === 1 ? '' : 's'} in the copy{res.extras ? ` · ${res.extras} extra departure${res.extras === 1 ? '' : 's'}` : ''} · took {(res.wallMs / 1000).toFixed(1)} s</span></div>
            <table className="st-cmp">
              <thead><tr><th>Measure</th><th>Without</th><th>With workflow</th><th>Difference</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const a = res.baseline[r.key], b = res.variant[r.key];
                  const d = diff(game, r, a, b);
                  return <tr key={r.key}><td>{r.label}</td><td>{r.fmt(game, a)}</td><td>{r.fmt(game, b)}</td><td className={d.cls}>{d.text}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
          <div className="st-sec">
            <h4>Read this first</h4>
            <ul className="st-notes">{res.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </div>
          <div className="st-sec">
            <h4>What the workflow asked for in the copy</h4>
            {Object.keys(res.outcomes).length === 0 ? <div className="pn-note">It did not ask for anything over these hours.</div> : (
              <div className="pn-actions">
                {(Object.entries(res.outcomes) as [keyof typeof OUTCOME_LABEL, number][]).map(([k, v]) => <span key={k} className="pn-tag">{OUTCOME_LABEL[k]} · {v}</span>)}
              </div>
            )}
            {res.samples.length > 0 && <div className="st-runs">{res.samples.slice(0, 6).map((r) => <RunRow key={r.id} game={game} run={r} />)}</div>}
          </div>
        </>
      )}
    </div></div>
  );
}
