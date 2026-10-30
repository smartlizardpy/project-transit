import { useState } from 'react';
import type { Game } from '../../game/engine.ts';
import type { SavedReport } from '../../game/analytics/query.ts';
import { useUI } from '../../state/store.ts';

/** "Save as report": the current view (query, comparison or journeys) with its columns. */
export function SaveReport({ game, kind, query, compare, od, columns, suggest }: {
  game: Game; kind: SavedReport['kind']; query?: SavedReport['query']; compare?: SavedReport['compare']; od?: SavedReport['od']; columns: string[]; suggest: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const save = () => {
    const r = game.saveReport({ name: name.trim() || suggest, kind, query, compare, od, columns });
    if (!r.ok) return useUI.getState().notify(r.error, 'warn');
    useUI.getState().notify('Report saved. Find it under Reports.', 'good');
    setOpen(false);
    setName('');
  };
  if (!open) return <button className="btn sm" onClick={() => setOpen(true)}>Save as report</button>;
  return (
    <span className="nc-split">
      <input className="pn-input" style={{ width: 170 }} autoFocus placeholder={suggest} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      <button className="btn sm primary" onClick={save}>Save</button>
      <button className="btn sm" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}
