// Game session: loads regions, starts new companies, loads and saves games, autosaves.
// React reads the session phase from `useSession`; map code subscribes with `onGame`.

import { create } from 'zustand';
import { Game, newGameState } from '../game/engine.ts';
import { prepareRegion } from '../game/world/geo.ts';
import type { Region, RegionData, RegionSpec } from '../game/world/region.ts';
import { SAVE_VERSION, type GameState } from '../game/types.ts';
import { persistence, type SaveMeta } from './persistence.ts';
import type { RegionWorkerMessage } from './regionWorker.ts';

export type Phase = 'menu' | 'loading' | 'setup' | 'playing';

export interface Progress {
  stage: string;
  done: number;
  total: number;
}

interface SessionStore {
  phase: Phase;
  progress: Progress | null;
  error: string | null;
  saves: SaveMeta[];
  lastSaved: number | null;
  saving: boolean;
  /** the region being set up (new company flow) */
  pending: { spec: RegionSpec } | null;
  /** home area picked on the map during setup */
  homeZone: string | null;
  notice: string | null;
}

export const useSession = create<SessionStore>(() => ({
  phase: 'menu',
  progress: null,
  error: null,
  saves: [],
  lastSaved: null,
  saving: false,
  pending: null,
  homeZone: null,
  notice: null,
}));

export interface AppSettings {
  autosaveMinutes: number;
}

const SETTINGS_KEY = 'pt-settings-v1';
export function loadSettings(): AppSettings {
  const d: AppSettings = { autosaveMinutes: 5 };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return { autosaveMinutes: typeof raw.autosaveMinutes === 'number' ? raw.autosaveMinutes : d.autosaveMinutes };
  } catch {
    return d;
  }
}
export function saveSettings(s: AppSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Upgrade older save formats. Throws with a readable message if the save is unusable. */
export function migrate(raw: unknown): GameState {
  const s = raw as Partial<GameState> | null;
  if (!s || typeof s !== 'object' || !s.company || !s.region || !s.clock || !s.finance) throw new Error('This save file is damaged or not a Project Transit save.');
  const v = s.version ?? 0;
  if (v > SAVE_VERSION) throw new Error('This save was made by a newer version of Project Transit.');
  // v1 is the first released format; future migrations go here in order.
  return s as GameState;
}

type GameListener = (game: Game | null) => void;

class Session {
  game: Game | null = null;
  region: Region | null = null;
  private regionKey = '';
  private listeners = new Set<GameListener>();
  private worker: Worker | null = null;
  private autosaveTimer = 0;
  private lastAutosave = 0;

  onGame(fn: GameListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setGame(g: Game | null) {
    this.game = g;
    (window as unknown as { __game?: Game | null }).__game = g;
    this.listeners.forEach((fn) => fn(g));
  }

  async refreshSaves() {
    try {
      useSession.setState({ saves: await persistence().list() });
    } catch (e) {
      console.warn('listing saves failed', e);
    }
  }

  /** Build (or reuse) the playable region for a spec, reporting progress. */
  loadRegion(spec: RegionSpec): Promise<Region> {
    const key = `${spec.id}|${spec.tiles.map((t) => t.join(',')).join(';')}`;
    if (this.region && this.regionKey === key) return Promise.resolve(this.region);
    this.worker?.terminate();
    useSession.setState({ progress: { stage: 'Preparing', done: 0, total: 1 }, error: null });
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./regionWorker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      w.onmessage = (e: MessageEvent<RegionWorkerMessage>) => {
        const m = e.data;
        if (m.type === 'progress') useSession.setState({ progress: { stage: m.stage, done: m.done, total: m.total } });
        else if (m.type === 'error') {
          w.terminate();
          this.worker = null;
          reject(new Error(m.message));
        } else {
          w.terminate();
          this.worker = null;
          const region = prepareRegion(m.data as RegionData);
          this.region = region;
          this.regionKey = key;
          if (m.missing) useSession.setState({ notice: `${m.missing} map tile${m.missing > 1 ? 's' : ''} could not be downloaded; parts of the area may be missing streets.` });
          resolve(region);
        }
      };
      w.onerror = (e) => {
        w.terminate();
        this.worker = null;
        reject(new Error(e.message || 'The map data could not be processed.'));
      };
      w.postMessage({ spec });
    });
  }

  /** New company flow, step 1: load the chosen area, then let the player pick a home area. */
  async beginNew(spec: RegionSpec) {
    useSession.setState({ phase: 'loading', pending: { spec }, error: null, homeZone: null });
    try {
      await this.loadRegion(spec);
      useSession.setState({ phase: 'setup', progress: null });
    } catch (e) {
      useSession.setState({ phase: 'menu', progress: null, error: (e as Error).message, pending: null });
    }
  }

  /** New company flow, step 2: found the company in the chosen home area. */
  startNew(company: { name: string; colour: string; logo: number }, homeZone: string) {
    const region = this.region;
    if (!region) return;
    const state = newGameState({ region, company, homeZone, startWeekday: 0, startHour: 5 });
    const game = new Game(state, region);
    useSession.setState({ phase: 'playing', pending: null, progress: null, error: null, lastSaved: null });
    this.setGame(game);
    this.startAutosave();
    void this.save('manual');
  }

  cancelSetup() {
    useSession.setState({ phase: 'menu', pending: null, progress: null });
  }

  async load(id: string) {
    useSession.setState({ phase: 'loading', error: null, progress: { stage: 'Opening save', done: 0, total: 1 } });
    try {
      const { json, recovered } = await persistence().read(id);
      const state = migrate(JSON.parse(json));
      const region = await this.loadRegion(state.region);
      const game = new Game(state, region);
      const problems = game.audit().filter((p) => !p.startsWith('Passenger count'));
      useSession.setState({
        phase: 'playing',
        progress: null,
        lastSaved: state.meta.saved || null,
        notice: recovered ? 'The latest save was damaged; the previous version was restored.' : problems.length ? `Save loaded with ${problems.length} consistency warning(s).` : null,
      });
      this.setGame(game);
      this.startAutosave();
    } catch (e) {
      useSession.setState({ phase: 'menu', progress: null, error: (e as Error).message });
    }
  }

  async continueLatest() {
    await this.refreshSaves();
    const latest = useSession.getState().saves[0];
    if (latest) await this.load(latest.id);
  }

  meta(kind: 'manual' | 'auto'): SaveMeta | null {
    const g = this.game;
    if (!g) return null;
    const s = g.state;
    const day = Math.floor(s.clock.t / 86400) + 1;
    return {
      id: kind === 'auto' ? `${s.meta.id}-auto` : s.meta.id,
      name: `${s.company.name} · Day ${day}${kind === 'auto' ? ' (autosave)' : ''}`,
      company: s.company.name,
      colour: s.company.colour,
      city: `${s.region.city}${s.region.area ? `, ${s.region.area}` : ''}`,
      day,
      balance: s.finance.balance,
      savedAt: Date.now(),
      version: SAVE_VERSION,
      kind,
    };
  }

  async save(kind: 'manual' | 'auto' = 'manual'): Promise<boolean> {
    const g = this.game;
    const meta = this.meta(kind);
    if (!g || !meta) return false;
    useSession.setState({ saving: true });
    try {
      await persistence().write(meta, g.serialize());
      useSession.setState({ saving: false, lastSaved: Date.now() });
      if (kind === 'auto') this.lastAutosave = Date.now();
      void this.refreshSaves();
      return true;
    } catch (e) {
      useSession.setState({ saving: false, notice: `Saving failed: ${(e as Error).message}` });
      return false;
    }
  }

  private startAutosave() {
    clearInterval(this.autosaveTimer);
    this.lastAutosave = Date.now();
    this.autosaveTimer = window.setInterval(() => {
      const mins = loadSettings().autosaveMinutes;
      if (!mins || !this.game || useSession.getState().phase !== 'playing') return;
      if (Date.now() - this.lastAutosave >= mins * 60_000) void this.save('auto');
    }, 15_000);
  }

  async quitToMenu(saveFirst = true) {
    if (saveFirst && this.game) await this.save('auto');
    clearInterval(this.autosaveTimer);
    this.setGame(null);
    useSession.setState({ phase: 'menu', pending: null });
    void this.refreshSaves();
  }

  async deleteSave(id: string) {
    await persistence().remove(id);
    await this.refreshSaves();
  }
}

export const session = new Session();
