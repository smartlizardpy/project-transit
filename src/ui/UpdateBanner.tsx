import { ArrowsClockwise, X } from '@phosphor-icons/react';
import { installAndRestart, useUpdates } from '../app/updates.ts';

/** "Version 0.2.1 is ready": shown once an update has downloaded in the background. */
export function UpdateBanner() {
  const status = useUpdates((s) => s.status);
  const version = useUpdates((s) => s.version);
  const dismissed = useUpdates((s) => s.dismissed);
  if (dismissed || (status !== 'ready' && status !== 'installing')) return null;
  const installing = status === 'installing';
  return (
    <div className="card update-banner" role="status">
      <ArrowsClockwise size={18} weight="bold" />
      <div>
        <b>Version {version} is ready</b>
        <span>Restart now (your game is saved first), or it installs when you quit.</span>
      </div>
      <button className="btn sm primary" disabled={installing} onClick={() => void installAndRestart()}>{installing ? 'Restarting…' : 'Restart now'}</button>
      <button className="close-btn" aria-label="Later" title="Later" disabled={installing} onClick={() => useUpdates.setState({ dismissed: true })}><X size={12} weight="bold" /></button>
    </div>
  );
}
