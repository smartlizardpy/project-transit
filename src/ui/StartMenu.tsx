import { useEffect, useState } from 'react';
import { Play, Plus, FolderOpen, GearSix, Power, X } from '@phosphor-icons/react';
import '../styles/menu.css';
import { useSession, session } from '../app/session.ts';
import { exitApp, isDesktop } from '../app/persistence.ts';
import { LoadDialog, MenuBtn, SettingsDialog, relTime } from './GameMenu.tsx';
import { useNewCompanyFlow } from './NewCompany.tsx';

export function StartMenu() {
  const phase = useSession((s) => s.phase);
  const saves = useSession((s) => s.saves);
  const error = useSession((s) => s.error);
  const flowOpen = useNewCompanyFlow((s) => s.open);
  const [dlg, setDlg] = useState<'load' | 'settings' | null>(null);
  useEffect(() => {
    void session.refreshSaves();
  }, []);
  if (phase !== 'menu' || flowOpen) return null;
  const latest = [...saves].sort((a, b) => b.savedAt - a.savedAt)[0];
  return (
    <div className="mn-start">
      <div className="mn-scrim" />
      <div className="mn-start-col">
        <header className="mn-title">
          <h1>Project Transit</h1>
          <p>Build the bus network your city deserves.</p>
        </header>
        {error && (
          <div className="mn-error" role="alert">
            <span>{error}</span>
            <button className="close-btn" aria-label="Dismiss" onClick={() => useSession.setState({ error: null })}><X size={12} weight="bold" /></button>
          </div>
        )}
        <nav className="card mn-menu" aria-label="Main menu">
          {latest && (
            <MenuBtn
              primary autoFocus icon={<Play weight="fill" />} label="Continue"
              meta={`${latest.company} · ${latest.city} · Day ${latest.day} · ${relTime(latest.savedAt)}`}
              onClick={() => void session.continueLatest()}
            />
          )}
          <MenuBtn icon={<Plus />} label="New company" autoFocus={!latest} onClick={() => useNewCompanyFlow.setState({ open: true })} />
          <MenuBtn icon={<FolderOpen />} label="Load game" meta={saves.length ? `${saves.length} saved` : undefined} onClick={() => setDlg('load')} />
          <MenuBtn icon={<GearSix />} label="Settings" onClick={() => setDlg('settings')} />
          {isDesktop() && <MenuBtn icon={<Power />} label="Exit" onClick={() => void exitApp()} />}
        </nav>
        <footer className="mn-foot">Map data © OpenStreetMap contributors</footer>
      </div>
      {dlg === 'load' && <LoadDialog onClose={() => setDlg(null)} />}
      {dlg === 'settings' && <SettingsDialog onClose={() => setDlg(null)} />}
    </div>
  );
}
