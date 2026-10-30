// Controls for node settings. One control per registry field kind.
import { useMemo } from 'react';
import type { Game } from '../../game/engine.ts';
import type { ConfigField } from '../../game/automation/registry.ts';
import type { Value } from '../../game/automation/types.ts';
import { MEASURES } from '../../game/analytics/query.ts';
import { checkExpr } from '../../game/expr.ts';
import { Switch } from './common.tsx';

const lineName = (game: Game, id: string) => { const r = game.state.routes[id]; return r ? `Line ${r.number} ${r.name}` : 'Removed line'; };

export function FieldControl({ game, field, value, onChange, connected }: {
  game: Game; field: ConfigField; value: Value | undefined; onChange: (v: Value) => void; connected?: boolean;
}) {
  const v = value === undefined ? field.default : value;
  const any = field.allowAny ? [{ value: '', label: 'Any' }] : [{ value: '', label: 'Choose…' }];
  const select = (opts: { value: string; label: string }[]) => (
    <select className="pn-select" value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} aria-label={field.label}>
      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  switch (field.kind) {
    case 'number':
      return (
        <div className="st-numrow">
          <input className="pn-input" type="number" value={typeof v === 'number' ? v : ''} min={field.min} max={field.max} step={field.step ?? 1} aria-label={field.label}
            onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))} />
          {field.unit && <span className="faint">{field.unit}</span>}
        </div>
      );
    case 'text': return <input className="pn-input" value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} aria-label={field.label} />;
    case 'textarea': return <textarea className="pn-input st-area" rows={3} value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} aria-label={field.label} />;
    case 'boolean': return <Switch on={!!v} onChange={onChange} label={field.label} />;
    case 'select': return select(field.options ?? []);
    case 'time': return <input className="pn-input" type="time" value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} aria-label={field.label} />;
    case 'line': return select([...any, ...Object.values(game.state.routes).map((r) => ({ value: r.id, label: lineName(game, r.id) }))]);
    case 'stop': return select([...any, ...Object.values(game.state.stops).map((s) => ({ value: s.id, label: s.name }))]);
    case 'vehicle': return select([...any, ...game.vehicleList().map((b) => ({ value: b.id, label: `Bus ${b.fleetNo}` }))]);
    case 'depot': return select([...any, ...Object.values(game.state.depots).map((d) => ({ value: d.id, label: d.name ?? d.id }))]);
    case 'workflow': return select([{ value: '', label: 'Choose a function…' }, ...game.workflowList().filter((w) => w.kind === 'function').map((w) => ({ value: w.id, label: w.name }))]);
    case 'measure': return select(MEASURES.map((m) => ({ value: m.id, label: m.label })));
    case 'expr': return <ExprField field={field} value={String(v ?? '')} onChange={onChange} />;
  }
  void connected;
  return null;
}

function ExprField({ field, value, onChange }: { field: ConfigField; value: string; onChange: (v: Value) => void }) {
  const res = useMemo(() => checkExpr(value, field.vars ?? []), [value, field.vars]);
  return (
    <div className="st-expr">
      <input className={`pn-input st-mono ${res.ok ? '' : 'bad'}`} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} aria-label={field.label} />
      {!res.ok && (
        <div className="st-exprerr">
          <span className="st-caret" style={{ paddingLeft: `${Math.min(res.at, 60)}ch` }}>^</span>
          {res.error}
        </div>
      )}
      {res.ok && <div className="st-exprok">Formula is valid{field.vars?.length ? ` · you can use ${field.vars.join(', ')}` : ''}</div>}
    </div>
  );
}
