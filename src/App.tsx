import { useEffect, useState } from 'react';
import { MapView } from './map/MapView.tsx';
import { CompanyCard, TimeControls, Stats } from './ui/TopBar.tsx';
import { ToolRail, MapControls, Attribution, Legends, Toast } from './ui/ToolRail.tsx';
import { Inspector } from './ui/Inspector.tsx';
import { Panels } from './ui/Panels.tsx';
import { RouteTray } from './ui/RouteTray.tsx';
import { useKeyboard } from './ui/keyboard.ts';
import { mapRuntime } from './map/runtime.ts';
import { CompanyLogo } from './ui/TopBar.tsx';
import './styles/ui.css';

function Boot() {
  const [done, setDone] = useState(false);
  useEffect(
    () =>
      mapRuntime.onReady(() => {
        const map = mapRuntime.map!;
        const check = () => {
          if (map.loaded() && mapRuntime.city && !mapRuntime.city.busy) setDone(true);
          else setTimeout(check, 150);
        };
        check();
        setTimeout(() => setDone(true), 9000); // never block on slow tiles
      }),
    [],
  );
  return (
    <div className={`boot ${done ? 'done' : ''}`} aria-hidden={done}>
      <div className="boot-inner">
        <div className="company-logo" style={{ width: 52, height: 52, borderRadius: 14 }}>
          <CompanyLogo size={28} />
        </div>
        Building İstanbul…
        <div className="boot-bar"><i /></div>
      </div>
    </div>
  );
}

export function App() {
  useKeyboard();
  const [hud, setHud] = useState(true);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F10' || (e.key.toLowerCase() === 'u' && e.shiftKey)) setHud((x) => !x);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <div className="app">
      <MapView />
      {hud && (
        <div className="hud">
          <CompanyCard />
          <TimeControls />
          <Stats />
          <ToolRail />
          <Panels />
          <Inspector />
          <RouteTray />
          <Legends />
          <MapControls />
          <Toast />
        </div>
      )}
      <Attribution />
      <div className="proto">PROTOTYPE · simulated data</div>
      <Boot />
    </div>
  );
}
