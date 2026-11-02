// Live access for AI agents (desktop app, off unless switched on in Settings → AI agents).
// The app's local bridge (src-tauri/src/agent.rs) passes each request from the MCP server here;
// the game answers it with the rules in src/game/agents/api.ts and sends the answer back.
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { isDesktop } from './persistence.ts';
import { session } from './session.ts';
import { AgentError, handleAgentRequest } from '../game/agents/api.ts';

interface Request {
  id: number;
  method: string;
  params: unknown;
  who: string;
}

export const useAgentLive = create<{ on: boolean; requests: number; last: string | null; error: string | null }>(() => ({ on: false, requests: 0, last: null, error: null }));

let unlisten: (() => void) | null = null;

async function answer(r: Request) {
  let body: string;
  try {
    body = JSON.stringify({ ok: true, result: await handleAgentRequest(session.game, r.method, r.params, r.who) });
  } catch (e) {
    const msg = e instanceof AgentError ? e.message : `The game could not do that: ${e instanceof Error ? e.message : String(e)}`;
    body = JSON.stringify({ ok: false, error: msg });
  }
  useAgentLive.setState((s) => ({ requests: s.requests + 1, last: r.method }));
  await invoke('agent_reply', { id: r.id, body }).catch((e) => console.warn('agent reply failed', e));
}

/** Switch live access on or off (also called at start-up with the saved setting). */
export async function setAgentLive(on: boolean): Promise<void> {
  if (!isDesktop()) return;
  try {
    if (on && !unlisten) {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<Request>('pt-agent-request', (e) => void answer(e.payload));
    }
    const port = await invoke<number | null>('agent_live', { on });
    if (!on && unlisten) {
      unlisten();
      unlisten = null;
    }
    useAgentLive.setState({ on: port !== null, error: null });
  } catch (e) {
    useAgentLive.setState({ on: false, error: e instanceof Error ? e.message : String(e) });
  }
}
