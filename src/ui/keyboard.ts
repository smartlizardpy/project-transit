import { useEffect } from 'react';
import { useUI } from '../state/store.ts';
import { mapRuntime } from '../map/runtime.ts';
import { focusVehicle } from './camera.ts';
import { session, useSession } from '../app/session.ts';
import { startDrafting } from './routeDraft.ts';
import { goHome } from './ToolRail.tsx';

/** Desktop shortcuts: Space, 1–4, WASD, Q/E, F, B/R/D tools, panels, Esc, Ctrl/Cmd+Z, Ctrl/Cmd+S. */
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
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const game = session.game;
      if (!game || useSession.getState().phase !== 'playing') return;
      const ui = useUI.getState();
      if (ui.studio.open && !ui.studio.peek) return; // Automation Studio handles its own keys
      if (ui.modal && ui.modal.kind !== 'notifications') return; // dialogs handle their own keys
      const map = mapRuntime.map;
      const k = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && k === 's') {
        e.preventDefault();
        void session.save('manual').then((ok) => ok && ui.notify('Game saved', 'good'));
        return;
      }
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) ui.redoDraft();
        else ui.undoDraft();
        return;
      }
      if (mod || e.altKey) return;
      if (e.shiftKey && k === 'd') {
        ui.setTool(ui.tool === 'depot' ? 'select' : 'depot');
        return;
      }
      if (['w', 'a', 's', 'd'].includes(k)) {
        held.add(k);
        if (!raf) raf = requestAnimationFrame(pan);
        return;
      }
      switch (k) {
        case ' ':
          e.preventDefault();
          if (game.speed === 0) game.setSpeed(lastSpeed);
          else {
            lastSpeed = game.speed;
            game.setSpeed(0);
          }
          break;
        case '1': game.setSpeed(1); break;
        case '2': game.setSpeed(2); break;
        case '3': game.setSpeed(3); break;
        case '4': game.setSpeed(4); break;
        case 'v': ui.setTool('select'); break;
        case 'b': ui.setTool(ui.tool === 'stop' ? 'select' : 'stop'); break;
        case 'r': if (ui.tool === 'route') ui.setTool('select'); else startDrafting(null); break;
        case 'n': ui.toggleOverlay('network'); break;
        case 't': ui.toggleOverlay('traffic'); break;
        case 'p': ui.toggleOverlay('demand'); break;
        case 'o': ui.toggleOverlay('areas'); break;
        case 'l': ui.openPanel(ui.panel === 'lines' ? null : 'lines'); break;
        case 'g': ui.openPanel(ui.panel === 'fleet' ? null : 'fleet'); break;
        case 'm': ui.openPanel(ui.panel === 'finance' ? null : 'finance'); break;
        case 'c': ui.openPanel(ui.panel === 'company' ? null : 'company'); break;
        case 'k': ui.openPanel(ui.panel === 'network' ? null : 'network'); break;
        case 'f':
          if (ui.selection?.kind === 'vehicle') {
            const on = ui.following !== ui.selection.id;
            ui.follow(on ? ui.selection.id : null);
            if (on) focusVehicle(ui.selection.id);
          }
          break;
        case 'h': goHome(); break;
        case 'q': map?.easeTo({ bearing: map.getBearing() - 22.5, duration: 260 }); break;
        case 'e': map?.easeTo({ bearing: map.getBearing() + 22.5, duration: 260 }); break;
        case '+': case '=': map?.zoomIn({ duration: 250 }); break;
        case '-': case '_': map?.zoomOut({ duration: 250 }); break;
        case 'escape':
          if (ui.tool !== 'select') ui.setTool('select');
          else if (ui.following) ui.follow(null);
          else if (ui.selection) ui.select(null);
          else if (ui.panel) ui.openPanel(null);
          else ui.openModal({ kind: 'menu' });
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
