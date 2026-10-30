// Node library: search, category sections, click or drag to add.
import { useMemo, useState } from 'react';
import { MagnifyingGlass, CaretDown, CaretRight } from '@phosphor-icons/react';
import { NODES, CATEGORIES, type Category } from '../../game/automation/registry.ts';
import { CatChip } from './common.tsx';

export function Library({ kind, onAdd, searchRef }: { kind: 'workflow' | 'function'; onAdd: (type: string) => void; searchRef?: React.Ref<HTMLInputElement> }) {
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<Category>>(new Set());
  const query = q.trim().toLowerCase();
  const groups = useMemo(() => CATEGORIES.map((c) => ({
    ...c,
    nodes: NODES.filter((n) => n.category === c.id && !(kind === 'function' && n.trigger) && !(kind === 'workflow' && (n.type === 'adv.input' || n.type === 'adv.output'))
      && (!query || `${n.label} ${n.description} ${c.label} ${n.inputs.map((p) => p.label).join(' ')} ${n.outputs.map((p) => p.label).join(' ')}`.toLowerCase().includes(query))),
  })).filter((c) => c.nodes.length), [query, kind]);
  const total = groups.reduce((n, g) => n + g.nodes.length, 0);
  return (
    <div className="st-side left">
      <div className="st-side-head">
        <span className="label">Add a step</span>
        <div className="st-search">
          <MagnifyingGlass size={14} weight="bold" />
          <input ref={searchRef} className="pn-input" placeholder="Search nodes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search nodes" />
        </div>
      </div>
      <div className="st-scroll">
        {groups.map((g) => {
          const open = !!query || !closed.has(g.id);
          return (
            <div className="st-cat" key={g.id}>
              <button className="st-cat-head" onClick={() => setClosed((s) => { const n = new Set(s); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })} aria-expanded={open}>
                {open ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
                <span className="grow">{g.label}</span><span>{g.nodes.length}</span>
              </button>
              {open && g.nodes.map((n) => (
                <button key={n.type} className="st-lib-item" draggable title={n.description}
                  onDragStart={(e) => { e.dataTransfer.setData('application/pt-node', n.type); e.dataTransfer.effectAllowed = 'copy'; }}
                  onClick={() => onAdd(n.type)}>
                  <CatChip cat={n.category} />
                  <span><b>{n.label}</b><span className="d">{n.description}</span></span>
                </button>
              ))}
            </div>
          );
        })}
        {total === 0 && <div className="pn-note" style={{ padding: '10px 14px' }}>No node matches “{q}”. Try a word like “bus”, “line”, “compare” or “notify”.</div>}
      </div>
      <div className="st-hint">Click a node to add it, or drag it onto the canvas. Drag from a round point to another to connect.</div>
    </div>
  );
}
