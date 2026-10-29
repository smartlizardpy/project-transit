import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function LineBadge({ colour, children, size }: { colour: string; children: ReactNode; size?: 'sm' | 'lg' }) {
  return (
    <span className={`line-badge ${size ?? ''}`} style={{ ['--c' as string]: colour }}>
      {children}
    </span>
  );
}

export function LoadBar({ value, marker = true, solid, colour }: { value: number; marker?: boolean; solid?: boolean; colour?: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className={`loadbar ${solid ? 'solid' : ''}`} style={{ ['--bar' as string]: colour }}>
      <i style={{ width: `${v * 100}%`, ['--full' as string]: `${v > 0 ? 100 / v : 100}%` }} />
      {marker && <em style={{ left: `${v * 100}%` }} />}
    </div>
  );
}

export interface SegOption<T extends string> { value: T; label: ReactNode; disabled?: boolean }

export function Segmented<T extends string>({ options, value, onChange, tone }: { options: SegOption<T>[]; value: T; onChange: (v: T) => void; tone?: 'money' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLButtonElement>(`button[data-v="${value}"]`);
    if (el) setInd({ x: el.offsetLeft, w: el.offsetWidth });
  }, [value, options.length]);
  return (
    <div className={`seg ${tone ?? ''}`} ref={ref}>
      {ind && <div className="seg-ind" style={{ width: ind.w, transform: `translateX(${ind.x - 3}px)`, left: 3 }} />}
      {options.map((o) => (
        <button key={o.value} data-v={o.value} className={o.value === value ? 'on' : ''} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tip({ label, k, hint, soon, side }: { label: string; k?: string; hint?: string; soon?: boolean; side?: 'below' | 'left' }) {
  return (
    <span className={`tip ${side ?? ''}`} role="tooltip">
      <span>
        {label}
        {soon && <> · <span className="soon">Not in demo</span></>}
        {hint && <small>{hint}</small>}
      </span>
      {k && <kbd>{k}</kbd>}
    </span>
  );
}

export function Kpi({ value, label, tone }: { value: ReactNode; label: string; tone?: 'mint' | 'coral' | 'amber' }) {
  return (
    <div className="kpi">
      <b className={tone ?? ''}>{value}</b>
      <span>{label}</span>
    </div>
  );
}
