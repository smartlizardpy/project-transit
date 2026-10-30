import { useEffect, useState } from 'react';
import { Nav } from './components/Nav.tsx';
import { Company } from './sections/Company.tsx';
import { Development } from './sections/Development.tsx';
import { Footer } from './sections/Footer.tsx';
import { Hero } from './sections/Hero.tsx';
import { Living } from './sections/Living.tsx';
import { Places } from './sections/Places.tsx';
import { Routes } from './sections/Routes.tsx';
import { Screenshots } from './sections/Screenshots.tsx';
import { Terminus } from './sections/Terminus.tsx';

/** Which nav link each section belongs to. */
const NAV_FOR: [string, string][] = [
  ['places', '#places'],
  ['routes', '#routes'],
  ['living', '#routes'],
  ['company', '#routes'],
  ['screenshots', '#screenshots'],
  ['development', '#development'],
  ['get', '#development'],
];

function useActiveSection() {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const line = window.innerHeight * 0.4;
      let current: string | null = null;
      for (const [id, href] of NAV_FOR) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) current = href;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);
  return active;
}

export function App() {
  const active = useActiveSection();
  return (
    <>
      <a className="skip" href="#places">
        Skip to content
      </a>
      <Nav active={active} />
      <main id="main">
        <Hero />
        <Places />
        <Routes />
        <Living />
        <Company />
        <Screenshots />
        <Development />
        <Terminus />
      </main>
      <Footer />
    </>
  );
}
