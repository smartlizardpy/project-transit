// Game session: loads regions, starts new companies, loads and saves games, autosaves.
// React reads the session phase from `useSession`; map code subscribes with `onGame`.

import { create } from 'zustand';
import { Game, newGameState } from '../game/engine.ts';
import { prepareRegion } from '../game/world/geo.ts';
import { moveToRegion } from '../game/growth.ts';
import { tilesNeeded } from '../game/world/zoneTiles.ts';
import type { Region, RegionData, RegionSpec } from '../game/world/region.ts';
import { SAVE_VERSION, type GameState } from '../game/types.ts';
import { upgradeState } from '../game/upgrade.ts';
import { persistence, safeId, type SaveMeta } from './persistence.ts';
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
  /** new company setup: choose the home area first, then name the company */
  setupStep: 'area' | 'company';
  notice: string | null;
  /** more of the map is being loaded around the company's territory */
  growing: boolean;
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
  setupStep: 'area',
  notice: null,
  growing: false,
}));

export interface AppSettings {
  autosaveMinutes: number;
  /** desktop: look for updates on launch and every few hours */
  autoUpdate: boolean;
}

const SETTINGS_KEY = 'pt-settings-v1';
export function loadSettings(): AppSettings {
  const d: AppSettings = { autosaveMinutes: 5, autoUpdate: true };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return {
      autosaveMinutes: typeof raw.autosaveMinutes === 'number' ? raw.autosaveMinutes : d.autosaveMinutes,
      autoUpdate: typeof raw.autoUpdate === 'boolean' ? raw.autoUpdate : d.autoUpdate,
    };
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
  const damaged = 'This save file is damaged or not a Project Transit save.';
  if (!s || typeof s !== 'object' || !s.company || !s.region || !s.clock || !s.finance || !s.territory) throw new Error(damaged);
  if (!s.meta || typeof s.meta.id !== 'string' || !s.meta.id) throw new Error(damaged);
  for (const k of ['stops', 'routes', 'vehicles', 'depots'] as const) if (!s[k] || typeof s[k] !== 'object') throw new Error(damaged);
  if (typeof s.clock.t !== 'number' || typeof s.finance.balance !== 'number' || !Array.isArray(s.territory.owned)) throw new Error(damaged);
  const v = s.version ?? 0;
  if (v > SAVE_VERSION) throw new Error('This save was made by a newer version of Project Transit.');
  // v1 → v2: analytics, Network Control progress and automation (safe defaults)
  return upgradeState(s as GameState);
}

/** `grown`: the same game moved onto a bigger map (keep the camera and the open panels) */
type GameListener = (game: Game | null, info?: { grown?: boolean }) => void;

class Session {
  game: Game | null = null;
  region: Region | null = null;
  private regionKey = '';
  private listeners = new Set<GameListener>();
  private worker: Worker | null = null;
  /** the region being built right now (shared by callers asking for the same area) */
  private inflight: { key: string; promise: Promise<Region>; quiet: boolean; cancel: () => void } | null = null;
  private autosaveTimer = 0;
  private lastAutosave = 0;
  /** saves run one at a time, in the order they were asked for */
  private saveChain: Promise<unknown> = Promise.resolve();
  private savesPending = 0;

  onGame(fn: GameListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setGame(g: Game | null, info?: { grown?: boolean }) {
    this.game = g;
    (window as unknown as { __game?: Game | null }).__game = g;
    this.listeners.forEach((fn) => fn(g, info));
    if (g) this.watchGrowth(g);
  }

  // ───────────────────────── a map that grows with the company

  private growing = false;

  /** Load more map whenever the company's territory nears the edge of what is loaded. */
  private watchGrowth(g: Game) {
    let owned = g.state.territory.owned.join();
    g.on('changed', () => {
      const now = g.state.territory.owned.join();
      if (now === owned || this.game !== g) return;
      owned = now;
      void this.grow();
    });
    void this.grow();
  }

  /**
   * Rebuild the region with the tiles the territory needs, then move the running game onto it.
   * The game keeps running meanwhile; if the map cannot be downloaded it stays as it is and the
   * next licence (or loading the save) tries again.
   */
  async grow(): Promise<boolean> {
    const g = this.game;
    if (!g || this.growing) return false;
    const tiles = tilesNeeded(g.region.spec, g.state.territory.owned);
    if (!tiles) return false;
    this.growing = true;
    useSession.setState({ growing: true });
    let ok = false;
    try {
      const region = await this.loadRegion({ ...g.region.spec, tiles }, { quiet: true });
      if (this.game !== g) return false;
      if (region.coverage.missingTiles > g.region.coverage.missingTiles) throw new Error('missing tiles');
      const state = JSON.parse(g.serialize()) as GameState;
      const lost = moveToRegion(state, g.region, region);
      const next = new Game(state, region);
      next.settleAfterGrowth();
      next.setSpeed(g.speed);
      if (lost) console.warn(`map grew: ${lost} bus(es) returned to the depot`);
      this.setGame(next, { grown: true });
      ok = true;
    } catch (e) {
      console.warn('the map could not grow', e);
      useSession.setState({ notice: navigator.onLine === false ? 'You are offline, so the map cannot grow yet. Your areas work as normal; more of the map loads when you are back online.' : 'More of the map could not be downloaded. Your areas work as normal; it will try again when you next license an area or load this game.' });
    } finally {
      this.growing = false;
      useSession.setState({ growing: false });
    }
    // the territory may have changed again while the map was loading
    if (ok) void this.grow();
    return ok;
  }

  async refreshSaves() {
    try {
      useSession.setState({ saves: await persistence().list() });
    } catch (e) {
      console.warn('listing saves failed', e);
    }
  }

  /**
   * Build (or reuse) the playable region for a spec, reporting progress. `quiet` loads (the
   * start-menu showcase) report nothing and give way to any other load.
   */
  loadRegion(spec: RegionSpec, opts: { quiet?: boolean } = {}): Promise<Region> {
    const quiet = !!opts.quiet;
    const key = `${spec.id}|${spec.tiles.map((t) => t.join(',')).join(';')}`;
    if (this.region && this.regionKey === key) return Promise.resolve(this.region);
    const running = this.inflight;
    if (running && running.key === key) {
      if (!quiet && running.quiet) {
        running.quiet = false;
        useSession.setState({ progress: { stage: 'Preparing', done: 0, total: 1 }, error: null });
      }
      return running.promise;
    }
    if (running) {
      if (quiet) return Promise.reject(new Error('Another area is loading.'));
      running.cancel();
    }
    if (!quiet) useSession.setState({ progress: { stage: 'Preparing', done: 0, total: 1 }, error: null });
    const w = new Worker(new URL('./regionWorker.ts', import.meta.url), { type: 'module' });
    this.worker = w;
    let entry!: NonNullable<Session['inflight']>;
    const promise = new Promise<Region>((resolve, reject) => {
      const finish = () => {
        w.terminate();
        if (this.worker === w) this.worker = null;
        if (this.inflight === entry) this.inflight = null;
      };
      entry = { key, promise: null as unknown as Promise<Region>, quiet, cancel: () => { finish(); reject(new Error('Loading was cancelled.')); } };
      w.onmessage = (e: MessageEvent<RegionWorkerMessage>) => {
        const m = e.data;
        if (m.type === 'progress') {
          if (!entry.quiet) useSession.setState({ progress: { stage: m.stage, done: m.done, total: m.total } });
        } else if (m.type === 'error') {
          finish();
          reject(new Error(m.message));
        } else {
          finish();
          const region = prepareRegion(m.data as RegionData);
          this.region = region;
          this.regionKey = key;
          if (m.missing && !entry.quiet) useSession.setState({ notice: `${m.missing} map tile${m.missing > 1 ? 's' : ''} could not be downloaded; parts of the area may be missing streets.` });
          resolve(region);
        }
      };
      w.onerror = (e) => {
        finish();
        reject(new Error(e.message || 'The map data could not be processed.'));
      };
    });
    entry.promise = promise;
    this.inflight = entry;
    w.postMessage({ spec });
    return promise;
  }

  /** New company flow, step 1: load the chosen area, then let the player pick a home area. */
  async beginNew(spec: RegionSpec) {
    useSession.setState({ phase: 'loading', pending: { spec }, error: null, homeZone: null, setupStep: 'area' });
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
    // Keep the game being replaced: it goes into its autosave slot first, unless that slot is
    // exactly what the player chose to go back to.
    const current = this.game;
    if (current) {
      current.setSpeed(0);
      const ownAuto = safeId(`${current.state.meta.id}-auto`) === safeId(id);
      if (!ownAuto && !(await this.save('auto'))) return;
    }
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
      // a failed load leaves the current game (if any) running
      if (this.game) useSession.setState({ phase: 'playing', progress: null, notice: `Could not load that save: ${(e as Error).message}` });
      else useSession.setState({ phase: 'menu', progress: null, error: (e as Error).message });
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

  /** Save the game as it is right now. Saves are written one at a time, in order. */
  save(kind: 'manual' | 'auto' = 'manual'): Promise<boolean> {
    const g = this.game;
    const meta = this.meta(kind);
    if (!g || !meta) return Promise.resolve(false);
    const json = g.serialize();
    this.savesPending++;
    useSession.setState({ saving: true });
    const run = async () => {
      try {
        await persistence().write(meta, json);
        useSession.setState({ lastSaved: Date.now() });
        if (kind === 'auto') this.lastAutosave = Date.now();
        return true;
      } catch (e) {
        useSession.setState({ notice: `Saving failed: ${(e as Error).message}` });
        return false;
      } finally {
        if (--this.savesPending === 0) {
          useSession.setState({ saving: false });
          void this.refreshSaves();
        }
      }
    };
    const result = this.saveChain.then(run, run);
    this.saveChain = result;
    return result;
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

  /** Leave the game. If saving first fails, the player stays in the game (and is told why). */
  async quitToMenu(saveFirst = true): Promise<boolean> {
    this.game?.setSpeed(0);
    if (saveFirst && this.game && !(await this.save('auto'))) return false;
    clearInterval(this.autosaveTimer);
    this.setGame(null);
    useSession.setState({ phase: 'menu', pending: null });
    void this.refreshSaves();
    return true;
  }

  async deleteSave(id: string) {
    await persistence().remove(id);
    await this.refreshSaves();
  }
}

export const session = new Session();
// back online: load any map the territory is still missing
if (typeof window !== 'undefined') window.addEventListener('online', () => void session.grow());
