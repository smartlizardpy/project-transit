// Durable save storage. In the desktop app saves are JSON files in the app data folder,
// written atomically (temp file + rename) with the previous version kept as a backup, so an
// interrupted write never destroys a save. In a plain browser, IndexedDB is used instead.

import { invoke } from '@tauri-apps/api/core';

export interface SaveMeta {
  id: string;
  /** display name, e.g. "Haliç Transit · Day 12" */
  name: string;
  company: string;
  colour: string;
  city: string;
  day: number;
  balance: number;
  /** wall-clock ms */
  savedAt: number;
  version: number;
  kind: 'manual' | 'auto';
}

export interface ReadResult {
  json: string;
  /** the main file was unreadable and the backup was used */
  recovered: boolean;
}

export interface Persistence {
  readonly kind: 'desktop' | 'browser';
  list(): Promise<SaveMeta[]>;
  read(id: string): Promise<ReadResult>;
  write(meta: SaveMeta, json: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function safeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 64) || 'save';
}

class DesktopPersistence implements Persistence {
  readonly kind = 'desktop' as const;
  async list() {
    const raw = await invoke<string[]>('saves_list');
    return raw.map((s) => JSON.parse(s) as SaveMeta).sort((a, b) => b.savedAt - a.savedAt);
  }
  read(id: string) {
    return invoke<ReadResult>('save_read', { id: safeId(id) });
  }
  write(meta: SaveMeta, json: string) {
    return invoke<void>('save_write', { id: safeId(meta.id), meta: JSON.stringify({ ...meta, id: safeId(meta.id) }), data: json });
  }
  remove(id: string) {
    return invoke<void>('save_delete', { id: safeId(id) });
  }
}

class BrowserPersistence implements Persistence {
  readonly kind = 'browser' as const;
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('project-transit-saves', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta');
        req.result.createObjectStore('data');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (meta: IDBObjectStore, data: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(['meta', 'data'], mode);
      const req = fn(t.objectStore('meta'), t.objectStore('data'));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('Save transaction aborted'));
    });
  }

  async list() {
    const all = (await this.tx('readonly', (m) => m.getAll())) as SaveMeta[] | undefined;
    return (all ?? []).sort((a, b) => b.savedAt - a.savedAt);
  }

  async read(id: string) {
    const json = (await this.tx('readonly', (_m, d) => d.get(safeId(id)))) as string | undefined;
    if (json) return { json, recovered: false };
    const bak = (await this.tx('readonly', (_m, d) => d.get(`${safeId(id)}.bak`))) as string | undefined;
    if (bak) return { json: bak, recovered: true };
    throw new Error('Save not found.');
  }

  async write(meta: SaveMeta, json: string) {
    const id = safeId(meta.id);
    const prev = (await this.tx('readonly', (_m, d) => d.get(id))) as string | undefined;
    // one transaction: the save and its metadata are written together or not at all
    await this.tx('readwrite', (m, d) => {
      if (prev) d.put(prev, `${id}.bak`);
      d.put(json, id);
      m.put({ ...meta, id }, id);
    });
  }

  async remove(id: string) {
    const k = safeId(id);
    await this.tx('readwrite', (m, d) => {
      m.delete(k);
      d.delete(k);
      d.delete(`${k}.bak`);
    });
  }
}

let instance: Persistence | null = null;
export function persistence(): Persistence {
  return (instance ??= isDesktop() ? new DesktopPersistence() : new BrowserPersistence());
}

/** Quit the desktop app (no-op in the browser). */
/** Fullscreen through the native window on desktop (the webview has no Fullscreen API there). */
export async function isFullscreen(): Promise<boolean> {
  if (isDesktop()) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().isFullscreen().catch(() => false);
  }
  return !!document.fullscreenElement;
}

export async function setFullscreen(on: boolean) {
  if (isDesktop()) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setFullscreen(on).catch(() => {});
  } else if (on) await document.documentElement.requestFullscreen().catch(() => {});
  else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
}

export async function toggleFullscreen() {
  await setFullscreen(!(await isFullscreen()));
}

export async function exitApp() {
  if (isDesktop()) await invoke('app_exit').catch(() => window.close());
}
