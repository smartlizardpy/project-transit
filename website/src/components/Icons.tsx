// A few line icons drawn for the page (stroke style matching the game's Phosphor icons).
import type { ReactNode } from 'react';

type P = { size?: number };

const svg = (size: number, children: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Download = ({ size = 18 }: P) =>
  svg(size, (
    <>
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ));

export const Close = ({ size = 18 }: P) =>
  svg(size, (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ));

export const Prev = ({ size = 20 }: P) => svg(size, <path d="m15 5-7 7 7 7" />);
export const Next = ({ size = 20 }: P) => svg(size, <path d="m9 5 7 7-7 7" />);

export const Menu = ({ size = 18 }: P) =>
  svg(size, (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </>
  ));

export const Pause = ({ size = 14 }: P) =>
  svg(size, (
    <>
      <path d="M9 5v14" />
      <path d="M15 5v14" />
    </>
  ));

export const Play = ({ size = 14 }: P) => svg(size, <path d="M7 5v14l11-7z" fill="currentColor" />);

export const GitHub = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03a9.5 9.5 0 0 1 5 0c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.85-2.34 4.7-4.57 4.95.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
  </svg>
);
