// The Network Control milestone card shown once both unlock requirements are met, and its
// optional three-step tour. Calm: no animation beyond the usual card fade, no sound.
import { ChartLineUp, UsersThree, Bus, Gauge } from '@phosphor-icons/react';
import { useGameUpdates } from './hooks.ts';
import { useUI, type NetworkTab } from '../state/store.ts';
import { useSession } from '../app/session.ts';
import { companyLevel } from '../game/control.ts';
import '../styles/network.css';

const TOUR: { tab: NetworkTab; title: string; body: string }[] = [
  { tab: 'overview', title: '1 of 3 · Filters and overview', body: 'Pick a period, the days of the week and a time of day. Every figure on every tab follows them, and changes compare with the period before. Top problems link to the line or stop on the map.' },
  { tab: 'passengers', title: '2 of 3 · Where passengers go', body: 'Journeys between stops or areas, drawn as flows on the map. Solid arcs are journeys your buses carried; dashed arcs are estimated demand, a model rather than an observation.' },
  { tab: 'lines', title: '3 of 3 · Lines and comparisons', body: 'Select a line to see its busiest hours, load and run time on each segment, and compare two periods, for example Monday mornings against Friday evenings.' },
];

export function NetworkUnlock() {
  const game = useGameUpdates(1);
  const phase = useSession((s) => s.phase);
  const panel = useUI((s) => s.panel);
  if (!game || phase !== 'playing') return null;
  const c = game.state.control;
  const a = game.state.analytics;

  if (c.unlocked && c.introSeen && panel === 'network' && c.tour >= 0 && c.tour < TOUR.length) {
    const i = c.tour;
    const step = TOUR[i];
    const go = (n: number) => {
      game.setNetworkIntro({ tour: n });
      if (n < TOUR.length) useUI.getState().setNetworkTab(TOUR[n].tab);
    };
    return (
      <div className="card nc-tour" role="dialog" aria-label="Network Control tour">
        <div className="head"><span className="label">{step.title}</span></div>
        <div className="pn-note">{step.body}</div>
        <div className="acts">
          <button className="btn sm" onClick={() => game.setNetworkIntro({ tour: 99 })}>Skip tour</button>
          <button className="btn sm primary" onClick={() => go(i + 1 < TOUR.length ? i + 1 : 99)}>{i + 1 < TOUR.length ? 'Next' : 'Done'}</button>
        </div>
      </div>
    );
  }

  if (!c.unlocked || c.introSeen) return null;
  let journeys = 0;
  for (const d of [...a.days, a.today]) for (const x of d.net.j) journeys += x;
  const close = () => game.setNetworkIntro({ seen: true });
  const open = (tour: boolean) => {
    game.setNetworkIntro({ seen: true, ...(tour ? { tour: 0 } : {}) });
    const ui = useUI.getState();
    ui.setNetworkTab('overview');
    ui.openPanel('network');
  };
  return (
    <div className="gameover-scrim">
      <div className="card gameover nc-unlock" role="dialog" aria-modal="true" aria-label="Network Control is available" style={{ textAlign: 'left', alignItems: 'stretch' }}>
        <div className="go-icon"><ChartLineUp size={26} weight="bold" /></div>
        <div>
          <div className="p-title" style={{ fontSize: 20 }}>Network Control is open</div>
          <div className="p-sub" style={{ marginTop: 6 }}>After {c.days.count} operating days as a level {companyLevel(game.state.company.reputation).level} company, there is a real history to study. All of it was recorded as it happened.</div>
        </div>
        <div className="go-stats" style={{ justifyContent: 'flex-start' }}>
          <div><b>{a.days.length}</b><span>days recorded</span></div>
          <div><b>{journeys.toLocaleString('en-GB')}</b><span>journeys</span></div>
          <div><b>{Object.keys(game.state.routes).length}</b><span>lines</span></div>
          <div><b>{Object.keys(game.state.stops).length}</b><span>stops</span></div>
        </div>
        <ul className="nc-steps">
          <li><UsersThree size={16} weight="bold" /><span><b>Where passengers go</b> and where they give up, by stop or area.</span></li>
          <li><Bus size={16} weight="bold" /><span><b>Crowding, delays and run times</b> segment by segment, line by line and bus by bus.</span></li>
          <li><Gauge size={16} weight="bold" /><span><b>Your own metrics and reports</b>, and automations that act on what you find.</span></li>
        </ul>
        <div className="actions">
          <button className="btn primary" onClick={() => open(false)}>Open Network Control</button>
          <button className="btn" onClick={() => open(true)}>Take a 3-step tour</button>
          <span className="grow" />
          <button className="btn" onClick={close}>Later</button>
        </div>
        <div className="pn-note">You can open it any time from the left tool bar, or with K.</div>
      </div>
    </div>
  );
}
