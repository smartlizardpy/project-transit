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
import { exitApp, isDesktop, toggleFullscreen } from './app/persistence.ts';
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
  const growing = useSession((s) => s.growing);
  useEffect(() => {
    if (growing) useUI.getState().notify('Loading more of the map around your areas…', 'info');
  }, [growing]);
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
    // Desktop: save before the window closes or the app quits (Cmd+Q comes from our own menu
    // item, see src-tauri/src/lib.rs). At most a few seconds, so quitting never hangs.
    const saveNow = async (): Promise<void> => {
      if (playing()) await Promise.race([session.save('auto'), new Promise((r) => setTimeout(r, 3000))]);
    };
    const offs: (() => void)[] = [];
    let disposed = false;
    if (isDesktop())
      void Promise.all([import('@tauri-apps/api/window'), import('@tauri-apps/api/event')]).then(async ([{ getCurrentWindow }, { listen }]) => {
        const got = [
          await getCurrentWindow().onCloseRequested(saveNow),
          await listen('pt-quit-requested', async () => {
            await saveNow();
            await exitApp();
          }),
        ];
        if (disposed) got.forEach((f) => f());
        else offs.push(...got);
      });
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', h);
      offs.forEach((f) => f());
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
