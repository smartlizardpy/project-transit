// Live access: asks the running desktop game, through its local bridge, instead of reading a save.
// The game writes the bridge's port and a token to agent.json in its data folder while the player
// has live access switched on (Settings → AI agents); see src-tauri/src/agent.rs.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';

export const LIVE_OFF = 'Live access is off. In the game, open Settings → AI agents and switch on Live access (desktop app only). Save files can still be read with the other tools.';
const NOT_RUNNING = 'The game is not answering. Start the desktop app and check Settings → AI agents → Live access is on.';

interface Conn {
  port: number;
  token: string;
}

function conn(file: string): Conn {
  let c: Partial<Conn>;
  try {
    c = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(LIVE_OFF);
  }
  if (!Number.isInteger(c.port) || typeof c.token !== 'string' || !c.token) throw new Error(LIVE_OFF);
  return c as Conn;
}

/** One request to the running game. Rejects with the game's own message when it says no. */
export function askLive(file: string, method: string, params: unknown, who: string, timeoutMs = 130_000): Promise<unknown> {
  const { port, token } = conn(file);
  const body = JSON.stringify({ method, params, who });
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/v1/request', method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${token}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let reply: { ok?: boolean; result?: unknown; error?: string } | null = null;
          try {
            reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // not JSON: reported below
          }
          if (!reply) reject(new Error(`The game answered ${res.statusCode} without data.`));
          else if (reply.ok) resolve(reply.result);
          else reject(new Error(reply.error ?? `The game answered ${res.statusCode}.`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('The game did not answer in time.')));
    req.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? new Error(NOT_RUNNING) : e));
    req.end(body);
  });
}

/** "claude-code" → "Claude Code", for the player's notifications. */
export function agentName(client?: string): string {
  const n = (client ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 40);
  if (!n) return 'An AI agent';
  return n.split(/[-_ ]+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}
