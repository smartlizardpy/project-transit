import type { ReactNode } from 'react';

const S = { fill: 'none', stroke: '#fff', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function svg(size: number, children: ReactNode) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export const LOGOS: ((size: number) => ReactNode)[] = [
  // bridge arches over water
  (s) => svg(s, <g {...S}><path d="M3 12h18" /><path d="M5 12v-1M19 12v-1" /><path d="M3 12a4.5 5 0 0 1 9 0M12 12a4.5 5 0 0 1 9 0" /><path d="M3 17c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0" /></g>),
  // bus front
  (s) => svg(s, <g {...S}><rect x="5" y="4" width="14" height="14" rx="3" /><path d="M5 11h14" /><path d="M8 15h.01M16 15h.01" strokeWidth={2.6} /><path d="M7.5 20v-2M16.5 20v-2" /></g>),
  // route loop with stops
  (s) => svg(s, <g><path {...S} d="M7 6h10a4 4 0 0 1 0 8h-1.5M7 6a4 4 0 0 0 0 8h5" /><circle cx="7" cy="6" r="2" fill="#fff" /><circle cx="17" cy="14" r="2" fill="#fff" /><circle cx="12" cy="18" r="2" fill="#fff" /></g>),
  // compass rose
  (s) => svg(s, <g><circle cx="12" cy="12" r="8.5" {...S} /><path d="M12 5.5l2.2 6.5L12 18.5 9.8 12z" fill="#fff" /><path d="M5.5 12H8M16 12h2.5" {...S} /></g>),
  // wave
  (s) => svg(s, <g {...S}><path d="M3 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0" /><path d="M3 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0" /><path d="M3 19c2-2 4-2 6 0s4 2 6 0 4-2 6 0" opacity=".55" /></g>),
  // star junction
  (s) => svg(s, <g><path {...S} d="M12 3v18M3 12h18M6 6l12 12M18 6L6 18" opacity=".55" /><circle cx="12" cy="12" r="3.2" fill="#fff" /><circle cx="12" cy="3.5" r="1.4" fill="#fff" /><circle cx="12" cy="20.5" r="1.4" fill="#fff" /><circle cx="3.5" cy="12" r="1.4" fill="#fff" /><circle cx="20.5" cy="12" r="1.4" fill="#fff" /></g>),
];

export function CompanyMark({ logo, colour, size = 36 }: { logo: number; colour: string; size?: number }) {
  const mark = LOGOS[((logo % LOGOS.length) + LOGOS.length) % LOGOS.length];
  return (
    <span className="mn-mark" style={{ width: size, height: size, background: colour, borderRadius: Math.round(size * 0.28) }}>
      {mark(Math.round(size * 0.66))}
    </span>
  );
}
