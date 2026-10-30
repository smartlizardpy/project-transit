// Network Control: analytics for the whole company (left panel, wide variant).
import { useEffect } from 'react';
import { Check, ChartLineUp, UsersThree, MapPinLine, Bus, Gauge } from '@phosphor-icons/react';
import type { Game } from '../../game/engine.ts';
import { useUI, type NetworkTab } from '../../state/store.ts';
import { Segmented } from '../primitives.tsx';
import { unlockProgress, companyLevel, LEVELS } from '../../game/control.ts';
import { AutomationTab } from '../automation/AutomationTab.tsx';
import { Head } from './common.tsx';
import { Overview } from './Overview.tsx';
import { Passengers } from './Passengers.tsx';
import { Stops } from './Stops.tsx';
import { Lines } from './Lines.tsx';
import { Fleet } from './Fleet.tsx';
import { Reports } from './Reports.tsx';
import '../../styles/network.css';

const TABS: { value: NetworkTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'passengers', label: 'Passengers' },
  { value: 'stops', label: 'Stops' },
  { value: 'lines', label: 'Lines' },
  { value: 'fleet', label: 'Fleet' },
  { value: 'reports', label: 'Reports' },
  { value: 'automation', label: 'Automation' },
];

export function NetworkControl({ game }: { game: Game }) {
  const unlocked = game.state.control.unlocked;
  const tab = useUI((s) => s.networkTab);
  const setTab = useUI((s) => s.setNetworkTab);
  // the map flows belong to the Passengers tab and to this panel only
  useEffect(() => () => useUI.getState().setFlowOverlay(null), []);
  useEffect(() => { if (tab !== 'passengers') useUI.getState().setFlowOverlay(null); }, [tab]);
  if (!unlocked) return <Locked game={game} />;
  const a = game.state.analytics;
  return (
    <>
      <Head title="Network Control" sub={`${a.days.length} days of history · recording since day ${a.since + 1}`} />
      <div className="p-body">
        <div className="nc-tabs"><Segmented value={tab} onChange={setTab} options={TABS} /></div>
        {tab === 'overview' && <Overview game={game} />}
        {tab === 'passengers' && <Passengers game={game} />}
        {tab === 'stops' && <Stops game={game} />}
        {tab === 'lines' && <Lines game={game} />}
        {tab === 'fleet' && <Fleet game={game} />}
        {tab === 'reports' && <Reports game={game} />}
        {tab === 'automation' && <AutomationTab game={game} />}
      </div>
    </>
  );
}

// ───────────────────────────────────────── locked

function Locked({ game }: { game: Game }) {
  const p = unlockProgress(game);
  const a = game.state.analytics;
  const daysOk = p.days >= p.required;
  const levelOk = p.level >= p.requiredLevel;
  const rep = Math.floor(p.reputation);
  const lv = companyLevel(p.reputation);
  return (
    <>
      <Head title="Network Control" sub="Opens after 30 operating days at level 3" />
      <div className="p-body">
        <div className="section nc-prog">
          <div className="section-head" style={{ marginBottom: 0 }}>
            <span className="nc-sub">Operating days</span>
            {daysOk && <span className="pn-tag good">Done</span>}
          </div>
          <div className="nc-big">{p.days}<small> / {p.required} days</small></div>
          <div className={`pn-bar ${daysOk ? 'good' : ''}`}><i style={{ width: `${(p.days / p.required) * 100}%` }} /></div>
          <div className="pn-note">
            A day counts when buses carry at least 25 passengers and finish a trip. {p.today.qualifies
              ? 'Today counts already.'
              : `Today counts once 25 passengers board and a trip completes (${p.today.boardings} boarded, ${p.today.trips} trip${p.today.trips === 1 ? '' : 's'} so far).`}
          </div>
        </div>

        <div className="section nc-prog">
          <div className="section-head" style={{ marginBottom: 0 }}>
            <span className="nc-sub">Company level</span>
            {levelOk && <span className="pn-tag good">Done</span>}
          </div>
          <div className="row"><span className="k">Now</span><span className="v">Level {lv.level} · {lv.title}</span></div>
          <div className="row"><span className="k">Needed</span><span className="v">Level {p.requiredLevel} · {LEVELS[p.requiredLevel - 1].title} · reputation {p.reputationNeeded}</span></div>
          <div className={`pn-bar ${levelOk ? 'good' : ''}`}><i style={{ width: `${Math.min(100, (rep / p.reputationNeeded) * 100)}%` }} /></div>
          <div className="pn-note">Reputation {rep} of {p.reputationNeeded}. It grows with satisfied passengers and reliable service.</div>
        </div>

        <div className="section">
          <div className="section-head"><span className="nc-sub">What it offers</span></div>
          <ul className="nc-steps">
            <li><ChartLineUp size={16} weight="bold" /><span><b>Overview and trends.</b> Boardings, waits, punctuality, fares and costs, compared with the period before.</span></li>
            <li><UsersThree size={16} weight="bold" /><span><b>Where passengers go.</b> Observed journeys between stops and areas, drawn as flows on the map.</span></li>
            <li><MapPinLine size={16} weight="bold" /><span><b>Stops and lines.</b> Waits, loads and run times per segment, and side-by-side comparisons of periods.</span></li>
            <li><Bus size={16} weight="bold" /><span><b>Fleet.</b> How each bus spends its day, and who assigned it where.</span></li>
            <li><Gauge size={16} weight="bold" /><span><b>Your own metrics, reports and automations.</b></span></li>
          </ul>
        </div>

        <div className="pn-note" style={{ padding: '0 4px' }}>
          <Check size={12} weight="bold" style={{ verticalAlign: -1, marginRight: 4 }} />
          Analytics are already being recorded: {a.days.length} full day{a.days.length === 1 ? '' : 's'} so far, from day {a.since + 1}. Nothing is lost while you wait.
        </div>
      </div>
    </>
  );
}
