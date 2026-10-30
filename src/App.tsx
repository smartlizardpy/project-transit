import { useEffect, useState } from 'react';
import { MapView } from './map/MapView.tsx';
import { CompanyCard, TimeControls, Stats } from './ui/TopBar.tsx';
import { ToolRail, MapControls, Attribution, Legends, Toast } from './ui/ToolRail.tsx';
import { Inspector } from './ui/Inspector.tsx';
import { Panels } from './ui/Panels.tsx';
import { RouteTray } from './ui/RouteTray.tsx';
import { TimetableEditor } from './ui/TimetableEditor.tsx';
import { StartMenu } from './ui/StartMenu.tsx';
import { NewCompany } from './ui/NewCompany.tsx';
import { GameMenu } from './ui/GameMenu.tsx';
import { Onboarding, GameOver } from './ui/Onboarding.tsx';
import { useKeyboard } from './ui/keyboard.ts';
import { mapRuntime } from './map/runtime.ts';
import { session, useSession } from './app/session.ts';
import { isDesktop, toggleFullscreen } from './app/persistence.ts';
import { useUI } from './state/store.ts';
import { CompanyMark } from './ui/logos.tsx';
import './styles/ui.css';
import './styles/game.css';

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
        <CompanyMark logo={0} colour="#e0573e" size={52} />
        Loading Project Transit…
        <div className="boot-bar"><i /></div>
      </div>
    </div>
  );
}

/** Session notices (save recovered, tiles missing, save failed) as toasts. */
function SessionNotices() {
  const notice = useSession((s) => s.notice);
  useEffect(() => {
    if (!notice) return;
    useUI.getState().notify(notice, 'warn');
    useSession.setState({ notice: null });
  }, [notice]);
  return null;
}

function TimetableModal() {
  const modal = useUI((s) => s.modal);
  if (modal?.kind !== 'timetable') return null;
  return <TimetableEditor routeId={modal.route} onClose={() => useUI.getState().openModal(null)} />;
}

/** Quietly save when the window is closed or hidden. */
function useSaveOnExit() {
  useEffect(() => {
    const playing = () => !!session.game && useSession.getState().phase === 'playing';
    const h = () => {
      if (document.visibilityState === 'hidden' && playing()) void session.save('auto');
    };
    document.addEventListener('visibilitychange', h);
    // desktop: save before the window closes (at most a few seconds, so closing never hangs)
    let unlisten: (() => void) | null = null;
    let disposed = false;
    if (isDesktop())
      void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        const off = await getCurrentWindow().onCloseRequested(async () => {
          if (playing()) await Promise.race([session.save('auto'), new Promise((r) => setTimeout(r, 3000))]);
        });
        if (disposed) off();
        else unlisten = off;
      });
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', h);
      unlisten?.();
    };
  }, []);
}

export function App() {
  useKeyboard();
  useSaveOnExit();
  const phase = useSession((s) => s.phase);
  const [hud, setHud] = useState(true);
  useEffect(() => {
    void session.refreshSaves();
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F10' || (e.key.toLowerCase() === 'u' && e.shiftKey)) setHud((x) => !x);
      if (e.key === 'F11') {
        e.preventDefault();
        void toggleFullscreen();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const playing = phase === 'playing';
  return (
    <div className={`app phase-${phase}`}>
      <MapView />
      {playing && hud && (
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
          <Onboarding />
        </div>
      )}
      {playing && <TimetableModal />}
      {playing && <GameOver />}
      <StartMenu />
      <NewCompany />
      <GameMenu />
      <Toast />
      <SessionNotices />
      <Attribution />
      <Boot />
    </div>
  );
}
