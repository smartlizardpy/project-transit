// Optional first-steps guide. Each step completes from real game state, so it never gets out
// of sync with what the player actually built. The player can dismiss it at any time.
import { Check, X, Warning } from '@phosphor-icons/react';
import { useGameUpdates } from './hooks.ts';
import { useUI } from '../state/store.ts';
import { session } from '../app/session.ts';
import { startDrafting } from './routeDraft.ts';
import type { Game } from '../game/engine.ts';
import { ECON } from '../game/content.ts';
import { useNewCompanyFlow } from './NewCompany.tsx';

interface Step {
  id: string;
  title: string;
  body: (g: Game) => string;
  done: (g: Game) => boolean;
  action?: { label: string; run: () => void };
}

const STEPS: Step[] = [
  {
    id: 'depot',
    title: 'Build a depot',
    body: (g) => `Buses park and are maintained at a depot. Pick the depot tool and click a street inside your licensed area (${g.money(ECON.depotCost, { compact: true })}).`,
    done: (g) => Object.keys(g.state.depots).length > 0,
    action: { label: 'Depot tool', run: () => useUI.getState().setTool('depot') },
  },
  {
    id: 'bus',
    title: 'Buy your first bus',
    body: () => 'Open Fleet → Buy. A City 12 is a good all-rounder; a Midi 10 is cheaper for quieter streets.',
    done: (g) => Object.keys(g.state.vehicles).length > 0,
    action: { label: 'Open fleet', run: () => useUI.getState().openPanel('fleet') },
  },
  {
    id: 'line',
    title: 'Draw a line',
    body: () => 'Pick the line tool and click stop spots (the round markers on the streets) in order, near homes, jobs, stations and schools. Turn on demand (P) to see where people are.',
    done: (g) => Object.keys(g.state.routes).length > 0,
    action: { label: 'Line tool', run: () => startDrafting(null) },
  },
  {
    id: 'assign',
    title: 'Assign buses to the line',
    body: () => 'Open the line and assign spare buses. The line panel tells you how many the timetable needs.',
    done: (g) => Object.values(g.state.routes).some((r) => r.vehicles.length > 0),
    action: { label: 'Open lines', run: () => useUI.getState().openPanel('lines') },
  },
  {
    id: 'run',
    title: 'Carry passengers',
    body: () => 'Press play (Space) and speed up time. Click a bus or stop to see what is happening. Watch satisfaction and the daily result.',
    done: (g) => g.state.stats.total.trips > 0,
  },
];

export function Onboarding() {
  const game = useGameUpdates(1);
  if (!game || !game.state.onboarding.active) return null;
  const idx = STEPS.findIndex((s) => !s.done(game));
  if (idx < 0) {
    game.state.onboarding.active = false;
    return null;
  }
  const step = STEPS[idx];
  return (
    <div className="card onboard" role="complementary" aria-label="First steps">
      <div className="ob-head">
        <span className="label">First steps · {idx + 1} of {STEPS.length}</span>
        <button className="close-btn" onClick={() => { game.state.onboarding.active = false; useUI.getState().notify('Guide hidden. You can play at your own pace.'); }} aria-label="Hide guide">
          <X size={13} weight="bold" />
        </button>
      </div>
      <ol className="ob-steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={i < idx ? 'done' : i === idx ? 'now' : ''}>
            <span className="ob-dot">{i < idx ? <Check size={11} weight="bold" /> : i + 1}</span>
            <span>{s.title}</span>
          </li>
        ))}
      </ol>
      <div className="ob-body">{step.body(game)}</div>
      {step.action && (
        <button className="btn sm primary" onClick={step.action.run}>{step.action.label}</button>
      )}
    </div>
  );
}

/** Shown when the company has gone bankrupt. */
export function GameOver() {
  const game = useGameUpdates(1);
  if (!game || game.state.company.status !== 'bankrupt') return null;
  const last = [...game.state.notifications].reverse().find((n) => n.title === 'Bankrupt');
  const days = Math.floor(game.t / 86400) + 1;
  return (
    <div className="gameover-scrim">
      <div className="card gameover" role="alertdialog" aria-modal="true" aria-label="Company bankrupt">
        <div className="go-icon"><Warning size={26} weight="fill" /></div>
        <div className="p-title">{game.state.company.name} has gone bankrupt</div>
        <div className="p-sub" style={{ marginTop: 6 }}>{last?.body ?? 'The company could not pay its debts.'}</div>
        <div className="go-stats">
          <div><b>{days}</b><span>days in business</span></div>
          <div><b>{game.state.stats.total.trips.toLocaleString()}</b><span>journeys carried</span></div>
          <div><b>{Object.keys(game.state.routes).length}</b><span>lines</span></div>
        </div>
        <div className="go-actions">
          <button className="btn" onClick={() => void session.quitToMenu(false)}>Main menu</button>
          <button
            className="btn primary"
            onClick={async () => {
              await session.quitToMenu(false);
              useNewCompanyFlow.setState({ open: true });
            }}
          >
            Start a new company
          </button>
        </div>
      </div>
    </div>
  );
}
