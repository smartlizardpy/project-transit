// Desktop-only save round trip across real app launches. Runs only when the Tauri shell is
// started with PT_DIAG_DIR and PT_DIAG_SAVE (see scripts/dev/native-saves.sh):
//   write   - found a company in İstanbul (offline), build a line, run, save; check the file
//             lists and reads back; play on, then close the window (the close hook autosaves)
//   reopen  - load the autosave written on close; play on; quit through the same path as Cmd+Q
//   cleanup - load the autosave written on quit; delete this company's saves
// Each step writes save-check.json into PT_DIAG_DIR. Only saves of the test company are touched.
import { invoke } from '@tauri-apps/api/core';
import { session, useSession } from './app/session.ts';
import { persistence } from './app/persistence.ts';
import { PRESETS, presetSpec } from './app/presets.ts';
import { routeWithFallback } from './game/world/graph.ts';
import { paxTotals } from './game/passengers.ts';

const COMPANY = 'Diag Check Transit';
const report: Record<string, unknown> = { steps: [] as string[] };
const step = (s: string) => (report.steps as string[]).push(s);
const flush = () => invoke('diag_save_report', { report: JSON.stringify(report, null, 2) }).catch(() => {});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fingerprint() {
  const g = session.game!;
  const s = g.state;
  const p = paxTotals(s);
  return {
    company: s.company.name,
    t: s.clock.t,
    balance: Math.round(s.finance.balance * 100) / 100,
    stops: Object.keys(s.stops).length,
    routes: Object.keys(s.routes).length,
    vehicles: Object.keys(s.vehicles).length,
    depots: Object.keys(s.depots).length,
    waiting: p.waiting,
    onboard: p.onboard,
    audit: g.audit().filter((a) => !a.startsWith('Passenger count')),
  };
}

async function ours() {
  return (await persistence().list()).filter((m) => m.company === COMPANY);
}

function buildNetwork() {
  const g = session.game!;
  const gr = g.region.graph;
  const owned = new Set(g.state.territory.owned);
  const inOwned = (v: number) => owned.has(g.geo.zoneAt([gr.lng[v], gr.lat[v]]).id);
  const main: number[] = [];
  for (let e = 0; e < gr.m; e++) if (gr.cls[e] >= 2 && gr.cls[e] <= 4 && !(gr.flags[e] & 6) && inOwned(gr.ea[e])) main.push(gr.ea[e]);
  let depot: string | null = null;
  for (const v of main) {
    const r = g.buildDepot([gr.lng[v], gr.lat[v]]);
    if (r.ok) {
      depot = r.value;
      break;
    }
  }
  const a = main[0];
  let line: ReturnType<typeof routeWithFallback> = null;
  for (const b of main) {
    const d = Math.hypot(gr.x[b] - gr.x[a], gr.y[b] - gr.y[a]);
    if (d < 700 || d > 1700) continue;
    const l = routeWithFallback(gr, a, b);
    if (l && l.nodes.filter(inOwned).length / l.nodes.length > 0.9) {
      line = l;
      break;
    }
  }
  const stops: string[] = [];
  if (line) {
    let acc = 1e9;
    for (let i = 1; i < line.nodes.length; i++) {
      const p = line.nodes[i - 1], q = line.nodes[i];
      acc += Math.hypot(gr.x[q] - gr.x[p], gr.y[q] - gr.y[p]);
      if (acc >= 350) {
        const r = g.placeStop([gr.lng[q], gr.lat[q]]);
        if (r.ok) {
          stops.push(r.value);
          acc = 0;
        }
      }
    }
  }
  const route = stops.length >= 2 ? g.createRoute({ stops, kind: 'linear', name: 'Check line' }) : null;
  let buses = 0;
  if (depot && route?.ok)
    for (let i = 0; i < 2; i++) {
      const r = g.buyVehicle('city12', depot);
      if (r.ok && g.assignVehicle(r.value, route.value).ok) buses++;
    }
  return { depot: !!depot, stops: stops.length, route: route ? (route.ok ? route.value : route.error) : null, buses };
}

async function loadLatestOurs(kind: 'auto' | 'manual') {
  const mine = await ours();
  report.savesFound = mine.map((m) => ({ id: m.id, kind: m.kind, day: m.day, balance: m.balance }));
  const pick = mine.find((m) => m.kind === kind);
  if (!pick) throw new Error(`no ${kind} save of the test company`);
  await session.load(pick.id);
  if (!session.game || useSession.getState().phase !== 'playing') throw new Error(`load failed: ${useSession.getState().error}`);
  step(`loaded ${pick.id}`);
  return fingerprint();
}

export async function runSaveCheck(mode: string) {
  report.mode = mode;
  report.persistence = persistence().kind;
  await wait(3000); // let the app mount and register its close/quit listeners
  try {
    if (mode === 'write') {
      for (const m of await ours()) await persistence().remove(m.id); // leftovers of an earlier run
      await session.beginNew(presetSpec(PRESETS[0]));
      if (useSession.getState().phase !== 'setup') throw new Error(`region failed: ${useSession.getState().error}`);
      const zone = [...session.region!.zones].sort((a, b) => b.residents + b.jobs - (a.residents + a.jobs))[0];
      session.startNew({ name: COMPANY, colour: '#2f7fd6', logo: 1 }, zone.id);
      step('founded');
      report.built = buildNetwork();
      session.game!.run(3 * 3600);
      report.savedOk = await session.save('manual');
      report.manual = fingerprint();
      const mine = await ours();
      const manual = mine.find((m) => m.kind === 'manual');
      report.listed = mine.map((m) => ({ id: m.id, kind: m.kind }));
      if (manual) {
        const back = JSON.parse((await persistence().read(manual.id)).json);
        report.readBack = { t: back.clock.t, balance: Math.round(back.finance.balance * 100) / 100 };
      }
      session.game!.run(2 * 3600);
      report.beforeClose = fingerprint();
      step('closing window');
      await flush();
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close(); // the app's close hook autosaves, then the app exits
    } else if (mode === 'reopen') {
      report.loadedAuto = await loadLatestOurs('auto');
      session.game!.run(3600);
      report.beforeQuit = fingerprint();
      step('quitting like Cmd+Q');
      await flush();
      const { emit } = await import('@tauri-apps/api/event');
      await emit('pt-quit-requested'); // same event the native Quit menu item sends
    } else if (mode === 'cleanup') {
      try {
        report.loadedAuto = await loadLatestOurs('auto');
      } catch (e) {
        report.loadError = String(e); // still delete the test saves below
      }
      if (session.game) await session.quitToMenu(false);
      for (const m of await ours()) await persistence().remove(m.id);
      report.remainingAfterCleanup = (await ours()).length;
      step('cleaned up');
      await flush();
      await invoke('app_exit');
    }
  } catch (e) {
    report.error = String((e as Error)?.stack ?? e);
    await flush();
  }
  await flush();
}
