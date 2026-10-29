import { useEffect, useState, type ReactNode } from 'react';
import { X, Play, FloppyDisk, FolderOpen, GearSix, SignOut, Power, Trash, ArrowLeft } from '@phosphor-icons/react';
import '../styles/menu.css';
import { useSession, session, loadSettings, saveSettings, type AppSettings } from '../app/session.ts';
import { exitApp, isDesktop, type SaveMeta } from '../app/persistence.ts';
import { useUI } from '../state/store.ts';
import { useGame } from './hooks.ts';
import { CompanyMark } from './logos.tsx';
import { Segmented } from './primitives.tsx';

export function relTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

function useEsc(fn: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        fn();
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [fn]);
}

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEsc(onClose);
  return (
    <div className="mn-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'card mn-dialog' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mn-dialog-head">
          <h2>{title}</h2>
          <button className="close-btn" onClick={onClose} aria-label="Close"><X size={14} weight="bold" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** List of saves with Load and Delete (with confirmation). */
export function SaveList({ onLoad }: { onLoad?: () => void }) {
  const saves = useSession((s) => s.saves);
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    void session.refreshSaves();
  }, []);
  if (!saves.length) return <p className="mn-empty">No saved games yet.</p>;
  const sorted = [...saves].sort((a: SaveMeta, b: SaveMeta) => b.savedAt - a.savedAt);
  return (
    <ul className="mn-saves">
      {sorted.map((s) => (
        <li key={s.id} className="mn-save">
          <CompanyMark logo={0} colour={s.colour} size={34} />
          <div className="mn-save-text">
            <b>{s.company}{s.kind === 'auto' && <span className="pill mn-auto">Autosave</span>}</b>
            <span>{s.city} · Day {s.day} · {Math.round(s.balance).toLocaleString()} · {relTime(s.savedAt)}</span>
          </div>
          {confirm === s.id ? (
            <div className="mn-save-actions">
              <button className="btn sm" onClick={() => setConfirm(null)}>Keep</button>
              <button className="btn sm mn-danger" onClick={() => { setConfirm(null); void session.deleteSave(s.id); }}>Delete</button>
            </div>
          ) : (
            <div className="mn-save-actions">
              <button className="icon-btn" aria-label={`Delete ${s.company}`} onClick={() => setConfirm(s.id)}><Trash size={16} /></button>
              <button className="btn sm primary" onClick={() => { onLoad?.(); void session.load(s.id); }}>Load</button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function LoadDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Load game" onClose={onClose} wide>
      <SaveList onLoad={onClose} />
    </Dialog>
  );
}

export function SettingsDialog({ onClose }: { onClose?: () => void }) {
  const close = () => (onClose ? onClose() : useUI.getState().openModal(null));
  const game = useGame();
  const [s, setS] = useState<AppSettings>(loadSettings);
  const [, force] = useState(0);
  const patch = (p: Partial<AppSettings>) => {
    const n = { ...s, ...p };
    setS(n);
    saveSettings(n);
  };
  const gs = game?.state.settings;
  return (
    <Dialog title="Settings" onClose={close}>
      <div className="mn-set">
        <div className="mn-set-row">
          <div><b>Autosave</b><span>How often a running game is saved automatically.</span></div>
          <Segmented
            options={[{ value: '0', label: 'Off' }, { value: '2', label: '2 min' }, { value: '5', label: '5 min' }, { value: '10', label: '10 min' }]}
            value={String(s.autosaveMinutes)}
            onChange={(v) => patch({ autosaveMinutes: Number(v) })}
          />
        </div>
        {game && gs && (
          <>
            <div className="label mn-set-h">This company</div>
            <div className="mn-set-row">
              <div><b>Automatic maintenance</b><span>Send buses to the depot when their condition drops.</span></div>
              <button
                role="switch"
                aria-checked={gs.autoService}
                className={'mn-switch' + (gs.autoService ? ' on' : '')}
                onClick={() => { game.setSettings({ autoService: !gs.autoService }); force((x) => x + 1); }}
              ><i /></button>
            </div>
            <div className={'mn-set-row' + (gs.autoService ? '' : ' off')}>
              <div><b>Service below {Math.round(gs.serviceBelow * 100)}% condition</b><span>Higher means more frequent servicing and fewer breakdowns.</span></div>
              <input
                type="range" min={0.5} max={0.9} step={0.05} value={gs.serviceBelow} disabled={!gs.autoService}
                aria-label="Service threshold"
                onChange={(e) => { game.setSettings({ serviceBelow: Number(e.target.value) }); force((x) => x + 1); }}
              />
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

export function GameMenu() {
  const modal = useUI((s) => s.modal);
  const openModal = useUI((s) => s.openModal);
  const saving = useSession((s) => s.saving);
  const [view, setView] = useState<'main' | 'load' | 'quit'>('main');
  const [saved, setSaved] = useState(false);
  const isMenu = modal?.kind === 'menu';
  useEffect(() => {
    if (isMenu) { setView('main'); setSaved(false); }
  }, [isMenu]);
  const close = () => openModal(null);
  useEsc(() => (view === 'main' ? close() : setView('main')));
  if (modal?.kind === 'settings') return <SettingsDialog />;
  if (!isMenu) return null;
  const save = async () => {
    const ok = await session.save('manual');
    setSaved(ok);
    if (ok) setTimeout(() => setSaved(false), 2200);
  };
  return (
    <div className="mn-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="card mn-dialog" role="dialog" aria-modal="true" aria-label="Game menu">
        {view === 'main' && (
          <>
            <div className="mn-dialog-head"><h2>Paused</h2><button className="close-btn" onClick={close} aria-label="Close"><X size={14} weight="bold" /></button></div>
            <div className="mn-list">
              <MenuBtn icon={<Play weight="fill" />} label="Resume" onClick={close} primary autoFocus />
              <MenuBtn icon={<FloppyDisk />} label={saving ? 'Saving…' : saved ? 'Saved' : 'Save game'} disabled={saving} onClick={save} />
              <MenuBtn icon={<FolderOpen />} label="Load game" onClick={() => setView('load')} />
              <MenuBtn icon={<GearSix />} label="Settings" onClick={() => openModal({ kind: 'settings' })} />
              <MenuBtn icon={<SignOut />} label="Quit to main menu" onClick={() => setView('quit')} />
              {isDesktop() && <MenuBtn icon={<Power />} label="Exit game" onClick={() => void exitApp()} />}
            </div>
          </>
        )}
        {view === 'load' && (
          <>
            <div className="mn-dialog-head"><button className="icon-btn" onClick={() => setView('main')} aria-label="Back"><ArrowLeft size={16} /></button><h2>Load game</h2></div>
            <p className="mn-note">Loading replaces the current game. Save first if you want to keep your progress.</p>
            <SaveList onLoad={close} />
          </>
        )}
        {view === 'quit' && (
          <>
            <div className="mn-dialog-head"><h2>Quit to main menu?</h2></div>
            <p className="mn-note">Your game is saved before you leave.</p>
            <div className="mn-row-end">
              <button className="btn" onClick={() => setView('main')} autoFocus>Stay</button>
              <button className="btn primary" onClick={() => { close(); void session.quitToMenu(); }}>Save and quit</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function MenuBtn({ icon, label, onClick, primary, disabled, autoFocus, meta }: { icon: ReactNode; label: string; onClick: () => void; primary?: boolean; disabled?: boolean; autoFocus?: boolean; meta?: string }) {
  return (
    <button className={'mn-item' + (primary ? ' primary' : '')} onClick={onClick} disabled={disabled} autoFocus={autoFocus}>
      <span className="mn-item-icon">{icon}</span>
      <span className="mn-item-label">{label}</span>
      {meta && <span className="mn-item-meta">{meta}</span>}
    </button>
  );
}
