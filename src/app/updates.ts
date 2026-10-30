// Automatic updates for the desktop app. Shortly after launch (and every few hours) it asks
// GitHub Releases for a newer version, downloads it in the background and offers a restart.
// Updates are signed; the app only installs ones signed with the project's key (see
// docs/releasing.md). If the player picks "Later", the update installs when they quit.
// Nothing happens in the browser build.
import { create } from 'zustand';
import type { Update } from '@tauri-apps/plugin-updater';
import { isDesktop } from './persistence.ts';
import { loadSettings, session, useSession } from './session.ts';

export const APP_VERSION: string = __APP_VERSION__;

type Status = 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'installing' | 'error';

interface UpdateState {
  status: Status;
  /** the new version, once one is found */
  version: string | null;
  /** download progress 0..1 */
  progress: number;
  /** the player chose "Later" */
  dismissed: boolean;
  checkedAt: number | null;
  error: string | null;
}

export const useUpdates = create<UpdateState>(() => ({ status: 'idle', version: null, progress: 0, dismissed: false, checkedAt: null, error: null }));

const FIRST_CHECK_MS = 8_000;
const EVERY_MS = 6 * 3600_000;

let ready: Update | null = null;
let busy = false;

/** Look for an update and download it. `manual`: the player asked, so report errors. */
export async function checkForUpdates(manual = false): Promise<void> {
  if (!isDesktop() || busy) return;
  if (ready) {
    useUpdates.setState({ dismissed: false });
    return;
  }
  busy = true;
  useUpdates.setState({ status: 'checking', error: null });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    useUpdates.setState({ checkedAt: Date.now() });
    if (!update) {
      useUpdates.setState({ status: 'none' });
      return;
    }
    let total = 0, got = 0;
    useUpdates.setState({ status: 'downloading', version: update.version, progress: 0 });
    await update.download((e) => {
      if (e.event === 'Started') total = e.data.contentLength ?? 0;
      else if (e.event === 'Progress') {
        got += e.data.chunkLength;
        if (total) useUpdates.setState({ progress: Math.min(1, got / total) });
      }
    });
    ready = update;
    useUpdates.setState({ status: 'ready', progress: 1, dismissed: false });
  } catch (e) {
    console.warn('update check failed', e);
    // offline or GitHub unreachable: stay quiet unless the player asked
    useUpdates.setState({ status: manual ? 'error' : 'idle', error: manual ? 'Could not reach the update server. Check your connection and try again.' : null });
  } finally {
    busy = false;
  }
}

const saveFirst = async () => {
  if (session.game && useSession.getState().phase === 'playing') await Promise.race([session.save('auto'), new Promise((r) => setTimeout(r, 3000))]);
};

/** Save, install the downloaded update and start the new version. */
export async function installAndRestart(): Promise<void> {
  if (!ready) return;
  useUpdates.setState({ status: 'installing' });
  try {
    await saveFirst();
    await ready.install();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    console.warn('update install failed', e);
    useUpdates.setState({ status: 'error', error: 'The update could not be installed. If the app is not in your Applications folder, move it there and try again.' });
  }
}

/** On quit: install a downloaded update so the next launch is the new version (at most 20 s). */
export async function installOnExit(): Promise<void> {
  if (!ready || useUpdates.getState().status !== 'ready') return;
  await Promise.race([ready.install().catch((e) => console.warn('update install on exit failed', e)), new Promise((r) => setTimeout(r, 20_000))]);
}

export function startAutoUpdates(): void {
  if (!isDesktop()) return;
  const auto = () => loadSettings().autoUpdate;
  setTimeout(() => auto() && void checkForUpdates(), FIRST_CHECK_MS);
  setInterval(() => auto() && void checkForUpdates(), EVERY_MS);
}
