import { useEffect, useRef, useState } from 'react';
import { BASE, NAV, RELEASE, RELEASES, REPO } from '../content/site.ts';
import { Close, Download, GitHub, Menu } from './Icons.tsx';

/** Two floating cards, like the game's top bar: the brand on the left, links on the right. */
export function Nav({ active }: { active: string | null }) {
  const [open, setOpen] = useState(false);
  const right = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => !right.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [open]);

  return (
    <header className="nav">
      <a className="nav-card brand-card" href="#top" aria-label="Project Transit, back to top">
        <span className="brand">
          <img src={`${BASE}mark-96.png`} alt="" width={40} height={40} />
          <span className="brand-name">
            <strong>Project Transit</strong>
            <span>Early build {RELEASE.version}</span>
          </span>
        </span>
      </a>
      <div className="nav-right" ref={right}>
        <div className="nav-card">
          <button className="nav-toggle" aria-expanded={open} aria-controls="nav-menu" onClick={() => setOpen((o) => !o)}>
            {open ? <Close /> : <Menu />}
            Menu
          </button>
          <nav id="nav-menu" className="nav-menu" data-open={open} aria-label="Main">
            <ul className="nav-links">
              {NAV.map((l) => (
                <li key={l.href}>
                  <a href={l.href} aria-current={active === l.href ? 'true' : undefined} onClick={() => setOpen(false)}>
                    {l.label}
                  </a>
                </li>
              ))}
              <li className="nav-sep" aria-hidden="true" />
              <li>
                <a className="nav-optional" href={REPO}>
                  <GitHub size={17} />
                  GitHub
                </a>
              </li>
            </ul>
            <a className="btn" href={RELEASES}>
              <Download size={17} />
              Download
            </a>
          </nav>
        </div>
      </div>
    </header>
  );
}
