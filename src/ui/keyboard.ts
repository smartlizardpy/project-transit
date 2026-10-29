import { useEffect } from 'react';
import { useUI } from '../state/store.ts';
import { sim } from '../sim/sim.ts';
import { mapRuntime } from '../map/runtime.ts';
import { HOME_VIEW } from '../sim/demoCity.ts';
import { focusVehicle } from './camera.ts';

/** Desktop shortcuts from the PRD: Space, 1–3, WASD, Q/E, F, Esc, Ctrl/Cmd+Z. */
export function useKeyboard() {
  useEffect(() => {
    let lastSpeed = 1;
    const held = new Set<string>();
    let raf = 0;
    const pan = () => {
      const map = mapRuntime.map;
      if (map && held.size) {
        const step = 14;
        let dx = 0, dy = 0;
        if (held.has('w')) dy -= step;
        if (held.has('s')) dy += step;
        if (held.has('a')) dx -= step;
        if (held.has('d')) dx += step;
        if (dx || dy) {
          useUI.getState().follow(null);
          map.panBy([dx, dy], { duration: 0 });
        }
        raf = requestAnimationFrame(pan);
      } else raf = 0;
    };
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const ui = useUI.getState();
      const map = mapRuntime.map;
      const k = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && k === 'z') {
        e.preventDefault();
        const d = ui.draft;
        if (!d) return;
        if (e.shiftKey) {
          const next = d.future[d.future.length - 1];
          if (next) ui.setDraft({ ...d, stops: next, history: [...d.history, d.stops], future: d.future.slice(0, -1) });
        } else {
          const prev = d.history[d.history.length - 1];
          if (prev) ui.setDraft({ ...d, stops: prev, history: d.history.slice(0, -1), future: [...d.future, d.stops] });
        }
        return;
      }
      if (mod || e.altKey) return;
      if (['w', 'a', 's', 'd'].includes(k)) {
        held.add(k);
        if (!raf) raf = requestAnimationFrame(pan);
        return;
      }
      switch (k) {
        case ' ':
          e.preventDefault();
          if (sim.speed === 0) sim.setSpeed(lastSpeed);
          else {
            lastSpeed = sim.speed;
            sim.setSpeed(0);
          }
          break;
        case '1': sim.setSpeed(1); break;
        case '2': sim.setSpeed(2); break;
        case '3': sim.setSpeed(4); break;
        case 'v': ui.setTool('select'); break;
        case 'r': ui.setTool(ui.tool === 'route' ? 'select' : 'route'); break;
        case 'n': ui.toggleOverlay('network'); break;
        case 't': ui.toggleOverlay('traffic'); break;
        case 'p': ui.toggleOverlay('demand'); break;
        case 'l': ui.openPanel(ui.panel === 'lines' ? null : 'lines'); break;
        case 'g': ui.openPanel(ui.panel === 'fleet' ? null : 'fleet'); break;
        case 'm': ui.openPanel(ui.panel === 'finance' ? null : 'finance'); break;
        case 'f':
          if (ui.selection?.kind === 'vehicle') {
            const on = ui.following !== ui.selection.id;
            ui.follow(on ? ui.selection.id : null);
            if (on) focusVehicle(ui.selection.id);
          }
          break;
        case 'h': map?.flyTo({ ...HOME_VIEW, duration: 1400 }); break;
        case 'q': map?.easeTo({ bearing: map.getBearing() - 22.5, duration: 260 }); break;
        case 'e': map?.easeTo({ bearing: map.getBearing() + 22.5, duration: 260 }); break;
        case '+': case '=': map?.zoomIn({ duration: 250 }); break;
        case '-': case '_': map?.zoomOut({ duration: 250 }); break;
        case 'escape':
          if (ui.tool !== 'select') ui.setTool('select');
          else if (ui.following) ui.follow(null);
          else if (ui.selection) ui.select(null);
          else if (ui.panel) ui.openPanel(null);
          break;
      }
    };
    const up = (e: KeyboardEvent) => held.delete(e.key.toLowerCase());
    const blur = () => held.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
}
