import { useState, type ReactNode } from 'react';
import type { Game } from '../../game/engine.ts';
import type { QueryResult, Row } from '../../game/analytics/query.ts';
import { ColHead, Val, colValue, sortRows, type Col } from './common.tsx';

/** A sortable table of query rows. Missing values show a dash with the reason. */
export function DataTable({ game, res, rows, cols, name, head, selected, onPick, total = true, limit = 40, initial }: {
  game: Game; res: QueryResult | null; rows: Row[]; cols: Col[]; name: (r: Row) => ReactNode; head: string;
  selected?: string | null; onPick?: (r: Row) => void; total?: boolean; limit?: number; initial: string;
}) {
  const [sort, setSort] = useState<{ id: string; dir: number }>({ id: initial, dir: -1 });
  const [more, setMore] = useState(false);
  const col = cols.find((c) => c.id === sort.id) ?? cols[0];
  const sorted = sortRows(rows, (r) => (col ? colValue(col, r) : null), sort.dir);
  const shown = more ? sorted : sorted.slice(0, limit);
  const onSort = (id: string) => setSort((s) => (s.id === id ? { id, dir: -s.dir } : { id, dir: -1 }));
  const note = res?.notes[0];
  return (
    <div className="nc-scroll">
      <table className="pn-table nc-table">
        <thead><tr><th>{head}</th>{cols.map((c) => <ColHead key={c.id} c={c} sort={sort} onSort={onSort} />)}</tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.key} className={`${onPick ? 'click' : ''} ${selected && r.id === selected ? 'on' : ''}`} onClick={() => onPick?.(r)}>
              <td className="name">{name(r)}</td>
              {cols.map((c) => <td key={c.id}><Val game={game} bare m={c.custom ? { unit: c.unit, decimals: c.custom.decimals } : c} v={colValue(c, r)} note={note} /></td>)}
            </tr>
          ))}
          {total && res && rows.length > 1 && (
            <tr className="tot">
              <td className="name">All</td>
              {cols.map((c) => <td key={c.id}><Val game={game} bare m={c.custom ? { unit: c.unit, decimals: c.custom.decimals } : c} v={colValue(c, res.total)} note={note} /></td>)}
            </tr>
          )}
        </tbody>
      </table>
      {sorted.length > limit && <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setMore(!more)}>{more ? 'Show fewer' : `Show all ${sorted.length}`}</button>}
    </div>
  );
}
