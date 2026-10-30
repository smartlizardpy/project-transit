// Small shared pieces of Automation Studio: category chips, switches, time labels.
import type { ReactNode } from 'react';
import {
  Lightning, Database, GitBranch, Calculator, Notebook, Bus, PuzzlePiece, Check, Warning, X, Eye, Lightbulb, Robot,
} from '@phosphor-icons/react';
import type { Category } from '../../game/automation/registry.ts';
import { NODE, CATEGORIES } from '../../game/automation/registry.ts';
import type { Mode, RunRecord } from '../../game/automation/types.ts';
import { DAY } from '../../game/content.ts';
import { hhmm } from '../../game/time.ts';
import '../../styles/automation.css';

export const CAT_ICON: Record<Category, typeof Bus> = {
  trigger: Lightning, data: Database, logic: GitBranch, math: Calculator, state: Notebook, action: Bus, advanced: PuzzlePiece,
};

export function CatChip({ cat, size = 14 }: { cat: Category; size?: number }) {
  const Icon = CAT_ICON[cat];
  return <span className={`st-chip cat-${cat}`}><Icon size={size} weight="bold" /></span>;
}

export const catLabel = (c: Category) => CATEGORIES.find((x) => x.id === c)?.label ?? c;
export const nodeTitle = (n: { type: string; label?: string }) => n.label || NODE[n.type]?.label || n.type;

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`mn-switch ${on ? 'on' : ''}`} style={disabled ? { opacity: 0.45 } : undefined} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

export const MODE_INFO: Record<Mode, { label: string; short: string; long: string; Icon: typeof Eye }> = {
  observe: { label: 'Observe', short: 'Records only', long: 'Watches and records what it would do. Nothing in the game changes.', Icon: Eye },
  suggest: { label: 'Suggest', short: 'Asks you first', long: 'Turns what it would do into suggestions that wait for your approval.', Icon: Lightbulb },
  automatic: { label: 'Automatic', short: 'Acts by itself', long: 'Acts by itself, with the same rules as when you do it. Big changes still wait for approval unless you allow them.', Icon: Robot },
};

export function ModeTag({ mode }: { mode: Mode }) {
  const m = MODE_INFO[mode];
  return <span className={`pn-tag st-mode-${mode}`}>{m.label}</span>;
}

/** "Day 31, 07:45" */
export const whenLabel = (t: number) => `Day ${Math.floor(t / DAY) + 1}, ${hhmm(t)}`;

export function StatusTag({ run }: { run: RunRecord }) {
  if (run.status === 'error') return <span className="pn-tag bad">Failed</span>;
  if (run.status === 'limit') return <span className="pn-tag warn">Limit reached</span>;
  return <span className="pn-tag good">Ran</span>;
}

export function IssueIcon({ level }: { level: 'error' | 'warning' | 'ok' }) {
  if (level === 'ok') return <Check size={13} weight="bold" />;
  if (level === 'error') return <X size={13} weight="bold" />;
  return <Warning size={13} weight="bold" />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="pn-empty">{children}</div>;
}

/** Plain text of a value for the debugger. */
export function showValue(v: unknown): string {
  if (v === null || v === undefined) return 'nothing';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}${v.length ? `: ${v.slice(0, 3).map(showValue).join(', ')}${v.length > 3 ? '…' : ''}` : ''}`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.name) return String(o.name);
    if (o.fleetNo) return String(o.fleetNo);
    if (o.number !== undefined && o.kind === 'line') return `Line ${o.number}`;
    return Object.entries(o).slice(0, 4).map(([k, x]) => `${k}: ${showValue(x)}`).join(', ');
  }
  return String(v);
}

