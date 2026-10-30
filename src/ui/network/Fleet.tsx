import { useState } from 'react';
import type { Game } from '../../game/engine.ts';
import { useUI } from '../../state/store.ts';
import { focusVehicle } from '../camera.ts';
import { hhmm } from '../../game/time.ts';
import { DAY } from '../../game/content.ts';
import { LineBadge } from '../primitives.tsx';
import { FilterBar, Notes, SectionHead, Val, columns, lineLabel, toQuery, useAgg, useNC, vehName } from './common.tsx';

const COLS = ['utilisation', 'km', 'boardings', 'revenue', 'vehicleCost'];

export function Fleet({ game }: { game: Game }) {
  const f = useNC((s) => s.f);
  const q = { ...toQuery({ ...f, line: '', time: 'all' }, game, 'vehicle'), hours: null };
  const res = useAgg(game, q);
  const rows = (res?.rows ?? []).filter((r) => r.id && (game.state.vehicles[r.id] || (r.values.km ?? 0) > 0));
  const cols = columns(game, COLS, []);
  const [sel, setSel] = useState<string | null>(null);
  const pick = (id: string) => { setSel(id); if (game.state.vehicles[id]) { useUI.getState().select({ kind: 'vehicle', id }); focusVehicle(id); } };
  const asg = game.state.analytics.assignments.slice(-16).reverse();
  const wf = (src: string) => (src === 'player' ? 'You' : (game.state.automation?.workflows?.[src]?.name ?? 'Automation'));
  const lineTag = (id: string | null) => {
    if (!id) return <span className="faint">Depot</span>;
    const r = game.state.routes[id];
    return r ? <LineBadge colour={r.colour} size="sm">{r.number}</LineBadge> : <span className="faint">{lineLabel(game, id)}</span>;
  };
  return (
    <>
      <FilterBar game={game} time={false} res={res} />
      <div className="section">
        <SectionHead title="How each bus spends its day" right={
          <span className="pn-legend">
            <span><i style={{ background: 'var(--accent)' }} />in service</span><span><i style={{ background: 'var(--mint)' }} />layover</span>
            <span><i style={{ background: 'var(--amber)' }} />positioning</span><span><i style={{ background: '#56655c' }} />parked</span><span><i style={{ background: 'var(--coral)' }} />workshop</span>
          </span>
        } />
        {rows.length === 0 ? <div className="pn-note">No buses recorded in this selection.</div> : (
          <div className="nc-scroll">
            <table className="pn-table nc-table">
              <thead><tr><th>Bus</th><th style={{ textAlign: 'left' }}>Day split</th>{cols.map((c) => <th key={c.id} title={`${c.describe} ${c.source === 'derived' ? 'Derived from recorded minutes and distance at ledger rates; not booked in the ledger.' : ''}`}>{c.label}{c.source === 'derived' && <i className="nc-src derived" />}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => {
                  const v = r.values;
                  const parts = [['sv', v.serviceHours], ['ly', v.layoverHours], ['dh', v.deadheadHours], ['pk', v.idleHours], ['mt', v.downHours]] as const;
                  const total = parts.reduce((s, [, x]) => s + (x ?? 0), 0);
                  const veh = game.state.vehicles[r.id!];
                  const line = veh?.route ? game.state.routes[veh.route] : null;
                  return (
                    <tr key={r.key} className={`click ${sel === r.id ? 'on' : ''}`} onClick={() => pick(r.id!)}>
                      <td className="name"><span className="nc-name"><span>{r.label}</span>{line && <LineBadge colour={line.colour} size="sm">{line.number}</LineBadge>}</span></td>
                      <td style={{ textAlign: 'left', width: 150 }}>
                        <div className="nc-stack" title={parts.map(([k, x]) => `${{ sv: 'In service', ly: 'Layover', dh: 'Positioning', pk: 'Parked', mt: 'Workshop' }[k]} ${(x ?? 0).toFixed(1)} h`).join(' · ')}>
                          {total > 0 && parts.map(([k, x]) => <i key={k} className={k} style={{ width: `${((x ?? 0) / total) * 100}%` }} />)}
                        </div>
                      </td>
                      {cols.map((c) => <td key={c.id}><Val game={game} m={c} v={v[c.id] ?? null} /></td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="nc-hint" style={{ marginTop: 8 }}>Running cost is derived: driver hours and energy at the ledger rates, plus maintenance spent and the daily fleet charge. It is not a booked ledger figure.</div>
      </div>
      <Notes res={res} />
      <div className="section">
        <SectionHead title="Assignment history" right={<span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>latest {asg.length}</span>} />
        {asg.length === 0 ? <div className="pn-note">No bus has been moved between lines since recording began.</div> : (
          <table className="pn-table nc-table">
            <thead><tr><th>When</th><th>Bus</th><th style={{ textAlign: 'left' }}>Change</th><th>By</th></tr></thead>
            <tbody>
              {asg.map((e, i) => (
                <tr key={i}>
                  <td>Day {Math.floor(e.t / DAY) + 1} · {hhmm(e.t)}</td>
                  <td className="name">{vehName(game, e.v)}</td>
                  <td style={{ textAlign: 'left' }}><span className="nc-name">{lineTag(e.from)}<span className="faint">→</span>{lineTag(e.to)}</span></td>
                  <td>{wf(e.src)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

